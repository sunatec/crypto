'use strict';

// 手册 §15.1 状态机（含空头对称，共 6 态）。按优先级判定，先命中先返回；每条判定条件逐项列出命中情况。

const STATE_LABELS = {
  TREND_LONG: '趋势多头',
  PULLBACK_IN_UPTREND: '上升趋势中回调',
  RANGE: '区间震荡',
  TREND_BROKEN_LONG: '多头结构破坏',
  TREND_SHORT: '趋势空头',
  RALLY_IN_DOWNTREND: '下降趋势中反抽',
};

const FAMILY = {
  TREND_LONG: 'long', PULLBACK_IN_UPTREND: 'long',
  TREND_SHORT: 'short', RALLY_IN_DOWNTREND: 'short',
  RANGE: 'range', TREND_BROKEN_LONG: 'broken',
};

const maOf = (tf, p) => (tf && tf.ma && tf.ma[p]) || null;
const structOf = (tf) => (tf && tf.structure) || {};
// 最近确认的 HL / LH：优先用结构事实里的 lastHL / lastLH；缺省时退回"最近低点比前一低点更高"的判定
const hlOf = (ds) => ds.lastHL || (ds.lastLow && ds.prevLow && ds.lastLow.price > ds.prevLow.price ? ds.lastLow : null);
const lhOf = (ds) => ds.lastLH || (ds.lastHigh && ds.prevHigh && ds.lastHigh.price < ds.prevHigh.price ? ds.lastHigh : null);
const fmt = (n) => (n == null ? '数据不足' : String(Math.round(n * 100) / 100));

