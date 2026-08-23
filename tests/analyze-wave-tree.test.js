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
  significanceRank,
  significantShortlist,
  indexCombinations,
  computeIncompleteness,
  legProportionViolated,
  directionalSpanToNow,
  directionalTopSpan,
  buildCounterTrendFrameworkB,
  macroAlternates,
  grammarViolatesRole,
  legEndpointsSpanExtreme,
  candidateViolations,
  strengthTier,
  renderStructuredReport,
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
  // 限定 allowedRoles=['driving']：本测试验证的是「impulse-strict 自身的拆解是否正确」，
  // 与「它是否压过其它 corrective 读法（如跳过中间摆动的紧凑锯齿）」无关——后者是
  // rank-competing-wave-counts 搜索补全后的合法竞争结果，同一组数据现在可能同时存在
  // 多种零违规读法（详见该 change 的 tasks.md 3.7 一节），不是这里要测的东西。
  const node = decompose(fine, candles, ['driving'], 0, { beamK: 3, maxDepth: 6, cache: new Map() });
  assert.equal(node.primary.patternId, 'impulse-strict');
  assert.equal(node.primary.score.tier1, 0);
  assert.equal(node.primary.children.length, 5);
  assert.ok(node.primary.children.every((c) => c.isLeaf));
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
  // beamK 调大到 10（而非 3）：搜索补全后，同一组数据里跳过中间摆动的紧凑锯齿读法
  // （如 100→175→150→260）也会零违规、且按指引命中数排到 primary——那是合法的
  // 搜索完整性效果（见 rank-competing-wave-counts），不是本测试要验证的东西。本测试
  // 验证的是「a(100→200 完整5浪)-b-c(150→260 完整5浪) 这个具体读法本身，其 a/c 腿
  // 能否正确递归拆解成 driving 子结构、文法零违规」——故直接在候选池里定位这个具体
  // 读法来断言，而不假设它必然是 primary。
  const node = decompose(fine, candles, ['corrective'], 0, { beamK: 10, maxDepth: 6, cache: new Map() });
  assert.equal(node.isLeaf, false);

  const all = [node.primary, ...(node.alternates || [])];
  const target = all.find((c) => c.points.length === 4
    && Math.abs(c.points[0].price - 100) < 1e-6 && Math.abs(c.points[1].price - 200) < 1e-6
    && Math.abs(c.points[2].price - 150) < 1e-6 && Math.abs(c.points[3].price - 260) < 1e-6);
  assert.ok(target, '候选池里应能找到 a(100→200)-b(→150)-c(→260) 这个完整读法');
  assert.equal(target.patternId, 'zigzag'); // 平台形 b 回撤不足70%被比下去
  assert.equal(target.score.tier1, 0);      // 自身规则 + 文法均无违规
  assert.equal(target.score.grammarViolations, 0);

  const [aChild, bChild, cChild] = target.children;
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
  // 6 点数据，末点标 provisional（模拟末腿仍在进行中）。搜索补全后（见
  // rank-competing-wave-counts）这组数据的顶层竞争 primary 是零违规的单锯齿
  // （3腿：a/b/c），而非直觉上的5浪推动——两者对同一组价格都合法零违规，
  // 引擎按指引命中数选出前者，与本测试要验证的「provisional 标注机制」无关，
  // 故按当前真实 primary 断言腿数，而非依赖它是哪种具体形态。
  const fine = finePivots([[100, 'L'], [150, 'H'], [120, 'L'], [200, 'H'], [170, 'L'], [250, 'H']]);
  fine[fine.length - 1].provisional = true;
  const candles = makeCandlesFromAnchors(fine);
  const tree = buildCountTree(fine, candles, { maxDepth: 6, trimTop: false });
  const expectedLegs = tree.primary.points.length - 1;
  assert.equal(tree.primary.status, '进行中');
  assert.equal(tree.primary.currentWave, expectedLegs);
  assert.equal(tree.primary.totalWaves, expectedLegs);
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

// ------------------------------------------------------------
// rank-competing-wave-counts：搜索补全 / 在建打分 / 腿间比例闸门
// ------------------------------------------------------------

