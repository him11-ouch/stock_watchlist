const market = require('./market.cjs');
const { money, roundedMoney } = require('./portfolio.cjs');
const { equityChart } = require('./equity-chart.cjs');

const dayMs = 86400000;
const torontoDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit',
});
const finite = value => Number.isFinite(value) ? value : null;
const percentage = value => value == null ? '—' : (value > 0 ? '+' : '') + value.toFixed(2) + '%';

function isRecent(date, now) {
  const stamp = Date.parse(date + 'T00:00:00Z');
  if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== date) return false;
  const age = (now.getTime() - stamp) / dayMs;
  return age >= 0 && age < 8;
}

// An exchange's regular-session window only establishes its status on that local date.
function sessionStatus(session, now, symbol) {
  if (!session || !Number.isFinite(session.start) || !Number.isFinite(session.end) ||
      session.end <= session.start) return null;
  const start = new Date(session.start * 1000);
  const end = new Date(session.end * 1000);
  const zone = session.timezone || (/\.TO$/.test(symbol) ? 'America/Toronto' : null);
  if (now >= start && now < end) return 'open';
  if (!zone) return null;
  try {
    const local = new Intl.DateTimeFormat('en-CA', { timeZone: zone });
    return local.format(start) === local.format(now) ? 'closed' : null;
  } catch {
    return null;
  }
}

function usableQuote(quote, now) {
  return quote && Number.isFinite(quote.price) && quote.price > 0 && quote.currency && typeof quote.asOf === 'string' &&
    isRecent(quote.asOf.slice(0, 10), now) && Date.parse(quote.asOf) <= now.getTime();
}

async function marketPrice(position, listings, provider, clock, signal) {
  const listing = await provider.resolveListing(position.symbol, listings, signal);
  if (listing.symbol !== market.watchSymbol(position.symbol)) throw new Error('Exact listing could not be verified.');
  position.currency = listing.currency;
  const history = await provider.dailyHistory(listing.symbol, signal);
  const now = clock();
  const bar = history.at(-1);
  if (!bar || !Number.isFinite(bar.close) || bar.close <= 0) throw new Error('Closing price unavailable.');
  if (listing.currency && bar.currency && listing.currency !== bar.currency) {
    throw new Error('The listing and quote report different currencies.');
  }
  position.currency = bar.currency || listing.currency;
  if (!position.currency) throw new Error('Price currency unavailable.');
  position.date = bar.date;
  position.session = sessionStatus(bar.session, now, position.symbol);
  const scale = bar.priceScale ?? listing.priceScale ?? 1;
  position.close = finite(bar.close * scale);
  if (!(position.close > 0)) throw new Error('Price units unavailable.');
  const quote = bar.marketQuote?.currency === position.currency && usableQuote(bar.marketQuote, now) ? bar.marketQuote : null;
  if (!isRecent(bar.date, now)) {
    if (quote) return quote;
    throw new Error('Stale or invalid close date.');
  }
  if (position.reviewBelow != null && position.close <= position.reviewBelow) {
    position.alerts.push('At or below your review price of ' + money(position.reviewBelow, position.currency));
  }
  if (position.reviewAbove != null && position.close >= position.reviewAbove) {
    position.alerts.push('At or above your review price of ' + money(position.reviewAbove, position.currency));
  }
  const previous = history.at(-2);
  if (previous && previous.date < bar.date && Number.isFinite(previous.close) && previous.close > 0) {
    position.changePercent = finite(100 * (bar.close / previous.close - 1));
    position.dayImpact = finite((bar.close - previous.close) * scale * position.shares);
  }
  return quote || { price: position.close, currency: position.currency, asOf: bar.date, source: (bar.source || 'Market') + ' close' };
}

