'use strict';

const { computeATR } = require('../analyze-wave-manual');

// 全部为纯函数：同一组 K 线 + 参数必得同一结果。历史不足的指标为 null，并写入 dataGaps，不估算。

function sma(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

// EMA 以首个值作种子（与 TradingView ta.ema 一致，长历史下与 SMA 种子的差异可忽略）。
function ema(values, n) {
  const out = new Array(values.length).fill(null);
  if (!values.length) return out;
  const alpha = 2 / (n + 1);
  out[0] = values[0];
  for (let i = 1; i < values.length; i += 1) out[i] = alpha * values[i] + (1 - alpha) * out[i - 1];
  return out;
}

// 柱 = DIF − DEA（与 Binance 图表一致；国内软件常乘 2，不影响正负与比较）。
// 前 slow+signal−2 根尚在预热，返回 null。
function macd(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const dif = closes.map((_, i) => emaFast[i] - emaSlow[i]);
  const dea = ema(dif, signal);
  const warm = slow + signal - 2;
  const mask = (arr) => arr.map((v, i) => (i < warm ? null : v));
  return { dif: mask(dif), dea: mask(dea), hist: mask(dif.map((v, i) => v - dea[i])) };
}

// (MA[t] − MA[t−k]) / MA[t−k]；|变化| < flat 视为走平。
function slopeOf(series, i, lookback, flat) {
  if (i - lookback < 0) return null;
  const now = series[i];
  const before = series[i - lookback];
  if (now == null || before == null || before === 0) return null;
  const slopePct = (now - before) / before;
  const dir = Math.abs(slopePct) < flat ? 'flat' : (slopePct > 0 ? 'up' : 'down');
  return { slopePct, dir };
}

function alignmentOf(m5, m10, m30) {
  if (m5 == null || m10 == null || m30 == null) return null;
  if (m5 > m10 && m10 > m30) return 'bull';
  if (m5 < m10 && m10 < m30) return 'bear';
  return 'mixed';
}

function glueAt(ma30, ma90, ma120, close) {
  if (ma30 == null || ma90 == null || ma120 == null || !close) return null;
  const bandHigh = Math.max(ma30, ma90, ma120);
  const bandLow = Math.min(ma30, ma90, ma120);
  return { bandHigh, bandLow, spreadPct: (bandHigh - bandLow) / close };
}

// 止跌 K（side=long）：下影 ≥ 振幅 50% 且收盘 ≥ 支撑价；或看涨吞没。止涨 K（side=short）对称。
// bars 取最近已收盘 K 线（至少最后一根；吞没需要前一根）。refPrice 为 null 时不检查支撑/阻力价。
function reversalCandle(bars, side, refPrice, params) {
  if (!bars || !bars.length) return { met: false, kind: null };
  const last = bars[bars.length - 1];
  const prev = bars.length > 1 ? bars[bars.length - 2] : null;
  const range = last.high - last.low;
  const bodyLow = Math.min(last.open, last.close);
  const bodyHigh = Math.max(last.open, last.close);
  const wick = side === 'long' ? bodyLow - last.low : last.high - bodyHigh;
  const wickRatio = range > 0 ? wick / range : 0;
  const refOk = refPrice == null || (side === 'long' ? last.close >= refPrice : last.close <= refPrice);
  const wickMet = range > 0 && wickRatio >= params.stopWickRatio && refOk;
  let engulf = false;
  if (prev) {
    engulf = side === 'long'
      ? prev.close < prev.open && last.close > last.open && last.close >= prev.open && last.open <= prev.close
      : prev.close > prev.open && last.close < last.open && last.close <= prev.open && last.open >= prev.close;
    if (refPrice != null) engulf = engulf && (side === 'long' ? last.close >= refPrice : last.close <= refPrice);
  }
  return { met: wickMet || engulf, kind: wickMet ? 'wick' : (engulf ? 'engulf' : null), wickRatio };
}

// 粘合后突破 + 首次回踩（手册 §7 的 D 定义，§11.2 第 3 条）。
function glueBreakout(candles, glueSeries, params) {
  const n = candles.length;
  const none = { dir: null, glueRecent: false, retest: false };
  const gl = glueSeries[n - 1];
  if (n < 2 || !gl) return none;
  let glueRecent = false;
  for (let i = Math.max(0, n - 1 - params.glueLookback); i < n; i += 1) {
    if (glueSeries[i] && glueSeries[i].spreadPct < params.gluePct) { glueRecent = true; break; }
  }
  if (!glueRecent) return none;
  const close = candles[n - 1].close;
  const window = candles.slice(Math.max(0, n - params.retestWindow));
  const atr = glueSeries.atr || 0;
  const tol = params.mergeAtr * atr;
  if (close > gl.bandHigh) {
    const minLow = Math.min(...window.map((c) => c.low));
    return { dir: 'up', glueRecent, retest: minLow <= gl.bandHigh + tol, bandHigh: gl.bandHigh, bandLow: gl.bandLow };
  }
  if (close < gl.bandLow) {
    const maxHigh = Math.max(...window.map((c) => c.high));
    return { dir: 'down', glueRecent, retest: maxHigh >= gl.bandLow - tol, bandHigh: gl.bandHigh, bandLow: gl.bandLow };
  }
  return { dir: null, glueRecent, retest: false };
}

// 一个周期的事实层。返回 { facts, internals }：facts 进 JSON，internals 是后续模块要用的序列。
function analyzeTimeframe(candles, label, params) {
  const n = candles.length;
  const dataGaps = [];
  const closes = candles.map((c) => c.close);
  const atrSeries = computeATR(candles, params.atrPeriod);
  const atr = n ? atrSeries[n - 1] : null;
  if (n && atr == null) dataGaps.push(`${label} ATR${params.atrPeriod} 数据不足，未计算（实际 ${n} 根，需 ${params.atrPeriod + 1} 根）`);
  const last = n ? candles[n - 1] : null;
  const close = last ? last.close : null;

  const maSeries = {};
  const ma = {};
  for (const period of params.maPeriods) {
    maSeries[period] = sma(closes, period);
    const value = n ? maSeries[period][n - 1] : null;
    if (value == null) {
      ma[period] = null;
      dataGaps.push(`${label} MA${period} 数据不足，未计算（实际 ${n} 根，需 ${period} 根）`);
      continue;
    }
    const slope = slopeOf(maSeries[period], n - 1, params.slopeLookback, params.slopeFlat);
    ma[period] = {
      period, value,
      devPct: (close - value) / value,
      devAtr: atr ? (close - value) / atr : null,
      slopePct: slope ? slope.slopePct : null,
      slope: slope ? slope.dir : null,
    };
  }
  const val = (p) => (ma[p] ? ma[p].value : null);

  const glueSeries = candles.map((c, i) => glueAt(maSeries[30] && maSeries[30][i], maSeries[90] && maSeries[90][i], maSeries[120] && maSeries[120][i], c.close));
  glueSeries.atr = atr || 0;
  const glueNow = n ? glueSeries[n - 1] : null;
  if (n && !glueNow) dataGaps.push(`${label} 粘合判定数据不足（需 MA30/MA90/MA120）`);

  const m = macd(closes, params.macdFast, params.macdSlow, params.macdSignal);
  const macdNeed = params.macdSlow + params.macdSignal - 1;
  let macdFacts = null;
  if (n >= macdNeed + 1 && m.hist[n - 1] != null) {
    macdFacts = { dif: m.dif[n - 1], dea: m.dea[n - 1], hist: m.hist[n - 1], prevHist: m.hist[n - 2] };
  } else {
    dataGaps.push(`${label} MACD${params.macdFast}/${params.macdSlow}/${params.macdSignal} 数据不足，未计算（实际 ${n} 根，需 ${macdNeed + 1} 根）`);
  }

  const facts = {
    label, count: n,
    lastTs: last ? last.timestamp : null,
    lastCloseIso: last ? new Date((last.timestamp) * 1000).toISOString() : null,
    close, high: last ? last.high : null, low: last ? last.low : null,
    atr: atr == null ? null : atr,
    ma,
    alignment: alignmentOf(val(5), val(10), val(30)),
    glue: glueNow ? { spreadPct: glueNow.spreadPct, glued: glueNow.spreadPct < params.gluePct, bandLow: glueNow.bandLow, bandHigh: glueNow.bandHigh } : null,
    macd: macdFacts,
    lastBars: candles.slice(-3).map((c) => ({ ts: c.timestamp, open: c.open, high: c.high, low: c.low, close: c.close })),
    dataGaps,
  };
  return { facts, internals: { closes, atrSeries, maSeries, macd: m, glueSeries } };
}

module.exports = { sma, ema, macd, slopeOf, alignmentOf, glueAt, reversalCandle, glueBreakout, analyzeTimeframe };
