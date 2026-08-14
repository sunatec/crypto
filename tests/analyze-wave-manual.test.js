'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeMeasures,
  makeJudge,
  evaluateManual,
  buildImpulseStrictManual,
  buildImpulseDiagonalManual,
  buildFlatManual,
  buildSingleZigzagManual,
  buildRegularFlatManual,
  buildExpandedFlatManual,
  buildRunningFlatManual,
  buildContractingTriangleManual,
  buildDoubleZigzagManual,
  buildDoubleSidewaysManual,
  legIsZigzagShaped,
  scanCandidates,
  scanPositionalCandidates,
  rankSurvivors,
  buildChannel,
  channelTypeFor,
  isImpulseFailure,
  fibRetracementForPattern,
  fibExtensionPoints,
  fibTimeResonance,
  scanAtDegree,
  countChildPivots,
  computeATR,
  detectPivots,
} = require('../analyze-wave-manual.js');

// ------------------------------------------------------------
// 辅助：从一串价格构造简单点位（按 3 根蜡烛等间距排布）与蜡烛
// ------------------------------------------------------------

function makePoints(prices, startType) {
  const types = [];
  let t = startType;
  for (let i = 0; i < prices.length; i += 1) {
    types.push(t);
    t = t === 'H' ? 'L' : 'H';
  }
  return prices.map((price, i) => ({
    index: i * 3,
    type: types[i],
    price,
    timestamp: 1700000000 + i * 3600,
  }));
}

/**
 * 用一组按 index 排序的锚点（{index, price}）线性插值构造蜡烛序列。
 * high=low=插值价格（无插针），可选传入 overshoot 在某根蜡烛上注入更极端的高/低，
 * 用于模拟「宏观枢轴之间藏着一次更深的插针」这种 price!=gross 场景。
 */
function makeCandlesFromAnchors(anchors, overshoot = null) {
  const sorted = anchors.slice().sort((a, b) => a.index - b.index);
  const maxIndex = sorted[sorted.length - 1].index;
  const candles = [];
  for (let i = 0; i <= maxIndex; i += 1) {
    candles.push({ timestamp: 1700000000 + i * 3600, timeUtc: '', open: 0, high: -Infinity, low: Infinity, close: 0, volume: 1 });
  }
  for (let seg = 0; seg < sorted.length - 1; seg += 1) {
    const a = sorted[seg];
    const b = sorted[seg + 1];
    for (let i = a.index; i <= b.index; i += 1) {
      const t = (i - a.index) / (b.index - a.index || 1);
      const price = a.price + (b.price - a.price) * t;
      candles[i].high = price;
      candles[i].low = price;
      candles[i].close = price;
    }
  }
  if (overshoot) {
    const { index, high, low } = overshoot;
    if (Number.isFinite(high)) candles[index].high = Math.max(candles[index].high, high);
    if (Number.isFinite(low)) candles[index].low = Math.min(candles[index].low, low);
  }
  return candles;
}

function makeCandlesFromPoints(points, overshoot = null) {
  return makeCandlesFromAnchors(points, overshoot);
}

// ------------------------------------------------------------
// wave-measurement: 价格 / 运行总量 / 价格运动百分比
// ------------------------------------------------------------

test('未衰竭推动浪：price 与 gross 相等', () => {
  // up impulse: 100→150(1浪)→120(2浪)→200(3浪)→170(4浪)→250(5浪，超过3浪终点200)
  const points = makePoints([100, 150, 120, 200, 170, 250], 'L');
  const candles = makeCandlesFromPoints(points);
  const m = computeMeasures(points, 'up', candles);
  assert.equal(m.price, 150); // 250 - 100
  assert.equal(m.gross, 150); // 250(最高) - 100(最低)
  assert.equal(m.price, m.gross);
});

test('5浪衰竭：price 小于 gross（gross 取1浪起点到3浪终点）', () => {
  // 同上但 5浪终点(180)未超过3浪终点(200) → 衰竭
  const points = makePoints([100, 150, 120, 200, 170, 180], 'L');
  const candles = makeCandlesFromPoints(points);
  const m = computeMeasures(points, 'up', candles);
  assert.equal(m.price, 80); // 180 - 100
  assert.equal(m.gross, 100); // 200(最高，3浪终点) - 100(最低)
  assert.ok(m.price < m.gross);
});

test('单腿且起终点即极值时：price 严格等于 gross', () => {
  const points = makePoints([100, 200], 'L');
  const candles = makeCandlesFromPoints(points);
  const m = computeMeasures(points, 'up', candles);
  assert.equal(m.price, 100);
  assert.equal(m.gross, 100);
});

// ------------------------------------------------------------
// 比率判据必须声明基准；平台形用 gross，单锯齿用 price
// ------------------------------------------------------------

