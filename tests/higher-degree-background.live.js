'use strict';

// Optional real Coinbase acceptance: node tests/higher-degree-background.live.js
// Isolated fresh cache; the fixed closed endpoint permits zero requests on run two.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

async function main() {
  const root = path.resolve(__dirname, '..');
  const directory = path.join(root, '.cache', 'acceptance', 'higher-degree-background');
  await fs.mkdir(directory, { recursive: true });
  const cacheDir = path.join(directory, `cache-${randomUUID()}`);
  const hook = path.join(directory, 'hook.cjs');
  await fs.writeFile(hook, `
const fs = require('node:fs');
const NativeDate = Date;
global.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : ['2026-10-04T00:10:00Z'])); } };
const cache = require(${JSON.stringify(path.join(root, 'candle-cache.js'))});
const {fetchCoinbasePage} = require(${JSON.stringify(path.join(root, 'coinbase-candle-transport.js'))});
const realGet = cache.getCandles;
const trace = [];
cache.getCandles = (...args) => realGet(...args.slice(0,4), {...args[4], cacheDir:process.env.BACKGROUND_CACHE,
  transport:async (...pageArgs) => {
    const event = {allHistory:args[2]==='all', granularity:pageArgs[1], start:pageArgs[2].toISOString(), end:pageArgs[3].toISOString()};
    trace.push(event);
    try { const rows=await fetchCoinbasePage(...pageArgs); event.rows=rows.length; return rows; }
    catch(e) { event.error=e.message; throw e; }
  }
});
process.on('exit', () => fs.writeFileSync(process.env.BACKGROUND_TRACE,JSON.stringify(trace,null,2)));
`);
  for (let run = 1; run <= 2; run++) {
    console.log(`BTC-USD live background run ${run}`);
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--require', hook, path.join(root, 'analyze-wave-tree.js'),
        '--product', 'BTC-USD', '--tf', '1d', '--start', '2025-10-05T00:00:00Z', '--end', '2026-10-03T00:00:00Z',
        '--verify-tf', 'off', '--background', 'on', '--out', path.join(directory, `run-${run}.json`), '--report', path.join(directory, `run-${run}.md`)],
      { cwd: root, stdio: 'inherit', windowsHide: true, env: { ...process.env, BACKGROUND_CACHE: cacheDir, BACKGROUND_TRACE: path.join(directory, `trace-${run}.json`) } });
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve() : reject(new Error(`CLI run ${run} exited ${code}`)));
    });
    const output = JSON.parse(await fs.readFile(path.join(directory, `run-${run}.json`), 'utf8'));
    assert.equal(output.background.available, true, output.background.reason);
  }
  const first = JSON.parse(await fs.readFile(path.join(directory, 'trace-1.json'), 'utf8'));
  const second = JSON.parse(await fs.readFile(path.join(directory, 'trace-2.json'), 'utf8'));
  assert.ok(first.some(p => p.allHistory), 'first run must discover all history');
  assert.ok(first.every(p => !p.error), 'live pages must succeed');
  assert.deepEqual(second, [], 'second run must issue zero candle page requests');
  for (const ext of ['json', 'md']) assert.deepEqual(await fs.readFile(path.join(directory, `run-1.${ext}`)), await fs.readFile(path.join(directory, `run-2.${ext}`)));
  const { background, tree } = JSON.parse(await fs.readFile(path.join(directory, 'run-1.json'), 'utf8'));
  const raw = JSON.parse(await fs.readFile(path.join(cacheDir, 'candles', 'coinbase', 'BTC-USD', '86400.json'), 'utf8'));
  assert.equal(background.listing.timestamp, raw.listingTs);
  assert.equal(background.listing.price, raw.bars.find(r => r[0] === raw.listingTs)[3]);
  const S = tree.points[0].price, end = tree.points.at(-1).price;
  const review = background.ladder.map(l => {
    const amplitude = Math.abs(S - l.start.price), window = Math.abs(S - end);
    assert.equal(l.amplitude.absolute, Number(amplitude.toFixed(2)));
    assert.ok(Math.abs(l.retrace.absolute - window / amplitude) < 1e-12);
    const internal = l.maxInternalRetrace;
    if (internal.absolute) assert.ok(Math.abs(internal.absolute.depth - Math.abs(internal.absolute.from - internal.absolute.to)) < 1e-8);
    if (internal.percentage) assert.ok(Math.abs(internal.percentage.ratio - Math.abs(internal.percentage.from - internal.percentage.to) / internal.percentage.from) < 1e-12);
    return { start: l.start, amplitude: l.amplitude, retrace: l.retrace, internal, section33: l.section33 };
  });
  const receipt = { firstRunPages: first.length, allHistoryPages: first.filter(p => p.allHistory).length, secondRunPages: second.length,
    jsonIdentical: true, markdownIdentical: true, verification: 'off (background acceptance)', listing: background.listing,
    extremes: background.extremes, spikes: background.spikes, window: { start: S, end }, ladderReview: review };
  await fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
}

main().catch(e => { console.error(e); process.exitCode = 1; });
