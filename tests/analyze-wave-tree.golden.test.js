'use strict';

// 金标准回归（Q14 第③层）：加载固化的 BTC-USD 1d 蜡烛 fixture（不联网），
// 断言引擎产出的「最大级别 → 当前浪」计数树的关键结构不变量。
// 目的：后续按 Q10b 逐条审规则时，任何让此真实案例计数倒退的改动都会在此暴露。
//
// 采「结构golden」而非「整串快照」：只钉稳定不变量（顶层形态族、起终锚点、进行中腿存在性、
// 序列化可round-trip），避免每次微调 overshoot 阈值都误报——真正的倒退（顶层换族、
// 起点丢失、进行中腿消失、schema 破裂）仍会被抓到。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const t = require('../analyze-wave-tree.js');
const rawCandles = require('./fixtures/btc-usd-1d-golden.json');

function buildGoldenTree() {
  const candles = rawCandles.map((c, i) => ({ ...c, index: i }));
  let fine = t.detectPivots(candles, 1, {});
  fine = t.anchorBoundaryExtremes(candles, fine);
  return { tree: t.buildCountTree(fine, candles, { maxDepth: 5, beamK: 3 }), candles };
}

test('金标准：fixture 为 314 根 1d 蜡烛', () => {
  assert.equal(rawCandles.length, 314);
});

test('金标准：顶层从区间高点 126296 起锚（缺陷1不得回归）', () => {
  const { tree } = buildGoldenTree();
  const s = t.serializeTree(tree);
  assert.equal(s.points[0].price, 126296);
});

test('金标准：顶层为已知形态、净向下', () => {
  // 注：不固定具体形态族——随规则逐章转录完善，最佳拟合会在推动/调整间迁移（属预期）。
  // 稳定不变量是「起自126296、净向下、有进行中腿、优雅降级」，见其余各条。
  const { tree } = buildGoldenTree();
  const s = t.serializeTree(tree);
  assert.equal(s.direction, 'down');
  const knownIds = t.PATTERNS.map((p) => p.id);
  assert.ok(knownIds.includes(s.patternId), `顶层应为已知形态，实际 ${s.patternId}`);
});

test('金标准：存在当前进行中腿（缺陷2不得回归）', () => {
  const { tree } = buildGoldenTree();
  const s = t.serializeTree(tree);
  assert.ok(s.inProgress, '应挂出当前进行中腿');
  assert.equal(s.inProgress.currentLegDir, 'up'); // 主跌见底后当前反弹向上
  assert.equal(s.inProgress.from, 57717.55); // 顶层结构止于主趋势低点57717，之后为进行中反弹
});

test('金标准：搜索补全后能找到真正零违规的顶层读法（rank-competing-wave-counts）', () => {
  // 本测试原断言「真实整段套不出零违规单形态，应降级」——那正是
  // rank-competing-wave-counts 要修的缺陷：旧版 segmentations() 每形态只回一个
  // 贪心坍缩结果，126296→84400→97964→57718 这个零违规的单锯齿读法从未被生成/打分。
  // 搜索补全后，对这份固化的金标准数据，顶层主选确认是 tier1=0（已用独立的
  // evaluateExplicitCount 路径交叉核对，非 bug；见该 change 的 proposal.md）。
  // 优雅降级机制本身（无人零违规时退取最轻违规者）仍由 selectBest 的专门单测覆盖，
  // 不因这里换了断言而失去覆盖。
  const { tree } = buildGoldenTree();
  const s = t.serializeTree(tree);
  assert.equal(s.fitScore.tier1, 0, '搜索补全后应能找到零违规顶层读法');
  assert.equal(s.fitScore.penalized, false);
  assert.equal(s.patternId, 'zigzag');
  assert.deepEqual(s.points.map((p) => p.price), [126296, 84400, 97963.62, 57717.55]);
});

test('金标准：序列化 schema 完整且可 round-trip', () => {
  const { tree } = buildGoldenTree();
  const s = t.serializeTree(tree);
  for (const key of ['patternId', 'label', 'direction', 'points', 'fitScore', 'children']) {
    assert.ok(key in s, `顶层缺字段 ${key}`);
  }
  const rt = JSON.parse(JSON.stringify(s));
  assert.equal(rt.patternId, s.patternId);
  assert.ok(Array.isArray(rt.children));
});

