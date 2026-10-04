'use strict';

// narrate-current-pullback：当前高点回撤叙述的单元/集成测试。
// 纯计算部分离线可测；async 下钻用注入的 fetchFn 桩，不联网。
// 关键回归：Z 浪主目标落在 Z=W=Y 等长带、含 0.236 破位档（BTC 实盘 74758 案例）。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  tfStepDown,
  splitPullbackAtLow,
  maxInternalRetrace,
  classifyPullbackDegree,
  zwaveProjection,
  readCombination,
  drillPullback,
  enrichCurrentPullback,
  renderPullbackNarrative,
} = require('../analyze-wave-tree.js');

// 合成枢轴：{price,type,index,timestamp}
function pv(price, type, index) {
  return { price, type, index, timestamp: 1700000000 + index * 3600 };
}

test('tfStepDown：粗→细逐级降，末级返回 null', () => {
  assert.equal(tfStepDown('1d'), '4h');
  assert.equal(tfStepDown('4h'), '1h');
  assert.equal(tfStepDown('1h'), '5m');
  assert.equal(tfStepDown('5m'), null);
  assert.equal(tfStepDown('unknown'), null);
});

// 前段上涨：100 → 130(1) → 118(2，回撤12) → 160(3) → 150(4，回撤10) → 175(5)
const RALLY = [pv(100, 'L', 0), pv(130, 'H', 1), pv(118, 'L', 2), pv(160, 'H', 3), pv(150, 'L', 4), pv(175, 'H', 5)];

test('maxInternalRetrace：取段内已创极值到之后反向极值的最大一次回撤', () => {
  assert.deepEqual(maxInternalRetrace(RALLY, true), { depth: 12, from: 130, to: 118 });
  // 次级反弹未创新高时，回撤仍从此前最高点量起
  const nested = [pv(100, 'L', 0), pv(130, 'H', 1), pv(120, 'L', 2), pv(125, 'H', 3), pv(112, 'L', 4), pv(170, 'H', 5)];
  assert.deepEqual(maxInternalRetrace(nested, true), { depth: 18, from: 130, to: 112 });
  assert.equal(maxInternalRetrace(RALLY.slice(0, 2), true), null);
});

test('§3.3：回撤超过前段上涨内部任何一次回撤 → 高一级', () => {
  const r = classifyPullbackDegree(RALLY, true, 162); // 175→162，幅13 > 12
  assert.equal(r.level, '高一级');
  assert.equal(r.exceeds, true);
  assert.equal(r.depth, 13);
});

test('§3.3：未超过前段内部最大回撤 → 仍可能是子浪调整（等于不算超过）', () => {
  assert.equal(classifyPullbackDegree(RALLY, true, 163).level, '子浪级'); // 幅12 = 最大内部回撤
  assert.equal(classifyPullbackDegree(RALLY, true, 170).exceeds, false);
});

test('§3.3：前段无内部回撤或数据不足时级别待定', () => {
  assert.equal(classifyPullbackDegree([pv(100, 'L', 0), pv(150, 'H', 1)], true, 120).level, '级别待定');
  assert.equal(classifyPullbackDegree(null, true, 120).level, '级别待定');
});

test('§3.3：下跌段之后的反弹同样适用', () => {
  const drop = [pv(200, 'H', 0), pv(170, 'L', 1), pv(185, 'H', 2), pv(140, 'L', 3)];
  assert.equal(classifyPullbackDegree(drop, false, 160).level, '高一级'); // 反弹20 > 15
  assert.equal(classifyPullbackDegree(drop, false, 150).level, '子浪级');
});

test('§3.3 叙述：写明比较对象与结论', () => {
  const text = renderPullbackNarrative({ level: classifyPullbackDegree(RALLY, true, 162), structureLine: 162, subDegree: null, combinationReading: null, zwaveTargets: null }, 2);
  assert.match(text, /已超过前段上涨内部任何一次回撤（最大一次 130→118，幅 12）/);
  assert.match(text, /书§3\.3/);
  const sub = renderPullbackNarrative({ level: classifyPullbackDegree(RALLY, true, 170), structureLine: 170, subDegree: null, combinationReading: null, zwaveTargets: null }, 2);
  assert.match(sub, /内部的子浪调整/);
});

