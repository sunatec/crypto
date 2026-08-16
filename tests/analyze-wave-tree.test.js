'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normRange,
  normGate,
  scoreCandidate,
  compareCandidates,
  selectBest,
  buildImpulseStrictManual,
  coarsenByPairs,
  segmentations,
  decompose,
  buildCountTree,
  crossDegreeHits,
  computeExpectation,
  triangleGross,
} = require('../analyze-wave-tree.js');

// 复用 manual 测试里的点构造思路：按 3 根蜡烛等间距排布
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

function ctxFor(points, direction) {
  return { points, direction };
}

// 由锚点线性插值构造 dense 蜡烛序列（high=low=插值价），与 manual 测试同法
function makeCandlesFromAnchors(anchors) {
  const sorted = anchors.slice().sort((a, b) => a.index - b.index);
  const maxIndex = sorted[sorted.length - 1].index;
  const candles = [];
  for (let i = 0; i <= maxIndex; i += 1) {
    candles.push({ timestamp: 1700000000 + i * 3600, open: 0, high: -Infinity, low: Infinity, close: 0, volume: 1, index: i });
  }
  for (let seg = 0; seg < sorted.length - 1; seg += 1) {
    const a = sorted[seg];
    const b = sorted[seg + 1];
    for (let i = a.index; i <= b.index; i += 1) {
      const t = (i - a.index) / ((b.index - a.index) || 1);
      const price = a.price + (b.price - a.price) * t;
      candles[i].high = price; candles[i].low = price; candles[i].close = price;
    }
  }
  return candles;
}

// 直接构造一串交替细枢轴（index 递增、类型交替）
function finePivots(seq) {
  return seq.map(([price, type], i) => ({ index: i * 3, type, price, timestamp: 1700000000 + i * 3600 }));
}

// ------------------------------------------------------------
// M2：切分（coarsenByPairs / segmentations）
// ------------------------------------------------------------

test('segmentations：点数恰等于目标 n 时原样返回', () => {
  const fine = finePivots([[100, 'L'], [150, 'H'], [120, 'L'], [200, 'H']]);
  const segs = segmentations(fine, 4);
  assert.equal(segs.length, 1);
  assert.deepEqual(segs[0].map((p) => p.price), [100, 150, 120, 200]);
});

test('coarsenByPairs：8→6 删掉最小振幅的内部相邻对，保端点与交替', () => {
  // 大摆动 100↑200↓150↑260，内嵌一个最小的 200↓190↑ 小摆动
  const fine = finePivots([
    [100, 'L'], [200, 'H'], [190, 'L'], [195, 'H'], [150, 'L'], [260, 'H'], [230, 'L'], [300, 'H'],
  ]);
  const out = coarsenByPairs(fine, 6);
  assert.equal(out.length, 6);
  assert.equal(out[0].price, 100); // 端点保留
  assert.equal(out[out.length - 1].price, 300);
  // 最小的 190→195 那对（振幅5）应被删掉
  assert.ok(!out.some((p) => p.price === 190 || p.price === 195));
  // 仍严格交替
  for (let i = 1; i < out.length; i += 1) assert.notEqual(out[i].type, out[i - 1].type);
});

// ------------------------------------------------------------
// M2：递归引擎——终止 / 文法 / 嵌套
// ------------------------------------------------------------

test('buildCountTree：干净上涨推动浪→impulse-strict 且 tier1=0，五腿皆末级', () => {
  const fine = finePivots([[100, 'L'], [150, 'H'], [120, 'L'], [200, 'H'], [170, 'L'], [250, 'H']]);
  const candles = makeCandlesFromAnchors(fine);
  const tree = buildCountTree(fine, candles, { maxDepth: 6 });
  assert.equal(tree.primary.patternId, 'impulse-strict');
  assert.equal(tree.primary.score.tier1, 0);
  assert.equal(tree.primary.children.length, 5);
  assert.ok(tree.primary.children.every((c) => c.isLeaf));
});