test('平台形 b 浪 70% 回撤规则使用 gross 基准', () => {
  const manual = buildFlatManual('up', { pivotsFine: [] });
  const rule = manual.rules.find((r) => r.id === 'flat.ratio.b-gross-at-least-70pct-of-a');
  assert.equal(rule.basis, 'gross');
});

test('单锯齿 a>=b>=0.2a 规则使用 price 基准', () => {
  const manual = buildSingleZigzagManual('up', { pivotsFine: [] });
  const rule = manual.rules.find((r) => r.id === 'zigzag.ratio.b-price-between-0.2a-and-a');
  assert.equal(rule.basis, 'price');
});

// ------------------------------------------------------------
// wave-verification-manual: 否定法（先淘汰后排名）
// ------------------------------------------------------------

test('破坏一条规则即淘汰，即使所有指引都命中', () => {
  const manual = {
    patternType: 'synthetic',
    direction: 'up',
    rules: [makeJudge('r1', 'pattern', '规则1：必须为真', () => false)],
    guidelines: [
      makeJudge('g1', 'pattern', '指引1', () => true),
      makeJudge('g2', 'pattern', '指引2', () => true),
    ],
  };
  const result = evaluateManual({}, manual);
  assert.equal(result.survived, false);
  assert.equal(result.failedRule.id, 'r1');
});

test('全部规则通过时，候选幸存并计算指引得分', () => {
  const manual = {
    patternType: 'synthetic',
    direction: 'up',
    rules: [makeJudge('r1', 'pattern', '规则1', () => true)],
    guidelines: [
      makeJudge('g1', 'pattern', '指引1', () => true),
      makeJudge('g2', 'pattern', '指引2', () => false),
    ],
  };
  const result = evaluateManual({}, manual);
  assert.equal(result.survived, true);
  assert.equal(result.guidelineScore, 1);
  assert.equal(result.hits.length, 1);
});

test('规则按 pattern→ratio→time 顺序求值，首个失败即返回', () => {
  const order = [];
  const manual = {
    patternType: 'synthetic',
    direction: 'up',
    rules: [
      makeJudge('time-rule', 'time', 'T', () => { order.push('time'); return true; }),
      makeJudge('pattern-rule', 'pattern', 'P', () => { order.push('pattern'); return false; }),
      makeJudge('ratio-rule', 'ratio', 'R', () => { order.push('ratio'); return true; }),
    ],
    guidelines: [],
  };
  const result = evaluateManual({}, manual);
  assert.deepEqual(order, ['pattern']); // pattern 层先测试，失败后不再测试 ratio/time
  assert.equal(result.failedRule.id, 'pattern-rule');
});

// ------------------------------------------------------------
// wave-taxonomy: 推动浪
// ------------------------------------------------------------

test('标准推动浪：4浪切入1浪则淘汰，但楔形变体可幸存', () => {
  // up: p0=100 p1=200(1浪) p2=150(2浪) p3=230(3浪) p4=180(4浪，跌破1浪终点200，落入2/1之间)  p5=250(5浪)
  const points = makePoints([100, 200, 150, 230, 180, 250], 'L');
  const candles = makeCandlesFromPoints(points);
  const measures = computeMeasures(points, 'up', candles);
  const ctx = { points, direction: 'up', candles, measures };

  const strict = evaluateManual(ctx, buildImpulseStrictManual('up'));
  assert.equal(strict.survived, false);
  assert.equal(strict.failedRule.id, 'impulse.pattern.wave4-not-cross-wave1');

  const diagonal = evaluateManual(ctx, buildImpulseDiagonalManual('up'));
  assert.equal(diagonal.survived, true, `diagonal 应幸存，实际淘汰原因: ${diagonal.failedRule?.id}`);
});

test('推动浪：3浪最短则淘汰', () => {
  // w1=100(100->200) w3=35(170->205，故意最短) w5=58(202->260)
  const points = makePoints([100, 200, 170, 205, 202, 260], 'L');
  const candles = makeCandlesFromPoints(points);
  const measures = computeMeasures(points, 'up', candles);
  const ctx = { points, direction: 'up', candles, measures };
  const result = evaluateManual(ctx, buildImpulseStrictManual('up'));
  assert.equal(result.survived, false);
  assert.equal(result.failedRule.id, 'impulse.pattern.wave3-not-shortest');
});

// ------------------------------------------------------------
// wave-taxonomy: 单锯齿（需要细粒度枢轴支撑 a/c 浪的"驱动浪形态"判定）
// ------------------------------------------------------------

