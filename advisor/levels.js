'use strict';

const { reversalCandle } = require('./indicators');
const { fmtPrice } = require('./format');

// 候选价位 → 共振区 → 计划卡。全部从事实 JSON（facts）出发，不再回头读 K 线，保证报告里每个价格都能追溯到事实层。

// 中文周期名直接连写（日线MA90），4H 与后文空一格（4H MA30）
const tag = (name) => (/^\w/.test(name) ? `${name} ` : name);
const dateOf = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);

function collectCandidates(facts, params) {
  const out = [];
  const push = (price, label, tf, kind) => {
    if (Number.isFinite(price) && price > 0) out.push({ price, label, tf, kind });
  };
  const addMAs = (tf, name, periods) => {
    for (const p of periods) if (tf && tf.ma && tf.ma[p]) push(tf.ma[p].value, `${tag(name)}MA${p}`, name, 'ma');
  };
  addMAs(facts.daily, '日线', [30, 90, 120, 256]);
  addMAs(facts.h4, '4H', [30, 90, 120]);
  addMAs(facts.weekly, '周线', [30]);

  for (const [tf, name] of [[facts.daily, '日线'], [facts.h4, '4H']]) {
    const pivots = (tf && tf.structure && tf.structure.pivots) || [];
    for (const type of ['H', 'L']) {
      for (const p of pivots.filter((x) => x.type === type).slice(-3)) {
        push(p.price, `${tag(name)}${type === 'H' ? '高点' : '低点'}${dateOf(p.ts)}`, name, 'pivot');
      }
    }
  }

  // 斐波：日线最近一对相邻确认高低点（主要波段）
  const swing = facts.daily && facts.daily.structure && facts.daily.structure.lastSwing;
  if (swing && swing.from && swing.to) {
    const a = swing.from.price;
    const b = swing.to.price;
    const high = Math.max(a, b);
    const low = Math.min(a, b);
    for (const r of params.fibLevels) {
      // 上升波段回撤从高点往下量；下降波段反抽从低点往上量
      const price = swing.toType === 'H' ? high - r * (high - low) : low + r * (high - low);
      push(price, `斐波${r}（日线波段 ${dateOf(swing.from.ts)}→${dateOf(swing.to.ts)}）`, '日线', 'fib');
    }
  }
  return out;
}

// 价格排序后，相邻差 ≤ mergeAtr×ATR 归为同一区；来源按 label 去重。
function mergeZones(cands, atr, mergeAtr, maxSpanAtr = Infinity) {
  const sorted = [...cands].sort((x, y) => x.price - y.price);
  const gap = mergeAtr * atr;
  const maxSpan = maxSpanAtr * atr;
  const groups = [];
  for (const c of sorted) {
    const g = groups[groups.length - 1];
    if (g && c.price - g[g.length - 1].price <= gap && c.price - g[0].price <= maxSpan) g.push(c);
    else groups.push([c]);
  }
  return groups.map((g) => {
    const seen = new Map();
    for (const c of g) if (!seen.has(c.label)) seen.set(c.label, { label: c.label, price: c.price });
    const low = g[0].price;
    const high = g[g.length - 1].price;
    return { low, high, mid: (low + high) / 2, count: seen.size, sources: [...seen.values()] };
  });
}

// 现价上下方各取 zonesPerSide 个：来源数降序，同数按距现价近者优先；输出按离现价由近到远。
function selectZones(zones, price, params) {
  const sideOf = (z) => (z.high < price ? 'support' : (z.low > price ? 'resistance' : (z.mid <= price ? 'support' : 'resistance')));
  const rank = (a, b) => (b.count - a.count) || (Math.abs(a.mid - price) - Math.abs(b.mid - price));
  const pick = (side) => zones.filter((z) => sideOf(z) === side).sort(rank).slice(0, params.zonesPerSide)
    .sort((a, b) => Math.abs(a.mid - price) - Math.abs(b.mid - price))
    .map((z) => ({ ...z, side, distancePct: (z.mid - price) / price }));
  return { support: pick('support'), resistance: pick('resistance') };
}

