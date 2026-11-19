const { money, roundedMoney } = require('./portfolio.cjs');
const { plotEquity, maxGapMs } = require('./terminal-plot.cjs');

const clock = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Toronto', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit',
});
const minute = 60_000;
const stamp = row => row.recorded_at ?? row.recordedAt;
const composition = row => row.composition_key ?? row.compositionKey;
const when = row => stamp(row) || row.estimated ? `${row.date} ${clock.format(new Date(stamp(row) ?? row.time))} ET` : row.date;

function pointCaption(point) {
  return (point.estimated ? 'Estimated' : 'Recorded') + ' at ' + when(point);
}

function openingEquity(view, history) {
  if (Number.isFinite(view.startingEquity)) return view.startingEquity;
  return history.find(row => row.currency === view.currency && Number.isFinite(row.equity))?.equity ?? view.equity;
}

function balanceChange(end, start, currency) {
  const opening = roundedMoney(start, currency);
  const difference = roundedMoney(roundedMoney(end, currency) - opening, currency);
  return { difference, percent: opening > 0 ? 100 * difference / opening : null };
}

function changeSinceStart(view, history) {
  const opening = openingEquity(view, history);
  if (!Number.isFinite(opening) || !Number.isFinite(view.equity)) return 'Change awaits a complete valuation.';
  const { difference, percent } = balanceChange(view.equity, opening, view.currency);
  const from = 'since your ' + money(opening, view.currency) + ' start';
  if (!difference) return 'Unchanged ' + from;
  const relative = percent == null ? '' : ` (${Math.abs(percent).toFixed(2)}%)`;
  return (difference > 0 ? 'Up ' : 'Down ') + money(Math.abs(difference), view.currency) + relative + ' ' + from;
}

// Fill only bracketed gaps today with the same recorded shares and cash at both ends.
// Every estimated minute requires actual, completed price and FX bars for that minute.
function pointsForPlot(observations, view) {
  const points = [];
  const positions = view.positions || [];
  const canEstimate = view.compositionKey && Number.isFinite(view.cash) && positions.length > 0 &&
    positions.every(p => p.quote?.minutes?.size && (p.quote.currency === view.currency || p.fx?.minutes?.size));
  let previous;
  for (const row of observations) {
    if (canEstimate && previous?.date === view.date && row.date === view.date && stamp(previous) && stamp(row) && row.time - previous.time > maxGapMs &&
        composition(previous) === view.compositionKey && composition(row) === view.compositionKey) {
      for (let time = (Math.floor(previous.time / minute) + 1) * minute; time < row.time; time += minute) {
        let equity = view.cash;
        for (const p of positions) {
          const price = p.quote.minutes.get(time);
          const rate = p.quote.currency === view.currency ? 1 : p.fx.minutes.get(time);
          if (!(price > 0 && rate > 0)) { equity = NaN; break; }
          equity += p.shares * price * rate;
        }
        if (Number.isFinite(equity)) points.push({ date: view.date, time, equity: roundedMoney(equity, view.currency), estimated: true });
      }
    }
    points.push(row);
    previous = row;
  }
  return points;
}

function equityChartLayout(view, history = [], columns = process.stdout.columns || 80, { compact = false, rows = 6, inspectable = false } = {}) {
  const { currency } = view;
  const amount = value => money(value, currency);
  const signed = value => (value > 0 ? '+' : '') + amount(value);
  const lines = [compact ? 'EQUITY TREND  ·  Last hour' : 'TOTAL EQUITY HISTORY (' + currency + ')'];
  const records = history.filter(row => row.currency === currency && Number.isFinite(row.equity));
  const last = records.at(-1);
  if (Number.isFinite(view.equity) && (last?.date !== view.date || last.equity !== view.equity || last.cash !== view.cash)) records.push(view);
  const observations = records.map(row => ({ ...row, equity: roundedMoney(row.equity, currency),
    time: Date.parse(stamp(row) || row.date) })).filter(row => Number.isFinite(row.time)).sort((a, b) => a.time - b.time);
  if (!observations.length) return { lines: lines.concat('Waiting for a complete valuation of cash and holdings.'), plot: null };
  if (view.equity == null) lines.push('Current valuation incomplete. Showing the last recorded balances.');

  const first = observations[0], end = observations.at(-1);
  let points = pointsForPlot(observations, view);
  if (compact) points = points.filter(p => p.time >= end.time - 60 * minute);
  const start = points[0];
  const tickLabel = p => start.date === end.date && (stamp(p) || p.estimated) ? clock.format(p.time).slice(0, 5) + ' ET' : p.date;
  start.tick = tickLabel(start);
  end.tick = tickLabel(end);
  let plot = null;
  if (inspectable) lines.push('Hover or use ← → for point details');
  const top = lines.length;
  if (points.length > 1) {
    const drawing = plotEquity(points, currency, columns, rows, inspectable);
    if (drawing.geometry) plot = { ...drawing.geometry, top };
    lines.push(...drawing.lines);
    const estimates = points.filter(p => p.estimated).length;
    if (estimates) lines.push(`${estimates} estimated minutes from Yahoo prices and FX using the recorded positions.`);
    if (drawing.gaps) lines.push('Blank intervals have insufficient price history.');
  } else {
    const prefix = when(end) + '   ';
    if (inspectable) plot = { left: prefix.length, top, height: 1, cells: [[1]],
      samples: [{ column: 0, row: 0, point: end }] };
    lines.push(prefix + '●' + (compact ? '' : '  ' + amount(end.equity)),
      compact ? 'One reading in this hour. The next live check adds a point.' : `Starting balance on ${when(first)}`);
  }
  if (compact) return { lines, plot };

  if (observations.length > 1) lines.push(`${when(first)} to ${when(end)} (${observations.length} observations in order)`);
  const opening = openingEquity(view, observations);
  const { difference, percent } = balanceChange(end.equity, opening, currency);
  const relative = percent == null ? '' : ` (${difference > 0 ? '+' : ''}${percent.toFixed(2)}%)`;
  lines.push(`Start ${amount(opening)}   End ${amount(end.equity)}   Equity change ${signed(difference)}${relative}`);
  if (observations.length > 1 && Number.isFinite(first.cash) && Number.isFinite(end.cash)) {
    const cashChange = balanceChange(end.cash, first.cash, currency).difference;
    const measured = balanceChange(end.equity, first.equity, currency).difference;
    lines.push(`Cash balance change ${signed(cashChange)}   Holdings value change ${signed(measured - cashChange)}` +
      (roundedMoney(opening, currency) === first.equity ? '' : ' since the first recorded valuation'));
  }
  if (end.activity) {
    const previousPoint = observations.at(-2);
    const movement = previousPoint ? ` (${signed(balanceChange(end.equity, previousPoint.equity, currency).difference)} in total equity)` : '';
    lines.push(`Last recorded update  ${end.activity}${movement}`);
  }
  return { lines, plot };
}

function equityChart(...args) {
  return equityChartLayout(...args).lines.join('\n');
}

module.exports = { equityChart, equityChartLayout, pointCaption, openingEquity, changeSinceStart };
