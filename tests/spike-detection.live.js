'use strict';

// Optional live acceptance: node tests/spike-detection.live.js
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { getCandles } = require('../candle-cache');
const { fetchCoinbasePage } = require('../coinbase-candle-transport');
const S = require('../spike-detection');
const E = require('../analyze-wave-tree');

async function main() {
  const root = path.resolve(__dirname, '..');
  const directory = path.join(root, '.cache', 'acceptance', 'spike-detection');
  const cacheDir = path.join(directory, 'cache');
  await fs.mkdir(directory, { recursive: true });
  const trace = [];
  const fetcher = async (...args) => getCandles(...args.slice(0, 4), { ...args[4], cacheDir,
    transport: async (...pageArgs) => {
      trace.push({ product: pageArgs[0], granularity: pageArgs[1], start: pageArgs[2].toISOString(), end: pageArgs[3].toISOString() });
      return fetchCoinbasePage(...pageArgs);
    } });
  const products = [];
  for (const product of ['BTC-USD', 'ETH-USD']) {
    console.log(`Live all-history spike classification: ${product}`);
    const daily = await fetcher(product, 86400, 'all', '2026-10-03T00:00:00Z');
    assert.deepEqual(daily.fetchErrors, []);
    const spikes = await S.classifySpikes(S.detectSpikeCandidates(daily, { timeframe: '1d' }), { candles: daily, product, fetchFiner: fetcher });
    const high = daily.reduce((a, b) => b.high > a.high ? b : a);
    const structure = { points: [{ price: high.high, timestamp: high.timestamp }, { price: daily.at(-1).close, timestamp: daily.at(-1).timestamp }] };
    const background = E.buildHigherDegreeBackground({ daily, structure, listingTs: daily.listingTs, spikes });
    assert.equal(background.available, true);
    const btcNeedle = background.spikes.find(s => s.originalPrice === 0.06 && s.type === 'L');
    const ethThin = background.spikes.find(s => s.originalPrice === 74.98 && s.type === 'H');
    const ethVolume = background.spikes.find(s => s.originalPrice === 0.10 && s.type === 'L');
    if (product === 'BTC-USD') {
      assert.equal(btcNeedle.classification, 'thin');
      assert.equal(btcNeedle.clipped, true);
      assert.equal(btcNeedle.usedTimeframe, '1h');
      assert.ok(Math.abs(btcNeedle.volumeRatio - 3.06) < 0.1);
      assert.notEqual(background.extremes.low.price, 0.06);
    } else {
      assert.equal(ethThin.classification, 'thin');
      assert.equal(ethThin.clipped, true);
      assert.ok(Math.abs(ethThin.volumeRatio - 1.27) < 0.1);
      assert.equal(ethVolume.classification, 'volume');
      assert.equal(ethVolume.clipped, false);
      assert.equal(ethVolume.usedTimeframe, '1h');
      assert.ok(Math.abs(ethVolume.volumeRatio - 24.6) < 0.2);
      assert.equal(background.extremes.low.price, 0.10);
    }
    const record = { product, bars: daily.length, extremes: background.extremes, spikes: background.spikes };
    products.push(record);
    await fs.writeFile(path.join(directory, `${product}-background.json`), JSON.stringify(background, null, 2));
    await fs.writeFile(path.join(directory, `${product}-background.md`), E.renderHigherDegreeBackground(background, 2));
    console.log(JSON.stringify(record));
  }
  const hook = path.join(directory, 'hook.cjs');
  await fs.writeFile(hook, `
const cache=require(${JSON.stringify(path.join(root, 'candle-cache.js'))}); const real=cache.getCandles;
cache.getCandles=(...args)=>real(...args.slice(0,4),{...args[4],cacheDir:${JSON.stringify(cacheDir)}});
`);
  const runs = [];
  for (const ignore of [false, true]) {
    console.log(`Live BTC 2017 window, ignore thin spikes: ${ignore}`);
    const out = path.join(directory, `btc-${ignore ? 'clipped' : 'default'}.json`);
    const report = path.join(directory, `btc-${ignore ? 'clipped' : 'default'}.md`);
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--require', hook, path.join(root, 'analyze-wave-tree.js'), '--product', 'BTC-USD', '--tf', '1d',
        '--start', '2017-04-01T00:00:00Z', '--end', '2017-05-01T00:00:00Z', '--background', 'off',
        '--out', out, '--report', report, ...(ignore ? ['--ignore-thin-spikes'] : [])], { cwd: root, windowsHide: true, stdio: 'inherit' });
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve() : reject(new Error(`CLI exited ${code}`)));
    });
    const json = JSON.parse(await fs.readFile(out, 'utf8'));
    const md = await fs.readFile(report, 'utf8');
    const s = json.spikes.find(s => s.originalPrice === 0.06);
    assert.equal(s.classification, 'thin');
    assert.equal(s.clipped, ignore);
    assert.equal(s.usedTimeframe, '1h');
    if (ignore) {
      assert.ok(json.tree.points.every(p => p.price !== 0.06));
      assert.ok(!md.includes('此数法依赖该扎针'));
      assert.match(md, /已截取为/);
    } else {
      assert.ok(json.tree.points.some(p => p.price === 0.06));
      assert.match(md, /此数法依赖该扎针/);
      assert.match(md, /--ignore-thin-spikes 对照/);
    }
    runs.push({ ignoreThinSpikes: ignore, primary: json.tree.patternId, points: json.tree.points,
      spikes: json.spikes, verification: json.tree.verificationStatus, hourlyVerification: json.tree.fitScore });
  }
  const receipt = { products, runs, pageRequests: trace.length };
  await fs.writeFile(path.join(directory, 'trace.json'), JSON.stringify(trace, null, 2));
  await fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(`Live acceptance passed; receipt: ${path.join(directory, 'receipt.json')}`);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