test('单锯齿：b浪内部插针跌破a浪起点则淘汰（gross 基准，即使 price 比率已通过）', () => {
  // 宏观4点：p0=100(idx0) p1=200(idx60,a浪) p2=150(idx90,b浪，价格比率0.5正常) p3=210(idx150,c浪)
  const p0 = { index: 0, type: 'L', price: 100 };
  const p1 = { index: 60, type: 'H', price: 200 };
  const p2 = { index: 90, type: 'L', price: 150 };
  const p3 = { index: 150, type: 'H', price: 210 };
  const points = [p0, p1, p2, p3];

  // a浪内部细节：5段交替摆动，呈驱动浪形态
  const aLegFine = [
    { index: 0, type: 'L', price: 100 },
    { index: 10, type: 'H', price: 130 },
    { index: 20, type: 'L', price: 115 },
    { index: 30, type: 'H', price: 160 },
    { index: 40, type: 'L', price: 140 },
    { index: 60, type: 'H', price: 200 },
  ];
  // c浪内部细节：一个真正合法的 5 浪推动浪（低点递增、4浪不切入1浪终点）
  const cLegFine = [
    { index: 90, type: 'L', price: 150 },  // w1 起
    { index: 100, type: 'H', price: 172 }, // w1=22
    { index: 110, type: 'L', price: 161 }, // w2=11（回撤0.5）
    { index: 120, type: 'H', price: 200 }, // w3=39（>1浪终点172）
    { index: 130, type: 'L', price: 182 }, // w4=18（182>172，未切入1浪；低点150<161<182递增）
    { index: 150, type: 'H', price: 210 }, // w5=28
  ];
  const pivotsFine = [...aLegFine, ...cLegFine];

  // 蜡烛：在 a/c 浪细节锚点之上，于 b 浪区间(idx60~90)注入一次插针到 90（跌破 a 浪起点100），
  // 但 b 浪的宏观终点 p2 仍是 150（价格比率 0.5，正常），插针不体现为正式枢轴。
  const candles = makeCandlesFromAnchors([...aLegFine, ...cLegFine], { index: 75, low: 90 });

  const measures = computeMeasures(points, 'up', candles);
  const ctx = { points, direction: 'up', candles, measures };
  const manual = buildSingleZigzagManual('up', { pivotsFine });

  // 先确认价格比率规则（先于 gross 规则）本身是通过的
  const priceRule = manual.rules.find((r) => r.id === 'zigzag.ratio.b-price-between-0.2a-and-a');
  assert.equal(priceRule.test(ctx), true, 'b/a 价格比率应通过（0.5 在 [0.2,1.0] 内）');

  const result = evaluateManual(ctx, manual);
  assert.equal(result.survived, false);
  assert.equal(result.failedRule.id, 'zigzag.ratio.b-not-break-a-start');
});

// ------------------------------------------------------------
// wave-taxonomy: 平台形（基础版）
// ------------------------------------------------------------

test('平台形：b浪回撤不足a浪运行总量70%则淘汰', () => {
  // a: 100(idx0)->150(idx30) gross=50；b: 150->140(idx60) gross=10，回撤仅20% < 70%
  const p0 = { index: 0, type: 'L', price: 100 };
  const p1 = { index: 30, type: 'H', price: 150 };
  const p2 = { index: 60, type: 'L', price: 140 };
  const p3 = { index: 120, type: 'H', price: 200 };
  const points = [p0, p1, p2, p3];

  // c浪内部细节：呈驱动浪形态，让 c-is-driving 规则先行通过
  const cLegFine = [
    { index: 60, type: 'L', price: 140 },
    { index: 70, type: 'H', price: 160 },
    { index: 80, type: 'L', price: 150 },
    { index: 90, type: 'H', price: 180 },
    { index: 100, type: 'L', price: 165 },
    { index: 120, type: 'H', price: 200 },
  ];
  const pivotsFine = cLegFine;
  const candles = makeCandlesFromAnchors([p0, p1, ...cLegFine]);

  const measures = computeMeasures(points, 'up', candles);
  const ctx = { points, direction: 'up', candles, measures };
  const manual = buildFlatManual('up', { pivotsFine });

  const result = evaluateManual(ctx, manual);
  assert.equal(result.survived, false);
  assert.equal(result.failedRule.id, 'flat.ratio.b-gross-at-least-70pct-of-a');
});

// ------------------------------------------------------------
// 排名：guidelineScore desc, endIndex desc
// ------------------------------------------------------------

test('rankSurvivors 按指引得分降序，再按结束位置降序排列', () => {
  const survivors = [
    { endIndex: 10, evalResult: { guidelineScore: 2 } },
    { endIndex: 20, evalResult: { guidelineScore: 3 } },
    { endIndex: 15, evalResult: { guidelineScore: 3 } },
  ];
  const ranked = rankSurvivors(survivors);
  assert.deepEqual(ranked.map((r) => r.endIndex), [20, 15, 10]);
});

// ------------------------------------------------------------
// 端到端：候选扫描能识别一个清晰的推动浪
// ------------------------------------------------------------

test('scanCandidates 端到端识别一段标准上涨推动浪为幸存候选', () => {
  const points = makePoints([100, 150, 120, 200, 170, 260], 'L');
  const candles = makeCandlesFromPoints(points);
  const { survivors } = scanCandidates(points, candles, { pivotsFine: points });
  const impulseHit = survivors.find((c) => c.patternType === 'impulse' && c.mode === 'strict');
  assert.ok(impulseHit, '应识别出标准推动浪候选');
});

