'use strict';

// 书第3章（§3.6 / §3.18.2 / §3.21）与推动浪手册、报告主选展示的对照回归。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  scoreCandidate,
  buildImpulseStrictManual,
  buildDiagonalManual,
  waveFourTimeGate,
  countInvalid,
  renderRankedCounts,
  renderNarrative,
} = require('../analyze-wave-tree.js');

// 价格序列 + 每个拐点的K线下标（默认等距 3 根）
function pts(prices, indices = prices.map((_, i) => i * 3)) {
  return prices.map((price, i) => ({ price, index: indices[i], timestamp: 1700000000 + indices[i] * 3600 }));
}
const ids = (s) => s.failed.map((f) => f.id);
const impulse = (prices, indices) => scoreCandidate({ points: pts(prices, indices), direction: 'up' }, buildImpulseStrictManual('up'));

test('§3.18.2：2浪回撤21%合法（旧23.6%下限会误杀）', () => {
  const s = impulse([100, 200, 179, 260, 230, 300]);
  assert.equal(s.tier1, 0, ids(s).join(','));
});

test('§3.18.2：2浪回撤不足20%推翻推动浪假设', () => {
  const s = impulse([100, 200, 185, 260, 230, 300]);
  assert.ok(ids(s).includes('impulse.ratio.wave2-retrace-min-20'));
});

test('§3.18.2/§1.5：2浪回撤95%只受100%规则约束，不再被88.6%上限否定', () => {
  const s = impulse([100, 200, 105, 300, 260, 320]);
  assert.equal(s.tier1, 0, ids(s).join(','));
});

test('书无3浪扩展上限：3浪=5.5倍1浪不违规', () => {
  const s = impulse([100, 110, 105, 160, 150, 170]);
  assert.equal(s.tier1, 0, ids(s).join(','));
});

test('§3.21：4浪时间超过3浪2倍推翻推动浪假设', () => {
  // ③ 3根，④ 25根
  const s = impulse([100, 200, 150, 260, 230, 300], [0, 3, 6, 9, 34, 37]);
  assert.ok(ids(s).includes('impulse.time.wave4-le-2x-wave3'));
});

test('§3.21：名义超2倍但在拐点K线误差内时待较小周期定位，不判违规', () => {
  // ③ 10根，④ 21根：真实时长可能是 11 与 20
  const s = impulse([100, 200, 150, 260, 230, 300], [0, 3, 6, 16, 37, 40]);
  assert.ok(!ids(s).includes('impulse.time.wave4-le-2x-wave3'));
  assert.ok(s.pendingRules.some((r) => r.id === 'impulse.time.wave4-le-2x-wave3'));
});

test('§3.21：4浪恰为3浪2倍不违规', () => {
  const s = impulse([100, 200, 150, 260, 230, 300], [0, 3, 6, 16, 36, 39]);
  assert.ok(!ids(s).includes('impulse.time.wave4-le-2x-wave3'));
  assert.ok(!s.pendingRules.some((r) => r.id === 'impulse.time.wave4-le-2x-wave3'));
});

test('§3.21 适用于全部驱动浪：楔形同样受4浪时间约束', () => {
  const s = scoreCandidate({ points: pts([100, 140, 120, 150, 135, 155], [0, 3, 6, 9, 34, 37]), direction: 'up' }, buildDiagonalManual('up', 'ending'));
  assert.ok(ids(s).includes('diagonal.time.wave4-le-2x-wave3'));
});

test('waveFourTimeGate：确定超时/误差内待定/未超时', () => {
  assert.equal(waveFourTimeGate(10, 25, 1).pass, false);
  assert.ok(!waveFourTimeGate(10, 25, 1).undetermined);
  assert.equal(waveFourTimeGate(10, 21, 1).undetermined, true);
  assert.equal(waveFourTimeGate(10, 20, 1).pass, true);
  // 较小周期单位下，同样的跨度可以被定论
  assert.ok(!waveFourTimeGate(10 * 24, 21 * 24, 1).undetermined);
});

function fake(tier1, verificationStatus) {
  return {
    manual: { label: '单锯齿（Zigzag 5-3-5）' }, direction: 'down', patternId: 'zigzag',
    points: [{ price: 100 }, { price: 80 }, { price: 95 }, { price: 60 }],
    score: { tier1, tier2: tier1 ? 0.3 : 0, incompleteness: 0, complexity: 1, verificationStatus,
      failed: tier1 ? [{ id: 'x', desc: 'b浪价格须在a浪的20%~100%之间', overshoot: 0.3 }] : [], grammarNotes: [], deferred: [] },
  };
}

