'use strict';

// track-live-swing-extreme：进行中结构的摆动极值纳入"末枢轴之后又创的新极值"（provisional），
// 越过时回撤腿归入摆动段内部、currentPullback 为 null，轴②/③/简报按新极值重算；未越过时一切不变。

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../analyze-wave-tree.js');

const FIX = require('./fixtures/btcusdt-1h-live-extreme-20261104.json');
const ALL = FIX.candles.map((c, i) => ({ ...c, index: i }));
const CONFIRMED_EXT = 78164;
const EXT_INDEX = E.detectPivots(ALL, 1, {}).at(-1).index; // 已确认摆动极值 78164 所在 K 线

function run(candles) {
  const fine = E.anchorBoundaryExtremes(candles, E.detectPivots(candles, 1, {}));
  const tree = E.buildCountTree(fine, candles, { maxDepth: 5, beamK: 4, pricePrecision: 2 });
  return { fine, tree };
}
function meta(candles) {
  return { product: 'BTC-USD', timeframe: '1h', startUtc: '2026-10-30T16:00:00Z', endUtc: '2026-11-04T09:39:50Z',
    generatedAtUtc: '2026-11-04T09:40:00Z', sampleCount: candles.length, pricePrecision: 2, lastClose: candles.at(-1).close,
    rangeHigh: Math.max(...candles.map((c) => c.high)), rangeLow: Math.min(...candles.map((c) => c.low)) };
}

let live;
const liveRun = () => (live ||= run(ALL));

test('夹具：末确认枢轴之后的最高价越过已确认摆动极值 78164', () => {
  const raw = E.detectPivots(ALL, 1, {});
  const lastConfirmed = raw.at(-1);
  assert.equal(lastConfirmed.price, CONFIRMED_EXT);
  const after = ALL.filter((c) => c.index > lastConfirmed.index);
  assert.ok(Math.max(...after.map((c) => c.high)) > CONFIRMED_EXT);
  // anchorBoundaryExtremes 只在右端补反向极值，新高本身不会成为枢轴（这是要在进行中层补上的原因）
  const fine = E.anchorBoundaryExtremes(ALL, raw);
  assert.equal(fine.at(-1).type, 'L');
  assert.equal(fine.at(-1).price, 77748.09);
});

test('越过：摆动极值取暂定新高、无回撤腿、失效位不动', () => {
  const { tree } = liveRun();
  const ips = tree.inProgressStruct;
  const hi = Math.max(...ALL.filter((c) => c.index > EXT_INDEX).map((c) => c.high));
  assert.equal(ips.swingExtreme.price, hi);
  assert.equal(ips.swingExtreme.price, 78556.01);
  assert.equal(ips.swingExtreme.provisional, true);
  assert.equal(ips.pullback, null);
  assert.equal(ips.invalidation, 75736.38);
  const json = E.serializeInProgress(ips);
  assert.equal(json.swingExtreme.provisional, true);
  assert.equal(json.currentPullback, null);
});

test('越过：回撤位、轴②投影、反弹锚点都按新极值计算', () => {
  const { tree } = liveRun();
  const ext = 78556.01;
  const amp = ext - 75736.38;
  const ips = tree.inProgressStruct;
  assert.deepEqual(ips.retraceTargets.map((t) => t.mult), [0.382, 0.5, 0.618]);
  ips.retraceTargets.forEach((t) => assert.ok(Math.abs(t.price - (ext - amp * t.mult)) < 1e-6));
  const cws = tree.currentWaveStructures;
  assert.equal(cws.extending, true);
  assert.equal(cws.ext, ext);
  const bx = cws.structures.find((s) => s.id === 'connector-bx');
  assert.equal(bx.legs[0].status, '⏳延伸中');
  assert.equal(bx.legs[1].status, '未走');
  assert.ok(Math.abs(bx.projection[0].price - (ext - amp * 0.382)) < 1e-6);
  const r2 = cws.structures.find((s) => s.id === 'reverse-impulse-2');
  assert.equal(r2.tier1, 0);
  assert.match(r2.currentWave, /^浪①（延伸中）/);
  assert.equal(tree.assessment.bounceHyp.anchor, ext);
});

test('越过：md 中简报与轴②同口径，不再出现过时的回撤腿', () => {
  const { tree } = liveRun();
  const md = E.renderMarkdownReport(meta(ALL), tree);
  for (const s of ['b腿（进行中）', '浪②（进行中）', '回调或已结束', '78164 → 77748.09，⏳ 进行中']) {
    assert.ok(!md.includes(s), `不应含「${s}」`);
  }
  assert.match(md, /a 腿（延伸中）/);
  assert.match(md, /2\. 当前浪型：[^\n]*仍在延伸中/);
  assert.match(md, /3\. 核心生死线（失效点）：75736\.38/);
  assert.match(md, /\| 77478\.91 \| [^|]*回撤 0\.382/);
});

test('未越过：appendLiveExtreme 原样返回，进行中结构与改动前一致', () => {
  // 截到新高越过 78164 之前（末根最高价仍不超过已确认极值）
  const cut = ALL.findIndex((c) => c.index > EXT_INDEX && c.high > CONFIRMED_EXT);
  assert.ok(cut > EXT_INDEX + 1);
  const candles = ALL.slice(0, cut);
  const { fine, tree } = run(candles);
  const spanLast = fine.find((p) => p.price === 75736.38);
  assert.equal(E.appendLiveExtreme(fine, spanLast, candles), fine);
  const ips = tree.inProgressStruct;
  assert.equal(ips.swingExtreme.price, CONFIRMED_EXT);
  assert.ok(!ips.swingExtreme.live);
  assert.ok(ips.pullback);
  assert.equal(ips.retraceTargets, undefined);
  assert.ok(!tree.currentWaveStructures.extending);
});

test('未越过：golden 1d 夹具的枢轴序列不被改写', () => {
  const candles = require('./fixtures/btc-usd-1d-golden.json').map((c, i) => ({ ...c, index: i }));
  const { fine, tree } = run(candles);
  const spanLast = tree.inProgressStruct.rallyStart;
  assert.equal(E.appendLiveExtreme(fine, spanLast, candles), fine);
});
