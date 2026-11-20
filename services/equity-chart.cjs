const { money, roundedMoney } = require('./portfolio.cjs');
const { plotEquity, maxGapMs } = require('./terminal-plot.cjs');

const clock = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Toronto', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit',
});
const calendar = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' });
const minute = 60_000;
const day = 24 * 60 * minute;
const trendRanges = [
  { key: 'hour', label: 'Last hour', duration: 60 * minute },
  { key: 'day', label: 'Past day', duration: day },
  { key: 'week', label: 'Past week', duration: 7 * day },
  { key: 'month', label: 'Past month', duration: 30 * day },
  { key: 'year', label: 'Past year', duration: 365 * day },
  { key: 'all', label: 'Since inception', duration: Infinity },
];
const stamp = row => row.recorded_at ?? row.recordedAt;
const composition = row => row.composition_key ?? row.compositionKey;
const when = row => stamp(row) || row.estimated ? `${row.date} ${clock.format(new Date(stamp(row) ?? row.time))} ET` : row.date;

function pointCaption(point) {
  if (point.interpolated) return `Interpolated at ${calendar.format(point.time)} ${clock.format(point.time)} ET`;
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

function todaysPnl(view, history) {
  const label = "Today's P&L";
  if (!Number.isFinite(view.equity)) return label + ' awaits a complete valuation.';
  const yesterday = new Date(Date.parse(view.date) - day).toISOString().slice(0, 10);
  const readings = history.filter(row => row.currency === view.currency && Number.isFinite(row.equity) &&
    row.date >= yesterday && row.date <= view.date);
  const last = readings.at(-1);
  if (!last || stamp(last) !== stamp(view) || last.equity !== view.equity || composition(last) !== composition(view)) readings.push(view);
  const opening = readings.findLast(row => row.date === yesterday) ?? readings[0];
  if (opening === readings.at(-1)) return label + ' awaits a second reading.';
  let funding = 0;
  let previous = opening;
  for (const row of readings.slice(readings.indexOf(opening) + 1)) {
    // Money in saved funding activities uses en-CA formatting in the account currency.
    const flow = /^(Deposit|Withdraw)\s+[A-Z]{3}\s+([\d,]+(?:\.\d+)?)$/.exec(row.activity ?? '');
    if (flow) funding += (flow[1] === 'Deposit' ? 1 : -1) * Number(flow[2].replaceAll(',', ''));
    else if (composition(previous) !== composition(row) && !/^(Buy|Sell) /.test(row.activity ?? '')) {
      return label + ' unavailable after an unclassified balance change.';
    }
    previous = row;
  }
  const { difference, percent } = balanceChange(view.equity - funding, opening.equity, view.currency);
  const relative = percent == null ? '' : ` (${percent > 0 ? '+' : ''}${percent.toFixed(2)}%)`;
  const baseline = opening.date === yesterday ? 'since ' + when(opening) : 'since first reading today';
  return label + '  ' + (difference > 0 ? '+' : '') + money(difference, view.currency) + relative + ' ' + baseline;
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

// Reserve the same space for currency labels when switching live ranges.
function liveLabelWidth(view, history) {
  let low = view.equity ?? 0, high = low;
  for (const row of history) {
    if (row.currency !== view.currency || !Number.isFinite(row.equity)) continue;
    low = Math.min(low, row.equity);
    high = Math.max(high, row.equity);
  }
  return 'High '.length + Math.max(money(low, view.currency).length, money(high, view.currency).length);
}

function equityChartLayout(view, history = [], columns = process.stdout.columns || 80, { compact = false, rows = 6, inspectable = false,
  range = trendRanges[0], asOf = stamp(view) || view.date } = {}) {
  const { currency } = view;
  const amount = value => money(value, currency);
  const signed = value => (value > 0 ? '+' : '') + amount(value);
  const lines = compact ? [] : ['TOTAL EQUITY HISTORY (' + currency + ')'];
  const until = Date.parse(asOf);
  const cutoff = compact ? until - range.duration : -Infinity;
  // Include the preceding date so a gap straddling the cutoff can still use today's minute bars.
  const firstDate = Number.isFinite(cutoff) ? new Date(cutoff - day).toISOString().slice(0, 10) : '';
  const records = history.filter(row => row.currency === currency && row.date >= firstDate && Number.isFinite(row.equity));
  const last = records.at(-1);
  if (Number.isFinite(view.equity) && (last?.date !== view.date || last.equity !== view.equity || last.cash !== view.cash ||
      (compact && stamp(last) !== stamp(view)))) records.push(view);
  const observations = records.map(row => ({ ...row, equity: roundedMoney(row.equity, currency),
    time: Date.parse(stamp(row) || row.date) })).filter(row => Number.isFinite(row.time)).sort((a, b) => a.time - b.time);
  if (!observations.length) return { lines: lines.concat(compact && history.length ? 'No readings in this period.' :
    'Waiting for a complete valuation of cash and holdings.'), plot: null };
  if (view.equity == null) lines.push('Current valuation incomplete. Showing the last recorded balances.');

  const first = observations[0];
  let points = observations;
  let daily = false;
  if (compact) {
    const inRange = p => p.time >= cutoff && p.time <= until && (range.key !== 'hour' || stamp(p) || p.estimated);
    points = observations.filter(inRange);
    daily = points.length > 1 && points.at(-1).time - points[0].time >= 2 * day;
    if (daily) {
      points = points.filter((p, i, all) => i === 0 || p.date !== all[i + 1]?.date);
      lines.push('Opening reading and last recorded equity each day');
    } else points = pointsForPlot(observations, view).filter(inRange);
    if (!points.length) return { lines: lines.concat('No readings in this period.'), plot: null };
  } else points = pointsForPlot(observations, view);
  const start = points[0], end = points.at(-1);
  const bounded = Number.isFinite(cutoff);
  const from = bounded ? cutoff : start.time;
  const to = compact ? until : end.time;
  const leftDate = bounded ? calendar.format(from) : start.date;
  const rightDate = !compact ? end.date : asOf === view.date ? view.date : calendar.format(to);
  function tick(time, date, timed) {
    if (!timed) return date;
    const hour = clock.format(time).slice(0, 5) + ' ET';
    if (leftDate === rightDate || (compact && range.key === 'hour')) return hour;
    return compact && range.key === 'day' ? date.slice(5) + ' ' + hour : date;
  }
  const axis = { from, to, left: tick(from, leftDate, bounded || stamp(start) || start.estimated),
    right: tick(to, rightDate, compact ? asOf !== view.date : stamp(end) || end.estimated) };
  if (bounded && leftDate < start.date) lines.push('First reading in this period  ' + when(start));
  let plot = null;
  if (inspectable) lines.push('Hover or use ← → for point details');
  const top = lines.length;
  if (compact || points.length > 1) {
    const drawing = plotEquity(points, currency, columns, rows, {
      axis, inspectable, liveRange: compact ? range.key : undefined, labelWidth: compact ? liveLabelWidth(view, history) : 0,
      gapLimit: daily ? 2 * day : maxGapMs,
    });
    if (drawing.geometry) plot = { ...drawing.geometry, top };
    lines.push(...drawing.lines);
    const estimates = points.filter(p => p.estimated).length;
    if (estimates) lines.push(`${estimates} estimated minutes from Yahoo prices and FX using the recorded positions.`);
    if (drawing.gaps) lines.push(compact && range.key !== 'hour' ? 'Line connects available readings across gaps.' :
      'Blank intervals have insufficient price history.');
    if (points.length === 1) lines.push('One reading in this period.');
  } else {
    const prefix = when(end) + '   ';
    if (inspectable) {
      const samples = [{ column: 0, row: 0, point: end, leftIndex: -1, rightIndex: 1 }];
      plot = { left: prefix.length, top, height: 1, cells: [[1]], samples, targets: samples, hits: [new Map([[0, 0]])] };
    }
    lines.push(prefix + '●  ' + amount(end.equity), `Starting balance on ${when(first)}`);
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

module.exports = { equityChart, equityChartLayout, pointCaption, openingEquity, changeSinceStart, todaysPnl, trendRanges };