async function buildDashboard(rows, profile, listings, provider = market, asOf, signal) {
  const currency = profile.currency;
  const cash = finite(profile.cash);
  const clock = () => asOf ?? new Date();
  const fx = new Map();
  async function conversion(from) {
    if (from === currency) return { rate: 1 };
    if (!fx.has(from)) fx.set(from, provider.exchangeRate(from, currency, signal));
    const quote = await fx.get(from);
    if (!(Number.isFinite(quote?.rate) && quote.rate > 0 && isRecent(quote.asOf?.slice(0, 10), clock()))) {
      throw new Error('FX rate is stale or unavailable.');
    }
    return { ...quote, from };
  }

  const positions = [];
  for (const row of rows.filter(row => row.shares > 0)) {
    signal?.throwIfAborted();
    const position = {
      symbol: row.symbol, shares: row.shares, avgCost: finite(row.avg_cost),
      reviewBelow: finite(row.review_below), reviewAbove: finite(row.review_above),
      close: null, date: null, currency: null, quote: null, value: null, cost: null, returnPercent: null,
      changePercent: null, dayImpact: null, weight: null, alerts: [],
    };
    positions.push(position);
    const [daily, intraday] = await Promise.allSettled([
      marketPrice(position, listings, provider, clock, signal), provider.latestQuote?.(row.symbol, signal),
    ]);
    signal?.throwIfAborted();
    if (daily.status === 'fulfilled') position.quote = daily.value;
    else position.issue = daily.reason.message;
    const current = intraday.status === 'fulfilled' ? intraday.value : null;
    const now = clock();
    if (usableQuote(current, now) && (!position.currency || position.currency === current.currency) &&
        (!position.quote || Date.parse(current.asOf) >= Date.parse(position.quote.asOf))) {
      position.quote = current;
      position.currency = current.currency;
    }
    const broker = { price: row.broker_price, currency: row.broker_price_currency, asOf: row.broker_price_at, source: 'Broker price' };
    if (usableQuote(broker, now) && (!position.quote || Date.parse(broker.asOf) >= Date.parse(position.quote.asOf))) {
      position.quote = broker;
    }
    if (!position.quote) continue;
    if (position.quote.currency === position.currency && position.avgCost > 0) {
      position.returnPercent = finite(100 * (position.quote.price / position.avgCost - 1));
    }
    try {
      const exchange = await conversion(position.quote.currency);
      if (exchange.from) position.fx = exchange;
      position.value = finite(position.quote.price * row.shares * exchange.rate);
      if (position.value == null) throw new Error('Position value exceeds the supported numeric range.');
      if (position.currency) {
        const costRate = position.currency === position.quote.currency ? exchange.rate : (await conversion(position.currency)).rate;
        if (position.avgCost != null) position.cost = finite(position.avgCost * row.shares * costRate);
        if (position.cost > 0) position.returnPercent = finite(100 * (position.value / position.cost - 1));
        if (position.dayImpact != null) position.dayImpact = finite(position.dayImpact * costRate);
      }
    } catch (error) {
      position.dayImpact = null;
      position.issue = error.message;
    }
  }

  const priced = positions.filter(p => p.value != null);
  const pricedSubtotal = priced.reduce((sum, p) => sum + p.value, 0);
  const equity = cash != null && priced.length === positions.length ? finite(cash + pricedSubtotal) : null;
  const invested = positions.every(p => p.cost != null) ? finite(positions.reduce((sum, p) => sum + p.cost, 0)) : null;
  const gain = invested != null && priced.length === positions.length ? finite(pricedSubtotal - invested) : null;
  const returnPercent = gain != null && invested > 0 ? finite(100 * gain / invested) : null;
  if (equity > 0) {
    for (const p of positions) {
      p.weight = finite(100 * p.value / equity);
      if (profile.max_weight > 0 && p.weight > profile.max_weight) {
        p.overweight = `Weight ${p.weight.toFixed(1)}% exceeds your ${profile.max_weight}% single-stock limit.`;
      }
    }
  }
  const composition = positions.map(p => [p.symbol, p.shares]).sort(([a], [b]) => a.localeCompare(b));
  const now = clock();
  return {
    currency, cash, equity, invested, gain, returnPercent, positions, pricedSubtotal: finite(pricedSubtotal),
    brokerEquity: finite(profile.broker_equity), brokerDate: profile.broker_date, date: torontoDate.format(now),
    startingEquity: finite(profile.starting_equity), recordedAt: now.toISOString(),
    compositionKey: JSON.stringify([currency, cash, composition]),
  };
}

