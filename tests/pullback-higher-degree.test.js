'use strict';

// pullback-higher-degree-flat-reading：回撤真低点之前的整段 = a/w 浪，之后的反弹 = b/x 浪。
// 数值来自 BTC 2026-09-21 高点 87395.67 → 2026-10-15 低点 79800 的回撤；纯算术，离线可测。

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../analyze-wave-tree.js');

const BASE = 1790000000;
const pv = (price, type, index, provisional) => ({ price, type, index, timestamp: BASE + index * 86400, ...(provisional ? { provisional: true } : {}) });
const n = (v) => v.toFixed(2);
const dated = (p) => `${n(p.price)}（d${Math.round((p.timestamp - BASE) / 86400)}）`;

const A_LEG = [pv(87395.67, 'H', 0), pv(82874.93, 'L', 3), pv(85255, 'H', 4), pv(82563, 'L', 7),
  pv(87220, 'H', 11), pv(80393.56, 'L', 17), pv(84352, 'H', 21), pv(79800, 'L', 24)];
const PATTERNS = [{ label: '单锯齿（Zigzag 5-3-5）' }, { label: '平台形（Flat 3-3-5，基础版）' }, { label: '双重横向整理（联合形 w-x-y）' }];
const G = 87395.67 - 79800; // 7595.67

function reading(afterLow, patterns = PATTERNS, combinationReading = null) {
  const split = E.splitPullbackAtLow([...A_LEG, ...afterLow], true);
  return E.buildHigherDegreeReading({ split, patterns, combinationReading });
}
// 反弹越过摆动高点时，splitPullbackAtLow 会把新高当作摆动高点；扩散型分支用手工 split 覆盖反弹极值来测。
function readingWithBounce(price) {
  const split = E.splitPullbackAtLow([...A_LEG, pv(84898, 'H', 30)], true);
  return E.buildHigherDegreeReading({ split: { ...split, bounceExtreme: pv(price, 'H', 30) }, patterns: PATTERNS });
}
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

test('状态①：反弹最高 84898 未到 70% 线 85116.97，差 218.97，占整段 67.1%', () => {
  const hd = reading([pv(82940.81, 'H', 25), pv(80684.36, 'L', 27), pv(84898, 'H', 30, true)]);
  assert.equal(hd.state, 'below');
  near(hd.gross, G);
  near(hd.line70, 79800 + 0.7 * G);
  near(hd.regularCap, 87395.67);
  near(hd.comboCap, 79800 + 1.5 * G);
  near(hd.flatCap, 79800 + 2 * G);
  near(hd.shortfall, hd.line70 - 84898);
  near(hd.xPct, (84898 - 79800) / G);
  assert.equal(hd.cTargets.length, 0, '状态①不给 c 目标');
  assert.equal(hd.touched70, false);
});

test('状态②规则型：已过 70% 线、未越过摆动高点 → c 目标 0.618/1/1.236，自反弹最高量', () => {
  const hd = reading([pv(85500, 'H', 30)]);
  assert.equal(hd.state, 'reached');
  assert.equal(hd.subtype, 'regular');
  assert.deepEqual(hd.cTargets.map((t) => t.mult), [0.618, 1, 1.236]);
  hd.cTargets.forEach((t) => near(t.price, 85500 - t.mult * G));
});

test('状态②扩散型：越过摆动高点 → 1.236~1.618；越过联合形上限排除联合形；达平台形上限作废', () => {
  const exp = readingWithBounce(88000);
  assert.equal(exp.subtype, 'expanded');
  assert.deepEqual(exp.cTargets.map((t) => t.mult), [1.236, 1.618]);
  assert.equal(exp.comboExcluded, false);
  const noCombo = readingWithBounce(92000);
  assert.equal(noCombo.comboExcluded, true);
  assert.equal(noCombo.invalid, false);
  const dead = readingWithBounce(95000);
  assert.equal(dead.invalid, true);
  assert.equal(dead.cTargets.length, 0);
});

test('状态③：反弹后创新低 → a 终点取此前的 79800，newLow=78000，是否触及 70% 线分别记录', () => {
  const quiet = reading([pv(84898, 'H', 30), pv(78000, 'L', 36, true)]);
  assert.equal(quiet.state, 'broken');
  assert.equal(quiet.aEnd.price, 79800);
  assert.equal(quiet.newLow.price, 78000);
  assert.equal(quiet.touched70, false);
  const touched = reading([pv(85500, 'H', 30), pv(78000, 'L', 36, true)]);
  assert.equal(touched.state, 'broken');
  assert.equal(touched.touched70, true);
});

