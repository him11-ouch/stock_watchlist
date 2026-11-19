const axios = require('axios');

const origin = 'https://query1.finance.yahoo.com';
const cache = new Map();
const lastTrades = new Map();
let retryAfter = 0;

async function request(path, params, ttl, key = JSON.stringify([path, params]), signal) {
  signal?.throwIfAborted();
  const now = Date.now();
  const previous = cache.get(key);
  if (previous && previous.expires > now) return previous.data;
  if (now < retryAfter) throw new Error('Yahoo Finance request limit reached. Try again later.');
  try {
    const { data } = await axios.get(origin + path, { params, timeout: 8000, maxContentLength: 3_000_000, signal });
    if (!data || typeof data !== 'object') throw new Error('Invalid response');
    cache.set(key, { data, expires: now + ttl });
    return data;
  } catch (error) {
    signal?.throwIfAborted();
    const status = error.response?.status;
    if (status === 429) {
      const retry = error.response.headers?.['retry-after'];
      const until = /^\d+$/.test(retry) ? now + Number(retry) * 1000 : Date.parse(retry);
      retryAfter = Math.max(now + 60_000, Number.isFinite(until) ? until : 0);
      throw new Error('Yahoo Finance request limit reached. Try again later.');
    }
    throw new Error(`Yahoo Finance request failed (${status || error.code || 'invalid response'}).`);
  }
}

function text(value) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim() : '';
}

const currencyCodes = new Set(Intl.supportedValuesOf('currency'));
function quoteUnit(unit) {
  if (unit === 'GBp' || unit === 'GBX') return { currency: 'GBP', priceScale: 0.01 };
  if (unit === 'ZAc' || unit === 'ZAC') return { currency: 'ZAR', priceScale: 0.01 };
  if (unit === 'ILA') return { currency: 'ILS', priceScale: 0.01 };
  return { currency: currencyCodes.has(unit) ? unit : null, priceScale: 1 };
}

async function chart(symbol, signal, type = 'security', params = { range: '3mo', interval: '1d' }, ttl = 5 * 60_000) {
  const data = await request('/v8/finance/chart/' + encodeURIComponent(symbol), params, ttl, undefined, signal);
  const result = data.chart?.result?.[0];
  const meta = result?.meta;
  // Yahoo also publishes USD/CAD as CAD=X. Verify the pair before accepting its shorthand.
  const canadianDollarAlias = type === 'CURRENCY' && symbol === 'USDCAD=X' && meta?.symbol === 'CAD=X' &&
    meta.currency === 'CAD' && (meta.shortName === 'USD/CAD' || meta.longName === 'USD/CAD');
  const correctType = type === 'security' ? ['EQUITY', 'ETF'].includes(meta?.instrumentType) : meta?.instrumentType === type;
  if (!correctType || (meta.symbol?.toUpperCase() !== symbol && !canadianDollarAlias)) {
    throw new Error(`Yahoo Finance could not verify the ${type.toLowerCase()} listing for ${symbol}.`);
  }
  return result;
}

function regularQuote(meta, unit, now) {
  const stamp = meta.regularMarketTime;
  if (!Number.isFinite(meta.regularMarketPrice) || meta.regularMarketPrice <= 0 ||
      !Number.isFinite(stamp) || stamp <= 0 || stamp > now) return null;
  return { price: meta.regularMarketPrice * unit.priceScale, currency: unit.currency,
    asOf: new Date(stamp * 1000).toISOString(), source: 'Yahoo Finance regular-session quote' };
}

// A minute candle's close belongs at the end of its minute. Ignore incomplete candles and quote ticks.
function completedMinutes(timestamp, closes, scale, now) {
  const prices = new Map();
  timestamp.forEach((stamp, index) => {
    const price = closes[index] * scale;
    if (Number.isInteger(stamp) && stamp > 0 && stamp % 60 === 0 && stamp + 60 <= now && Number.isFinite(closes[index]) &&
        Number.isFinite(price) && price > 0) prices.set((stamp + 60) * 1000, price);
  });
  return prices;
}

