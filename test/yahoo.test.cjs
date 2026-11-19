const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const yahoo = require('../services/yahoo.cjs');
const market = require('../services/market.cjs');

test('company names prefer a matching Canadian listing and an explicit foreign ticker selects that listing', async t => {
  const name = 'Example Company';
  const us = { symbol: 'EXMP', name, currency: 'USD' };
  const ca = { symbol: 'EXMP.TO', name, currency: 'CAD' };
  t.mock.method(yahoo, 'matches', async () => [us, ca]);
  assert.equal((await market.resolveListing(name)).symbol, ca.symbol);
  assert.equal((await market.resolveListing(us.symbol)).symbol, us.symbol);
});

test('Yahoo daily bars exclude the still-open session and preserve minor currency units', async t => {
  const now = Math.floor(Date.now() / 1000);
  let calls = 0;
  t.mock.method(axios, 'get', async () => {
    calls++;
    return { data: { chart: { result: [{
      meta: { symbol: 'EXAMPLE.L', currency: 'GBp', instrumentType: 'EQUITY', exchangeTimezoneName: 'Europe/London',
        fullExchangeName: 'London', regularMarketPrice: 160, regularMarketTime: now - 10,
        currentTradingPeriod: { regular: { start: now - 1200, end: now + 1200 } } },
      timestamp: [now - 86400, now - 1200], indicators: { quote: [{ close: [140, 150] }] },
    }] } } };
  });
  const bars = await yahoo.dailyHistory('EXAMPLE.L');
  assert.equal(bars.length, 1);
  assert.equal(bars[0].close, 140);
  assert.equal(bars[0].currency, 'GBP');
  assert.equal(bars[0].priceScale, 0.01);
  assert.equal(bars[0].marketQuote.price, 1.6);
  assert.equal(bars[0].marketQuote.asOf, new Date((now - 10) * 1000).toISOString());
  assert.equal(bars[0].session.exchange, 'London');
  assert.equal((await yahoo.listing({ symbol: 'EXAMPLE.L' })).currency, 'GBP');
  assert.equal(calls, 1);
});

test('a Canadian ETF can be found and priced without accepting unrelated instruments or future trades', async t => {
  const symbol = 'TESTFUND.TO';
  const stamp = Math.floor(Date.now() / 1000);
  t.mock.method(axios, 'get', async url => {
    if (url.endsWith('/search')) return { data: { quotes: [
      { symbol, quoteType: 'ETF', shortname: 'Test Fund' }, { symbol: 'PAIR', quoteType: 'CURRENCY' },
    ] } };
    return { data: { chart: { result: [{
      meta: { symbol, instrumentType: 'ETF', currency: 'CAD', exchangeTimezoneName: 'America/Toronto',
        regularMarketPrice: 999, regularMarketTime: stamp + 3600 },
      timestamp: [stamp - 86400], indicators: { quote: [{ close: [25] }] },
    }] } } };
  });
  assert.deepEqual((await yahoo.matches(symbol)).map(row => row.symbol), [symbol]);
  const history = await yahoo.dailyHistory(symbol);
  assert.equal(history[0].close, 25);
  assert.equal(history[0].marketQuote, undefined);
});

test('intraday quotes pick the latest available trade including extended hours and refresh after one minute', async t => {
  let stamp = Math.floor(Date.now() / 60_000) * 60;
  t.mock.method(Date, 'now', () => stamp * 1000);
  let calls = 0;
  t.mock.method(axios, 'get', async (_, { params }) => {
    calls++;
    if (calls === 3) throw new Error('Connection lost');
    assert.deepEqual(params, { range: '1d', interval: '1m', includePrePost: true });
    const window = { start: stamp - 3600, end: stamp + 1200 };
    return { data: { chart: { result: [{
      meta: { symbol: 'LIVE', currency: 'USD', instrumentType: 'EQUITY', regularMarketPrice: 20,
        regularMarketTime: stamp - 7200, currentTradingPeriod: calls === 1 ? { pre: window } : { post: window } },
      timestamp: [stamp - 120, stamp - 60, stamp, stamp + 60],
      indicators: { quote: [{ close: [15, 20 + calls, null, 1000] }] },
    }] } } };
  });
  const first = await yahoo.latestQuote('LIVE');
  assert.equal(first.price, 21);
  assert.equal(first.source, 'Yahoo Finance pre-market');
  assert.deepEqual([...first.minutes], [[(stamp - 60) * 1000, 15], [stamp * 1000, 21]]);
  stamp += 30;
  assert.deepEqual(await yahoo.latestQuote('LIVE'), first);
  stamp += 31;
  const next = await yahoo.latestQuote('LIVE');
  assert.equal(next.price, 22);
  assert.equal(next.source, 'Yahoo Finance after-hours');
  assert.equal(next.asOf, new Date((stamp - 60) * 1000).toISOString());
  stamp += 61;
  const offline = await yahoo.latestQuote('LIVE');
  assert.equal(offline.price, next.price);
  assert.equal(offline.asOf, next.asOf);
  assert.match(offline.source, /last available/);
  assert.equal(calls, 3);
});

