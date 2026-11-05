'use strict';

// 末浪延伸排除：模板角色宽松（楔形各浪为泛化"调整浪"）时，按本数法对末腿的实际细分判定起点约束。
// 楔形第5浪 82850→57800.19 细分为单锯齿，极值后反弹到 87395.67 已越过 82850 → 不得残留"末浪进行中"读法。
// 另：「已排除」与「对侧点位」两条附注默认不进 md，只在 --verbose 下输出。

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../analyze-wave-tree.js');

const FIX = require('./fixtures/btcusdt-1d-20251005-20261104.json');
const candles = FIX.candles.map((c, i) => ({ ...c, index: i }));

let cached;
function run() {
  if (cached) return cached;
  const fine = E.anchorBoundaryExtremes(candles, E.detectPivots(candles, 1, {}));
  const tree = E.buildCountTree(fine, candles, { maxDepth: 5, beamK: 4, pricePrecision: 2 });
  cached = { fine, tree };
  return cached;
}

test('楔形末腿细分为单锯齿：越过末腿起点即排除末浪延伸读法', () => {
  const { tree } = run();
  const ex = tree.counterTrendExcluded || [];
  const diag = ex.find((e) => e.patternId === 'diagonal-leading' && e.finalLegFrom === 82850);
  assert.ok(diag, '楔形（第5浪起点 82850）应在已排除列表中');
  assert.ok(diag.counterExtreme > 82850);
  const rc = E.serializeRankedCounts(tree) || [];
  const leftover = rc.filter((c) => c.finalWaveInProgress && c.finalLegFrom && c.finalLegFrom.price < diag.counterExtreme);
  assert.deepEqual(leftover.map((c) => c.label), [], '末腿起点已被越过的"末浪进行中"读法不应残留在排名表');
});

test('「末浪延伸读法已排除」附注默认不进 md，--verbose 下保留', () => {
  const { tree } = run();
  const md = E.renderRankedCounts(tree, 2, [], null);
  assert.ok(!md.includes('末浪延伸读法已排除'));
  const mdV = E.renderRankedCounts(tree, 2, [], null, { verbose: true });
  assert.ok(mdV.includes('末浪延伸读法已排除'));
});
