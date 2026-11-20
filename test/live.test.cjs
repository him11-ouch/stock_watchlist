const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { liveFrame, liveLayout, inspectedLines, pollLive } = require('../services/live.cjs');
const { todaysPnl, trendRanges } = require('../services/equity-chart.cjs');
const { pointAt } = require('../services/terminal-plot.cjs');
const { TerminalInput } = require('../services/terminal-input.cjs');
const { buildDashboard } = require('../services/dashboard.cjs');

process.env.WATCHLIST_DB = ':memory:';
const account = require('../services/account.cjs');

test('each live range shows its saved readings and handles stale and empty windows', () => {
  const now = Date.parse('2026-11-19T21:00:00Z');
  const history = [9000, 3000, 480, 80, 18, 1, 0].map((hours, i) => {
    const stamp = new Date(now - hours * 3600000).toISOString();
    return { recorded_at: stamp, date: stamp.slice(0, 10), equity: 100 + i, cash: 10, currency: 'CAD' };
  });
  const view = { ...history.at(-1), positions: [] };
  for (const [i, range] of trendRanges.entries()) {
    const frame = liveLayout(view, history, 80, { range, inspectable: true });
    assert.ok(frame.lines[frame.selector.top].includes(`[ ${range.label} ▾ ]`));
    assert.equal(frame.plot.samples[0].point.equity, 105 - i);
    assert.equal(frame.plot.samples.at(-1).point.equity, 106);
  }
  const incomplete = { ...view, equity: null };
  const single = liveFrame(incomplete, history.slice(-1), 80).join('\n');
  assert.match(single, /One reading in this period/);
  const stale = liveFrame(incomplete, history.slice(0, 2), 80).join('\n');
  assert.match(stale, /No readings in this period/);
  const menu = liveLayout(incomplete, [], 80, { menuIndex: 4 });
  assert.ok(menu.selector);
  assert.match(menu.lines.join('\n'), /› 5  Past year/);
});

test('live ranges place sparse readings on the selected time axis at different terminal widths', () => {
  const date = '2026-11-19';
  const history = [
    ['14:10', 1824.19], ['21:12', 1802.75], ['23:02', 1772.87], ['23:51', 1772.87],
  ].map(([time, equity]) => ({ date, recorded_at: `${date}T${time}:00Z`, currency: 'CAD', cash: 1, equity }));
  const view = { ...history.at(-1), positions: [] };
  for (const columns of [64, 210]) {
    const layout = (range, readings = history) => liveLayout(view, readings, columns, { rows: 54, range, inspectable: true });
    const hour = layout(trendRanges[0]).plot;
    const width = hour.cells[0].length;
    assert.equal(hour.left + width, columns - 1);
    assert.equal(hour.height, 18);
    assert.ok(hour.cells.every(row => row[Math.floor(width / 2)] === 0));
    const starts = {};
    for (const range of trendRanges.slice(1)) {
      const frame = layout(range);
      const { plot } = frame;
      assert.equal(plot.left, hour.left);
      assert.equal(plot.cells[0].length, width);
      assert.equal(plot.height, hour.height);
      assert.deepEqual(plot.samples.map(s => s.point.recorded_at), history.map(s => s.recorded_at));
      const start = plot.samples[0].column;
      starts[range.key] = start;
      assert.equal(plot.samples.at(-1).column, width - 1);
      for (let x = 0; x < width; x++) assert.equal(plot.cells.some(row => row[x]), x >= start);
      assert.match(frame.lines.join('\n'), /connects available readings across gaps/);
      assert.ok(frame.lines[plot.top + plot.height].length < columns);
    }
    assert.equal(starts.all, 0);
    assert.ok(starts.all < starts.day && starts.day < starts.week && starts.week < starts.month);
    assert.equal(starts.year, width - 1);
    const single = layout(trendRanges[1], [view]).plot;
    assert.equal(single.left + single.cells[0].length, columns - 1);
    assert.equal(single.samples.length, 1);
    assert.equal(single.cells.reduce((total, row) => total + row.filter(Boolean).length, 0), 1);
  }
});

