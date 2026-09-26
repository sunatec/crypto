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

test('金标准：真极值下 W-X-Y 双锯齿零违规——书籍勘误后不再被误判降级', () => {
  // 演进史：rank-competing-wave-counts 一度让本案例找到"零违规单锯齿"126296→84400→97964→
  // 57718；但 macro-endpoint-span-extreme 揭示那套是几何伪清白——其 a 段(126296→84400)内部
  // 藏着更低的 80524，84400 并非该段真极值，故被正确淘汰。用真极值数（126296→80524.65→
  // 97963.62→57717.55）时，y/w≈0.879，此前"y须>90%w"被误当硬规则，曾令本案例退化为
  // penalized 的最轻违规者；书籍勘误（y浪通常>90%w，非必须）把该下界降为指引后，
  // 双锯齿读法真正零违规，不再需要优雅降级。优雅降级机制本身另有 selectBest 专门单测覆盖。
  const { tree } = buildGoldenTree();
  const s = t.serializeTree(tree);
  assert.equal(s.fitScore.tier1, 0, '书籍勘误后，真极值 W-X-Y 双锯齿应零违规');
  assert.equal(s.fitScore.penalized, false);
  // 端点须是各自跨度的真极值：a 段端点不得再是被更低点(80524)包住的 84400
  assert.ok(!s.points.some((p) => p.price === 84400), 'a 段端点不应是非极值的 84400');
});