function nearestPivot(facts, side, bound) {
  // side='below'：低点且价格 < bound，取最高者；side='above'：高点且价格 > bound，取最低者
  let best = null;
  for (const [tf, name] of [[facts.daily, '日线'], [facts.h4, '4H']]) {
    for (const p of ((tf && tf.structure && tf.structure.pivots) || [])) {
      if (side === 'below' && p.type === 'L' && p.price < bound && (!best || p.price > best.price)) best = { ...p, tf: name };
      if (side === 'above' && p.type === 'H' && p.price > bound && (!best || p.price < best.price)) best = { ...p, tf: name };
    }
  }
  return best;
}

// 失效价：区外侧最近确认低点（空头为高点）∓ buffer×ATR；没有则区边 ∓ buffer×ATR。
function invalidationFor(direction, zone, facts, params) {
  const atr = facts.daily.atr;
  if (atr == null) return null;
  const buf = params.invalidationBufferAtr * atr;
  if (direction === 'long') {
    const p = nearestPivot(facts, 'below', zone.low);
    if (p) return { price: p.price - buf, basis: `${p.tf}低点 ${dateOf(p.ts)}（${fmtPrice(p.price)}）− ${params.invalidationBufferAtr}×ATR`, pivotPrice: p.price };
    return { price: zone.low - buf, basis: `区下沿 − ${params.invalidationBufferAtr}×ATR`, pivotPrice: null };
  }
  const p = nearestPivot(facts, 'above', zone.high);
  if (p) return { price: p.price + buf, basis: `${p.tf}高点 ${dateOf(p.ts)}（${fmtPrice(p.price)}）+ ${params.invalidationBufferAtr}×ATR`, pivotPrice: p.price };
  return { price: zone.high + buf, basis: `区上沿 + ${params.invalidationBufferAtr}×ATR`, pivotPrice: null };
}

const maVal = (tf, p) => (tf && tf.ma && tf.ma[p] ? tf.ma[p].value : null);
const gt = (a, b) => (a == null || b == null ? null : a > b);
const lt = (a, b) => (a == null || b == null ? null : a < b);
const and = (...xs) => (xs.some((x) => x === false) ? false : (xs.some((x) => x == null) ? null : true));

// 手册 §11.2 右侧触发三选一（不是同时必须），逐条给出当前是否满足。
function rightSideTriggers(direction, zone, facts, params) {
  const d = facts.daily || {};
  const h = facts.h4 || {};
  const long = direction === 'long';
  const hMA30 = maVal(h, 30);
  const hs = (h && h.structure) || {};
  const gb = (d && d.glueBreakout) || null;
  const ma90 = maVal(d, 90);
  const ma120 = maVal(d, 120);

  const t1 = long
    ? and(gt(h.close, hMA30), hs.lastHigh ? gt(h.close, hs.lastHigh.price) : null, hs.pattern == null ? null : hs.pattern === 'HH/HL')
    : and(lt(h.close, hMA30), hs.lastLow ? lt(h.close, hs.lastLow.price) : null, hs.pattern == null ? null : hs.pattern === 'LH/LL');
  const band = ma90 != null && ma120 != null ? (long ? Math.max(ma90, ma120) : Math.min(ma90, ma120)) : null;
  const confirmK = d && d.lastBars ? reversalCandle(d.lastBars, long ? 'long' : 'short', long ? zone.low : zone.high, params) : { met: null };
  const t2 = and(long ? gt(d.close, band) : lt(d.close, band), d && d.lastBars ? confirmK.met : null, long ? gt(h.close, hMA30) : lt(h.close, hMA30));
  const t3 = gb ? Boolean(gb.dir === (long ? 'up' : 'down') && gb.retest) : null;

  return [
    { id: 'R1', met: t1, text: long ? '4H 收盘站回 MA30，最近 LH 被突破，回踩形成 HL' : '4H 收盘跌回 MA30 下，最近 HL 被跌破，反抽形成 LH' },
    { id: 'R2', met: t2, text: long ? '日线收回 MA90/120 支撑带并形成止跌确认 K，4H 跟随' : '日线跌回 MA90/120 压力带下并形成止涨确认 K，4H 跟随' },
    { id: 'R3', met: t3, text: long ? '均线粘合向上突破后首次成功回踩，关键结构保持有效' : '均线粘合向下跌破后首次反抽失败，关键结构保持有效' },
  ];
}

