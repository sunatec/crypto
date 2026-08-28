'use strict';

/**
 * 波浪计数引擎（递归拆解 + 最佳拟合）—— 独立并行模块。
 *
 * 设计依据：
 *   - openspec/changes/rebuild-wave-tree-best-fit-engine/（grilling 定稿 Q1–Q18，M1–M4 架构基线）
 *   - openspec/changes/rank-competing-wave-counts/（搜索补全 / 顶层区间焊死解开 / 排名数法输出）
 * 定位：以《波浪理论详解》全部可计算知识为准绳的「最佳拟合浪型识别器」，产出：
 *   ① 一条「最大级别 → 当前所处浪型」的计数树（主链 + 每层备选 + 进行中预期）；
 *   ② 顶层「排名数法表」：同一段行情按吻合度排出主选1+备选3的完整数法竞争结果，
 *      候选池含两种框架——框架A（区间止于全局极值，已完成）、框架B（区间延伸到
 *      now，表达"当前走势可能是更高级别、尚未走完的浪的内部子腿"），同一把尺排名
 *      （框架B候选带未完成度惩罚，防止半成品因"还没机会违规"而虚高）。
 *
 * 对旧文件 analyze-wave-manual.js 采「采石场，非依赖」策略：
 *   - 管道（取数/枢轴/度量/通道/斐波，理论中立）直接 require 复用；
 *   - 形态规则的「内容」搬进本文件的新判据层（test 返回 {pass, overshoot}）；
 *   - legShape 家族与滑窗/固定三档（scan 系列、DEGREE_CONFIGS）不搬，被递归取代。
 *
 * 关键内部机制（rank-competing-wave-counts，见该 change 的 design.md 详解）：
 *   - segmentations()：显著性短名单（拓扑存活序）+ 交替子序列穷举，每形态可回多套
 *     合法切分（而非单一贪心坍缩），交给 decompose() 逐套打分排名；
 *   - decompose()：两段式 beam——先用不含子树的基础分粗排前沿，只对少数幸存者才
 *     递归展开子树（否则多解搜索会让分支因子随深度指数放大），并按「区间+角色+
 *     深度」记忆化缓存跨候选共享的重复子树计算；
 *   - buildCountTree()：framework A（directionalTopSpan）与 framework B
 *     （directionalSpanToNow，仅当其严格长于A时才计算）并行拆解，供排名表合并。
 */

// ---- 复用旧模块的管道（plumbing，理论中立）----
const manual = require('./analyze-wave-manual.js');
const {
  fetchCandles,
  transformCandles,
  computeATR,
  detectPivots,
  anchorBoundaryExtremes,
  computeMeasures,
  rangeExtreme,
  TIMEFRAMES,
  // 书02章 艾略特通道（复用老模块按本书的实现）
  buildChannel,
  channelTypeFor,
  channelExitHint,
} = manual;

// ============================================================
// 0. 本地小工具（旧模块未导出的 safeRatio/absLen 等，均为理论中立的算术）
// ============================================================

function safeRatio(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  return numerator / denominator;
}

function absLen(a, b) {
  return Math.abs(Number(b.price) - Number(a.price));
}

function legIndexTime(p0, p1) {
  return Math.max(1, Math.abs(p1.index - p0.index));
}

// ============================================================
// 1. 判据契约（Q6/Q3 的地基）：test 返回 { pass, overshoot }
// ============================================================
//
// overshoot = 违反时「相对阈值归一化的越界距离」，通过时为 0。
//   · 比率规则：超出 [lo,hi] 区间的量 ÷ 区间宽度（单侧则 ÷ 阈值）。
//   · 形态规则（闸门）：归一化价格距离 ÷ 参考浪幅。
// 这样拟合分才能在 tier2 累加「违反有多重」，并支撑 near-miss 可解释。

const LAYER_ORDER = { pattern: 0, ratio: 1, time: 2 };

// 越界超过此归一化阈值即算「严重违规/致命伤」（书外工程阈值，可后审调整）。
const SEVERE_OVERSHOOT = 0.5;

// 文法违规（子腿性格无法胜任所需角色）在 tier2(越界和) 里的固定权重（structured-wave-report §2.4）。
// 此前文法违规只计 tier1 条数、tier2 记 0，导致"结构性格不对"的候选在越界维度白占便宜、平票压过
// "仅差一丝比例"的候选。给它一个权重后，"腿性格根本不对"这类结构硬伤不再被当作比小比例越界更轻。
// 取 0.25：重于常见的小比例越界(如 0.5%~2%)，与较大比例越界(~19%)量级相当；可后审标定。
const GRAMMAR_OVERSHOOT = 0.25;

/**
 * 比率型判据的归一化结果：要求 r ∈ [lo, hi]（hi 可为 Infinity 表示单侧）。
 */
function normRange(r, lo, hi) {
  if (r === null || !Number.isFinite(r)) return { pass: false, overshoot: 1 };
  const hasHi = Number.isFinite(hi);
  const width = hasHi ? (hi - lo) : Math.abs(lo);
  const denom = width > 0 ? width : 1;
  if (r < lo) return { pass: false, overshoot: (lo - r) / denom };
  if (hasHi && r > hi) return { pass: false, overshoot: (r - hi) / denom };
  return { pass: true, overshoot: 0 };
}

/**
 * 闸门型判据的归一化结果：pass 为布尔，margin 为违反时的越界量，ref 为归一化参考浪幅。
 */
function normGate(pass, margin, ref) {
  if (pass) return { pass: true, overshoot: 0 };
  const denom = Number.isFinite(ref) && ref > 0 ? ref : 1;
  return { pass: false, overshoot: Math.abs(margin) / denom };
}

/**
 * 判据工厂。test(ctx) MUST 返回 { pass, overshoot }。
 * 指引可只关心 pass（overshoot 恒 0），仍走同一契约以便统一求值。
 */
function makeJudge(id, layer, desc, test, options = {}) {
  return {
    id,
    layer,
    basis: options.basis || null,
    desc,
    test,
    kind: options.kind || 'rule', // 'rule' | 'guideline'
  };
}

function safeTest(judge, ctx) {
  try {
    const res = judge.test(ctx);
    if (res && typeof res === 'object' && 'pass' in res) {
      return { pass: Boolean(res.pass), overshoot: Number.isFinite(res.overshoot) ? res.overshoot : (res.pass ? 0 : 1) };
    }
    // 兼容返回裸布尔的指引
    return { pass: Boolean(res), overshoot: 0 };
  } catch (err) {
    return { pass: false, overshoot: 1 };
  }
}

// ============================================================
// 2. 拟合分（Q6=a + Q11=b）：分层字典序 + 优雅降级（Q3=b）
// ============================================================
//
// 排序键（全部升序，越小越优，tier4 例外为「命中越多越优」→ 比较时降序）：
//   tier1 = 违反硬规则条数
//   tier2 = 违反规则的越界距离之和
//   tier3 = 形态内指引未命中率 (1 - 命中率)
//   tier4 = 跨级别指引命中数（交替/父子斐波/通道/浪个性）—— 仅平局裁决，M3 填充

function scoreCandidate(ctx, m) {
  const rules = m.rules.slice().sort((a, b) => LAYER_ORDER[a.layer] - LAYER_ORDER[b.layer]);

  const failed = [];
  let overshootSum = 0;
  for (const r of rules) {
    const res = safeTest(r, ctx);
    if (!res.pass) {
      failed.push({ id: r.id, layer: r.layer, desc: r.desc, overshoot: res.overshoot });
      overshootSum += res.overshoot;
    }
  }

  const guidelines = m.guidelines || [];
  const hits = [];
  for (const g of guidelines) {
    if (safeTest(g, ctx).pass) hits.push({ id: g.id, desc: g.desc });
  }
  const total = guidelines.length;

  return {
    manual: m,
    // 严重违规数：越界>SEVERE_OVERSHOOT 的硬规则失败（致命伤）。排在条数之前，
    // 使"一条致命伤"不能被"少违规一条"救回来（用户定：严重程度可盖过条数差）。
    severe: failed.filter((f) => f.overshoot > SEVERE_OVERSHOOT).length,
    tier1: failed.length,
    tier2: overshootSum,
    // tier3 用「命中数的负值」（越多越优），而非未命中率——否则「没有任何指引」的形态
    // 会拿到满分未命中率 0，白白压过命中了部分指引的形态。
    tier3: -hits.length,
    tier4: 0, // 跨级别指引，M3 接入
    failed,
    hits,
    guidelineTotal: total,
    penalized: failed.length > 0, // Q3=b：带违规即被降级标记
  };
}

/**
 * 分层字典序比较：tier1↑, tier2↑, incompleteness↑, complexity↑, tier3↑, tier4↓。
 * complexity（简约原则）插在硬规则拟合之后、软指引之前：书里明确「多重调整（双/三）
 * 是最后手段」，故同等规则拟合下，越简单的形态越优——防止规则稀少的联合形/多锯齿
 * 靠"没什么可违反"白捡第一。
 * incompleteness（rank-competing-wave-counts §3.2，Q6=a 同一把尺）：框架B（在建）
 * 候选专属，插在 tier2 之后、complexity 之前——防止「还没机会违反规则」的半成品
 * 单凭 tier1/tier2 干净就虚高，压过已完成、真正规则全过的框架A候选。框架A候选恒为 0。
 */
function compareCandidates(a, b) {
  const sa = a.severe || 0;
  const sb = b.severe || 0;
  if (sa !== sb) return sa - sb; // 严重违规最少者优先（致命伤盖过条数差）
  if (a.tier1 !== b.tier1) return a.tier1 - b.tier1;
  if (a.tier2 !== b.tier2) return a.tier2 - b.tier2;
  const ia = a.incompleteness || 0;
  const ib = b.incompleteness || 0;
  if (ia !== ib) return ia - ib;
  const ca = a.complexity || 0;
  const cb = b.complexity || 0;
  if (ca !== cb) return ca - cb;
  if (a.tier3 !== b.tier3) return a.tier3 - b.tier3;
  if (a.tier4 !== b.tier4) return b.tier4 - a.tier4;
  return 0;
}

// 简约度：单形态=1，双重=2，三重=3（书：多重调整是最后手段）。
function patternComplexity(id) {
  if (id.endsWith('-triple')) return 3;
  if (id.endsWith('-double')) return 2;
  return 1;
}

/**
 * 未完成度惩罚（rank-competing-wave-counts §3.2，Q6=a）：框架B候选的末点是 provisional
 * （尚未确认），末腿仍在成形中。这里用「末腿已走过的幅度 ÷ 参考腿（前一条已完成腿）幅度」
 * 估计末腿完成度——刚起步（比值趋近0）→ 惩罚趋近1（几乎完全未定）；已跟其它腿相当或
 * 更大（比值≥1）→ 惩罚趋近0（大概率已近尾声）。
 *
 * 实现范围说明（design.md §3.2 的取舍）：完整设计要求「进行中的末腿只查可判定规则、
 * 未定项不计违规也不计入通过」——需要逐条规则标注依赖哪些点才能精确做到，改动面极大
 * （现有约 50 条规则闭包），本次先用这个整体性惩罚项作为主要公平机制：末腿仍按现有
 * scoreCandidate 全量规则打分（可能因"尚未走够"而误判违规，与该段其它腿一视同仁），
 * 但 incompleteness 会把明显还很稚嫩的候选压到已完成框架A候选之后。逐规则可判定性
 * 留作后续增量（design.md 已同步记录）。
 */
function computeIncompleteness(pts) {
  const last = pts[pts.length - 1];
  if (!last || !last.provisional || pts.length < 2) return 0;
  const lastLegAmp = Math.abs(last.price - pts[pts.length - 2].price);
  let refAmp = 0;
  for (let i = 0; i < pts.length - 2; i += 1) {
    refAmp = Math.max(refAmp, Math.abs(pts[i + 1].price - pts[i].price));
  }
  if (refAmp <= 0) return 1; // 无参考腿可比，视为完全未定
  const progress = Math.min(1, lastLegAmp / refAmp);
  return 1 - progress;
}

/**
 * 从一组候选中选出主选 + 备选（beam K）。优雅降级（Q3=b）天然内建：
 * 字典序让 tier1=0 的候选排最前；若无人 tier1=0，主选即最轻违规者且已带 penalized。
 */
function selectBest(scored, beamK = 3) {
  const sorted = scored.slice().sort(compareCandidates);
  return {
    primary: sorted[0] || null,
    alternates: sorted.slice(1, beamK),
    all: sorted,
  };
}

// ============================================================
// 3. 样板手册：标准推动浪（从 analyze-wave-manual.js 机械搬运 + 换 overshoot 契约）
// ============================================================
//
// 判据 id / 章节对照沿用旧模块（书 1.5）。规则内容原样搬运，仅把布尔 test 升级为
// {pass, overshoot}。可疑阈值处打 TODO 待后审（Q10b=a：先跑通架构，规则对错独立迭代）。

function buildImpulseStrictManual(direction) {
  const isUp = direction === 'up';

  const rules = [
    makeJudge('impulse.pattern.wave2-not-retrace-100', 'pattern', '2浪不能折返1浪的100%', (ctx) => {
      const [p0, p1, p2] = ctx.points;
      const w1 = absLen(p0, p1);
      const pass = isUp ? p2.price > p0.price : p2.price < p0.price;
      return normGate(pass, absLen(p0, p2), w1);
    }),
    makeJudge('impulse.pattern.wave3-exceeds-wave1-end', 'pattern', '3浪须超过1浪的终点', (ctx) => {
      const [p0, p1, , p3] = ctx.points;
      const w1 = absLen(p0, p1);
      const pass = isUp ? p3.price > p1.price : p3.price < p1.price;
      return normGate(pass, absLen(p1, p3), w1);
    }),
    makeJudge('impulse.pattern.wave4-not-cross-wave1', 'pattern', '推动浪的4浪不能切入1浪', (ctx) => {
      const [p0, p1, , , p4] = ctx.points;
      const w1 = absLen(p0, p1);
      const pass = isUp ? p4.price > p1.price : p4.price < p1.price;
      return normGate(pass, absLen(p1, p4), w1);
    }),
    makeJudge('impulse.pattern.wave3-not-shortest', 'pattern', '3浪一定不是1/3/5浪中最短的', (ctx) => {
      const [p0, p1, p2, p3, p4, p5] = ctx.points;
      const w1 = absLen(p0, p1);
      const w3 = absLen(p2, p3);
      const w5 = absLen(p4, p5);
      const threshold = Math.min(w1, w5);
      const pass = w3 >= threshold;
      return normGate(pass, threshold - w3, threshold);
    }),
    makeJudge('impulse.ratio.wave2-retrace-range', 'ratio', '2浪回撤须在1浪的23.6%~88.6%之间', (ctx) => {
      const [p0, p1, p2] = ctx.points;
      const r = safeRatio(absLen(p1, p2), absLen(p0, p1));
      return normRange(r, 0.236, 0.886);
    }, { basis: 'price' }),
    makeJudge('impulse.ratio.wave3-extend-range', 'ratio', '3浪相对1浪的扩展须在1~4.236倍之间', (ctx) => {
      const [p0, p1, p2, p3] = ctx.points;
      const r = safeRatio(absLen(p2, p3), absLen(p0, p1));
      return normRange(r, 1.0, 4.236);
    }, { basis: 'price' }),
  ];

  const guidelines = [
    makeJudge('impulse.guide.alternation-2-4', 'pattern', '2浪与4浪呈现交替（回撤比率不同）', (ctx) => {
      const [p0, p1, p2, p3, p4] = ctx.points;
      const w1 = absLen(p0, p1);
      const w3 = absLen(p2, p3);
      const retrace2 = Math.abs(safeRatio(absLen(p1, p2), w1) || 0);
      const retrace4 = Math.abs(safeRatio(absLen(p3, p4), w3) || 0);
      return { pass: Math.abs(retrace2 - retrace4) > 0.15, overshoot: 0 };
    }, { kind: 'guideline' }),
    makeJudge('impulse.guide.wave3-common-extension', 'ratio', '3浪扩展接近常见斐波那契倍数（1.618/2.618）', (ctx) => {
      const [p0, p1, p2, p3] = ctx.points;
      const r = safeRatio(absLen(p2, p3), absLen(p0, p1));
      const pass = r !== null && (Math.abs(r - 1.618) < 0.3 || Math.abs(r - 2.618) < 0.4);
      return { pass, overshoot: 0 };
    }, { kind: 'guideline', basis: 'price' }),
    makeJudge('impulse.guide.wave4-time-balance', 'time', '4浪与2浪耗时比在0.2~5倍之间（时间平衡）', (ctx) => {
      const [, p1, p2, p3, p4] = ctx.points;
      const r = legIndexTime(p3, p4) / legIndexTime(p1, p2);
      return { pass: r >= 0.2 && r <= 5.0, overshoot: 0 };
    }, { kind: 'guideline' }),
  ];

  return { patternType: 'impulse', direction, mode: 'strict', label: '推动浪（标准 Impulse）', rules, guidelines };
}

// ---- 楔形（Diagonal，驱动类）：搬运 buildImpulseDiagonalManual 的价格/比率规则 ----
// 结构规则（子浪须为驱动/调整）不在此，由文法承担。position 仅影响标签。

function buildDiagonalManual(direction, position) {
  const isUp = direction === 'up';
  const isLeading = position === 'leading';
  const mode = isLeading ? 'leading_diagonal' : 'ending_diagonal';
  const label = isLeading ? '推动浪（引导楔形 Leading Diagonal）' : '推动浪（终结楔形 Ending Diagonal）';

  const rules = [
    makeJudge('diagonal.pattern.wave2-not-retrace-100', 'pattern', '2浪不能折返1浪的100%', (ctx) => {
      const [p0, p1, p2] = ctx.points;
      return normGate(isUp ? p2.price > p0.price : p2.price < p0.price, absLen(p0, p2), absLen(p0, p1));
    }),
    makeJudge('diagonal.pattern.wave3-exceeds-wave1-end', 'pattern', '3浪须超过1浪的终点', (ctx) => {
      const [p0, p1, , p3] = ctx.points;
      return normGate(isUp ? p3.price > p1.price : p3.price < p1.price, absLen(p1, p3), absLen(p0, p1));
    }),
    makeJudge('diagonal.pattern.wave4-allowed-cross-wave1', 'pattern', '楔形允许4浪切入1浪，但须落在2、1浪终点之间', (ctx) => {
      const [, p1, p2, , p4] = ctx.points;
      const pass = isUp ? (p4.price <= p1.price && p4.price > p2.price) : (p4.price >= p1.price && p4.price < p2.price);
      const margin = isUp ? Math.min(Math.abs(p4.price - p1.price), Math.abs(p4.price - p2.price)) : Math.min(Math.abs(p4.price - p1.price), Math.abs(p4.price - p2.price));
      return normGate(pass, pass ? 0 : margin, absLen(p1, p2));
    }),
    makeJudge('diagonal.pattern.wave4-not-retrace-100-of-3', 'pattern', '4浪不能折返3浪的100%', (ctx) => {
      const [, , p2, p3, p4] = ctx.points;
      return normGate(isUp ? p4.price > p2.price : p4.price < p2.price, absLen(p2, p4), absLen(p2, p3));
    }),
    makeJudge('diagonal.pattern.wave3-not-shortest', 'pattern', '3浪一定不是最短的', (ctx) => {
      const [p0, p1, p2, p3, p4, p5] = ctx.points;
      const w1 = absLen(p0, p1); const w3 = absLen(p2, p3); const w5 = absLen(p4, p5);
      const thr = Math.min(w1, w5);
      return normGate(w3 >= thr, thr - w3, thr);
    }),
    makeJudge('diagonal.ratio.converging', 'ratio', '楔形须收敛：3浪短于1浪、5浪短于3浪', (ctx) => {
      const [p0, p1, p2, p3, p4, p5] = ctx.points;
      const w1 = absLen(p0, p1); const w3 = absLen(p2, p3); const w5 = absLen(p4, p5);
      const pass = w3 < w1 && w5 < w3;
      const margin = Math.max(0, w3 - w1) + Math.max(0, w5 - w3);
      return normGate(pass, margin, w1 || 1);
    }, { basis: 'price' }),
  ];

  const guidelines = [
    makeJudge('diagonal.guide.wave5-time-shorter', 'time', '5浪耗时通常短于3浪', (ctx) => {
      const [, , p2, p3, p4, p5] = ctx.points;
      return { pass: legIndexTime(p4, p5) <= legIndexTime(p2, p3), overshoot: 0 };
    }, { kind: 'guideline' }),
  ];

  return { patternType: 'impulse', direction, mode, label, rules, guidelines };
}

// ---- 单锯齿（Zigzag 5-3-5，调整类）：仅保留价格/比率/时间规则 ----
// a/c 须驱动、b 须调整 → 由文法承担，不在此。

function buildZigzagManual(direction) {
  const isUp = direction === 'up';

  const rules = [
    makeJudge('zigzag.ratio.b-price-between-0.2a-and-a', 'ratio', 'b浪价格须在a浪的20%~100%之间', (ctx) => {
      const [p0, p1, p2] = ctx.points;
      return normRange(safeRatio(absLen(p1, p2), absLen(p0, p1)), 0.2, 1.0);
    }, { basis: 'price' }),
    makeJudge('zigzag.ratio.b-not-break-a-start', 'ratio', 'b浪任何部分不能超过a浪起点', (ctx) => {
      const [p0, p1, p2] = ctx.points;
      const ext = rangeExtreme(ctx.candles, p1.index, p2.index);
      const pass = isUp ? ext.minLow >= p0.price - 1e-9 : ext.maxHigh <= p0.price + 1e-9;
      const margin = isUp ? p0.price - ext.minLow : ext.maxHigh - p0.price;
      return normGate(pass, margin, absLen(p0, p1));
    }, { basis: 'gross' }),
    makeJudge('zigzag.ratio.c-between-0.9b-and-5b', 'ratio', 'c浪须≥b浪90%且<b浪5倍且<a浪5倍', (ctx) => {
      const [p0, p1, p2, p3] = ctx.points;
      const a = absLen(p0, p1); const b = absLen(p1, p2); const c = absLen(p2, p3);
      const r1 = normRange(safeRatio(c, b), 0.9, 5);
      const r2 = normRange(safeRatio(c, a), 0, 5);
      return { pass: r1.pass && r2.pass, overshoot: r1.overshoot + r2.overshoot };
    }, { basis: 'price' }),
    makeJudge('zigzag.time.b-lt-10a', 'time', 'b浪时间≤a浪10倍', (ctx) => {
      const [p0, p1, p2] = ctx.points;
      return normRange(legIndexTime(p1, p2) / legIndexTime(p0, p1), 0, 10);
    }),
    makeJudge('zigzag.time.c-lt-10a-and-10b', 'time', 'c浪时间≤a、b浪10倍', (ctx) => {
      const [p0, p1, p2, p3] = ctx.points;
      const ra = normRange(legIndexTime(p2, p3) / legIndexTime(p0, p1), 0, 10);
      const rb = normRange(legIndexTime(p2, p3) / legIndexTime(p1, p2), 0, 10);
      return { pass: ra.pass && rb.pass, overshoot: ra.overshoot + rb.overshoot };
    }),
  ];

  const guidelines = [
    makeJudge('zigzag.guide.b-common-ratio', 'ratio', 'b浪接近常见比率(0.382/0.5/0.618)', (ctx) => {
      const [p0, p1, p2] = ctx.points;
      const r = Math.abs(safeRatio(absLen(p1, p2), absLen(p0, p1)) || 0);
      return { pass: [0.382, 0.5, 0.618].some((t) => Math.abs(r - t) < 0.08), overshoot: 0 };
    }, { kind: 'guideline' }),
    makeJudge('zigzag.guide.c-common-ratio', 'ratio', 'c浪接近常见比率(1/0.618/1.618)', (ctx) => {
      const [p0, p1, p2, p3] = ctx.points;
      const r = Math.abs(safeRatio(absLen(p2, p3), absLen(p0, p1)) || 0);
      return { pass: [1, 0.618, 1.618].some((t) => Math.abs(r - t) < 0.1), overshoot: 0 };
    }, { kind: 'guideline' }),
    // 书 §4.1 补：b浪不会接近a浪起点（通常不深度回撤）
    makeJudge('zigzag.guide.b-not-approach-a-start', 'ratio', 'b浪通常不接近a浪起点（回撤≤a的90%）', (ctx) => {
      const [p0, p1, p2] = ctx.points;
      const r = safeRatio(absLen(p1, p2), absLen(p0, p1));
      return { pass: r !== null && r <= 0.9, overshoot: 0 };
    }, { kind: 'guideline' }),
    // 书 §4.1 补：c浪未远超a浪的161.8%（否则更可能是推动浪开始，而非锯齿）
    makeJudge('zigzag.guide.c-not-far-beyond-1.618a', 'ratio', 'c浪未远超a浪的1.618倍（否则更像推动浪）', (ctx) => {
      const [p0, p1, p2, p3] = ctx.points;
      const r = Math.abs(safeRatio(absLen(p2, p3), absLen(p0, p1)) || 0);
      return { pass: r <= 1.618, overshoot: 0 };
    }, { kind: 'guideline' }),
    // 书 §4.1 补：b浪时间通常介于a浪时间的61.8%~161%
    makeJudge('zigzag.guide.b-time-window', 'time', 'b浪时间通常介于a浪的61.8%~161%', (ctx) => {
      const [p0, p1, p2] = ctx.points;
      const r = legIndexTime(p1, p2) / legIndexTime(p0, p1);
      return { pass: r >= 0.618 && r <= 1.61, overshoot: 0 };
    }, { kind: 'guideline' }),
  ];

  return { patternType: 'zigzag', direction, mode: 'single', label: '单锯齿（Zigzag 5-3-5）', rules, guidelines };
}

// ---- 平台形（Flat 3-3-5 基础版，调整类）：仅保留运行总量/比率/时间规则 ----

// 平台形各腿度量（书 §5.1：a/b/c 的运行总量 gross、a 的价格 price）
function flatMeasures(ctx, direction) {
  const oppo = direction === 'up' ? 'down' : 'up';
  const [p0, p1, p2, p3] = ctx.points;
  return {
    p0, p1, p2, p3,
    aM: computeMeasures([p0, p1], direction, ctx.candles),
    bM: computeMeasures([p1, p2], oppo, ctx.candles),
    cM: p3 ? computeMeasures([p2, p3], direction, ctx.candles) : null,
    aPrice: absLen(p0, p1),
  };
}

// 平台形共享基础规则（书 §5.1）：b∈[0.7,2)a运行总量、c与a重叠、c运行总量≤2×max(a,b)且≤3×a价格、时间≤10倍
function flatBaseRules(direction) {
  const isUp = direction === 'up';
  return [
    makeJudge('flat.ratio.b-gross-at-least-70pct-of-a', 'ratio', 'b浪运行总量须≥a浪70%', (ctx) => {
      const { aM, bM } = flatMeasures(ctx, direction);
      return normRange(safeRatio(bM.gross, aM.gross), 0.7, Infinity);
    }, { basis: 'gross' }),
    makeJudge('flat.ratio.b-gross-below-200pct-of-a', 'ratio', 'b浪运行总量须<a浪2倍', (ctx) => {
      const { aM, bM } = flatMeasures(ctx, direction);
      return normRange(safeRatio(bM.gross, aM.gross), 0, 2.0);
    }, { basis: 'gross' }),
    makeJudge('flat.ratio.c-overlaps-a', 'ratio', 'c浪必须与a浪有价格重叠', (ctx) => {
      const { aM, cM } = flatMeasures(ctx, direction);
      const pass = isUp ? cM.lo <= aM.hi : cM.hi >= aM.lo;
      const margin = isUp ? cM.lo - aM.hi : aM.lo - cM.hi;
      return normGate(pass, margin, aM.gross || 1);
    }, { basis: 'gross' }),
    makeJudge('flat.ratio.c-gross-limit', 'ratio', 'c浪运行总量≤max(a,b)的2倍 且 ≤a价格的3倍', (ctx) => {
      const { aM, bM, cM, aPrice } = flatMeasures(ctx, direction);
      const r1 = normRange(safeRatio(cM.gross, Math.max(aM.gross, bM.gross)), 0, 2.0);
      const r2 = normRange(safeRatio(cM.gross, aPrice), 0, 3.0);
      return { pass: r1.pass && r2.pass, overshoot: r1.overshoot + r2.overshoot };
    }, { basis: 'gross' }),
    makeJudge('flat.time.b-lt-10a', 'time', 'b浪时间≤a浪10倍', (ctx) => {
      const [p0, p1, p2] = ctx.points;
      return normRange(legIndexTime(p1, p2) / legIndexTime(p0, p1), 0, 10);
    }),
    makeJudge('flat.time.c-lt-10a-and-10b', 'time', 'c浪时间≤a、b浪10倍', (ctx) => {
      const [p0, p1, p2, p3] = ctx.points;
      const ra = normRange(legIndexTime(p2, p3) / legIndexTime(p0, p1), 0, 10);
      const rb = normRange(legIndexTime(p2, p3) / legIndexTime(p1, p2), 0, 10);
      return { pass: ra.pass && rb.pass, overshoot: ra.overshoot + rb.overshoot };
    }),
  ];
}