test('month and year plots use their own dates and equity history, even when the latest reading is stale', () => {
  const history = [
    ['2025-12-01', 1500], ['2026-08-17', 2500], ['2026-11-01', 2200], ['2026-11-15', 1747],
  ].map(([date, equity]) => ({ date, recorded_at: date + 'T18:00:00Z', currency: 'CAD', cash: 1, equity }));
  const view = { ...history.at(-1), positions: [] };
  // In Toronto this is still November 19. The chart ends four days after the last reading.
  const asOf = '2026-11-20T01:00:00Z';
  const layout = key => liveLayout(view, history, 160, { asOf, inspectable: true, range: trendRanges.find(r => r.key === key) });
  const month = layout('month'), year = layout('year');
  for (const [frame, expectedStart, balances] of [
    [month, '2026-10-20', [2200, 1747]], [year, '2025-11-19', [1500, 2500, 2200, 1747]],
  ]) {
    const { plot, lines } = frame;
    const axis = lines[plot.top + plot.height];
    assert.ok(axis.includes(expectedStart) && axis.endsWith('2026-11-19'));
    assert.deepEqual(plot.samples.map(s => s.point.equity), balances);
    assert.ok(plot.samples[0].column > 0);
    assert.ok(plot.cells.every(row => !row[0] && !row.at(-1)));
  }
  assert.match(month.lines.join('\n'), /First reading in this period\s+2026-11-01/);
  assert.ok(year.plot.samples.at(-2).column > month.plot.samples[0].column);
  assert.ok(year.plot.samples.at(-1).column > month.plot.samples.at(-1).column);
  assert.equal(year.plot.samples[1].row, 0);
  assert.equal(month.plot.samples[0].row, 0);
});

test('daily P&L uses Eastern dates, removes funding, and includes trading gains', () => {
  const row = (date, time, equity, key, activity) => ({ date, recorded_at: time, currency: 'CAD', equity, composition_key: key, activity });
  const prior = row('2026-11-18', '2026-11-19T02:00:00Z', 1000, 'opening');
  const deposit = row('2026-11-19', '2026-11-19T15:00:00Z', 2010, 'funded', 'Deposit CAD\u00a01,000.00');
  const trade = row('2026-11-19', '2026-11-19T16:00:00Z', 2030, 'traded', 'Buy 1 ABC at 10 per share');
  const latest = row('2026-11-19', '2026-11-20T02:00:00Z', 1980, 'latest', 'Withdraw CAD\u00a050.00');
  const history = [prior, deposit, trade, latest];
  const pnl = todaysPnl(latest, history).replaceAll('\u00a0', ' ');
  assert.match(pnl, /\+CAD 30\.00 \(\+3\.00%\) since 2026-11-18 21:00:00 ET/);
  assert.match(todaysPnl(latest, history.slice(1)), /\+CAD\s20\.00.*since first reading today/);
  assert.match(todaysPnl(latest, [latest]), /awaits a second reading/);
  assert.match(todaysPnl({ ...latest, equity: null }, history), /awaits a complete valuation/);
  assert.match(todaysPnl({ ...latest, activity: 'Profile edited' }, history.slice(0, -1)), /unavailable/);
});

