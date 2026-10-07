'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../analyze-wave-tree');
const T = require('../top-level-readings');
const WEEK = 604800, START = Date.parse('2020-01-06T00:00:00Z') / 1000;

function fixture(prices = [10, 100, 50, 300, 150, 400, 250], sIndex = prices.length - 2) {
  const daily = prices.map((price, i) => ({ timestamp: START + i * WEEK, open: price, high: price, low: price, close: price, volume: 1 }));
  const structure = { points: [{ price: prices[sIndex], timestamp: daily[sIndex].timestamp },
    { price: prices.at(-1), timestamp: daily.at(-1).timestamp }] };
  const background = E.buildHigherDegreeBackground({ daily, structure, listingTs: START, spikes: [] });
  return { daily, structure, background };
}
const fourth = result => result.families.find(f => f.key === 'fourth-wave');

test('虚拟 0 在首周之前，复用截取后日线且不改变背景 JSON 或输入', () => {
  const f = fixture(), before = JSON.stringify(f.background), daily = JSON.stringify(f.daily);
  const result = E.buildTopLevelReadings(f.background, f.structure);
  assert.equal(result.available, true);
  assert.equal(result.dataOrigin.virtualStart.price, 0);
  assert.equal(result.dataOrigin.virtualStart.timestamp, START - WEEK);
  assert.equal(result.weeklyCount, f.daily.length + 1);
  assert.match(result.dataOrigin.note, /并非品种诞生/);
  assert.equal(JSON.stringify(f.background), before);
  assert.equal(JSON.stringify(f.daily), daily);
  assert.equal(fourth(result).representative.points[0].price, 0);
});

test('背景 off、取数失败、缺失背景及窗口均不可用', () => {
  for (const reason of ['--background off', '网络失败']) assert.deepEqual(E.buildTopLevelReadings({ available: false, reason }), { available: false, reason });
  assert.equal(E.buildTopLevelReadings(null).available, false);
  assert.equal(E.buildTopLevelReadings(fixture().background, null).available, false);
});

test('P1/P2 互相约束；重置低点令早期高点无效，2 浪必须回撤 20%', () => {
  const f = fixture([10, 100, 50, 90, 10, 200, 150]);
  const family = fourth(E.buildTopLevelReadings(f.background, f.structure));
  assert.equal(family.p1Range.min.price, 100);
  assert.equal(family.p2Range.min.price, 10);
  assert.ok(Object.keys(family.excludedReasons).some(r => r.includes('P1 不是')));
  const shallow = fixture([10, 100, 81, 200, 150]);
  assert.ok(Object.keys(fourth(E.buildTopLevelReadings(shallow.background, shallow.structure)).excludedReasons).some(r => r.includes('20%')));
});

test('各硬规则边界：20% 与 2 倍时间可通过；触及 P1、3 浪相等、跌破 0 均失败', () => {
  const p1 = { price: 100 }, p2 = { price: 80, timestamp: 10 }, ath = { price: 200, timestamp: 20 };
  assert.equal(T.fourthWaveFailure(p1, p2, ath, 101, 40), null);
  assert.match(T.fourthWaveFailure(p1, { ...p2, price: 80.01 }, ath, 101, 40), /20%/);
  assert.match(T.fourthWaveFailure(p1, { ...p2, price: -1 }, ath, 101, 40), /跌破价格 0/);
  assert.match(T.fourthWaveFailure(p1, p2, { ...ath, price: 100 }, 101, 40), /3 浪未超过/);
  assert.match(T.fourthWaveFailure(p1, p2, ath, 100, 40), /进入 1 浪/);
  assert.match(T.fourthWaveFailure(p1, p2, ath, 101, 41), /2 倍/);
});

test('子浪 invalid 排除，pending 保留；3 浪非最短始终待定', () => {
  const f = fixture();
  let calls = 0;
  const engine = { ...E, evaluateLegRole: () => { calls++; return { violates: false, evidence: { status: 'invalid', reason: '角色失败' } }; } };
  const invalid = fourth(T.buildTopLevelReadings(engine, f.background, f.structure));
  assert.equal(invalid.legal, 0);
  assert.ok(calls > 0);
  assert.ok(Object.keys(invalid.excludedReasons).some(r => r.includes('子浪角色违规')));
  const pending = fourth(E.buildTopLevelReadings(f.background, f.structure));
  assert.equal(pending.legal, 1);
  assert.equal(pending.pending, 1);
  assert.ok(pending.pendingReasons.some(r => r.includes('须待 5 浪')));
});