const flatCommonGuideline = (direction) => makeJudge('flat.guide.c-common-ratio', 'ratio', 'c浪接近常见比率(c=a 或 c=1.618a)', (ctx) => {
  const [p0, p1, p2, p3] = ctx.points;
  const r = Math.abs(safeRatio(absLen(p2, p3), absLen(p0, p1)) || 0);
  return { pass: Math.abs(r - 1) < 0.15 || Math.abs(r - 1.618) < 0.2, overshoot: 0 };
}, { kind: 'guideline' });

function buildFlatManual(direction) {
  return { patternType: 'flat', direction, mode: 'basic', label: '平台形（Flat 3-3-5，基础版）', rules: flatBaseRules(direction), guidelines: [flatCommonGuideline(direction)] };
}

// 书 §5.4.1 规则平台形：b运行总量≤a（外观像 N）
function buildRegularFlatManual(direction) {
  const rules = [...flatBaseRules(direction),
    makeJudge('flat-regular.ratio.b-le-a', 'ratio', '规则平台形：b浪运行总量≤a浪', (ctx) => {
      const { aM, bM } = flatMeasures(ctx, direction);
      return normRange(safeRatio(bM.gross, aM.gross), 0, 1.0);
    }, { basis: 'gross' }),
  ];
  return { patternType: 'flat', direction, mode: 'regular', label: '规则平台形（Regular Flat）', rules, guidelines: [flatCommonGuideline(direction)] };
}

// 书 §5.4.2 扩散平台形：b运行总量>a，c超过a终点（外观像喇叭）
function buildExpandedFlatManual(direction) {
  const isUp = direction === 'up';
  const rules = [...flatBaseRules(direction),
    makeJudge('flat-expanded.ratio.b-gt-a', 'ratio', '扩散平台形：b浪运行总量>a浪', (ctx) => {
      const { aM, bM } = flatMeasures(ctx, direction);
      return normRange(safeRatio(bM.gross, aM.gross), 1.0, Infinity);
    }, { basis: 'gross' }),
    makeJudge('flat-expanded.pattern.c-exceeds-a-end', 'pattern', '扩散平台形：c浪须超过a浪终点', (ctx) => {
      const { p1, p3, aPrice } = flatMeasures(ctx, direction);
      const pass = isUp ? p3.price > p1.price : p3.price < p1.price;
      return normGate(pass, absLen(p1, p3), aPrice);
    }),
  ];
  return { patternType: 'flat', direction, mode: 'expanded', label: '扩散平台形（Expanded Flat）', rules, guidelines: [] };
}

// 书 §5.4.3 顺势平台形：b运行总量>a，c不超过a终点但与a重叠（外观像菱形）
function buildRunningFlatManual(direction) {
  const isUp = direction === 'up';
  const rules = [...flatBaseRules(direction),
    makeJudge('flat-running.ratio.b-gt-a', 'ratio', '顺势平台形：b浪运行总量>a浪', (ctx) => {
      const { aM, bM } = flatMeasures(ctx, direction);
      return normRange(safeRatio(bM.gross, aM.gross), 1.0, Infinity);
    }, { basis: 'gross' }),
    makeJudge('flat-running.pattern.c-not-exceed-a-end', 'pattern', '顺势平台形：c浪不超过a浪终点', (ctx) => {
      const { p1, p3, aPrice } = flatMeasures(ctx, direction);
      const pass = isUp ? p3.price <= p1.price : p3.price >= p1.price;
      return normGate(pass, absLen(p1, p3), aPrice);
    }),
  ];
  return { patternType: 'flat', direction, mode: 'running', label: '顺势平台形（Running Flat）', rules, guidelines: [] };
}

// ---- 联合形：双重 / 三重横向整理（书 1.7；调整类）----
// w/y/z 须是调整浪（文法承担）；连接段有量化门槛：x 回撤 w 的70%（三重另加 xx 回撤 y 的70%）。

function buildDoubleSidewaysManual(direction) {
  const oppo = direction === 'up' ? 'down' : 'up';
  const rules = [
    makeJudge('sideways-double.ratio.x-retrace-70pct-of-w', 'ratio', 'x浪须回撤w浪运行总量的70%以上', (ctx) => {
      const [p0, p1, p2] = ctx.points;
      const wM = computeMeasures([p0, p1], direction, ctx.candles);
      const xM = computeMeasures([p1, p2], oppo, ctx.candles);
      return normRange(safeRatio(xM.gross, wM.gross), 0.7, Infinity);
    }, { basis: 'gross' }),
  ];
  return { patternType: 'sideways', direction, mode: 'double', label: '双重横向整理（联合形 w-x-y）', rules, guidelines: [] };
}

function buildTripleSidewaysManual(direction) {
  const oppo = direction === 'up' ? 'down' : 'up';
  const rules = [
    makeJudge('sideways-triple.ratio.x-retrace-70pct-of-w', 'ratio', 'x浪须回撤w浪运行总量的70%以上', (ctx) => {
      const [p0, p1, p2] = ctx.points;
      const wM = computeMeasures([p0, p1], direction, ctx.candles);
      const xM = computeMeasures([p1, p2], oppo, ctx.candles);
      return normRange(safeRatio(xM.gross, wM.gross), 0.7, Infinity);
    }, { basis: 'gross' }),
    makeJudge('sideways-triple.ratio.xx-retrace-70pct-of-y', 'ratio', 'xx浪须回撤y浪运行总量的70%以上', (ctx) => {
      const [, , p2, p3, p4] = ctx.points;
      const yM = computeMeasures([p2, p3], direction, ctx.candles);
      const xxM = computeMeasures([p3, p4], oppo, ctx.candles);
      return normRange(safeRatio(xxM.gross, yM.gross), 0.7, Infinity);
    }, { basis: 'gross' }),
  ];
  return { patternType: 'sideways', direction, mode: 'triple', label: '三重横向整理（联合形 w-x-y-xx-z）', rules, guidelines: [] };
}

// ---- 收缩三角形（书 06 章；调整类，a-b-c-d-e，扩散三角形书 6.1 明说不存在）----

// 收缩三角形（书 §6.2 完整转录）。a-b-c-d-e，各腿 price=absLen。
// 子浪类型（a/b锯齿类等）与"子浪的子浪运行总量<105%"需子结构，暂标 TODO。
function buildContractingTriangleManual(direction) {
  const legs = (pts) => [absLen(pts[0], pts[1]), absLen(pts[1], pts[2]), absLen(pts[2], pts[3]), absLen(pts[3], pts[4]), absLen(pts[4], pts[5])];

  const rules = [
    makeJudge('triangle.pattern.longest-is-a-or-b', 'pattern', '最长子浪只能是a或b（c/d/e 不能最长）', (ctx) => {
      const [w1, w2, w3, w4, w5] = legs(ctx.points);
      const cap = Math.max(w1, w2);
      const pass = w3 <= cap && w4 <= cap && w5 <= cap;
      const margin = Math.max(0, w3 - cap) + Math.max(0, w4 - cap) + Math.max(0, w5 - cap);
      return normGate(pass, margin, cap || 1);
    }),
    makeJudge('triangle.pattern.e-within-a-range', 'pattern', 'e浪终点必须回到a浪价格区域内', (ctx) => {
      const [p0, p1] = ctx.points;
      const p5 = ctx.points[5];
      const aLo = Math.min(p0.price, p1.price);
      const aHi = Math.max(p0.price, p1.price);
      const pass = p5.price >= aLo && p5.price <= aHi;
      const margin = pass ? 0 : Math.min(Math.abs(p5.price - aLo), Math.abs(p5.price - aHi));
      return normGate(pass, margin, absLen(p0, p1) || 1);
    }),
    makeJudge('triangle.ratio.b-vs-a', 'ratio', 'b浪价格须≥a浪50%且<a浪2倍', (ctx) => {
      const [w1, w2] = legs(ctx.points);
      return normRange(safeRatio(w2, w1), 0.5, 2.0);
    }, { basis: 'price' }),
    makeJudge('triangle.ratio.c-vs-b', 'ratio', 'c浪价格须<b浪且≥b浪50%', (ctx) => {
      const [, w2, w3] = legs(ctx.points);
      return normRange(safeRatio(w3, w2), 0.5, 1.0);
    }, { basis: 'price' }),
    makeJudge('triangle.ratio.d-vs-c', 'ratio', 'd浪价格须≤c浪且≥c浪50%', (ctx) => {
      const [, , w3, w4] = legs(ctx.points);
      return normRange(safeRatio(w4, w3), 0.5, 1.0);
    }, { basis: 'price' }),
    makeJudge('triangle.ratio.e-vs-d', 'ratio', 'e浪价格须<d浪且≥d浪25%', (ctx) => {
      const [, , , w4, w5] = legs(ctx.points);
      return normRange(safeRatio(w5, w4), 0.25, 1.0);
    }, { basis: 'price' }),
    makeJudge('triangle.time.d-le-4c', 'time', 'd浪时间≤c浪4倍', (ctx) => {
      const [, , p2, p3, p4] = ctx.points;
      return normRange(legIndexTime(p3, p4) / legIndexTime(p2, p3), 0, 4);
    }),
    makeJudge('triangle.time.e-le-4c', 'time', 'e浪时间≤c浪4倍', (ctx) => {
      const [, , p2, p3, p4] = ctx.points;
      const p5 = ctx.points[5];
      return normRange(legIndexTime(p4, p5) / legIndexTime(p2, p3), 0, 4);
    }),
  ];

  const guidelines = [
    makeJudge('triangle.guide.618-pair', 'ratio', '通常有一对同向浪比例约61.8%（c/a 或 d/b）', (ctx) => {
      const [w1, w2, w3, w4] = legs(ctx.points);
      const rca = Math.abs(safeRatio(w3, w1) || 0);
      const rdb = Math.abs(safeRatio(w4, w2) || 0);
      return { pass: Math.abs(rca - 0.618) < 0.1 || Math.abs(rdb - 0.618) < 0.1, overshoot: 0 };
    }, { kind: 'guideline' }),
    makeJudge('triangle.guide.e-retrace-70-of-d', 'ratio', 'e浪通常回撤d浪的70%', (ctx) => {
      const [, , , w4, w5] = legs(ctx.points);
      const r = Math.abs(safeRatio(w5, w4) || 0);
      return { pass: Math.abs(r - 0.7) < 0.15, overshoot: 0 };
    }, { kind: 'guideline' }),
  ];

  return { patternType: 'triangle', direction, mode: 'contracting', label: '收缩三角形（a-b-c-d-e）', rules, guidelines };
}

// ---- 双锯齿 / 三锯齿（书 07 章；调整类）----
// 与联合形的区别：w/y/z 腿须**自身恰好是单锯齿**（文法用具体形态 'zigzag' 约束），
// 故本手册自身几乎无量化规则，全靠文法；只留一条量级指引。

// 「y浪不能既价格>x价格N倍，又时间>x时间N倍」复合规则的越界度量
function notBothBeyond(priceRatio, timeRatio, mult) {
  const fail = priceRatio > mult && timeRatio > mult;
  const over = fail ? Math.min((priceRatio - mult) / mult, (timeRatio - mult) / mult) : 0;
  return normGate(!fail, over, 1);
}

// 双锯齿（书 §7.1 完整转录）。结构类规则（w须单锯齿、x任意调整）由文法承担；
// 「w的c浪不能失败 / 相邻子浪不同时5浪衰竭」需子浪内部结构，暂标 TODO 待接。
function buildDoubleZigzagManual(direction) {
  const rules = [
    makeJudge('zigzag-double.ratio.x-retrace-20-100', 'ratio', 'x浪价格须回撤w浪价格的20%~100%', (ctx) => {
      const [p0, p1, p2] = ctx.points;
      return normRange(safeRatio(absLen(p1, p2), absLen(p0, p1)), 0.2, 1.0);
    }, { basis: 'price' }),
    makeJudge('zigzag-double.ratio.y-vs-w-0.9-5', 'ratio', 'y浪价格须>w浪90%且<w浪5倍', (ctx) => {
      const [p0, p1, p2, p3] = ctx.points;
      return normRange(safeRatio(absLen(p2, p3), absLen(p0, p1)), 0.9, 5);
    }, { basis: 'price' }),
    makeJudge('zigzag-double.ratio.y-gt-x', 'ratio', 'y浪价格须大于x浪价格的1倍', (ctx) => {
      const [, p1, p2, p3] = ctx.points;
      return normRange(safeRatio(absLen(p2, p3), absLen(p1, p2)), 1.0, Infinity);
    }, { basis: 'price' }),
    makeJudge('zigzag-double.time.x-lt-5w', 'time', 'x浪时间≤w浪5倍', (ctx) => {
      const [p0, p1, p2] = ctx.points;
      return normRange(legIndexTime(p1, p2) / legIndexTime(p0, p1), 0, 5);
    }),
    makeJudge('zigzag-double.time.y-lt-5w', 'time', 'y浪时间≤w浪5倍', (ctx) => {
      const [p0, p1, p2, p3] = ctx.points;
      return normRange(legIndexTime(p2, p3) / legIndexTime(p0, p1), 0, 5);
    }),
    makeJudge('zigzag-double.time.y-not-both-5x', 'time', 'y浪不能既价格>x浪5倍又时间>x浪5倍', (ctx) => {
      const [, p1, p2, p3] = ctx.points;
      const rp = safeRatio(absLen(p2, p3), absLen(p1, p2)) || 0;
      const rt = legIndexTime(p2, p3) / legIndexTime(p1, p2);
      return notBothBeyond(rp, rt, 5);
    }),
  ];
  const guidelines = [
    makeJudge('zigzag-double.guide.x-retrace-30-70', 'ratio', 'x浪通常回撤w浪的30%~70%', (ctx) => {
      const [p0, p1, p2] = ctx.points;
      const r = safeRatio(absLen(p1, p2), absLen(p0, p1));
      return { pass: r !== null && r >= 0.3 && r <= 0.7, overshoot: 0 };
    }, { kind: 'guideline' }),
    makeJudge('zigzag-double.guide.y-near-w-or-1.618', 'ratio', 'y浪价格倾向=w浪或1.618倍w浪', (ctx) => {
      const [p0, p1, p2, p3] = ctx.points;
      const r = Math.abs(safeRatio(absLen(p2, p3), absLen(p0, p1)) || 0);
      return { pass: Math.abs(r - 1) < 0.15 || Math.abs(r - 1.618) < 0.2, overshoot: 0 };
    }, { kind: 'guideline' }),
    makeJudge('zigzag-double.guide.x-time-window', 'time', 'x浪时间通常介于w浪的61.8%~161.8%', (ctx) => {
      const [p0, p1, p2] = ctx.points;
      const r = legIndexTime(p1, p2) / legIndexTime(p0, p1);
      return { pass: r >= 0.618 && r <= 1.618, overshoot: 0 };
    }, { kind: 'guideline' }),
  ];
  return { patternType: 'zigzag', direction, mode: 'double', label: '双锯齿（Double Zigzag w-x-y）', rules, guidelines };
}

// 三锯齿（书 §7.1 完整转录）。w/y/z 须单锯齿、x/xx 任意调整 → 文法承担。
function buildTripleZigzagManual(direction) {
  const rules = [
    makeJudge('zigzag-triple.ratio.x-retrace-20-100', 'ratio', 'x浪价格须回撤w浪价格的20%~100%', (ctx) => {
      const [p0, p1, p2] = ctx.points;
      return normRange(safeRatio(absLen(p1, p2), absLen(p0, p1)), 0.2, 1.0);
    }, { basis: 'price' }),
    makeJudge('zigzag-triple.ratio.y-vs-w-0.9-5', 'ratio', 'y浪价格须>w浪90%且<w浪5倍', (ctx) => {
      const [p0, p1, p2, p3] = ctx.points;
      return normRange(safeRatio(absLen(p2, p3), absLen(p0, p1)), 0.9, 5);
    }, { basis: 'price' }),
    makeJudge('zigzag-triple.ratio.y-gt-x', 'ratio', 'y浪价格须大于x浪价格的1倍', (ctx) => {
      const [, p1, p2, p3] = ctx.points;
      return normRange(safeRatio(absLen(p2, p3), absLen(p1, p2)), 1.0, Infinity);
    }, { basis: 'price' }),
    makeJudge('zigzag-triple.ratio.xx-retrace-20-100', 'ratio', 'xx浪价格须回撤y浪价格的20%~100%', (ctx) => {
      const [, , p2, p3, p4] = ctx.points;
      return normRange(safeRatio(absLen(p3, p4), absLen(p2, p3)), 0.2, 1.0);
    }, { basis: 'price' }),
    makeJudge('zigzag-triple.ratio.z-vs-xx-y-w', 'ratio', 'z浪须≥xx浪1倍、<y浪5倍、<w浪5倍', (ctx) => {
      const [p0, p1, p2, p3, p4, p5] = ctx.points;
      const z = absLen(p4, p5);
      const r1 = normRange(safeRatio(z, absLen(p3, p4)), 1.0, Infinity);
      const r2 = normRange(safeRatio(z, absLen(p2, p3)), 0, 5);
      const r3 = normRange(safeRatio(z, absLen(p0, p1)), 0, 5);
      return { pass: r1.pass && r2.pass && r3.pass, overshoot: r1.overshoot + r2.overshoot + r3.overshoot };
    }, { basis: 'price' }),
    makeJudge('zigzag-triple.time.x-lt-5w', 'time', 'x浪时间≤w浪5倍', (ctx) => {
      const [p0, p1, p2] = ctx.points;
      return normRange(legIndexTime(p1, p2) / legIndexTime(p0, p1), 0, 5);
    }),
    makeJudge('zigzag-triple.time.y-lt-5w', 'time', 'y浪时间≤w浪5倍', (ctx) => {
      const [p0, p1, p2, p3] = ctx.points;
      return normRange(legIndexTime(p2, p3) / legIndexTime(p0, p1), 0, 5);
    }),
    makeJudge('zigzag-triple.time.z-lt-5w-5y', 'time', 'z浪时间≤w浪5倍且≤y浪5倍', (ctx) => {
      const [p0, p1, p2, p3, p4, p5] = ctx.points;
      const tz = legIndexTime(p4, p5);
      const ra = normRange(tz / legIndexTime(p0, p1), 0, 5);
      const rb = normRange(tz / legIndexTime(p2, p3), 0, 5);
      return { pass: ra.pass && rb.pass, overshoot: ra.overshoot + rb.overshoot };
    }),
    makeJudge('zigzag-triple.time.y-not-both-5x', 'time', 'y浪不能既价格>x浪5倍又时间>x浪5倍', (ctx) => {
      const [, p1, p2, p3] = ctx.points;
      return notBothBeyond(safeRatio(absLen(p2, p3), absLen(p1, p2)) || 0, legIndexTime(p2, p3) / legIndexTime(p1, p2), 5);
    }),
    makeJudge('zigzag-triple.time.z-not-both-5xx', 'time', 'z浪不能既价格>xx浪5倍又时间>xx浪5倍', (ctx) => {
      const [, , , p3, p4, p5] = ctx.points;
      return notBothBeyond(safeRatio(absLen(p4, p5), absLen(p3, p4)) || 0, legIndexTime(p4, p5) / legIndexTime(p3, p4), 5);
    }),
  ];
  const guidelines = [
    makeJudge('zigzag-triple.guide.x-retrace-30-70', 'ratio', 'x浪通常回撤w浪的30%~70%', (ctx) => {
      const [p0, p1, p2] = ctx.points;
      const r = safeRatio(absLen(p1, p2), absLen(p0, p1));
      return { pass: r !== null && r >= 0.3 && r <= 0.7, overshoot: 0 };
    }, { kind: 'guideline' }),
    makeJudge('zigzag-triple.guide.xx-retrace-30-70', 'ratio', 'xx浪通常回撤y浪的30%~70%', (ctx) => {
      const [, , p2, p3, p4] = ctx.points;
      const r = safeRatio(absLen(p3, p4), absLen(p2, p3));
      return { pass: r !== null && r >= 0.3 && r <= 0.7, overshoot: 0 };
    }, { kind: 'guideline' }),
  ];
  return { patternType: 'zigzag', direction, mode: 'triple', label: '三锯齿（Triple Zigzag w-x-y-xx-z）', rules, guidelines };
}

// ============================================================
// 4. 形态注册表（Q8 全形态竞争的候选集） + 文法（Q2 父浪限定子浪类别）
// ============================================================
//
// 每个形态声明：类别(klass: driving|corrective)、点数(points)、类型序列(seq)、
// 各腿子浪应有的类别(childRoles)、手册构造器。klass 决定它能否被某个角色采用；
// childRoles 决定递归拆解每条腿时的可选假设集——这就是「级别涌现」的机制。

const DRIVING = 'driving';
const CORRECTIVE = 'corrective';

function seqOf(direction, points) {
  const up = direction === 'up';
  const first = up ? 'L' : 'H';
  const arr = [];
  for (let i = 0; i < points; i += 1) arr.push(i % 2 === 0 ? first : (first === 'L' ? 'H' : 'L'));
  return arr;
}

// 几何交替校验：内部宏观点必须是相邻宏观点里的真极值——H 高于左右相邻、L 低于左右相邻。
// 类型交替(H/L)不足以保证方向真反转：下跌途中的"更低的高点(lower-high)"被选作连接浪的
// 向上目标时，"L→H"这条腿反而在下降，形态方向反了却仍过类型检查。这类骨架非近失、是结构
// 无效（连接浪/回撤浪没真正反向），须硬淘汰。所有合法形态（含收缩/扩散三角、扩散平台）都满足此式。
function macroAlternates(pts) {
  if (!Array.isArray(pts) || pts.length < 3) return true;
  for (let i = 1; i < pts.length - 1; i += 1) {
    const p = pts[i];
    if (p.type === 'H') {
      if (!(p.price > pts[i - 1].price && p.price > pts[i + 1].price)) return false;
    } else if (!(p.price < pts[i - 1].price && p.price < pts[i + 1].price)) return false;
  }
  return true;
}

// 宏观腿端点须为跨度内真极值（macro-endpoint-span-extreme）：每个内部宏观点，须是其左右相邻
// 宏观点之间那一段 segFine 细枢轴里的真极值——去 H 的严格高于窗口内每个细枢轴、去 L 的严格
// 低于。堵住"用更低的高点/更高的低点当端点、把真极值埋进腿里"的退化骨架（如 a 段收在 65705、
// 内部却藏着更高的 66924）。比 macroAlternates 更强并包含它（相邻宏观点也在窗口内）。
function legEndpointsSpanExtreme(pts, segFine) {
  if (!Array.isArray(pts) || pts.length < 3 || !Array.isArray(segFine)) return true;
  for (let i = 1; i < pts.length - 1; i += 1) {
    const p = pts[i];
    const lo = pts[i - 1].index;
    const hi = pts[i + 1].index;
    for (const f of segFine) {
      if (f.index <= lo || f.index >= hi) continue;
      if (p.type === 'H') { if (f.price > p.price) return false; }
      else if (f.price < p.price) return false;
    }
  }
  return true;
}

const PATTERNS = [
  {
    id: 'impulse-strict', klass: DRIVING, points: 6,
    childRoles: [DRIVING, CORRECTIVE, DRIVING, CORRECTIVE, DRIVING],
    build: (dir) => buildImpulseStrictManual(dir),
  },
  {
    id: 'diagonal', klass: DRIVING, points: 6,
    childRoles: [DRIVING, CORRECTIVE, DRIVING, CORRECTIVE, DRIVING],
    build: (dir) => buildDiagonalManual(dir, 'ending'),
  },
  {
    id: 'zigzag', klass: CORRECTIVE, points: 4,
    childRoles: [DRIVING, CORRECTIVE, DRIVING],
    build: (dir) => buildZigzagManual(dir),
  },
  {
    id: 'flat', klass: CORRECTIVE, points: 4,
    childRoles: [CORRECTIVE, CORRECTIVE, DRIVING],
    build: (dir) => buildFlatManual(dir),
  },
  // 书 05 章：平台形三子类（a/b 调整、c 驱动）。
  {
    id: 'flat-regular', klass: CORRECTIVE, points: 4,
    childRoles: [CORRECTIVE, CORRECTIVE, DRIVING],
    build: (dir) => buildRegularFlatManual(dir),
  },
  {
    id: 'flat-expanded', klass: CORRECTIVE, points: 4,
    childRoles: [CORRECTIVE, CORRECTIVE, DRIVING],
    build: (dir) => buildExpandedFlatManual(dir),
  },
  {
    id: 'flat-running', klass: CORRECTIVE, points: 4,
    childRoles: [CORRECTIVE, CORRECTIVE, DRIVING],
    build: (dir) => buildRunningFlatManual(dir),
  },
  // 书 07 章：双/三锯齿。w/y/z 腿须「自身是单锯齿」→ 文法用具体形态 'zigzag' 约束。
  {
    id: 'zigzag-double', klass: CORRECTIVE, points: 4,
    childRoles: ['zigzag', CORRECTIVE, 'zigzag'],
    build: (dir) => buildDoubleZigzagManual(dir),
  },
  {
    id: 'zigzag-triple', klass: CORRECTIVE, points: 6,
    childRoles: ['zigzag', CORRECTIVE, 'zigzag', CORRECTIVE, 'zigzag'],
    build: (dir) => buildTripleZigzagManual(dir),
  },
  // 书 1.7：联合形（双/三重横向整理）。w/y/z 为任意调整浪，连接段有 70% 门槛。
  {
    id: 'sideways-double', klass: CORRECTIVE, points: 4,
    childRoles: [CORRECTIVE, CORRECTIVE, CORRECTIVE],
    build: (dir) => buildDoubleSidewaysManual(dir),
  },
  {
    id: 'sideways-triple', klass: CORRECTIVE, points: 6,
    childRoles: [CORRECTIVE, CORRECTIVE, CORRECTIVE, CORRECTIVE, CORRECTIVE],
    build: (dir) => buildTripleSidewaysManual(dir),
  },
  // 书 06 章：收缩三角形 a-b-c-d-e（各腿均为调整浪）。
  {
    id: 'triangle', klass: CORRECTIVE, points: 6,
    childRoles: [CORRECTIVE, CORRECTIVE, CORRECTIVE, CORRECTIVE, CORRECTIVE],
    build: (dir) => buildContractingTriangleManual(dir),
  },
];

const MIN_POINTS = {
  [DRIVING]: Math.min(...PATTERNS.filter((p) => p.klass === DRIVING).map((p) => p.points)),
  [CORRECTIVE]: Math.min(...PATTERNS.filter((p) => p.klass === CORRECTIVE).map((p) => p.points)),
};

