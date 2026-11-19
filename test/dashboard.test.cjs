const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDashboard, renderDashboard, equityCheck } = require('../services/dashboard.cjs');
const { equityChart, changeSinceStart } = require('../services/equity-chart.cjs');

const now = new Date('2026-11-18T22:00:00Z');
const profile = { currency: 'CAD', cash: 200, broker_equity: 670 };
const rows = [
  { symbol: 'AC.TO', shares: 10, avg_cost: 20 },
  { symbol: 'MSFT', shares: 2, avg_cost: 110, review_below: 99 },
  { symbol: 'NVDA', shares: 0, avg_cost: null },
];

function provider() {
  return {
    async resolveListing(symbol) {
      return { symbol, currency: symbol === 'AC.TO' ? 'CAD' : 'USD' };
    },
    async dailyHistory(symbol) {
      const prices = symbol === 'AC.TO' ? [21, 22] : [100, 98];
      return prices.map((close, i) => ({
        date: '2026-11-' + (17 + i), close, source: 'Test',
        session: { start: Date.parse('2026-11-18T14:30Z') / 1000, end: Date.parse('2026-11-18T21:00Z') / 1000, timezone: 'America/New_York' },
      }));
    },
    async exchangeRate() { return { rate: 1.25, asOf: '2026-11-18', source: 'Test FX' }; },
  };
}

test('dashboard values cash and fractional-capable holdings, attributions, cost basis and user review bands', async () => {
  const snapshot = await buildDashboard(rows, profile, [], provider(), now);
  assert.equal(snapshot.positions.length, 2);
  assert.equal(snapshot.equity, 665);
  assert.equal(snapshot.invested, 475);
  assert.equal(snapshot.gain, -10);
  assert.equal(snapshot.returnPercent, -1000 / 475);
  assert.equal(snapshot.positions[1].dayImpact, -5);
  assert.deepEqual(snapshot.positions[1].alerts, ['At or below your review price of USD\u00a099.00']);
  assert.equal(snapshot.positions[1].weight, 100 * 245 / 665);
  const text = renderDashboard(snapshot).join('\n').replaceAll('\u00a0', ' ');
  assert.match(text, /Regular market session CLOSED/);
  assert.match(text, /Largest percentage decline  MSFT  -2.00% on 2026-11-18/);
  assert.match(text, /Price impact on your current quantity  -CAD 5.00/);
  assert.match(text, /FX  1 USD = 1.25 CAD\s+2026-11-18\s+Test FX/);
  assert.match(text, /Starting balance on 2026-11-18/);
});

test('stale FX prevents full valuation, stale closes suppress price review, missing cost prevents P\/L only', async () => {
  const data = provider();
  data.exchangeRate = async () => ({ rate: 1.25, asOf: '2020-01-01' });
  const partial = await buildDashboard(rows, profile, [], data, now);
  assert.equal(partial.equity, null);
  assert.equal(partial.pricedSubtotal, 220);
  assert.equal(partial.gain, null);
  assert.equal(partial.positions[1].weight, null);
  assert.match(partial.positions[1].issue, /FX rate is stale/);
  assert.equal(partial.positions[1].alerts.length, 1);
  data.dailyHistory = async () => [{ date: '2020-01-01', close: 1 }];
  const stale = await buildDashboard(rows, profile, [], data, now);
  assert.equal(stale.equity, null);
  assert.deepEqual(stale.positions[1].alerts, []);
  const missingCost = await buildDashboard([{ symbol: 'AC.TO', shares: 1.5 }], profile, [], provider(), now);
  assert.equal(missingCost.equity, 233);
  assert.equal(missingCost.invested, null);
  assert.equal(missingCost.gain, null);
});

test('the broker check uses the newest dated price while review alerts still use completed closes', async () => {
  const data = provider();
  data.dailyHistory = async () => [{ close: 100, date: '2026-11-17', currency: 'USD', source: 'Test',
    marketQuote: { price: 110, currency: 'USD', asOf: '2026-11-18T20:00:00Z', source: 'Test quote' } }];
  const row = { symbol: 'MSFT', shares: 0.5, avg_cost: 105, review_below: 101,
    broker_price: 150, broker_price_currency: 'CAD', broker_price_at: '2026-11-18T19:00:00Z' };
  const details = { currency: 'CAD', cash: 0.15, broker_equity: 68.90 };
  const market = await buildDashboard([row], details, [], data, now);
  assert.equal(market.equity, 68.9);
  assert.equal(equityCheck(market).matches, true);
  assert.equal(market.positions[0].alerts.length, 1);
  assert.equal(market.positions[0].quote.source, 'Test quote');
  row.broker_price_at = '2026-11-18T21:00:00Z';
  const broker = await buildDashboard([row], details, [], data, now);
  assert.equal(broker.equity, 75.15);
  assert.equal(broker.positions[0].quote.source, 'Broker price');
  assert.equal(broker.positions[0].cost, 65.625);
  assert.match(equityCheck(broker).lines.join('\n').replaceAll('\u00a0', ' '), /CAD 6.25 above/);
  data.exchangeRate = async () => { throw new Error('FX unavailable'); };
  row.broker_price_currency = 'USD';
  const missing = await buildDashboard([row], details, [], data, now);
  assert.equal(missing.equity, null);
  assert.equal(equityCheck(missing).matches, false);
  assert.match(equityCheck(missing).lines.join('\n'), /FX unavailable/);
  data.dailyHistory = async () => { throw new Error('No price'); };
  row.broker_price_at = '2026-10-01T21:00:00Z';
  assert.equal((await buildDashboard([row], details, [], data, now)).equity, null);
});

