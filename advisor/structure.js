'use strict';

const { detectPivots, computeATR } = require('../analyze-wave-manual');

// 拐点：与波浪引擎同参数（lookback 2、摆幅 ≥ 1×ATR），保证两边拐点一致；再强制 H/L 交替。
function computePivots(candles, params) {
  if (!candles.length) return [];
  const indexed = candles.map((c, i) => ({ ...c, index: i }));
  const raw = detectPivots(indexed, params.pivotLookback, {
    atrSeries: computeATR(indexed, params.atrPeriod), atrMultiplier: params.pivotAtrMult,
  });
  const out = [];
  for (const p of raw) {
    const pivot = { index: p.index, type: p.type, price: p.price, ts: p.timestamp };
    const last = out[out.length - 1];
    if (last && last.type === pivot.type) {
      const moreExtreme = pivot.type === 'H' ? pivot.price >= last.price : pivot.price <= last.price;
      if (moreExtreme) out[out.length - 1] = pivot;
    } else {
      out.push(pivot);
    }
  }
  return out;
}

// 最近两个已确认高点与两个已确认低点比较：HH/HL、LH/LL，否则 mixed。
function classifyStructure(pivots) {
  const highs = pivots.filter((p) => p.type === 'H');
  const lows = pivots.filter((p) => p.type === 'L');
  const lastHigh = highs[highs.length - 1] || null;
  const prevHigh = highs[highs.length - 2] || null;
  const lastLow = lows[lows.length - 1] || null;
  const prevLow = lows[lows.length - 2] || null;
  // 最近一个"更高的低点"（HL）与"更低的高点"（LH）：趋势里被守护/被压制的那个结构点
  let lastHL = null;
  let lastLH = null;
  for (let i = 1; i < lows.length; i += 1) if (lows[i].price > lows[i - 1].price) lastHL = lows[i];
  for (let i = 1; i < highs.length; i += 1) if (highs[i].price < highs[i - 1].price) lastLH = highs[i];
  let pattern = null;
  if (lastHigh && prevHigh && lastLow && prevLow) {
    const hh = lastHigh.price > prevHigh.price;
    const hl = lastLow.price > prevLow.price;
    const lh = lastHigh.price < prevHigh.price;
    const ll = lastLow.price < prevLow.price;
    pattern = hh && hl ? 'HH/HL' : (lh && ll ? 'LH/LL' : 'mixed');
  }
  return { pattern, lastHigh, prevHigh, lastLow, prevLow, lastHL, lastLH };
}

const iso = (ts) => new Date(ts * 1000).toISOString();