test('终止（Q7）：4点调整段在只允许 driving 时无法成形→叶子', () => {
  const fine = finePivots([[100, 'L'], [150, 'H'], [120, 'L'], [180, 'H']]);
  const candles = makeCandlesFromAnchors(fine);
  const node = decompose(fine, candles, ['driving'], 0, { beamK: 3, maxDepth: 6 });
  assert.equal(node.isLeaf, true); // driving 最小需 6 点，仅 4 点→末级
});

test('文法+嵌套：强制 corrective 解读，a/c 腿递归为 driving 推动浪，文法满足', () => {
  // 上涨单锯齿 a(100→200 干净5浪) - b(200→150) - c(150→260 干净5浪)
  const fine = finePivots([
    [100, 'L'], [140, 'H'], [115, 'L'], [175, 'H'], [150, 'L'], [200, 'H'], // a: 5浪
    [150, 'L'],                                                             // b_end
    [200, 'H'], [175, 'L'], [240, 'H'], [215, 'L'], [260, 'H'],            // c: 5浪
  ]);
  const candles = makeCandlesFromAnchors(fine);
  const node = decompose(fine, candles, ['corrective'], 0, { beamK: 3, maxDepth: 6 });

  assert.equal(node.isLeaf, false);
  assert.equal(node.primary.patternId, 'zigzag'); // 平台形 b 回撤不足70%被比下去
  assert.equal(node.primary.score.tier1, 0);      // 自身规则 + 文法均无违规
  assert.equal(node.primary.score.grammarViolations, 0);

  const [aChild, bChild, cChild] = node.primary.children;
  assert.equal(aChild.isLeaf, false, 'a腿应被递归拆解');
  assert.equal(aChild.primary.klass, 'driving');
  assert.equal(aChild.primary.score.tier1, 0);
  assert.equal(bChild.isLeaf, true, 'b腿仅2点→末级');
  assert.equal(cChild.isLeaf, false, 'c腿应被递归拆解');
  assert.equal(cChild.primary.klass, 'driving');
});

// ------------------------------------------------------------
// M3：tier4 跨级别指引 / 进行中浪 + 预期
// ------------------------------------------------------------

test('triangleGross（书3.16特例）：取最长子浪的高低差，而非整段高低差', () => {
  // a-b-c-d-e 收缩三角，最长子浪是 a（200→300，跨度100）；整段高低差=300-220=80
  const pts = finePivots([
    [200, 'L'], [300, 'H'], [220, 'L'], [290, 'H'], [230, 'L'], [280, 'H'],
  ]);
  const candles = makeCandlesFromAnchors(pts);
  const g = triangleGross(pts, candles);
  assert.equal(g, 100, '应等于最长子浪a的高低差100，而非整段的80');
});

test('crossDegreeHits：推动浪3浪最强→命中浪个性', () => {
  // w1=50, w3=80(最强), w5=50
  const points = finePivots([[100, 'L'], [150, 'H'], [120, 'L'], [200, 'H'], [170, 'L'], [220, 'H']]);
  const cand = { patternId: 'impulse-strict', points, children: [] };
  assert.ok(crossDegreeHits(cand) >= 1);
});

test('crossDegreeHits：3浪最短时不命中浪个性', () => {
  // w1=50, w3=30(最短), w5=58
  const points = finePivots([[100, 'L'], [150, 'H'], [170, 'L'], [200, 'H'], [202, 'L'], [260, 'H']]);
  const cand = { patternId: 'impulse-strict', points, children: [] };
  assert.equal(crossDegreeHits(cand), 0);
});