// ==============================================================
// P2: 平台形三子类
// ==============================================================

test('规则平台形：b浪运行总量=a浪70%时幸存；同一候选下扩散平台形因b比率不足被淘汰', () => {
  const p0 = { index: 0, type: 'L', price: 100 };
  const p1 = { index: 30, type: 'H', price: 200 };
  const p2 = { index: 60, type: 'L', price: 130 }; // b.gross = 70 = 70% of a.gross(100)
  const p3 = { index: 120, type: 'H', price: 195 };
  const points = [p0, p1, p2, p3];

  const cLegFine = [
    { index: 60, type: 'L', price: 130 },
    { index: 70, type: 'H', price: 150 },
    { index: 80, type: 'L', price: 140 },
    { index: 90, type: 'H', price: 170 },
    { index: 100, type: 'L', price: 155 },
    { index: 120, type: 'H', price: 195 },
  ];
  const pivotsFine = cLegFine;
  const candles = makeCandlesFromAnchors([p0, p1, ...cLegFine]);

  const measures = computeMeasures(points, 'up', candles);
  const ctx = { points, direction: 'up', candles, measures };

  const regular = evaluateManual(ctx, buildRegularFlatManual('up', { pivotsFine }));
  assert.equal(regular.survived, true, `regular应幸存，实际淘汰: ${regular.failedRule?.id}`);

  const expanded = evaluateManual(ctx, buildExpandedFlatManual('up', { pivotsFine }));
  assert.equal(expanded.survived, false);
  assert.equal(expanded.failedRule.id, 'flat-expanded.ratio.b-gross-1.0-to-2.0-of-a');
});

test('扩散平台形：b浪运行总量为a浪1.1倍、c浪超越a浪终点时幸存', () => {
  const p0 = { index: 0, type: 'L', price: 100 };
  const p1 = { index: 30, type: 'H', price: 200 };
  const p2 = { index: 60, type: 'L', price: 90 }; // b.gross = 110 = 1.1x a.gross(100)
  const p3 = { index: 120, type: 'H', price: 230 }; // 超过 a 浪终点 200
  const points = [p0, p1, p2, p3];

  const cLegFine = [
    { index: 60, type: 'L', price: 90 },
    { index: 70, type: 'H', price: 140 },
    { index: 80, type: 'L', price: 115 },
    { index: 90, type: 'H', price: 170 },
    { index: 100, type: 'L', price: 145 },
    { index: 120, type: 'H', price: 230 },
  ];
  const pivotsFine = cLegFine;
  const candles = makeCandlesFromAnchors([p0, p1, ...cLegFine]);

  const measures = computeMeasures(points, 'up', candles);
  const ctx = { points, direction: 'up', candles, measures };
  const result = evaluateManual(ctx, buildExpandedFlatManual('up', { pivotsFine }));
  assert.equal(result.survived, true, `扩散平台形应幸存，实际淘汰: ${result.failedRule?.id}`);
});

test('顺势平台形：b浪1.1倍、c浪不超a浪终点但重叠时幸存；标记为2浪位置则淘汰', () => {
  const p0 = { index: 0, type: 'L', price: 100 };
  const p1 = { index: 30, type: 'H', price: 200 };
  const p2 = { index: 60, type: 'L', price: 90 };
  const p3 = { index: 120, type: 'H', price: 180 }; // 未超过 a 浪终点 200，但与 a 浪重叠
  const points = [p0, p1, p2, p3];

  // c浪：一个真正合法的 5 浪推动浪（低点递增、4浪不切入1浪终点），终点 180 不超过 a 浪终点 200
  const cLegFine = [
    { index: 60, type: 'L', price: 90 },   // w1 起
    { index: 70, type: 'H', price: 118 },  // w1=28
    { index: 80, type: 'L', price: 104 },  // w2=14（回撤0.5）
    { index: 90, type: 'H', price: 150 },  // w3=46（>1浪终点118）
    { index: 100, type: 'L', price: 132 }, // w4=18（132>118，未切入1浪；低点90<104<132递增）
    { index: 120, type: 'H', price: 180 }, // w5=48
  ];
  const pivotsFine = cLegFine;
  const candles = makeCandlesFromAnchors([p0, p1, ...cLegFine]);

  const measures = computeMeasures(points, 'up', candles);
  const manual = buildRunningFlatManual('up', { pivotsFine });

  const ctxNoPosition = { points, direction: 'up', candles, measures };
  const resultNoPosition = evaluateManual(ctxNoPosition, manual);
  assert.equal(resultNoPosition.survived, true, `未知位置时应幸存，实际淘汰: ${resultNoPosition.failedRule?.id}`);

  const ctxWave2 = { ...ctxNoPosition, positionHint: 'wave2' };
  const resultWave2 = evaluateManual(ctxWave2, manual);
  assert.equal(resultWave2.survived, false);
  assert.equal(resultWave2.failedRule.id, 'flat-running.pattern.not-wave2-position');
});