test('splitPullbackAtLow：剥出摆动极值/真低点/反弹极值与两截', () => {
  // 高点 79500 → 真低点 75538 → 反弹 78055（当前）
  const fine = [
    pv(79500, 'H', 0), pv(76202, 'L', 1), pv(78828, 'H', 2),
    pv(75538, 'L', 3), pv(78055, 'H', 4),
  ];
  const s = splitPullbackAtLow(fine, true);
  assert.equal(s.swingExtreme.price, 79500);
  assert.equal(s.trueLow.price, 75538);
  assert.equal(s.bounceExtreme.price, 78055);
  assert.equal(s.completed[s.completed.length - 1].price, 75538); // 完成段收在真低点
  assert.equal(s.completed[0].price, 79500);
  assert.equal(s.inProgress[0].price, 75538); // 进行中段从真低点起
});

test('readCombination：联合形 W/X/Y 逐腿 + XX 对 Y 回撤%', () => {
  const comboCand = {
    patternId: 'sideways-double',
    points: [pv(79500, 'H', 0), pv(76202, 'L', 1), pv(78828, 'H', 2), pv(75538, 'L', 3)],
  };
  const combo = readCombination(comboCand, pv(75538, 'L', 3), pv(78055, 'H', 4));
  assert.deepEqual(combo.legs.W, { from: 79500, to: 76202 });
  assert.deepEqual(combo.legs.Y, { from: 78828, to: 75538 });
  assert.deepEqual(combo.legs.XX, { from: 75538, to: 78055 });
  assert.equal(combo.legs.Z.pending, true);
  // XX 幅=2517.25，Y 幅=3290.25 → 76.5%
  assert.ok(Math.abs(combo.xxRetracePct - (78055 - 75538) / (78828 - 75538)) < 1e-9);
  assert.ok(combo.xxRetracePct >= 0.7); // 满足连接浪门槛
});

test('zwaveProjection：主目标 = Z=W=Y 等长带，含 0.236 破位档（锁 74758 案例）', () => {
  const wAmp = 79500 - 76202.06; // 3297.94
  const yAmp = 78828.37 - 75538.12; // 3290.25
  const z = zwaveProjection(wAmp, yAmp, 75538.12, 78055.25);
  const m = z.breakPath.main;
  assert.equal(z.trigger, 75538.12);
  // 等长带含 74758；0.236 破位档 ≈ 74761.6
  assert.ok(m.low <= 74758 && m.high >= 74757, `等长带应含74758，实际 ${m.low}-${m.high}`);
  assert.ok(Math.abs(m.breakFib0236 - (75538.12 - 0.236 * yAmp)) < 1e-6);
  assert.ok(Math.abs(m.breakFib0236 - 74761.6) < 1);
  assert.equal(z.breakPath.aftermath, 'Z 浪走完后转向上涨');
  assert.ok(z.trianglePath); // 三角路径存在
  assert.equal(zwaveProjection(1, 0, 100, 110), null); // yAmp<=0 降级
});

test('renderPullbackNarrative：无子结构时形态待明、无警戒线措辞', () => {
  const txt = renderPullbackNarrative({
    level: { level: '级别待定', exceeds: null, depth: NaN },
    structureLine: 75538,
    subDegree: null, combinationReading: null, zwaveTargets: null,
  });
  assert.match(txt, /级别待定/);
  assert.match(txt, /形态待明/);
  assert.match(txt, /守住结构线 \*\*75538\*\*/);
  assert.doesNotMatch(txt, /警惕|警戒/); // 警戒线已砍
});

// ---- async：下钻 + 编排（注入 fetchFn 桩，不联网）----

// 构造一段有清晰 高→低→反弹 的 1h 蜡烛（fetchCandles 返回形状），供 detectPivots 拆出 ≥4 枢轴
function stub1hCandles() {
  const path = [
    79500, 79000, 78200, 77000, 76202, 77200, 78300, 78828, 78000,
    77000, 76471, 75900, 75538, 76200, 77100, 78055, 77600, 78016,
  ];
  return path.map((p, i) => ({
    timestamp: 1700000000 + i * 3600,
    low: p - 60, high: p + 60, open: p, close: p, volume: 100,
  }));
}