test('完整类使用既有驱动引擎：统计通过、待定、首条违规，排除调整角色', () => {
  const f = fixture();
  const points = [0, 100, 50, 300, 150, 400].map((price, i) => ({ price, timestamp: START + i * WEEK, index: i, type: i % 2 ? 'H' : 'L' }));
  let seenRoles;
  const engine = { ...E, decompose: (fine, bars, roles, depth, opts) => {
    seenRoles = roles;
    assert.equal(opts.maxDepth, 4); assert.equal(opts.beamK, 6);
    assert.equal(bars[0].open, 0); assert.equal(fine[0].price, 0);
    const candidate = score => ({ patternId: 'impulse-strict', points, score });
    return { isLeaf: false, primary: candidate({ tier1: 0, verificationStatus: 'verified' }), alternates: [
      candidate({ tier1: 0, verificationStatus: 'pending' }),
      candidate({ tier1: 2, failed: [{ desc: '4 浪重叠' }, { desc: '其他失败' }] }),
    ] };
  } };
  const result = T.buildTopLevelReadings(engine, f.background, f.structure);
  assert.deepEqual(seenRoles, ['driving']);
  assert.equal(result.families[0].legal, 2); assert.equal(result.families[0].pending, 1);
  assert.equal(result.families[0].excluded, 1);
  assert.deepEqual(result.families[0].excludedReasons, { '4 浪重叠': 1 });
  assert.match(result.limitations, /调整浪不列入/);
  assert.match(result.families[0].parentMapping.impulse, /新一轮驱动/);
  assert.equal(result.families[0].windowRole.correction.from.price, 0);
});

test('真实引擎的完整驱动候选保留硬规则违规', () => {
  const f = fixture([10, 100, 50, 300, 40, 400, 250]);
  const complete = E.buildTopLevelReadings(f.background, f.structure).families[0];
  assert.equal(complete.legal, 0);
  assert.ok(complete.excluded > 0);
  assert.equal(Object.values(complete.excludedReasons).reduce((a, b) => a + b, 0), complete.excluded);
});

test('真实完整推动硬规则合规；价格 0 起点的百分比按 +∞ 判定，不因此待定', () => {
  const f = fixture();
  const complete = E.buildTopLevelReadings(f.background, f.structure).families[0];
  assert.ok(complete.legal > 0);
  assert.ok(!complete.pendingReasons.some(r => /百分比/.test(r)), '§3.16 在 +∞ 下可判定，不应列为待定原因');
});

// §3.16 + §3.12：自价格 0 起的 1 浪涨幅为 +∞，「3 浪不能同时小于 1、5 浪」化为「3 浪不得小于 5 浪」
const zeroImpulse = prices => E.scoreCandidate({ direction: 'up', points: prices.map((price, i) => ({ price, index: i * 3, timestamp: 1700000000 + i * 3 * WEEK, ...(i === 0 ? { virtual: true } : {}) })) }, E.buildImpulseStrictManual('up'));
const pctRule = s => ({ failed: s.failed.some(f => f.id === 'impulse.pattern.wave3-percent-not-shortest'), pending: s.pendingRules.some(r => r.id === 'impulse.pattern.wave3-percent-not-shortest') });

test('价格 0 起点：3 浪百分比不小于 5 浪即通过（BTC 型 607% / 69.7%）', () => {
  assert.deepEqual(pctRule(zeroImpulse([0, 64899, 15460, 109358, 74421, 126296])), { failed: false, pending: false });
});

test('价格 0 起点：3 浪百分比小于 5 浪即违规', () => {
  // 3 浪 50→300 为 500%，5 浪 250→2000 为 700%；3 浪按长度不是最短，只触发百分比规则
  assert.deepEqual(pctRule(zeroImpulse([0, 100, 50, 300, 250, 2000])), { failed: true, pending: false });
});