test('金标准：给我的数法打分——用户 W-X-Y 在每种4点读法下都非零违规', () => {
  const candles = rawCandles.map((c, i) => ({ ...c, index: i }));
  let fine = t.detectPivots(candles, 1, {});
  fine = t.anchorBoundaryExtremes(candles, fine);
  const findIdx = (price, kind) => {
    let bi = -1; let bd = 1e9;
    candles.forEach((c, i) => { const v = kind === 'H' ? c.high : c.low; const d = Math.abs(v - price); if (d < bd) { bd = d; bi = i; } });
    return bi;
  };
  const P = (price, type) => { const idx = findIdx(price, type); return { index: idx, type, price, timestamp: candles[idx].timestamp }; };
  const wxy = [P(126296, 'H'), P(80524.65, 'L'), P(97963.62, 'H'), P(57717.55, 'L')];
  const res = t.evaluateExplicitCount(wxy, fine, candles);
  assert.equal(res.direction, 'down');
  assert.ok(res.results.length >= 4, '应至少匹配单锯齿/双锯齿/平台/双重横向4种');
  assert.ok(res.results.every((r) => r.total.tier1 > 0), '用户 W-X-Y 每种读法都应有违规');
  // 联合形读法：x 回撤 70% 规则应不通过
  const sideways = res.results.find((r) => r.patternId === 'sideways-double');
  const xRule = sideways.ruleResults.find((rr) => rr.desc.includes('x浪须回撤w浪'));
  assert.equal(xRule.pass, false, '联合形 x 回撤70%规则应不通过');
});

test('金标准：现状研判——大级别偏多、失效点=57717、身份框架(XX主选)', () => {
  const { tree } = buildGoldenTree();
  const a = tree.assessment;
  assert.ok(a, '应生成现状研判');
  assert.equal(a.bigTrend, 'up', '顶层为调整浪(向下)→修正完成→大级别偏多');
  assert.equal(a.invalidation, 57717.55, '失效点=顶层完成结构终点极值');
  assert.equal(a.currentDir, 'up', '当前波段=反弹向上');
  const h = a.bounceHyp;
  assert.ok(h, '应有当前反弹身份研判');
  assert.equal(h.lean, 'xx', '反弹为三波→XX 主选');
  // XX 上方目标在失效点上方、其下跌段在失效点下方
  assert.ok(h.xx.targets.every((t2) => t2.price > a.invalidation));
  assert.ok(h.xx.down.every((t2) => t2.price < a.invalidation));
  // B 目标含 0.7×整段 ≈ 105722
  const b07 = h.b.targets.find((t2) => t2.ratio === 0.7);
  assert.ok(Math.abs(b07.price - 105722) < 500, `B 0.7目标应≈105722，实际 ${b07.price.toFixed(0)}`);
  // 近端触发线取 57717→反弹首个高点
  assert.ok(a.nearTerm && a.nearTerm.from === 57717.55);
});

test('金标准：--count 用户 W-X-Y 的身份研判——XX 复现作者 65766–82589', () => {
  const candles = rawCandles.map((c, i) => ({ ...c, index: i }));
  let fine = t.detectPivots(candles, 1, {});
  fine = t.anchorBoundaryExtremes(candles, fine);
  const pts = t.pointsFromPrices([126296, 80524.65, 97963.62, 57717.55], candles);
  const ue = t.evaluateExplicitCount(pts, fine, candles);
  const h = ue.bounceHyp;
  assert.ok(h, '应有身份研判');
  // 用户结构的"上一子浪"=Y(97963→57717)=40246；XX 0.2/0.618 ≈ 65766 / 82589
  const xx02 = h.xx.targets.find((x) => x.ratio === 0.2);
  const xx618 = h.xx.targets.find((x) => x.ratio === 0.618);
  assert.ok(Math.abs(xx02.price - 65766) < 300, `XX 0.2 应≈65766，实际 ${xx02.price.toFixed(0)}`);
  assert.ok(Math.abs(xx618.price - 82589) < 500, `XX 0.618 应≈82589，实际 ${xx618.price.toFixed(0)}`);
});

test('金标准：Markdown 报告非空且含进行中浪与计数树两节', () => {
  const { tree } = buildGoldenTree();
  const md = t.renderMarkdownReport({ product: 'BTC-USD', timeframe: '1d', startUtc: new Date().toISOString(), endUtc: new Date().toISOString(), generatedAtUtc: new Date().toISOString(), source: 'fixture', sampleCount: 314 }, tree);
  assert.ok(md.includes('一句话大局'), '应含大白话大局节');
  assert.ok(md.includes('现在走到哪了'), '应含现在走到哪节');
  assert.ok(md.includes('技术细节'), '应含技术细节折叠节');
});
