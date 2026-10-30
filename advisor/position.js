'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const { fmtPrice, fmtPct, fmtPctPlain, PENDING } = require('./format');
const { invalidationFor, rightSideTriggers } = require('./levels');

const EPS = 1e-12;
const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// ---- 手册 §14.1/§14.2/§14.3：U 本位线性合约风控 ----
// side=long: Q>0；side=short: Q<0。亏损一律取正数。任何缺失输入对应的字段输出"待查"，不估算。
function computeRisk({ side, cost, qty, equity, P, S, riskPct, liq, margin }, params) {
  const sign = side === 'long' ? 1 : -1;
  if (qty == null || equity == null || P == null) {
    return {
      available: false, notional: PENDING, leverage: PENDING, riskBudget: PENDING, riskAmount: PENDING,
      deltaLoss: PENDING, tradeLoss: PENDING, tradeLossPctEquity: PENDING, qMax: PENDING, stress: [], liquidation: { checked: false, note: PENDING }, reduction: [],
    };
  }
  const notional = qty * P;
  const leverage = notional / equity;
  const riskBudget = equity * riskPct;
  const stress = params.stressPcts.map((x) => ({ pct: x, loss: notional * x / 100, pctEquity: notional * x / 100 / equity }));
  const out = {
    available: true, notional, leverage, riskBudget, equity, qty, price: P,
    stress, liquidation: { checked: false, note: PENDING }, reduction: [],
    deltaLoss: PENDING, tradeLoss: PENDING, tradeLossPctEquity: PENDING, deltaLossPctEquity: PENDING, riskAmount: PENDING, qMax: PENDING,
    overBudget: null, overLeverage: leverage > params.levRef, stopDistance: PENDING, stopDistancePct: PENDING,
  };
  if (S != null) {
    const dist = sign * (P - S);
    out.stopDistance = dist;
    out.stopDistancePct = dist / P;
    out.deltaLoss = qty * Math.max(dist, 0);
    out.deltaLossPctEquity = out.deltaLoss / equity;
    out.qMax = dist > 0 ? riskBudget / Math.max(dist, EPS) : PENDING;
    if (cost != null) {
      out.tradeLoss = qty * Math.max(sign * (cost - S), 0);
      out.tradeLossPctEquity = out.tradeLoss / equity;
      out.riskAmount = out.tradeLoss;
      out.overBudget = out.tradeLoss > riskBudget + EPS;
    }
  }
  if (liq != null) {
    const bufferPct = Math.abs(P - liq) / P;
    const before = S == null ? null : (side === 'long' ? liq > S : liq < S);
    out.liquidation = { checked: S != null, liq, bufferPct, liqBeforeStop: before, note: S == null ? '失效价未知，无法比较' : (before ? '强平先于止损' : '强平在止损之后') };
  }
  out.reduction = reductionTable({ side, cost, qty, equity, P, S, sign, margin, riskBudget, out }, params);
  return out;
}

// 手册 §14.2：不是只给最终状态，每一步重算名义、杠杆、压力损失。静态模拟下权益不变（浮盈亏转已实现）。
function reductionTable({ cost, qty, equity, P, S, sign, margin, riskBudget, out }, params) {
  const needBudget = out.overBudget === true;
  const needLev = out.overLeverage === true;
  if (!needBudget && !needLev) return [];
  const rows = [];
  const step = params.reduceStep;
  const origLev = (qty * P) / equity;
  const tradeLossAt = (q) => (S != null && cost != null ? q * Math.max(sign * (cost - S), 0) : null);
  const row = (k) => {
    const frac = Math.max(0, 1 - step * k);
    const q = qty * frac;
    const notional = q * P;
    const keep = notional / equity;
    const tl = tradeLossAt(q);
    return {
      step: k, action: k === 0 ? '当前' : `减仓 ${Math.round(step * k * 100)}%（累计）`,
      reduceQty: qty - q, reduceNotional: (qty - q) * P, remainQty: q, remainNotional: notional,
      equity, leverage: keep,
      leverageKeepMargin: keep, leverageReleaseMargin: margin === 'isolated' ? (q > 0 ? origLev : 0) : null,
      tradeLoss: tl, tradeLossPctEquity: tl == null ? null : tl / equity,
      stress: params.stressPcts.map((x) => ({ pct: x, loss: notional * x / 100, pctEquity: notional * x / 100 / equity })),
      withinBudget: tl == null ? null : tl <= riskBudget + EPS,
      withinLevRef: keep <= params.levRef,
    };
  };
  for (let k = 0; k * step < 1 + EPS; k += 1) {
    const r = row(k);
    rows.push(r);
    const budgetOk = !needBudget || r.withinBudget === true;
    const levOk = !needLev || r.withinLevRef;
    if (k > 0 && budgetOk && levOk) break;
  }
  return rows;
}