// ==============================================================
// P2: 收缩三角形
// ==============================================================

test('收缩三角形：子浪振幅依次收敛时幸存；不收敛则淘汰', () => {
  const points = [
    { index: 0, type: 'L', price: 200 },
    { index: 10, type: 'H', price: 300 }, // w1=100
    { index: 20, type: 'L', price: 220 }, // w2=80
    { index: 30, type: 'H', price: 290 }, // w3=70 <= w1
    { index: 40, type: 'L', price: 230 }, // w4=60 <= w2
    { index: 50, type: 'H', price: 280 }, // w5=50 <= w3
  ];
  const candles = makeCandlesFromPoints(points);
  const measures = computeMeasures(points, 'up', candles);
  const ctx = { points, direction: 'up', candles, measures };

  const converging = evaluateManual(ctx, buildContractingTriangleManual('up', {}));
  assert.equal(converging.survived, true, `应幸存，实际淘汰: ${converging.failedRule?.id}`);

  const nonConvergingPoints = [
    points[0], points[1], points[2],
    { index: 30, type: 'H', price: 400 }, // w3 远大于 w1，破坏收敛
    points[4], points[5],
  ];
  const ncCandles = makeCandlesFromPoints(nonConvergingPoints);
  const ncMeasures = computeMeasures(nonConvergingPoints, 'up', ncCandles);
  const ncCtx = { points: nonConvergingPoints, direction: 'up', candles: ncCandles, measures: ncMeasures };
  const nonConverging = evaluateManual(ncCtx, buildContractingTriangleManual('up', {}));
  assert.equal(nonConverging.survived, false);
  assert.equal(nonConverging.failedRule.id, 'triangle.pattern.legs-converge');
});

test('收缩三角形作为4浪时，切入1浪终点则淘汰', () => {
  const points = [
    { index: 0, type: 'L', price: 200 },
    { index: 10, type: 'H', price: 300 },
    { index: 20, type: 'L', price: 220 }, // 三角形最低点 220
    { index: 30, type: 'H', price: 290 },
    { index: 40, type: 'L', price: 230 },
    { index: 50, type: 'H', price: 280 },
  ];
  const candles = makeCandlesFromPoints(points);
  const measures = computeMeasures(points, 'up', candles);
  const ctx = { points, direction: 'up', candles, measures };

  // 1浪终点(280) 高于三角形最低点(220) → 视为切入1浪，应淘汰
  const crossing = evaluateManual(ctx, buildContractingTriangleManual('up', {
    wave1Ref: { p0: { price: 150 }, p1: { price: 280 }, impulseDirection: 'up' },
  }));
  assert.equal(crossing.survived, false);
  assert.equal(crossing.failedRule.id, 'triangle.pattern.wave4-not-cross-wave1');

  // 1浪终点(150) 低于三角形全局最低点(p0=200) → 未切入，应幸存
  const notCrossing = evaluateManual(ctx, buildContractingTriangleManual('up', {
    wave1Ref: { p0: { price: 100 }, p1: { price: 150 }, impulseDirection: 'up' },
  }));
  assert.equal(notCrossing.survived, true, `应幸存，实际淘汰: ${notCrossing.failedRule?.id}`);
});

// ==============================================================
// P2: 锯齿类分级（双锯齿）
// ==============================================================

test('双锯齿：w/y腿自身须呈单锯齿形态，否则淘汰', () => {
  const p0 = { index: 0, type: 'L', price: 100 };
  const p1 = { index: 90, type: 'H', price: 250 };
  const p2 = { index: 120, type: 'L', price: 200 };
  const p3 = { index: 210, type: 'H', price: 340 };
  const points = [p0, p1, p2, p3];

  const wLegFine = [
    { index: 0, type: 'L', price: 100 },
    { index: 30, type: 'H', price: 180 },
    { index: 60, type: 'L', price: 150 }, // b不破a起点(100)
    { index: 90, type: 'H', price: 250 },
  ];
  const yLegFine = [
    { index: 120, type: 'L', price: 200 },
    { index: 150, type: 'H', price: 280 },
    { index: 180, type: 'L', price: 245 }, // b不破a起点(200)
    { index: 210, type: 'H', price: 340 },
  ];
  const pivotsFine = [...wLegFine, ...yLegFine];
  const candles = makeCandlesFromAnchors(pivotsFine);

  const measures = computeMeasures(points, 'up', candles);
  const ctx = { points, direction: 'up', candles, measures };

  const withFineDetail = evaluateManual(ctx, buildDoubleZigzagManual('up', { pivotsFine }));
  assert.equal(withFineDetail.survived, true, `应幸存，实际淘汰: ${withFineDetail.failedRule?.id}`);

  // 缺少细粒度枢轴时，w/y 腿退化为边界2点，不构成"单锯齿形态"，应淘汰
  const withoutFineDetail = evaluateManual(ctx, buildDoubleZigzagManual('up', { pivotsFine: [] }));
  assert.equal(withoutFineDetail.survived, false);
  assert.equal(withoutFineDetail.failedRule.id, 'zigzag-double.pattern.w-is-zigzag-shaped');
});