test('真实价格起点的百分比规则行为不变', () => {
  const real = E.scoreCandidate({ direction: 'up', points: [100, 150, 120, 200, 170, 250].map((price, i) => ({ price, index: i * 3 })) }, E.buildImpulseStrictManual('up'));
  assert.deepEqual(pctRule(real), { failed: false, pending: false });
});

test('含义映射、P1 最高代表、累计失效分档，S 早于 ATH 时如实描述跨浪', () => {
  const f = fixture([10, 100, 50, 200, 150, 400, 300]);
  const result = E.buildTopLevelReadings(f.background, f.structure), family = fourth(result);
  assert.equal(family.representative.points[1].price, 200);
  assert.deepEqual(family.invalidationTiers.map(t => [t.price, t.eliminated, t.wholeFamily]), [[200, 1, false], [100, 2, true]]);
  assert.equal(family.windowRole.firstSegment, true);
  assert.equal(family.windowRole.correction.to.price, 400);
  assert.match(family.parentMapping.combination, /4 浪内部.*窗口 400 → 300/);
  assert.match(family.parentMapping.impulse, /5 浪起步.*E 300 完成/);
  const early = fixture([10, 100, 50, 200, 150, 400, 300], 3);
  const earlyFamily = fourth(E.buildTopLevelReadings(early.background, early.structure));
  assert.equal(earlyFamily.windowRole.firstSegment, false);
  assert.match(earlyFamily.windowRole.description, /早于历史最高/);
  assert.ok(earlyFamily.windowRole.positions.some(r => r.includes('3 浪')));
  assert.match(earlyFamily.parentMapping.flat, /跨浪/);
  assert.match(T.parentEvidence({ available: true, families: [] }, 'flat'), /全部被排除/);
});

test('参与计算的有量扎针保留并披露，报告列出规则与未枚举范围', () => {
  const f = fixture();
  f.background.spikes.push({ timestamp: START, classification: 'volume', type: 'L', originalPrice: 0.1, referencePrice: 10,
    volumeRatio: 6, usedTimeframe: '1h', conditions: ['price'], clipped: false });
  const result = E.buildTopLevelReadings(f.background, f.structure), md = E.renderTopLevelReadings(result, 2);
  assert.equal(result.spikes.length, 1);
  assert.match(md, /0.1.*有量扎针.*保留原价/);
  assert.match(md, /嵌套级别/);
  assert.match(md, /跌破或触及 100/);
  assert.match(md, /其中待定/);
});

test('接入前后只新增顶层子块与候选句，既有报告和全部结构序列化一致', () => {
  const candles = require('./fixtures/btc-usd-1d-golden.json');
  const fine = E.anchorBoundaryExtremes(candles, E.detectPivots(candles, 1));
  const tree = E.buildCountTree(fine, candles, { maxDepth: 5, beamK: 4 });
  const meta = { product: 'BTC-USD', timeframe: '1d', startUtc: '2025-10-05T00:00:00Z', endUtc: '2026-10-03T00:00:00Z',
    generatedAtUtc: '2026-10-04T00:00:00Z', sampleCount: candles.length, rangeHigh: 126296, rangeLow: 57717.55 };
  const background = fixture().background;
  const snapshot = () => JSON.stringify({ tree: E.serializeTree(tree), ranked: E.serializeRankedCounts(tree),
    parent: E.serializeMultiDegree(tree, '1d'), current: E.serializeCurrentWaveStructures(tree), inProgress: tree.inProgressStruct });
  const before = snapshot(), oldMd = E.renderMarkdownReport(meta, tree, null, { background });
  const topLevel = E.buildTopLevelReadings(background, tree.primary);
  const newMd = E.renderMarkdownReport(meta, tree, null, { background, topLevel });
  assert.equal(snapshot(), before);
  const normalize = md => md.replace(/^- .*，顶层：.*\n/gm, '')
    .replace(/## 顶层读法（自价格 0，周线）[\s\S]*?(?=\n---\n)/, '').replace(/\n{3,}/g, '\n\n');
  assert.equal(normalize(newMd), normalize(oldMd));
  assert.equal(newMd.split('## 顶层读法').length - 1, 1);
  assert.equal(newMd.split('，顶层：').length - 1, E.deriveParentDegree(tree).all.length);
});
