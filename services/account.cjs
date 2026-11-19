const db = require('../db.cjs');
const { isDeepStrictEqual } = require('node:util');
const { watchSymbol } = require('./market.cjs');
const { money } = require('./portfolio.cjs');

const profile = () => db.prepare(`SELECT p.*, s.equity AS starting_equity FROM portfolio_profile p
  LEFT JOIN portfolio_starting_equity s ON s.currency = p.currency WHERE p.id = 1`).get();
const startingEquity = currency => db.prepare('SELECT equity FROM portfolio_starting_equity WHERE currency = ?').get(currency)?.equity ?? null;
const firstValuation = currency => db.prepare(`SELECT date, recorded_at, equity FROM portfolio_snapshots
  WHERE currency = ? ORDER BY date, recorded_at, id LIMIT 1`).get(currency);
const holdings = () => db.prepare('SELECT * FROM watchlist WHERE shares > 0 ORDER BY symbol').all();

function ticker(input) {
  if (!/^[a-z0-9][a-z0-9.-]{0,30}$/i.test(input || '')) throw new Error('Enter a stock ticker such as T.TO.');
  return watchSymbol(input);
}

function quantity(value) {
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) || !Number.isFinite(Number(value))) {
    throw new Error('Enter a nonnegative number, for example 2.5.');
  }
  return Number(value);
}

const saveHolding = db.prepare(`INSERT INTO watchlist (symbol, shares, avg_cost) VALUES (?, ?, ?)
  ON CONFLICT(symbol) DO UPDATE SET shares = excluded.shares, avg_cost = excluded.avg_cost,
    broker_price = CASE WHEN excluded.shares > 0 THEN broker_price END,
    broker_price_currency = CASE WHEN excluded.shares > 0 THEN broker_price_currency END,
    broker_price_at = CASE WHEN excluded.shares > 0 THEN broker_price_at END`);

async function confirm(read, question) {
  for (;;) {
    const answer = (await read(question + ' [y/N] '))?.trim().toLowerCase();
    if (answer === 'yes' || answer === 'y') return true;
    if (!answer || ['no', 'n', 'cancel'].includes(answer)) return false;
    console.log('Enter y for yes or n for no');
  }
}

function holdingSummary({ symbol, shares, avg_cost, broker_price, broker_price_currency, broker_price_at }) {
  const cost = avg_cost == null ? 'purchase cost unspecified' : `average cost ${avg_cost} in listing currency`;
  const price = broker_price == null ? '' : `, broker price ${broker_price} ${broker_price_currency} entered ${broker_price_at}`;
  return `  ${symbol}  ${shares} shares, ${cost}${price}`;
}

function profileSummary(details, positions) {
  const { currency, cash, broker_equity, max_weight, horizon } = details;
  const lines = [
    `Currency            ${currency}`,
    `Cash                ${money(cash, currency)}`,
    `Broker equity        ${broker_equity == null ? 'Unspecified' : money(broker_equity, currency)}`,
    `Starting equity      ${details.starting_equity == null ? 'First recorded balance' : money(details.starting_equity, currency)}`,
    `Single-stock limit   ${max_weight == null ? 'Unspecified' : max_weight + '%'}`,
    `Time horizon         ${horizon || 'Unspecified'}`,
    'Holdings',
  ];
  const owned = positions.filter(row => row.shares > 0);
  if (!owned.length) lines.push('  No shares recorded');
  lines.push(...owned.map(holdingSummary));
  return lines.join('\n');
}

const profileHoldings = () => db.prepare(`SELECT symbol, shares, avg_cost, broker_price, broker_price_currency, broker_price_at
  FROM watchlist WHERE shares > 0 ORDER BY symbol`).all();

const setBrokerPrice = db.prepare(`UPDATE watchlist SET broker_price = ?, broker_price_currency = ?, broker_price_at = ?
  WHERE symbol = ?`);

const saveProfile = db.transaction((old, original, draft, positions) => {
  if (!isDeepStrictEqual(old, profile()) || !isDeepStrictEqual(original, profileHoldings())) {
    throw new Error('The portfolio changed in another session. Reopen the editor to review the latest balances.');
  }
  const previous = new Map(original.map(row => [row.symbol, row]));
  for (const symbol of previous.keys()) {
    if (!positions.has(symbol)) saveHolding.run(symbol, 0, null);
  }
  for (const row of positions.values()) {
    if (isDeepStrictEqual(row, previous.get(row.symbol))) continue;
    saveHolding.run(row.symbol, row.shares, row.avg_cost);
    setBrokerPrice.run(row.broker_price, row.broker_price_currency, row.broker_price_at, row.symbol);
  }
  let opening = draft.starting_equity;
  if (!old && opening == null && !firstValuation(draft.currency)) opening = draft.broker_equity;
  if (opening != null) {
    db.prepare(`INSERT INTO portfolio_starting_equity (currency, equity) VALUES (?, ?)
      ON CONFLICT(currency) DO UPDATE SET equity = excluded.equity`).run(draft.currency, opening);
  } else {
    db.prepare('DELETE FROM portfolio_starting_equity WHERE currency = ?').run(draft.currency);
  }
  db.prepare(`INSERT OR REPLACE INTO portfolio_profile
    (id, currency, cash, broker_equity, broker_date, max_weight, horizon) VALUES (1, ?, ?, ?, ?, ?, ?)`)
    .run(draft.currency, draft.cash, draft.broker_equity, draft.broker_date, draft.max_weight, draft.horizon);
});

const latestSnapshot = db.prepare(`SELECT date, recorded_at, equity, composition_key FROM portfolio_snapshots
  WHERE currency = ? ORDER BY date DESC, recorded_at DESC, id DESC LIMIT 1`);
const insertSnapshot = db.prepare(`INSERT INTO portfolio_snapshots
  (date, recorded_at, currency, equity, cash, composition_key, activity) VALUES (?, ?, ?, ?, ?, ?, ?)`);
const saveSnapshot = db.transaction((view, activity, live) => {
  const last = latestSnapshot.get(view.currency);
  if (live && last?.recorded_at > view.recordedAt) return;
  if (last?.date === view.date && last.equity === view.equity && last.composition_key === view.compositionKey &&
      (!live || last.recorded_at?.slice(0, 16) === view.recordedAt.slice(0, 16))) return;
  const reason = activity ?? (last?.composition_key === view.compositionKey ? 'Market valuation' : 'Balance recorded');
  insertSnapshot.run(view.date, view.recordedAt, view.currency, view.equity, view.cash, view.compositionKey, reason);
});

function recordSnapshot(view, activity = null, live = false) {
  if (Number.isFinite(view.equity)) saveSnapshot.immediate(view, activity, live);
}

function equityHistory(view) {
  return db.prepare(`SELECT date, recorded_at, currency, equity, cash, composition_key, activity FROM portfolio_snapshots
    WHERE currency = ? AND (date < ? OR (date = ? AND (recorded_at IS NULL OR recorded_at <= ?)))
    ORDER BY date, recorded_at, id`).all(view.currency, view.date, view.date, view.recordedAt);
}

module.exports = { profile, holdings, ticker, quantity, saveHolding, confirm, profileSummary, holdingSummary, startingEquity, firstValuation,
  profileHoldings, saveProfile, recordSnapshot, equityHistory };

