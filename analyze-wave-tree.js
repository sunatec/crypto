'use strict';

/**
 * 波浪计数引擎（递归拆解 + 最佳拟合）—— 独立并行模块。
 *
 * 设计依据：openspec/changes/rebuild-wave-tree-best-fit-engine/（grilling 定稿 Q1–Q18）。
 * 定位：以《波浪理论详解》全部可计算知识为准绳的「最佳拟合浪型识别器」，产出一条
 * 「最大级别 → 当前所处浪型」的计数树（主链 + 每层备选 + 进行中预期）。
 *
 * 对旧文件 analyze-wave-manual.js 采「采石场，非依赖」策略：
 *   - 管道（取数/枢轴/度量/通道/斐波，理论中立）直接 require 复用；
 *   - 形态规则的「内容」搬进本文件的新判据层（test 返回 {pass, overshoot}）；
 *   - legShape 家族与滑窗/固定三档（scan 系列、DEGREE_CONFIGS）不搬，被递归取代。
 *
 * 本文件当前进度：M1（判据契约 + 分层字典序拟合分 + 优雅降级 + 标准推动浪样板）。
 * 递归引擎（M2）、级别涌现与进行中/投影层（M3）、输出与测试（M4）后续增量落地。
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
 * 分层字典序比较：tier1↑, tier2↑, complexity↑, tier3↑, tier4↓。
 * complexity（简约原则）插在硬规则拟合之后、软指引之前：书里明确「多重调整（双/三）
 * 是最后手段」，故同等规则拟合下，越简单的形态越优——防止规则稀少的联合形/多锯齿
 * 靠"没什么可违反"白捡第一。
 */