test('computeExpectation：给出末腿方向与斐波完成区间，标注推断', () => {
  const points = finePivots([[100, 'L'], [150, 'H'], [120, 'L'], [200, 'H'], [170, 'L'], [230, 'H']]);
  const exp = computeExpectation({ points }, 5); // 末腿 = 第5腿 170→230(up)
  assert.equal(exp.currentLegDir, 'up');
  assert.equal(exp.note, '推断，非确定');
  assert.equal(exp.fibTargets.length, 3);
  // 参考浪=w1(50)，0.618×从170起 → 170+30.9
  assert.ok(Math.abs(exp.fibTargets[0].price - (170 + 0.618 * 50)) < 1e-6);
});

test('进行中浪：末点带 provisional → 主链末腿标进行中并附预期', () => {
  // 干净上涨推动浪，末点标 provisional（模拟进行中的第5浪）
  const fine = finePivots([[100, 'L'], [150, 'H'], [120, 'L'], [200, 'H'], [170, 'L'], [250, 'H']]);
  fine[fine.length - 1].provisional = true;
  const candles = makeCandlesFromAnchors(fine);
  const tree = buildCountTree(fine, candles, { maxDepth: 6, trimTop: false });
  assert.equal(tree.primary.status, '进行中');
  assert.equal(tree.primary.currentWave, 5);
  assert.equal(tree.primary.totalWaves, 5);
  assert.ok(tree.primary.expectation, '应附完成区间预期');
  assert.equal(tree.primary.expectation.note, '推断，非确定');
});

test('顶层进行中腿：provisional 末点与起点同型被方向裁剪时，单独挂出在建腿', () => {
  // 下跌推动浪 200→100，末尾追加一个 provisional 高点 110（与起点 200 同为 H）
  const fine = finePivots([
    [200, 'H'], [160, 'L'], [175, 'H'], [120, 'L'], [140, 'H'], [100, 'L'],
  ]);
  fine.push({ index: 18, type: 'H', price: 110, timestamp: 1700000000 + 18 * 3600, provisional: true, boundary: 'end' });
  const candles = makeCandlesFromAnchors(fine);
  const tree = buildCountTree(fine, candles, { maxDepth: 6 });
  assert.ok(tree.inProgress, '应挂出顶层进行中腿');
  assert.equal(tree.inProgress.currentLegDir, 'up'); // 100→110 反向上行
  assert.equal(tree.inProgress.from.price, 100);
  assert.equal(tree.inProgress.to.price, 110);
  assert.equal(tree.inProgress.note, '推断，非确定');
});

test('已完成结构：末点无 provisional → 标完成、无预期', () => {
  const fine = finePivots([[100, 'L'], [150, 'H'], [120, 'L'], [200, 'H'], [170, 'L'], [250, 'H']]);
  const candles = makeCandlesFromAnchors(fine);
  const tree = buildCountTree(fine, candles, { maxDepth: 6, trimTop: false });
  assert.equal(tree.primary.status, '完成');
  assert.equal(tree.primary.expectation, undefined);
});

// ------------------------------------------------------------
// 判据契约：overshoot 归一化
// ------------------------------------------------------------

test('normRange：区间内 pass 且 overshoot=0', () => {
  const r = normRange(0.5, 0.236, 0.886);
  assert.equal(r.pass, true);
  assert.equal(r.overshoot, 0);
});

test('normRange：低于下界，overshoot=(lo-r)/宽度', () => {
  const r = normRange(0.1, 0.236, 0.886);
  assert.equal(r.pass, false);
  assert.ok(Math.abs(r.overshoot - (0.236 - 0.1) / (0.886 - 0.236)) < 1e-9);
});

test('normRange：高于上界，overshoot=(r-hi)/宽度', () => {
  const r = normRange(5.0, 1.0, 4.236);
  assert.equal(r.pass, false);
  assert.ok(Math.abs(r.overshoot - (5.0 - 4.236) / (4.236 - 1.0)) < 1e-9);
});

test('normRange：单侧(hi=Infinity)按阈值归一化', () => {
  const r = normRange(0.5, 1.0, Infinity);
  assert.equal(r.pass, false);
  assert.ok(Math.abs(r.overshoot - (1.0 - 0.5) / 1.0) < 1e-9);
});

