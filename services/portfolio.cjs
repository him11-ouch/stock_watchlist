const market = require('./market.cjs');

const money = (amount, currency) => new Intl.NumberFormat('en-CA', {
  style: 'currency', currency, currencyDisplay: 'code',
}).format(amount);

const decimalFormats = new Map();
function roundedMoney(amount, currency) {
  if (!decimalFormats.has(currency)) {
    const { maximumFractionDigits } = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions();
    decimalFormats.set(currency, new Intl.NumberFormat('en', { maximumFractionDigits, useGrouping: false }));
  }
  return Number(decimalFormats.get(currency).format(amount));
}

async function portfolio(rows, base, listings, provider = market) {
  const lines = ['Daily closing prices'];
  let total = 0;
  let valued = 0;
  const owned = rows.filter(row => row.shares > 0).length;
  const fx = new Map();
  for (const { symbol, shares } of rows) {
    const position = shares ? `${shares} shares` : 'watch only';
    try {
      const listing = await provider.resolveListing(symbol, listings);
      if (listing.symbol !== market.watchSymbol(symbol) || !listing.currency) {
        throw new Error('Exact listing and quote currency could not be verified.');
      }
      const history = await provider.dailyHistory(listing.symbol);
      const { close, date, currency, source, priceScale } = history.at(-1);
      if (currency && currency !== listing.currency) throw new Error('The listing and price currencies disagree.');
      const age = (Date.now() - Date.parse(date + 'T00:00:00Z')) / 86400000;
      const stale = !Number.isFinite(age) || age < 0 || age >= 8;
      const change = history.length > 1 ? (close / history.at(-2).close - 1) * 100 : null;
      const move = change === null ? '' : ` | ${change >= 0 ? '+' : ''}${change.toFixed(2)}% vs prior close`;
      const unitPrice = close * (priceScale ?? listing.priceScale ?? 1);
      lines.push(`${symbol} | ${position} | ${money(unitPrice, listing.currency)} on ${date}${move}${stale ? ' | stale quote' : ''}${source ? ' | ' + source : ''}`);
      if (!shares) continue;
      const value = shares * unitPrice;
      lines.push(`  Holding value at close: ${money(value, listing.currency)}`);
      if (stale) continue;
      let converted = value;
      if (listing.currency !== base) {
        if (!fx.has(listing.currency)) fx.set(listing.currency, await provider.exchangeRate(listing.currency, base));
        const { rate, asOf } = fx.get(listing.currency);
        const fxAge = (Date.now() - Date.parse(asOf.slice(0, 10) + 'T00:00:00Z')) / 86400000;
        if (!Number.isFinite(fxAge) || fxAge < 0 || fxAge >= 8) throw new Error(`FX quote is stale or undated (${asOf}).`);
        converted *= rate;
        lines.push(`  ${money(converted, base)} at ${rate} ${base}/${listing.currency} (${asOf})`);
      }
      if (!Number.isFinite(total + converted)) throw new Error('Position value exceeds the supported numeric range.');
      total += converted;
      valued++;
    } catch (error) {
      lines.push(`${symbol} (${position}) — ${error.message}`);
    }
  }
  if (!rows.length) lines.push('Your watchlist is empty. Use watch TICKER or hold TICKER SHARES.');
  if (valued === owned) lines.push(`Total stock equity: ${money(total, base)} (${owned} holdings)`);
  else lines.push(`Total stock equity unavailable. Valued subtotal: ${money(total, base)} (${valued} of ${owned} holdings).`);
  return lines;
}

module.exports = { portfolio, money, roundedMoney };