function compareCandidates(a, b) {
  const sa = a.severe || 0;
  const sb = b.severe || 0;
  if (sa !== sb) return sa - sb; // 严重违规最少者优先（致命伤盖过条数差）
  if (a.tier1 !== b.tier1) return a.tier1 - b.tier1;
  if (a.tier2 !== b.tier2) return a.tier2 - b.tier2;
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
// 5. 切分（Q8）：把一段细枢轴按目标点数 n 逐级并小摆动坍缩
// ============================================================
//
// 交替序列（首尾类型固定）长度与 n 同奇偶；每次删掉一对「最小振幅的内部相邻枢轴」，
// 保持首尾与交替不变、长度 −2，直到等于 n。返回该切分（不足/奇偶不符则 null）。

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

function segmentations(segFine, n) {
  if (segFine.length === n) return [segFine.slice()];
  const coarse = coarsenByPairs(segFine, n);
  return coarse ? [coarse] : [];
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
  return { character, drivingNode: asDrv, correctiveNode: asCorr };
}

function decompose(segFine, candles, allowedRoles, depth, opts) {
  if (!Array.isArray(segFine) || segFine.length < 2) return leafNode(segFine, allowedRoles[0]);

  const start = segFine[0];
  const end = segFine[segFine.length - 1];
  const direction = end.price >= start.price ? 'up' : 'down';

  // 终止（Q7）：点数不足以成形任一允许形态 → 叶子
  const minPts = Math.min(...allowedRoles.map((r) => rolePoints(r)));
  if (depth >= opts.maxDepth || segFine.length < minPts) {
    return leafNode(segFine, allowedRoles[0]);
  }

  const candidates = [];
  for (const pat of PATTERNS) {
    if (!allowedRoles.some((r) => patternMatchesRole(pat, r))) continue;
    const seq = seqOf(direction, pat.points);
    if (start.type !== seq[0] || end.type !== seq[seq.length - 1]) continue;
    if (segFine.length < pat.points) continue;

    for (const pts of segmentations(segFine, pat.points)) {
      if (!pts.every((p, i) => p.type === seq[i])) continue;

      const measures = computeMeasures(pts, direction, candles);
      // 书 3.16 特例：三角形的运行总量按「最长子浪高低差」口径纠正
      if (pat.id === 'triangle') {
        const tg = triangleGross(pts, candles);
        if (tg != null) measures.gross = tg;
      }
      const ctx = { points: pts, direction, candles, measures };
      const score = scoreCandidate(ctx, pat.build(direction));

      // 文法：逐腿递归拆解（childRoles 可为类别 driving/corrective 或具体形态 id 如 'zigzag'）
      const children = [];
      let grammarViolations = 0;
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
          // 文法违规：这条腿的真实性格与所需性格相反（如 a浪须驱动、实测更像三波调整；
          // 或 W浪须调整、实测更像五浪推动）。性格判不出（太短）则不计违规。
          if (lc.character && lc.character !== requiredChar) grammarViolations += 1;
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
      candidate.score = { ...score, tier1: totalTier1, grammarViolations, tier4, complexity: patternComplexity(pat.id), penalized: totalTier1 > 0 };
      candidate.truncated = Number.isFinite(measures.price) && Number.isFinite(measures.gross)
        && measures.price < measures.gross - 1e-6;
      candidate.volumeNote = volumeNote(candidate, candles);
      candidates.push(candidate);
    }
  }

  if (candidates.length === 0) return leafNode(segFine, allowedRoles[0]);

  const ranked = candidates.slice().sort((a, b) => compareCandidates(a.score, b.score));
  return {
    isLeaf: false,
    segFine,
    primary: ranked[0],
    alternates: ranked.slice(1, opts.beamK),
  };
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
 * 引擎入口：对整段细枢轴（应已含边界锚定）做顶层全形态竞争（driving + corrective）。
 */
function buildCountTree(finePivots, candles, options = {}) {
  const opts = { beamK: options.beamK || 3, maxDepth: options.maxDepth || 6, variants: options.variants || 1 };
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
    tree.inProgress = {
      from: spanLast,
      to: globalLast,
      ...computeLegExpectation(spanLast, globalLast, refAmp),
    };
  }
  tree.assessment = situationAssessment(tree, candles, finePivots);
  return tree;
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

function situationAssessment(tree, candles, finePivots) {
  if (!tree || tree.isLeaf || !tree.primary) return null;
  const p = tree.primary;
  const topStart = p.points[0];
  const topEnd = p.points[p.points.length - 1];
  const isMotive = p.klass === DRIVING;
  const structDir = p.direction;
  const bigTrend = isMotive ? structDir : (structDir === 'up' ? 'down' : 'up');

  const ip = tree.inProgress;
  let currentDir = null;
  let roleChar = null;
  if (ip) {
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
  };
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

  // ③ —— 当前反弹的三身份，叙述化（作者口吻）
  L.push('## ③ 目标在哪（当前反弹的三种身份）');
  L.push('');
  if (a.bounceHyp) {
    L.push(renderBounceHypotheses(a.bounceHyp, a.nearTerm));
  } else {
    L.push('当前没有明显在建的反弹，暂不研判身份。');
  }
  if (a.channel && a.channel.baseAt != null) {
    L.push('');
    L.push(`另外，艾略特通道的下边界大约在 **${n(a.channel.baseAt)}**，可作一条参考支撑。`);
  }
  L.push('');

  // ④ —— 时间窗
  if (a.fibTimeWindows && a.fibTimeWindows.length) {
    L.push('## ④ 什么时候可能转（斐波时间窗，仅辅助）');
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

    // 文法：逐腿判定「五浪(驱动) vs 三波(调整)」性格，与所需性格相反才算违规（与 decompose 一致）
    let grammarViolations = 0;
    const legNotes = [];
    for (let i = 0; i < pat.childRoles.length; i += 1) {
      const role = pat.childRoles[i];
      const childFine = sliceFine(finePivots, macroPoints[i], macroPoints[i + 1]);
      if (childFine.length >= rolePoints(role)) {
        const requiredChar = role === DRIVING ? 'driving' : 'corrective';
        const lc = legCharacter(childFine, candles, 1, opts);
        if (lc.character && lc.character !== requiredChar) {
          grammarViolations += 1;
          const cn = (c) => (c === 'driving' ? '驱动浪(五浪)' : '调整浪(三波)');
          legNotes.push(`第${i + 1}腿（须为${cn(requiredChar)}）实测更像${cn(lc.character)}`);
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
    alternates: node.alternates.map((a) => ({
      patternId: a.patternId, label: a.manual.label, direction: a.direction,
      fitScore: { tier1: a.score.tier1, tier2: a.score.tier2, tier3: a.score.tier3, tier4: a.score.tier4 },
    })),
  };
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
  L.push(`- 品种：${meta.product}　周期：${meta.timeframe}`);
  L.push(`- 区间：${fmtTime(meta.startUtc)} ~ ${fmtTime(meta.endUtc)}（共 ${meta.sampleCount} 根K线）`);
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
      L.push(`- **${lab} 段**：${c.from} → ${c.to}（较小，不再细分）`);
    } else {
      const cp = c.primary;
      const s = cp.points[0];
      const e = cp.points[cp.points.length - 1];
      L.push(`- **${lab} 段** · ${dirCn(cp.direction)}：${s.price} → ${e.price}（${fmtTs(s.timestamp)} ~ ${fmtTs(e.timestamp)}），内部像一个 ${plainLabel(cp.patternId)}`);
    }
  });
  L.push('');

  L.push('## 现在走到哪了');
  L.push('');
  if (tree.inProgress) {
    const ip = tree.inProgress;
    const d = dirCn(ip.currentLegDir);
    L.push(`当前正在走一段**还没走完**的${d}：从 **${ip.from.price}** 反向到 **${ip.to.price}**（截至最新一根K线）。`);
    L.push('');
    L.push('## 接下来可能到哪（仅供参考，不是保证）');
    L.push('');
    L.push(`如果这段${d}继续，几个常见的斐波那契目标价：**${ip.fibTargets.map((t) => t.price.toFixed(0)).join(' / ')}**`);
    if (tree.channel) {
      L.push('');
      if (tree.channel.targetSane) {
        const edges = [tree.channel.baseAt, tree.channel.railAt].filter((v) => v != null).map((v) => v.toFixed(0));
        L.push(`艾略特通道（${tree.channel.channelTypeCn}通道）边界投影：约 **${edges.join(' / ')}**（书2.5作用二，仅辅助）`);
      }
      if (tree.channel.exitHint) L.push(`通道完成提示：${tree.channel.exitHint}`);
    }
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
  // 现状研判放最前（结论先行，Q9=a）
  if (tree && tree.assessment) {
    lines.push(renderAssessment(tree.assessment));
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
  lines.push('> 术语：`违规×N`=不满足 N 条硬规则；`越界`=违反程度；`指引x/y`=命中软性指引数；');
  lines.push('> `衰竭`=末端未达极值；`跨级别+N`=交替/浪个性等加分；`末级/不可再分`=该段太小不再拆。');
  lines.push('');
  lines.push('```');
  lines.push(renderTreeText(tree));
  lines.push('```');
  lines.push('');
  lines.push('</details>');
  return lines.join('\n');
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
  const tree = buildCountTree(fine, candles, { maxDepth: 5, beamK: 3 });

  // --count "126296,80524,97963,57717"：把用户指定的数法喂进去逐条打分，并入报告
  let userEval = null;
  const argv = process.argv.slice(2);
  const ci = argv.indexOf('--count');
  if (ci >= 0 && argv[ci + 1]) {
    const prices = argv[ci + 1].split(',').map(Number).filter((x) => Number.isFinite(x));
    const pts = pointsFromPrices(prices, candles);
    if (pts) userEval = evaluateExplicitCount(pts, fine, candles);
  }

  const meta = {
    product: args.product, timeframe: args.tf,
    startUtc: start.toISOString(), endUtc: end.toISOString(),
    generatedAtUtc: new Date().toISOString(),
    source: 'Coinbase Exchange candles API', sampleCount: candles.length,
  };

  const safeProduct = args.product.replace(/[^A-Za-z0-9-]/g, '_');
  const outName = args.out || `${safeProduct}_${args.tf}_tree.json`;
  const reportName = args.report || `${safeProduct}_${args.tf}_tree.md`;
  await fs.writeFile(outName, JSON.stringify({ meta, tree: serializeTree(tree) }, null, 2), 'utf8');
  await fs.writeFile(reportName, renderMarkdownReport(meta, tree, userEval), 'utf8');

  console.log(renderTreeText(tree));
  console.log(`\nSaved JSON: ${outName}\nSaved report: ${reportName}`);
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
  coarsenByPairs,
  segmentations,
  sliceFine,
  triangleGross,
  legCharacter,
  crossDegreeHits,
  volumeNote,
  decompose,
  computeLegExpectation,
  computeExpectation,
  channelProjection,
  fibTimeWindows,
  annotateInProgress,
  directionalTopSpan,
  buildCountTree,
  situationAssessment,
  renderAssessment,
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
  main,
};