test('significantShortlist：拓扑存活序——两个大摆动挤掉夹在中间的小噪音', () => {
  // 两个巨大摆动(500高、50低)之间夹了两对几乎贴着彼此的小噪音枢轴(498/499/497/498.5)
  const fine = finePivots([
    [100, 'L'], [500, 'H'], [498, 'L'], [499, 'H'], [497, 'L'], [498.5, 'H'], [50, 'L'], [496, 'H'],
  ]);
  const sl = significantShortlist(fine, 2);
  const prices = sl.map((i) => fine[i].price);
  assert.deepEqual(prices.slice().sort((a, b) => a - b), [50, 500], '短名单应恰好是两个大摆动，挤掉中间小噪音');
});

test('indexCombinations：保持相对顺序、恰选 k 个的所有组合', () => {
  assert.deepEqual(indexCombinations([10, 20, 30], 2), [[10, 20], [10, 30], [20, 30]]);
  assert.deepEqual(indexCombinations([1, 2], 0), [[]]);
  assert.deepEqual(indexCombinations([1], 2), []); // k > n 时无解
});

test('computeIncompleteness：末点非provisional恒为0；provisional按末腿完成度估计', () => {
  const done = finePivots([[100, 'L'], [150, 'H'], [120, 'L'], [200, 'H']]);
  assert.equal(computeIncompleteness(done), 0);

  const justStarted = finePivots([[100, 'L'], [150, 'H'], [120, 'L'], [121, 'H']]);
  justStarted[3].provisional = true; // 末腿仅走1，参考腿(前段最大)50 —— 几乎没走
  assert.ok(computeIncompleteness(justStarted) > 0.9, '刚起步的末腿惩罚应接近1');

  const nearlyDone = finePivots([[100, 'L'], [150, 'H'], [120, 'L'], [175, 'H']]);
  nearlyDone[3].provisional = true; // 末腿55，已超过参考腿50
  assert.equal(computeIncompleteness(nearlyDone), 0, '末腿已达/超过参考腿量级，惩罚应为0');
});

test('legProportionViolated：腿间比例闸门——畸长腿判真，均衡腿判假', () => {
  const balanced = finePivots([[100, 'L'], [150, 'H'], [120, 'L'], [170, 'H']]); // 50,30,50
  assert.equal(legProportionViolated(balanced), false);

  const skewed = finePivots([[100, 'L'], [150, 'H'], [145, 'L'], [500, 'H']]); // 50,5,355 → 比71
  assert.equal(legProportionViolated(skewed), true);

  const singleLeg = finePivots([[100, 'L'], [200, 'H']]); // 只一条腿，无兄弟浪可比
  assert.equal(legProportionViolated(singleLeg), false);
});

test('directionalSpanToNow：起点同框架A，终点延伸到最后一个细枢轴而非另一极值', () => {
  const fine = finePivots([[100, 'L'], [300, 'H'], [50, 'L'], [200, 'H'], [150, 'L']]);
  const a = directionalTopSpan(fine);
  const b = directionalSpanToNow(fine);
  assert.deepEqual(a.map((p) => p.price), [300, 50]); // A：全局高→全局低，止步于此
  assert.deepEqual(b.map((p) => p.price), [300, 50, 200, 150]); // B：同起点，延伸到now
  assert.equal(a[0].price, b[0].price, '两框架起点应相同');
});

test('框架B端到端：解开焊死后，全局低点之后的走势能被纳入更高级别的在建候选', () => {
  // 126→100→110→57(全局低，框架A止于此)→90→62(provisional，仍高于57、故57仍是全局低)
  const fine = finePivots([[126, 'H'], [100, 'L'], [110, 'H'], [57, 'L'], [90, 'H'], [62, 'L']]);
  fine[fine.length - 1].provisional = true;
  const candles = makeCandlesFromAnchors(fine);
  const tree = buildCountTree(fine, candles, { maxDepth: 5, beamK: 4 });
  assert.equal(tree.primary.points[tree.primary.points.length - 1].price, 57, '框架A仍止于全局低点，未受影响');
  assert.ok(tree.frameworkB && tree.frameworkB.primary, '应生成框架B（区间延伸到now）且能匹配出形态');
  assert.equal(tree.frameworkB.primary.points[0].price, 126, '框架B与框架A同起点');
  const bEnd = tree.frameworkB.primary.points[tree.frameworkB.primary.points.length - 1];
  assert.equal(bEnd.price, 62, '框架B终点延伸到now（最后一个细枢轴）');
  assert.ok(bEnd.provisional, '框架B末点应标provisional');
  assert.ok(!tree.frameworkB.counterTrend, 'now是顺势极值(L)→走朴素框架B，非逆势末浪');
});