test('Yahoo fundamentals only compare matching periods and currencies', async t => {
  const recent = new Date().toISOString().slice(0, 10);
  const point = (date, raw, unit, periodType) => ({ asOfDate: date, reportedValue: { raw }, currencyCode: unit, periodType });
  const data = {
    quarterlyTotalRevenue: [point('2025-01-31', 50, 'CAD', '3M'), point('2026-01-31', 80, 'USD', '3M')],
    trailingTotalRevenue: [point('2026-01-31', 200, 'USD', 'TTM')],
    trailingNetIncome: [point('2025-10-31', 40, 'USD', 'TTM')],
    trailingPeRatio: [point(recent, 19, null, 'TTM')],
  };
  t.mock.method(axios, 'get', async () => ({ data: { timeseries: { result: Object.entries(data).map(([type, points]) => ({
    meta: { symbol: ['PERIOD'], type: [type] }, [type]: points,
  })) } } }));
  const result = await yahoo.overview('PERIOD');
  assert.equal(result.QuarterlyRevenueGrowthYOY, null);
  assert.equal(result.ProfitMargin, null);
  assert.equal(result.TrailingPE, 19);
  assert.equal(result.Source, 'Yahoo Finance');
});

test('USD/CAD and CAD/USD use opposite sides of the same dated Bank of Canada rate when Yahoo metadata is incomplete', async t => {
  let bankRequests = 0;
  t.mock.method(axios, 'get', async url => {
    if (url.startsWith('https://query1.finance.yahoo.com/')) {
      return { data: { chart: { result: [{ meta: { symbol: 'UNKNOWN', instrumentType: 'CURRENCY' } }] } } };
    }
    assert.equal(url, 'https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json');
    bankRequests++;
    return { data: { seriesDetail: { FXUSDCAD: { label: 'USD/CAD' } },
      observations: [{ d: '2026-01-05', FXUSDCAD: { v: '1.25' } }] } };
  });
  const forward = await market.exchangeRate('USD', 'CAD');
  const reverse = await market.exchangeRate('CAD', 'USD');
  assert.equal(forward.source, 'Bank of Canada daily average');
  assert.equal(forward.asOf, '2026-01-05');
  assert.equal(forward.rate, 1.25);
  assert.equal(reverse.rate, 0.8);
  assert.equal(bankRequests, 1);
});

test('Yahoo throttling falls back independently and avoids repeated Yahoo requests', async t => {
  const oldKey = process.env.ALPHA_VANTAGE_KEY;
  const oldSource = process.env.WATCHLIST_MARKET_SOURCE;
  process.env.ALPHA_VANTAGE_KEY = 'fixture';
  delete process.env.WATCHLIST_MARKET_SOURCE;
  t.after(() => {
    if (oldKey === undefined) delete process.env.ALPHA_VANTAGE_KEY;
    else process.env.ALPHA_VANTAGE_KEY = oldKey;
    if (oldSource !== undefined) process.env.WATCHLIST_MARKET_SOURCE = oldSource;
  });
  let attempts = 0;
  t.mock.method(axios, 'get', async url => {
    if (url.startsWith('https://query1.finance.yahoo.com/')) {
      attempts++;
      const error = new Error('Too many requests');
      error.response = { status: 429, headers: { 'retry-after': '120' } };
      throw error;
    }
    return { data: { 'Time Series (Daily)': { '2026-01-01': { '4. close': '100' } } } };
  });
  for (const symbol of ['FALL1', 'FALL2']) assert.equal((await market.dailyHistory(symbol))[0].source, 'Alpha Vantage');
  assert.equal(attempts, 1);
});