function modeFor(family, side) {
  if (family === 'long') return side === 'support' ? { kind: 'plan', direction: 'long', tag: '完整计划（顺大级别方向）' } : { kind: 'watch', direction: null, tag: '观察位（逆大级别方向，仅作止盈参考）' };
  if (family === 'short') return side === 'resistance' ? { kind: 'plan', direction: 'short', tag: '完整计划（顺大级别方向）' } : { kind: 'watch', direction: null, tag: '观察位，不建议参与' };
  if (family === 'range') return { kind: 'plan', direction: side === 'support' ? 'long' : 'short', tag: '区间边缘·轻仓' };
  return { kind: 'watch', direction: null, tag: side === 'support' ? '观察位，不建议参与（多头结构已破坏，不出多头计划）' : '观察位（反抽压力，空头计划需另行确认）' };
}

function buildCard(zone, mode, selected, price, facts, params) {
  const card = {
    id: `${zone.side}-${Math.round(zone.mid * 100)}`,
    side: zone.side, kind: mode.kind, direction: mode.direction, tag: mode.tag,
    zone: { low: zone.low, high: zone.high, mid: zone.mid, count: zone.count, sources: zone.sources },
    distancePct: zone.distancePct,
  };
  if (mode.kind !== 'plan') return card;

  const entry = { low: zone.low, high: zone.high, mid: zone.mid };
  const inv = invalidationFor(mode.direction, zone, facts, params);
  const targets = mode.direction === 'long'
    ? selected.resistance.filter((z) => z.low > Math.max(price, zone.mid)).sort((a, b) => a.low - b.low).map((z) => z.low)
    : selected.support.filter((z) => z.high < Math.min(price, zone.mid)).sort((a, b) => b.high - a.high).map((z) => z.high);
  const tp1 = targets[0] == null ? null : targets[0];
  const tp2 = targets[1] == null ? null : targets[1];
  let rr = null;
  if (inv && tp1 != null) {
    const risk = mode.direction === 'long' ? entry.mid - inv.price : inv.price - entry.mid;
    const reward = mode.direction === 'long' ? tp1 - entry.mid : entry.mid - tp1;
    rr = risk > 0 ? reward / risk : null;
  }
  const notes = [];
  if (!inv) notes.push('日线 ATR 数据不足，失效价待查');
  if (tp1 == null) notes.push('现价另一侧没有可用的共振区作 TP，盈亏比待查');
  const triggers = rightSideTriggers(mode.direction, zone, facts, params);
  return {
    ...card, entry, triggers,
    triggerMet: triggers.some((t) => t.met === true),
    invalidation: inv, tp1, tp2, rr,
    rrFlag: rr != null && rr < params.minRR ? '性价比不足' : null,
    notes: [...notes, '条件性计划，需右侧确认后再执行；仓位按风险预算反推（手册 §14）'],
  };
}

// facts：{ weekly, daily, h4 }（各含 ma/structure…）；state：classifyState 结果。
function buildLevels(facts, state, params) {
  const dataGaps = [];
  const price = facts.daily.close;
  const atr = facts.daily.atr;
  if (atr == null || price == null) {
    dataGaps.push('日线 ATR 数据不足，无法合并共振区，点位模式不输出计划');
    return { price, zones: { support: [], resistance: [] }, plans: [], dataGaps };
  }
  const merged = mergeZones(collectCandidates(facts, params), atr, params.mergeAtr, params.maxZoneSpanAtr);
  const zones = selectZones(merged, price, params);
  const plans = [];
  for (const side of ['support', 'resistance']) {
    for (const zone of zones[side]) plans.push(buildCard(zone, modeFor(state.family, side), zones, price, facts, params));
  }
  return { price, zones, plans, dataGaps };
}

module.exports = { collectCandidates, mergeZones, selectZones, invalidationFor, rightSideTriggers, buildLevels, modeFor };