test('框架B逆势末浪（model-unfinished-final-wave）：now在反弹高点时不空缺，改标末浪进行中', () => {
  // 下跌到全局低57，之后反弹到79(H, provisional) —— now是逆势反弹高点，朴素框架B会因
  // 「下行形态须终结于L、而止点是H」返回空；应改用「复用框架A、末浪进行中」的逆势框架B。
  const fine = finePivots([[126, 'H'], [100, 'L'], [110, 'H'], [57, 'L'], [79, 'H']]);
  fine[fine.length - 1].provisional = true;
  const candles = makeCandlesFromAnchors(fine);
  const tree = buildCountTree(fine, candles, { maxDepth: 5, beamK: 4 });

  assert.ok(tree.frameworkB && tree.frameworkB.primary, '逆势反弹高点处框架B不得空缺');
  assert.equal(tree.frameworkB.counterTrend, true, '应走逆势末浪路径');
  const bp = tree.frameworkB.primary;
  assert.equal(bp.finalWaveInProgress, true, '框架B主选应标末浪进行中');
  // 末点仍是全局极值57（不强行终结在now=79），且投影为跌破57的新低
  assert.equal(bp.points[bp.points.length - 1].price, 57, '框架B末点=全局极值（不是now）');
  assert.ok(Array.isArray(bp.projection) && bp.projection.length === 3, '应给末浪延伸投影');
  assert.ok(bp.projection.every((t) => t.price < 57), '下跌末浪延伸投影须在全局低点57下方');
  assert.ok(bp.score.incompleteness > 0, '末浪进行中应带未完成度惩罚');
});

test('candidateViolations：规则违规+文法违规合并，按越界降序，供报告展示原因', () => {
  const c = {
    score: {
      failed: [{ desc: 'y浪须>w浪90%', overshoot: 0.005 }, { desc: 'x浪回撤须≥70%', overshoot: 0.19 }],
      grammarNotes: [{ kind: 'grammar', desc: '第2腿须调整、实测像五浪', overshoot: 0 }],
    },
  };
  const v = candidateViolations(c);
  assert.equal(v.length, 3, '规则2 + 文法1 = 3 条');
  assert.equal(v[0].desc, 'x浪回撤须≥70%', '越界最大(0.19)排最前');
  assert.equal(v[0].kind, 'rule');
  assert.equal(v[v.length - 1].kind, 'grammar', '文法(越界0)排最后');
  // 无违规 → 空
  assert.deepEqual(candidateViolations({ score: { failed: [], grammarNotes: [] } }), []);
});

test('legEndpointsSpanExtreme：端点须为跨度真极值，内部藏更极端点则淘汰', () => {
  const fp = (seq) => seq.map(([price, type], i) => ({ index: i, type, price }));
  // 端点非极值：a 段 L57718→H65705，但两宏观点之间(索引1..3)藏着更高的 66924
  const segBad = fp([[57718, 'L'], [64669, 'H'], [66924, 'H'], [65705, 'H'], [62209, 'L'], [79500, 'H']]);
  const ptsBad = [segBad[0], segBad[3], segBad[4], segBad[5]]; // 57718→65705→62209→79500
  assert.equal(legEndpointsSpanExtreme(ptsBad, segBad), false, '65705 内部藏着更高的66924→淘汰');

  // 端点即极值：把 a 顶取在真极值 66924
  const ptsGood = [segBad[0], segBad[2], segBad[4], segBad[5]]; // 57718→66924→62209→79500
  assert.equal(legEndpointsSpanExtreme(ptsGood, segBad), true, '66924 是该段真极值→通过');

  // 收缩三角样例（highs 递降但各自仍是局部段极值）不被误伤
  const segTri = fp([[300, 'H'], [220, 'L'], [290, 'H'], [230, 'L'], [280, 'H'], [240, 'L']]);
  assert.equal(legEndpointsSpanExtreme(segTri, segTri), true, '收缩三角每个宏观点仍是局部极值→通过');
});