async function intradayQuote(symbol, signal) {
  const { meta, timestamp = [], indicators } = await chart(symbol, signal, 'security',
    { range: '1d', interval: '1m', includePrePost: true }, 60_000);
  const unit = quoteUnit(meta.currency);
  if (!unit.currency) throw new Error(`Unrecognized Yahoo quote currency for ${symbol}.`);
  const now = Date.now() / 1000;
  const regular = regularQuote(meta, unit, now);
  const closes = indicators?.quote?.[0]?.close || [];
  const minutes = completedMinutes(timestamp, closes, unit.priceScale, now);
  for (let i = timestamp.length - 1; i >= 0; i--) {
    const stamp = timestamp[i];
    if (!Number.isFinite(stamp) || stamp <= 0 || stamp > now || !Number.isFinite(closes[i]) || closes[i] <= 0) continue;
    if (regular && stamp <= meta.regularMarketTime) break;
    const { pre, post } = meta.currentTradingPeriod || {};
    let source = 'Yahoo Finance 1-minute bar';
    if (stamp >= pre?.start && stamp < pre.end) source = 'Yahoo Finance pre-market';
    if (stamp >= post?.start && stamp < post.end) source = 'Yahoo Finance after-hours';
    return { price: closes[i] * unit.priceScale, currency: unit.currency, asOf: new Date(stamp * 1000).toISOString(), source, minutes };
  }
  return regular && { ...regular, minutes };
}

