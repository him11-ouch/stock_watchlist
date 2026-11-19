const axios = require('axios');
const yahoo = require('./yahoo.cjs');

const cache = new Map();
const ttlMs = 5 * 60 * 1000;

async function request(operation, params, signal) {
  signal?.throwIfAborted();
  const key = process.env.ALPHA_VANTAGE_KEY;
  if (!key || key === 'your_api_key_here') throw new Error('Set ALPHA_VANTAGE_KEY in .env to fetch market data.');
  const id = JSON.stringify([operation, params]);
  const cached = cache.get(id);
  if (cached && cached.expires > Date.now()) return cached.data;
  let data;
  try {
    ({ data } = await axios.get('https://www.alphavantage.co/query', {
      params: { function: operation, ...params, apikey: key }, timeout: 10000, signal,
    }));
  } catch (error) {
    throw new Error(`Alpha Vantage request failed (${error.response?.status || error.code || 'network error'}).`);
  }
  if (data?.Note || data?.Information || data?.['Error Message']) {
    const message = String(data.Note || data.Information || data['Error Message']);
    if (/rate limit|call frequency|requests per/i.test(message)) throw new Error('Alpha Vantage request limit reached. Try again when your quota resets.');
    if (/premium|entitlement/i.test(message)) throw new Error(`Your Alpha Vantage plan does not include ${operation}.`);
    if (/api.?key/i.test(message)) throw new Error('Alpha Vantage declined the API key. Check ALPHA_VANTAGE_KEY.');
    throw new Error(`Alpha Vantage could not fulfill ${operation} for this listing.`);
  }
  if (!data || typeof data !== 'object') throw new Error('Alpha Vantage returned an unreadable response.');
  cache.set(id, { data, expires: Date.now() + ttlMs });
  return data;
}

// Keep the watchlist's Toronto notation locally and translate at the provider boundary.
function watchSymbol(symbol) {
  return symbol.toUpperCase().replace(/\.TRT$/, '.TO');
}

function providerSymbol(symbol) {
  return symbol.toUpperCase().replace(/\.TO$/, '.TRT');
}

async function withFallback(getYahoo, getAlpha) {
  if (process.env.WATCHLIST_MARKET_SOURCE === 'alpha') return getAlpha();
  try {
    return await getYahoo();
  } catch (first) {
    if (!process.env.ALPHA_VANTAGE_KEY || process.env.ALPHA_VANTAGE_KEY === 'your_api_key_here') throw first;
    try {
      return await getAlpha();
    } catch (second) {
      throw new Error(`${first.message} ${second.message}`);
    }
  }
}

async function resolveListing(query, known = [], signal) {
  const normalized = watchSymbol(query.trim());
  const local = known.find(stock =>
    stock.symbol === normalized || stock.name.toUpperCase() === normalized
  );
  if (local) return local;
  async function alphaMatches() {
    const { bestMatches } = await request('SYMBOL_SEARCH', { keywords: providerSymbol(query.trim()) }, signal);
    return (bestMatches || []).filter(row => ['Equity', 'ETF'].includes(row['3. type'])).map(row => ({
      symbol: watchSymbol(row['1. symbol']), name: row['2. name'], ...yahoo.quoteUnit(row['8. currency']),
    }));
  }
  const matches = await withFallback(() => yahoo.matches(query.trim(), signal), alphaMatches);
  const exact = matches.find(row => row.symbol === normalized);
  // Respect an explicit ticker. Prefer a Canadian listing for an exact company-name match.
  const canadian = row => /\.(TO|V|CN|NE)$/.test(row.symbol);
  const named = matches.filter(row => row.name?.toUpperCase() === normalized);
  const canadianNamed = named.filter(canadian);
  const match = exact || (canadianNamed.length === 1 && canadianNamed[0]) ||
    (named.length === 1 && named[0]) || (matches.length === 1 && matches[0]);
  if (!matches.length) throw new Error(`No stock or ETF listing found for ${query}.`);
  if (!match) {
    const ordered = [...matches].sort((a, b) => Number(canadian(b)) - Number(canadian(a)));
    throw new Error('Choose a ticker: ' + ordered.map(row => `${row.symbol} (${row.name}, ${row.exchange || row.currency || 'unknown market'})`).join(', '));
  }
  if ('currency' in match) return match;
  return withFallback(() => yahoo.listing(match, signal), async () => {
    const fallback = (await alphaMatches()).find(row => row.symbol === match.symbol && row.currency);
    if (!fallback) throw new Error(`Unable to verify quote currency for ${match.symbol}.`);
    return fallback;
  });
}