test('grammarViolatesRole：歧义腿胜任任一角色不违规；只能胜任一方的按角色判', () => {
  // 歧义腿：两种拆解都干净 → 放在调整位或驱动位都不违规
  const ambiguous = { character: 'driving', canDrive: true, canCorrect: true };
  assert.equal(grammarViolatesRole(ambiguous, 'corrective'), false, '歧义腿放调整位不违规');
  assert.equal(grammarViolatesRole(ambiguous, 'driving'), false, '歧义腿放驱动位不违规');

  // 只能干净走五浪：放在调整位仍违规（无法胜任调整角色）
  const driveOnly = { character: 'driving', canDrive: true, canCorrect: false };
  assert.equal(grammarViolatesRole(driveOnly, 'corrective'), true, '只能五浪的腿放调整位应违规');
  assert.equal(grammarViolatesRole(driveOnly, 'driving'), false, '放驱动位不违规');

  // 只能干净走三波：放在驱动位仍违规
  const corrOnly = { character: 'corrective', canDrive: false, canCorrect: true };
  assert.equal(grammarViolatesRole(corrOnly, 'driving'), true, '只能三波的腿放驱动位应违规');
  assert.equal(grammarViolatesRole(corrOnly, 'corrective'), false);

  // 两种都拆不干净：退回旧口径（用最佳性格 character 判）
  const neitherClean = { character: 'corrective', canDrive: false, canCorrect: false };
  assert.equal(grammarViolatesRole(neitherClean, 'driving'), true, '退回旧口径：最佳性格≠所需→违规');
  assert.equal(grammarViolatesRole(neitherClean, 'corrective'), false);
});

test('macroAlternates：淘汰"下降的连接浪"——lower-high 被选作上冲目标的退化骨架', () => {
  // 下跌联合形被错误地选了下跌途中的"更低的高点"：L103517→H94641，H 比前一个 L 还低，
  // "L→H"这条连接浪其实在下降。类型交替(H/L)通过，但几何上方向反了，须淘汰。
  const bad = [
    { type: 'H', price: 126296 }, { type: 'L', price: 103517 }, { type: 'H', price: 94641 },
    { type: 'L', price: 84400 }, { type: 'H', price: 76023 }, { type: 'L', price: 57718 },
  ];
  assert.equal(macroAlternates(bad), false, 'H 低于相邻 L 的降序连接浪应判非法');

  // 真正交替的联合形：x 连接浪向上回抽（82814 > 80525）
  const good = [
    { type: 'H', price: 126296 }, { type: 'L', price: 80525 }, { type: 'H', price: 82814 },
    { type: 'L', price: 57718 },
  ];
  assert.equal(macroAlternates(good), true, '每个内部H高于相邻L、每个内部L低于相邻H → 合法');

  // 干净五浪推动（下跌）：各内部点均为相邻真极值
  const impulse = [
    { type: 'H', price: 126296 }, { type: 'L', price: 103517 }, { type: 'H', price: 116410 },
    { type: 'L', price: 84400 }, { type: 'H', price: 97964 }, { type: 'L', price: 57718 },
  ];
  assert.equal(macroAlternates(impulse), true);
});