test('countInvalid：硬规则违规或子浪验证失败都算不成立', () => {
  assert.equal(countInvalid(fake(1, 'invalid')), true);
  assert.equal(countInvalid(fake(0, 'invalid')), true);
  assert.equal(countInvalid(fake(0, 'pending')), false);
});

test('§3.6：排名第一仍违规时报告写"无合法数法"，不称主选', () => {
  const md = renderRankedCounts({ primary: fake(1, 'invalid'), alternates: [] }, 2);
  assert.match(md, /❌ 无合法数法/);
  assert.match(md, /违规最轻的读法：单锯齿/);
  assert.doesNotMatch(md, /主选：/);
});

test('§3.6：合法候选照常展示为主选', () => {
  const md = renderRankedCounts({ primary: fake(0, 'pending'), alternates: [] }, 2);
  assert.match(md, /⏳ 主选：单锯齿/);
  assert.doesNotMatch(md, /无合法数法/);
});

test('§3.6：大白话版同样不把违规读法说成"最像"', () => {
  const md = renderNarrative({ pricePrecision: 2 }, { primary: fake(1, 'invalid') });
  assert.match(md, /无合法数法/);
  assert.doesNotMatch(md, /最像/);
});

// ── §3.6 指引分层：浪型指引 > 比率指引 > 时间指引 ──

const { compareCandidates, alternationHit, correctiveSlope } = require('../analyze-wave-tree.js');
const base = { severe: 0, tier1: 0, tier2: 0, incompleteness: 0, complexity: 1, tier4: 0 };
const withHits = (pattern, ratio, time) => ({ ...base, guideHits: { pattern, ratio, time }, tier3: -(pattern + ratio + time) });

test('§3.6：一条浪型指引压过多条时间指引', () => {
  const pattern = withHits(1, 0, 0), time = withHits(0, 0, 3);
  assert.deepEqual([time, pattern].sort(compareCandidates), [pattern, time]);
});

test('§3.6：浪型指引持平时比率指引优先于时间指引', () => {
  const ratio = withHits(0, 1, 0), time = withHits(0, 0, 2);
  assert.deepEqual([time, ratio].sort(compareCandidates), [ratio, time]);
});

test('§3.6：各层持平才轮到跨级别指引', () => {
  const a = { ...withHits(0, 1, 1), tier4: 0 }, b = { ...withHits(0, 1, 1), tier4: 1 };
  assert.deepEqual([a, b].sort(compareCandidates), [b, a]);
});

test('缺分层数据的旧式分数退回总命中数比较', () => {
  const a = { ...base, tier3: -1 }, b = { ...base, tier3: -2 };
  assert.deepEqual([a, b].sort(compareCandidates), [b, a]);
});

test('scoreCandidate 按层记录指引命中', () => {
  const s = impulse([100, 200, 150, 300, 270, 330]); // 3浪=1.5×1浪，命中1.618附近的比率指引
  assert.equal(s.guideHits.ratio, 1);
  assert.equal(s.guideHits.pattern, 0, '交替不再按回撤比率差在手册里判');
});

const node = (patternId, children) => ({ isLeaf: false, primary: { patternId, children } });

test('§1.7 陡直/横向分类', () => {
  assert.equal(correctiveSlope(node('zigzag-double')), 'steep');
  assert.equal(correctiveSlope(node('flat-expanded')), 'sideways');
  assert.equal(correctiveSlope(node('triangle')), 'sideways');
  assert.equal(correctiveSlope(node('sideways-double', [node('flat')])), 'sideways');
  assert.equal(correctiveSlope(node('sideways-double', [node('zigzag')])), null, '以单锯齿起始的双重横向整理两可');
  assert.equal(correctiveSlope({ isLeaf: true }), null);
});

test('§1.7：推动浪2/4浪陡直与横向交替才算交替', () => {
  const impulseOf = (two, four) => ({ patternId: 'impulse-strict', children: [null, node(two), null, node(four), null] });
  assert.equal(alternationHit(impulseOf('zigzag', 'triangle')), true);
  assert.equal(alternationHit(impulseOf('zigzag', 'zigzag-double')), false, '简单/复杂不是交替');
  assert.equal(alternationHit(impulseOf('flat', 'triangle')), false);
  assert.equal(alternationHit({ ...impulseOf('zigzag', 'flat'), patternId: 'diagonal-leading' }), false, '楔形不计交替');
});
