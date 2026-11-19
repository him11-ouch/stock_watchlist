const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createInterface } = require('node:readline');

test('clearing the watchlist through the API survives a server restart', { timeout: 15000 }, async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'watchlist-api-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  async function start() {
    const child = spawn(process.execPath, [path.resolve(__dirname, '../server.cjs')], {
      env: { ...process.env, WATCHLIST_DB: path.join(dir, 'test.db'), WATCHLIST_HOST: '127.0.0.1', PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit');
    async function stop() {
      child.kill();
      await exited;
    }
    t.after(stop);
    let errors = '';
    child.stderr.on('data', data => { errors += data; });
    for await (const line of createInterface({ input: child.stdout })) {
      const match = line.match(/Server is running on http:\/\/localhost:(\d+)/);
      if (match) return { url: `http://127.0.0.1:${match[1]}/watchlist`, stop };
    }
    throw new Error(`Server failed to start. ${errors}`);
  }

  const first = await start();
  const initial = await (await fetch(first.url)).json();
  assert.deepEqual(initial.watchlist.map(row => row.symbol).sort(), ['AC.TO', 'CLS.TO', 'T.TO']);
  for (const { symbol } of initial.watchlist) {
    const response = await fetch(`${first.url}/${symbol}`, { method: 'DELETE' });
    assert.equal(response.status, 200);
  }
  await first.stop();
  const restarted = await start();
  assert.deepEqual(await (await fetch(restarted.url)).json(), { success: true, count: 0, watchlist: [] });
  await restarted.stop();
});
