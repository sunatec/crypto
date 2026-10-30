'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const manual = require('../analyze-wave-manual');
const { computePivots, classifyStructure, detectDivergence, analyzeStructure } = require('../advisor/structure');
const { analyzeTimeframe } = require('../advisor/indicators');
const { resolveParams } = require('../advisor/params');

const DAILY = require('./fixtures/btcusdt-1d-20261025.json');
const P = resolveParams();

test('拐点：H/L 严格交替，且与波浪引擎同参数结果一致', () => {
  const pivots = computePivots(DAILY, P);
  assert.ok(pivots.length >= 6, `拐点数 ${pivots.length}`);
  for (let i = 1; i < pivots.length; i += 1) assert.notEqual(pivots[i].type, pivots[i - 1].type, `第 ${i} 个拐点未交替`);

  const indexed = DAILY.map((c, i) => ({ ...c, index: i }));
  const raw = manual.detectPivots(indexed, 2, { atrSeries: manual.computeATR(indexed, 14), atrMultiplier: 1 });
  const rawByIndex = new Map(raw.map((p) => [`${p.index}:${p.type}`, p]));
  for (const p of pivots) {
    const r = rawByIndex.get(`${p.index}:${p.type}`);
    assert.ok(r, `拐点 index=${p.index} ${p.type} 不在引擎输出里`);
    assert.equal(r.price, p.price);
  }
  assert.ok(pivots.length <= raw.length);
  assert.deepEqual(computePivots(DAILY, P), pivots, '确定性');
});

test('HH/HL、LH/LL、mixed 与数据不足', () => {
  const mk = (prices) => prices.map(([type, price], index) => ({ type, price, index, ts: index }));
  assert.equal(classifyStructure(mk([['L', 90], ['H', 100], ['L', 95], ['H', 110]])).pattern, 'HH/HL');
  assert.equal(classifyStructure(mk([['H', 110], ['L', 100], ['H', 105], ['L', 95]])).pattern, 'LH/LL');
  assert.equal(classifyStructure(mk([['L', 90], ['H', 100], ['L', 85], ['H', 110]])).pattern, 'mixed');
  const few = classifyStructure(mk([['L', 90], ['H', 100]]));
  assert.equal(few.pattern, null);
  assert.equal(few.lastHigh.price, 100);
});

test('analyzeStructure：fixture 上输出结构事实与两侧背离结果', () => {
  const { facts: tf, internals } = analyzeTimeframe(DAILY, '日线', P);
  const { facts, pivots } = analyzeStructure(DAILY, internals, '日线', P);
  assert.ok(['HH/HL', 'LH/LL', 'mixed'].includes(facts.pattern));
  assert.equal(facts.pivots.length, Math.min(12, pivots.length));
  for (const side of ['bottom', 'top']) assert.ok(['confirmed', 'forming', 'none'].includes(facts.divergence[side].status));
  assert.ok(tf.count === DAILY.length);
});

// ---- 三段背离：手工构造柱序列 ----
const N = 50;

function pivotsOf(type, prices, idxs) {
  const other = type === 'L' ? 'H' : 'L';
  const out = [];
  idxs.forEach((idx, k) => {
    out.push({ type, price: prices[k], index: idx, ts: 1000 + idx });
    out.push({ type: other, price: type === 'L' ? 200 : 10, index: idx + 7, ts: 1000 + idx + 7 });
  });
  return out.sort((a, b) => a.index - b.index);
}

// sign=-1 底背离（柱为负时是"谷"），sign=+1 顶背离
function histOf(sign, { base, troughs, tail }) {
  const h = new Array(N).fill(-sign * base); // 谷与谷之间的基线：反向柱
  [[10, troughs[0]], [25, troughs[1]], [40, troughs[2]]].forEach(([c, d]) => {
    for (let k = -2; k <= 2; k += 1) h[c + k] = sign * d * (1 - Math.abs(k) / 3);
    h[c] = sign * d;
  });
  tail.forEach((v, i) => { h[N - tail.length + i] = sign * v; });
  return h;
}