// 文法角色 → 允许的形态：'driving'/'corrective' 按类别；其它按具体形态 id（如 'zigzag'）。
function patternMatchesRole(pat, role) {
  if (role === DRIVING || role === CORRECTIVE) return pat.klass === role;
  return pat.id === role;
}

function rolePoints(role) {
  if (role === DRIVING || role === CORRECTIVE) return MIN_POINTS[role];
  const p = PATTERNS.find((x) => x.id === role);
  return p ? p.points : 4;
}

// ============================================================
// 5. 切分（Q8 + rank-competing-wave-counts §2）：把一段细枢轴按目标点数 n
//    枚举「显著性短名单 + 交替子序列」多套合法切分，交给 decompose 逐套打分排名。
// ============================================================
//
// 交替序列（首尾类型固定）长度与 n 同奇偶；旧版每次删掉一对「最小振幅的内部相邻枢轴」
// 贪心坍缩到 n，只回一种切分——搜索空间=1，可能漏掉更优的宏观分法（如把某个大摆动
// 误当噪音坍缩掉）。coarsenByPairs 保留作为兜底，segmentations() 改为多解枚举。

function coarsenByPairs(segFine, n) {
  if (segFine.length < n) return null;
  if ((segFine.length - n) % 2 !== 0) return null;
  const arr = segFine.slice();
  // 保护全段的全局最高/最低枢轴：它们几乎必是浪型的关键拐点，不该在坍缩中被当噪音删掉
  // （修「全局最低 57717 被 6 点坍缩吞掉」这类与边界 126296 同类的极值丢失）。
  let hiI = 0;
  let loI = 0;
  for (let i = 1; i < arr.length; i += 1) {
    if (arr[i].price > arr[hiI].price) hiI = i;
    if (arr[i].price < arr[loI].price) loI = i;
  }
  const protHi = arr[hiI];
  const protLo = arr[loI];
  const isProtected = (p) => p === protHi || p === protLo;
  while (arr.length > n) {
    let bestI = -1;
    let bestAmp = Infinity;
    let fbI = -1; // 兜底：若无法在不动极值的前提下坍缩，则允许删最小对
    let fbAmp = Infinity;
    for (let i = 1; i + 1 <= arr.length - 2; i += 1) {
      const amp = Math.abs(arr[i].price - arr[i + 1].price);
      if (amp < fbAmp) { fbAmp = amp; fbI = i; }
      if (isProtected(arr[i]) || isProtected(arr[i + 1])) continue;
      if (amp < bestAmp) { bestAmp = amp; bestI = i; }
    }
    const rm = bestI >= 0 ? bestI : fbI;
    if (rm < 0) return null;
    arr.splice(rm, 2);
  }
  return arr;
}

// 摆动显著性（拓扑存活序）：复用 coarsenByPairs 同一套「反复删相邻振幅最小对」的
// 贪心化简，但不停在目标点数 n，一路做到只剩首尾，并记录每个内部枢轴被删除的次序。
// 存活越久（越晚被删）代表在全局拓扑上越显著——这比「只看紧邻两侧的价格落差」更稳健：
// 后者是纯局部量度，会把 97963/82814 这类全局关键拐点误判为不显著（若其紧邻枢轴恰好
// 很近），反而让无关紧要的小反弹挤进短名单、产出不合理的宏观切分。
function significanceRank(segFine) {
  const rankByIdx = new Map();
  const n = segFine.length;
  if (n <= 2) return rankByIdx;
  const arr = segFine.map((p, idx) => ({ price: p.price, idx }));
  let hiI = 0;
  let loI = 0;
  for (let i = 1; i < arr.length; i += 1) {
    if (arr[i].price > arr[hiI].price) hiI = i;
    if (arr[i].price < arr[loI].price) loI = i;
  }
  const protHi = arr[hiI];
  const protLo = arr[loI];
  const isProtected = (x) => x === protHi || x === protLo;
  let step = 0;
  while (arr.length > 2) {
    let bestI = -1;
    let bestAmp = Infinity;
    let fbI = -1;
    let fbAmp = Infinity;
    for (let i = 1; i + 1 <= arr.length - 2; i += 1) {
      const amp = Math.abs(arr[i].price - arr[i + 1].price);
      if (amp < fbAmp) { fbAmp = amp; fbI = i; }
      if (isProtected(arr[i]) || isProtected(arr[i + 1])) continue;
      if (amp < bestAmp) { bestAmp = amp; bestI = i; }
    }
    const rm = bestI >= 0 ? bestI : fbI;
    if (rm < 0) break;
    rankByIdx.set(arr[rm].idx, step);
    rankByIdx.set(arr[rm + 1].idx, step);
    arr.splice(rm, 2);
    step += 1;
  }
  for (const x of arr) rankByIdx.set(x.idx, Infinity); // 存活到最后（含首尾、被保护极值）= 最高显著性
  return rankByIdx;
}

const SEG_SHORTLIST_M = 12; // 显著性短名单上限：约束组合规模的护栏（design §2.2）
const SEG_MAX_COMBOS = 60; // 单次 segmentations 调用返回的组合数上限（性能护栏）

// 显著性短名单：内部枢轴（不含首尾）按拓扑存活序取前 M 个，恒并入全局最高/最低
// （它们几乎必是关键拐点，不该被坍缩当噪音丢弃）。按原始时间序（索引升序）返回。
function significantShortlist(segFine, maxM) {
  const n = segFine.length;
  if (n <= 2) return [];
  const internal = [];
  for (let i = 1; i < n - 1; i += 1) internal.push(i);
  if (internal.length <= maxM) return internal;

  let hiI = internal[0];
  let loI = internal[0];
  for (const i of internal) {
    if (segFine[i].price > segFine[hiI].price) hiI = i;
    if (segFine[i].price < segFine[loI].price) loI = i;
  }
  const picked = new Set([hiI, loI]);
  const rankByIdx = significanceRank(segFine);
  const ranked = internal
    .filter((i) => !picked.has(i))
    .sort((a, b) => (rankByIdx.get(b) ?? -1) - (rankByIdx.get(a) ?? -1));
  for (const i of ranked) {
    if (picked.size >= maxM) break;
    picked.add(i);
  }
  return Array.from(picked).sort((a, b) => a - b);
}

// 在已按原始顺序排好的候选索引里，穷举所有「恰选 k 个、保持相对顺序」的组合。
function indexCombinations(idxArr, k) {
  const out = [];
  const n = idxArr.length;
  if (k < 0 || k > n) return out;
  if (k === 0) return [[]];
  const combo = [];
  const go = (start) => {
    if (combo.length === k) { out.push(combo.slice()); return; }
    for (let i = start; i <= n - (k - combo.length); i += 1) {
      combo.push(idxArr[i]);
      go(i + 1);
      combo.pop();
    }
  };
  go(0);
  return out;
}

/**
 * 宏观分段（rank-competing-wave-counts §2）：显著性短名单 + 交替子序列穷举，产出
 * 多套合法切分交给 decompose 逐套打分排名（下游 scoreCandidate/compareCandidates/
 * beam 原样复用，不改契约）。首尾固定；内部从短名单选 n-2 个、保持时间序；只留
 * 与首点类型交替相符的组合——细枢轴本就严格交替，故等价于「相邻所选点在原数组中
 * 的索引间隔为奇数」。按组合内枢轴显著性之和降序截断到 SEG_MAX_COMBOS。
 * 旧贪心坍缩结果始终作为兜底纳入（短名单枚举为空时不回退到空结果）。
 */
function segmentations(segFine, n) {
  if (segFine.length === n) return [segFine.slice()];
  if (segFine.length < n) return [];

  const k = n - 2;
  const lastIdx = segFine.length - 1;
  const shortlist = significantShortlist(segFine, SEG_SHORTLIST_M);
  const rankByIdx = significanceRank(segFine);
  const seen = new Set();
  const scored = [];

  if (k >= 0 && shortlist.length >= k) {
    for (const idxCombo of indexCombinations(shortlist, k)) {
      let ok = true;
      let prev = 0;
      for (const i of idxCombo) {
        if ((i - prev) % 2 === 0) { ok = false; break; }
        prev = i;
      }
      if (ok && (lastIdx - prev) % 2 === 0) ok = false; // 末段间隔也须为奇数
      if (!ok) continue;

      const pts = [segFine[0], ...idxCombo.map((i) => segFine[i]), segFine[lastIdx]];
      const key = pts.map((p) => p.index).join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      const sig = idxCombo.reduce((s, i) => s + Math.min(rankByIdx.get(i) ?? 0, 1e6), 0);
      scored.push({ pts, sig });
    }
  }

  scored.sort((a, b) => b.sig - a.sig);
  const results = scored.slice(0, SEG_MAX_COMBOS).map((x) => x.pts);

  // 兜底：原贪心坍缩结果始终纳入，防短名单枚举为空、也保持既有行为不回退
  const greedy = coarsenByPairs(segFine, n);
  if (greedy) {
    const key = greedy.map((p) => p.index).join(',');
    if (!seen.has(key)) results.push(greedy);
  }

  return results;
}

function sliceFine(segFine, a, b) {
  const lo = Math.min(a.index, b.index);
  const hi = Math.max(a.index, b.index);
  return segFine.filter((p) => p.index >= lo && p.index <= hi);
}

// 书 3.16 特例：收缩三角形的「运行总量」= 其最长一个子浪的最高点到最低点的价差，
// 而非整段的高低差（通用 computeMeasures 的定义）。用于纠正三角形节点的 gross 口径。
function triangleGross(points, candles) {
  if (!Array.isArray(points) || points.length < 2) return null;
  let fromIdx = points[0].index;
  let toIdx = points[1].index;
  let longest = -1;
  for (let i = 0; i < points.length - 1; i += 1) {
    const len = absLen(points[i], points[i + 1]);
    if (len > longest) { longest = len; fromIdx = points[i].index; toIdx = points[i + 1].index; }
  }
  const ext = rangeExtreme(candles, fromIdx, toIdx);
  return Number.isFinite(ext.maxHigh) && Number.isFinite(ext.minLow) ? ext.maxHigh - ext.minLow : null;
}

// ============================================================
// 5.5 跨级别指引（Q11=b：tier4 平局裁决）+ 量能注记（Q16=b：仅注记）
// ============================================================
//
// tier4 用「建树后才能查」的软判别：需要子树信息（交替）或多腿几何（浪个性）。
// 只在 tier1–tier3 持平时影响排序，不动摇硬规则主序。

/**
 * 跨级别指引命中数（越多越优）。当前实现两条可计算项：
 *   · 浪个性（Q15=b）：推动浪的 3 浪最强（幅度≥1、5 浪）。
 *   · 交替（书 1.7）：以子形态族区分——2 浪与 4 浪拆解出的形态族不同即视为交替。
 */
function crossDegreeHits(candidate) {
  let hits = 0;
  const pts = candidate.points;
  const isImpulseFamily = candidate.patternId === 'impulse-strict' || candidate.patternId === 'diagonal';

  if (isImpulseFamily && pts.length >= 6) {
    const w1 = absLen(pts[0], pts[1]);
    const w3 = absLen(pts[2], pts[3]);
    const w5 = absLen(pts[4], pts[5]);
    if (w3 >= w1 && w3 >= w5) hits += 1; // 3浪最强

    const fam = (n) => (n && !n.isLeaf && n.primary ? n.primary.patternId : null);
    const f2 = fam(candidate.children[1]);
    const f4 = fam(candidate.children[3]);
    if (f2 && f4 && f2 !== f4) hits += 1; // 2/4浪交替（子形态族不同）
  }

  return hits;
}

function avgVol(candles, i0, i1) {
  let s = 0;
  let n = 0;
  for (let i = Math.min(i0, i1); i <= Math.max(i0, i1); i += 1) {
    const c = candles[i];
    if (c && Number.isFinite(c.volume)) { s += c.volume; n += 1; }
  }
  return n ? s / n : null;
}

/**
 * 量能注记（不参与评分，Q16=b）：推动浪 3 浪均量与 1 浪均量的配合/背离。
 */
function volumeNote(candidate, candles) {
  const isImpulseFamily = candidate.patternId === 'impulse-strict' || candidate.patternId === 'diagonal';
  if (!isImpulseFamily || candidate.points.length < 6) return null;
  const p = candidate.points;
  const v1 = avgVol(candles, p[0].index, p[1].index);
  const v3 = avgVol(candles, p[2].index, p[3].index);
  if (v1 == null || v3 == null || v1 === 0) return null;
  return v3 > v1 ? '量能配合：3浪均量>1浪' : '量能背离：3浪均量≤1浪';
}

// ============================================================
// 6. 递归拆解引擎（Q2 + Q8 + Q7 + Q12）
// ============================================================
//
// decompose 对一段细枢轴（含首尾、交替）在 allowedClasses 限定下全形态竞争，
// 每形态按需点数切分、评分，并递归拆每条腿（文法：childRoles 限定子浪类别）。
// 子腿若能拆但其最优（受限类别）仍带违规 → 记一次文法违规并入父级 tier1（硬约束）。
// 子腿数据不足以成形（末级）→ 叶子，不计违规（Q3=b 宽容：数据不足不证伪）。

function leafNode(segFine, role) {
  return { isLeaf: true, segFine, role, primary: null, alternates: [], label: '末级/不可再分' };
}

/**
 * 子浪结构判定：对一条腿分别按「驱动(五浪)」和「调整(三波)」各拆一次、比较拟合，
 * 得出这条腿的真实性格。这是「a浪(须驱动) 还是 W浪(须调整)」下定论的关键——
 * 不再只问"能不能凑成所需角色"，而是问"它本质更像五浪还是三波"。
 */
function legCharacter(legFine, candles, depth, opts) {
  const asCorr = decompose(legFine, candles, [CORRECTIVE], depth, opts);
  const asDrv = legFine.length >= MIN_POINTS[DRIVING]
    ? decompose(legFine, candles, [DRIVING], depth, opts) : null;
  const cS = asCorr && !asCorr.isLeaf && asCorr.primary ? asCorr.primary.score : null;
  const dS = asDrv && !asDrv.isLeaf && asDrv.primary ? asDrv.primary.score : null;
  // 「能干净地走成五浪」即是驱动性（书：合法的5浪计数=推动）；仅当它当不成干净五浪时，
  // 才考虑调整性——否则规则稀少的6点调整形态会把干净推动腿误判成调整。
  const dClean = dS && dS.tier1 === 0;
  const cClean = cS && cS.tier1 === 0;
  let character = null;
  if (dClean) character = 'driving';
  else if (cClean) character = 'corrective';
  else if (dS && cS) character = compareCandidates(dS, cS) <= 0 ? 'driving' : 'corrective';
  else if (dS) character = 'driving';
  else if (cS) character = 'corrective';
  // canDrive/canCorrect（grammar-role-fulfillment）：这条腿「能否胜任」某角色 = 该方向存在
  // 干净拆解（tier1=0）。文法判定用它，而非「最佳性格 character」——歧义腿（两者都干净）应能
  // 胜任任一角色，不因「驱动优先」的 character 在调整位被误报违规。
  return { character, drivingNode: asDrv, correctiveNode: asCorr, canDrive: !!dClean, canCorrect: !!cClean };
}

// 文法违规判据（grammar-role-fulfillment §2）：这条腿是否「无法胜任」所需角色。
// 胜任 = 所需方向存在干净拆解（canDrive/canCorrect）。歧义腿（两者都干净）胜任任一角色→不违规。
// 仅当所需方向拆不干净时才违规；当两方向都拆不干净时，退回旧口径（用最佳性格 character 判），
// 避免「腿本身成不了任何干净结构」时漏判。
function grammarViolatesRole(lc, requiredChar) {
  if (!lc) return false;
  if (lc.canDrive || lc.canCorrect) {
    return requiredChar === 'driving' ? !lc.canDrive : !lc.canCorrect;
  }
  return !!(lc.character && lc.character !== requiredChar);
}

function decompose(segFine, candles, allowedRoles, depth, opts) {
  if (!Array.isArray(segFine) || segFine.length < 2) return leafNode(segFine, allowedRoles[0]);

  // 记忆化（rank-competing-wave-counts §2 的配套修复）：不同顶层候选常共享同一段
  // 子腿区间（如两种分段都会切出「97963→60001」），legCharacter 会对它重复递归。
  // 用「区间起止索引 + 允许角色 + 深度」为键缓存，命中直接复用，同 run 内跨候选共享。
  const cacheKey = opts.cache
    ? `${segFine[0].index}|${segFine[segFine.length - 1].index}|${allowedRoles.join(',')}|${depth}`
    : null;
  if (cacheKey && opts.cache.has(cacheKey)) return opts.cache.get(cacheKey);

  const start = segFine[0];
  const end = segFine[segFine.length - 1];
  const direction = end.price >= start.price ? 'up' : 'down';

  // 终止（Q7）：点数不足以成形任一允许形态 → 叶子
  const minPts = Math.min(...allowedRoles.map((r) => rolePoints(r)));
  if (depth >= opts.maxDepth || segFine.length < minPts) {
    const leaf = leafNode(segFine, allowedRoles[0]);
    if (cacheKey) opts.cache.set(cacheKey, leaf);
    return leaf;
  }

  // 两段式 beam（rank-competing-wave-counts §2 的配套修复）：segmentations() 现在
  // 每形态可回多套切分，若像旧版那样对每个原始候选都先递归展开子树（含 legCharacter
  // 对每条子腿的双向 decompose）再统一排序截断，分支因子会随深度指数级放大、直接 OOM。
  // 改为「先用不含子树的基础分（scoreCandidate 本就不需要子树）做前沿筛选，
  // 只对少数幸存者才展开子树」——标准 beam search 做法，也是 beamK 命名本该有的语义。
  const lite = [];
  for (const pat of PATTERNS) {
    if (!allowedRoles.some((r) => patternMatchesRole(pat, r))) continue;
    const seq = seqOf(direction, pat.points);
    if (start.type !== seq[0] || end.type !== seq[seq.length - 1]) continue;
    if (segFine.length < pat.points) continue;

    for (const pts of segmentations(segFine, pat.points)) {
      if (!pts.every((p, i) => p.type === seq[i])) continue;
      if (!macroAlternates(pts)) continue; // 快筛：淘汰"下降的连接浪"（lower-high 当上冲目标）
      if (!legEndpointsSpanExtreme(pts, segFine)) continue; // 淘汰"端点非跨度极值"（真极值被埋进腿里）

      const measures = computeMeasures(pts, direction, candles);
      // 书 3.16 特例：三角形的运行总量按「最长子浪高低差」口径纠正
      if (pat.id === 'triangle') {
        const tg = triangleGross(pts, candles);
        if (tg != null) measures.gross = tg;
      }
      const ctx = { points: pts, direction, candles, measures };
      const score = scoreCandidate(ctx, pat.build(direction)); // 便宜：不含 grammar/tier4，不需要子树
      score.incompleteness = computeIncompleteness(pts); // 同样便宜（只看 pts），提前计入前沿筛选
      lite.push({ pat, pts, measures, score });
    }
  }

  if (lite.length === 0) {
    const leaf = leafNode(segFine, allowedRoles[0]);
    if (cacheKey) opts.cache.set(cacheKey, leaf);
    return leaf;
  }

  // 前沿筛选：按基础分（tier1/tier2/complexity/tier3，grammar 与 tier4 尚未计入）
  // 粗排，只对前 preRankKeep 名展开子树。grammar 违规只会把 tier1 往上加（不会减），
  // 缓冲区留够余量以降低「基础分领先者被 grammar 反超」时漏选真实最优的概率。
  // 顶层（depth 0）额外放宽：排名数法表要「按形态去重后全列」，需要更多顶层候选原料
  // （rank-competing-wave-counts）。放宽只发生在最外层这一个节点，不进深层递归，
  // 故不会引发分支因子爆炸——指数放大来自深层嵌套，顶层单节点多展开一些是安全的。
  const isTop = depth === 0;
  const preRankKeep = isTop
    ? Math.max((opts.beamK || 3) * 4, 30)
    : Math.max((opts.beamK || 3) * 4, 12);
  const liteSorted = lite
    .slice()
    .sort((a, b) => compareCandidates(
      { ...a.score, tier4: 0, complexity: patternComplexity(a.pat.id) },
      { ...b.score, tier4: 0, complexity: patternComplexity(b.pat.id) },
    ));
  // 顶层（最外层单节点）全量展开所有候选切分——不做 preRankKeep 截断。原因：排名数法表
  // 要「按形态去重后全列」，而每种形态族的「干净代表」用的分点各不相同，且是否干净往往取决于
  // 展开子树后的文法违规（base score 看不出），故必须把每种形态的多个分点都全量打分，才能
  // 稳定找到各族的干净代表。顶层只有一个节点、且 legCharacter 的子腿分解经 opts.cache 大量
  // 共享，378 个候选的实际增量成本有限（实测详见 tasks 4）。深层仍按 preRankKeep 收敛。
  const shortlisted = isTop ? liteSorted : liteSorted.slice(0, preRankKeep);

  const candidates = shortlisted.map(({ pat, pts, measures, score }) => {
    // 文法：逐腿递归拆解（childRoles 可为类别 driving/corrective 或具体形态 id 如 'zigzag'）
    const children = [];
    let grammarViolations = 0;
    const grammarNotes = []; // 文法违规明细（供报告"违规原因"展示，Q2=a）
    const legLabels = waveLabelsFor(pat.id);
    const charCn = (c) => (c === 'driving' ? '驱动浪(五浪)' : '调整浪(三波)');
    for (let i = 0; i < pat.childRoles.length; i += 1) {
      const childFine = sliceFine(segFine, pts[i], pts[i + 1]);
      const childRole = pat.childRoles[i];
      const childMin = rolePoints(childRole);
      if (childFine.length >= childMin && depth + 1 < opts.maxDepth) {
        // 所需性格：driving 角色须五浪；corrective / 具体形态(如 zigzag)须三波
        const requiredChar = childRole === DRIVING ? 'driving' : 'corrective';
        const lc = legCharacter(childFine, candles, depth + 1, opts);
        const childNode = (childRole === DRIVING ? (lc.drivingNode || lc.correctiveNode) : lc.correctiveNode)
          || leafNode(childFine, childRole);
        children.push(childNode);
        // 文法违规（grammar-role-fulfillment）：这条腿「无法胜任」所需角色时才违规——
        // 即所需方向拆不出干净结构。歧义腿（两种都干净）胜任任一角色，不再因驱动优先误报。
        if (grammarViolatesRole(lc, requiredChar)) {
          grammarViolations += 1;
          grammarNotes.push({
            kind: 'grammar',
            desc: `${legLabels[i] || `第${i + 1}腿`} 须为${charCn(requiredChar)}，走不成干净的${charCn(requiredChar)}（更像${charCn(lc.character)}）`,
            overshoot: 0,
          });
        }
      } else {
        children.push(leafNode(childFine, childRole));
      }
    }

    const candidate = {
      patternId: pat.id,
      klass: pat.klass,
      manual: pat.build(direction),
      direction,
      points: pts,
      measures,
      children,
    };
    // tier4 跨级别指引（需 children，故此处计算）；衰竭与量能为注记（不评分）
    const tier4 = crossDegreeHits(candidate);
    const totalTier1 = score.tier1 + grammarViolations;
    // 文法违规带越界权重计入 tier2（structured-wave-report §2.4）：不再让"结构性格不对"
    // 在越界维度白占便宜、平票压过"仅差一丝比例"的候选。
    const totalTier2 = score.tier2 + grammarViolations * GRAMMAR_OVERSHOOT;
    const incompleteness = computeIncompleteness(pts); // 框架A候选恒为0（末点非provisional）
    candidate.score = { ...score, tier1: totalTier1, tier2: totalTier2, grammarViolations, grammarNotes, tier4, incompleteness, complexity: patternComplexity(pat.id), penalized: totalTier1 > 0 };
    candidate.truncated = Number.isFinite(measures.price) && Number.isFinite(measures.gross)
      && measures.price < measures.gross - 1e-6;
    candidate.volumeNote = volumeNote(candidate, candles);
    return candidate;
  });

  const ranked = candidates.slice().sort((a, b) => compareCandidates(a.score, b.score));
  // 顶层保留全部备选（供排名表按形态去重全列，覆盖所有形态族）；序列化时会另行去重截断
  // （dedupeAlternatesForSerialize）以控制 JSON 体积。深层仍按 beamK 收敛，控制树体积与性能。
  const result = {
    isLeaf: false,
    segFine,
    primary: ranked[0],
    alternates: isTop ? ranked.slice(1) : ranked.slice(1, opts.beamK),
  };
  if (cacheKey) opts.cache.set(cacheKey, result);
  return result;
}

// ============================================================
// 6.5 进行中浪与投影层（Q9=a）：标注末浪 + 预期（斐波目标，标注为推断）
// ============================================================
//
// 进行中的判定锚点是边界锚定打上的 provisional 末枢轴：凡某节点主选的末点带 provisional，
// 说明该结构的末浪正落在当前边缘、尚未走完。沿主链的最后一条腿逐层下探，最深处即当前微浪。

/**
 * 投影层（不评分）：给进行中的末腿一个「完成区间」预期。参考浪取该形态第 1 腿的幅度，
 * 以 0.618/1.0/1.618 倍从末腿起点投影。明确标注为推断、非确定。
 */
function computeLegExpectation(from, to, refAmp) {
  const up = to.price >= from.price;
  const amp = refAmp || Math.abs(to.price - from.price);
  const dir = up ? 1 : -1;
  return {
    note: '推断，非确定',
    currentLegDir: up ? 'up' : 'down',
    fibTargets: [0.618, 1.0, 1.618].map((m) => ({ mult: m, price: from.price + dir * amp * m })),
  };
}

function computeExpectation(pattern, k) {
  const pts = pattern.points;
  const refAmp = absLen(pts[0], pts[1]) || Math.abs(pts[k].price - pts[k - 1].price);
  return computeLegExpectation(pts[k - 1], pts[k], refAmp);
}

// 书02章 通道 → 投影层（不评分）：为一个形态节点建艾略特通道，投影下一拐点边界价（作用二），
// 并给完成判定提示（作用一）。复用老模块 buildChannel/channelExitHint。
const CHANNEL_CN = { parallel: '平行', contracting: '收缩', expanding: '扩散' };

// 书03章 3.22 斐波那契时间共振 → 面向未来的「转折时间窗」（投影层，不评分）：
// 从每个枢轴按斐波数列向后（越过当前 K 线）投影潜在转折 K 线，≥2 个枢轴重合的未来日
// 即多源共振时间窗。用等间隔外推时间戳。
const FIB_SEQ = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144];

function fibTimeWindows(finePivots, candles, horizon = 60) {
  if (!Array.isArray(candles) || candles.length < 2 || !Array.isArray(finePivots)) return [];
  const lastIdx = candles.length - 1;
  const interval = (candles[1].timestamp - candles[0].timestamp) || 86400;
  const marks = new Map();
  for (const piv of finePivots) {
    for (const n of FIB_SEQ) {
      const bar = piv.index + n;
      if (bar > lastIdx && bar <= lastIdx + horizon) marks.set(bar, (marks.get(bar) || 0) + 1);
    }
  }
  const windows = [];
  for (const [bar, count] of marks.entries()) {
    if (count >= 2) windows.push({ bar, count, ts: candles[lastIdx].timestamp + (bar - lastIdx) * interval });
  }
  windows.sort((a, b) => a.bar - b.bar);
  return windows.slice(0, 3);
}