test('legIsZigzagShaped: 4点单锯齿形态判真，非4点或b破a起点判假', () => {
  const fine = [
    { index: 0, type: 'L', price: 100 },
    { index: 30, type: 'H', price: 180 },
    { index: 60, type: 'L', price: 150 },
    { index: 90, type: 'H', price: 250 },
  ];
  const candles = makeCandlesFromAnchors(fine);
  assert.equal(legIsZigzagShaped(fine, fine[0], fine[3], 'up', candles), true);

  const broken = [
    { index: 0, type: 'L', price: 100 },
    { index: 30, type: 'H', price: 180 },
    { index: 60, type: 'L', price: 90 }, // 跌破起点100
    { index: 90, type: 'H', price: 250 },
  ];
  const brokenCandles = makeCandlesFromAnchors(broken);
  assert.equal(legIsZigzagShaped(broken, broken[0], broken[3], 'up', brokenCandles), false);
});

// ==============================================================
// P2: 联合形（双重横向整理）
// ==============================================================

test('双重横向整理：x浪回撤w浪70%时幸存，回撤不足则淘汰', () => {
  const p0 = { index: 0, type: 'L', price: 100 };
  const p1 = { index: 30, type: 'H', price: 200 }; // w.gross = 100
  const p2 = { index: 60, type: 'L', price: 130 }; // x.gross = 70 = 70%
  const p3 = { index: 90, type: 'H', price: 210 };
  const points = [p0, p1, p2, p3];
  const candles = makeCandlesFromPoints(points);
  const measures = computeMeasures(points, 'up', candles);
  const ctx = { points, direction: 'up', candles, measures };

  const ok = evaluateManual(ctx, buildDoubleSidewaysManual('up', { pivotsFine: [] }));
  assert.equal(ok.survived, true, `应幸存，实际淘汰: ${ok.failedRule?.id}`);

  const shallowP2 = { index: 60, type: 'L', price: 170 }; // x.gross = 30，仅30%
  const shallowPoints = [p0, p1, shallowP2, p3];
  const shallowCandles = makeCandlesFromPoints(shallowPoints);
  const shallowMeasures = computeMeasures(shallowPoints, 'up', shallowCandles);
  const shallowCtx = { points: shallowPoints, direction: 'up', candles: shallowCandles, measures: shallowMeasures };
  const shallow = evaluateManual(shallowCtx, buildDoubleSidewaysManual('up', { pivotsFine: [] }));
  assert.equal(shallow.survived, false);
  assert.equal(shallow.failedRule.id, 'sideways-double.ratio.x-retrace-70pct-of-w');
});

// ==============================================================
// P2: 引导 vs 终结楔形（按位置区分）
// ==============================================================

test('楔形手册按 positionHint 输出引导/终结楔形标签', () => {
  const leading = buildImpulseDiagonalManual('up', 'leading');
  assert.equal(leading.mode, 'leading_diagonal');
  assert.match(leading.label, /引导楔形/);

  const ending = buildImpulseDiagonalManual('up', 'ending');
  assert.equal(ending.mode, 'ending_diagonal');
  assert.match(ending.label, /终结楔形/);

  const defaulted = buildImpulseDiagonalManual('up');
  assert.equal(defaulted.mode, 'ending_diagonal', '未传位置时默认按终结楔形处理');
});

// ==============================================================
// P2: 端到端——scanPositionalCandidates 能识别位置相关的修正浪
// ==============================================================

test('scanPositionalCandidates 返回结构完整的候选（幸存或淘汰均可解释）', () => {
  const points = makePoints([100, 150, 120, 200, 170, 260], 'L');
  const candles = makeCandlesFromPoints(points);
  const { survivors, eliminated } = scanPositionalCandidates(points, points, candles);
  // 细粒度枢轴与宏观枢轴相同（数据量小），多数位置候选会因缺少4点/6点细节而不生成；
  // 这里只验证函数在正常输入下不抛异常，且返回的两个数组结构合法。
  assert.ok(Array.isArray(survivors));
  assert.ok(Array.isArray(eliminated));
  for (const c of [...survivors, ...eliminated]) {
    assert.ok(c.evalResult, '每个候选都应带有 evalResult');
  }
});

// ==============================================================
// P3: 艾略特通道（wave-channels）
// ==============================================================