// 结构失效价：D8——以成本所在或下方（空头为上方）最近的共振区为准，复用 D7 的失效价逻辑。
function locateZone(side, cost, levels) {
  const list = side === 'long' ? levels.zones.support : levels.zones.resistance;
  const containing = list.find((z) => z.low <= cost && cost <= z.high);
  if (containing) return containing;
  if (side === 'long') return list.filter((z) => z.high <= cost).sort((a, b) => b.high - a.high)[0] || null;
  return list.filter((z) => z.low >= cost).sort((a, b) => a.low - b.low)[0] || null;
}

function buildPositionAdvice(input, facts, levels, state, params) {
  const { side, cost } = input;
  const long = side === 'long';
  const spot = facts.daily.close;
  const P = input.markPrice != null ? input.markPrice : spot;
  const priceSource = input.markPrice != null ? (input.markSource || '合约标记价') : '现货日线收盘价（合约标记价获取失败，风控改用现货收盘价）';

  const zone = locateZone(side, cost, levels);
  const anchor = zone || { low: cost, high: cost, mid: cost, count: 0, sources: [] };
  const inv = invalidationFor(side, anchor, facts, params);
  const S = inv ? inv.price : null;
  const dir = long ? 1 : -1;

  const vsMA = [];
  for (const [name, tf] of [['日线', facts.daily], ['4H', facts.h4], ['周线', facts.weekly]]) {
    for (const p of [30, 90, 120, 256]) {
      const m = tf && tf.ma && tf.ma[p];
      if (m) vsMA.push({ label: `${name === '4H' ? '4H ' : name}MA${p}`, value: m.value, costVsPct: (cost - m.value) / m.value });
    }
  }

  const risk = computeRisk({ side, cost, qty: input.qty, equity: input.equity, P, S, riskPct: input.riskPct, liq: input.liq, margin: input.margin }, params);
  const stopPnlPct = S == null ? PENDING : dir * (S - cost) / cost;
  const floatPnlPct = dir * (P - cost) / cost;

  const triggers = rightSideTriggers(side, anchor, facts, params);
  const family = state.family;
  const against = (long && (family === 'short' || family === 'broken')) || (!long && family === 'long');
  const hMA30 = facts.h4 && facts.h4.ma && facts.h4.ma[30] ? facts.h4.ma[30].value : null;
  const tp = levels.plans.find((c) => c.kind === 'plan' && c.direction === side && c.tp1 != null);

  const actions = { hold: [], reduce: [], stop: [], add: [] };
  if (S != null) {
    actions.stop.push(`日线收盘${long ? '跌破' : '升破'}失效价 ${fmtPrice(S)}（${inv.basis}）→ 按计划止损，相对成本 ${fmtPct(stopPnlPct)}`);
    actions.hold.push(`日线收盘仍在失效价 ${fmtPrice(S)} ${long ? '之上' : '之下'}，且状态不是${long ? '多头结构破坏/空头趋势' : '空头被逆转'}时，持有`);
  } else {
    actions.stop.push(`失效价${PENDING}（日线 ATR 或结构高低点数据不足），无法给出价位止损`);
  }
  if (against) actions.reduce.push(`当前状态为「${state.label}」，与持仓方向相反：优先减仓/降杠杆，不以浮亏金额作为继续持有的理由（手册 §15.1）`);
  // 减仓触发要选"尚未触发"的参考线：多单取现价下方最近的日线均线，空单取上方最近的
  const refs = [30, 90, 120].map((n) => [`日线 MA${n}`, facts.daily.ma && facts.daily.ma[n] ? facts.daily.ma[n].value : null]).filter(([, v]) => v != null);
  const notYet = refs.filter(([, v]) => (long ? v < spot : v > spot)).sort((a, b) => (long ? b[1] - a[1] : a[1] - b[1]));
  if (notYet.length) actions.reduce.push(`日线收盘${long ? '跌破' : '升破'}${notYet[0][0]}（${fmtPrice(notYet[0][1])}）或 4H 结构转${long ? 'LH/LL' : 'HH/HL'} → 减仓至风险预算内`);
  else actions.reduce.push(`4H 结构转${long ? 'LH/LL' : 'HH/HL'}，或日线收盘继续${long ? '下行' : '上行'}离开所有日线均线 → 减仓至风险预算内`);
  if (tp) actions.reduce.push(`到达 TP1 ${fmtPrice(tp.tp1)}${tp.tp2 != null ? `、TP2 ${fmtPrice(tp.tp2)}` : ''} → 分批止盈（单次阶段止盈不宜过大，手册 §12.2）`);
  const addable = !against && triggers.some((t) => t.met === true);
  actions.add.push(addable
    ? '右侧触发已满足其一，可在重新计算组合风险、且强平不早于止损的前提下小幅递增（手册 §11.2）'
    : '右侧三条触发均未满足，不加仓；左侧也不得无限摊低成本');
  for (const t of triggers) actions.add.push(`${t.met === true ? '[已满足]' : (t.met === false ? '[未满足]' : '[数据不足]')} ${t.text}`);
  if (hMA30 != null) actions.add.push(`参考：4H MA30 ${fmtPrice(hMA30)}`);

  const warnings = [];
  if (risk.liquidation && risk.liquidation.liqBeforeStop === true) warnings.push('强平先于止损：优先动作是降低杠杆或减仓，使强平价落在失效价之外（手册 §12.1）');
  if (risk.overBudget === true) warnings.push(`从成本到失效价的亏损超出风险预算（${fmtPctPlain(input.riskPct, 2)} 权益），需减仓`);
  if (risk.available && risk.overLeverage) warnings.push(`实际杠杆高于参考线 ${params.levRef}（D 级参考，非本人固定数字）`);
  if (input.markPrice == null) warnings.push('合约标记价获取失败，风控改用现货日线收盘价');

  const pending = [];
  if (input.qty == null) pending.push('持仓数量');
  if (input.equity == null) pending.push('相关风险池权益');
  if (input.lev == null) pending.push('设置杠杆');
  if (input.liq == null) pending.push('强平价');

  return {
    symbol: input.symbol, side, cost, qty: input.qty == null ? PENDING : input.qty,
    margin: input.margin || PENDING, lev: input.lev == null ? PENDING : input.lev, liq: input.liq == null ? PENDING : input.liq,
    equity: input.equity == null ? PENDING : input.equity, riskPct: input.riskPct,
    price: P, priceSource, spotClose: spot, floatPnlPct,
    location: {
      vsMA,
      zone: zone ? { low: zone.low, high: zone.high, mid: zone.mid, count: zone.count, sources: zone.sources } : null,
      note: zone ? '成本落在/邻近上列共振区' : '成本附近没有排名靠前的共振区，失效价以成本下方（空头为上方）最近确认高低点估算',
    },
    invalidation: inv ? { price: inv.price, basis: inv.basis } : null,
    stopPnlPct, risk, actions, warnings, pending,
    headline: warnings.find((w) => w.startsWith('强平先于止损'))
      || (against ? `状态「${state.label}」与${long ? '多' : '空'}单方向相反，优先降风险` : `状态「${state.label}」，失效价止损相对成本 ${typeof stopPnlPct === 'number' ? fmtPct(stopPnlPct) : PENDING}`),
  };
}