test('状态③：此前反弹不足整段 20% 时不算"跌破 a 终点"，按新低为 a 终点、反弹尚未展开', () => {
  const hd = reading([pv(80500, 'H', 30), pv(78000, 'L', 36, true)]);
  assert.notEqual(hd.state, 'broken');
  assert.equal(hd.aEnd.price, 78000);
});

test('整段内部没有调整浪读法（或仅三角形）→ 不输出高一级读法', () => {
  assert.equal(reading([pv(84898, 'H', 30)], []), null);
  assert.equal(reading([pv(84898, 'H', 30)], [{ label: '收缩三角形（Contracting Triangle）' }]), null);
});

test('渲染：状态①写明差额、两个分支、分级失效线，不断言"c 必须跌破"，不给联合形 y 目标', () => {
  const hd = reading([pv(84898, 'H', 30)]);
  const txt = E.renderHigherDegree(hd, n, dated).join('\n');
  assert.match(txt, /读法一（⏳\(进行中\)腿整体）\*\*：即轴②该进行中腿本身的形态/);
  assert.match(txt, /反弹尚差 \*\*218\.97\*\*/);
  assert.match(txt, /占 \(a\)\/\(w\) 的 67\.1%/);
  assert.match(txt, /没到 85116\.97 就跌破 79800\.00/);
  assert.match(txt, /只剩单锯齿.*双锯齿/);
  assert.match(txt, /不构成回撤结束的证据/);
  assert.match(txt, /失效线（分级）/);
  assert.match(txt, /不等于回撤结束/);
  assert.match(txt, /届时以轴②为准：轴②改以新高为摆动极值重新研判/);
  assert.match(txt, /备注：书中扩散 \/ 顺势平台形的 \(b\) 可越过 \(a\) 起点/);
  assert.match(txt, /双锯齿 \(w\)-\(x\)-\(y\)/);
  assert.doesNotMatch(txt, /必须跌破|c 浪必须跌破/);
  assert.doesNotMatch(txt, /y 浪.{0,6}(目标|参考)位?\s*[→:：]/);
  assert.doesNotMatch(txt, /c 浪参考/, '状态①不给 c 目标');
  assert.doesNotMatch(txt, /(?<![(（/])\b[abcwxy] 浪/, '腿内部浪名一律括号记号');
});

test('渲染：状态②给暂定 (c) 目标（归轴③目标位）并说明联合形 (y) 不给目标', () => {
  const hd = reading([pv(85500, 'H', 30)]);
  const txt = E.renderHigherDegree(hd, n, dated).join('\n');
  assert.match(txt, /反弹已触及 70% 线/);
  assert.match(txt, /规则型/);
  assert.match(txt, /平台形 \(c\) 浪参考位见轴③「回撤目标位」/);
  const targets = E.renderPullbackTargets(narrativeWith(hd), 2);
  assert.match(targets, /平台形 \(c\) 浪参考.*暂取目前反弹高点 85500 为 \(b\) 终点/);
  assert.match(targets, /联合形 \(y\) 浪不给目标/);
});

test('渲染：越过摆动高点时写明规则平台形/单锯齿/双锯齿已被排除', () => {
  const txt = E.renderHigherDegree(readingWithBounce(88000), n, dated).join('\n');
  assert.match(txt, /扩散 \/ 顺势型/);
  assert.match(txt, /已被排除/);
});

test('渲染：状态③未触及 70% 线只剩单锯齿/双锯齿；触及则平台形/联合形仍在', () => {
  const quiet = E.renderHigherDegree(reading([pv(84898, 'H', 30), pv(78000, 'L', 36, true)]), n, dated).join('\n');
  assert.match(quiet, /已跌破此前的 \(a\)\/\(w\) 终点 79800\.00/);
  assert.match(quiet, /始终未触及/);
  assert.match(quiet, /平台形与联合形已被排除/);
  const hit = E.renderHigherDegree(reading([pv(85500, 'H', 30), pv(78000, 'L', 36, true)]), n, dated).join('\n');
  assert.match(hit, /曾触及/);
  assert.match(hit, /仍在候选内/);
});

test('渲染：两条 70% 线并存时写明各自基准与现在所处位置', () => {
  // 联合形读法 Y 浪 87220→79800（7420），XX 线 = 79800+0.7×7420 = 84994；反弹 84898 低于两条线
  const cr = { xxRetracePct: 0.687, legs: { Y: { from: 87220, to: 79800 } } };
  const below = E.renderPullbackLegDetail(narrativeWith(reading([pv(84898, 'H', 30)], PATTERNS, cr)), 2);
  assert.match(below, /两条 70% 线的区别/);
  assert.match(below, /84994/);
  assert.match(below, /两条线都尚未触及/);
  // 反弹 85050：已过 84994（联合形 XX）、未过 85116.97（整段）
  const between = E.renderPullbackLegDetail(narrativeWith(reading([pv(85050, 'H', 30)], PATTERNS, cr)), 2);
  assert.match(between, /介于二者之间：读法二的 \(xx\) 已过线、读法一尚未过线/);
});

function narrativeWith(hd) {
  return {
    level: { level: '级别待定', exceeds: null, depth: NaN },
    structureLine: 79800,
    tf: '1d',
    subDegree: { tf: '1d', drilled: false, rankedPatterns: [
      { label: '单锯齿（Zigzag 5-3-5）', points: A_LEG.slice(0, 7).filter((_, i) => [0, 3, 6].includes(i)).concat([A_LEG[7]]) },
      { label: '平台形（Flat 3-3-5，基础版）', points: [A_LEG[0], A_LEG[3], A_LEG[4], A_LEG[7]] },
    ] },
    combinationReading: null, zwaveTargets: null,
    ...(hd ? { higherDegree: hd } : {}),
  };
}

test('整体叙述：有高一级读法时，a-b-c 改称整段内部结构，续涨条件有条件、不再写"走完即到头"', () => {
  const hd = reading([pv(84898, 'H', 30)]);
  const txt = E.renderPullbackNarrative(narrativeWith(hd), 2);
  assert.match(txt, /这段的内部\*\*：\*\*单锯齿/);
  assert.match(txt, /读法一把它看作 \(a\)\/\(w\)/);
  assert.doesNotMatch(txt, /读法三/, '无已走完读法数据时不提读法三');
  assert.doesNotMatch(txt.split('\n').find((l) => l.includes('这段的内部**')), /\b[abc]\(/, '(a) 内部只写价链，不用字母');
  assert.match(txt, /守住结构线不单独构成回撤结束的证据/);
  assert.doesNotMatch(txt, /走完即到头|仍有上攻动力/);
  assert.ok(txt.indexOf('读法一（⏳(进行中)腿整体）**：') > txt.indexOf('这段的内部'));
});

test('整体叙述：无高一级读法时保持原文（向后兼容）', () => {
  const txt = E.renderPullbackNarrative(narrativeWith(null), 2);
  assert.match(txt, /走完即到头/);
  assert.match(txt, /仍有上攻动力/);
  assert.doesNotMatch(txt, /读法一/);
});

test('这段内部：3 浪段终点之前有更极端价时注明截断（书§4.7），5 浪段注明失败第五浪（书§3.15）', () => {
  const nr = narrativeWith(reading([pv(84898, 'H', 30)]));
  nr.subDegree.rankedPatterns[1].beyondEnds = [{ leg: 0, end: { price: 82563, timestamp: A_LEG[3].timestamp }, beyond: { price: 82000, timestamp: A_LEG[2].timestamp } }];
  nr.subDegree.rankedPatterns[0].beyondEnds = [{ leg: 0, end: { price: 82563, timestamp: A_LEG[3].timestamp }, beyond: { price: 81000, timestamp: A_LEG[2].timestamp } }];
  const txt = E.renderPullbackLegDetail(nr, 2);
  assert.match(txt, /平台形首段内部低点 82000 @\S+ 低于该段终点 82563：该段末浪未跌破此前低点（截断，书§4\.7），正统终点仍取 82563/);
  assert.match(txt, /单锯齿首段内部低点 81000 @\S+ 低于该段终点 82563：该段第 5 浪未跌破第 3 浪低点（失败第五浪，书§3\.15）/);
});