function priceLabel(quote) {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: quote.currency,
    currencyDisplay: 'code', maximumFractionDigits: 8 }).format(quote.price);
}

function quoteTime(asOf, seconds = false) {
  if (!asOf.includes('T')) return asOf;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: seconds ? '2-digit' : undefined,
    hourCycle: 'h23' }).format(new Date(asOf)) + ' ET';
}

function brokerDifference({ equity, brokerEquity, currency }) {
  if (equity == null || brokerEquity == null) return null;
  // Compare the two displayed balances at the reporting currency's precision.
  return roundedMoney(equity, currency) - roundedMoney(brokerEquity, currency);
}

function equityCheck(view) {
  const { positions, currency, cash, equity, brokerEquity } = view;
  const amount = value => value == null ? 'unavailable' : money(value, currency);
  const lines = ['Check against your broker'];
  for (const p of positions) {
    const price = p.quote ? `${priceLabel(p.quote)} (${p.quote.source}, ${quoteTime(p.quote.asOf)})` : 'price unavailable';
    const fx = p.fx ? ` × ${p.fx.rate} ${currency}/${p.fx.from} (FX ${p.fx.asOf})` : '';
    lines.push(`  ${p.symbol}  ${p.shares} × ${price}${fx} = ${p.value == null ? 'unavailable' : amount(p.value)}`);
    if (p.issue) lines.push(`    ${p.issue}`);
  }
  lines.push(`  Holdings ${equity == null ? '(priced only) ' : ''}${amount(view.pricedSubtotal)}   Cash ${amount(cash)}`,
    `  Calculated equity ${equity == null ? 'unavailable' : amount(equity)}   Broker total ${amount(brokerEquity)}${view.brokerDate ? ' (' + view.brokerDate + ')' : ''}`);
  if (equity == null) {
    lines.push('Check incomplete. Review each holding marked unavailable and its price or exchange rate.');
    return { matches: false, lines };
  }
  const difference = brokerDifference(view);
  if (difference === 0) lines.push('Your calculated equity matches your broker total.');
  else lines.push(`Your calculated equity is ${amount(Math.abs(difference))} ${difference < 0 ? 'below' : 'above'} your broker total.`,
    'Compare the tickers, share counts, cash, quote times and FX with the same broker screen.');
  return { matches: difference === 0, lines };
}