async function latestQuote(symbol, signal) {
  const previous = lastTrades.get(symbol);
  const age = previous ? Date.now() - Date.parse(previous.asOf) : Infinity;
  const retained = age >= 0 && age < 7 * 86400_000 ? previous : null;
  try {
    const quote = await intradayQuote(symbol, signal);
    if (quote && (!retained || quote.asOf >= retained.asOf)) {
      lastTrades.set(symbol, quote);
      return quote;
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (!retained) throw error;
  }
  return retained ? { ...retained, source: retained.source + ' (last available)' } : null;
}

async function dailyHistory(symbol, signal) {
  const { meta, timestamp = [], indicators } = await chart(symbol, signal);
  const unit = quoteUnit(meta.currency);
  if (!unit.currency) throw new Error(`Unrecognized Yahoo quote currency for ${symbol}.`);
  const closes = indicators?.quote?.[0]?.close || [];
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone: meta.exchangeTimezoneName, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const bars = new Map();
  const regular = meta.currentTradingPeriod?.regular;
  const now = Date.now() / 1000;
  for (const [i, t] of timestamp.entries()) {
    if (!Number.isFinite(closes[i]) || closes[i] <= 0 || !Number.isFinite(t) || t > now) continue;
    // The final daily candle can be the still-trading session.
    if (regular && t >= regular.start && now < regular.end) continue;
    const date = format.format(new Date(t * 1000));
    bars.set(date, { date, close: closes[i], source: 'Yahoo Finance', ...unit });
  }
  const history = [...bars.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (!history.length) throw new Error(`No completed Yahoo Finance daily bars available for ${symbol}.`);
  const quote = regularQuote(meta, unit, now);
  if (quote && format.format(new Date(quote.asOf)) >= history.at(-1).date) history.at(-1).marketQuote = quote;
  if (Number.isFinite(regular?.start) && Number.isFinite(regular?.end) && regular.start < regular.end) {
    history.at(-1).session = { start: regular.start, end: regular.end, exchange: text(meta.fullExchangeName || meta.exchangeName),
      timezone: meta.exchangeTimezoneName };
  }
  return history;
}

async function lookup(query, signal) {
  return request('/v1/finance/search', { q: query, quotesCount: 8, newsCount: 8 }, 10 * 60_000, undefined, signal);
}

async function matches(query, signal) {
  const data = await lookup(query, signal);
  return (data.quotes || []).filter(row => ['EQUITY', 'ETF'].includes(row.quoteType) && row.symbol).map(row => ({
    symbol: text(row.symbol).toUpperCase(), name: text(row.longname || row.shortname || row.symbol), exchange: text(row.exchDisp),
  }));
}

async function listing(match, signal) {
  const { meta } = await chart(match.symbol, signal);
  const unit = quoteUnit(meta.currency);
  if (!unit.currency) throw new Error(`Unrecognized Yahoo quote currency for ${match.symbol}.`);
  return { ...match, ...unit };
}

async function news(symbol) {
  const data = await lookup(symbol);
  const latest = Date.now() / 1000;
  return (data.news || []).filter(row => row.relatedTickers?.includes(symbol) &&
    row.providerPublishTime <= latest && row.providerPublishTime >= latest - 14 * 86400 &&
    text(row.title) && /^https:\/\//i.test(row.link)).sort((a, b) => b.providerPublishTime - a.providerPublishTime)
    .slice(0, 5).map(row => ({
      title: text(row.title), publisher: text(row.publisher), url: text(row.link),
      date: new Date(row.providerPublishTime * 1000).toISOString(),
    }));
}

async function exchangeRate(from, to, signal) {
  const { meta, timestamp = [], indicators } = await chart(`${from}${to}=X`, signal, 'CURRENCY', { range: '1d', interval: '1m' }, 60_000);
  if (meta.currency !== to || !Number.isFinite(meta.regularMarketPrice) || meta.regularMarketPrice <= 0 ||
      !Number.isFinite(meta.regularMarketTime) || meta.regularMarketTime <= 0 || meta.regularMarketTime * 1000 > Date.now()) {
    throw new Error(`Unverified Yahoo Finance exchange rate for ${from}/${to}.`);
  }
  return { rate: meta.regularMarketPrice, asOf: new Date(meta.regularMarketTime * 1000).toISOString(), source: 'Yahoo Finance',
    minutes: completedMinutes(timestamp, indicators?.quote?.[0]?.close || [], 1, Date.now() / 1000) };
}

async function overview(symbol) {
  const now = Math.floor(Date.now() / 1000);
  const types = ['quarterlyTotalRevenue', 'trailingNetIncome', 'trailingTotalRevenue', 'trailingPeRatio'];
  const path = '/ws/fundamentals-timeseries/v1/finance/timeseries/' + encodeURIComponent(symbol);
  const data = await request(path, { symbol, type: types.join(','), period1: now - 2 * 366 * 86400, period2: now }, 3600_000, path);
  const rows = data.timeseries?.result || [];
  function observations(type) {
    const row = rows.find(entry => entry.meta?.symbol?.includes(symbol) && entry.meta?.type?.includes(type));
    const period = type === 'quarterlyTotalRevenue' ? '3M' : 'TTM';
    return (row?.[type] || []).filter(point => point?.periodType === period && Number.isFinite(point?.reportedValue?.raw) &&
      /^\d{4}-\d{2}-\d{2}$/.test(point.asOfDate) && Date.parse(point.asOfDate) <= now * 1000)
      .sort((a, b) => b.asOfDate.localeCompare(a.asOfDate));
  }
  const [quarter, ...past] = observations('quarterlyTotalRevenue');
  if (!quarter) throw new Error(`No quarterly Yahoo Finance data available for ${symbol}.`);
  const yearAgo = past.find(point => {
    const days = (Date.parse(quarter.asOfDate) - Date.parse(point.asOfDate)) / 86400_000;
    return days >= 350 && days <= 380 && quarter.currencyCode && point.currencyCode === quarter.currencyCode && point.reportedValue.raw > 0;
  });
  const sameQuarter = point => quarter.currencyCode && point.asOfDate === quarter.asOfDate && point.currencyCode === quarter.currencyCode;
  const income = observations('trailingNetIncome').find(sameQuarter);
  const revenue = observations('trailingTotalRevenue').find(sameQuarter);
  const pe = observations('trailingPeRatio').find(point => now * 1000 - Date.parse(point.asOfDate) <= 30 * 86400_000);
  return {
    Source: 'Yahoo Finance', Symbol: symbol, LatestQuarter: quarter.asOfDate, TrailingPE: pe?.reportedValue.raw,
    QuarterlyRevenueGrowthYOY: yearAgo ? quarter.reportedValue.raw / yearAgo.reportedValue.raw - 1 : null,
    ProfitMargin: income && revenue?.reportedValue.raw > 0 ? income.reportedValue.raw / revenue.reportedValue.raw : null,
  };
}

module.exports = { dailyHistory, latestQuote, matches, listing, overview, exchangeRate, news, quoteUnit };
