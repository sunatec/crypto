'use strict';

// pullback-internal-roles：浪②/b 前提下按角色列出回撤段内部读法——五浪类只作单锯齿的 (a)，单锯齿 (b) 的 20% 下限，
// 深 (b) 越过 70% 线仍合规，读法三的五浪风险说明。夹具为 Binance BTCUSDT 日线 2025-10-05 ~ 2026-11-09（末根为当日未收盘）。

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../analyze-wave-tree.js');

let cache = null;
function btc() {
  if (!cache) {
    const candles = require('./fixtures/btcusdt-1d-20261109.json').map((v, index) => ({ ...v, index }));
    const fine = E.anchorBoundaryExtremes(candles, E.detectPivots(candles, 1, {}));
    const split = E.splitPullbackAtLow(fine.slice(fine.findIndex((p) => p.price === 87395.67)), true);
    cache = { candles, fine, split, analysis: E.analyzePullbackCompleted(split.completed, candles) };
  }
  return cache;
}
const prices = (pts) => pts.map((p) => p.price);
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
const dated = (p) => `${p.price}`;
const n = (v) => (Number.isFinite(v) ? String(Math.round(v * 100) / 100) : v);

test('五浪类读法：87395.67→73510 拆出引导楔形与推动浪，角色只有单锯齿的 (a)', () => {
  const { split, analysis } = btc();
  assert.equal(split.trueLow.price, 73510);
  const five = analysis.fiveWave;
  const diag = five.find((p) => p.patternId === 'diagonal-leading');
  assert.ok(diag, '引导楔形应在五浪类候选内');
  assert.deepEqual(prices(diag.points), [87395.67, 79800, 84898, 76325.98, 81196.01, 73510]);
  assert.equal(diag.score.tier1, 0);
  assert.ok(five.some((p) => p.patternId === 'impulse-strict'), '推动浪同样合规');
  for (const p of five) assert.deepEqual(p.roles, ['zigzag-a']);
  assert.ok(five.every((p, i) => five.findIndex((q) => q.patternId === p.patternId) === i), '每种形态只取一个');
});

test('楔形注记：通道收窄约 7.1%，"3 短于 1、5 短于 3"未满足，但候选不被移除', () => {
  const diag = btc().analysis.fiveWave.find((p) => p.patternId === 'diagonal-leading');
  near(diag.diagonal.narrowPct, 0.0708, 5e-4);
  const g = Object.fromEntries(diag.diagonal.guidelines.map((x) => [x.id, x.pass]));
  assert.equal(g['diagonal.ratio.converging'], false);
  assert.equal(g['diagonal.guide.wave5-time-shorter'], true);
});

test('三段式候选带角色；三锯齿不再被并入单锯齿族', () => {
  const { patterns } = btc().analysis;
  const byType = Object.fromEntries(patterns.map((p) => [p.patternType, p.roles]));
  assert.deepEqual(byType.zigzag, ['whole', 'flat-a', 'double-zigzag-w', 'combination-w']);
  assert.deepEqual(byType.flat, ['whole', 'flat-a', 'combination-w']);
  assert.ok(byType['zigzag-triple'], '三锯齿应单独列出');
  assert.ok(patterns.every((p) => p.patternType !== 'driving'), '五浪类不混入 rankedPatterns');
});

test('高一级读法：20% 线 76287.13，反弹 75599.22 未触及；整段有五浪类读法', () => {
  const { split, analysis } = btc();
  const hd = E.buildHigherDegreeReading({ split, patterns: analysis.patterns, fiveWave: analysis.fiveWave });
  assert.equal(hd.state, 'below');
  near(hd.gross, 13885.67);
  near(hd.line20, 76287.134);
  assert.equal(hd.bounce.price, 75599.22);
  assert.equal(hd.touched20, false);
  assert.equal(hd.fiveWaveA, true);
  assert.equal(E.buildHigherDegreeReading({ split, patterns: analysis.patterns, fiveWave: [] }).fiveWaveA, false);
});