function channelProjection(primary, candles) {
  if (!primary || !Array.isArray(primary.points) || primary.points.length < 4) return null;
  const p = primary.points;
  const shim = {
    patternType: primary.manual.patternType,
    mode: primary.manual.mode,
    direction: primary.direction,
    points: p,
    endIndex: p[p.length - 1].index,
    label: primary.manual.label,
  };
  let channel = null;
  try { channel = buildChannel(shim); } catch (e) { channel = null; }
  if (!channel) return null;
  const lastLegSpan = Math.max(1, p[p.length - 1].index - p[p.length - 2].index);
  const projIndex = shim.endIndex + lastLegSpan;
  let exitHint = null;
  try { exitHint = channelExitHint(shim, candles, channel); } catch (e) { exitHint = null; }
  // 作用二（下一拐点投影）仅在数值合理时可信：收敛/发散通道外推常给出负价或天量价，
  // 尤其当该形态已走完时无意义。用参考价过滤，不合理则置 null，只保留作用一（完成提示）。
  const refPrice = Math.abs(p[p.length - 1].price) || 1;
  const sane = (v) => Number.isFinite(v) && v > refPrice * 0.5 && v < refPrice * 2;
  const baseAt = channel.base.at(projIndex);
  const railAt = channel.rail.at(projIndex);
  return {
    channelType: channel.channelType,
    channelTypeCn: CHANNEL_CN[channel.channelType] || channel.channelType,
    note: channel.note,
    projIndex,
    baseAt: sane(baseAt) ? baseAt : null,
    railAt: sane(railAt) ? railAt : null,
    targetSane: sane(baseAt) || sane(railAt),
    exitHint,
  };
}

/**
 * 沿主链下探标注进行中浪（就地写入 node.primary.status / currentWave / totalWaves / expectation）。
 */
function annotateInProgress(node) {
  if (!node || node.isLeaf || !node.primary) return node;
  const p = node.primary;
  const pts = p.points;
  const lastPt = pts[pts.length - 1];

  if (lastPt && lastPt.provisional) {
    const k = pts.length - 1; // 腿数
    p.status = '进行中';
    p.currentWave = k;
    p.totalWaves = k;
    const lastChild = p.children[p.children.length - 1];
    if (lastChild && !lastChild.isLeaf && lastChild.primary) {
      annotateInProgress(lastChild); // 继续下探更细级别的进行中浪
    } else {
      p.expectation = computeExpectation(p, k); // 最深进行中腿 → 附预期
    }
  } else {
    p.status = '完成';
  }
  return node;
}

/**
 * 顶层入口的方向性裁剪：顶层结构应覆盖「主趋势的完整段」——从一个全局极值走到另一个全局极值，
 * 而不是硬拖到最后一根K线。否则会把「已走完的大跌 + 之后的反弹」塞进一个形态，使第1浪长得离谱。
 *
 * 做法：起点取更早出现的全局极值，终点取另一个全局极值（如 BTC：126296高 → 57717低）。
 * 极值之后的走势（57717→现在的反弹）留给 buildCountTree 作为进行中的后续结构处理。
 * 首尾天然一高一低、方向明确。这是 Q8「起点锚→主趋势终点」的落地细化，属可迭代的入口启发式。
 */
function directionalTopSpan(fine) {
  if (!Array.isArray(fine) || fine.length < 2) return fine;
  let hiI = 0;
  let loI = 0;
  for (let i = 1; i < fine.length; i += 1) {
    if (fine[i].price > fine[hiI].price) hiI = i;
    if (fine[i].price < fine[loI].price) loI = i;
  }
  const startI = Math.min(hiI, loI); // 更早出现的全局极值
  const endI = Math.max(hiI, loI);   // 另一个全局极值 = 主趋势的终点
  const span = fine.slice(startI, endI + 1);
  return span.length >= 2 ? span : fine.slice(startI);
}

/**
 * 框架B的顶层区间（rank-competing-wave-counts §3.1，解开 directionalTopSpan 焊死）：
 * 起点与框架A相同（更早出现的全局极值），但终点不再钦定"另一个全局极值"，而是延伸到
 * now（最后一个细枢轴，通常 provisional）。表达"读法2"——当前走势可能是更高级别、
 * 尚未走完的浪的内部子腿，而非"已完成结构 + 附加反弹"。
 */
function directionalSpanToNow(fine) {
  if (!Array.isArray(fine) || fine.length < 2) return fine;
  let hiI = 0;
  let loI = 0;
  for (let i = 1; i < fine.length; i += 1) {
    if (fine[i].price > fine[hiI].price) hiI = i;
    if (fine[i].price < fine[loI].price) loI = i;
  }
  const startI = Math.min(hiI, loI);
  return fine.slice(startI);
}

/**
 * 引擎入口：对整段细枢轴（应已含边界锚定）做顶层全形态竞争（driving + corrective）。
 */
function buildCountTree(finePivots, candles, options = {}) {
  const opts = { beamK: options.beamK || 3, maxDepth: options.maxDepth || 6, variants: options.variants || 1, cache: new Map() };
  const topSpan = options.trimTop === false ? finePivots : directionalTopSpan(finePivots);
  const tree = decompose(topSpan, candles, [DRIVING, CORRECTIVE], 0, opts);
  annotateInProgress(tree);
  if (tree && tree.primary) {
    tree.channel = channelProjection(tree.primary, candles);
    tree.fibTimeWindows = fibTimeWindows(finePivots, candles);
  }

  // 当进行中的 provisional 末枢轴与顶层起点同型、被方向裁剪剔除时（完成结构走到最后一个
  // 确认枢轴、当前正沿反向走一条尚未确认的腿），把这条在建腿作为顶层进行中浪单独挂出。
  const globalLast = Array.isArray(finePivots) && finePivots.length ? finePivots[finePivots.length - 1] : null;
  const spanLast = Array.isArray(topSpan) && topSpan.length ? topSpan[topSpan.length - 1] : null;
  if (globalLast && globalLast.provisional && spanLast && globalLast.index > spanLast.index) {
    // 参考幅度取「紧邻的上一条完成腿」（同量级的可比波），而非顶级大浪1，避免投影尺度失真。
    const idx = finePivots.indexOf(spanLast);
    const prev = idx > 0 ? finePivots[idx - 1] : null;
    const refAmp = prev ? Math.abs(spanLast.price - prev.price) : 0;
    const exp = computeLegExpectation(spanLast, globalLast, refAmp);
    // 修正：refAmp 是「刚在极值处、投影第一条反向小腿」的口径；当这条在建腿已顺势跑过基于
    // refAmp 的完成投影（如 57718→72427 已远超 57718+3121×1.618），原目标会全部落在现价的
    // 逆势一侧、早被走穿。此时改为从当前端点按本腿自身幅度向前延伸投影，保证目标在现价顺势一侧。
    const up = globalLast.price >= spanLast.price;
    const allPast = exp.fibTargets.every((t) => (up ? t.price <= globalLast.price : t.price >= globalLast.price));
    const legAmp = Math.abs(globalLast.price - spanLast.price);
    if (allPast && legAmp > 0) {
      const sgn = up ? 1 : -1;
      exp.fibTargets = [0.382, 0.618, 1.0].map((m) => ({ mult: m, price: globalLast.price + sgn * legAmp * m }));
    }
    tree.inProgress = { from: spanLast, to: globalLast, ...exp };
  }
  // 进行中结构（未确认）：把「已确认低/高点 → 现在」这段单独拆成带标签的子树，
  // 让报告能像历史段一样看到「哪里到哪里 = 什么浪型」，并研判当前浪位。
  tree.inProgressStruct = buildInProgressStructure(finePivots, spanLast, candles, opts);
  tree.currentWaveStructures = buildCurrentWaveStructures(finePivots, spanLast, candles, opts);
  tree.assessment = situationAssessment(tree, candles, finePivots);

  // 框架B（rank-competing-wave-counts §3.1）：解开焊死——当前走势可能是更高级别、
  // 尚未走完的浪的内部子腿（"读法2"），而非"框架A已完成结构 + 附加反弹"。只在B真的
  // 延伸超过A时才值得算（若二者终点相同，即无未确认的后续走势，B就是A，算了也是重复）。
  // 独立 opts.cache：B 的区间与 A 不同，共享缓存反而互相污染。
  if (options.trimTop !== false) {
    const topSpanB = directionalSpanToNow(finePivots);
    if (topSpanB.length > topSpan.length) {
      const optsB = { ...opts, cache: new Map() };
      const naiveB = decompose(topSpanB, candles, [DRIVING, CORRECTIVE], 0, optsB);
      // gate-extending-final-leg-rules §2.1：不再让朴素框架B 独占。
      //  · 朴素B 先过"末腿终点=区间顺势极值"不变量：藏了更极端点的畸形拟合（如双锯齿把 57718
      //    压进 y 腿、终点却停在反弹价 78301）剔除；末腿本就终结于区间极值者（如推动浪
      //    81265→78301 单调下行）保留——它是合法的"顺势延伸中"读法。
      //  · 始终另算逆势框架B（锚全局极值、末浪延伸中、投影新极值），供被剔除形态的正确表达。
      //  · 合并两池，交 buildRankedCounts 按形态去重（同形取分高者）。
      const naiveKept = filterFinalLegAnchored(naiveB, finePivots);
      const counterB = buildCounterTrendFrameworkB(tree, finePivots, candles);
      tree.frameworkB = mergeFrameworkB(naiveKept, counterB);
    }
  }
  return tree;
}

/**
 * 进行中结构（未确认）：从已确认结构终点（spanLast，如 BTC 低点 57718）到当前边缘，拆成两部分：
 *   · upStructure：终点 → 该段摆动极值（如 66924）——真实走完的那条冲/跌腿，走全形态竞争打标签；
 *   · currentPullback：摆动极值 → 最后一根K线（如 63658，今天）——尚未走完的当前回撤子腿（⏳进行中）。
 * 口径中性（Q4=a）：只客观拆内部几波/什么形态，5波/3波结论反哺①③身份研判；深度封顶 2 级（Q5）。
 */
function buildInProgressStructure(finePivots, spanLast, candles, options = {}) {
  if (!Array.isArray(finePivots) || !spanLast) return null;
  const iStart = finePivots.indexOf(spanLast);
  if (iStart < 0) return null;
  const post = finePivots.slice(iStart + 1);
  if (!post.length) return null;

  const structUp = spanLast.type === 'L'; // 已确认段收在低点 → 之后是上涨（反弹）；收在高点 → 之后下跌
  // 摆动极值：post 段里最远离终点的那个枢轴（上涨取最高、下跌取最低）
  let ext = post[0];
  for (const p of post) {
    if (structUp ? p.price > ext.price : p.price < ext.price) ext = p;
  }
  const last = finePivots[finePivots.length - 1];
  const iExt = finePivots.indexOf(ext);

  const ipOpts = { beamK: options.beamK || 3, maxDepth: 2, cache: new Map() }; // 进行中段样本少，封顶 2 级避免过拟合
  const upSpanFine = finePivots.slice(iStart, iExt + 1);
  const upTree = upSpanFine.length >= 2
    ? decompose(upSpanFine, candles, [DRIVING, CORRECTIVE], 0, ipOpts) : null;
  annotateInProgress(upTree); // 若极值本身还是 provisional（仍在创新高/低、无回撤），末腿标进行中

  // 内部性格（5波/3波）——中性口径的客观判定，用于反哺身份研判
  let swingChar = null;
  if (upSpanFine.length >= MIN_POINTS[CORRECTIVE]) {
    swingChar = legCharacter(upSpanFine, candles, 0, { beamK: 3, maxDepth: 4 }).character;
  }

  // 当前回撤子腿（仅当价格已从极值回撤、极值不是最后一根K线时才有）
  let pullback = null;
  if (iExt >= 0 && iExt < finePivots.length - 1) {
    const pbFine = finePivots.slice(iExt);
    const pbTree = pbFine.length >= MIN_POINTS[CORRECTIVE]
      ? decompose(pbFine, candles, [CORRECTIVE], 0, ipOpts) : null;
    const upAmp = Math.abs(ext.price - spanLast.price);
    const s = structUp ? -1 : 1; // 回撤方向与上冲/下跌相反
    pullback = {
      from: ext, to: last,
      currentLegDir: structUp ? 'down' : 'up',
      note: '回撤，推断非确定',
      // 回撤目标 = 上冲段的斐波回撤位（非投影）
      fibTargets: [0.382, 0.5, 0.618].map((m) => ({ mult: m, price: ext.price + s * upAmp * m })),
      subtree: pbTree,
    };
  }

  return { structUp, swingExtreme: ext, swingChar, upTree, pullback, invalidation: spanLast.price };
}

const CUR_RANKED_MAX = 6;

/**
 * 当前进行浪竞争结构（enumerate-current-wave-structures）：对当前进行浪段（已确认极值 spanLast → now）
 * 枚举一组"当前浪位模板"，每条给出【具体子计数 + 当前浪位 + 下一浪投影 + 失效点】。既含完成型也含
 * 在建型（"你正处形态P的第k浪、其后浪位投影"）。否定法排名（硬约束破了的先淘汰、软信号=leg1性格
 * 契合度排名）、按倾向去重、设 CUR_RANKED_MAX 上限。投影/失效点均为推断。
 *
 * v1 用有界模板目录（非组合搜索）；在建部分只对已走腿查可判定的结构约束（失效点是否已破、回撤比是否
 * 越界），未走的浪只投影、不判违规——天然满足 gate-extending-final-leg-rules 的"在建部分不误判违规"。
 */
function buildCurrentWaveStructures(finePivots, spanLast, candles, options = {}) {
  if (!Array.isArray(finePivots) || !spanLast) return null;
  const iStart = finePivots.indexOf(spanLast);
  if (iStart < 0) return null;
  const post = finePivots.slice(iStart + 1);
  if (post.length < 1) return null;

  const lowConfirmed = spanLast.type === 'L'; // 确认低点 → 反弹向上、大势续跌；确认高点镜像
  let ext = post[0];
  for (const p of post) {
    if (lowConfirmed ? p.price > ext.price : p.price < ext.price) ext = p;
  }
  const now = finePivots[finePivots.length - 1];
  if (ext === now) return null; // 还没回撤、只有一条腿，不足以定当前浪位
  const iExt = finePivots.indexOf(ext);
  const prior = iStart > 0 ? finePivots[iStart - 1] : null; // 进入极值的前腿起点

  const amp1 = Math.abs(ext.price - spanLast.price); // leg1: spanLast→ext（已走）
  const amp2 = Math.abs(now.price - ext.price); // leg2: ext→now（进行中）
  const amp0 = prior ? Math.abs(spanLast.price - prior.price) : amp1; // 进入极值前腿
  const retrace2 = amp1 > 0 ? amp2 / amp1 : 1;

  const leg1Fine = finePivots.slice(iStart, iExt + 1);
  const leg1Char = leg1Fine.length >= MIN_POINTS[CORRECTIVE]
    ? legCharacter(leg1Fine, candles, 0, { beamK: 3, maxDepth: 4 }).character : null;

  const contDir = lowConfirmed ? -1 : 1; // 大势续行方向（续跌=-1 / 续涨=+1）
  const revDir = -contDir;
  const proj = (base, sign, refAmp, mults) => mults.map((m) => ({ mult: m, price: base + sign * refAmp * m }));
  const R = (v) => Math.round(v);
  const templates = [];

  // T1 续行推动·浪③进行中（续大势）：①=进入极值前腿 ②=leg1 ③=leg2起步
  if (prior) {
    const breach = lowConfirmed ? ext.price > prior.price : ext.price < prior.price;
    templates.push({
      id: 'cont-impulse-3',
      label: lowConfirmed ? '下跌推动·浪③进行中' : '上涨推动·浪③进行中',
      tendency: lowConfirmed ? '看跌' : '看多',
      legs: [
        { name: '①', from: prior.price, to: spanLast.price, status: '完成' },
        { name: '②', from: spanLast.price, to: ext.price, status: '完成' },
        { name: '③', from: ext.price, to: now.price, status: '⏳进行中' },
      ],
      currentWave: '浪③（进行中）',
      projection: proj(ext.price, contDir, amp0, [1.0, 1.618, 2.618]),
      invalidation: { price: prior.price, reason: `浪②不得超浪①起点 ${R(prior.price)}` },
      tier1: breach ? 1 : 0,
      soft: leg1Char === 'corrective' ? 1 : 0, // ②应为调整(3波)
      deferred: ['浪③内部形态待走完再判'],
    });
  }

  // T2 连接浪/B·中继（先反弹后续大势）：a=leg1 b=leg2进行中 c=投影(反弹方向)
  templates.push({
    id: 'connector-bx',
    label: lowConfirmed ? 'X连接浪/B·中继(先上后跌)' : 'X连接浪/B·中继(先下后涨)',
    tendency: '中继',
    legs: [
      { name: 'a', from: spanLast.price, to: ext.price, status: '完成' },
      { name: 'b', from: ext.price, to: now.price, status: '⏳进行中' },
      { name: 'c', from: now.price, to: null, status: '未走' },
    ],
    currentWave: 'b腿（进行中），之后 c 腿反弹',
    projection: proj(now.price, revDir, amp1, [0.618, 1.0]),
    invalidation: { price: spanLast.price, reason: `跌破 ${R(spanLast.price)} 则反弹结构坏` },
    tier1: 0,
    soft: leg1Char === 'corrective' ? 1 : 0,
    deferred: ['c 腿未走，仅投影'],
  });

  // T3 反转推动·浪②进行中（转势）：①=leg1 ②=leg2进行中 ③=投影(反弹方向)
  {
    const breach = retrace2 >= 1.0; // ②回撤超①100% = 跌破 spanLast
    templates.push({
      id: 'reverse-impulse-2',
      label: lowConfirmed ? '新上涨推动·浪②进行中(转势)' : '新下跌推动·浪②进行中(转势)',
      tendency: lowConfirmed ? '看多' : '看跌',
      legs: [
        { name: '①', from: spanLast.price, to: ext.price, status: '完成' },
        { name: '②', from: ext.price, to: now.price, status: '⏳进行中' },
        { name: '③', from: now.price, to: null, status: '未走' },
      ],
      currentWave: '浪②（进行中），之后 浪③',
      projection: proj(now.price, revDir, amp1, [1.0, 1.618]),
      invalidation: { price: spanLast.price, reason: `浪②不得回撤超浪①100%（跌破 ${R(spanLast.price)}）` },
      tier1: breach ? 1 : 0,
      soft: leg1Char === 'driving' ? 1 : 0, // ①应为5浪
      deferred: ['浪③未走，仅投影'],
    });
  }

  // 否定法排名：tier1 升序、soft 降序；按倾向去重、设上限
  templates.sort((a, b) => (a.tier1 - b.tier1) || (b.soft - a.soft));
  const seen = new Set();
  const ranked = [];
  for (const tpl of templates) {
    if (seen.has(tpl.tendency)) continue;
    seen.add(tpl.tendency);
    ranked.push(tpl);
    if (ranked.length >= CUR_RANKED_MAX) break;
  }
  return { spanLast: spanLast.price, ext: ext.price, now: now.price, leg1Char, structures: ranked };
}

/**
 * 进行中结构的调试文本（技术细节块内，缩进树）。
 */
function renderInProgressText(ips) {
  if (!ips) return '（无在建结构：当前结构大致已走完最后一浪）';
  const L = [];
  const charCn = ips.swingChar === 'driving' ? '内部五浪(偏推动)'
    : ips.swingChar === 'corrective' ? '内部三波(偏调整)' : '内部结构待明';
  L.push(`⏳ 进行中结构（未确认）｜上冲/下跌段极值 ${ips.swingExtreme.price}｜${charCn}｜失效点 ${ips.invalidation}`);
  if (ips.upTree) L.push(renderTreeText(ips.upTree, 0));
  if (ips.pullback) {
    const pb = ips.pullback;
    const tg = pb.fibTargets.map((t) => `${t.mult}×→${t.price.toFixed(0)}`).join(', ');
    L.push(`⏳ 当前回撤子腿（未确认）：${pb.from.price}→${pb.to.price}（末腿${pb.currentLegDir}）｜回撤位(${pb.note}) ${tg}`);
    if (pb.subtree) L.push(renderTreeText(pb.subtree, 1));
  }
  return L.join('\n');
}

/**
 * 进行中结构序列化（JSON 平级字段 inProgressTree，与 tree 并列）。
 */
function serializeInProgress(ips) {
  if (!ips) return null;
  const pt = (p) => (p ? { price: p.price, type: p.type, index: p.index, timestamp: p.timestamp, provisional: p.provisional || undefined } : null);
  return {
    status: '进行中/未确认',
    structDir: ips.structUp ? 'up' : 'down',
    swingExtreme: pt(ips.swingExtreme),
    swingCharacter: ips.swingChar, // 'driving'(五浪) | 'corrective'(三波) | null
    invalidation: ips.invalidation,
    upStructure: ips.upTree ? serializeNode(ips.upTree, 0, null) : null,
    currentPullback: ips.pullback ? {
      from: ips.pullback.from.price, to: ips.pullback.to.price,
      currentLegDir: ips.pullback.currentLegDir, note: ips.pullback.note,
      fibTargets: ips.pullback.fibTargets,
      subtree: ips.pullback.subtree ? serializeNode(ips.pullback.subtree, 0, null) : null,
      // narrate-current-pullback：与主树平级隔离；无法计算的子字段为 null，不报错
      level: ips.pullback.narrative ? ips.pullback.narrative.level : null,
      structureLine: ips.pullback.narrative ? ips.pullback.narrative.structureLine : null,
      subDegree: ips.pullback.narrative ? ips.pullback.narrative.subDegree : null,
      combinationReading: ips.pullback.narrative ? ips.pullback.narrative.combinationReading : null,
      zwaveTargets: ips.pullback.narrative ? ips.pullback.narrative.zwaveTargets : null,
    } : null,
  };
}

// ============================================================
// 6.55 当前高点回撤叙述（narrate-current-pullback）
// ============================================================
//
// 引擎已拆出 currentPullback（摆动高点 → 今），但只吐斐波目标价。本节把它补成可读研判：
//   ①级别（相对同段历史回撤深度分位）②回撤内部竞争形态（多选，滤除违规）③续涨条件（结构线=真低点）
//   ④联合形浪位读法（W-X-Y-XX-Z）+ Z 浪双路径与完整目标阶梯。
// 拆不出（枢轴 < 4）时下钻子级别补结构（自适应步降，级别隔离，不改主计数树）。
// 设计见 openspec/changes/narrate-current-pullback/{design,specs}。

// tf 降级阶梯（粗→细）；stepDown 取更细一级
const TF_LADDER = ['1y', '1m', '1w', '1d', '4h', '1h', '5m'];
function tfStepDown(tfKey) {
  const i = TF_LADDER.indexOf(tfKey);
  return (i >= 0 && i < TF_LADDER.length - 1) ? TF_LADDER[i + 1] : null;
}

// 镜像 main() 管道，取某级别某窗口的 {tfKey, candles, fine}；fetchFn 可注入便于离线测试
async function loadCandlesAndPivots(product, tfKey, start, end, fetchFn = fetchCandles) {
  const tf = TIMEFRAMES[tfKey];
  if (!tf) return null;
  const base = await fetchFn(product, tf.fetchGranularity, start, end);
  const startTs = Math.floor(start.getTime() / 1000);
  const endTs = Math.floor(end.getTime() / 1000);
  const candles = transformCandles(base, tf)
    .filter((c) => c.timestamp >= startTs && c.timestamp <= endTs)
    .map((c, i) => ({ ...c, index: i }));
  if (candles.length < 2) return { tfKey, candles, fine: [] };
  let fine = detectPivots(candles, 1, {});
  fine = anchorBoundaryExtremes(candles, fine);
  return { tfKey, candles, fine };
}

// 自适应步降下钻：从 mainTf 的下一级起，逐级下探直到回撤窗枢轴 ≥ MIN_POINTS.corrective(4)
async function drillPullback(product, mainTfKey, window, fetchFn = fetchCandles) {
  const start = new Date(window.fromTs * 1000);
  const end = new Date(window.toTs * 1000);
  let tfKey = tfStepDown(mainTfKey);
  let best = null;
  while (tfKey) {
    // eslint-disable-next-line no-await-in-loop
    const loaded = await loadCandlesAndPivots(product, tfKey, start, end, fetchFn);
    if (loaded && loaded.fine.length >= MIN_POINTS[CORRECTIVE]) return loaded;
    if (loaded && loaded.fine.length) best = loaded; // 记住最细一次兜底
    tfKey = tfStepDown(tfKey);
  }
  return best; // 仍不足则交由上层降级
}

// 把回撤剥两截：摆动极值 → 真低点（已走完、拆形态）/ 真低点 → 今（进行中反弹、不拆）
// structUp=true：回撤向下，极值取最高枢轴、真低点取其后最低枢轴。
function splitPullbackAtLow(fine, structUp) {
  if (!Array.isArray(fine) || fine.length < 2) return null;
  let extIdx = 0;
  for (let i = 1; i < fine.length; i += 1) {
    if (structUp ? fine[i].price > fine[extIdx].price : fine[i].price < fine[extIdx].price) extIdx = i;
  }
  const after = fine.slice(extIdx);
  if (after.length < 2) return null;
  let loIdx = 0;
  for (let i = 1; i < after.length; i += 1) {
    if (structUp ? after[i].price < after[loIdx].price : after[i].price > after[loIdx].price) loIdx = i;
  }
  const swingExtreme = after[0];
  const trueLow = after[loIdx];
  // 反弹极值：真低点之后离真低点最远的反向枢轴（当前 XX 连接浪的高点）
  const tail = after.slice(loIdx);
  let bounce = tail[0];
  for (const p of tail) if (structUp ? p.price > bounce.price : p.price < bounce.price) bounce = p;
  return {
    swingExtreme,
    trueLow,
    bounceExtreme: bounce,
    completed: after.slice(0, loIdx + 1), // 极值 → 真低点
    inProgress: tail, // 真低点 → 今
  };
}

// 同段趋势历史高→低回撤深度样本（比率），用于给"级别"定分位
function historicalPullbackDepths(finePivots) {
  const depths = [];
  if (!Array.isArray(finePivots)) return depths;
  for (let i = 0; i < finePivots.length - 1; i += 1) {
    const a = finePivots[i];
    const b = finePivots[i + 1];
    if (a.type === 'H' && b.type === 'L' && a.price > 0) depths.push((a.price - b.price) / a.price);
  }
  return depths;
}

