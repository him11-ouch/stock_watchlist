const techIdeas = [
  { symbol: 'SHOP.TO', name: 'Shopify', question: 'How much of the growth in merchant sales translates into free cash flow?' },
  { symbol: 'CSU.TO', name: 'Constellation Software', question: 'Are returns on new acquisitions keeping pace with the capital spent?' },
  { symbol: 'CLS.TO', name: 'Celestica', question: 'Is growth in hardware sales translating into sustainable operating margins?' },
  { symbol: 'OTEX.TO', name: 'OpenText', question: 'Does recurring revenue generate enough cash to fund investment and reduce debt?' },
  { symbol: 'DSG.TO', name: 'Descartes Systems Group', question: 'How much of revenue growth comes from existing operations versus acquisitions?' },
].map(stock => ({ ...stock, currency: 'CAD' }));

const usTech = [
  { symbol: 'MSFT', name: 'Microsoft', question: 'Is Azure growth producing enough operating cash flow to cover new data-center spending?' },
  { symbol: 'AAPL', name: 'Apple', question: 'Can services profit and iPhone demand support the current earnings multiple?' },
  { symbol: 'NVDA', name: 'NVIDIA', question: 'Are data-center sales and gross margins holding up as customers introduce their own chips?' },
  { symbol: 'GOOGL', name: 'Alphabet', question: 'How are AI search costs and cloud investment affecting free cash flow per share?' },
  { symbol: 'AMZN', name: 'Amazon', question: 'Is AWS operating income growing fast enough to offset higher infrastructure spending?' },
];

function daysSince(date, today) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return NaN;
  const timestamp = Date.parse(date + 'T00:00:00Z');
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) return NaN;
  return Math.floor((today - timestamp) / 86400000);
}

function metric(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function percent(value) {
  return (value * 100).toFixed(1) + '%';
}

function assess(history, overview = {}, today = new Date()) {
  const window = history.slice(-21);
  const latest = window.at(-1);
  const lines = [];
  const age = daysSince(latest?.date, today);
  if (!Number.isFinite(age) || age < 0 || age > 7) {
    lines.push(latest?.date ? 'Latest price date is ' + latest.date + '.' : 'A dated closing price is unavailable.');
    lines.push('Refresh the quote before assessing this listing.');
    return { label: 'Insufficient recent price data', rank: 0, lines };
  }

  if (window.length < 21 || window.some((day, index) => !Number.isFinite(day.close) || day.close <= 0 ||
      !Number.isFinite(daysSince(day.date, today)) || (index > 0 && day.date <= window[index - 1].date))) {
    lines.push('A 20-session comparison requires 21 dated, positive closing prices in chronological order.');
    return { label: 'Insufficient price history', rank: 0, lines };
  }
  const first = window[0];
  const change = latest.close / first.close - 1;
  lines.push('20-session price change ' + percent(change) + ' (' + first.date + ' to ' + latest.date + ').');
  const largeMove = window.some((day, index) => index > 0 && Math.abs(day.close / window[index - 1].close - 1) >= 0.4);
  if (largeMove) {
    lines.push('A one-session move of at least 40% appears in the unadjusted closes. Check for a split or a material event.');
    return { label: 'Review price history before ranking', rank: 0, lines };
  }

  const quarter = overview?.LatestQuarter;
  const quarterAge = daysSince(quarter, today);
  const pe = metric(overview?.TrailingPE) ?? metric(overview?.PERatio);
  const growth = metric(overview?.QuarterlyRevenueGrowthYOY);
  const margin = metric(overview?.ProfitMargin);
  if (quarter) {
    lines.push('Fiscal quarter ' + quarter + ' | YoY revenue growth ' + (growth === null ? 'unavailable' : percent(growth)) +
      ' | net margin ' + (margin === null ? 'unavailable' : percent(margin)) +
      ' | trailing P/E ' + (pe === null ? 'unavailable' : pe > 0 ? pe.toFixed(1) + 'x' : 'not meaningful') + '.');
  }
  if (!Number.isFinite(quarterAge) || quarterAge < 0 || quarterAge > 185 || growth === null || margin === null ||
      (pe === null && growth > 0 && margin > 0)) {
    lines.push('The fundamentals screen needs recent data on earnings, revenue growth and profitability.');
    lines.push('Check the latest earnings release and compare valuation with peers.');
    return { label: change > 0 ? 'Positive price trend, fundamentals unconfirmed' : 'Flat or falling price, fundamentals unconfirmed', rank: 1, lines };
  }

  if (growth <= 0 || margin <= 0 || pe <= 0) {
    lines.push('This screen requires growing revenue, positive net margin and positive trailing earnings.');
    lines.push('Examine whether the latest weakness is temporary or structural.');
    return { label: 'Lower research priority on fundamentals', rank: 1, lines };
  }
  if (pe > 30) {
    lines.push('The multiple exceeds the screen’s 30x ceiling. Test what growth would justify that price.');
    return { label: 'Growing and profitable, valuation needs a closer look', rank: 2, lines };
  }
  lines.push('Revenue is growing, margins are positive and trailing P/E is within the 30x screen ceiling.');
  lines.push('Compare cash flow, debt and peer multiples before making an investment decision.');
  return { label: 'Worth deeper research', rank: 3, lines };
}

const listings = [
  ...techIdeas,
  { symbol: 'T.TO', name: 'TELUS', currency: 'CAD' },
  { symbol: 'AC.TO', name: 'Air Canada', currency: 'CAD' },
  ...usTech.map(stock => ({ ...stock, currency: 'USD' })),
];

module.exports = { assess, techIdeas, listings };