function hdText(over) {
  const { split, analysis } = btc();
  const hd = { ...E.buildHigherDegreeReading({ split, patterns: analysis.patterns, fiveWave: analysis.fiveWave }), ...over };
  return E.renderHigherDegree(hd, n, dated).join('\n');
}

test('状态①、未到 20% 线：直接跌破 73510 则"(a) 在 73510 结束的单锯齿"不合规；冲破 70% 线时单锯齿（深 (b)）仍合规', () => {
  const t = hdText({});
  assert.match(t, /20% 线 \*\*76287\.13\*\*，反弹尚未越过/);
  assert.match(t, /\(a\) 在 73510 结束的单锯齿也不合规（\(b\) 不足 \(a\) 的 20%，20% 线 76287\.13\），更可能是 \(a\) 或末段在延伸；只剩双锯齿/);
  assert.match(t, /①冲破 83229\.97：.*单锯齿（深 \(b\)，要求 \(a\) 为五浪类；整段内部已拆出五浪类读法，见上方）在最高未越过 87395\.67 时仍合规；三者的区别在 \(a\) 内部：五浪为单锯齿，三波为平台形或联合形/);
});

test('状态①、已过 20% 线：跌破后剩单锯齿（须 (a) 五浪）或双锯齿；整段无五浪读法时注明缺依据', () => {
  const t = hdText({ touched20: true, bounce: { price: 78000, timestamp: 0 } });
  assert.match(t, /只剩单锯齿（要求 \(a\) 浪为推动浪或引导楔形，即五浪类；整段内部已拆出五浪类读法，见上方）或双锯齿/);
  const none = hdText({ touched20: true, fiveWaveA: false });
  assert.match(none, /整段内部未拆出五浪类读法，单锯齿这条路目前缺少内部结构依据/);
});

test('状态②：规则型时单锯齿（深 (b)）与平台形 / 联合形并存；扩散型时单锯齿已排除', () => {
  const regular = hdText({ state: 'reached', subtype: 'regular', touched70: true, bounce: { price: 84000, timestamp: 0 } });
  assert.match(regular, /平台形 \/ 联合形门槛已开：.*单锯齿（深 \(b\)/);
  const expanded = hdText({ state: 'reached', subtype: 'expanded', touched70: true, bounce: { price: 88000, timestamp: 0 } });
  assert.match(expanded, /规则平台形与单锯齿 \/ 双锯齿已被排除/);
  assert.doesNotMatch(expanded, /单锯齿（深 \(b\)/);
});

test('状态③：写明此前是否触及 20% 线', () => {
  const t = hdText({ state: 'broken', touched70: false, touched20: false, newLow: { price: 72000, timestamp: 0 } });
  assert.match(t, /未触及 20% 线 76287\.13/);
  assert.match(t, /\(a\) 在 73510 结束的单锯齿也不合规/);
});

test('读法三：有五浪类读法时追加"本读法不成立"，没有时不加', () => {
  const { split, analysis } = btc();
  const hd = E.buildHigherDegreeReading({ split, patterns: analysis.patterns, fiveWave: analysis.fiveWave });
  const withFive = E.buildCompletedReading({ hd, patterns: analysis.patterns, roles: [], fiveWave: analysis.fiveWave });
  assert.equal(withFive.fiveWaveRisk, true);
  assert.match(E.renderCompletedReading(withFive, n, dated).join('\n'), /若整段为五浪（单锯齿的 \(a\)，见上方「五浪类读法」），⏳\(进行中\)腿尚未走完，本读法不成立/);
  const without = E.buildCompletedReading({ hd, patterns: analysis.patterns, roles: [], fiveWave: [] });
  assert.equal(without.fiveWaveRisk, false);
  assert.doesNotMatch(E.renderCompletedReading(without, n, dated).join('\n'), /本读法不成立/);
});