test('normRange：null/NaN 视为最差 overshoot=1', () => {
  assert.equal(normRange(null, 0, 1).overshoot, 1);
  assert.equal(normRange(NaN, 0, 1).overshoot, 1);
});

test('normGate：pass→overshoot=0；fail→|margin|/ref', () => {
  assert.deepEqual(normGate(true, 999, 100), { pass: true, overshoot: 0 });
  const f = normGate(false, 30, 100);
  assert.equal(f.pass, false);
  assert.ok(Math.abs(f.overshoot - 0.3) < 1e-9);
});

// ------------------------------------------------------------
// 拟合分：分层字典序
// ------------------------------------------------------------

test('干净推动浪：全过规则，tier1=0、tier2=0', () => {
  const points = makePoints([100, 150, 120, 200, 170, 250], 'L');
  const s = scoreCandidate(ctxFor(points, 'up'), buildImpulseStrictManual('up'));
  assert.equal(s.tier1, 0);
  assert.equal(s.tier2, 0);
  assert.equal(s.penalized, false);
});

test('4浪切入1浪：违反 wave4 规则，tier1≥1 且 penalized', () => {
  // p4=180 跌破 1浪终点(200) → 切入
  const points = makePoints([100, 200, 150, 230, 180, 250], 'L');
  const s = scoreCandidate(ctxFor(points, 'up'), buildImpulseStrictManual('up'));
  assert.ok(s.tier1 >= 1);
  assert.equal(s.penalized, true);
  assert.ok(s.failed.some((f) => f.id === 'impulse.pattern.wave4-not-cross-wave1'));
  assert.ok(s.failed.find((f) => f.id === 'impulse.pattern.wave4-not-cross-wave1').overshoot > 0);
});

test('compareCandidates：违规更少者优先，与指引无关', () => {
  const clean = { tier1: 0, tier2: 0, tier3: 0.9, tier4: 0 };
  const dirty = { tier1: 1, tier2: 0.01, tier3: 0.0, tier4: 3 };
  const sorted = [dirty, clean].sort(compareCandidates);
  assert.equal(sorted[0], clean);
});

test('compareCandidates：tier1/2 相同时按指引未命中率，再按跨级别命中降序', () => {
  const a = { tier1: 0, tier2: 0, tier3: 0.5, tier4: 1 };
  const b = { tier1: 0, tier2: 0, tier3: 0.2, tier4: 0 };
  const c = { tier1: 0, tier2: 0, tier3: 0.2, tier4: 2 };
  const sorted = [a, b, c].sort(compareCandidates);
  assert.deepEqual(sorted, [c, b, a]); // tier3 更低的 b/c 在前；其中 tier4 更高的 c 最前
});

test('selectBest：无人全过规则时，主选为最轻违规者且 penalized（优雅降级）', () => {
  const scored = [
    { tier1: 2, tier2: 0.5, tier3: 0.1, tier4: 0, penalized: true },
    { tier1: 1, tier2: 0.2, tier3: 0.9, tier4: 0, penalized: true },
    { tier1: 1, tier2: 0.4, tier3: 0.0, tier4: 0, penalized: true },
  ];
  const { primary, alternates } = selectBest(scored, 3);
  assert.equal(primary.tier1, 1);
  assert.equal(primary.tier2, 0.2); // 同 tier1 下越界更小者
  assert.equal(primary.penalized, true);
  assert.equal(alternates.length, 2);
});

test('selectBest：存在全过者时不选降级候选', () => {
  const scored = [
    { tier1: 1, tier2: 0.2, tier3: 0.0, tier4: 5, penalized: true },
    { tier1: 0, tier2: 0.0, tier3: 0.8, tier4: 0, penalized: false },
  ];
  const { primary } = selectBest(scored, 3);
  assert.equal(primary.tier1, 0);
  assert.equal(primary.penalized, false);
});