function median(arr) {
  if (!arr || !arr.length) return null;
  const s = [...arr].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// 级别定级：回撤深度 ≤ 历史中位数 → 小级别；否则与"上半部分中位数"比出中/大级别
function classifyPullbackLevel(depthRatio, samples) {
  const med = median(samples);
  if (med == null || !Number.isFinite(depthRatio)) return { level: '级别待定', depthRatio, median: med };
  if (depthRatio <= med) return { level: '小级别', depthRatio, median: med };
  const upperMed = median(samples.filter((d) => d > med));
  const level = (upperMed != null && depthRatio > upperMed) ? '大级别' : '中级别';
  return { level, depthRatio, median: med };
}

// 拆回撤"已走完"段：竞争形态（滤除 severe/文法违规、按形态族去重）+ 联合形候选（供浪位读法）
function analyzePullbackCompleted(completedFine, candles) {
  if (!Array.isArray(completedFine) || completedFine.length < MIN_POINTS[CORRECTIVE]) {
    return { patterns: [], comboCand: null };
  }
  const res = decompose(completedFine, candles, [CORRECTIVE], 0, { beamK: 6, maxDepth: 2, cache: new Map() });
  if (!res || res.isLeaf) return { patterns: [], comboCand: null };
  const all = [res.primary, ...(res.alternates || [])].filter(Boolean);
  const patterns = [];
  const seen = new Set();
  let comboCand = null;
  for (const c of all) {
    const sc = c.score || {};
    const severe = sc.severe || 0;
    const gv = sc.grammarViolations || 0;
    if (severe > 0 || gv > 0) continue; // 滤除 severe/文法违规
    const family = (c.manual && c.manual.patternType) || c.patternId;
    if (!comboCand && (c.patternId === 'sideways-double' || c.patternId === 'sideways-triple')) comboCand = c;
    if (seen.has(family)) continue; // 按形态族去重
    seen.add(family);
    patterns.push({
      label: (c.manual && c.manual.label) || c.patternId,
      patternType: family,
      score: { tier1: sc.tier1, tier2: sc.tier2, tier3: sc.tier3 },
    });
  }
  return { patterns, comboCand };
}

// 联合形浪位读法：从联合形候选取 W/X/Y 边界，XX=真低点→当前反弹极值，Z 待走；给 XX 对 Y 的回撤%
function readCombination(comboCand, trueLow, bounceExtreme) {
  if (!comboCand || !Array.isArray(comboCand.points)) return null;
  const p = comboCand.points;
  const names = comboCand.patternId === 'sideways-triple' ? ['W', 'X', 'Y', 'XX', 'Z'] : ['W', 'X', 'Y'];
  const legs = {};
  for (let i = 0; i < names.length && i + 1 < p.length; i += 1) {
    legs[names[i]] = { from: p[i].price, to: p[i + 1].price };
  }
  const yLeg = legs.Y;
  const yAmp = yLeg ? Math.abs(yLeg.from - yLeg.to) : null;
  const xxAmp = Math.abs(bounceExtreme.price - trueLow.price);
  legs.XX = { from: trueLow.price, to: bounceExtreme.price };
  legs.Z = { pending: true };
  const xxRetracePct = (yAmp && yAmp > 0) ? xxAmp / yAmp : null;
  return { legs, xxRetracePct, yAmp };
}

// Z 浪双路径投影（架构同 bounceHypotheses）：跌破路径完整目标阶梯 + 三角收缩路径
function zwaveProjection(wAmp, yAmp, trueLowPrice, bounceHighPrice) {
  if (!Number.isFinite(yAmp) || yAmp <= 0) return null;
  const wRef = Number.isFinite(wAmp) && wAmp > 0 ? wAmp : yAmp;
  // 主目标 = Z=W=Y 等长带（W≈Y 时收敛为窄带）+ Y低−0.236×Y 破位档
  const eqA = bounceHighPrice - wRef;
  const eqB = bounceHighPrice - yAmp;
  const main = {
    label: 'Z=W=Y 等长带',
    low: Math.min(eqA, eqB),
    high: Math.max(eqA, eqB),
    breakFib0236: trueLowPrice - 0.236 * yAmp,
  };
  const extension = [
    { label: 'XX高−1.272×Y', price: bounceHighPrice - 1.272 * yAmp },
    { label: 'Y低−0.618×Y', price: trueLowPrice - 0.618 * yAmp },
  ];
  const extreme = [
    { label: 'Y低−1.0×Y', price: trueLowPrice - yAmp },
    { label: 'XX高−1.618×Y', price: bounceHighPrice - 1.618 * yAmp },
  ];
  return {
    trigger: trueLowPrice, // 跌破真低点确认 Z 启动
    breakPath: { main, extension, extreme, aftermath: 'Z 浪走完后转向上涨' },
    trianglePath: { note: '横向收缩三角（在结构线附近震荡收敛，无单一价目标）', aftermath: '完成后转向上涨' },
  };
}

// 编排：对进行中的高点回撤做子级别下钻 + 竞争形态 + 定级 + 联合形 + Z 投影，结果挂到 pullback.narrative
// 纯计算部分（split/rank/level/combo/zwave）离线可测；仅 drillPullback 触网（拆不出时才触发）。
async function enrichCurrentPullback(tree, ctx, fetchFn = fetchCandles) {
  const ips = tree && tree.inProgressStruct;
  const pb = ips && ips.pullback;
  if (!ips || !pb || ips.structUp !== true) return null; // 仅"高点回撤"（confirmed low → 上冲 → 回撤下行）
  const { product, mainTf, finePivots, candles } = ctx;
  const swingExtreme = ips.swingExtreme;
  const trueLowMain = pb.to; // 主级别回撤末点（当前边缘）

  // 选子级别数据：主级别"已走完段"够拆就用主级别，否则下钻
  const iExt = finePivots.indexOf(swingExtreme);
  const mainSub = iExt >= 0 ? { tfKey: mainTf, candles, fine: finePivots.slice(iExt) } : null;
  const mainSplit = mainSub ? splitPullbackAtLow(mainSub.fine, true) : null;
  let sub = (mainSplit && mainSplit.completed.length >= MIN_POINTS[CORRECTIVE]) ? mainSub : null;
  let drilled = false;
  if (!sub) {
    const window = { fromTs: swingExtreme.timestamp, toTs: trueLowMain.timestamp };
    const d = await drillPullback(product, mainTf, window, fetchFn);
    if (d && d.fine.length >= 2) { sub = d; drilled = true; }
  }

  const narrative = {
    level: null,
    structureLine: (mainSplit && mainSplit.trueLow.price) || trueLowMain.price,
    subDegree: null,
    combinationReading: null,
    zwaveTargets: null,
  };

  if (sub) {
    const split = splitPullbackAtLow(sub.fine, true);
    if (split) {
      narrative.structureLine = split.trueLow.price;
      const { patterns, comboCand } = analyzePullbackCompleted(split.completed, sub.candles);
      narrative.subDegree = { tf: sub.tfKey, drilled, rankedPatterns: patterns };
      const combo = readCombination(comboCand, split.trueLow, split.bounceExtreme);
      if (combo) {
        narrative.combinationReading = { legs: combo.legs, xxRetracePct: combo.xxRetracePct };
        const wLeg = combo.legs.W;
        const wAmp = wLeg ? Math.abs(wLeg.from - wLeg.to) : null;
        narrative.zwaveTargets = zwaveProjection(wAmp, combo.yAmp, split.trueLow.price, split.bounceExtreme.price);
      }
    }
  }

  // 级别：回撤深度按"高点 → 真低点（结构线）"度量，对同段历史回撤样本定分位
  const depthRatio = swingExtreme.price > 0
    ? (swingExtreme.price - narrative.structureLine) / swingExtreme.price : NaN;
  narrative.level = classifyPullbackLevel(depthRatio, historicalPullbackDepths(finePivots));

  narrative.text = renderPullbackNarrative(narrative);
  pb.narrative = narrative;
  return narrative;
}

// 叙述成句（现状研判块）：正文只给主目标 + 延伸档，全阶梯留 JSON。无警戒线措辞。
function renderPullbackNarrative(nr) {
  if (!nr) return '';
  const n = (v) => (Number.isFinite(v) ? Math.round(v) : v);
  const L = [];
  L.push('## 当前高点回撤研判');
  L.push('');
  const sd = nr.subDegree;
  const forms = sd && sd.rankedPatterns && sd.rankedPatterns.length
    ? sd.rankedPatterns.slice(0, 3).map((p) => p.label).join(' 或 ')
    : '形态待明（进行中枢轴不足）';
  const tfNote = sd && sd.drilled ? `（下钻 ${sd.tf} 子级别）` : '';
  let s1 = `自高点回撤，属**${nr.level.level}回撤**`;
  if (Number.isFinite(nr.level.depthRatio)) s1 += `（深度 ${(nr.level.depthRatio * 100).toFixed(1)}%`;
  if (nr.level.median != null) s1 += `，同段历史回撤中位数 ${(nr.level.median * 100).toFixed(1)}%`;
  if (Number.isFinite(nr.level.depthRatio)) s1 += '）';
  s1 += `。回撤内部${tfNote}较符合 **${forms}**。`;
  L.push(s1);
  L.push('');
  L.push(`**续涨条件**：守住结构线 **${n(nr.structureLine)}** 上方，回撤结构未坏，仍有上攻动力。`);
  L.push('');
  const cr = nr.combinationReading;
  if (cr && cr.xxRetracePct != null) {
    const legStr = ['W', 'X', 'Y'].filter((k) => cr.legs[k]).map((k) => `${k}(${n(cr.legs[k].from)}→${n(cr.legs[k].to)})`).join('、');
    L.push(`**联合形浪位**：${legStr}；当前反弹 **XX** 已回撤 Y 浪 **${(cr.xxRetracePct * 100).toFixed(0)}%**${cr.xxRetracePct >= 0.7 ? '（≥70% 门槛，看作连接浪）' : '（未达 70% 门槛）'}。`);
    L.push('');
  }
  const zt = nr.zwaveTargets;
  if (zt && zt.breakPath) {
    const m = zt.breakPath.main;
    const ext = zt.breakPath.extension.map((e) => n(e.price)).join(' / ');
    L.push(`**Z 浪两条路：** ①跌破 **${n(zt.trigger)}** 后，主目标 **${n(m.low)}–${n(m.high)}** 一带（Z=W=Y 等长，含破位档 ${n(m.breakFib0236)}），延伸看 ${ext}；②走收缩三角横向收敛。两路 **Z 浪走完后转向上涨**。`);
    L.push('');
  }
  L.push('> 以上为概率性研判、非确定，不构成买卖建议；数字由本次 K 线计算。');
  return L.join('\n');
}

// ============================================================
// 6.6 现状研判（把历史浪型收敛成四问：当前浪型/趋势/目标/依据）
// ============================================================
//
// 内核（grilling 定稿）：
//   · 大级别趋势 = 顶层完成结构的 motive/corrective 推断（推动→新趋势确立；调整→修正完成、原趋势恢复）
//   · 当前浪角色 = 对进行中腿跑 legCharacter（五浪→"新势1浪"；三波→"修正A浪"）
//   · 失效点 = 顶层完成结构终点极值
//   · 目标 = 双情景：回撤(逆结构=反弹/转势) + 扩展(顺结构=延续)，各条带依据；主选=与大趋势一致的那套

// 当前反弹的「身份研判」（作者框架）：同一段反弹，身份不同→回撤参考不同→目标与之后走向不同。
//   · XX 连接段：回撤"上一子浪"的 0.2/0.382/0.618；之后 Z 浪续跌
//   · B 反弹：回撤"整段"的 0.5/0.618/0.7；之后 C 浪续跌
//   · 推动 3 浪：反弹内部为五浪→趋势转、无上方回撤上限
// 主次由反弹子浪性格定：五浪→推动3为主；三波→XX为主、B为备。
function bounceHypotheses(structPoints, bounceChar) {
  if (!Array.isArray(structPoints) || structPoints.length < 2) return null;
  const start = structPoints[0];
  const term = structPoints[structPoints.length - 1];
  const prev = structPoints[structPoints.length - 2];
  const structDown = term.price < start.price;
  const s = structDown ? 1 : -1; // 反弹方向（逆结构）为正
  const lastSub = Math.abs(term.price - prev.price);
  const whole = Math.abs(start.price - term.price);
  const up = (ratios, ref) => ratios.map((r) => ({ ratio: r, price: term.price + s * r * ref })); // 反弹上方目标
  const dn = (ratios, ref) => ratios.map((r) => ({ ratio: r, price: term.price - s * r * ref })); // 跌破后延续目标
  return {
    term: term.price, startPrice: start.price, prevPrice: prev.price, lastSub, whole, structDown, bounceChar,
    three: { targets: up([0.382, 0.5, 0.618], whole), note: '反弹内部若五浪→趋势转、上方无回撤上限（以整段回撤位作参考阻力）' },
    xx: { targets: up([0.2, 0.382, 0.618], lastSub), down: dn([0.618, 1.0, 1.618], lastSub), aftermath: 'Z 浪下跌' },
    b: { targets: up([0.5, 0.618, 0.7], whole), down: dn([0.618, 1.0], lastSub), aftermath: 'C 浪下跌', timing: '走完 C 通常耗时较长，时间上多半不够' },
    lean: bounceChar === 'driving' ? 'three' : 'xx',
  };
}

// 近端触发线（Q7）：取反弹第一条腿（结构终点→反弹首个反向枢轴）的 0.382/0.5/0.618 回撤
function nearTermTrigger(termPivot, finePivots) {
  if (!termPivot || !Array.isArray(finePivots)) return null;
  const after = finePivots.filter((p) => p.index > termPivot.index);
  if (!after.length) return null;
  // 取反弹的极值（离终点最远的那个枢轴 = 反弹的摆动高/低），而非第一个小枢轴
  const hi = after.reduce((acc, p) => (p.price > acc.price ? p : acc), after[0]);
  const lo = after.reduce((acc, p) => (p.price < acc.price ? p : acc), after[0]);
  const swing = Math.abs(hi.price - termPivot.price) >= Math.abs(lo.price - termPivot.price) ? hi : lo;
  const amp = Math.abs(swing.price - termPivot.price);
  if (amp <= 0) return null;
  const s = swing.price > termPivot.price ? -1 : 1; // 回撤方向
  const levels = [0.382, 0.5, 0.618].map((r) => ({ ratio: r, price: swing.price + s * r * amp }));
  return { from: termPivot.price, to: swing.price, levels };
}

// 叙述化渲染（可读性 grilling 定稿：作者口吻，把参考浪/依据/之后走向揉进整句；
// 每种身份一句有因果的话，而非带括号的价格；主选就近标注，全精度数字）。
function renderBounceHypotheses(h, nearTerm) {
  if (!h) return '';
  const n = (v) => Math.round(v);
  const px = (arr) => arr.filter((t) => t.price > 0).map((t) => n(t.price)).join(' / ');
  const main = (k) => (h.lean === k ? '（主选）' : '');
  const charCn = h.bounceChar === 'driving' ? '内部更像五浪（偏推动）'
    : h.bounceChar === 'corrective' ? '内部更像三波（偏调整）'
      : '内部结构还看不清';
  const leanCn = h.lean === 'three' ? '推动 3 浪' : 'XX 连接浪';
  const refLeg = `${n(h.prevPrice)}→${n(h.term)}`;
  const wholeLeg = `${n(h.startPrice)}→${n(h.term)}`;
  const L = [];
  L.push(`眼下从 **${n(h.term)}** 起的这波反弹，身份还没定。按反弹${charCn}，**${leanCn}是主选**；三种可能各自的参考浪、目标、之后走向都不一样：`);
  L.push('');
  L.push(`- **若是 XX 连接浪**${main('xx')}：它是对上一子浪（${refLeg}，幅 ${n(h.lastSub)}）的反弹，通常吃掉该段的 0.2–0.618，也就是 **${px(h.xx.targets)}**；xx 可以是任意一种调整形态（横向收缩，或再冲一段、涨过前高都行），但走完之后是 **${h.xx.aftermath}**——若随后跌破 ${n(h.term)}，下看 ${px(h.xx.down)}。`);
  L.push(`- **若是 B 反弹**：针对的是整段（${wholeLeg}，幅 ${n(h.whole)}），需要涨到 0.5/0.618/0.7 一线、即 **${px(h.b.targets)}**，之后是 **${h.b.aftermath}**——只是${h.b.timing}。`);
  L.push(`- **若直接是推动 3 浪（转势）**${main('three')}：那上方 ${px(h.three.targets)} 一线只作参考阻力，前提是反弹内部得走成五浪；果真如此，趋势就此翻多、上方不再设回撤上限。`);
  if (nearTerm) {
    const lv = nearTerm.levels;
    L.push('');
    L.push(`近端看：这波反弹取 ${n(nearTerm.from)}→${n(nearTerm.to)} 这条腿，须站上 **${n(lv[0].price)}** 才算真正好转，否则回落 **${n(lv[2].price)}**（中间 ${n(lv[1].price)} 是分水岭）。`);
  }
  return L.join('\n');
}

// ============================================================
// 6.7 多级别结论（父级大结构 + 当前段内部细化）：否定法派生、候选排名
// ============================================================
//
// 把「已走完的大跌 + 现在的反弹」放进一个更大的父级大浪型：
//   · 父级候选由「大跌性质(调整/推动) + 反弹性质(3波/5浪)」的硬闸门筛出，回撤深度做软信号排名；
//   · 被硬规则淘汰者照样列出并注明原因（否定法的价值＝看到什么被排除、为什么）。
// 再往下钻一层：当前段(X)内部最像什么形态、当前处于哪条腿（主选/次选，含分水岭）。

/**
 * 父级大结构派生（否定法）：返回幸存/淘汰候选，幸存者按回撤吻合度排名。
 */
function deriveParentDegree(tree) {
  const p = tree && tree.primary;
  const ips = tree && tree.inProgressStruct;
  if (!p || !ips || !ips.swingExtreme) return null;
  const dropMotive = p.klass === DRIVING;
  const bounceMotive = ips.swingChar === 'driving';
  const dropStart = p.points[0];
  const dropEnd = p.points[p.points.length - 1];
  const dropAmp = Math.abs(dropStart.price - dropEnd.price);
  const retrace = dropAmp > 0 ? Math.abs(ips.swingExtreme.price - dropEnd.price) / dropAmp : 0;
  const inval = dropEnd.price;
  const bh = tree.assessment && tree.assessment.bounceHyp;
  const tgt = (arr) => (arr ? arr.filter((t) => t.price > 0).map((t) => Math.round(t.price)) : []);

  const cands = [
    {
      key: 'combination', parentCn: '更大的联合调整（w-x-y）', dropLabel: 'W', curLabel: 'X 连接浪',
      hardOk: !dropMotive, elimReason: dropMotive ? 'W 须为调整，而大跌是推动' : null,
      band: [0, 0.5], targets: bh ? tgt(bh.xx.targets) : [],
      basis: 'X 连接浪通常浅、可为任意调整形态，与当前浅反弹吻合',
    },
    {
      key: 'flat', parentCn: '更大的平台型调整（a-b-c）', dropLabel: 'A', curLabel: 'B 浪',
      hardOk: !dropMotive, elimReason: dropMotive ? 'A 须为调整，而大跌是推动' : null,
      band: [0.5, 1.05], targets: bh ? tgt(bh.b.targets) : [],
      basis: '规则平台 B 浪须回撤 A 的约 90%+；当前回撤浅，按比例偏弱',
    },
    {
      key: 'zigzag', parentCn: '更大的之字型调整（a-b-c）', dropLabel: 'A', curLabel: 'B 浪',
      hardOk: dropMotive, elimReason: !dropMotive ? 'A 须为 5 浪推动，而大跌是调整（三锯齿）' : null,
      band: [0.5, 0.79], targets: bh ? tgt(bh.b.targets) : [],
      basis: '之字的 A 浪须为推动',
    },
    {
      key: 'impulse', parentCn: '新的推动浪（转势）', dropLabel: '（前置熊市调整）', curLabel: '1/3 浪',
      hardOk: bounceMotive, elimReason: !bounceMotive ? '反弹内部须为 5 浪，而实测 3 波' : null,
      band: [0.5, 99], targets: bh ? tgt(bh.three.targets) : [],
      basis: '反弹内部须走成五浪方成立',
    },
  ];

  const scoreOf = (c) => {
    if (!c.hardOk) return Infinity;
    const [lo, hi] = c.band;
    if (retrace >= lo && retrace <= hi) {
      const center = (lo + Math.min(hi, 1.05)) / 2;
      return Math.abs(retrace - center); // 命中带内，越靠中心越好
    }
    return 10 + Math.min(Math.abs(retrace - lo), Math.abs(retrace - hi)); // 带外罚分
  };
  cands.forEach((c) => { c.score = scoreOf(c); });
  const survivors = cands.filter((c) => c.hardOk).sort((a, b) => a.score - b.score);
  const eliminated = cands.filter((c) => !c.hardOk);
  survivors.forEach((c, i) => { c.rank = i === 0 ? 'primary' : 'alt'; c.rankNo = i; });
  eliminated.forEach((c) => { c.rank = 'eliminated'; });
  return {
    retrace, invalidation: inval,
    dropStart: dropStart.price, dropEnd: dropEnd.price,
    survivors, eliminated, primary: survivors[0] || null, all: [...survivors, ...eliminated],
  };
}

/**
 * 当前段(X)内部细化：内部最像什么形态、当前处于哪条腿（主选/次选，含分水岭）。用日线枢轴。
 */
function deriveCurrentInternal(tree, parentCurLabel, tfLabel) {
  const ips = tree && tree.inProgressStruct;
  if (!ips || !ips.swingExtreme) return null;
  const cur = parentCurLabel || '当前段';
  const tf = tfLabel || '本周期';
  const up = ips.upTree && ips.upTree.primary;
  const refPatCn = up ? plainLabel(up.patternId) : '三波';
  const startPrice = ips.invalidation; // X 起点 = 已确认结构终点（如 57718）
  const ext = ips.swingExtreme;         // 摆动极值（如 66924）
  const hasPb = !!(ips.pullback && ips.pullback.to.index !== ext.index);
  const now = hasPb ? ips.pullback.to : ext;
  const structUp = ips.structUp;
  const R = (v) => Math.round(v);
  const aDir = structUp ? '上涨' : '下跌';
  const bDir = structUp ? '下跌' : '上涨';
  const aAmp = Math.abs(ext.price - startPrice);

  // X 这一层数成 a-b-c：a=起点→极值(完成)，b=极值→现在(进行中/回撤)，c=未走
  const legs = [];
  legs.push({ name: 'a', dirCn: aDir, from: startPrice, to: ext.price, status: '完成' });
  if (hasPb) {
    const refs = (ips.pullback.fibTargets || []).map((t) => R(t.price));
    legs.push({ name: 'b', dirCn: bDir, from: ext.price, to: now.price, status: '进行中', current: true, refs });
    // c 腿投影：从 b 腿 0.5 回撤位起、按 a 腿幅度 0.618/1.0 倍投影（推断）
    const bMid = (ips.pullback.fibTargets && ips.pullback.fibTargets[1]) ? ips.pullback.fibTargets[1].price : now.price;
    const sgn = structUp ? 1 : -1;
    legs.push({ name: 'c', dirCn: aDir, from: null, to: null, status: '未走', targets: [0.618, 1.0].map((m) => R(bMid + sgn * aAmp * m)) });
  } else {
    legs[0].status = '进行中';
    legs[0].current = true;
    legs.push({ name: 'b', dirCn: bDir, from: null, to: null, status: '未走' });
    legs.push({ name: 'c', dirCn: aDir, from: null, to: null, status: '未走' });
  }
  const cur2 = legs.find((l) => l.current);
  const curName = cur2 ? cur2.name : null;
  const structHint = hasPb
    ? `${cur}内部（${tf}）走 a-b-c：a 腿 ${R(startPrice)}→${R(ext.price)} 已完成，**当前在 b 腿**（${R(ext.price)}→${R(now.price)}，回撤中）`
    : `${cur}内部（${tf}）**当前在 a 腿**（${R(startPrice)}→${R(now.price)}，进行中）`;
  return {
    refPatCn, tf, cur, structUp,
    startPrice, ext: ext.price, now: now.price, hasPb,
    legs, currentLegName: curName,
    altLabelNote: `若 ${cur} 内部为联合调整，则 a/b/c 对应 w/x/y`,
    confirmWord: structUp ? '重上' : '跌破', invalWord: structUp ? '跌破' : '升破',
    confirm: ext.price, invalidation: startPrice,
    structHint,
  };
}

/**
 * 多级别结论渲染（报告最顶）：三句话跨级别 + 父级候选排名表 + 当前段内部细化。
 */
function renderMultiDegree(tree, tfLabel) {
  const pd = deriveParentDegree(tree);
  if (!pd || !pd.primary) return '';
  const n = (v) => Math.round(v);
  const P = pd.primary;
  const ci = deriveCurrentInternal(tree, P.curLabel, tfLabel);
  const L = [];
  L.push('# 结论：大跌走完了什么、现在在哪');
  L.push('');
  L.push('> 概率性研判、非确定，不构成买卖建议。以下为「否定法」派生：硬规则淘汰、软信号排名。');
  L.push('');
  // 三句话（跨级别串起来）
  const s = [];
  s.push(`整段像 **${P.parentCn}**`);
  s.push(`已走完的 **${n(pd.dropStart)}→${n(pd.dropEnd)} 是 ${P.dropLabel} 浪**（完成）`);
  s.push(`现在 **${n(pd.dropEnd)} 起是 ${P.curLabel}**（进行中）`);
  if (ci) s.push(ci.structHint);
  s.push(`失效点 **${n(pd.invalidation)}**`);
  L.push(`${s.join('；')}。`);
  L.push('');

  // 大级别：父级候选排名
  L.push('## 大级别：整段在组成什么（父级候选，按吻合排序）');
  L.push('');
  L.push(`> 反弹已回撤大跌的 **${(pd.retrace * 100).toFixed(0)}%**（浅→偏 X 连接、深→偏 B、超越前高→偏转势）。`);
  L.push('');
  L.push('| 排名 | 父级大浪型 | 大跌= | 现在= | 目标价 | 依据 |');
  L.push('|---|---|---|---|---|---|');
  pd.survivors.forEach((c, i) => {
    const tag = i === 0 ? '✅ 主选' : `次选${i}`;
    L.push(`| ${tag} | ${c.parentCn} | ${c.dropLabel} | ${c.curLabel} | ${c.targets.join(' / ') || '—'} | ${c.basis} |`);
  });
  pd.eliminated.forEach((c) => {
    L.push(`| ❌ 淘汰 | ${c.parentCn} | ${c.dropLabel} | ${c.curLabel} | — | ${c.elimReason} |`);
  });
  L.push('');

  // 小级别：当前段内部的 a/b/c 逐腿
  if (ci) {
    L.push(`## 小级别：当前 ${P.curLabel} 内部的 a/b/c（${tfLabel || '本周期'}）`);
    L.push('');
    L.push(`按 ${P.curLabel} 这一层数成 a-b-c，当前处于 **${ci.currentLegName} 腿**：`);
    ci.legs.forEach((l) => {
      const mark = l.current ? ' ← **当前在此**' : '';
      if (l.status === '未走') {
        const tg = l.targets ? `，若转此腿常见目标 **${l.targets.join(' / ')}**（推断）` : '';
        L.push(`- **${l.name} 腿** · ${l.dirCn}：未走${tg}${mark}`);
      } else {
        const rf = l.refs ? `，回撤支撑参考 ${l.refs.join(' / ')}` : '';
        L.push(`- **${l.name} 腿** · ${l.dirCn}：**${n(l.from)} → ${n(l.to)}**（${l.status}）${rf}${mark}`);
      }
    });
    L.push(`- ${ci.altLabelNote}`);
    L.push(`- 分水岭：${ci.confirmWord} **${n(ci.confirm)}** 则 b 腿结束、转 c；${ci.invalWord} **${n(ci.invalidation)}** 则整套作废。`);
    L.push('');
  }
  return L.join('\n');
}

// 多级别结论序列化（JSON：parentDegree + currentInternal）
function serializeMultiDegree(tree, tfLabel) {
  const pd = deriveParentDegree(tree);
  if (!pd || !pd.primary) return null;
  const ci = deriveCurrentInternal(tree, pd.primary.curLabel, tfLabel);
  const candJson = (c) => ({
    parent: c.parentCn, dropLabel: c.dropLabel, currentLabel: c.curLabel,
    rank: c.rank, targets: c.targets, basis: c.basis, elimReason: c.elimReason || undefined,
  });
  return {
    invalidation: pd.invalidation, retrace: pd.retrace,
    dropRange: [pd.dropStart, pd.dropEnd],
    parentCandidates: pd.all.map(candJson),
    currentInternal: ci ? {
      refPattern: ci.refPatCn, currentLeg: ci.currentLegName,
      startPrice: ci.startPrice, ext: ci.ext, now: ci.now,
      legs: ci.legs.map((l) => ({ name: l.name, dir: l.dirCn, from: l.from, to: l.to, status: l.status, current: !!l.current, refs: l.refs, targets: l.targets })),
      altLabelNote: ci.altLabelNote, confirm: ci.confirm, invalidation: ci.invalidation,
    } : null,
  };
}

// ============================================================
// 6.8 排名数法（rank-competing-wave-counts §4）：把「结论」升级为多套完整数法排名
// ============================================================
//
// 与「父级候选」（deriveParentDegree，回答「大跌+反弹在组成什么更大结构」）是不同的轴：
// 这里回答「大跌本身最像哪种数法」——decompose() 现在能搜出多套顶层候选（框架A，
// 当前先只这一框架，框架B留给阶段三），把 tree.primary + tree.alternates 摊开成
// 主选1+备选3 的排名表，各带①现在的浪型 ②已走完的腿 ③当前在哪 ④评分。
// ③沿用 tree.inProgressStruct——框架A的所有候选共享同一个终点（全局低点），
// 所以「现在在哪」对每条候选都一样，不需要重算。

// 汇总一个候选的全部违规原因（规则违规 + 文法违规），供报告展示（违规原因写进文档）。
// 规则违规来自 score.failed（带 desc + overshoot 越界程度）；文法违规来自 score.grammarNotes。
function candidateViolations(candidate) {
  const s = candidate && candidate.score;
  if (!s) return [];
  // 展示层扣除被闸门暂缓的规则（gate-extending-final-leg-rules §2.3）：它们移到 deferred（⏳待判），
  // 不出现在违规列表；ranking 用的 score.failed/tier1 未动，扣除只发生在展示。
  const deferredIds = new Set((s.deferred || []).map((d) => d.id));
  const rules = (s.failed || [])
    .filter((f) => !deferredIds.has(f.id))
    .map((f) => ({ kind: 'rule', desc: f.desc, overshoot: f.overshoot || 0 }));
  const grammar = (s.grammarNotes || []).map((g) => ({ kind: 'grammar', desc: g.desc, overshoot: g.overshoot || 0 }));
  // 越界大的排前（更重的违规先显示）
  return [...rules, ...grammar].sort((a, b) => (b.overshoot || 0) - (a.overshoot || 0));
}

// 被可判定性闸门暂缓的规则（gate-extending-final-leg-rules §2.3）：进行中末腿上"延伸能翻转判决"
// 的规则不计违规，但透明列出为"待判"，供报告展示。
function candidateDeferred(candidate) {
  const s = candidate && candidate.score;
  if (!s || !s.deferred || !s.deferred.length) return [];
  return s.deferred.map((f) => ({ kind: 'deferred', desc: f.desc, overshoot: f.overshoot || 0 }));
}

// 违规原因一句话（供两份报告共用）：赘述规则本身 + 越界的定性程度。
// 不再显示 "(差 0.5%)" 这种归一化数值——它易被误当"差0.5个百分点"（实际 y 是 w 的 87.9%、
// 差 2.1 个百分点，归一化后才 0.005）。改为叙述规则 + 差一丝/差一点/差较多，并附归一化越界值。
function fmtViolReason(v) {
  if (!v) return '';
  if (v.kind === 'deferred') {
    const o = v.overshoot || 0;
    const mag = o < 0.02 ? '差一丝' : (o < 0.1 ? '差一点' : (o < 0.3 ? '差较多' : '差很远'));
    return `⏳ ${v.desc}：待末腿走完再判（当前${mag}，延伸可能翻转判定）`;
  }
  if (v.kind === 'grammar' || !v.overshoot) return v.desc;
  const o = v.overshoot;
  const mag = o < 0.02 ? '差一丝' : (o < 0.1 ? '差一点' : (o < 0.3 ? '差较多' : '差很远'));
  return `${v.desc}（${mag}，归一化越界 ${o.toFixed(3)}）`;
}

function candidateLegs(candidate) {
  const labels = waveLabelsFor(candidate.patternId);
  const pts = candidate.points;
  const lastIdx = pts.length - 2; // 末腿在 legs 里的下标
  const legs = [];
  for (let i = 0; i < pts.length - 1; i += 1) {
    // 末腿状态三态：
    //   · 落在 provisional 末点（朴素框架B：区间延伸到 now）→「⏳ 进行中」
    //   · 逆势框架B 的末浪进行中（finalWaveInProgress）→「⏳ 延伸中」——终点(全局极值)只是
    //     末浪内部拐点，之后可能延伸出新极值
    //   · 其余（框架A：终点=全局极值已确认）→「完成」
    let status = '完成';
    if (pts[i + 1].provisional) status = '⏳ 进行中';
    else if (candidate.finalWaveInProgress && i === lastIdx) status = '⏳ 延伸中';
    legs.push({ name: labels[i] || String(i + 1), from: pts[i].price, to: pts[i + 1].price, status });
  }
  return legs;
}

// 腿间比例硬闸门（rank-competing-wave-counts §3.3，Q7=a）：替代原一刀切裁区间防"大跌+
// 反弹硬塞一个形态、第1浪畸长"。只对框架B的顶层候选生效（post-hoc，不进 decompose 的
// 共享递归路径）——若把它做成通用规则会误伤深层合法的"3浪延伸"型推动浪（3浪本就该比
// 1/5浪大得多，是书内标准指引而非缺陷），只在"整段区间"这个入口层面把关才对症。
const LEG_PROPORTION_MAX_RATIO = 6;
function legProportionViolated(pts) {
  if (!Array.isArray(pts) || pts.length < 3) return false; // 只一条腿，无兄弟浪可比
  const amps = [];
  for (let i = 0; i < pts.length - 1; i += 1) amps.push(Math.abs(pts[i + 1].price - pts[i].price));
  const mn = Math.min(...amps);
  const mx = Math.max(...amps);
  if (mn <= 0) return true;
  return mx / mn > LEG_PROPORTION_MAX_RATIO;
}

function gateFrameworkBCandidate(c) {
  if (!legProportionViolated(c.points)) return c;
  // 违规：克隆一份带惩罚的分数，不动原始候选对象（框架B树仍可能被其它逻辑读取原始分）
  return {
    ...c,
    score: {
      ...c.score,
      tier1: c.score.tier1 + 1,
      failed: [...(c.score.failed || []), { id: 'leg-proportion-gate', layer: 'ratio', desc: `同级兄弟浪振幅比超过${LEG_PROPORTION_MAX_RATIO}倍（防大跌+反弹畸长塞入）`, overshoot: 0 }],
      penalized: true,
    },
  };
}

// 末腿终点不变量（gate-extending-final-leg-rules §2.1）：进行中末腿的终点 MUST 是该末腿区间内的
// 顺势极值——下跌腿取区间最低、上涨腿取区间最高。判据基于价格而非 now.type（now 处于"反弹后
// 回撤中"时枢轴类型可能与全局极值同型，type 判据失灵）。区间极值取自落在末腿 index 跨度内的细枢轴。
function finalLegAnchored(candidate, finePivots) {
  const pts = candidate && candidate.points;
  if (!Array.isArray(pts) || pts.length < 2) return true;
  const start = pts[pts.length - 2];
  const end = pts[pts.length - 1];
  const lo = Math.min(start.index, end.index);
  const hi = Math.max(start.index, end.index);
  const inSpan = (finePivots || []).filter((p) => p.index >= lo && p.index <= hi);
  const prices = inSpan.map((p) => p.price).concat(end.price);
  if (candidate.direction === 'down') {
    return end.price <= Math.min(...prices) + 1e-6; // 终点须为区间最低
  }
  return end.price >= Math.max(...prices) - 1e-6;   // 终点须为区间最高
}

// 过滤朴素框架B：剔除"末腿藏了更极端点"的畸形拟合（如双锯齿把 57718 压进 y 腿、终点却停在 78301），
// 只保留末腿终点=区间顺势极值者（如推动浪 81265→78301 单调下行、78301 即真低点）。
function filterFinalLegAnchored(fw, finePivots) {
  if (!fw || !fw.primary) return null;
  const kept = [fw.primary, ...(fw.alternates || [])].filter((c) => finalLegAnchored(c, finePivots));
  if (!kept.length) return null;
  return { ...fw, primary: kept[0], alternates: kept.slice(1) };
}

// 合并框架B 候选池（gate-extending-final-leg-rules §2.1）：过滤后的朴素B（顺势延伸中）∪ 逆势B
// （末浪延伸中、锚全局极值）。合并成单个 {primary, alternates}，交 buildRankedCounts 按形态去重。
function mergeFrameworkB(naiveKept, counterB) {
  const pool = [];
  if (naiveKept && naiveKept.primary) pool.push(naiveKept.primary, ...(naiveKept.alternates || []));
  if (counterB && counterB.primary) pool.push(counterB.primary, ...(counterB.alternates || []));
  if (!pool.length) return null;
  pool.sort((x, y) => compareCandidates(x.score, y.score));
  return { primary: pool[0], alternates: pool.slice(1), counterTrend: !!(counterB && counterB.counterTrend) };
}

// 可判定性闸门（gate-extending-final-leg-rules §2.2，单调性判据）：对进行中末腿，逐条已失败规则问
// 「末腿沿其合法方向延伸，能否翻转这条规则的判决」。用「把末点向趋势方向微移、重测越界是否变小」
// 的梯度法计算（无需逐规则手工标注单调方向，且天然正确处理上/下界）：新判定通过、或越界变小 → 该
// 规则可被延伸翻转（当前未违反可触发、或已违反可解除）→ 标为 deferred（待判）；否则照计。
// 与末腿终点无关的规则（子浪数/方向等）微移末点不改变其越界 → 自然归入照计。
//
// 关键：本闸门是「展示层重分类」，只往 score 追加 deferred 标记，**不改 failed/tier1/tier2**——
// 排序仍用完整 tier1（§2.4）。否则延伸中候选会因"少一条违规"跃过其同骨架的框架A完成候选抢占主选，
// 而未完成度惩罚（排在 tier1 之后）来不及生效。展示时（candidateViolations / 排名条目）再把 deferred
// 从违规里扣除、tier1 显示为扣除后值 → 用户看到"✅规则全过 + ⏳待判"，而排名位置由未完成度守住。
function applyInProgressRuleGate(candidate, candles) {
  const s = candidate && candidate.score;
  const failed = (s && s.failed) || [];
  if (!failed.length) return s;
  const pts = candidate.points;
  const finalPt = pts[pts.length - 1];
  const prevPt = pts[pts.length - 2];
  const legAmp = Math.abs(finalPt.price - prevPt.price) || 1;
  const sgn = candidate.direction === 'down' ? -1 : 1;
  const EPS = 0.02; // 末点向趋势方向微移 2% 末腿幅度，测越界梯度
  const perturbed = pts.map((p, i) => (i === pts.length - 1 ? { ...p, price: p.price + sgn * legAmp * EPS } : p));
  const rulesById = new Map(((candidate.manual && candidate.manual.rules) || []).map((r) => [r.id, r]));
  const ctx = { points: perturbed, direction: candidate.direction, candles, measures: candidate.measures };
  const deferred = [];
  for (const f of failed) {
    const rule = rulesById.get(f.id);
    if (!rule) continue;
    const res = safeTest(rule, ctx);
    if (res.pass || res.overshoot < (f.overshoot || 0) - 1e-9) deferred.push({ ...f });
  }
  if (!deferred.length) return s;
  return { ...s, deferred: [...(s.deferred || []), ...deferred] }; // 仅追加标记，failed/tier1/tier2 不动
}

// 框架B 逆势末浪进行中（model-unfinished-final-wave §3.1）：当 now 处于逆势极值（反弹高点/
// 回抽低点），朴素框架B（decompose 到 now）会因首尾类型不匹配返回空。此时改为复用框架A 的
// 顶层数法（同宏观骨架），但把其「最后一个宏观浪」重新解读为「进行中、还没终结在全局极值」——
// 全局极值只是末浪内部的一个拐点，当前逆势走势是末浪内部的回撤，之后可能延伸出新极值。
// 返回 { primary, alternates, counterTrend:true }，与朴素框架B 同形，供 buildRankedCounts 消费。
function buildCounterTrendFrameworkB(tree, finePivots, candles) {
  const p = tree && tree.primary;
  if (!p || !Array.isArray(p.points) || p.points.length < 2) return null;
  const term = p.points[p.points.length - 1]; // 框架A 末点 = 全局极值（如 57718 L）
  const now = Array.isArray(finePivots) && finePivots.length ? finePivots[finePivots.length - 1] : null;
  if (!now || !now.provisional) return null;
  if (now.index <= term.index) return null;     // now 未越过全局极值 → 无后续走势
  const down = p.direction === 'down';           // 净向下 → 末浪延伸=新低；净向上 → 新高
  // 守卫改为价格判据（gate-extending-final-leg-rules §2.1）：now 已是顺势新极值（下跌创新低/
  // 上涨创新高）→ 朴素框架B 已能处理，不走这里。不能用 now.type——now 处于反弹后回撤中时其枢轴
  // 类型可能与全局极值同型（下跌中 now 是回撤低点、type=L，与全局低点同型），基于 type 的判据会失灵。
  if (down ? now.price <= term.price : now.price >= term.price) return null;

  const sgn = down ? -1 : 1;
  const lastLegAmp = Math.abs(term.price - p.points[p.points.length - 2].price);
  // 末浪延伸的投影极值：从全局极值按末腿幅度的 0.382/0.618/1.0 倍继续（推断、非确定）
  const projection = [0.382, 0.618, 1.0].map((m) => ({ mult: m, price: term.price + sgn * lastLegAmp * m }));
  // 未完成度：当前逆势回撤越深 → "末浪还在延伸"越不可能（越可能已见底/见顶）→ 惩罚越大。
  const retraceRatio = lastLegAmp > 0 ? Math.min(1, Math.abs(now.price - term.price) / lastLegAmp) : 1;

  const reframe = (c) => {
    // 先按可判定性闸门把"延伸能翻转判决"的规则从违规移入 deferred，再叠未完成度惩罚。
    const gated = applyInProgressRuleGate(c, candles);
    return {
      ...c,
      finalWaveInProgress: true,
      projection,
      retraceFrom: term,
      retraceNow: now,
      score: { ...gated, incompleteness: retraceRatio },
    };
  };
  return {
    counterTrend: true,
    primary: reframe(p),
    alternates: (tree.alternates || []).slice(0, 3).map(reframe), // 只带前几族，避免把整张A表复制一遍
  };
}

const RANKED_MAX = 8; // 排名表上限：按形态去重后全列，设个上限防爆（rank-competing-wave-counts Q3 复议）

/**
 * 汇聚排名候选池（rank-competing-wave-counts §4.1）：框架A（完成，终点=全局极值）∪
 * 框架B（在建，终点=now，若存在）。同一把尺排序（compareCandidates 已含 incompleteness），
 * 然后「按形态去重、全列」：同一 (框架 + 形态) 只保留分最高的一条代表——真实行情里
 * 常有 5+ 条同形态、只差内部分点的近似重复（如多条双重横向整理），全列是噪音；
 * 去重后剩几条由「实际有几种本质不同的合规读法」决定，比钉死数量更诚实。上限 RANKED_MAX。
 */
function buildRankedCounts(tree) {
  if (!tree || tree.isLeaf || !tree.primary) return null;
  const fromA = [tree.primary, ...(tree.alternates || [])].map((c) => ({ c, framing: 'A' }));
  const fromB = tree.frameworkB && tree.frameworkB.primary
    ? [tree.frameworkB.primary, ...(tree.frameworkB.alternates || [])].map((c) => ({ c: gateFrameworkBCandidate(c), framing: 'B' }))
    : [];
  const sorted = [...fromA, ...fromB].sort((x, y) => compareCandidates(x.c.score, y.c.score));
  // 去重：同一 (框架 + patternId) 只留分最高的（sorted 已按分排序，故取首次出现即最优代表）。
  // 框架A的zigzag 与 框架B的zigzag 视为不同读法（完成 vs 在建），故键含 framing。
  const seen = new Set();
  const deduped = [];
  for (const item of sorted) {
    const key = `${item.framing}:${item.c.patternId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
    if (deduped.length >= RANKED_MAX) break;
  }
  return deduped.map(({ c, framing }, i) => ({
    rank: i === 0 ? 'primary' : `alt${i}`,
    framing,
    label: c.manual.label,
    direction: c.direction,
    legs: candidateLegs(c),
    violations: candidateViolations(c), // 违规原因明细（规则+文法），md/json 同源
    deferred: candidateDeferred(c), // 可判定性闸门暂缓的规则（"待判"），md/json 同源
    // 逆势框架B 的"末浪进行中"标记与投影，供渲染层展示"57718只是拐点、投影新低"
    finalWaveInProgress: !!c.finalWaveInProgress,
    projection: c.projection || null,
    invalidation: c.retraceFrom ? c.retraceFrom.price : null,
    // 展示 tier1/tier2 扣除被闸门暂缓的规则（§2.3/2.4）：ranking 已用完整 tier1 排完序，此处扣除只
    // 影响"❌违规×N / ✅规则全过"标签与越界显示，不影响已定的排名位置（未完成度守住 B 在 A 之后）。
    score: (() => {
      const d = c.score.deferred || [];
      const dOver = d.reduce((a, f) => a + (f.overshoot || 0), 0);
      return {
        tier1: c.score.tier1 - d.length,
        tier2: c.score.tier2 - dOver,
        incompleteness: c.score.incompleteness || 0,
        complexity: c.score.complexity,
        penalized: (c.score.tier1 - d.length) > 0,
      };
    })(),
  }));
}

function renderRankedCounts(tree) {
  const ranked = buildRankedCounts(tree);
  if (!ranked || !ranked.length) return '';
  const n = (v) => Math.round(v);
  const dirCn = (d) => (d === 'up' ? '上涨' : '下跌');
  const scoreTag = (s) => (s.tier1 === 0 ? '✅ 规则全过' : `❌ 违规×${s.tier1}`);
  const fmtViol = fmtViolReason; // 共用：赘述规则 + 定性越界程度（不再显示易误解的归一化%）
  const L = [];
  L.push('# 数法排名（现在的浪型是什么，按吻合排序）');
  L.push('');
  L.push('> 「否定法」派生：先看谁规则全过，同档再按越界距离/未完成度/简约度排名。主选展开，备选精简。');
  L.push('> 候选池含两种框架：**框架A**——大跌到全局极值即算完成；**框架B**——区间延伸到现在，当前走势可能只是更高级别、尚未走完的浪的内部子腿（"读法2"）。');
  L.push('');

  // 框架标签：框架A 的"完成"软化为"待确认"（model-unfinished-final-wave §3.2）；
  // 框架B 分「末浪进行中（逆势）」与「区间延伸到now（顺势）」两种措辞。
  const framingLine = (item) => {
    const ext = item.legs.length ? item.legs[item.legs.length - 1].to : null;
    const dn = item.direction === 'down';
    if (item.framing === 'A') {
      return ext != null
        ? `✅ 完成（待确认）：末浪终结于全局极值 **${n(ext)}**；若${dn ? '跌破' : '升破'} **${n(ext)}** 则末浪可能延伸、见框架B 读法`
        : '✅ 完成（待确认，框架A：区间止于全局极值）';
    }
    if (item.finalWaveInProgress) {
      const proj = (item.projection || []).map((t) => n(t.price)).join(' / ');
      return `⏳ 末浪进行中（框架B）：**${n(item.invalidation)}** 不是终点、只是末浪内部拐点；当前逆势走势是末浪的回撤，之后可能延伸出新${dn ? '低' : '高'}——投影 **${proj}**（推断）。重回极值另一侧则视为末浪已完成、见底/见顶`;
    }
    return '⏳ 在建（框架B：区间延伸到now，当前是其内部子腿）';
  };

  const [primary, ...alts] = ranked;
  L.push(`## ${primary.framing === 'A' ? '✅' : '⏳'} 主选：${primary.label}（${dirCn(primary.direction)}）`);
  L.push('');
  L.push(framingLine(primary));
  L.push('');
  let tag = scoreTag(primary.score);
  if (primary.score.tier1) tag += `（越界 ${primary.score.tier2.toFixed(3)}）`;
  if (primary.score.incompleteness > 0) tag += `｜未完成度 ${(primary.score.incompleteness * 100).toFixed(0)}%`;
  L.push(tag);
  L.push('');
  // 违规原因写全（Q1a/Q2a/Q3a）：主选逐条列，规则+文法都带
  if (primary.violations && primary.violations.length) {
    L.push('**⚠️ 违规原因：**');
    primary.violations.forEach((v) => L.push(`- ${fmtViol(v)}`));
    L.push('');
  }
  // 可判定性闸门暂缓项（gate-extending-final-leg-rules §2.3）：透明列出、不计违规
  if (primary.deferred && primary.deferred.length) {
    L.push('**⏳ 待判（延伸中末腿，暂不计违规）：**');
    primary.deferred.forEach((v) => L.push(`- ${fmtViol(v)}`));
    L.push('');
  }
  L.push('**① 各宏观腿（末腿若标"⏳进行中/延伸中"即当前所在）：**');
  primary.legs.forEach((l) => L.push(`- ${l.name} 腿：${n(l.from)} → ${n(l.to)}（${l.status}）`));
  L.push('');
  if (primary.framing === 'A' && tree.inProgressStruct) {
    L.push('**② 当前在哪：** 见下方「进行中结构」——当前在其后的在建腿，尚未确认。');
    L.push('');
  }

  if (alts.length) {
    L.push('## 备选');
    L.push('');
    L.push('| 排名 | 框架 | 浪型 | 方向 | 腿 | 评分 | 违规原因（最重一条） |');
    L.push('|---|---|---|---|---|---|---|');
    alts.forEach((c, i) => {
      const legsStr = c.legs.map((l) => `${l.name}:${n(l.from)}→${n(l.to)}${(l.status === '⏳ 进行中' || l.status === '⏳ 延伸中') ? '⏳' : ''}`).join(' ');
      let sc = scoreTag(c.score);
      if (c.score.incompleteness > 0) sc += `(未完${(c.score.incompleteness * 100).toFixed(0)}%)`;
      const fr = c.framing === 'B' ? (c.finalWaveInProgress ? '⏳B末浪' : '⏳B') : 'A';
      // Q4a：备选只列最重的一条违规原因（violations 已按越界降序，取首条）；规则全过则显示待判项（若有）
      const why = (c.violations && c.violations.length) ? fmtViol(c.violations[0])
        : ((c.deferred && c.deferred.length) ? fmtViol(c.deferred[0]) : '—');
      L.push(`| 备选${i + 1} | ${fr} | ${c.label} | ${dirCn(c.direction)} | ${legsStr} | ${sc} | ${why} |`);
    });
    L.push('');
    // 若有"末浪进行中"的框架B 备选，补一行投影说明（否则表里只有"延伸中"三字、没数）
    const cb = alts.find((c) => c.finalWaveInProgress);
    if (cb) {
      const proj = (cb.projection || []).map((t) => n(t.price)).join(' / ');
      L.push(`> ⏳B末浪：${cb.label} 的末浪可能未走完——**${n(cb.invalidation)}** 只是拐点，若${cb.direction === 'down' ? '跌破' : '升破'}则延伸新${cb.direction === 'down' ? '低' : '高'}，投影 **${proj}**（推断）。`);
      L.push(`> （这是"顶层数法"这一轴的看跌可能；下方「结论」节的 XX/B 反弹身份是"反弹在更大结构里是什么"这一轴的同一看跌可能，两者互为印证、非重复。）`);
      L.push('');
    }
  }
  return L.join('\n');
}

function serializeRankedCounts(tree) {
  return buildRankedCounts(tree);
}

// 当前进行浪竞争结构渲染（enumerate-current-wave-structures）。
function renderCurrentWaveStructures(tree) {
  const cws = tree && tree.currentWaveStructures;
  if (!cws || !Array.isArray(cws.structures) || !cws.structures.length) return '';
  const n = (v) => Math.round(v);
  const L = [];
  L.push('# 当前进行浪：可能的具体结构（按吻合排序）');
  L.push('');
  L.push(`> 当前进行浪段 **${n(cws.spanLast)} → ${n(cws.ext)}（摆动极值）→ ${n(cws.now)}（现在）**；上冲/回落段内部性格：**${cws.leg1Char === 'driving' ? '五浪(偏推动)' : cws.leg1Char === 'corrective' ? '三波(偏调整)' : '待明'}**。`);
  L.push('> 每条给出：具体子计数 + 当前浪位 + 下一浪投影 + 失效点。含"在建型"（你正处第 k 浪、其后投影）。投影/失效点均为推断，非确定，不构成买卖建议。');
  L.push('');
  L.push('| 排名 | 结构 | 倾向 | 子计数（腿） | 当前浪位 | 下一浪投影 | 失效点 | 评分 |');
  L.push('|---|---|---|---|---|---|---|---|');
  cws.structures.forEach((s, i) => {
    const legs = s.legs.map((l) => `${l.name}:${n(l.from)}→${l.to == null ? '?' : n(l.to)}${l.status === '⏳进行中' ? '⏳' : (l.status === '未走' ? '…' : '')}`).join(' ');
    const projTxt = (s.projection || []).map((p) => n(p.price)).join(' / ');
    const score = s.tier1 === 0 ? '✅ 规则全过' : `❌ 违规×${s.tier1}`;
    L.push(`| ${i + 1} | ${s.label} | ${s.tendency} | ${legs} | ${s.currentWave} | ${projTxt} | ${n(s.invalidation.price)}（${s.invalidation.reason}） | ${score} |`);
  });
  L.push('');
  L.push('> ⏳=进行中腿，…=未走（仅投影）。"看跌"续大势创新低、"看多"转势、"中继"先反弹后续大势——三轴并列，谁被失效点证伪谁淘汰。');
  L.push('');
  return L.join('\n');
}

function serializeCurrentWaveStructures(tree) {
  return tree && tree.currentWaveStructures ? tree.currentWaveStructures : null;
}

function situationAssessment(tree, candles, finePivots) {
  if (!tree || tree.isLeaf || !tree.primary) return null;
  const p = tree.primary;
  const topStart = p.points[0];
  const topEnd = p.points[p.points.length - 1];
  const isMotive = p.klass === DRIVING;
  const structDir = p.direction;
  const bigTrend = isMotive ? structDir : (structDir === 'up' ? 'down' : 'up');

  // 身份研判改由「进行中上冲/下跌段」的内部性格驱动（QB=自动改主选）：
  // 上冲段走成五浪→倾向推动3(转势)；三波→倾向 XX/B 反弹。取代旧的「整条在建腿」口径
  // （旧口径把已回撤的震荡也算进去，性格会被噪声污染）。
  const ips = tree.inProgressStruct;
  const ip = tree.inProgress;
  let currentDir = null;
  let roleChar = null;
  if (ips && ips.swingChar) {
    roleChar = ips.swingChar;
    currentDir = ips.structUp ? 'up' : 'down';
  } else if (ip) {
    currentDir = ip.currentLegDir;
    const lo = Math.min(ip.from.index, ip.to.index);
    const hi = Math.max(ip.from.index, ip.to.index);
    const legFine = (finePivots || []).filter((x) => x.index >= lo && x.index <= hi);
    if (legFine.length >= MIN_POINTS[CORRECTIVE]) {
      roleChar = legCharacter(legFine, candles, 0, { beamK: 3, maxDepth: 4 }).character;
    }
  }

  const invalidation = topEnd.price;

  return {
    topLabel: p.manual.label, topStart, topEnd, isMotive, structDir,
    bigTrend, currentDir, roleChar, invalidation, primary: bigTrend,
    // Q8=a：身份框架（XX/B/推动3）取代旧的看涨/看跌双情景
    bounceHyp: bounceHypotheses(p.points, roleChar),
    nearTerm: nearTermTrigger(topEnd, finePivots),
    channel: tree.channel, fibTimeWindows: tree.fibTimeWindows,
    // 进行中结构：两个锚点（摆动极值 + 当前价）与当前浪位一句话所需数据
    inProgressStruct: ips,
    swingExtreme: ips ? ips.swingExtreme : null,
    currentPrice: ips && ips.pullback ? ips.pullback.to : (ip ? ip.to : null),
  };
}

// 当前浪位一句话（QC=单一最佳判断 + 失效点，后跟一行次选兜底）。
// 两个锚点都说清（Q1）：上冲/下跌段的摆动极值 + 当前已回到的价。
function renderCurrentWaveLine(a) {
  const n = (v) => Math.round(v);
  const ips = a.inProgressStruct;
  const ext = a.swingExtreme.price;
  const now = a.currentPrice ? a.currentPrice.price : ext;
  const moveCn = ips.structUp ? '上冲' : '下跌';
  const pbCn = ips.structUp ? '回撤' : '反抽'; // 逆着上冲/下跌的那一下
  const pbLegCn = ips.structUp ? '回落腿' : '反抽腿';
  const backCn = ips.structUp ? '已回到' : '已反抽到';
  const newExtCn = ips.structUp ? '再创新高' : '再创新低';
  const inval = n(ips.invalidation);
  let main;
  let alt;
  if (ips.swingChar === 'driving') {
    main = `**${moveCn}段（${inval}→${n(ext)}）内部走成了五浪**，疑似新趋势的推动 1 浪已走完；当前多半在其后的 **2 浪${pbCn}**（${backCn} **${n(now)}**）。`;
    alt = `次选：这五浪只是更大级别反弹里的一条腿（XX/B），${pbCn}走完后仍回原方向。`;
  } else if (ips.swingChar === 'corrective') {
    main = `**${moveCn}段（${inval}→${n(ext)}）内部是三波**，属反弹/调整性质；当前在其后的 **${pbLegCn}**（${backCn} **${n(now)}**），倾向 XX 连接浪或 B 浪身份。`;
    alt = `次选：若${pbCn}后${newExtCn}、且内部转成五浪，则升级为推动 3 浪（转势）。`;
  } else {
    main = `**${moveCn}段（${inval}→${n(ext)}）内部结构还看不清**；当前 ${backCn} **${n(now)}**。`;
    alt = `次选：待内部走清是五浪还是三波，再定身份。`;
  }
  const invalLine = ips.structUp
    ? `失效点 **${inval}**（跌破则此数法作废）；重回 **${n(ext)}** 之上则${moveCn}结构延续、回撤结束。`
    : `失效点 **${inval}**（升破则此数法作废）；重回 **${n(ext)}** 之下则${moveCn}结构延续、反抽结束。`;
  return `> 🎯 **当前浪位**：${main}${invalLine}\n>\n> ${alt}`;
}

function renderAssessment(a) {
  if (!a) return '# 现状研判\n\n（数据不足，暂无法研判）';
  const n = (v) => Math.round(v);
  const dirCn = (d) => (d === 'up' ? '上涨' : '下跌');
  const roleCn = a.roleChar === 'driving'
    ? '内部像五浪，更像"新趋势的 1 浪"（偏进攻）'
    : a.roleChar === 'corrective'
      ? '内部像三波，更像"修正的 A 浪"（偏反弹）'
      : '内部结构还看不清';
  const L = [];
  L.push('# 现状研判（先看这里）');
  L.push('');
  L.push('> 结论在前、历史计数在后作支撑。以下均为概率性研判，仅辅助、非确定，不构成买卖建议。');
  L.push('');

  // ① —— 一段话说清"这段是什么、现在走到哪"
  L.push('## ① 当前处于什么浪型');
  L.push('');
  let s1 = `从 **${n(a.topStart.price)}** 到 **${n(a.topEnd.price)}** 这一整段，最像一个已经走完的 **${a.topLabel}**（方向${dirCn(a.structDir)}）。`;
  if (a.currentDir) s1 += `此后从 **${n(a.topEnd.price)}** 起，正在走一段**还没走完的${dirCn(a.currentDir)}**——${roleCn}。`;
  L.push(s1);
  if (a.inProgressStruct && a.swingExtreme) {
    L.push('');
    L.push(renderCurrentWaveLine(a));
  }
  L.push('');

  // ② —— 趋势 + 失效点，讲清"为什么"
  L.push('## ② 现在是什么趋势');
  L.push('');
  const trendWhy = a.isMotive
    ? '上一段是**推动浪**，意味着新趋势已经确立'
    : '上一段是**调整浪**，意味着这轮修正已经走完、原来的趋势正在恢复';
  let s2 = `大级别看**偏${a.bigTrend === 'up' ? '多' : '空'}**——因为${trendWhy}；当前波段是${a.currentDir ? `**${dirCn(a.currentDir)}**` : '横向整理'}。`;
  s2 += `这套判断有一条**失效点：${n(a.invalidation)}**——一旦${a.structDir === 'down' ? '跌破' : '升破'}它，上面的大局就作废、要翻到另一种情景去。`;
  L.push(s2);
  L.push('');

  // 通道下边界作为参考支撑（原 ③「当前反弹三种身份 + 目标价」已并入顶部「结论」节）
  if (a.channel && a.channel.baseAt != null) {
    L.push(`另外，艾略特通道的下边界大约在 **${n(a.channel.baseAt)}**，可作一条参考支撑。`);
    L.push('');
  }

  // ③ —— 时间窗
  if (a.fibTimeWindows && a.fibTimeWindows.length) {
    L.push('## ③ 什么时候可能转（斐波时间窗，仅辅助）');
    L.push('');
    L.push(`多个枢轴的斐波时间在这几天重合，是潜在的转折时间窗：${a.fibTimeWindows.map((w) => `**${fmtTime(w.ts * 1000)}**（${w.count}源）`).join('、')}。`);
  }
  return L.join('\n');
}

/**
 * 「给我的数法打分」：用户手动指定一组宏观点（W-X-Y 之类），逐条评估它在各匹配形态下
 * 的规则是否通过、文法是否成立，按拟合分排序返回。用来回答「我这个数法行不行」。
 *
 * @param macroPoints [{price,type,index,timestamp}] 用户指定的浪型端点（交替 H/L）
 * @param finePivots  细枢轴全集（用于文法：判断每条腿的子结构）
 */
function evaluateExplicitCount(macroPoints, finePivots, candles, options = {}) {
  const opts = { beamK: 3, maxDepth: options.maxDepth || 4 };
  const start = macroPoints[0];
  const end = macroPoints[macroPoints.length - 1];
  const direction = end.price >= start.price ? 'up' : 'down';
  const results = [];

  for (const pat of PATTERNS) {
    if (pat.points !== macroPoints.length) continue;
    const seq = seqOf(direction, pat.points);
    if (!macroPoints.every((p, i) => p.type === seq[i])) continue;

    const measures = computeMeasures(macroPoints, direction, candles);
    const ctx = { points: macroPoints, direction, candles, measures };
    const m = pat.build(direction);
    const score = scoreCandidate(ctx, m);
    const ruleResults = m.rules.map((r) => {
      const res = safeTest(r, ctx);
      return { desc: r.desc, pass: res.pass, overshoot: res.overshoot };
    });

    // 文法：逐腿判「能否胜任所需角色」，无法胜任才违规（grammar-role-fulfillment，与 decompose 一致）
    let grammarViolations = 0;
    const legNotes = [];
    for (let i = 0; i < pat.childRoles.length; i += 1) {
      const role = pat.childRoles[i];
      const childFine = sliceFine(finePivots, macroPoints[i], macroPoints[i + 1]);
      if (childFine.length >= rolePoints(role)) {
        const requiredChar = role === DRIVING ? 'driving' : 'corrective';
        const lc = legCharacter(childFine, candles, 1, opts);
        if (grammarViolatesRole(lc, requiredChar)) {
          grammarViolations += 1;
          const cn = (c) => (c === 'driving' ? '驱动浪(五浪)' : '调整浪(三波)');
          // 歧义腿已不违规；能到这里说明所需方向拆不干净，据实说明它实测更像哪种
          legNotes.push(`第${i + 1}腿（须为${cn(requiredChar)}）走不成干净的${cn(requiredChar)}（实测更像${cn(lc.character)}）`);
        }
      }
    }

    const total = {
      tier1: score.tier1 + grammarViolations,
      tier2: score.tier2,
      tier3: score.tier3,
      tier4: 0,
      complexity: patternComplexity(pat.id),
    };
    results.push({ patternId: pat.id, label: m.label, ruleResults, grammarViolations, legNotes, total, guidelineHits: score.hits.length, guidelineTotal: score.guidelineTotal });
  }

  results.sort((a, b) => compareCandidates(a.total, b.total));

  // 当前反弹身份研判：反弹 = 用户结构终点 → 最新细枢轴；性格用 legCharacter
  let bounceHyp = null;
  let nearTerm = null;
  const term = macroPoints[macroPoints.length - 1];
  const edge = finePivots && finePivots.length ? finePivots[finePivots.length - 1] : null;
  if (edge && edge.index > term.index) {
    const lo = Math.min(term.index, edge.index);
    const hi = Math.max(term.index, edge.index);
    const bounceFine = finePivots.filter((x) => x.index >= lo && x.index <= hi);
    let bounceChar = null;
    if (bounceFine.length >= MIN_POINTS[CORRECTIVE]) {
      bounceChar = legCharacter(bounceFine, candles, 0, { beamK: 3, maxDepth: 4 }).character;
    }
    bounceHyp = bounceHypotheses(macroPoints, bounceChar);
    nearTerm = nearTermTrigger(term, finePivots);
  }
  return { direction, results, bounceHyp, nearTerm };
}

/**
 * 从一串价格构造宏观点（类型按交替推断：若首价高于次价则起于 H，否则起于 L），
 * 每个点定位到最接近的 K 线高/低点。供 --count 让用户直接喂自己的数法。
 */
function pointsFromPrices(prices, candles) {
  if (!Array.isArray(prices) || prices.length < 2) return null;
  const startH = prices[0] > prices[1];
  return prices.map((price, i) => {
    const type = ((i % 2 === 0) === startH) ? 'H' : 'L';
    let bi = -1;
    let bd = Infinity;
    for (let idx = 0; idx < candles.length; idx += 1) {
      const v = type === 'H' ? candles[idx].high : candles[idx].low;
      const d = Math.abs(v - price);
      if (d < bd) { bd = d; bi = idx; }
    }
    return { index: bi, type, price, timestamp: candles[bi] ? candles[bi].timestamp : 0 };
  });
}

/**
 * 「给我的数法打分」的大白话渲染。
 */
function renderExplicitVerdict(evalResult) {
  const L = [];
  if (evalResult.results.length === 0) {
    return '这组点数不匹配任何已知形态（点数或高低点类型对不上）。';
  }
  L.push(`方向：${evalResult.direction === 'up' ? '上涨' : '下跌'}　可套用的形态（按拟合优劣排序）：`);
  evalResult.results.forEach((r, idx) => {
    const clean = r.total.tier1 === 0;
    L.push('');
    L.push(`${idx + 1}. **${r.label}** —— ${clean ? '✅ 规则全过' : `❌ 有 ${r.total.tier1} 处不符`}`);
    r.ruleResults.forEach((rr) => {
      L.push(`   - ${rr.pass ? '✔' : '✗'} ${rr.desc}${rr.pass ? '' : `（越界约 ${(rr.overshoot * 100).toFixed(0)}%）`}`);
    });
    if (r.grammarViolations > 0) r.legNotes.forEach((n) => L.push(`   - ✗ ${n}`));
  });
  if (evalResult.bounceHyp) {
    L.push('');
    L.push('#### 按这个数法，当前反弹的三种身份');
    L.push('');
    L.push(renderBounceHypotheses(evalResult.bounceHyp, evalResult.nearTerm));
  }
  return L.join('\n');
}

/**
 * 调试用：把计数树主链渲染成缩进文本（M4 的正式报告在后续里程碑）。
 */
function renderTreeText(node, depth = 0) {
  const pad = '  '.repeat(depth);
  if (depth === 0 && node && node.inProgress) {
    const ip = node.inProgress;
    const tg = ip.fibTargets.map((t) => `${t.mult}×→${t.price.toFixed(0)}`).join(', ');
    const head = `⏳ 当前进行中浪（未确认）：${ip.from.price}→${ip.to.price}（末腿${ip.currentLegDir}）｜预期(${ip.note}) ${tg}`;
    return `${head}\n${renderTreeText({ ...node, inProgress: undefined }, depth)}`;
  }
  if (!node || node.isLeaf) {
    const seg = node && node.segFine;
    const rng = seg && seg.length ? `${seg[0].price}→${seg[seg.length - 1].price}` : '';
    return `${pad}· 末级/不可再分 ${rng}`;
  }
  const p = node.primary;
  const s = p.score;
  const tag = s.tier1 === 0 ? 'OK' : `违规×${s.tier1}`;
  const marks = [];
  if (p.status === '进行中') marks.push(`进行中(第${p.currentWave}/共${p.totalWaves}浪)`);
  if (s.tier4) marks.push(`跨级别+${s.tier4}`);
  if (p.truncated) marks.push('衰竭');
  if (p.volumeNote) marks.push(p.volumeNote);
  const suffix = marks.length ? ` 《${marks.join('；')}》` : '';
  const lines = [`${pad}${p.manual.label} · ${p.direction} [${tag}, 越界${s.tier2.toFixed(3)}, 指引${p.score.hits.length}/${p.score.guidelineTotal}] ${p.points[0].price}→${p.points[p.points.length - 1].price}${suffix}`];
  if (p.expectation) {
    const tg = p.expectation.fibTargets.map((t) => `${t.mult}×→${t.price.toFixed(0)}`).join(', ');
    lines.push(`${'  '.repeat(depth + 1)}↳ 预期(${p.expectation.note})：末腿${p.expectation.currentLegDir}，完成区间 ${tg}`);
  }
  for (const child of p.children) lines.push(renderTreeText(child, depth + 1));
  return lines.join('\n');
}

// ============================================================
// 7. 输出（Q13）：JSON 计数树 schema + Markdown 报告 + CLI
// ============================================================

const fs = require('fs/promises');

function pad2(n) { return String(n).padStart(2, '0'); }

function fmtTime(input, offsetHours = 8) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return String(input);
  const s = new Date(d.getTime() + offsetHours * 3600 * 1000);
  return `${s.getUTCFullYear()}-${pad2(s.getUTCMonth() + 1)}-${pad2(s.getUTCDate())} ${pad2(s.getUTCHours())}:${pad2(s.getUTCMinutes())}`;
}

// 秒级时间戳：YYYY-MM-DD HH:mm:ss（默认 UTC+8），报告头用
function fmtTimeSec(input, offsetHours = 8) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return String(input);
  const s = new Date(d.getTime() + offsetHours * 3600 * 1000);
  return `${s.getUTCFullYear()}-${pad2(s.getUTCMonth() + 1)}-${pad2(s.getUTCDate())} ${pad2(s.getUTCHours())}:${pad2(s.getUTCMinutes())}:${pad2(s.getUTCSeconds())}`;
}