const run = (side, hist, prices) => detectDivergence({
  hist, side, label: '4H', lastIndex: N - 1, lastTs: 1000 + N - 1, params: P,
  pivots: pivotsOf(side === 'bottom' ? 'L' : 'H', prices, [10, 25, 40]),
});

test('三段底背离已确认：价格更低、谷依次变浅、段间有正柱、第三低点后柱缩短', () => {
  const hist = histOf(-1, { base: 1, troughs: [10, 6, 3], tail: [2.6, 2.2, 2.0, 1.5] });
  const r = run('bottom', hist, [100, 95, 90]);
  assert.equal(r.status, 'confirmed');
  assert.equal(r.stopPrice, 90);
  assert.equal(r.oppositeBarSeen, true);
  assert.equal(r.extremes.length, 3);
  assert.deepEqual(r.extremes.map((e) => e.price), [100, 95, 90]);
  assert.deepEqual(r.extremes.map((e) => e.histExtreme), [-10, -6, -3]);
  assert.equal(r.macdParams, '12/26/9');
  assert.ok(r.nextBarRule && r.lastClosedIso);
});

test('第三低点后柱未缩短 → forming，不输出 confirmed', () => {
  const hist = histOf(-1, { base: 1, troughs: [10, 6, 3], tail: [2.6, 2.2, 2.0, 2.4] });
  const r = run('bottom', hist, [100, 95, 90]);
  assert.equal(r.status, 'forming');
  assert.match(r.reasons.join(''), /尚未被确认/);
  assert.equal(r.stopPrice, 90);
});

test('缺少反向柱分隔 → 不输出三段背离，最多标为普通背离', () => {
  const hist = histOf(-1, { base: -8, troughs: [20, 14, 9], tail: [8.5, 8.2, 8.0, 7.5] }); // base 为负 → 段间柱始终为负
  const r = run('bottom', hist, [100, 95, 90]);
  assert.equal(r.status, 'none');
  assert.equal(r.ordinary, true);
  assert.equal(r.oppositeBarSeen, false);
});

test('价格或柱未满足条件 → none', () => {
  const weak = run('bottom', histOf(-1, { base: 1, troughs: [10, 6, 7], tail: [2, 2, 2, 1.5] }), [100, 95, 90]);
  assert.equal(weak.status, 'none');
  assert.match(weak.reasons.join(''), /连续两次减弱/);
  const price = run('bottom', histOf(-1, { base: 1, troughs: [10, 6, 3], tail: [2, 2, 2, 1.5] }), [100, 95, 97]);
  assert.equal(price.status, 'none');
  assert.match(price.reasons.join(''), /依次更低/);
  const few = detectDivergence({ hist: new Array(N).fill(1), pivots: [], side: 'bottom', label: '4H', lastIndex: N - 1, lastTs: 1, params: P });
  assert.equal(few.status, 'none');
  assert.match(few.reasons.join(''), /不足 3 个/);
});

test('三段顶背离对称：确认', () => {
  const hist = histOf(+1, { base: 1, troughs: [10, 6, 3], tail: [2.6, 2.2, 2.0, 1.5] });
  const r = run('top', hist, [90, 95, 100]);
  assert.equal(r.status, 'confirmed');
  assert.equal(r.stopPrice, 100);
  assert.equal(r.side, 'top');
});

test('第三极值过久 → none', () => {
  const hist = histOf(-1, { base: 1, troughs: [10, 6, 3], tail: [2, 2, 2, 1.5] });
  const r = detectDivergence({
    hist, side: 'bottom', label: '4H', lastIndex: N - 1, lastTs: 1, params: { ...P, divergenceMaxAge: 5 },
    pivots: pivotsOf('L', [100, 95, 90], [10, 25, 40]),
  });
  assert.equal(r.status, 'none');
  assert.match(r.reasons.join(''), /超过 5 根/);
});
