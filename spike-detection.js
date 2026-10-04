'use strict';

const { computeATR } = require('./analyze-wave-manual');
const { getCandles } = require('./candle-cache');

// 工程阈值；§3.15 没有规定量化分界。
const ATR_MULTIPLIER = 2;
const LOW_PRICE_RATIO = 0.5;
const HIGH_PRICE_RATIO = 2;
const VOLUME_MULTIPLIER = 5;
const HOUR = 3600, DAY = 86400;
const TF_SECONDS = { '5m': 300, '1h': HOUR, '4h': 4 * HOUR, '1d': DAY, '1w': 7 * DAY };

function median(values) {
  const sorted = values.filter(v => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const i = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2;
}

function candleEnd(candle, timeframe, inferredWidth) {
  if (timeframe === '1m' || timeframe === '1y') {
    const d = new Date(candle.timestamp * 1000);
    return (timeframe === '1m' ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
      : Date.UTC(d.getUTCFullYear() + 1, 0, 1)) / 1000;
  }
  return candle.timestamp + (TF_SECONDS[timeframe] || inferredWidth || DAY);
}

function detectSpikeCandidates(candles, { atrPeriod = 14, timeframe } = {}) {
  const atr = computeATR(candles, atrPeriod);
  const widths = candles.slice(1).map((c, i) => c.timestamp - candles[i].timestamp).filter(w => w > 0);
  const inferredWidth = widths.length ? Math.min(...widths) : DAY;
  const candidates = [];
  candles.forEach((c, i) => {
    const prev = candles[i - 1], next = candles[i + 1];
    for (const type of ['L', 'H']) {
      const low = type === 'L';
      const referencePrice = low ? Math.min(c.open, c.close, prev ? prev.low : Infinity, next ? next.low : Infinity)
        : Math.max(c.open, c.close, prev ? prev.high : -Infinity, next ? next.high : -Infinity);
      const originalPrice = low ? c.low : c.high;
      const priceCondition = low ? originalPrice < referencePrice * LOW_PRICE_RATIO : originalPrice > referencePrice * HIGH_PRICE_RATIO;
      const protrusion = prev && next ? (low ? Math.min(prev.low, next.low) - originalPrice : originalPrice - Math.max(prev.high, next.high)) : 0;
      const wick = low ? Math.min(c.open, c.close) - originalPrice : originalPrice - Math.max(c.open, c.close);
      const structureCondition = !!prev && !!next && atr[i] > 0 && protrusion > 0
        && protrusion >= ATR_MULTIPLIER * atr[i] && wick >= ATR_MULTIPLIER * atr[i];
      if (!priceCondition && !structureCondition) continue;
      candidates.push({ index: i, timestamp: c.timestamp, endTimestamp: candleEnd(c, timeframe, inferredWidth),
        type, originalPrice, referencePrice, conditions: [...(structureCondition ? ['structure'] : []), ...(priceCondition ? ['price'] : [])],
        atr: atr[i], protrusion, wick });
    }
  });
  return candidates;
}

function volumeEvidence(candles, index, radius) {
  const neighbors = candles.slice(Math.max(0, index - radius), index).concat(candles.slice(index + 1, index + radius + 1));
  const baseline = median(neighbors.map(c => c.volume));
  const volume = candles[index].volume;
  // 零基准无法量化，不能据此宣称低量并删除极值。
  const ratio = baseline > 0 && Number.isFinite(volume) && volume >= 0 ? volume / baseline : null;
  return { volume, medianVolume: baseline, volumeRatio: ratio, volumeSamples: neighbors.filter(c => Number.isFinite(c.volume) && c.volume >= 0).length };
}

function classified(candidate, evidence, { usedTimeframe, volumeTimestamp = candidate.timestamp, fallback = false, fallbackReason = null }) {
  const classification = evidence.volumeRatio == null ? 'unknown' : evidence.volumeRatio >= VOLUME_MULTIPLIER ? 'volume' : 'thin';
  return { ...candidate, ...evidence, classification, usedTimeframe, volumeTimestamp,
    confidence: fallback || evidence.volumeRatio == null || evidence.volumeSamples < 48 ? 'low' : 'normal',
    note: evidence.volumeRatio == null ? '量能基准不足，暂不能分类' : fallback ? '仅主周期量能，置信度较低' : '',
    fallbackReason, clipped: false, adjustedPrice: candidate.originalPrice };
}

// 纯函数背景入口没有网络能力时，使用同一量能规则的主周期降级分类。
function classifyMainSpikes(candidates, { candles, timeframe = '1d', isStock = false }) {
  return candidates.map(c => classified(c, volumeEvidence(candles, c.index, !isStock && c.endTimestamp - c.timestamp <= HOUR ? 24 : 20),
    { usedTimeframe: timeframe, fallback: isStock || c.endTimestamp - c.timestamp > HOUR }));
}

async function classifySpikes(candidates, { candles, product, timeframe = '1d', isStock = false, refresh = false, fetchFiner = getCandles } = {}) {
  const results = [];
  for (const candidate of candidates) {
    let evidence = null, usedTimeframe = timeframe, fallbackReason = null, volumeTimestamp = candidate.timestamp;
    const width = candidate.endTimestamp - candidate.timestamp;
    if (!isStock && width > HOUR) {
      try {
        if (!product) throw new Error('未提供交易对');
        const fetched = await fetchFiner(product, HOUR, new Date((candidate.timestamp - DAY) * 1000), new Date((candidate.endTimestamp + DAY) * 1000), { refresh });
        if (fetched.fetchErrors && fetched.fetchErrors.length) throw new Error('小时行情分页不完整');
        const hours = fetched.slice().sort((a, b) => a.timestamp - b.timestamp);
        const i = hours.findIndex(c => c.timestamp >= candidate.timestamp && c.timestamp < candidate.endTimestamp
          && (candidate.type === 'L' ? c.low : c.high) === candidate.originalPrice);
        if (i < 0) throw new Error('小时线未定位到原极值');
        evidence = volumeEvidence(hours, i, 24);
        if (evidence.volumeRatio == null) throw new Error('小时线量能基准不足');
        usedTimeframe = '1h';
        volumeTimestamp = hours[i].timestamp;
      } catch (e) { evidence = null; fallbackReason = e.message; }
    }
    const fallback = !evidence && (isStock || width > HOUR);
    if (!evidence) evidence = volumeEvidence(candles, candidate.index, width <= HOUR && !isStock ? 24 : 20);
    results.push(classified(candidate, evidence, { usedTimeframe, volumeTimestamp, fallback, fallbackReason }));
  }
  return results;
}

function clipThinSpikes(candles, spikes) {
  const clips = [];
  const out = candles.map(c => {
    const copy = { ...c };
    for (const s of spikes) {
      if (s.classification !== 'thin' || c.timestamp < s.timestamp || c.timestamp >= s.endTimestamp) continue;
      const key = s.type === 'L' ? 'low' : 'high';
      if (s.type === 'L' ? copy.low >= s.referencePrice : copy.high <= s.referencePrice) continue;
      const originalPrice = copy[key];
      copy[key] = s.referencePrice;
      if (s.type === 'L') copy.high = Math.max(copy.high, copy.low);
      else copy.low = Math.min(copy.low, copy.high);
      // 开盘即异常价时，OHLC 也须满足 low ≤ open/close ≤ high。
      copy.open = Math.max(copy.low, Math.min(copy.high, copy.open));
      copy.close = Math.max(copy.low, Math.min(copy.high, copy.close));
      clips.push({ timestamp: c.timestamp, type: s.type, originalPrice, adjustedPrice: s.referencePrice, spikeTimestamp: s.timestamp });
    }
    return copy;
  });
  if (candles.fetchErrors) out.fetchErrors = candles.fetchErrors;
  if (candles.listingTs != null) out.listingTs = candles.listingTs;
  return { candles: out, clips };
}

function markSpikeTreatment(spikes, clips) {
  return spikes.map(s => {
    const clipped = clips.some(c => c.spikeTimestamp === s.timestamp && c.type === s.type);
    return { ...s, clipped, adjustedPrice: clipped ? s.referencePrice : s.originalPrice };
  });
}

function formatSpike(s, price = String) {
  const date = new Date(s.timestamp * 1000).toISOString();
  const label = s.classification === 'volume' ? '有量扎针' : s.classification === 'thin' ? '疑似乌龙针' : '量能不足，分类待定';
  const ratio = s.volumeRatio == null ? '倍数不可用' : `${s.volumeRatio.toFixed(2)} 倍`;
  return `${date} ${s.type === 'L' ? '低点' : '高点'}：${price(s.originalPrice)} → ${price(s.referencePrice)}（参考价）；${label}，${ratio}，所用周期 ${s.usedTimeframe}${s.note ? `，${s.note}` : ''}；${s.clipped ? `已截取为 ${price(s.adjustedPrice)}` : '保留原价'}；命中${s.conditions.map(c => c === 'structure' ? '结构条件' : '价格条件').join('、')}。${s.classification === 'volume' ? '§3.15：真实的一浪，常作为 X 连接段。' : ''}`;
}

module.exports = { detectSpikeCandidates, classifySpikes, classifyMainSpikes, clipThinSpikes, markSpikeTreatment, formatSpike,
  ATR_MULTIPLIER, LOW_PRICE_RATIO, HIGH_PRICE_RATIO, VOLUME_MULTIPLIER };