test('通道类型按浪型分派：推动浪=平行，楔形/三角=收缩，扩散平台=扩散', () => {
  assert.equal(channelTypeFor({ patternType: 'impulse', mode: 'strict' }), 'parallel');
  assert.equal(channelTypeFor({ patternType: 'impulse', mode: 'ending_diagonal' }), 'contracting');
  assert.equal(channelTypeFor({ patternType: 'triangle', mode: 'contracting' }), 'contracting');
  assert.equal(channelTypeFor({ patternType: 'flat', mode: 'expanded' }), 'expanding');
  assert.equal(channelTypeFor({ patternType: 'zigzag', mode: 'single' }), 'parallel');
});

test('单锯齿平行通道：连 0 与 b 为基线、过 a 作平行线', () => {
  // 0-a-b-c = p0..p3；up: p0=L, p1=H(a), p2=L(b), p3=H(c)
  const points = makePoints([100, 150, 120, 180], 'L');
  const candidate = { patternType: 'zigzag', mode: 'single', direction: 'up', points };
  const ch = buildChannel(candidate);
  assert.equal(ch.channelType, 'parallel');
  // 基线过 p0 与 p2
  assert.equal(ch.base.from, points[0]);
  assert.equal(ch.base.to, points[2]);
  // 平行线过 p1(a)，斜率与基线相同
  assert.equal(ch.rail.from, points[1]);
  assert.ok(Math.abs(ch.rail.slope - ch.base.slope) < 1e-9);
});

test('收缩三角形使用收缩通道：连 a、c 与 b、d', () => {
  const points = [
    { index: 0, type: 'L', price: 200 },
    { index: 10, type: 'H', price: 300 }, // a
    { index: 20, type: 'L', price: 220 }, // b
    { index: 30, type: 'H', price: 290 }, // c
    { index: 40, type: 'L', price: 230 }, // d
    { index: 50, type: 'H', price: 280 }, // e
  ];
  const ch = buildChannel({ patternType: 'triangle', mode: 'contracting', direction: 'up', points });
  assert.equal(ch.channelType, 'contracting');
  // rail = a-c (p1,p3), base = b-d (p2,p4)
  assert.equal(ch.rail.from, points[1]);
  assert.equal(ch.rail.to, points[3]);
  assert.equal(ch.base.from, points[2]);
  assert.equal(ch.base.to, points[4]);
});

// ==============================================================
// P3: 斐波那契取点（wave-fibonacci）
// ==============================================================

test('回撤取点：未衰竭推动浪取 0/5，衰竭取 0/3', () => {
  // 未衰竭：5浪终点(250)超过3浪终点(200)
  const healthy = makePoints([100, 150, 120, 200, 170, 250], 'L');
  const fr1 = fibRetracementForPattern({ patternType: 'impulse', mode: 'strict', direction: 'up', points: healthy });
  assert.equal(fr1.from, healthy[0]);
  assert.equal(fr1.to, healthy[5]);

  // 衰竭：5浪终点(180)未超过3浪终点(200)
  const failed = makePoints([100, 150, 120, 200, 170, 180], 'L');
  assert.equal(isImpulseFailure({ patternType: 'impulse', direction: 'up', points: failed }), true);
  const fr2 = fibRetracementForPattern({ patternType: 'impulse', mode: 'strict', direction: 'up', points: failed });
  assert.equal(fr2.from, failed[0]);
  assert.equal(fr2.to, failed[3], '衰竭时终点应取 3 浪终点');
});

test('扩展取点：预测5浪取 0/1/4；4浪为三角形时第3点取其 e 点', () => {
  const points = makePoints([100, 150, 120, 200, 170, 250], 'L');
  const ext = fibExtensionPoints({ patternType: 'impulse', mode: 'strict', direction: 'up', points }, 'wave5');
  assert.deepEqual(ext.points.map((p) => p.price), [100, 150, 170]); // p0,p1,p4

  const triangleE = { index: 999, type: 'L', price: 165 };
  const ext2 = fibExtensionPoints({ patternType: 'impulse', mode: 'strict', direction: 'up', points }, 'wave5', triangleE);
  assert.equal(ext2.points[2], triangleE, '中间浪为三角形时第3点取 e 点');
});

test('斐波那契时间共振：两枢轴序列日重合标为共振日', () => {
  // 枢轴A@index0，枢轴B@index26；A+34=34，B+8=34 → 第34根共振
  const pivots = [
    { index: 0, type: 'H', price: 100 },
    { index: 26, type: 'H', price: 90 },
  ];
  const res = fibTimeResonance(pivots, 100);
  const at34 = res.find((r) => r.bar === 34);
  assert.ok(at34, '第34根应为共振日');
  assert.equal(at34.sources.length, 2);
});

// ==============================================================
// P3: 级别体系（wave-degree）
// ==============================================================

test('countChildPivots 统计父跨度内更细级别的子枢轴数', () => {
  const parent = { startIndex: 10, endIndex: 40 };
  const finer = [
    { index: 5 }, { index: 12 }, { index: 20 }, { index: 33 }, { index: 40 }, { index: 55 },
  ];
  assert.equal(countChildPivots(parent, finer), 4); // 12,20,33,40（边界含入）
});

