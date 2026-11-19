const db = require('../db.cjs');
const market = require('./market.cjs');
const account = require('./account.cjs');
const { money } = require('./portfolio.cjs');

function positive(input) {
  const n = account.quantity(input);
  if (n <= 0) throw new Error('Enter an amount above zero');
  return n;
}

async function tradeCash(symbol, shares, price, brokerTotal, currency, listings) {
  if (brokerTotal != null) return { amount: positive(brokerTotal), detail: 'Using your broker’s cash total' };
  const listing = await market.resolveListing(symbol, listings);
  if (listing.symbol !== symbol || !listing.currency) {
    throw new Error('Could not verify the listing currency. Enter the broker cash total as the last argument.');
  }
  const nativeValue = shares * price;
  if (listing.currency === currency) return { amount: nativeValue };
  const fx = await market.exchangeRate(listing.currency, currency);
  const stamp = Date.parse(fx.asOf?.slice(0, 10) + 'T00:00:00Z');
  const age = (Date.now() - stamp) / 86400000;
  if (!Number.isFinite(age) || age < 0 || age >= 8 || !Number.isFinite(fx.rate) || fx.rate <= 0) {
    throw new Error('A recent exchange rate is unavailable. Enter the broker cash total as the last argument.');
  }
  return {
    amount: nativeValue * fx.rate,
    detail: `Estimated from ${money(nativeValue, listing.currency)} at ${fx.rate} ${currency}/${listing.currency} on ${fx.asOf}`,
  };
}

async function recordTransaction(action, args, read, listings, recordBeforeChange) {
  const profile = account.profile();
  if (!profile) throw new Error('Run setup to record your starting cash and holdings');
  const { currency, cash } = profile;
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
  const decimal = new Intl.NumberFormat('en', { maximumFractionDigits: digits, useGrouping: false });
  const roundCash = value => Number(decimal.format(value));
  const isTrade = action === 'buy' || action === 'sell';
  let symbol, old, newShares, newCost, amount, activity, detail;
  if (isTrade) {
    if (args.length < 3 || args.length > 4) throw new Error(`Use ${action} TICKER SHARES PRICE [BROKER_CASH_TOTAL]`);
    symbol = account.ticker(args[0]);
    const shares = positive(args[1]);
    const price = positive(args[2]);
    old = db.prepare('SELECT shares, avg_cost FROM watchlist WHERE symbol = ?').get(symbol);
    const held = old?.shares ?? 0;
    if (action === 'sell' && shares > held) throw new Error(`You have ${held} shares of ${symbol} recorded`);
    const settlement = await tradeCash(symbol, shares, price, args[3], currency, listings);
    amount = roundCash(settlement.amount);
    detail = settlement.detail;
    newShares = Number((held + (action === 'buy' ? shares : -shares)).toPrecision(15));
    if (!Number.isFinite(newShares) || newShares === held) throw new Error('Share quantity exceeds the supported precision');
    newCost = old?.avg_cost ?? null;
    if (action === 'buy') {
      if (!held) newCost = price;
      else if (newCost != null) newCost += (price - newCost) * (shares / newShares);
    } else if (!newShares) newCost = null;
    activity = `${action === 'buy' ? 'Buy' : 'Sell'} ${shares} ${symbol} at ${price} per share`;
  } else {
    if (args.length !== 1) throw new Error(`Use ${action} AMOUNT in ${currency}`);
    amount = positive(args[0]);
    if (roundCash(amount) !== amount) throw new Error(`Enter an amount in ${currency} with up to ${digits} decimal places`);
    activity = `${action === 'deposit' ? 'Deposit' : 'Withdraw'} ${money(amount, currency)}`;
  }
  const debit = action === 'buy' || action === 'withdraw';
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('The cash total must be positive in your reporting currency');
  if (debit && amount > cash) throw new Error(`This needs ${money(amount, currency)}. Available cash is ${money(cash, currency)}.`);
  const newCash = roundCash(cash + (debit ? -amount : amount));
  if (!Number.isSafeInteger(Math.round(newCash * 10 ** digits))) throw new Error('Balance exceeds the supported currency precision');
  console.log(activity);
  if (detail) console.log(detail);
  console.log(`Cash ${money(cash, currency)} → ${money(newCash, currency)}`);
  if (isTrade) console.log(`${symbol} shares ${old?.shares ?? 0} → ${newShares}`);
  if (!await account.confirm(read, 'Record this change?')) {
    console.log('Cancelled');
    return null;
  }

  // Separate market moves since the last visit from the change about to be recorded.
  await recordBeforeChange();
  db.transaction(() => {
    const current = account.profile();
    if (current?.cash !== cash || current.currency !== currency) throw new Error('The cash balance changed. Review the transaction again.');
    if (isTrade) {
      const position = db.prepare('SELECT shares, avg_cost FROM watchlist WHERE symbol = ?').get(symbol);
      if (position?.shares !== old?.shares || position?.avg_cost !== old?.avg_cost) {
        throw new Error('This holding changed. Review the transaction again.');
      }
      account.saveHolding.run(symbol, newShares, newCost);
    }
    db.prepare('UPDATE portfolio_profile SET cash = ? WHERE id = 1').run(newCash);
  }).immediate();
  console.log('Recorded');
  return activity;
}

module.exports = { recordTransaction };
