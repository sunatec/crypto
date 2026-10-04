'use strict';

// Optional live acceptance: node tests/candle-cache.live.js
// Uses real Coinbase pages and writes evidence under ignored .cache/acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

async function main() {
  const root = path.resolve(__dirname, '..');
  const directory = path.join(root, '.cache', 'acceptance');
  await fs.mkdir(directory, { recursive: true });
  const hook = path.join(directory, 'hook.cjs');
  const runCache = path.join(directory, `cache-${randomUUID()}`);
  await fs.writeFile(hook, `
const fs = require('node:fs');
const NativeDate = Date;
// Freeze only the analysis clock; real network transport and market data stay live.
global.Date = class extends NativeDate {
  constructor(...args) { super(...(args.length ? args : ['2026-10-04T00:00:00Z'])); }
};
const cache = require('../../candle-cache');
const transport = require('../../coinbase-candle-transport');
const trace = [];
const realPage = transport.fetchCoinbasePage;
// getCandles already captured its default transport; inject an instrumented real one.
const realGet = cache.getCandles;
cache.getCandles = (...args) => realGet(...args.slice(0, 4), {
  ...args[4], cacheDir: process.env.CANDLE_ACCEPTANCE_CACHE,
  transport: async (...pageArgs) => {
    const event = { product: pageArgs[0], granularity: pageArgs[1], start: pageArgs[2].toISOString(), end: pageArgs[3].toISOString() };
    trace.push(event);
    try { const rows = await realPage(...pageArgs); event.rows = rows.length; return rows; }
    catch (e) { event.error = e.message; throw e; }
  }
});
process.on('exit', () => fs.writeFileSync(process.env.CANDLE_ACCEPTANCE_TRACE, JSON.stringify(trace, null, 2)));
`, 'utf8');

  for (let run = 1; run <= 2; run += 1) {
    const args = ['--require', hook, path.join(root, 'analyze-wave-tree.js'),
      '--product', 'BTC-USD', '--tf', '1d', '--start', '2026-02-01T00:00:00Z', '--end', '2026-03-01T00:00:00Z',
      '--out', path.join(directory, `run-${run}.json`), '--report', path.join(directory, `run-${run}.md`)];
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: root, stdio: 'inherit', windowsHide: true,
        env: { ...process.env, CANDLE_ACCEPTANCE_CACHE: runCache, CANDLE_ACCEPTANCE_TRACE: path.join(directory, `trace-${run}.json`) },
      });
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve() : reject(new Error(`CLI run ${run} exited ${code}`)));
    });
  }
  const first = JSON.parse(await fs.readFile(path.join(directory, 'trace-1.json'), 'utf8'));
  const second = JSON.parse(await fs.readFile(path.join(directory, 'trace-2.json'), 'utf8'));
  assert.ok(first.some(page => page.granularity === 86400), 'use a fresh acceptance cache for the first live run');
  assert.ok(first.some(page => page.granularity === 3600), 'first run must exercise hourly verification');
  assert.ok(first.every(page => !page.error), 'all first-run live pages must succeed');
  assert.deepEqual(second, [], 'second run must issue zero candle page requests');
  for (const extension of ['json', 'md']) {
    assert.deepEqual(await fs.readFile(path.join(directory, `run-1.${extension}`)), await fs.readFile(path.join(directory, `run-2.${extension}`)));
  }
  const receipt = { firstRunPages: first.length, secondRunPages: second.length, jsonIdentical: true, markdownIdentical: true,
    clock: '2026-10-04T00:00:00Z', start: '2026-02-01T00:00:00Z', end: '2026-03-01T00:00:00Z' };
  await fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