test('equity chart spans holding and cash changes, comparing only complete valuations in the same currency', async () => {
  const snapshot = await buildDashboard(rows, profile, [], provider(), now);
  const log = [
    { date: '2026-11-14', currency: 'CAD', composition_key: snapshot.compositionKey, equity: 500, cash: 100 },
    { date: '2026-11-14', currency: 'USD', composition_key: 'other', equity: 1 },
    { date: '2026-11-15', currency: 'CAD', composition_key: 'different', equity: 900 },
    { date: '2026-11-17', currency: 'CAD', equity: null },
    { date: '2026-11-18', currency: 'CAD', composition_key: snapshot.compositionKey, equity: 660 },
  ];
  const chart = renderDashboard(snapshot, log).at(-1).replaceAll('\u00a0', ' ');
  assert.match(chart, /2026-11-14 to 2026-11-18 .*4 observations/);
  assert.match(chart, /Start CAD 500.00 +End CAD 665.00 +Equity change \+CAD 165.00 \(\+33.00%\)/);
  assert.match(chart, /Cash balance change \+CAD 100.00 +Holdings value change \+CAD 65.00/);
  const incomplete = renderDashboard({ ...snapshot, equity: null }, log).at(-1);
  assert.match(incomplete, /Current valuation incomplete/);
  assert.match(incomplete, /3 observations/);
});

test('a narrow graph retains the opening balance, intervening peak, and latest change', () => {
  const points = Array.from({ length: 100 }, (_, i) => ({
    date: '2026-11-18', currency: 'CAD', equity: i === 49 ? 1600 : 1000 + i, cash: 100,
    activity: 'Market valuation',
  }));
  const chart = equityChart(points.at(-1), points, 30).replaceAll('\u00a0', ' ');
  assert.match(chart, /High CAD 1,600\.00 │/);
  assert.match(chart, /Low CAD 1,000\.00 │/);
  assert.doesNotMatch(chart, /Latest CAD/);
  assert.match(chart, /100 observations in order/);
  assert.match(chart, /Start CAD 1,000.00 +End CAD 1,099.00/);
  assert.match(chart, /Market valuation \(\+CAD 1.00 in total equity\)/);
});

test('the since-start change uses displayed currency precision and a fixed opening amount', () => {
  const opening = { currency: 'CAD', date: '2026-03-10', equity: 824.19442, cash: 10 };
  const current = { ...opening, date: '2026-03-11', equity: 805.84717, brokerEquity: 809 };
  const text = equityChart(current, [opening]).replaceAll('\u00a0', ' ');
  assert.match(text, /Start CAD 824.19 +End CAD 805.85 +Equity change -CAD 18.34/);
  assert.match(text, /Holdings value change -CAD 18.34/);
  assert.match(text, /Blank intervals/);
  assert.doesNotMatch(text, /[┐└┘┌]/);
  assert.match(changeSinceStart({ ...current, startingEquity: 800 }, [opening]).replaceAll('\u00a0', ' '),
    /Up CAD 5.85 \(0.73%\) since your CAD 800.00 start/);
  assert.doesNotMatch(changeSinceStart({ ...current, startingEquity: 0 }, []), /%|Infinity/);
  assert.match(changeSinceStart({ ...current, equity: null }, [opening]), /awaits a complete valuation/);
});

test('a gap can show estimated minute values only with matching holdings, cash and complete historical FX', () => {
  const minute = 60_000;
  const from = Date.parse('2026-11-18T15:00:00Z');
  const key = 'unchanged holdings and cash';
  const first = { date: '2026-11-18', recorded_at: new Date(from).toISOString(), composition_key: key, currency: 'CAD', equity: 50, cash: 10 };
  const units = new Map([[from + minute, 20], [from + 2 * minute, 30], [from + 3 * minute, 1000]]);
  const rates = new Map([[from + minute, 1.5], [from + 2 * minute, 1.6]]);
  const view = { date: first.date, currency: 'CAD', cash: 10, equity: 56, recordedAt: new Date(from + 8 * minute).toISOString(),
    compositionKey: key, positions: [{ shares: 2, quote: { currency: 'USD', minutes: units }, fx: { minutes: rates } }] };
  const chart = equityChart(view, [first]).replaceAll('\u00a0', ' ');
  assert.match(chart, /CAD 106.00 │/); // 2 × 30 USD × 1.6 + 10 CAD.
  assert.match(chart, /2 estimated minutes/);
  assert.match(chart, /2 observations in order/);
  assert.match(chart, /Blank intervals/);
  assert.doesNotMatch(equityChart(view, [{ ...first, composition_key: 'different' }]), /estimated minutes/);
  assert.doesNotMatch(equityChart({ ...view, date: '2026-11-19' }, [first]), /estimated minutes/);
});