test('the live graph records a flat minute and then a price move, using dated intraday quotes', async () => {
  const control = new AbortController();
  let minute = 0;
  const frames = [];
  const at = () => new Date(Date.UTC(2026, 10, 19, 15, minute));
  const data = {
    resolveListing: async symbol => ({ symbol, currency: 'CAD' }),
    dailyHistory: async () => [{ close: 10, currency: 'CAD', date: '2026-11-18' }],
    latestQuote: async () => ({ price: minute === 2 ? 12 : 11, currency: 'CAD', source: 'Test quote', asOf: at().toISOString() }),
  };
  const profile = { cash: 10, currency: 'CAD' };
  await pollLive({
    load: signal => buildDashboard([{ symbol: 'SAMPLE.TO', shares: 2 }], profile, [], data, at(), signal),
    display(view) {
      account.recordSnapshot(view, null, true);
      // A second screen refreshing the same balance that minute shares the same point.
      account.recordSnapshot(view, null, true);
      const history = account.equityHistory(view);
      frames.push(liveFrame(view, history, 100).join('\n').replaceAll('\u00a0', ' '));
      if (++minute === 3) {
        assert.deepEqual(history.map(row => row.equity), [32, 32, 34]);
        control.abort();
      }
    },
    reportError: message => assert.fail(message),
  }, control.signal, 1);
  assert.match(frames[0], /Unchanged since your CAD 32.00 start/);
  assert.doesNotMatch(frames.join('\n'), /Latest CAD/);
  assert.match(frames[1], /Steady │/);
  assert.match(frames[1], /Steady │ +●●$/m);
  assert.match(frames[2], /TOTAL EQUITY\n  CAD 34.00/);
  assert.match(frames[2], /High CAD 34\.00 │[^\n]*●/);
  assert.match(frames[2], /Low CAD 32\.00 │/);
  assert.match(frames[2], /Up CAD 2.00 \(6.25%\) since your CAD 32.00 start/);
  assert.doesNotMatch(frames[2], /SAMPLE.TO/);
  const view = await buildDashboard([{ symbol: 'SAMPLE.TO', shares: 2 }], profile, [], data, at());
  const detailed = liveFrame(view, [], 100, { details: true, styled: true }).join('\n');
  assert.match(detailed, /\x1b\[1mTOTAL EQUITY/);
  assert.match(detailed, /SAMPLE.TO.*Test quote/);
  assert.doesNotMatch(detailed, /EQUITY TREND/);
});

test('hover shows the equity and time of the plotted sample, including estimates, and skips empty gaps', () => {
  const time = Date.parse('2026-11-19T15:00:00Z');
  const record = { date: '2026-11-19', recorded_at: new Date(time).toISOString(), cash: 10, currency: 'CAD', equity: 30, composition_key: 'same' };
  const view = { date: record.date, recordedAt: new Date(time + 600000).toISOString(), cash: 10, currency: 'CAD',
    compositionKey: 'same', equity: 24, positions: [{ shares: 1, quote: { currency: 'CAD', minutes: new Map([[time + 60000, 12]]) } }] };
  const frame = liveLayout(view, [record], 90, { inspectable: true, styled: true });
  const { plot } = frame;
  for (const [i, sample] of plot.samples.entries()) {
    assert.equal(pointAt(plot, plot.left + sample.column, plot.top + sample.row), i);
  }
  const hover = inspectedLines(frame, 1);
  assert.match(hover[0], /TOTAL EQUITY\s+CAD\s22\.00/);
  assert.notDeepEqual(hover.slice(1, 4), frame.lines.slice(1, 4));
  assert.match(hover[4], /Down CAD\s8\.00 \(26\.67%\)/);
  assert.match(hover[plot.top - 1], /Estimated at 2026-11-19 10:01:00 ET/);
  assert.doesNotMatch(hover[plot.top - 1], /CAD/);
  assert.ok(hover[plot.top + plot.samples[1].row].includes('◆'));
  assert.match(inspectedLines(frame, 0)[0], /TOTAL EQUITY\s+CAD\s30\.00/);
  const blankRow = plot.cells.findIndex(row => !row[plot.samples[1].column]);
  assert.notEqual(blankRow, -1);
  const nearby = pointAt(plot, plot.left + plot.samples[1].column, plot.top + blankRow);
  assert.equal(plot.targets[nearby].column, plot.samples[1].column);
  const gap = Math.floor((plot.samples[1].column + plot.samples[2].column) / 2);
  assert.equal(pointAt(plot, plot.left + gap, plot.top), -1);
  assert.equal(pointAt(plot, plot.left, plot.top - 1), -1);
  assert.equal(inspectedLines(frame, -1), frame.lines);
  const updated = liveLayout({ ...view, equity: 26 }, [record], 65, { inspectable: true, rows: 20 });
  assert.match(inspectedLines(updated, 0)[1], /CAD\s30\.00/);
  assert.match(inspectedLines(updated, -1)[1], /CAD\s26\.00/);
});

test('hover follows the equity line at each time column between readings', () => {
  const first = { date: '2026-11-18', recorded_at: '2026-11-19T03:00:00Z', currency: 'CAD', cash: 10, equity: 100 };
  const view = { date: '2026-11-19', recordedAt: '2026-11-19T07:00:00Z', currency: 'CAD', cash: 10, equity: 140, positions: [] };
  const frame = liveLayout(view, [first], 100, { rows: 33, range: trendRanges.at(-1), inspectable: true });
  const { plot } = frame;
  const width = plot.cells[0].length;
  let previousTime = -Infinity;
  for (let x = 0; x < width; x++) {
    const sample = plot.targets[pointAt(plot, plot.left + x, plot.top)];
    assert.equal(sample.column, x);
    assert.ok(plot.cells[sample.row][x]);
    assert.ok(sample.point.time > previousTime);
    previousTime = sample.point.time;
  }
  const middle = plot.left + Math.floor(width / 2);
  const index = pointAt(plot, middle, plot.top + plot.height - 1);
  const sample = plot.targets[index];
  assert.equal(sample.point.time, Date.parse('2026-11-19T05:00:00Z'));
  assert.equal(sample.point.equity, 120);
  assert.equal(plot.samples[sample.leftIndex].point.equity, 100);
  assert.equal(plot.samples[sample.rightIndex].point.equity, 140);
  const lines = inspectedLines(frame, index);
  assert.match(lines[1], /CAD\s120\.00/);
  assert.match(lines[2], /Up CAD\s20\.00 \(20\.00%\)/);
  assert.match(lines[plot.top - 1], /Interpolated at 2026-11-19 00:00:00 ET/);
  assert.equal(lines[plot.top + sample.row][middle], '◆');
});

test('steep moves within one time column have distinct hover values down the line', () => {
  const first = { date: '2026-11-19', recorded_at: '2026-11-19T18:00:00Z', currency: 'CAD', cash: 1, equity: 140 };
  const view = { ...first, recorded_at: '2026-11-19T18:02:00Z', equity: 100, positions: [] };
  const { plot } = liveLayout(view, [first], 100, { range: trendRanges.find(r => r.key === 'year'), inspectable: true });
  const x = plot.left + plot.samples[0].column;
  assert.equal(pointAt(plot, x - 1, plot.top), -1);
  assert.equal(pointAt(plot, x, plot.top), 0);
  assert.equal(pointAt(plot, x, plot.top + plot.height - 1), 1);
  let previous = plot.samples[0].point;
  for (let y = 1; y < plot.height - 1; y++) {
    const { point, row } = plot.targets[pointAt(plot, x, plot.top + y)];
    assert.equal(row, y);
    assert.equal(point.interpolated, true);
    assert.ok(point.time > previous.time && point.time < plot.samples[1].point.time);
    assert.ok(point.equity < previous.equity && point.equity > view.equity);
    previous = point;
  }
});

test('fragmented mouse reports and keyboard input can share the live prompt', async () => {
  const input = new TerminalInput({});
  const mouse = [], keys = [];
  input.on('pointer', (x, y) => mouse.push([x, y]));
  input.on('data', chunk => keys.push(chunk));
  const finished = new Promise(resolve => input.once('end', resolve));
  input.write('dé\x1b[');
  input.write('<35;20;');
  input.write('8Mta\x1b[<0;20;8m\x1b');
  input.end('[Dil\x1b[MC*+s\r');
  await finished;
  assert.deepEqual(mouse, [[19, 7], [9, 10]]);
  assert.equal(Buffer.concat(keys).toString(), 'déta\x1b[Dils\r');
});

test('live checks retry without overlap and leaving discards the in-flight result', async () => {
  const control = new AbortController();
  let calls = 0;
  const errors = [], displayed = [];
  await pollLive({
    async load() {
      if (++calls === 1) throw new Error('temporarily offline');
      if (calls === 2) return 'priced';
      control.abort();
      await delay(1);
      return 'late result';
    },
    display: view => displayed.push(view),
    reportError: reason => errors.push(reason),
  }, control.signal, 1);
  assert.deepEqual(errors, ['temporarily offline']);
  assert.deepEqual(displayed, ['priced']);
  assert.equal(calls, 3);
});