test('金标准：修平票后主选=W-X-Y 双锯齿，不再是结构不对的单锯齿（structured-wave-report §2.4）', () => {
  // 文法违规带 tier2 越界权重后，"结构不对的单锯齿(文法违规,原 tier2=0)"不再平票压过
  // "仅差 0.5% 比例的 W-X-Y(tier2=0.005)"。主选应对齐真实拟合，变为 W-X-Y。
  const { tree } = buildGoldenTree();
  assert.equal(tree.primary.patternId, 'zigzag-double', '主选应为双锯齿 W-X-Y');
  assert.deepEqual(tree.primary.points.map((p) => p.price), [126296, 80524.65, 97963.62, 57717.55]);
  // 单锯齿(文法违规)的 tier2 现在带权重、被压到 W-X-Y 之后
  const all = [tree.primary, ...(tree.alternates || [])];
  const single = all.find((c) => c.patternId === 'zigzag');
  if (single && single.score.grammarViolations > 0) {
    assert.ok(single.score.tier2 > tree.primary.score.tier2, '结构不对的单锯齿 tier2 应被权重压到主选之后');
  }
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

test('金标准：给我的数法打分——书籍勘误后双锯齿零违规，其余读法仍非零违规', () => {
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
  // 书籍勘误（y浪通常>90%w，非必须）后，双锯齿读法(y/w≈0.879)不再违反该规则——真正零违规
  const double = res.results.find((r) => r.patternId === 'zigzag-double');
  assert.ok(double, '应含双锯齿读法');
  assert.equal(double.total.tier1, 0, '双锯齿读法(y/w≈0.879)不再因 y下界规则计违规');
  // 其余读法（单锯齿/平台/联合形等）与该规则无关，仍应各自非零违规
  const others = res.results.filter((r) => r.patternId !== 'zigzag-double');
  assert.ok(others.every((r) => r.total.tier1 > 0), '其余读法仍应各自非零违规');
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
  assert.ok(md.includes('技术细节'), '应含技术细节折叠节');
});

// ── brief-report-summary：报告以 4 条波浪分析简报开头，三轴明细折叠 ──

test('金标准：报告以 4 条简报开头，失效点=assessment.invalidation', () => {
  const { tree } = buildGoldenTree();
  const md = t.renderMarkdownReport({ product: 'BTC-USD', timeframe: '1d', startUtc: new Date().toISOString(), endUtc: new Date().toISOString(), generatedAtUtc: new Date().toISOString(), source: 'fixture', sampleCount: 314 }, tree);
  assert.ok(md.startsWith('# BTC/USD 日线波浪分析简报'), '首行应为简报标题');
  const idx = ['1. 大局研判', '2. 当前浪型', '3. 核心生死线', '4. 关键目标与交易位置'].map((s) => md.indexOf(s));
  assert.ok(idx.every((i) => i > 0), '简报 4 条均应出现');
  assert.ok(idx.every((i, k) => k === 0 || i > idx[k - 1]), '简报 4 条应按序出现');
  const inv = t.formatPrice(tree.assessment.invalidation);
  assert.ok(md.includes(`3. 核心生死线（失效点）：${inv}`), `失效点应为 ${inv}`);
  assert.ok(md.includes('警惕 Z 浪下跌'), '主选 XX 时应提示警惕 Z 浪下跌');
  assert.ok(md.includes('非投资建议'), '应有免责声明');
});

test('金标准：简报与最新收盘比对——跌破支撑标"已跌破"，摆动极值已越过的目标标"已到"', () => {
  const { tree } = buildGoldenTree();
  const base = { product: 'BTC-USD', timeframe: '1d', startUtc: new Date().toISOString(), endUtc: new Date().toISOString(), generatedAtUtc: new Date().toISOString(), source: 'fixture', sampleCount: 314 };
  const swing = tree.inProgressStruct.swingExtreme.price;
  const low = tree.assessment.invalidation;
  // 现价压到支撑区下方（失效点之上一点）
  const broken = t.renderBrief({ ...base, lastClose: low + (swing - low) * 0.1 }, tree);
  assert.ok(/下预警\/支撑：.*已跌破（现 .*），回踩低吸区失效/.test(broken), '跌破支撑区应标已跌破');
  // 现价在支撑区上方：保持"回踩低吸区"
  const ok = t.renderBrief({ ...base, lastClose: swing * 0.99 }, tree);
  assert.ok(ok.includes('（回踩低吸区）'), '未跌破时应保持回踩低吸区');
  // 低于摆动高点的 XX 目标 = 反弹已摸到过 → 标已到
  const tg = tree.assessment.bounceHyp.xx.targets.filter((x) => x.price > 0).slice(0, 3);
  const expected = tg.filter((x) => x.price <= swing).length;
  assert.ok(expected > 0, 'fixture 中应至少有一个目标已被摆动高点越过');
  assert.equal((ok.match(/（已到）/g) || []).length, expected, '越过的目标应标已到');
  if (expected === tg.length) assert.ok(ok.includes('目标均已到，警惕 Z 浪下跌'));
});

test('金标准：三轴明细折叠在 <details> 内，TL;DR/大白话版不再出现', () => {
  const { tree } = buildGoldenTree();
  const md = t.renderMarkdownReport({ product: 'BTC-USD', timeframe: '1d', startUtc: new Date().toISOString(), endUtc: new Date().toISOString(), generatedAtUtc: new Date().toISOString(), source: 'fixture', sampleCount: 314 }, tree);
  const open = md.indexOf('<details>');
  const close = md.lastIndexOf('</details>');
  ['# 轴① 大跌走完了什么形态', '# 轴② 当前反弹是什么结构', '# 轴③ 接下来往哪、何时'].forEach((h) => {
    const i = md.indexOf(h);
    assert.ok(i > open && i < close, `${h} 应位于 <details> 内`);
  });
  assert.ok(!md.includes('现状研判（先看这里，TL;DR）'), '现状研判 TL;DR 不应再出现');
  assert.ok(!md.includes('大白话版'), '大白话版不应再出现');
});

// ── consolidate-report-by-theme：按主题轴单一权威呈现（旧节标题字面断言已改为主题级断言）──

test('金标准：报告按三条主题轴组织，各轴标题恰好出现一次', () => {
  const { tree } = buildGoldenTree();
  const md = t.renderMarkdownReport({ product: 'BTC-USD', timeframe: '1d', startUtc: new Date().toISOString(), endUtc: new Date().toISOString(), generatedAtUtc: new Date().toISOString(), source: 'fixture', sampleCount: 314 }, tree);
  const countOf = (needle) => md.split(needle).length - 1;
  assert.equal(countOf('# 轴① 大跌走完了什么形态'), 1, '轴①标题应恰好出现一次');
  assert.equal(countOf('# 轴② 当前反弹是什么结构'), 1, '轴②标题应恰好出现一次');
  assert.equal(countOf('# 轴③ 接下来往哪、何时'), 1, '轴③标题应恰好出现一次');
  const idxBrief = md.indexOf('波浪分析简报');
  const idxAxis1 = md.indexOf('# 轴① 大跌走完了什么形态');
  const idxAxis2 = md.indexOf('# 轴② 当前反弹是什么结构');
  const idxAxis3 = md.indexOf('# 轴③ 接下来往哪、何时');
  assert.ok(idxBrief < idxAxis1 && idxAxis1 < idxAxis2 && idxAxis2 < idxAxis3, '顺序应为 简报 → 轴① → 轴② → 轴③');
});

test('金标准：转折时间窗全报告仅出现一次（归属轴③）', () => {
  const { tree } = buildGoldenTree();
  const md = t.renderMarkdownReport({ product: 'BTC-USD', timeframe: '1d', startUtc: new Date().toISOString(), endUtc: new Date().toISOString(), generatedAtUtc: new Date().toISOString(), source: 'fixture', sampleCount: 314 }, tree);
  const countOf = (needle) => md.split(needle).length - 1;
  assert.equal(countOf('斐波时间窗'), 1, '斐波时间窗小节标题全文应仅出现一次');
  assert.ok(!md.includes('可能的转折时间窗（斐波时间共振'), '大白话版旧的重复时间窗小节不应再出现');
});

test('金标准：关键数字（主选形态/失效点/反弹目标）仍在，且各自只有一个权威落点', () => {
  const { tree } = buildGoldenTree();
  const md = t.renderMarkdownReport({ product: 'BTC-USD', timeframe: '1d', startUtc: new Date().toISOString(), endUtc: new Date().toISOString(), generatedAtUtc: new Date().toISOString(), source: 'fixture', sampleCount: 314 }, tree);
  assert.ok(md.includes('57718') || md.includes('57717'), '失效点数字应仍在报告中');
  assert.ok(md.includes('双锯齿'), '主选形态名称应仍在报告中（轴①）');
  // 反弹目标梯度（XX/B/推动3 三选一）只应在轴③出现一次，不与轴①父级候选表重复列出
  assert.equal(md.split('若是 XX 连接浪').length - 1, 1, 'XX 连接浪目标梯度应只在轴③出现一次');
  assert.ok(!md.includes('反弹目标（回撤比×参考腿）'), '轴①父级候选表不应再重列目标价梯度');
});

test('金标准：大白话版不再整体复述三轴明细', () => {
  const { tree } = buildGoldenTree();
  const md = t.renderMarkdownReport({ product: 'BTC-USD', timeframe: '1d', startUtc: new Date().toISOString(), endUtc: new Date().toISOString(), generatedAtUtc: new Date().toISOString(), source: 'fixture', sampleCount: 314 }, tree);
  assert.ok(!md.includes('拆成几大段'), '大白话版不应再有"拆成几大段"明细节');
  assert.ok(!md.includes('现在走到哪了'), '大白话版不应再有"现在走到哪了"明细节');
  assert.ok(!md.includes('接下来可能到哪'), '大白话版不应再有"接下来可能到哪"明细节');
});

test('金标准：数据层零改动——serializeTree/serializeRankedCounts/serializeCurrentWaveStructures 不受呈现层重构影响', () => {
  const { tree } = buildGoldenTree();
  const s = t.serializeTree(tree);
  assert.equal(s.patternId, 'zigzag-double');
  assert.deepEqual(s.points.map((p) => p.price), [126296, 80524.65, 97963.62, 57717.55]);
  const rc = t.serializeRankedCounts(tree) || [];
  assert.ok(rc.length >= 4, 'rankedCounts 候选数应不受呈现层改动影响');
  assert.equal(rc[0].framing, 'A');
  const cws = t.serializeCurrentWaveStructures(tree);
  assert.ok(cws && Array.isArray(cws.structures) && cws.structures.length >= 3, 'currentWaveStructures 应不受呈现层改动影响');
});

// ── gate-extending-final-leg-rules（延伸中末腿：终点锚真极值 + 可判定性规则闸门）──
// 金标准 now(63123) 高于全局低点 57717.55 → 逆势回撤中，触发本次改动的两条机制。

test('金标准：框架B主选末腿锚全局极值57717.55、标延伸中，非回撤价 (§2.1)', () => {
  const { tree } = buildGoldenTree();
  const rc = t.serializeRankedCounts(tree) || [];
  const b = rc.find((r) => r.framing === 'B' && r.finalWaveInProgress);
  assert.ok(b, '应有末浪进行中的框架B候选');
  const last = b.legs[b.legs.length - 1];
  assert.equal(Math.round(last.to), 57718, '末腿终点=全局极值57718（不是now回撤价）');
  assert.equal(last.status, '⏳ 延伸中', '末腿状态应为延伸中');
});

test('金标准：书籍勘误后"y须>90%w"已降为指引，延伸中双锯齿末腿不再因此计违规/待判，tier1=0 (§2.2/2.3)', () => {
  const { tree } = buildGoldenTree();
  const rc = t.serializeRankedCounts(tree) || [];
  // 双锯齿的 y 就是进行中末腿；y/w≈0.879<0.9，若仍是硬规则会需要闸门暂缓——
  // 书籍勘误后该下界已降为 guidelines，压根不再进入 rules/failed，无需闸门介入。
  const dz = rc.find((r) => r.framing === 'B' && r.finalWaveInProgress && r.label.includes('双锯齿'));
  assert.ok(dz, '应有框架B双锯齿末浪进行中候选');
  assert.equal(dz.score.tier1, 0, '规则全过（tier1=0，y下界已非规则）');
  assert.ok(!(dz.deferred || []).some((d) => d.desc.includes('y浪价格须>w浪90%')), 'y须>90%w 已非规则，不应再出现在待判里');
  assert.ok(!(dz.violations || []).some((v) => v.desc.includes('y浪价格须>w浪90%')), 'y须>90%w 已非规则，不应再计违规');
});

test('金标准：与末腿终点无关的规则(已完成的y)仍照计违规——闸门不误伤 (§2.2)', () => {
  // 书籍勘误后 y>90%w 已降为指引，golden 行情里不再有"已完成腿的违规"可测，改用构造点位直测闸门：
  // 下跌三锯齿 w:100→60 x:60→90 y:90→70 xx:70→80 z:80→75（进行中）。
  // y(20) < x(30) → 违反 y-gt-x（只涉已完成腿，末点延伸改变不了）→ 必须照计；
  // z(5) < xx(10) → 违反 z 规则（z 继续下探可翻转）→ 应标待判。
  const pat = t.PATTERNS.find((p) => p.id === 'zigzag-triple');
  const manual = pat.build('down');
  const points = [100, 60, 90, 70, 80, 75].map((price, i) => ({ price, index: i * 10, type: i % 2 === 0 ? 'H' : 'L' }));
  const ctx = { points, direction: 'down', candles: [], measures: {} };
  const failed = manual.rules
    .map((r) => ({ r, res: r.test(ctx) }))
    .filter(({ res }) => !res.pass)
    .map(({ r, res }) => ({ id: r.id, desc: r.desc, overshoot: res.overshoot }));
  const failedIds = failed.map((f) => f.id);
  assert.ok(failedIds.includes('zigzag-triple.ratio.y-gt-x'), '构造点位应违反 y-gt-x');
  assert.ok(failedIds.includes('zigzag-triple.ratio.z-vs-xx-y-w'), '构造点位应违反 z 规则');
  const gated = t.applyInProgressRuleGate({ points, direction: 'down', manual, measures: {}, score: { failed } }, []);
  const deferredIds = (gated.deferred || []).map((d) => d.id);
  assert.ok(!deferredIds.includes('zigzag-triple.ratio.y-gt-x'), '已完成 y 浪的规则不应被闸门暂缓（照计违规）');
  assert.ok(deferredIds.includes('zigzag-triple.ratio.z-vs-xx-y-w'), '进行中 z 浪的规则应被闸门暂缓（待判）');
});

test('金标准：闸门后tier1=0的框架B候选仍带未完成度惩罚、不顶替框架A主选 (§2.4)', () => {
  const { tree } = buildGoldenTree();
  const rc = t.serializeRankedCounts(tree) || [];
  assert.equal(rc[0].framing, 'A', '主选仍是框架A（已完成候选）');
  const b = rc.find((r) => r.framing === 'B' && r.finalWaveInProgress && r.score.tier1 === 0);
  assert.ok(b, '应有规则全过的框架B末浪进行中候选');
  assert.ok(b.score.incompleteness > 0, '即便规则全过仍带未完成度惩罚');
  assert.ok(rc.indexOf(b) > 0, '排在框架A主选之后，不因规则全过顶替主选');
});

// ── mark-extending-leg-character-fork（进行中末腿"两可"性格分叉的保留与标注）──
// 用户 explore 场景：BTC 备选1（双锯齿 w-x-y），y=97964→57718⏳ 的末端子腿 82814→57718
// 被显示为单锯齿（调整），但该子腿两可——驱动/5浪读法同样零违规，只是被 y 位(调整角色)压掉。

test('金标准：备选1双锯齿的末端两可腿(82814→57718)带 altCharacter，对侧=driving/推动浪 (§2/§4.1)', () => {
  const { tree } = buildGoldenTree();
  const rc = t.serializeRankedCounts(tree) || [];
  const dz = rc.find((r) => r.framing === 'B' && r.finalWaveInProgress && r.label.includes('双锯齿'));
  assert.ok(dz, '应有框架B双锯齿末浪进行中候选（备选1）');
  const alt = dz.altCharacter;
  assert.ok(alt, '末端两可腿应带 altCharacter');
  assert.equal(Math.round(alt.legFrom.price), 82814, '两可腿起点=82814');
  assert.equal(Math.round(alt.legTo.price), 57718, '两可腿终点=57718（与 y 腿终点重合，是 y 的末端子腿）');
  assert.equal(alt.shownCharacter, 'corrective', '当前显示性格=调整（单锯齿），因该腿占双锯齿 y 位');
  assert.equal(alt.character, 'driving', '对侧读法=驱动');
  assert.ok(alt.label.includes('推动浪'), `对侧形态应为推动浪，实际 ${alt.label}`);
  assert.ok(Array.isArray(alt.points) && alt.points.length >= 6, '对侧读法(5浪)应带完整点位序列');
  assert.equal(Math.round(alt.points[0].price), 82814);
  assert.equal(Math.round(alt.points[alt.points.length - 1].price), 57718);
});

test('金标准：altCharacter 标注不改变选中的计数与排名（纯标注，回归金标准快照）(§5)', () => {
  const { tree } = buildGoldenTree();
  const rc = t.serializeRankedCounts(tree) || [];
  // 与既有金标准断言完全一致：主选仍为框架A、顶层结构不变——加标注前后这些不变量应保持一致
  assert.equal(rc[0].framing, 'A', '标注后主选仍是框架A（未被两可标注影响排名）');
  assert.equal(tree.primary.patternId, 'zigzag-double', '标注后顶层主选仍为双锯齿 W-X-Y');
  const dz = rc.find((r) => r.framing === 'B' && r.finalWaveInProgress && r.label.includes('双锯齿'));
  assert.equal(dz.score.tier1, 0, '标注后该候选 tier1 仍为 0（闸门后规则全过，不受影响）');
});

test('金标准：Markdown 报告在备选表格行内联两可提示、表格下方附对侧点位 (inline-extending-leg-fork-in-table §4)', () => {
  const { tree } = buildGoldenTree();
  const md = t.renderRankedCounts(tree);
  const rc = t.serializeRankedCounts(tree) || [];
  const dz = rc.find((r) => r.framing === 'B' && r.finalWaveInProgress && r.label.includes('双锯齿'));
  const alt = dz.altCharacter;
  const shortShown = alt.shownLabel.replace(/（.*?）/, '');
  const shortAlt = alt.label.replace(/（.*?）/, '');
  assert.ok(md.includes(`两可:${shortShown}/${shortAlt}`), '备选表格"腿"列应内联"两可:现取/对侧"短标签后缀');
  assert.ok(md.includes('82814'), '报告应含两可腿起点 82814');
  assert.ok(md.includes('对侧点位'), '报告应含表格下方的对侧点位附注行');
  assert.ok(!md.includes('对侧读法点位'), '旧的表格外两行式脚注（含"对侧读法点位"）不应再出现在备选表格处');
});

// ── enumerate-current-wave-structures（当前进行浪：枚举所有合规的具体结构）──
// 金标准场景：spanLast=57717.55(L，已确认低点)，之后先反弹到摆动极值66923.95，再回落到
// now=63123.68(prov)。post-spanLast 细枢轴数=13(≥5)，同时满足 T1/T2/T3 三个2腿模板与
// T4 的5腿"末浪"模板的触发门槛，供本节验证枚举、去重、排名与失效点/投影是否都对。

test('金标准：当前进行浪结构表非空，至少含一条看跌(续大势)+一条看多/中继(反弹侧)，各带子计数/当前浪位/投影/失效点', () => {
  const { tree } = buildGoldenTree();
  const cws = tree.currentWaveStructures;
  assert.ok(cws && Array.isArray(cws.structures) && cws.structures.length >= 3, '当前进行浪结构表不应为空');
  const bearish = cws.structures.find((s) => s.tendency === '看跌');
  const bullishOrCont = cws.structures.find((s) => s.tendency === '看多' || s.tendency === '中继');
  assert.ok(bearish, '应至少有一条"看跌"结构（续大势创新低一侧）');
  assert.ok(bullishOrCont, '应至少有一条"看多"或"中继"结构（反弹一侧）');
  [bearish, bullishOrCont].forEach((s) => {
    assert.ok(Array.isArray(s.legs) && s.legs.length, '每条结构应带子计数腿');
    assert.ok(typeof s.currentWave === 'string' && s.currentWave, '每条结构应标当前浪位');
    assert.ok(Array.isArray(s.projection) && s.projection.length, '每条结构应带下一浪投影');
    assert.ok(s.invalidation && Number.isFinite(s.invalidation.price), '每条结构应带失效点');
  });
});

test('金标准：在建型读法"浪②进行中"出现，未走的浪③不计入违规（tier1=0，标待判）(§2.3 在建部分不误判)', () => {
  const { tree } = buildGoldenTree();
  const cws = tree.currentWaveStructures;
  const t2 = cws.structures.find((s) => s.id === 'reverse-impulse-2');
  assert.ok(t2, '应有"新上涨推动·浪②进行中"在建型读法，而非被强行读成已完成结构');
  const leg2 = t2.legs.find((l) => l.name === '②');
  const leg3 = t2.legs.find((l) => l.name === '③');
  assert.equal(leg2.status, '⏳进行中', '②应标进行中');
  assert.equal(leg3.status, '未走', '③尚未走，不应被当成已完成腿');
  assert.equal(leg3.to, null, '未走浪③无终点，规则天然不对它判定');
  assert.equal(t2.tier1, 0, '未走的③不应产生任何硬规则违规');
  assert.ok(t2.deferred.some((d) => d.includes('未走')), '未走浪③应标为待判说明，不是被判违规后又清除');
});

test('金标准：细枢轴充足(≥5)时产出 T4"上涨5浪推动·⑤进行中"，label去重不压掉同倾向的T3 (§1.4/1.5/2.1-2.4/5.3)', () => {
  const { tree } = buildGoldenTree();
  const cws = tree.currentWaveStructures;
  const t4 = cws.structures.find((s) => s.id === 'reverse-impulse-5');
  assert.ok(t4, 'spanLast之后细枢轴≥5个时应产出T4"⑤进行中"读法');
  assert.equal(t4.legs.length, 5, '子计数应完整含①②③④(完成)+⑤(进行中)');
  assert.deepEqual(t4.legs.map((l) => l.name), ['①', '②', '③', '④', '⑤']);
  assert.ok(t4.legs.slice(0, 4).every((l) => l.status === '完成'), '①②③④应均已完成');
  assert.equal(t4.legs[4].status, '⏳进行中', '⑤应标进行中');
  // 失效点=p4（④底），不随每根新K线漂移——直接等于④腿的终点
  assert.equal(Math.round(t4.invalidation.price), Math.round(t4.legs[3].to), '失效点应锚定在p4（④底）');
  assert.ok(t4.projection.every((p) => p.price > t4.invalidation.price), '⑤目标投影应在p4上方（顺revDir延伸）');
  assert.equal(t4.tendency, '看多', 'BTC此段spanLast为确认低点，T4应为看多(末浪)读法');
  // label去重生效：T3"浪②进行中"与T4"⑤进行中"同为"看多"倾向、外层身份不同，都应保留
  const t3 = cws.structures.find((s) => s.id === 'reverse-impulse-2');
  assert.ok(t3, 'T3"浪②进行中"不应因倾向去重被同倾向的T4压掉（label去重）');
  assert.notEqual(t3.label, t4.label, 'T3/T4 label（外层身份）应不同——新起步 vs 末浪');
});

test('金标准：Markdown 报告含"当前进行浪：可能的具体结构"新节，_tree.json 平级挂 currentWaveStructures (§3.1-3.3)', () => {
  const { tree } = buildGoldenTree();
  const md = t.renderMarkdownReport({ product: 'BTC-USD', timeframe: '1d', startUtc: new Date().toISOString(), endUtc: new Date().toISOString(), generatedAtUtc: new Date().toISOString(), source: 'fixture', sampleCount: 314 }, tree);
  assert.ok(md.includes('当前进行浪：可能的具体结构'), '报告应含新节标题（现归入轴②）');
  assert.ok(md.includes('上涨5浪推动·⑤进行中'), '报告新节应列出T4读法');
  const s = t.serializeTree(tree);
  assert.ok(s, 'serializeTree 应返回顶层节点');
  // currentWaveStructures 是与 tree 平级的字段（非 serializeTree 的一部分），单独校验其存在
  assert.ok(tree.currentWaveStructures && Array.isArray(tree.currentWaveStructures.structures), 'tree.currentWaveStructures 应平级挂出、结构非空');
});