// 报告头（分析报告元信息块）
function renderReportMeta(meta) {
  const n2 = (v) => (v == null ? '—' : Number(v).toFixed(2));
  const L = [];
  L.push('# 分析报告');
  L.push('');
  L.push(`- 品种：${meta.product}`);
  L.push(`- 周期：${meta.timeframe}`);
  L.push(`- 时间范围（UTC+8）：${fmtTimeSec(meta.startUtc)} ~ ${fmtTimeSec(meta.endUtc)}`);
  L.push(`- 样本数量：${meta.sampleCount} 根K线`);
  L.push(`- 区间最高/最低：${n2(meta.rangeHigh)} / ${n2(meta.rangeLow)}`);
  if (meta.lastClose != null) {
    L.push(`- 最新收盘：${n2(meta.lastClose)}（${fmtTimeSec(meta.lastCloseTs * 1000)} UTC+8）`);
  }
  L.push(`- 生成时间：${fmtTimeSec(meta.generatedAtUtc)}（UTC+8）`);
  L.push(`- 数据来源：${meta.source}`);
  return L.join('\n');
}

// 文件名用的紧凑时间戳：YYYYMMDDHHmm（默认 UTC+8）
function stampCompact(input, offsetHours = 8) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  const s = new Date(d.getTime() + offsetHours * 3600 * 1000);
  return `${s.getUTCFullYear()}${pad2(s.getUTCMonth() + 1)}${pad2(s.getUTCDate())}${pad2(s.getUTCHours())}${pad2(s.getUTCMinutes())}`;
}