function renderDashboard(snapshot, history = []) {
  const { currency, cash, equity, invested, gain, returnPercent, positions } = snapshot;
  const amount = value => value == null ? '—' : money(value, currency);
  const lines = [`PORTFOLIO INTELLIGENCE  ${snapshot.date}`, ''];
  const sessions = [...new Set(positions.map(p => p.session))];
  if (positions.length) {
    lines.push(sessions.length === 1 ? 'Regular market session ' + (sessions[0] || 'unavailable').toUpperCase() :
      'Regular market session ' + positions.map(p => p.symbol + ' ' + (p.session || 'unavailable')).join(', '));
  }
  lines.push(`Total equity  ${amount(equity)}    Cash  ${amount(cash)}`,
    `Invested cost  ${amount(invested)}    Unrealized P/L  ${amount(gain)}    Return on open holdings  ${percentage(returnPercent)}`);
  if (equity == null) {
    lines.push('Incomplete valuation. Priced holdings subtotal ' + amount(snapshot.pricedSubtotal) + '.');
  }
  if (snapshot.brokerEquity != null) {
    const difference = brokerDifference(snapshot);
    lines.push(`Entered broker equity${snapshot.brokerDate ? ' (' + snapshot.brokerDate + ')' : ''}  ${amount(snapshot.brokerEquity)}`);
    if (difference === 0) lines.push('Your calculated equity matches that broker total.');
    else {
      if (difference != null) lines.push(`Calculated equity is ${amount(Math.abs(difference))} ${difference < 0 ? 'below' : 'above'} that broker total.`);
      lines.push('Type edit to check each holding and cash, or edit broker to enter an updated broker total.');
    }
  }
  if (positions.length && invested == null) lines.push('A complete cost basis and valuation are needed for portfolio P/L.');
  if (positions.some(p => p.currency && p.currency !== currency)) {
    lines.push('Foreign cost and P/L use the displayed FX rate. Purchase-date FX gains and losses are excluded.');
  }

  lines.push('', positions.length ? `YOUR HOLDINGS (${positions.length})` : 'YOUR HOLDINGS');
  if (!positions.length) lines.push('No shares recorded.');
  else {
    const grid = [
      ['Stock', 'Shares', 'Price used', 'Market value', 'Return', 'Price as of'],
      ...positions.map(p => [p.symbol, String(p.shares), p.quote ? priceLabel(p.quote) : '—',
        amount(p.value), percentage(p.returnPercent), p.quote ? quoteTime(p.quote.asOf) : '—']),
    ];
    const widths = grid[0].map((_, i) => Math.max(...grid.map(row => row[i].length)));
    for (const row of grid) {
      lines.push(row.map((cell, i) => i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i])).join('  '));
    }
    for (const p of positions) {
      if (p.issue) lines.push(p.symbol + ' — ' + p.issue);
      if (p.overweight) lines.push(p.symbol + ' — ' + p.overweight);
      for (const alert of p.alerts) lines.push(p.symbol + ' — ' + alert);
    }
    const sources = [...new Set(positions.map(p => p.quote?.source).filter(Boolean))];
    if (sources.length === 1) lines.push('Price source  ' + sources[0]);
    if (sources.length > 1) lines.push(positions.filter(p => p.quote).map(p => p.symbol + ' ' + p.quote.source).join(', '));
    const fx = new Map(positions.filter(p => p.fx).map(p => [p.fx.from, p.fx]));
    for (const [from, quote] of fx) {
      lines.push(`FX  1 ${from} = ${quote.rate} ${currency}   ${quote.asOf}${quote.source ? '   ' + quote.source : ''}`);
    }

    const day = positions.filter(p => p.changePercent != null).map(p => p.date).sort().at(-1);
    const movers = positions.filter(p => p.date === day && p.changePercent != null);
    lines.push('', 'MARKET MOVEMENTS');
    if (movers.length) {
      const worst = movers.reduce((a, b) => a.changePercent < b.changePercent ? a : b);
      const coverage = `${movers.length}/${positions.length} holdings with comparable closes`;
      if (worst.changePercent < 0) {
        lines.push(`Largest percentage decline  ${worst.symbol}  ${percentage(worst.changePercent)} on ${day}   ${coverage}`);
        lines.push(`Price impact on your current quantity  ${amount(worst.dayImpact)} at the valuation FX rate`);
        const losses = movers.filter(p => p.dayImpact < 0).sort((a, b) => a.dayImpact - b.dayImpact);
        if (losses.length && losses[0].symbol !== worst.symbol) {
          lines.push(`Largest priced holding loss  ${losses[0].symbol}  ${amount(losses[0].dayImpact)}`);
        }
        lines.push(`Enter ${worst.symbol} to review its financials and recent headlines.`);
      } else lines.push(`No declines on ${day}   ${coverage}`);
    } else lines.push('Comparable recent closes unavailable.');
  }
  lines.push('', equityChart(snapshot, history));
  if (process.stdout.isTTY && !('NO_COLOR' in process.env) && process.env.TERM !== 'dumb') {
    return lines.map(line => {
      if (/^[A-Z][A-Z ]+(?:$| {2}[0-9]| \([0-9]+\)$)/.test(line)) return '\x1b[1m' + line + '\x1b[0m';
      return line.replace(/([+-])\d+\.\d+%/g, (value, sign) =>
        (sign === '+' ? '\x1b[32m' : '\x1b[31m') + value + '\x1b[0m');
    });
  }
  return lines;
}

module.exports = { buildDashboard, renderDashboard, equityCheck, priceLabel, quoteTime };
