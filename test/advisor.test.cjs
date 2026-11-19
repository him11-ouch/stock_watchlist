const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewStock, planBudget, askLocal } = require('../services/advisor.cjs');

test('review uses dated closes, personal limits and attributed coverage', () => {
  const today = new Date().toISOString().slice(0, 10);
  const position = { symbol: 'TEST', shares: 2, close: 25, priceFloor: 30, quoteDate: today,
    currency: 'USD', weightPct: 24, maxWeightPct: 20, horizon: '5 years',
    headlines: [{ title: 'Quarterly update', publisher: 'Publisher', date: today, url: 'https://example.org/report' }] };
  const report = reviewStock(position).join('\n');
  assert.match(report, /Review trimming/);
  assert.match(report, /downside review level/);
  assert.match(report, /5 years/);
  assert.match(report, /Publisher\s+\|\s+Quarterly update/);
  assert.doesNotMatch(reviewStock({ ...position, quoteDate: '2000-01-01' }).join('\n'), /downside review level/);
});

test('budget bounds use recorded cash and equity including existing stock exposure', () => {
  const inputs = { amount: 300, cash: 250, equity: 1000, maxWeightPct: 20,
    positions: [{ symbol: 'A', value: 180 }, { symbol: 'B', value: 570 }],
    candidates: ['A','B','C'].map(symbol => ({ symbol, rank: 3 })) };
  const lines = planBudget(inputs).join('\n').replaceAll('\u00a0', ' ');
  assert.match(lines, /B already meets/);
  assert.match(lines, /A\s+\|\s+CAD 20.00/);
  assert.match(lines, /C\s+\|\s+CAD 125.00/);
  assert.match(lines, /left in cash: CAD 105.00/);
  assert.match(planBudget({ ...inputs, equity: null })[0], /Sizing unavailable/);
  assert.match(planBudget({ ...inputs, candidates: [{ symbol: 'X', rank: 1 }] }).join(' '), /Retain the budget in cash/);
});

test('AI sends evidence only after confirming downloaded local model weights', async t => {
  t.mock.method(global, 'fetch', async (url, options) => {
    assert.equal(new URL(url).hostname, '127.0.0.1');
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    if (url.endsWith('/show')) {
      assert.equal(body.messages, undefined);
      return Response.json({ model_info: { architecture: 'qwen3' } });
    }
    assert.match(body.messages[0].content, /untrusted data/);
    assert.match(body.messages[1].content, /latest close/);
    assert.equal(body.format.required[0], 'answer');
    assert.match(body.messages[1].content, /todayUTC/);
    return Response.json({ done: true, done_reason: 'stop', message: { content: '{"answer":"Read the latest release."}' } });
  });
  assert.match(await askLocal('How did the stock do?', ['latest close']), /Read the latest release/);
  global.fetch.mock.mockImplementation(async url => {
    assert.ok(url.endsWith('/show'));
    return Response.json({ remote_host: 'https://example.org', model_info: { architecture: 'example' } });
  });
  assert.match(await askLocal('How did the stock do?', ['latest close']), /downloaded local model/);
});

test('AI withholds unfinished, malformed and reasoning-tagged replies', async t => {
  const valid = '{"answer":"Read the latest release."}';
  let next;
  t.mock.method(global, 'fetch', async url => Response.json(url.endsWith('/show')
    ? { model_info: { architecture: 'qwen3' } } : next));
  for (const [reason, content] of [['length', valid], ['stop', '{"answer":"Cut off'], ['stop', 'Notes</think>' + valid],
    ['stop', '{"answer":"<think>Notes</think>Answer."}']]) {
    next = { done: true, done_reason: reason, message: { content } };
    assert.match(await askLocal('What happened?', []), /^Local AI did not return a complete final answer/);
  }
});