function waveLabelsFor(patternId) {
  if (patternId === 'impulse-strict' || patternId === 'diagonal') return ['1', '2', '3', '4', '5'];
  if (patternId === 'zigzag-double' || patternId === 'sideways-double') return ['w', 'x', 'y'];
  if (patternId === 'zigzag-triple' || patternId === 'sideways-triple') return ['w', 'x', 'y', 'xx', 'z'];
  return ['a', 'b', 'c', 'd', 'e']; // 单锯齿/平台/三角
}

/**
 * 计数树节点序列化（Q13 schema）。alternates 只做浅层（label + fitScore），避免体积爆炸。
 */
function serializeNode(node, depth, waveLabel) {
  if (!node || node.isLeaf) {
    const seg = node && node.segFine;
    return {
      isLeaf: true, degree: depth, waveIndexInParent: waveLabel, status: '末级/不可再分',
      from: seg && seg[0] ? seg[0].price : null,
      to: seg && seg.length ? seg[seg.length - 1].price : null,
    };
  }
  const p = node.primary;
  const labels = waveLabelsFor(p.patternId);
  return {
    isLeaf: false, degree: depth, waveIndexInParent: waveLabel,
    patternId: p.patternId, label: p.manual.label, direction: p.direction,
    points: p.points.map((pt) => ({ price: pt.price, type: pt.type, index: pt.index, timestamp: pt.timestamp, provisional: pt.provisional || undefined })),
    fitScore: {
      tier1: p.score.tier1, tier2: p.score.tier2, tier3: p.score.tier3, tier4: p.score.tier4,
      grammarViolations: p.score.grammarViolations, penalized: p.score.penalized,
      violations: p.score.failed, guidelineHits: p.score.hits.length, guidelineTotal: p.score.guidelineTotal,
    },
    status: p.status || null,
    currentWave: p.currentWave, totalWaves: p.totalWaves,
    expectation: p.expectation || null,
    truncated: !!p.truncated, volumeNote: p.volumeNote || null,
    children: p.children.map((c, i) => serializeNode(c, depth + 1, labels[i] || String(i + 1))),
    // 顶层 alternates 现在可能很多（供排名表按形态去重全列，见 decompose 顶层不截断），
    // 序列化时按形态去重、只留每族最优代表、上限 8，避免 JSON 体积爆炸。
    alternates: dedupeAlternatesForSerialize(node.alternates).map((a) => ({
      patternId: a.patternId, label: a.manual.label, direction: a.direction,
      fitScore: { tier1: a.score.tier1, tier2: a.score.tier2, tier3: a.score.tier3, tier4: a.score.tier4 },
    })),
  };
}

// 序列化用：alternates 按 patternId 去重（保留分最高的代表，node.alternates 已按分排序）、上限 8。
function dedupeAlternatesForSerialize(alts) {
  const seen = new Set();
  const out = [];
  for (const a of alts || []) {
    if (seen.has(a.patternId)) continue;
    seen.add(a.patternId);
    out.push(a);
    if (out.length >= 8) break;
  }
  return out;
}

function serializeTree(tree) {
  const root = serializeNode(tree, 0, null);
  if (tree && tree.channel) {
    root.channel = {
      channelType: tree.channel.channelType,
      baseAt: tree.channel.baseAt,
      railAt: tree.channel.railAt,
      note: tree.channel.note,
      exitHint: tree.channel.exitHint,
    };
  }
  if (tree && Array.isArray(tree.fibTimeWindows) && tree.fibTimeWindows.length) {
    root.fibTimeWindows = tree.fibTimeWindows.map((w) => ({ bar: w.bar, count: w.count, timestamp: w.ts }));
  }
  if (tree && tree.inProgress) {
    root.inProgress = {
      from: tree.inProgress.from.price, to: tree.inProgress.to.price,
      currentLegDir: tree.inProgress.currentLegDir, note: tree.inProgress.note,
      fibTargets: tree.inProgress.fibTargets,
    };
  }
  return root;
}

// 形态 id → 大白话名称（藏掉英文与打分术语）
function plainLabel(patternId) {
  const map = {
    'impulse-strict': '五浪推动',
    diagonal: '楔形推动',
    zigzag: '锯齿型调整（a-b-c）',
    'zigzag-double': '双锯齿（w-x-y）',
    'zigzag-triple': '三锯齿（w-x-y-xx-z）',
    flat: '平台型调整（a-b-c）',
    'flat-regular': '规则平台形',
    'flat-expanded': '扩散平台形',
    'flat-running': '顺势平台形',
    'sideways-double': '双重横向整理（w-x-y）',
    'sideways-triple': '三重横向整理（w-x-y-xx-z）',
    triangle: '收缩三角形（a-b-c-d-e）',
  };
  return map[patternId] || patternId;
}

/**
 * 大白话报告：不含任何打分术语，只讲「大局 / 分几段 / 现在在哪 / 可能到哪」。
 */
function renderNarrative(meta, tree) {
  const L = [];
  const dirCn = (d) => (d === 'up' ? '上涨' : '下跌');
  const fmtTs = (sec) => fmtTime(sec * 1000); // 枢轴 timestamp 是秒，需 ×1000
  L.push('# BTC 数浪（大白话版）');
  L.push('');

  if (!tree || tree.isLeaf || !tree.primary) {
    L.push('数据不足，暂时数不出浪型。');
    return L.join('\n');
  }

  const p = tree.primary;
  const a = p.points[0];
  const b = p.points[p.points.length - 1];
  L.push('## 一句话大局');
  L.push('');
  L.push(`从 **${a.price}**（${fmtTs(a.timestamp)}）到 **${b.price}**（${fmtTs(b.timestamp)}），`);
  L.push(`整段走势最像一个 **${plainLabel(p.patternId)}**，方向 **${dirCn(p.direction)}**。`);
  if (p.score.tier1 > 0) {
    L.push('');
    L.push(`> ⚠️ 这段真实走势并不完全规整——上面是几种数法里**最接近**的一种（有 ${p.score.tier1} 处不满足书里的硬性规则）。当作参考，别当定论。`);
  }
  L.push('');

  L.push('## 拆成几大段（从大到小）');
  L.push('');
  const labels = waveLabelsFor(p.patternId);
  p.children.forEach((c, i) => {
    const lab = labels[i] || String(i + 1);
    if (c.isLeaf || !c.primary) {
      const sf = c.segFine || [];
      const f = sf.length ? sf[0].price : '?';
      const t = sf.length ? sf[sf.length - 1].price : '?';
      L.push(`- **${lab} 段**：${f} → ${t}（较小，不再细分）`);
    } else {
      const cp = c.primary;
      const s = cp.points[0];
      const e = cp.points[cp.points.length - 1];
      L.push(`- **${lab} 段** · ${dirCn(cp.direction)}：${s.price} → ${e.price}（${fmtTs(s.timestamp)} ~ ${fmtTs(e.timestamp)}），内部像一个 ${plainLabel(cp.patternId)}`);
    }
  });
  L.push('');

  L.push('## 现在走到哪了（在建结构，未确认）');
  L.push('');
  const ips = tree.inProgressStruct;
  if (ips) {
    const ext = ips.swingExtreme;
    const hasPb = !!(ips.pullback && ips.pullback.to.index !== ext.index);
    const nowPt = hasPb ? ips.pullback.to : ext;
    const moveCn = ips.structUp ? '上冲' : '下跌';
    // 两个锚点都说清（Q1）：先到摆动极值，之后回落到今天
    const pbVerb = ips.structUp ? '回落' : '反抽';
    let line = `已确认结构收在 **${b.price}**（${fmtTs(b.timestamp)}）；此后先${moveCn}到摆动极值 **${ext.price}**（${fmtTs(ext.timestamp)}）`;
    line += hasPb
      ? `，之后${pbVerb}、截至最新一根K线在 **${nowPt.price}**（${fmtTs(nowPt.timestamp)}）。`
      : `（仍在创新${ips.structUp ? '高' : '低'}，暂无明显${pbVerb}）。`;
    L.push(line);
    L.push('');
    // 上冲/下跌段的内部拆解
    if (ips.upTree && ips.upTree.primary) {
      const up = ips.upTree.primary;
      const charCn = ips.swingChar === 'driving' ? '（内部像**五浪**→偏推动/转势）'
        : ips.swingChar === 'corrective' ? '（内部像**三波**→偏反弹/调整）' : '';
      L.push(`**这条${moveCn}段（${b.price}→${ext.price}）内部最像：${plainLabel(up.patternId)}**${charCn}`);
      const upLabels = waveLabelsFor(up.patternId);
      up.children.forEach((c, i) => {
        const lab = upLabels[i] || String(i + 1);
        if (c.isLeaf || !c.primary) {
          const sf = c.segFine || [];
          const f = sf.length ? sf[0].price : '?';
          const t = sf.length ? sf[sf.length - 1].price : '?';
          L.push(`- ${lab} 段：${f} → ${t}（较小，不再细分）`);
        } else {
          const cp = c.primary;
          L.push(`- ${lab} 段 · ${dirCn(cp.direction)}：${cp.points[0].price} → ${cp.points[cp.points.length - 1].price}，内部像 ${plainLabel(cp.patternId)}`);
        }
      });
      L.push('');
    }
    // 当前回撤子腿（⏳未走完）
    if (hasPb) {
      const pb = ips.pullback;
      L.push(`**⏳ 当前子腿（还没走完）**：从 **${ext.price}** ${dirCn(pb.currentLegDir)}到 **${nowPt.price}**（今天）。`);
      L.push('');
      L.push('## 接下来可能到哪（仅供参考，不是保证）');
      L.push('');
      L.push(`当前回撤的常见斐波那契支撑/目标位：**${pb.fibTargets.map((t) => t.price.toFixed(0)).join(' / ')}**`);
    } else {
      L.push('## 接下来可能到哪（仅供参考，不是保证）');
      L.push('');
      // 无回撤（价格正创新高/低、这段还没回头）：给「若这段继续」的延伸目标——从当前摆动
      // 极值按本段自身幅度的 0.382/0.618/1.0 倍继续投影。不能再用旧的 tree.inProgress.fibTargets
      // （那是"刚在极值处、投影第一条反向小腿"的口径，价格已顺势跑远后会给出早被走穿的错误目标，
      // 如 57718 起已涨到 72427，却仍报 59647/60839/62768 这类低于现价的"目标"）。
      const contAmp = Math.abs(ext.price - ips.invalidation);
      const contSgn = ips.structUp ? 1 : -1;
      const cont = [0.382, 0.618, 1.0].map((r) => Math.round(ext.price + contSgn * contAmp * r));
      L.push(`如果这段${moveCn}继续，从 **${Math.round(ext.price)}** ${ips.structUp ? '之上' : '之下'}的常见延伸目标：**${cont.join(' / ')}**（推断）`);
    }
    if (tree.channel) {
      L.push('');
      if (tree.channel.targetSane) {
        const edges = [tree.channel.baseAt, tree.channel.railAt].filter((v) => v != null).map((v) => v.toFixed(0));
        L.push(`艾略特通道（${tree.channel.channelTypeCn}通道）边界投影：约 **${edges.join(' / ')}**（书2.5作用二，仅辅助）`);
      }
      if (tree.channel.exitHint) L.push(`通道完成提示：${tree.channel.exitHint}`);
    }
  } else if (tree.inProgress) {
    const ip = tree.inProgress;
    const d = dirCn(ip.currentLegDir);
    L.push(`当前正在走一段**还没走完**的${d}：从 **${ip.from.price}** 反向到 **${ip.to.price}**（截至最新一根K线）。`);
    L.push('');
    L.push('## 接下来可能到哪（仅供参考，不是保证）');
    L.push('');
    L.push(`如果这段${d}继续，几个常见的斐波那契目标价：**${ip.fibTargets.map((t) => t.price.toFixed(0)).join(' / ')}**`);
  } else {
    L.push('当前这套结构大致已走完最后一浪，暂无明显在建的新腿。');
  }
  if (Array.isArray(tree.fibTimeWindows) && tree.fibTimeWindows.length) {
    L.push('');
    L.push('## 可能的转折时间窗（斐波时间共振，仅辅助）');
    L.push('');
    L.push(`未来多枢轴斐波时间重合日：${tree.fibTimeWindows.map((w) => `${fmtTs(w.ts)}（${w.count}源）`).join('，')}`);
  }
  L.push('');
  return L.join('\n');
}