// ---- 手册 §20.2 快照子集：yaml / json ----
function loadSnapshot(file) {
  const text = fs.readFileSync(file, 'utf8');
  const doc = path.extname(file).toLowerCase() === '.json' ? JSON.parse(text) : YAML.parse(text);
  if (!doc || typeof doc !== 'object') throw new Error(`快照 ${file} 内容为空或格式不对`);
  const positions = [];
  for (const p of Array.isArray(doc.positions) ? doc.positions : []) {
    const symbol = String(p.symbol || '').toUpperCase();
    const amt = num(p.positionAmt);
    if (!symbol || !amt) continue;
    const coinM = !/USDT$|USDC$|BUSD$/.test(symbol) && /USD(_|$)/.test(symbol);
    const ps = String(p.positionSide || '').toUpperCase();
    const side = ps === 'LONG' ? 'long' : (ps === 'SHORT' ? 'short' : (amt > 0 ? 'long' : 'short'));
    const margin = String(p.marginType || '').toUpperCase() === 'ISOLATED' ? 'isolated' : 'cross';
    const equity = margin === 'isolated' ? num(p.isolatedWallet) : num(doc.totalMarginBalance);
    positions.push({
      symbol, supported: !coinM, reason: coinM ? '币本位反向合约，非线性盈亏不支持' : null,
      side, qty: Math.abs(amt), cost: num(p.entryPrice), markPrice: num(p.markPrice),
      lev: num(p.leverage_configured), margin, equity, liq: num(p.liquidationPrice),
    });
  }
  return { snapshotAt: doc.snapshot_at == null ? null : String(doc.snapshot_at), exchange: doc.exchange || null, positions };
}

module.exports = { computeRisk, reductionTable, locateZone, buildPositionAdvice, loadSnapshot };