async function alphaHistory(symbol, signal) {
  const data = await request('TIME_SERIES_DAILY', { symbol: providerSymbol(symbol) }, signal);
  const series = data['Time Series (Daily)'];
  if (!series) throw new Error(`No daily prices available for ${symbol}.`);
  const dates = Object.keys(series).sort();
  const history = dates.map(date => ({ date, close: Number(series[date]?.['4. close']), source: 'Alpha Vantage' }))
    .filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Number.isFinite(row.close) && row.close > 0);
  if (!history.length || history.at(-1).date !== dates.at(-1)) throw new Error(`Latest closing price unavailable for ${symbol}.`);
  return history;
}

async function alphaOverview(symbol) {
  const data = await request('OVERVIEW', { symbol: providerSymbol(symbol) });
  return data.Symbol === providerSymbol(symbol) ? { ...data, Source: 'Alpha Vantage' } : null;
}

async function alphaRate(from, to, signal) {
  const data = await request('CURRENCY_EXCHANGE_RATE', { from_currency: from, to_currency: to }, signal);
  const quote = data['Realtime Currency Exchange Rate'];
  const rate = Number(quote?.['5. Exchange Rate']);
  if (quote?.['1. From_Currency Code'] !== from || quote?.['3. To_Currency Code'] !== to ||
      !Number.isFinite(rate) || rate <= 0 || !quote['6. Last Refreshed']) {
    throw new Error(`FX rate unavailable for ${from}/${to}.`);
  }
  return { rate, source: 'Alpha Vantage', asOf: `${quote['6. Last Refreshed']} ${quote['7. Time Zone'] || ''}`.trim() };
}

function dailyHistory(symbol, signal) {
  return withFallback(() => yahoo.dailyHistory(watchSymbol(symbol), signal), () => alphaHistory(symbol, signal));
}

function latestQuote(symbol, signal) {
  return process.env.WATCHLIST_MARKET_SOURCE === 'alpha' ? null : yahoo.latestQuote(watchSymbol(symbol), signal);
}

function overview(symbol) {
  return withFallback(() => yahoo.overview(watchSymbol(symbol)), () => alphaOverview(symbol));
}

async function bankOfCanadaRate(from, signal) {
  signal?.throwIfAborted();
  const id = 'Bank of Canada FXUSDCAD';
  let quote = cache.get(id);
  if (!quote || quote.expires <= Date.now()) {
    const { data } = await axios.get('https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json', {
      params: { recent: 1 }, timeout: 8000, signal,
    });
    const point = data?.observations?.at(-1);
    const rate = Number(point?.FXUSDCAD?.v);
    if (data?.seriesDetail?.FXUSDCAD?.label !== 'USD/CAD' || !Number.isFinite(rate) || rate <= 0 ||
        !/^\d{4}-\d{2}-\d{2}$/.test(point?.d) || !(Date.parse(point.d) <= Date.now())) {
      throw new Error('Bank of Canada rate unavailable.');
    }
    quote = { rate, asOf: point.d, expires: Date.now() + 3600_000 };
    cache.set(id, quote);
  }
  return { rate: from === 'USD' ? quote.rate : 1 / quote.rate, asOf: quote.asOf, source: 'Bank of Canada daily average' };
}

function exchangeRate(from, to, signal) {
  return withFallback(async () => {
    try {
      return await yahoo.exchangeRate(from, to, signal);
    } catch (error) {
      if (!((from === 'USD' && to === 'CAD') || (from === 'CAD' && to === 'USD'))) throw error;
      try {
        return await bankOfCanadaRate(from, signal);
      } catch {
        throw new Error(`${error.message} Bank of Canada daily USD/CAD rate unavailable.`);
      }
    }
  }, () => alphaRate(from, to, signal));
}

module.exports = { news: yahoo.news, resolveListing, watchSymbol, providerSymbol, dailyHistory, latestQuote, overview, exchangeRate };
