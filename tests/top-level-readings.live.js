'use strict';

// Optional Coinbase acceptance: node tests/top-level-readings.live.js
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const E = require('../analyze-wave-tree');
const { getCandles } = require('../candle-cache');
const { fetchCoinbasePage } = require('../coinbase-candle-transport');

async function main() {
  const end = new Date('2026-10-03T00:00:00Z');
  const receipts = [];
  const directory = path.resolve(__dirname, '../.cache/acceptance/top-level-readings');
  await fs.mkdir(directory, { recursive: true });
  for (const product of ['BTC-USD', 'ETH-USD']) {
    // Make a real request even when historical pages are already cached.
    const probe = await fetchCoinbasePage(product, 86400, new Date('2026-10-01T00:00:00Z'), end);
    assert.ok(probe.length > 0, 'live Coinbase request returned no data');
    const daily = await getCandles(product, 86400, 'all', end);
    assert.deepEqual(daily.fetchErrors, []);
    const high = daily.reduce((a, b) => b.high > a.high ? b : a);
    const low = daily.filter(c => c.timestamp > high.timestamp).reduce((a, b) => b.low < a.low ? b : a);
    const structure = { points: [{ price: high.high, timestamp: high.timestamp }, { price: low.low, timestamp: low.timestamp }] };
    let backgroundCalls = 0;
    const started = performance.now();
    const background = await E.loadHigherDegreeBackground({ product, source: 'coinbase', end, structure },
      (...args) => { backgroundCalls++; return getCandles(...args); });
    assert.equal(background.available, true, background.reason);
    const topStarted = performance.now();
    const topLevel = E.buildTopLevelReadings(background, structure);
    const topMs = performance.now() - topStarted;
    assert.equal(backgroundCalls, 1, 'top-level calculation must reuse loaded background');
    const complete = topLevel.families[0], fourth = topLevel.families[1];
    if (product === 'BTC-USD') {
      // 价格 0 起点的 1 浪涨幅按 +∞：完整推动读法（如 0→64899→15460→109358→74421→126296）不因 §3.16 被误排除。
      assert.ok(complete.legal > 0, 'BTC 完整驱动浪应有存活读法');
      assert.ok(!complete.pendingReasons.some(r => /百分比/.test(r)));
      assert.ok(fourth.legal > 0);
      assert.ok(fourth.p1Range && fourth.p2Range);
      assert.equal(fourth.windowRole.correction.wave, '3 浪');
    } else {
      assert.ok(topLevel.spikes.some(s => s.originalPrice === 0.1), 'ETH 2017 volume spike must be retained');
    }
    const md = E.renderTopLevelReadings(topLevel, 2);
    await fs.writeFile(path.join(directory, `${product}.json`), JSON.stringify(topLevel, null, 2));
    await fs.writeFile(path.join(directory, `${product}.md`), md);
    const receipt = { product, endpoint: end.toISOString(), liveProbeRows: probe.length,
      backgroundCalls, totalMs: performance.now() - started, topMs, dataOrigin: topLevel.dataOrigin,
      families: topLevel.families.map(({ key, legal, pending, excluded, excludedReasons, p1Range, p2Range, windowRole }) =>
        ({ key, legal, pending, excluded, excludedReasons, p1Range, p2Range, windowRole })), spikes: topLevel.spikes };
    receipts.push(receipt);
    console.log(JSON.stringify(receipt));
  }
  await fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipts, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