test('全流程渲染：内部清单分三段式 / 五浪两类，不再写"均为三段式调整"，不写前提之外的读法', async () => {
  const { candles, fine } = btc();
  const tree = E.buildCountTree(fine, candles, { maxDepth: 5, beamK: 3 });
  tree.pricePrecision = 2;
  const nr = await E.enrichCurrentPullback(tree, { product: 'BTC-USD', mainTf: '1d', finePivots: fine, candles },
    async () => { throw new Error('日线足够，不应下钻'); });
  assert.ok(nr.subDegree.fiveWavePatterns.length >= 1);
  const leg = E.renderPullbackLegDetail(nr, 2, { md: true });
  assert.match(leg, /\*\*87395\.67→73510 这段的内部（三段式调整类）\*\*：/);
  assert.match(leg, /\*\*五浪类读法（只作单锯齿的 \(a\)）\*\*：.*\*\*驱动浪（引导楔形 Leading Diagonal）\*\*（87395\.67 @2026-09-21 → 79800 @2026-10-15 → 84898 @2026-10-21 → 76325\.98 @2026-10-30 → 81196\.01 @2026-11-04 → 73510 @2026-11-08；通道从 2 浪到 4 浪收窄 7\.1%/);
  assert.match(leg, /73510 之后是 \(b\) 三波反弹（须回撤 \(a\) 的 20%～100%，即 76287\.13～87395\.67，不越过 87395\.67），之后还有 \(c\)/);
  assert.doesNotMatch(leg, /均为三段式调整/);
  assert.doesNotMatch(leg, /走完即到头/);
  assert.doesNotMatch(leg, /新一轮下跌|第 1 浪/);
  const json = JSON.parse(JSON.stringify(nr.subDegree));
  assert.ok(json.rankedPatterns.every((p) => Array.isArray(p.roles)));
  assert.ok(json.fiveWavePatterns.every((p) => p.roles.join() === 'zigzag-a'));
});

test('无五浪类候选时保持原措辞', () => {
  const { analysis } = btc();
  const nr = { tf: '1d', level: {}, structureLine: 73510,
    structureLow: { price: 73510, timestamp: 0 }, subDegree: { tf: '1d', rankedPatterns: analysis.patterns, fiveWavePatterns: [] } };
  const leg = E.renderPullbackLegDetail(nr, 2);
  assert.match(leg, /均为三段式调整/);
  assert.doesNotMatch(leg, /五浪类读法/);
});

async function btcNarrative() {
  const { candles, fine } = btc();
  const tree = E.buildCountTree(fine, candles, { maxDepth: 5, beamK: 3 });
  tree.pricePrecision = 2;
  return E.enrichCurrentPullback(tree, { product: 'BTC-USD', mainTf: '1d', finePivots: fine, candles },
    async () => { throw new Error('日线足够，不应下钻'); });
}

test('精简版：已走完提示可能只是第一段，横着走列单锯齿，看线列 20% 线', async () => {
  const nr = await btcNarrative();
  const plain = E.renderPullbackPlain(nr, 2);
  assert.match(plain, /\*\*已走完\*\*：.*但若 87395\.67→73510 本身是五浪，它只是第一段，回调还没走完。/);
  assert.match(plain, /\*\*横着走\*\*：现在只是中间的反弹，之后还会再回落一段（单锯齿 \/ 平台形 \/ 联合形）。/);
  assert.match(plain, /- 连 \*\*76287\.13\*\*（回调的 20%）都没到就跌破 73510 → 这段下跌本身还在延伸，不只是最后一段/);
});

test('精简版：无五浪类读法时保持原文', async () => {
  const nr = await btcNarrative();
  const plain = E.renderPullbackPlain({
    ...nr,
    higherDegree: { ...nr.higherDegree, fiveWaveA: false },
    completedReading: nr.completedReading && { ...nr.completedReading, fiveWaveRisk: false },
  }, 2);
  assert.doesNotMatch(plain, /本身是五浪/);
  assert.match(plain, /之后还会再回落一段（平台形 \/ 联合形）。/);
});