test('countChildPivots 含边界', () => {
  const parent = { startIndex: 10, endIndex: 40 };
  const finer = [{ index: 10 }, { index: 25 }, { index: 40 }];
  assert.equal(countChildPivots(parent, finer), 3);
});

test('scanAtDegree：更粗级别（更大lookback/atr倍数）产出更少的枢轴', () => {
  // 构造一段带大量小摆动 + 若干大摆动的合成序列
  const candles = [];
  const base = 1700000000;
  for (let i = 0; i < 200; i += 1) {
    const bigWave = Math.sin(i / 25) * 20000; // 大级别摆动
    const smallWave = Math.sin(i / 3) * 1500; // 小级别噪音
    const price = 60000 + bigWave + smallWave;
    candles.push({ timestamp: base + i * 86400, timeUtc: '', open: price, high: price + 200, low: price - 200, close: price, volume: 1 });
  }
  const atr = computeATR(candles, 14);
  const fine = detectPivots(candles, 1, {});
  const coarse = scanAtDegree(candles, { degree: 0, label: '0', lookbackMult: 4, atrMult: 3 }, 2, 1.5, atr, fine);
  const finer = scanAtDegree(candles, { degree: 2, label: '2', lookbackMult: 1, atrMult: 1 }, 2, 1.5, atr, fine);
  assert.ok(coarse.pivots.length <= finer.pivots.length, `粗级别枢轴(${coarse.pivots.length})应不多于细级别(${finer.pivots.length})`);
  // 候选都带 degree 标记
  for (const c of coarse.survivors) assert.equal(c.degree, 0);
});

// ==============================================================
// P4: legShape 子浪驱动/调整判定修正（fix-subwave-impulse-classification）
// ==============================================================

const { legShape, legHasValidImpulse, legHasOverlap } = require('../analyze-wave-manual.js');

test('legShape：长且重叠的复杂上行腿判为调整浪（即使 ≥6 枢轴）', () => {
  // 取自 BTC-USD 1d 真实反弹 80524→97963：9 个摆动、低点出现逆序(84400<87733)
  const leg = [
    { index: 0, type: 'L', price: 80525 },
    { index: 3, type: 'H', price: 93162 },
    { index: 6, type: 'L', price: 83800 },
    { index: 9, type: 'H', price: 94181 },
    { index: 12, type: 'L', price: 87733 },
    { index: 15, type: 'H', price: 94641 },
    { index: 18, type: 'L', price: 84400 }, // 更低的低点 → 重叠
    { index: 21, type: 'H', price: 94825 },
    { index: 24, type: 'L', price: 89200 },
    { index: 27, type: 'H', price: 97964 },
  ];
  assert.equal(leg.length >= 6, true);
  assert.equal(legHasOverlap(leg, 'up'), true, '存在更低的低点 → 重叠');
  const shape = legShape(leg, leg[0], leg[leg.length - 1], 'up');
  assert.equal(shape.impulseLike, false, '重叠复杂腿不应判为驱动浪');
});

test('legShape：干净五浪腿判为驱动浪', () => {
  const leg = [
    { index: 0, type: 'L', price: 100 },
    { index: 3, type: 'H', price: 150 },
    { index: 6, type: 'L', price: 120 },
    { index: 9, type: 'H', price: 200 },
    { index: 12, type: 'L', price: 170 },
    { index: 15, type: 'H', price: 250 },
  ];
  assert.equal(legHasOverlap(leg, 'up'), false, '低点递增，无重叠');
  assert.equal(legHasValidImpulse(leg, 'up'), true, '应能实证出合法推动浪');
  const shape = legShape(leg, leg[0], leg[leg.length - 1], 'up');
  assert.equal(shape.impulseLike, true);
});

test('legShape：等枢轴数下，五浪与复杂调整判定不同（不再靠计数）', () => {
  const clean = [
    { index: 0, type: 'L', price: 100 },
    { index: 3, type: 'H', price: 150 },
    { index: 6, type: 'L', price: 120 },
    { index: 9, type: 'H', price: 200 },
    { index: 12, type: 'L', price: 170 },
    { index: 15, type: 'H', price: 250 },
  ];
  const complex = [
    { index: 0, type: 'L', price: 100 },
    { index: 3, type: 'H', price: 150 },
    { index: 6, type: 'L', price: 120 },
    { index: 9, type: 'H', price: 180 },
    { index: 12, type: 'L', price: 110 }, // 更低的低点 → 重叠
    { index: 15, type: 'H', price: 200 },
  ];
  assert.equal(clean.length, complex.length, '两段枢轴数相同');
  const sClean = legShape(clean, clean[0], clean[5], 'up');
  const sComplex = legShape(complex, complex[0], complex[5], 'up');
  assert.equal(sClean.impulseLike, true);
  assert.equal(sComplex.impulseLike, false);
  assert.notEqual(sClean.impulseLike, sComplex.impulseLike, '枢轴数相同但判定不同');
});
