const { setTimeout: delay } = require('node:timers/promises');
const { equityChartLayout, pointCaption, openingEquity, changeSinceStart } = require('./equity-chart.cjs');
const { money } = require('./portfolio.cjs');
const { priceLabel, quoteTime } = require('./dashboard.cjs');

const refreshMs = 60_000;

// Each valuation finishes before the next poll starts. Leaving the screen discards any pending result.
async function pollLive({ load, display, reportError }, signal, intervalMs = refreshMs) {
  while (!signal.aborted) {
    try {
      const view = await load(signal);
      if (signal.aborted) return;
      display(view);
    } catch (error) {
      if (signal.aborted) return;
      reportError(error.message);
    }
    try { await delay(intervalMs, undefined, { signal }); }
    catch (error) { if (signal.aborted) return; throw error; }
  }
}

// Five-pixel numerals use half blocks so the amount can be a three-line heading on a roomy terminal.
const digits = {
  '0': ['111','101','101','101','111'], '1': ['010','110','010','010','111'],
  '2': ['111','001','111','100','111'], '3': ['111','001','111','001','111'],
  '4': ['101','101','111','001','001'], '5': ['111','100','111','001','111'],
  '6': ['111','100','111','101','111'], '7': ['111','001','010','010','010'],
  '8': ['111','101','111','101','111'], '9': ['111','101','111','001','111'],
  ',': ['00','00','00','01','10'], '.': ['0','0','0','0','1'],
};

function equityHeading(view, columns, rows, styled, large) {
  const bold = text => styled ? '\x1b[1m' + text + '\x1b[0m' : text;
  if (!Number.isFinite(view.equity)) return [bold('TOTAL EQUITY'), bold('Awaiting a complete valuation')];
  const amount = money(view.equity, view.currency);
  const characters = [...amount.replace(view.currency, '').trim()];
  if (large && styled && rows >= 24 && characters.every(c => digits[c]) && characters.length * 4 + 2 < columns) {
    const lines = [bold('TOTAL EQUITY   ' + amount)];
    for (let y = 0; y < 5; y += 2) {
      lines.push(bold(characters.map(c => [...digits[c][y]].map((bit, x) =>
        ' ▄▀█'[2 * Number(bit) + Number(digits[c][y + 1]?.[x] || 0)]).join('')).join(' ')));
    }
    return lines;
  }
  return [bold('TOTAL EQUITY'), bold(amount)];
}

function liveLayout(view, history, columns = 80, { rows = 24, styled = false, details = false, loading = false, inspectable = false } = {}) {
  const amount = value => value == null ? 'unavailable' : money(value, view.currency);
  if (loading && !history.length) return { lines: [styled ? '  \x1b[1mTOTAL EQUITY\x1b[0m' : '  TOTAL EQUITY', '', '  Checking prices…'], plot: null };
  let plot = null;
  const lines = equityHeading(view, columns, rows, styled, !details);
  const headingHeight = lines.length;
  if (Number.isFinite(view.equity)) lines.push(changeSinceStart(view, history));
  else if (!details) lines.push('Type details to see which prices are missing.');
  lines.push('');
  if (details) {
    lines.push('HOLDINGS   Shares × price = market value');
    if (!view.positions.length) lines.push(loading ? 'Checking prices…' : 'No shares recorded');
    for (const p of view.positions) {
      const price = p.quote ? priceLabel(p.quote) : 'unavailable';
      const value = `${p.symbol}  ${p.shares} × ${price} = ${amount(p.value)}`;
      const stamp = p.quote ? quoteTime(p.quote.asOf).replace(view.date + ', ', '') : '';
      const source = p.quote ? `${stamp}  ${p.quote.source.replace('Yahoo Finance ', 'Yahoo ')}` : '';
      if (source && value.length + source.length + 5 >= columns) lines.push(value, '  ' + source);
      else lines.push(source ? value + '   ' + source : value);
      if (p.issue && p.value == null) lines.push('  ' + p.issue);
    }
    for (const fx of new Map(view.positions.filter(p => p.fx).map(p => [p.fx.from, p.fx])).values()) {
      lines.push(`FX  1 ${fx.from} = ${fx.rate} ${view.currency}  ${quoteTime(fx.asOf)}  ${fx.source || ''}`.trimEnd());
    }
  } else if (history.length || Number.isFinite(view.equity)) {
    const plotRows = Math.min(8, Math.max(2, rows - 17 - Number(inspectable)));
    const chart = equityChartLayout(view, history, columns - 2, { compact: true, rows: plotRows, inspectable });
    if (chart.plot) plot = { ...chart.plot, left: chart.plot.left + 2, top: chart.plot.top + lines.length };
    lines.push(...chart.lines);
  }
  const last = view.recorded_at || view.recordedAt;
  const checked = last ? quoteTime(last, true) : view.date;
  lines.push('', `Cash  ${amount(view.cash)}${loading ? '' : '    Holdings  ' + view.positions.length}`,
    loading ? (history.length ? `Last saved  ${checked}    Checking for newer prices…` : 'Checking for prices…')
      : `Last check  ${checked}    Refreshes here every 60s`);
  return { lines: lines.map(line => line ? '  ' + line : ''), plot, currency: view.currency,
    heading: { height: headingHeight, columns, rows, styled, startingEquity: openingEquity(view, history) } };
}

function liveFrame(...args) {
  return liveLayout(...args).lines;
}

function inspectedLines(frame, index) {
  const { plot } = frame;
  const sample = plot?.samples[index];
  if (!sample) return frame.lines;
  const lines = [...frame.lines];
  const { height, columns, rows, styled, startingEquity } = frame.heading;
  const historical = { equity: sample.point.equity, currency: frame.currency, startingEquity };
  const heading = equityHeading(historical, columns, rows, styled, height === 4);
  // Keep the plot under the pointer even if only one of the amounts fits in large type.
  for (let row = 0; row < height; row++) lines[row] = heading[row] ? '  ' + heading[row] : '';
  lines[height] = '  ' + changeSinceStart(historical, []);
  lines[plot.top - 1] = '  ' + pointCaption(sample.point);
  const column = plot.left + sample.column;
  for (let row = 0; row < plot.height; row++) {
    const line = lines[plot.top + row].padEnd(column + 1);
    const mark = row === sample.row ? '◆' : '┊';
    if (row === sample.row || line[column] === ' ') {
      lines[plot.top + row] = line.slice(0, column) + mark + line.slice(column + 1);
    }
  }
  return lines;
}

module.exports = { liveFrame, liveLayout, inspectedLines, pollLive };