test('端到端：报告排名表里不再出现"下降的连接浪"（几何退化骨架被源头拦截）', () => {
  // 构造一个会诱发降序连接浪的下跌序列：夹着一个"更低的高点"
  const fine = finePivots([
    [126, 'H'], [103, 'L'], [116, 'H'], [84, 'L'], [94, 'H'], [80, 'L'], [90, 'H'], [57, 'L'],
  ]);
  const candles = makeCandlesFromAnchors(fine);
  const tree = buildCountTree(fine, candles, { maxDepth: 5, beamK: 8 });
  const all = [tree.primary, ...(tree.alternates || [])];
  for (const c of all) {
    // 每条宏观腿的方向必须与其端点类型一致：去 H 的腿必上行、去 L 的腿必下行
    for (let i = 0; i < c.points.length - 1; i += 1) {
      const a = c.points[i];
      const b = c.points[i + 1];
      if (b.type === 'H') assert.ok(b.price > a.price, `去H的腿必上行，实测 ${a.price}→${b.price}`);
      else assert.ok(b.price < a.price, `去L的腿必下行，实测 ${a.price}→${b.price}`);
    }
  }
});

test('框架B逆势末浪：now越过全局极值但同型（顺势新低）时不触发逆势路径', () => {
  // now=45(L)是顺势新低（比57更低）→ directionalSpanToNow 会把它纳入，朴素框架B 直接处理，
  // 不应错误地走逆势末浪分支。构造：下跌一路到45新低（provisional）。
  const fine = finePivots([[126, 'H'], [100, 'L'], [110, 'H'], [45, 'L']]);
  fine[fine.length - 1].provisional = true;
  const candles = makeCandlesFromAnchors(fine);
  const tree = buildCountTree(fine, candles, { maxDepth: 5, beamK: 4 });
  // 全局低点就是 now 本身，directionalSpanToNow 与 directionalTopSpan 同长 → 不算B（无后续走势）
  // 或朴素B可拟合；无论如何都不应是"逆势末浪"（counterTrend）
  assert.ok(!(tree.frameworkB && tree.frameworkB.counterTrend), 'now为顺势新极值时不得走逆势末浪路径');
});

// ------------------------------------------------------------
// structured-wave-report：分档 + 7 节报告
// ------------------------------------------------------------

test('strengthTier：按违规数/越界/未完成度分 高/中/低（不给概率）', () => {
  assert.equal(strengthTier({ tier1: 0, tier2: 0, incompleteness: 0 }), '高');
  assert.equal(strengthTier({ tier1: 1, tier2: 0.005, incompleteness: 0 }), '高'); // 差一丝
  assert.equal(strengthTier({ tier1: 1, tier2: 0.2, incompleteness: 0 }), '中');
  assert.equal(strengthTier({ tier1: 2, tier2: 0.5, incompleteness: 0 }), '低');
  assert.equal(strengthTier({ tier1: 0, tier2: 0, incompleteness: 0.6 }), '中'); // 在建、未完成度高
});

test('结构化报告：7 节齐备 + 反弹必点修正对象 + wave-3 清单 + 不给概率百分比', () => {
  const fine = finePivots([
    [126, 'H'], [80, 'L'], [98, 'H'], [57, 'L'], [66, 'H'], [62, 'L'], [79, 'H'],
  ]);
  fine[fine.length - 1].provisional = true;
  const candles = makeCandlesFromAnchors(fine);
  const tree = buildCountTree(fine, candles, { maxDepth: 5, beamK: 4 });
  const meta = {
    product: 'BTC-USD', timeframe: '1d', startUtc: new Date().toISOString(), endUtc: new Date().toISOString(),
    generatedAtUtc: new Date().toISOString(), source: 'fixture', sampleCount: candles.length,
    rangeHigh: 126, rangeLow: 57, lastClose: 79, lastCloseTs: Math.floor(Date.now() / 1000),
  };
  const md = renderStructuredReport(meta, tree, candles, fine);
  ['## 1. 分析范围', '## 2. 关键转折点', '## 3. 已完成浪型', '## 4. 当前主方案',
    '## 5. 备选方案', '## 6. 方案排序', '## 7. 最终分析话术'].forEach((h) => {
    assert.ok(md.includes(h), `应含 ${h}`);
  });
  assert.ok(md.includes('修正对象'), '当前主方案须点明修正对象');
  assert.ok(/结构验证|无法验证/.test(md), '应含 wave-3 结构验证或无法验证说明');
  assert.ok(!md.includes('%概率') && !/概率\s*[:：]\s*\d/.test(md), '不得给概率百分比');
  assert.ok(!md.includes('undefined') && !md.includes('NaN'), '不得有 undefined/NaN');
});