function classifyState(facts) {
  const w = facts.weekly;
  const d = facts.daily;
  const h = facts.h4;
  const wMA30 = maOf(w, 30);
  const dMA30 = maOf(d, 30);
  const dMA90 = maOf(d, 90);
  const dMA120 = maOf(d, 120);
  const ds = structOf(d);
  const hs = structOf(h);

  const tri = (v) => (v == null ? null : Boolean(v));
  const wAbove = wMA30 && w.close != null ? w.close > wMA30.value : null;
  const wBelow = wMA30 && w.close != null ? w.close < wMA30.value : null;
  const wUp = wMA30 ? tri(wAbove && wMA30.slope === 'up') : null;
  const wDown = wMA30 ? tri(wBelow && wMA30.slope === 'down') : null;
  const hl = hlOf(ds);
  const lh = lhOf(ds);
  const dLowBelowHL = hl && d.close != null ? tri(d.close < hl.price) : null;
  const hlIntact = d.close != null && (hl || ds.lastLow) ? tri(d.close >= (hl || ds.lastLow).price && ds.pattern !== 'LH/LL') : null;
  const lhIntact = d.close != null && (lh || ds.lastHigh) ? tri(d.close <= (lh || ds.lastHigh).price && ds.pattern !== 'HH/HL') : null;
  const ma90Up = dMA90 ? dMA90.slope === 'up' : null;
  const ma120Up = dMA120 ? dMA120.slope === 'up' : null;
  const ma90Down = dMA90 ? dMA90.slope === 'down' : null;
  const ma120Down = dMA120 ? dMA120.slope === 'down' : null;
  const dBelowMA30 = dMA30 && d.close != null ? d.close < dMA30.value : null;
  const dAboveMA30 = dMA30 && d.close != null ? d.close >= dMA30.value : null;
  const h4LHLL = hs.pattern == null ? null : hs.pattern === 'LH/LL';
  const h4HHHL = hs.pattern == null ? null : hs.pattern === 'HH/HL';
  const glued = d && d.glue ? d.glue.glued : null;
  const weeklyMixedFlat = w && wMA30 ? tri(w.alignment === 'mixed' && wMA30.slope === 'flat') : null;
  const dMA90NotUp = dMA90 ? dMA90.slope !== 'up' : null;

  const all = (...xs) => (xs.some((x) => x === false) ? false : (xs.some((x) => x == null) ? null : true));
  const any = (...xs) => (xs.some((x) => x === true) ? true : (xs.some((x) => x == null) ? null : false));
  const not = (x) => (x == null ? null : !x);

  const c = (id, text, met) => ({ id, text, met });
  const conditions = [
    c('W_UP', `周线收盘 ${fmt(w && w.close)} 高于上行的 MA30（${fmt(wMA30 && wMA30.value)}，${wMA30 ? wMA30.slope : '数据不足'}）`, wUp),
    c('W_DOWN', `周线收盘低于下行的 MA30`, wDown),
    c('D_HL_BROKEN', `日线收盘 ${fmt(d && d.close)} 跌破最近确认 HL（${fmt(hl && hl.price)}）`, dLowBelowHL),
    c('D_HL_INTACT', '日线 HL 未破且结构不是 LH/LL', hlIntact),
    c('D_LH_INTACT', '日线 LH 未破且结构不是 HH/HL', lhIntact),
    c('D_MA90_NOT_UP', '日线 MA90 走平或下行', dMA90NotUp),
    c('D_MA90_120_UP', '日线 MA90、MA120 均上行', all(ma90Up, ma120Up)),
    c('D_MA90_120_DOWN', '日线 MA90、MA120 均下行', all(ma90Down, ma120Down)),
    c('D_ABOVE_MA30', '日线收盘不低于 MA30', dAboveMA30),
    c('D_BELOW_MA30', '日线收盘低于 MA30', dBelowMA30),
    c('H4_LH_LL', '4H 结构为 LH/LL', h4LHLL),
    c('H4_HH_HL', '4H 结构为 HH/HL', h4HHHL),
    c('D_GLUED', '日线 MA30/90/120 粘合', glued),
    c('W_MIXED_FLAT', '周线 MA5/10/30 交错且 MA30 走平', weeklyMixedFlat),
  ];

  const result = (state, rule) => ({ state, label: STATE_LABELS[state], family: FAMILY[state], rule, conditions });

  // 1 多头破坏优先于一切趋势判定。周线破位但日线已是完整 LH/LL 时，属于已确立的空头，留给下面的空头分支。
  const brokenA = all(dLowBelowHL, dMA90NotUp);
  const brokenB = all(wDown, ds.pattern == null ? null : (ds.pattern !== 'LH/LL' && ds.pattern !== 'HH/HL'));
  if (any(brokenA, brokenB) === true) {
    return result('TREND_BROKEN_LONG', brokenA === true ? '日线收盘跌破最近确认 HL 且 MA90 走平/下行' : '周线收在下行的 MA30 之下，日线结构既不是完整 LH/LL 也不是 HH/HL 反抽');
  }
  // 2 区间
  if (any(glued, weeklyMixedFlat) === true) return result('RANGE', glued ? '日线 MA30/90/120 粘合' : '周线 MA5/10/30 交错且 MA30 走平');
  // 3/4 多头
  if (wUp === true) {
    if (all(hlIntact, all(ma90Up, ma120Up), dAboveMA30, not(h4LHLL)) === true) return result('TREND_LONG', '周线偏多、日线 HL 未破、MA90/120 上行、日线站上 MA30、4H 未走弱');
    if (any(dBelowMA30, h4LHLL) === true) return result('PULLBACK_IN_UPTREND', '周线偏多（多头破坏条件未命中），日线收在 MA30 下或 4H 为 LH/LL');
  }
  // 5 空头镜像
  if (wDown === true) {
    if (all(lhIntact, all(ma90Down, ma120Down), dBelowMA30, not(h4HHHL)) === true) return result('TREND_SHORT', '周线偏空、日线 LH 未破、MA90/120 下行、日线在 MA30 下、4H 未转强');
    if (any(dAboveMA30, h4HHHL) === true) return result('RALLY_IN_DOWNTREND', '周线偏空，日线收在 MA30 上或 4H 为 HH/HL');
  }
  return result('RANGE', '未命中任何趋势条件，按区间处理');
}

module.exports = { classifyState, STATE_LABELS, FAMILY };
