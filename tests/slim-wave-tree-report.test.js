'use strict';

// slim-wave-tree-report：价位梯子、轴②已排除折叠、轴①同点位备选合并、调试信息只进 JSON / --verbose、
// 免责声明一次、简报顺延下一档。

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../analyze-wave-tree.js');

// BTC-USD 1h 2026-11-04 样例的最小树：W=78878.01→75736.38（末腿起点 77886.86），反弹高点 78164，现价 78462
function btc1hMiniTree() {
  const pts = [78878.01, 77886.86, 75736.38].map((price, i) => ({ price, index: i }));
  const h = E.bounceHypotheses(pts, null, 78164);
  const fibTargets = [0.382, 0.5, 0.618].map((m) => ({ mult: m, price: 78164 - (78164 - 75736.38) * m }));
  return {
    pricePrecision: 2,
    assessment: { bounceHyp: h, invalidation: 75736.38, structDir: 'down', nearTerm: null },
    inProgressStruct: { structUp: true, swingExtreme: { price: 78164, type: 'H' }, invalidation: 75736.38,
      pullback: { fibTargets, to: { price: 77748.09, type: 'L' } } },
  };
}
const META = { lastClose: 78462, rangeHigh: 78878.01, rangeLow: 75736.38 };

test('价位梯子：窗口高点即 X 上限、现价档写回撤 W 比例、降序且同价只一行', () => {
  const lv = E.collectPriceLevels(btc1hMiniTree(), META);
  const top = lv.find((l) => l.price === 78878.01);
  assert.ok(top.tags.some((t) => /^X 上限/.test(t)), 'X 上限');
  assert.ok(top.tags.includes('窗口最高'));
  const now = lv.find((l) => l.now);
  assert.equal(now.price, 78462);
  assert.match(now.tags[0], /反弹已回撤整段 W 的 87%/);
  for (let i = 1; i < lv.length; i += 1) assert.ok(lv[i - 1].price > lv[i].price, '严格降序');
  assert.equal(new Set(lv.map((l) => l.price)).size, lv.length, '同一价位只一行');
  // 0.03% 内合并：B 0.618 与 X 0.618 同为 77677.91 → 一档两个含义
  const shared = lv.find((l) => Math.abs(l.price - 77677.91) < 0.01);
  assert.ok(shared.tags.includes('X 0.618') && shared.tags.includes('B 0.618'));
  // 回撤 0.382（77236.65）不被 B 0.5（77307.2）吞掉
  assert.ok(lv.some((l) => Math.abs(l.price - 77236.65) < 0.01));
});

test('轴③：回撤梯度只在价位梯子出现一次，续行浪名为 Y，时间窗一次', () => {
  const tree = btc1hMiniTree();
  tree.assessment.fibTimeWindows = [{ ts: 1793790000, count: 6 }];
  const md = E.renderAxis3(tree, 2, META);
  assert.equal(md.split('| 77236.65 |').length - 1, 1);
  assert.doesNotMatch(md, /0\.382×→/);
  assert.match(md, /Y 浪（X 之后）/);
  assert.doesNotMatch(md, /Z 浪/);
  assert.equal(md.split('可能的转折时间窗').length - 1, 1);
  assert.doesNotMatch(md, /## 回撤目标位|## 通道参考|近端看/);
});

let golden;
function goldenTree() {
  if (!golden) {
    const candles = require('./fixtures/btc-usd-1d-golden.json').map((c, i) => ({ ...c, index: i }));
    golden = E.buildCountTree(E.anchorBoundaryExtremes(candles, E.detectPivots(candles, 1, {})), candles, { maxDepth: 5, beamK: 4 });
  }
  return golden;
}
const GMETA = { product: 'BTC-USD', timeframe: '1d', startUtc: '2025-10-05T00:00:00Z', endUtc: '2026-10-03T00:00:00Z',
  generatedAtUtc: '2026-10-04T00:00:00Z', sampleCount: 314, rangeHigh: 126296, rangeLow: 57717.55 };

test('轴①备选：框架与各腿点位相同的备选只占一行', () => {
  const md = E.renderMarkdownReport(GMETA, goldenTree());
  const sec = md.slice(md.indexOf('## 备选'), md.indexOf('\n\n', md.indexOf('|---|', md.indexOf('## 备选'))));
  const rows = sec.split('\n').filter((l) => /^\| 备选/.test(l)).map((l) => l.split(' | '));
  const keys = rows.map((c) => `${c[1]}|${c[3]}|${c[4]}`);
  assert.equal(new Set(keys).size, keys.length);
});

test('调试信息：默认 md 不含规则树/子浪证据/内部 id/开发备注，--verbose 恢复', () => {
  const tree = goldenTree();
  const md = E.renderMarkdownReport(GMETA, tree);
  for (const s of ['规则树与打分', '进行中结构（未确认）**', '子浪验证证据', '专章待补', '越界0.', 'corrective-no-triangle', 'impulse-strict', '约束出处']) {
    assert.ok(!md.includes(s), `默认 md 不应含「${s}」`);
  }
  const full = E.renderMarkdownReport(GMETA, tree, null, { verbose: true });
  assert.ok(full.includes('## 规则树与打分'));
  assert.ok(full.length > md.length);
});

test('免责声明全报告只一条', () => {
  const md = E.renderMarkdownReport({ ...GMETA, lastClose: 63000 }, goldenTree());
  assert.equal((md.match(/不构成买卖建议|非投资建议/g) || []).length, 1);
});

test('简报：上阻力已被站上时顺延到价位梯子前方一档', () => {
  const tree = goldenTree();
  const ext = tree.inProgressStruct.swingExtreme.price;
  const close = Math.round(ext * 1.02);
  const md = E.renderBrief({ ...GMETA, lastClose: close }, tree, { withTitle: false });
  const line = md.split('\n').find((l) => /上阻力\/突破/.test(l));
  assert.ok(line, '有上阻力行');
  assert.match(line, new RegExp(`${String(ext).replace('.', '\\.')} 已站上`));
  const next = Number(line.match(/上阻力\/突破：([0-9.]+)/)[1]);
  assert.ok(next > close, '顺延价在现价之上');
});