function renderMarkdownReport(meta, tree, userEval) {
  const lines = [];
  // 分析报告头（元信息）
  lines.push(renderReportMeta(meta));
  lines.push('');
  lines.push('---');
  lines.push('');
  // 排名数法（rank-competing-wave-counts）：大跌本身最像哪种数法，主选1+备选3，放最顶
  const ranked = tree ? renderRankedCounts(tree) : '';
  if (ranked) {
    lines.push(ranked);
    lines.push('---');
    lines.push('');
  }
  // 当前进行浪竞争结构（enumerate-current-wave-structures）：历史段那张表的"当前轴"对偶
  const curWave = tree ? renderCurrentWaveStructures(tree) : '';
  if (curWave) {
    lines.push(curWave);
    lines.push('---');
    lines.push('');
  }
  // 多级别结论（父级大结构 + 当前段内部细化）：大跌+反弹在组成什么更大结构，是另一条轴
  const multi = tree ? renderMultiDegree(tree, meta && meta.timeframe) : '';
  if (multi) {
    lines.push(multi);
    lines.push('---');
    lines.push('');
  }
  // 现状研判放最前（结论先行，Q9=a）
  if (tree && tree.assessment) {
    lines.push(renderAssessment(tree.assessment));
    lines.push('');
    lines.push('---');
    lines.push('');
  }
  // 当前高点回撤叙述（narrate-current-pullback）——进现状研判块，与主树隔离
  const pbNarr = tree && tree.inProgressStruct && tree.inProgressStruct.pullback
    && tree.inProgressStruct.pullback.narrative;
  if (pbNarr && pbNarr.text) {
    lines.push(pbNarr.text);
    lines.push('');
    lines.push('---');
    lines.push('');
  }
  // 历史计数（支撑）
  lines.push(renderNarrative(meta, tree));
  lines.push('');
  // 用户指定的数法评分（--count）
  if (userEval && Array.isArray(userEval.results) && userEval.results.length) {
    lines.push('## 你指定的数法评分');
    lines.push('');
    lines.push(renderExplicitVerdict(userEval));
    lines.push('');
  }
  lines.push('---');
  lines.push('');
  // 再附技术细节（含打分，可略过）
  lines.push('<details><summary>技术细节（含规则打分，可略过）</summary>');
  lines.push('');
  lines.push(`- 生成时间：${fmtTime(meta.generatedAtUtc)}（UTC+8）｜数据来源：${meta.source}`);
  lines.push('> 评分方法：否定法（Negation Method）。规则（Rules）是硬性闸门：全过规则的候选永远优先于有违规的候选；');
  lines.push('> 指引（Guidelines）只用于给同档候选排名，不能抵消规则的失败。RSI 等书外技术指标不参与判定。');
  lines.push('> 优雅降级：当某段没有任何一种数法能全过规则时（真实行情常见），引擎不返回空，而是退取「违规最少、越界最小」的一种，标注为存疑（penalized），仅供参考。');
  lines.push('>');
  lines.push('> 术语：`违规×N`=不满足 N 条硬规则；`越界`=违反程度；`指引x/y`=命中软性指引数；');
  lines.push('> `衰竭`=末端未达极值；`跨级别+N`=交替/浪个性等加分；`末级/不可再分`=该段太小不再拆。');
  lines.push('');
  lines.push('```');
  lines.push(renderTreeText(tree));
  lines.push('```');
  lines.push('');
  lines.push('**进行中结构（未确认）**');
  lines.push('');
  lines.push('```');
  lines.push(renderInProgressText(tree && tree.inProgressStruct));
  lines.push('```');
  lines.push('');
  lines.push('</details>');
  return lines.join('\n');
}

// ============================================================
// 8. 结构化波浪分析报告（structured-wave-report）：固定 7 节、自然语言、不替换现有报告
// ============================================================

// 强弱分档（探索 B + 6节 b）：不给概率，用 高/中/低——按 违规数 + 越界 + 未完成度客观分。
function strengthTier(score) {
  if (!score) return '低';
  const t1 = score.tier1 || 0;
  const t2 = score.tier2 || 0;
  const inc = score.incompleteness || 0;
  if (t1 === 0 && inc < 0.5) return '高';            // 规则全过且非明显在建
  if (t1 <= 1 && t2 < 0.05 && inc < 0.5) return '高'; // 仅差一丝比例
  if (t1 >= 2 || t2 >= 0.5) return '低';              // 多违规 或 大越界
  return '中';                                        // 其余：1违规 / 规则全过但在建
}

// 一条腿的时长（K线根数）
function legBars(a, b) { return Math.abs((b.index || 0) - (a.index || 0)); }

// wave-3 结构验证清单（探索 C：只做书内结构验证，不引入动量）：判"新推动3浪"前逐条查。
// 面向"低点之后的上涨"（structUp）；数据不足则标"无法验证"。
function wave3Checklist(tree) {
  const ips = tree && tree.inProgressStruct;
  if (!ips || !ips.upTree || !ips.upTree.primary || !ips.structUp) return null;
  const up = ips.upTree.primary;
  const start = ips.invalidation;            // 上涨起点（全局低，如 57718）= 候选第1浪起点
  const nowP = ips.pullback ? ips.pullback.to.price : ips.swingExtreme.price;
  const w1High = up.points[1] ? up.points[1].price : null;   // 首个上冲子腿的顶 = 候选第1浪高点
  const w2Low = up.points[2] ? up.points[2].price : null;    // 其后回撤低 = 候选第2浪低点
  // 前一轮下跌的关键结构高点：主结构里最后一个高点（如 W-X-Y 的 x 顶）
  const priorHighs = (tree.primary ? tree.primary.points : []).filter((p) => p.type === 'H');
  const priorKeyHigh = priorHighs.length ? priorHighs[priorHighs.length - 1].price : null;
  const R = Math.round;
  const chk = (item, pass, note) => ({ item, pass, note });
  return [
    chk('存在可识别的第1浪', w1High != null, w1High != null ? `首上冲腿 ${R(start)}→${R(w1High)}` : '上涨内部拆不出第1子腿'),
    chk('存在符合规则的第2浪', w2Low != null, w2Low != null ? `其后回撤到 ${R(w2Low)}` : '无明显第2浪回撤'),
    chk('第2浪未跌破第1浪起点', w2Low == null ? false : w2Low > start, w2Low != null ? `回撤低 ${R(w2Low)} vs 起点 ${R(start)}` : '—'),
    chk('当前突破第1浪高点', w1High != null && nowP > w1High, `现价 ${R(nowP)} vs 第1浪高 ${w1High != null ? R(w1High) : '?'}`),
    chk('内部形成五浪推动', ips.swingChar === 'driving', `上冲段内部实测像 ${ips.swingChar === 'driving' ? '五浪' : '三波'}`),
    chk('突破前一轮下跌关键结构高点', priorKeyHigh != null && nowP > priorKeyHigh, `现价 ${R(nowP)} vs 关键高 ${priorKeyHigh != null ? R(priorKeyHigh) : '?'}`),
  ];
}

/**
 * 结构化波浪分析报告：固定 7 节、自然语言。复用现有派生（tree/parentDegree/bounceHyp/
 * inProgressStruct/数法排名），只做组织与叙述，不臆造数字。
 */
function renderStructuredReport(meta, tree, candles, fine) {
  const R = (v) => (v == null ? '—' : Math.round(v));
  const n2 = (v) => (v == null ? '—' : Number(v).toFixed(2));
  const fmtTs = (sec) => fmtTime(sec * 1000);
  const dirCn = (d) => (d === 'up' ? '上涨' : '下跌');
  const L = [];
  L.push(`# ${meta.product} 波浪结构分析`);
  L.push('');

  // ── 1. 分析范围 ──
  L.push('## 1. 分析范围');
  L.push('');
  L.push(`- 品种：${meta.product}`);
  L.push(`- 周期：${meta.timeframe}`);
  L.push(`- 时间范围（UTC+8）：${fmtTimeSec(meta.startUtc)} ~ ${fmtTimeSec(meta.endUtc)}`);
  L.push(`- 样本数量：${meta.sampleCount} 根K线`);
  L.push(`- 区间最高/最低：${n2(meta.rangeHigh)} / ${n2(meta.rangeLow)}`);
  if (meta.lastClose != null) L.push(`- 最新收盘：${n2(meta.lastClose)}（${fmtTimeSec(meta.lastCloseTs * 1000)} UTC+8）`);
  L.push(`- 生成时间：${fmtTimeSec(meta.generatedAtUtc)}（UTC+8）`);
  L.push(`- 数据来源：${meta.source}`);
  L.push('');

  if (!tree || tree.isLeaf || !tree.primary) {
    L.push('数据不足，暂时数不出浪型。');
    return L.join('\n');
  }

  const p = tree.primary;
  const labels = waveLabelsFor(p.patternId);
  const ranked = buildRankedCounts(tree) || [];
  const pd = deriveParentDegree(tree);
  const bh = tree.assessment && tree.assessment.bounceHyp;
  const ips = tree.inProgressStruct;

  // ── 2. 关键转折点 ──
  L.push('## 2. 关键转折点');
  L.push('');
  L.push('| 序号 | 日期 | 价格 | 类型 | 暂定浪型位置 |');
  L.push('|---|---|---:|---|---|');
  const tps = p.points.slice();
  // 追加低点之后的在建关键点（摆动极值 + now），标为"其后在建"
  if (ips && ips.swingExtreme && ips.swingExtreme.index > tps[tps.length - 1].index) tps.push(ips.swingExtreme);
  tps.forEach((pt, i) => {
    let pos;
    if (i < p.points.length) {
      pos = i === 0 ? `${labels[0] || '起'} 浪起点` : `${labels[i - 1] || `第${i}`} 浪终点`;
    } else {
      pos = `${p.direction === 'down' ? '低点后' : '高点后'}在建段极值`;
    }
    L.push(`| ${i + 1} | ${fmtTs(pt.timestamp)} | ${n2(pt.price)} | ${pt.type} | ${pos} |`);
  });
  L.push('');

  // ── 3. 已完成浪型 ──
  L.push('## 3. 已完成浪型');
  L.push('');
  const dropAmp = Math.abs(p.points[0].price - p.points[p.points.length - 1].price);
  L.push(`从 **${R(p.points[0].price)}** ${dirCn(p.direction)}至 **${R(p.points[p.points.length - 1].price)}** 这一整段，主方案划分为 **${plainLabel(p.patternId)}**。`);
  L.push('');
  const legAmps = [];
  const legBarsArr = [];
  for (let i = 0; i < p.points.length - 1; i += 1) {
    legAmps.push(Math.abs(p.points[i + 1].price - p.points[i].price));
    legBarsArr.push(legBars(p.points[i], p.points[i + 1]));
  }
  p.children.forEach((c, i) => {
    const lab = labels[i] || `第${i + 1}`;
    const a = p.points[i];
    const b = p.points[i + 1];
    const inner = (c.isLeaf || !c.primary) ? '较小、不再细分' : plainLabel(c.primary.patternId);
    L.push(`- **${lab} 浪** · ${dirCn(b.price >= a.price ? 'up' : 'down')}：${R(a.price)}（${fmtTs(a.timestamp)}） → ${R(b.price)}（${fmtTs(b.timestamp)}）；内部结构：${inner}`);
  });
  L.push('');
  L.push(`- 价格比例：各腿幅度 ${legAmps.map(R).join(' : ')}`);
  L.push(`- 时间比例：各腿K线数 ${legBarsArr.join(' : ')}`);
  L.push('');
  // 选择理由 / 为何不是其它形态：从全部候选（非仅去重后的 top）里找该形态的最优代表、引用其违规
  L.push('**为何是该结构、而非其它：**');
  const allCands = [tree.primary, ...(tree.alternates || [])];
  const whyNot = (patId, patName) => {
    if (p.patternId === patId) return null; // 主方案本身就是它，不用"为何不是"
    const c = allCands.find((x) => x.patternId === patId);
    if (!c) return `- 不是${patName}：这段数不出该形态（首尾/点数不符）`;
    const vs = candidateViolations(c);
    const v = vs.length ? vs[0].desc : '评分更低';
    return `- 不是${patName}：该读法${c.score.tier1 ? `违规×${c.score.tier1}（${v}）` : '虽合规但简约度/吻合更低'}`;
  };
  [['zigzag', '单一锯齿'], ['impulse-strict', '五浪推动'], ['flat', '平台形']].forEach(([id, nm]) => {
    const s = whyNot(id, nm); if (s) L.push(s);
  });
  // 主方案自身的瑕疵：把违规规则赘述清楚（不只报"越界 0.005"这种归一化数值）
  const primViol = (ranked[0] && ranked[0].violations) ? ranked[0].violations : [];
  if (primViol.length) {
    L.push(`- 主方案自身唯一瑕疵：${primViol.map(fmtViolReason).join('；')}——是所有候选里最轻的。`);
  }
  L.push(`- 选择理由：主方案 ${plainLabel(p.patternId)} 在同台竞争里${p.score.tier1 ? `违规最少（×${p.score.tier1}）` : '规则全过'}，各腿方向、内部结构与价格关系最自洽。`);
  L.push('');

  // ── 4. 当前主方案（低点之后的在建行情）──
  L.push('## 4. 当前主方案');
  L.push('');
  if (pd && pd.primary && bh) {
    const P = pd.primary;
    const term = R(pd.dropEnd);
    const isXX = P.key === 'combination';
    const corrObj = isXX
      ? `上一子浪（${R(bh.prevPrice)}→${R(bh.term)}，幅 ${R(bh.lastSub)}）`
      : `整段完整结构（${R(bh.startPrice)}→${R(bh.term)}，幅 ${R(bh.whole)}）`;
    const tgt = isXX ? bh.xx.targets : (P.key === 'flat' ? bh.b.targets : bh.three.targets);
    const tgtStr = (tgt || []).filter((t) => t.price > 0).map((t) => R(t.price)).join(' / ');
    // 两种级别叫法（用户要求）：升一级看＝X 连接浪；同级别看＝已完成 w-x-y 的 xx 连接段，
    // 之后接 z 则整段延伸成 w-x-y-xx-z（三锯齿/三重）。
    const doneDouble = p.patternId === 'zigzag-double' || p.patternId === 'sideways-double';
    const dualNote = (isXX && doneDouble)
      ? `——两种叫法：升一级看是 **X 连接浪**；同级别看是已完成 w-x-y 的 **xx 连接段**，若之后再接 z 浪，整段就延伸成 **w-x-y-xx-z**`
      : '';
    L.push(`- 当前浪型：**${P.curLabel}**（大跌在更大结构里是 ${P.dropLabel} 浪，现在这波${dirCn(tree.assessment.currentDir)}是其后的 ${P.curLabel}）${dualNote}`);
    L.push(`- 修正对象：${corrObj}`);
    L.push(`- 计算基准：${isXX ? '上一子浪的幅度' : '整段结构的幅度'}`);
    L.push(`- 比例规则：${isXX ? '连接浪常吃该段 0.2–0.618' : (P.key === 'flat' ? 'B 浪常回撤整段 0.5/0.618/0.7' : '转势推动，上方目标作参考阻力')}`);
    L.push(`- 目标价格：**${tgtStr || '—'}**（推断，非确定）`);
    L.push(`- 确认条件：${isXX ? `内部维持三波、回撤到位后转跌（走完转 Z 浪）` : 'B 浪须涨到回撤带、之后转 C 浪下跌'}`);
    L.push(`- 失效条件：跌破 **${term}**（跌破则此数法作废、见框架B/更低目标）`);
  } else {
    L.push('- 当前无明显在建反弹，暂不研判。');
  }
  L.push('');

  // ── 5. 备选方案 ──
  L.push('## 5. 备选方案');
  L.push('');
  if (pd && bh) {
    const alts = pd.all.filter((c) => c !== pd.primary);
    alts.slice(0, 3).forEach((c) => {
      const isB = c.key === 'flat' || c.key === 'zigzag';
      const isImp = c.key === 'impulse';
      const corr = isImp ? '（转势：57718 结束整个调整、之后为新推动）'
        : (isB ? `针对整段完整结构（${R(bh.startPrice)}→${R(bh.term)}）` : `针对上一子浪（${R(bh.prevPrice)}→${R(bh.term)}）`);
      const tgt = isImp ? bh.three.targets : (isB ? bh.b.targets : bh.xx.targets);
      const tgtStr = (tgt || []).filter((t) => t.price > 0).map((t) => R(t.price)).join(' / ');
      const stat = c.rank === 'eliminated' ? `已淘汰（${c.elimReason}）` : '保留';
      L.push(`- **${c.parentCn}**（${stat}）：修正对象＝${corr}；目标 ${tgtStr || '—'}。`);
    });
  }
  L.push('');

  // ── 6. 方案排序（高/中/低，不给概率）──
  L.push('## 6. 方案排序');
  L.push('');
  L.push('| 方案 | 强弱 | 支持依据 | 不利因素 | 确认条件 |');
  L.push('|---|---|---|---|---|');
  if (pd) {
    pd.all.forEach((c) => {
      const tier = c.rank === 'primary' ? '高' : (c.rank === 'eliminated' ? '低' : '中');
      const support = c.basis || '—';
      const against = c.rank === 'eliminated' ? c.elimReason : '尚未确认、需继续验证';
      let confirm = '—';
      if (c.key === 'combination') confirm = '回撤到位后转跌、跌破 57718 走 Z';
      else if (c.key === 'flat') confirm = '涨到整段 0.5–0.7 回撤带后转 C';
      else if (c.key === 'impulse') confirm = '内部走出完整五浪并突破关键前高（见 wave-3 验证）';
      else if (c.key === 'zigzag') confirm = '（需 A 浪为五浪推动，当前不满足）';
      L.push(`| ${c.parentCn}（大跌=${c.dropLabel}） | ${tier} | ${support} | ${against} | ${confirm} |`);
    });
  }
  L.push('');
  // wave-3 验证清单（判"新推动3浪"前的书内结构验证，去动能）
  const w3 = wave3Checklist(tree);
  if (w3) {
    L.push('**"新推动 3 浪"方案的结构验证（书内、不含动量；不得因涨幅大直接判 3 浪）：**');
    w3.forEach((c) => L.push(`- ${c.pass ? '✅' : '❌'} ${c.item}（${c.note}）`));
    const passN = w3.filter((c) => c.pass).length;
    L.push('');
    L.push(`→ ${passN}/${w3.length} 项通过。${passN < w3.length ? '关键项未过，暂不提升"新推动 3 浪"档位。' : '全过，可提升该方案档位。'}`);
    L.push('');
  }

  // ── 7. 最终分析话术 ──
  L.push('## 7. 最终分析话术');
  L.push('');
  const s = [];
  s.push(`从 **${R(p.points[0].price)}** ${dirCn(p.direction)}至 **${R(p.points[p.points.length - 1].price)}** 的行情，目前优先看作一组 **${plainLabel(p.patternId)}**。`);
  if (p.points.length >= 4) {
    const seg = [];
    p.children.forEach((c, i) => {
      const lab = labels[i] || `第${i + 1}`;
      const a = p.points[i]; const b = p.points[i + 1];
      seg.push(`${lab} 浪从 ${R(a.price)} ${dirCn(b.price >= a.price ? 'up' : 'down')}至 ${R(b.price)}`);
    });
    s.push(`其中，${seg.join('；')}。`);
  }
  if (pd && pd.primary && bh) {
    const P = pd.primary;
    const isXX = P.key === 'combination';
    const tgt = isXX ? bh.xx.targets : (P.key === 'flat' ? bh.b.targets : bh.three.targets);
    const tp = (tgt || []).filter((t) => t.price > 0).map((t) => R(t.price));
    const tgtStr = tp.length ? `${tp[0]}–${tp[tp.length - 1]}` : '—';
    const doneDouble2 = p.patternId === 'zigzag-double' || p.patternId === 'sideways-double';
    s.push(`从 **${R(pd.dropEnd)}** 开始的${dirCn(tree.assessment.currentDir)}，当前优先考虑 **${P.curLabel}**${isXX && doneDouble2 ? '（同级别看即已完成 w-x-y 的 xx 连接段，之后接 z 则延伸成 w-x-y-xx-z）' : ''}，同时保留更大级别 B 浪与新推动浪两种可能。`);
    if (isXX) s.push(`如果属于 XX 连接浪，它主要针对前面的上一子浪（${R(bh.prevPrice)}→${R(bh.term)}）修正，按书中回撤规则，目标区间约 **${tgtStr}**；走完之后转 Z 浪下跌（即整段成 w-x-y-xx-z）。`);
    s.push(`如果属于更大级别 B 浪，则针对整段（${R(bh.startPrice)}→${R(bh.term)}）修正，0.7 回撤位约 **${R((bh.b.targets.find((t) => t.ratio === 0.7) || {}).price)}**。`);
    s.push(`更强势的备选是 ${R(pd.dropEnd)} 已结束整个调整、之后为新一轮推动浪；但只有当上涨内部走出完整五浪、并突破关键前高后，才能提高"第 3 浪"方案的概率。`);
  }
  L.push(s.join(''));
  L.push('');
  L.push('> 以上为概率性研判、非确定，不构成买卖建议；所有数字由本次 K 线自动计算。');
  return L.join('\n');
}

async function main() {
  const args = manual.parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage:\n  node analyze-wave-tree.js --product BTC-USD --tf 1d --start 2025-10-05T00:00:00+08:00 --end now\n\n以《波浪理论详解》为准绳，递归拆解产出「最大级别 → 当前浪」计数树。');
    return;
  }
  const tf = TIMEFRAMES[args.tf];
  if (!tf) throw new Error(`Unsupported timeframe: ${args.tf}. Use: ${Object.keys(TIMEFRAMES).join(', ')}`);

  const end = args.end && String(args.end).toLowerCase() !== 'now' ? new Date(args.end) : new Date();
  const start = args.start ? new Date(args.start) : new Date(end.getTime() - 30 * 24 * 3600 * 1000);

  const base = await fetchCandles(args.product, tf.fetchGranularity, start, end);
  const startTs = Math.floor(start.getTime() / 1000);
  const endTs = Math.floor(end.getTime() / 1000);
  const candles = transformCandles(base, tf)
    .filter((c) => c.timestamp >= startTs && c.timestamp <= endTs)
    .map((c, i) => ({ ...c, index: i }));

  let fine = detectPivots(candles, 1, {});
  fine = anchorBoundaryExtremes(candles, fine);
  // beamK:4 → 顶层排名表可给「主选1+备选3」（rank-competing-wave-counts Q3）
  const tree = buildCountTree(fine, candles, { maxDepth: 5, beamK: 4 });

  // 当前高点回撤叙述（narrate-current-pullback）：拆不出时下钻子级别补结构；叙述为可选增量，失败不阻断
  try {
    await enrichCurrentPullback(tree, { product: args.product, mainTf: args.tf, finePivots: fine, candles });
  } catch (e) {
    // 叙述属增量输出，取数/拆解失败时不影响主报告
  }

  // --count "126296,80524,97963,57717"：把用户指定的数法喂进去逐条打分，并入报告
  let userEval = null;
  const argv = process.argv.slice(2);
  const ci = argv.indexOf('--count');
  if (ci >= 0 && argv[ci + 1]) {
    const prices = argv[ci + 1].split(',').map(Number).filter((x) => Number.isFinite(x));
    const pts = pointsFromPrices(prices, candles);
    if (pts) userEval = evaluateExplicitCount(pts, fine, candles);
  }

  const last = candles.length ? candles[candles.length - 1] : null;
  const meta = {
    product: args.product, timeframe: args.tf,
    startUtc: start.toISOString(), endUtc: end.toISOString(),
    generatedAtUtc: new Date().toISOString(),
    source: 'Coinbase Exchange candles API', sampleCount: candles.length,
    rangeHigh: candles.length ? Math.max(...candles.map((c) => c.high)) : null,
    rangeLow: candles.length ? Math.min(...candles.map((c) => c.low)) : null,
    lastClose: last ? last.close : null,
    lastCloseTs: last ? last.timestamp : null,
  };

  const safeProduct = args.product.replace(/[^A-Za-z0-9-]/g, '_');
  const stamp = `${stampCompact(start)}_${stampCompact(end)}`;
  const outName = args.out || `${safeProduct}_${args.tf}_${stamp}_tree.json`;
  const reportName = args.report || `${safeProduct}_${args.tf}_${stamp}_tree.md`;
  await fs.writeFile(outName, JSON.stringify({
    meta,
    tree: serializeTree(tree),
    inProgressTree: serializeInProgress(tree.inProgressStruct),
    rankedCounts: serializeRankedCounts(tree),
    currentWaveStructures: serializeCurrentWaveStructures(tree),
    parentDegree: serializeMultiDegree(tree, args.tf),
  }, null, 2), 'utf8');
  await fs.writeFile(reportName, renderMarkdownReport(meta, tree, userEval), 'utf8');
  // 新增：结构化 7 节报告（structured-wave-report，A=a 新增输出、不替换现有报告）
  const structuredName = args.structured || `${safeProduct}_${args.tf}_${stamp}_structured.md`;
  await fs.writeFile(structuredName, renderStructuredReport(meta, tree, candles, fine), 'utf8');
}

if (require.main === module) {
  main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
}

// ============================================================
// 导出（M1 + M2 + M3 + M4）
// ============================================================

module.exports = {
  // 复用管道（透传，便于测试/后续引擎）
  fetchCandles,
  transformCandles,
  computeATR,
  detectPivots,
  anchorBoundaryExtremes,
  computeMeasures,
  rangeExtreme,
  TIMEFRAMES,
  // 本地工具
  safeRatio,
  absLen,
  // 判据契约
  normRange,
  normGate,
  makeJudge,
  safeTest,
  // 拟合分
  scoreCandidate,
  compareCandidates,
  selectBest,
  // 手册
  buildImpulseStrictManual,
  buildDiagonalManual,
  buildZigzagManual,
  buildFlatManual,
  buildRegularFlatManual,
  buildExpandedFlatManual,
  buildRunningFlatManual,
  buildDoubleSidewaysManual,
  buildTripleSidewaysManual,
  buildContractingTriangleManual,
  buildDoubleZigzagManual,
  buildTripleZigzagManual,
  // M2 引擎
  PATTERNS,
  MIN_POINTS,
  seqOf,
  macroAlternates,
  legEndpointsSpanExtreme,
  candidateViolations,
  coarsenByPairs,
  segmentations,
  sliceFine,
  triangleGross,
  legCharacter,
  grammarViolatesRole,
  crossDegreeHits,
  volumeNote,
  decompose,
  computeLegExpectation,
  computeExpectation,
  channelProjection,
  fibTimeWindows,
  annotateInProgress,
  directionalTopSpan,
  directionalSpanToNow,
  buildCountTree,
  // rank-competing-wave-counts：搜索补全 / 在建打分 / 腿间比例闸门 / 排名输出
  significanceRank,
  significantShortlist,
  indexCombinations,
  computeIncompleteness,
  legProportionViolated,
  buildCounterTrendFrameworkB,
  buildRankedCounts,
  renderRankedCounts,
  serializeRankedCounts,
  buildCurrentWaveStructures,
  serializeCurrentWaveStructures,
  renderCurrentWaveStructures,
  situationAssessment,
  renderAssessment,
  // narrate-current-pullback
  tfStepDown,
  loadCandlesAndPivots,
  drillPullback,
  splitPullbackAtLow,
  historicalPullbackDepths,
  classifyPullbackLevel,
  analyzePullbackCompleted,
  readCombination,
  zwaveProjection,
  enrichCurrentPullback,
  renderPullbackNarrative,
  bounceHypotheses,
  nearTermTrigger,
  renderBounceHypotheses,
  renderTreeText,
  evaluateExplicitCount,
  pointsFromPrices,
  renderExplicitVerdict,
  serializeTree,
  plainLabel,
  renderNarrative,
  renderMarkdownReport,
  renderStructuredReport,
  strengthTier,
  wave3Checklist,
  main,
};
