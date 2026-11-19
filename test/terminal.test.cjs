const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { portfolio } = require('../services/portfolio.cjs');

function terminalFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchlist-terminal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'existing.db');
  const oldDb = new Database(file);
  oldDb.exec(`CREATE TABLE watchlist (id INTEGER PRIMARY KEY, symbol TEXT UNIQUE NOT NULL, added_at TEXT);
    INSERT INTO watchlist (symbol) VALUES ('AC.TO')`);
  oldDb.close();

  // Replace only the HTTP transport, exercising the actual provider payload parsers and CLI.
  const fixture = path.join(dir, 'provider.cjs');
  fs.writeFileSync(fixture, `
    const prices = Array.from({ length: 21 }, (_, i) => {
      const date = new Date(Date.now() - (20 - i) * 86400000).toISOString().slice(0, 10);
      return [date, { '4. close': String(80 + i + Number(process.env.FIXTURE_PRICE_CHANGE || 0)) }];
    });
    require(${JSON.stringify(require.resolve('axios'))}).get = async (_, { params }) => {
      switch (params.function) {
        case 'SYMBOL_SEARCH':
          if (params.keywords === 'XIC.TRT') {
            return { data: { bestMatches: [{ '1. symbol': 'XIC.TRT', '2. name': 'Test Fund', '3. type': 'ETF', '8. currency': 'CAD' }] } };
          }
          return { data: { bestMatches: [{ '1. symbol': 'IBM', '2. name': 'International Business Machines', '3. type': 'Equity', '8. currency': 'USD' }] } };
        case 'TIME_SERIES_DAILY':
          return { data: params.symbol === 'AC.TO' ? {} : { 'Time Series (Daily)': Object.fromEntries(prices) } };
        case 'CURRENCY_EXCHANGE_RATE':
          return { data: { 'Realtime Currency Exchange Rate': { '1. From_Currency Code': 'USD', '3. To_Currency Code': 'CAD',
            '5. Exchange Rate': '1.25', '6. Last Refreshed': prices.at(-1)[0], '7. Time Zone': 'UTC' } } };
        case 'OVERVIEW':
          return { data: { Symbol: params.symbol, LatestQuarter: prices[0][0], TrailingPE: '20', QuarterlyRevenueGrowthYOY: '0.1', ProfitMargin: '0.2' } };
        default: throw new Error('Unexpected operation');
      }
    };
  `);
  const run = (input, args = [], priceChange = 0) => {
    const result = spawnSync(process.execPath, ['--require', fixture, path.resolve(__dirname, '../cli.cjs'), ...args], {
      env: { ...process.env, ALPHA_VANTAGE_KEY: 'fixture', WATCHLIST_MARKET_SOURCE: 'alpha', WATCHLIST_DB: file,
        FIXTURE_PRICE_CHANGE: String(priceChange) },
      input, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.replaceAll('\u00a0', ' ');
  };
  return { file, run };
}

test('terminal migrates an existing watchlist, values holdings and screens companies', t => {
  const { run } = terminalFixture(t);
  const output = run('list CAD\nhold AC.TO 2\nhold MSFT 1.5\nhold MSFT 1.5\nwatch MSFT\nlist CAD\nInternational Business Machines\nideas\nquit\n');
  assert.match(output, /AC\.TO \| watch only/);
  assert.match(output, /Total stock equity: CAD 387\.50 \(2 holdings\)/);
  assert.match(output, /International Business Machines \(IBM\)/);
  assert.match(output, /Shopify \(SHOP\.TO\) \| CAD/);
  assert.equal(output.match(/Worth deeper research/g)?.length, 6);
  assert.match(run('list USD\nquit\n'), /Valued subtotal: USD 150\.00 \(1 of 2 holdings\)/);
  assert.match(run('remove AC.TO\nhold MSFT 0\nlist CAD\nquit\n'), /Total stock equity: CAD 0\.00 \(0 holdings\)/);
  const setup = run('setup\ny\nMSFT\n1.5\n80\ndone\n1000\n1187.5\n25\n5 years\nyes\nalert MSFT above 95\ndashboard\nquit\n');
  assert.match(setup, /Total equity  CAD 1,187\.50/);
  assert.match(setup, /Unrealized P\/L  CAD 37\.50/);
  assert.match(setup, /At or above your review price of USD 95\.00/);
  assert.match(run('edit\ny\nholdings\nMSFT\n2\n99\ncancel\ndashboard\nquit\n'), /Total equity  CAD 1,187\.50/);
  assert.match(run('budget 200\nquit\n'), /CAD 200\.00 available from recorded cash/);
});

test('a profile draft needs explicit confirmation and the editor preserves unedited fields across restarts', t => {
  const { run } = terminalFixture(t);
  const draft = 'y\n\nT.TO\n1.25\n80.50\n\ndone\n250\n\n20\n5 years\n';
  run('\n', ['setup']);
  assert.match(run('', ['profile']), /No profile saved/);
  run(draft + '\n', ['setup']); // Blank final answer followed by EOF.
  assert.match(run('', ['profile']), /No profile saved/);
  const saved = run(draft + '\ncash\n225\nyes\n', ['setup']);
  assert.match(saved, /Portfolio totals use Canadian dollars \(CAD\)/);
  assert.match(saved, /Enter your first ticker, such as T\.TO/);
  assert.match(saved, /Total equity  CAD 350.00/);
  assert.doesNotMatch(saved, /[·•]/);
  run('y\ncash\n900\n\ncancel\n', ['profile', 'edit']);
  assert.match(run('', ['profile']), /Cash +CAD 225.00/);
  run('y\n1\nT.TO\n2\n2\ndone\n6\n8 years\nyes\n', ['edit']);
  const profile = run('', ['profile']);
  assert.match(profile, /T\.TO +2 shares, average cost 80.5/);
  assert.match(profile, /Cash +CAD 225.00/);
  assert.match(profile, /Single-stock limit +20%/);
  assert.match(profile, /Time horizon +8 years/);
});

test('blank tickers, back and a return to holdings preserve the draft until a specific correction balances the account', t => {
  const { run } = terminalFixture(t);
  const result = run([
    'y', 'TYPO', 'back', 'T.TO', '3', 'back', '1', '12.34', '',
    'MSFT', '0.5', '', 'done', '7.25', '369.75',
    'holdings', 'XIC.TO', '1', '', 'done', '20', '3 years',
    'yes', 'T.TO', '2', '2', 'yes',
  ].join('\n') + '\n', ['setup']);
  assert.match(result, /Enter another ticker, choose a holding number, or type done/);
  assert.match(result, /MSFT  0.5 × USD 100.00.*1.25 CAD\/USD.*CAD 62.50/);
  assert.match(result, /XIC.TO  1 × CAD 100.00.*= CAD 100.00/);
  assert.match(result, /CAD 100.00 below your broker total/);
  assert.match(result, /Saving is paused until the broker total matches/);
  assert.match(result, /Your calculated equity matches your broker total/);
  assert.match(result, /Total equity  CAD 369.75/);
  assert.equal(result.match(/Profile saved/g)?.length, 1);
  const profile = run('', ['profile']);
  assert.match(profile, /T.TO  2 shares, average cost 12.34/);
  assert.match(profile, /Cash +CAD 7.25/);
  assert.match(profile, /Time horizon +3 years/);
  assert.doesNotMatch(profile, /TYPO/);

  const difference = run('y\n8.25\nyes\ncancel\n', ['edit', 'cash']);
  assert.match(difference, /CAD 1.00 above your broker total/);
  assert.match(run('', ['profile']), /Cash +CAD 7.25/);
});

test('an incomplete equity check keeps edits unsaved until a dated broker price or a corrected ticker values the holding', t => {
  const { run, file } = terminalFixture(t);
  const input = 'y\nMISSING.TO\n2\n15\ndone\n3.50\n44.63\n\n\n';
  const incomplete = run(input + 'yes\n', ['setup']);
  assert.match(incomplete, /MISSING.TO  2 × price unavailable = unavailable/);
  assert.match(incomplete, /Check incomplete/);
  assert.doesNotMatch(incomplete, /Profile saved/);
  assert.match(run('', ['profile']), /No profile saved/);
  const saved = run(input + 'MISSING.TO\n4\n20.567 CAD\nyes\n', ['setup']);
  assert.match(saved, /2 × CAD 20.567 \(Broker price,/);
  assert.match(saved, /Your calculated equity matches your broker total/);
  assert.match(run('', ['dashboard']), /Total equity  CAD 44.63/);

  // Correct a symbol without retyping its shares or purchase cost. Its old quote belongs to the old symbol.
  const edited = run('y\n1\nT.TO\n3\n203.50\nyes\n', ['edit', 'MISSING.TO']);
  assert.match(edited, /CAD 158.87 above your broker total/);
  assert.match(edited, /Total equity  CAD 203.50/);
  assert.match(run('', ['profile']), /T.TO  2 shares, average cost 15/);
  const stored = new Database(file, { readonly: true });
  try {
    assert.deepEqual(stored.prepare("SELECT symbol, shares, broker_price FROM watchlist WHERE symbol IN ('T.TO', 'MISSING.TO') ORDER BY symbol").all(),
      [{ symbol: 'MISSING.TO', shares: 0, broker_price: null }, { symbol: 'T.TO', shares: 2, broker_price: null }]);
    assert.deepEqual(stored.prepare('SELECT equity FROM portfolio_snapshots ORDER BY id').all().map(r => Math.round(r.equity * 100)),
      [4463, 20350]);
  } finally { stored.close(); }
});

test('equity history keeps legacy points, intraday funding, trades and price moves without counting purchases as deposits', t => {
  const { file, run } = terminalFixture(t);
  const old = new Database(file);
  old.exec(`CREATE TABLE portfolio_snapshots (
    date TEXT NOT NULL, currency TEXT NOT NULL, equity REAL NOT NULL,
    composition_key TEXT NOT NULL, PRIMARY KEY(date, currency)
  )`);
  old.prepare('INSERT INTO portfolio_snapshots VALUES (?, ?, ?, ?)').run('2020-01-10', 'CAD', 900, '["CAD",900,[]]');
  old.prepare('INSERT INTO portfolio_snapshots VALUES (?, ?, ?, ?)').run('2020-01-10', 'USD', 99, '["USD",99,[]]');
  old.close();
  run('y\nnone\n1000\n\n\n\nyes\n', ['setup']);
  run('deposit 200\ny\nbuy MSFT 2 100\ny\nwithdraw 100\ny\nsell MSFT 1 100\ny\nquit\n');
  // A declined transaction and an unchanged valuation add no points.
  run('deposit 900\n\nbuy MSFT 200 100\nsell MSFT 2 100\ngraph\nquit\n');
  const chart = run('', ['graph'], 10);
  assert.match(chart, /Start CAD 900.00 +End CAD 1,112.50 +Equity change \+CAD 212.50/);
  assert.match(chart, /Market valuation \(\+CAD 12.50 in total equity\)/);
  const deposit = run('y\n', ['deposit', '50'], 20);
  assert.match(deposit, /Deposit CAD 50.00 \(\+CAD 50.00 in total equity\)/);
  const stored = new Database(file, { readonly: true });
  try {
    const rows = stored.prepare("SELECT equity, cash FROM portfolio_snapshots WHERE currency = 'CAD' ORDER BY id").all();
    assert.deepEqual(rows.map(row => row.equity), [900, 1000, 1200, 1200, 1100, 1100, 1112.5, 1125, 1175]);
    assert.deepEqual(rows.map(row => row.cash), [900, 1000, 1200, 950, 850, 975, 975, 975, 1025]);
    assert.equal(stored.prepare("SELECT shares FROM watchlist WHERE symbol = 'MSFT'").get().shares, 1);
    assert.equal(stored.prepare("SELECT COUNT(*) AS n FROM portfolio_snapshots WHERE currency = 'USD'").get().n, 1);
  } finally { stored.close(); }
});

test('starting equity is saved separately from the changing broker total and can be corrected independently', t => {
  const { run } = terminalFixture(t);
  run('y\nnone\n100\n100\n\n\nyes\n', ['setup']);
  run('y\n', ['deposit', '25']);
  assert.match(run('', ['graph']), /Start CAD 100.00 +End CAD 125.00 +Equity change \+CAD 25.00/);
  run('y\n125\nyes\n', ['edit', 'broker']);
  assert.match(run('', ['profile']), /Starting equity +CAD 100.00/);
  run('y\n', ['deposit', '10']); // The broker comparison now predates a deposit.
  assert.match(run('y\n110\nyes\n', ['edit', 'baseline']), /Profile saved/);
  assert.match(run('', ['graph']), /Start CAD 110.00 +End CAD 135.00 +Equity change \+CAD 25.00/);
  run('y\n90\ncancel\n', ['edit', 'baseline']);
  assert.match(run('', ['profile']), /Starting equity +CAD 110.00/);
  run('y\n-\nyes\n', ['edit', 'baseline']);
  assert.match(run('', ['graph']), /Start CAD 100.00 +End CAD 135.00 +Equity change \+CAD 35.00/);
});

test('stale prices cannot contribute to a current total and missing watch-only quotes do not count', async () => {
  const rows = [{symbol: 'OLD', shares: 3}, {symbol: 'WATCH', shares: 0}];
  const provider = {
    resolveListing: async symbol => ({ symbol, currency: 'CAD' }),
    dailyHistory: async symbol => {
      if (symbol === 'WATCH') throw new Error('No quote');
      return [{ date: '2000-01-01', close: 99 }];
    },
  };
  const output = (await portfolio(rows, 'CAD', [], provider)).join('\n');
  assert.match(output, /stale quote/);
  assert.match(output, /Valued subtotal: CAD\s0\.00 \(0 of 1 holdings\)/);
});