// MACD 三段背离（手册 §8.1/§8.4）。side='bottom' 底背离 / 'top' 顶背离。
// hist 与 K 线等长；pivots 为交替拐点；lastIndex/lastTs 为最后一根已收盘 K 线。
function detectDivergence({ hist, pivots, side, label, lastIndex, lastTs, params }) {
  const bottom = side === 'bottom';
  const base = {
    status: 'none', side, timeframe: label,
    macdParams: `${params.macdFast}/${params.macdSlow}/${params.macdSignal}`,
    extremes: [], separators: [], oppositeBarSeen: null, ordinary: false,
    lastClosedTs: lastTs, lastClosedIso: lastTs == null ? null : iso(lastTs),
    stopPrice: null, nextBarRule: null, reasons: [],
  };
  const fail = (reason) => ({ ...base, reasons: [...base.reasons, reason] });

  const type = bottom ? 'L' : 'H';
  const ps = pivots.filter((p) => p.type === type).slice(-3);
  if (ps.length < 3) return fail(`${label} 已确认${bottom ? '低' : '高'}点不足 3 个，数据不足`);

  const w = params.divergenceWindow;
  const extremes = ps.map((p) => {
    let ext = null;
    for (let i = Math.max(0, p.index - w); i <= Math.min(lastIndex, p.index + w); i += 1) {
      const h = hist[i];
      if (h == null) continue;
      if (ext == null || (bottom ? h < ext : h > ext)) ext = h;
    }
    return { price: p.price, ts: p.ts, iso: iso(p.ts), index: p.index, histExtreme: ext };
  });
  base.extremes = extremes.map(({ index, ...rest }) => rest);
  if (extremes.some((e) => e.histExtreme == null || (bottom ? e.histExtreme >= 0 : e.histExtreme <= 0))) {
    return fail(`${label} 极值点所在柱段不在${bottom ? '负' : '正'}柱区，不构成${bottom ? '底' : '顶'}背离`);
  }

  const priceOk = bottom
    ? extremes[0].price > extremes[1].price && extremes[1].price > extremes[2].price
    : extremes[0].price < extremes[1].price && extremes[1].price < extremes[2].price;
  const mags = extremes.map((e) => Math.abs(e.histExtreme));
  const weaken = mags[0] > mags[1] && mags[1] > mags[2];

  const separators = [0, 1].map((k) => {
    const from = extremes[k].index + 1;
    const to = extremes[k + 1].index - 1;
    let ext = null;
    for (let i = from; i <= to; i += 1) {
      const h = hist[i];
      if (h == null) continue;
      if (ext == null || (bottom ? h > ext : h < ext)) ext = h;
    }
    const opposite = ext != null && (bottom ? ext > 0 : ext < 0);
    const near = !opposite && ext != null && Math.abs(ext) <= params.divergenceZeroTol * mags[k];
    return { extremeBetween: ext, opposite, near, separated: opposite || near };
  });
  base.separators = separators.map(({ separated, ...rest }) => rest);
  const separated = separators.every((s) => s.separated);
  base.oppositeBarSeen = separators.every((s) => s.opposite);

  if (!priceOk) return fail(`${label} 三个${bottom ? '低' : '高'}点价格未依次${bottom ? '更低' : '更高'}`);
  if (!weaken) return fail(`${label} 柱${bottom ? '谷' : '峰'}绝对值未连续两次减弱（${mags.map((m) => m.toFixed(4)).join(' → ')}）`);
  if (!separated) {
    return { ...base, ordinary: true, reasons: [`${label} 三段之间缺少反向柱或接近零轴，最多算普通背离`] };
  }
  if (lastIndex - extremes[2].index > params.divergenceMaxAge) {
    return fail(`${label} 第三${bottom ? '低' : '高'}点距最新收盘已超过 ${params.divergenceMaxAge} 根，不再视为当前信号`);
  }

  const last = hist[lastIndex];
  const prev = hist[lastIndex - 1];
  const shortened = lastIndex > extremes[2].index && last != null && prev != null
    && (bottom ? prev < 0 && last > prev : prev > 0 && last < prev);
  return {
    ...base,
    status: shortened ? 'confirmed' : 'forming',
    stopPrice: extremes[2].price,
    nextBarRule: '确认后下一根同级别 K 线的柱若未继续向预期方向缩短，提前退出，不必等打到结构止损（手册 §8.2）',
    reasons: shortened ? [] : [`${label} 第三${bottom ? '低' : '高'}点后最新收盘柱尚未缩短：可能出现背离，但三段背离尚未被确认`],
  };
}

// 一个周期的结构事实 + 背离。pivots 同时返回给点位模块使用。
function analyzeStructure(candles, internals, label, params) {
  const pivots = computePivots(candles, params);
  const cls = classifyStructure(pivots);
  const dataGaps = [];
  if (!cls.pattern) dataGaps.push(`${label} 已确认高低点不足（需至少 2 高 2 低），HH/HL 判定数据不足`);
  const lastIndex = candles.length - 1;
  const lastTs = candles.length ? candles[lastIndex].timestamp : null;
  const hist = internals.macd.hist;
  const divergence = {};
  for (const side of ['bottom', 'top']) {
    divergence[side] = detectDivergence({ hist, pivots, side, label, lastIndex, lastTs, params });
  }
  const view = (p) => (p ? { price: p.price, ts: p.ts, iso: iso(p.ts) } : null);
  const facts = {
    pattern: cls.pattern,
    lastHigh: view(cls.lastHigh), prevHigh: view(cls.prevHigh), lastLow: view(cls.lastLow), prevLow: view(cls.prevLow), lastHL: view(cls.lastHL), lastLH: view(cls.lastLH),
    pivots: pivots.slice(-12).map((p) => ({ type: p.type, price: p.price, ts: p.ts, iso: iso(p.ts) })),
    lastSwing: pivots.length >= 2 ? { from: view(pivots[pivots.length - 2]), fromType: pivots[pivots.length - 2].type, to: view(pivots[pivots.length - 1]), toType: pivots[pivots.length - 1].type } : null,
    divergence,
    dataGaps,
  };
  return { facts, pivots };
}

module.exports = { computePivots, classifyStructure, detectDivergence, analyzeStructure };
