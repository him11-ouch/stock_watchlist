const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { liveFrame, liveLayout, inspectedLines, pollLive } = require('../services/live.cjs');
const { pointAt } = require('../services/terminal-plot.cjs');
const { TerminalInput } = require('../services/terminal-input.cjs');
const { buildDashboard } = require('../services/dashboard.cjs');

process.env.WATCHLIST_DB = ':memory:';
const account = require('../services/account.cjs');

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
  assert.match(frames[1], /●[\u2801-\u28ff]+●/);
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
  assert.equal(pointAt(plot, plot.left + plot.samples[1].column, plot.top + blankRow), -1);
  assert.equal(pointAt(plot, plot.left, plot.top - 1), -1);
  assert.deepEqual(inspectedLines(frame, -1), frame.lines);
  const updated = liveLayout({ ...view, equity: 26 }, [record], 65, { inspectable: true, rows: 20 });
  assert.match(inspectedLines(updated, 0)[1], /CAD\s30\.00/);
  assert.match(inspectedLines(updated, -1)[1], /CAD\s26\.00/);
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