test('drillPullback：自适应步降到子级别并拿到 ≥4 枢轴（注入 fetchFn）', async () => {
  const fetchStub = async () => stub1hCandles();
  const window = { fromTs: 1700000000, toTs: 1700000000 + 17 * 3600 };
  const out = await drillPullback('X-USD', '4h', window, fetchStub); // 4h→1h
  assert.ok(out, '应返回子级别数据');
  assert.equal(out.tfKey, '1h');
  assert.ok(out.fine.length >= 4, `子级别枢轴应 ≥4，实际 ${out.fine.length}`);
});

test('enrichCurrentPullback：structUp=false（下跌途中反弹）不产叙述', async () => {
  const tree = {
    inProgressStruct: {
      structUp: false,
      swingExtreme: pv(60000, 'L', 0),
      pullback: { from: pv(60000, 'L', 0), to: pv(63000, 'H', 5), currentLegDir: 'up' },
    },
  };
  const res = await enrichCurrentPullback(tree, { product: 'X-USD', mainTf: '1d', finePivots: [], candles: [] }, async () => []);
  assert.equal(res, null);
  assert.equal(tree.inProgressStruct.pullback.narrative, undefined);
});

test('enrichCurrentPullback：高点回撤经下钻产出 subDegree/structureLine（注入 fetchFn）', async () => {
  const swingHigh = pv(79500, 'H', 10);
  const edge = pv(78016, 'H', 27);
  // 主级别 finePivots 只有 高→低→反弹 3 点（拆不出，触发下钻）；带若干历史 H→L 供定级
  const finePivots = [
    pv(57717, 'L', 0), pv(66924, 'H', 4), pv(62210, 'L', 8),
    swingHigh, pv(75538, 'L', 12), edge,
  ];
  const tree = {
    inProgressStruct: {
      structUp: true,
      swingExtreme: swingHigh,
      pullback: { from: swingHigh, to: edge, currentLegDir: 'down' },
    },
  };
  const fetchStub = async () => stub1hCandles();
  const res = await enrichCurrentPullback(
    tree, { product: 'X-USD', mainTf: '1d', finePivots, candles: [] }, fetchStub,
  );
  assert.ok(res, '应产出叙述');
  assert.ok(res.subDegree && res.subDegree.drilled, '应标记已下钻');
  assert.equal(res.subDegree.tf, '1h');
  assert.ok(Number.isFinite(res.structureLine));
  assert.ok(res.level && res.level.level, '应给出级别');
  assert.ok(typeof res.text === 'string' && res.text.includes('当前高点回撤研判'));
  // 挂到 pullback 上，供序列化/渲染读取
  assert.equal(tree.inProgressStruct.pullback.narrative, res);
});

test('zwaveProjection：破位路径各档在 trigger 之下且逐档加深；trigger 之上的等长位单列（BTC 82510 案例）', () => {
  const z = zwaveProjection(87397 - 82708.96, 85250 - 82510.37, 82510.37, 85613.72);
  const { main, extension, extreme } = z.breakPath;
  assert.ok(main.high < z.trigger, '主目标须在 Y 低之下');
  assert.deepEqual(main.aboveTrigger.map((e) => e.label), ['Z=Y 等长'], '82874 在 82510 之上，单列不入破位路径');
  const ladder = [main.low, ...extension.map((e) => e.price), ...extreme.map((e) => e.price)];
  ladder.forEach((v, i) => { if (i) assert.ok(v < ladder[i - 1], `第 ${i} 档 ${v} 须深于上一档 ${ladder[i - 1]}`); });
  assert.ok(!extension.some((e) => e.price > main.low), '延伸不得比主目标浅（旧版 82128.91 浅于 80925.68）');
});

test('Z 浪叙述：等长位都在 trigger 之上时主目标只写破位档，不再标 Z=W=Y 等长', () => {
  const t = (hi) => renderPullbackNarrative({ level: { kind: 'minor', depthPct: 5, medianPct: 5 }, structureLine: 82510.37,
    zwaveTargets: zwaveProjection(87397 - 82708.96, 85250 - 82510.37, 82510.37, hi), combinationReading: null, subDegree: null }, 2)
    .split('\n').find((l) => l.includes('Z 浪两条路'));
  const both = t(87249.43);
  assert.match(both, /主目标为破位档 \*\*81863\.82\*\*/);
  assert.doesNotMatch(both, /Z=W=Y 等长/);
  assert.match(t(85613.72), /主目标 \*\*80925\.68\*\* 一带（Z=W 等长/);
});
