'use strict';

const { getCandles } = require('../candle-cache');
const { fetchBinancePage, BINANCE_GRANULARITIES } = require('../binance-candle-transport');
const { transformCandles, TIMEFRAMES } = require('../analyze-wave-manual');

const DAY = 86400;
const H4 = 14400;
const WEEK = 604800;
const H4_BARS = 400; // MA256 + 背离回看

// 丢弃 OHLC 非有限数的坏 K 线（缓存损坏或接口异常），数量记入 market.dropped，不让 NaN 渗进事实层
const finiteBar = (c) => ['open', 'high', 'low', 'close'].every((k) => Number.isFinite(c[k]));

const nowSeconds = (now) => Math.floor((now instanceof Date ? now.getTime() : Number(now)) / 1000);

// 只保留已收盘的 K 线：开盘 + 周期 ≤ 现在。candle-cache 的返回里会带"尚未沉淀"的最后一根。
function dropUnclosed(candles, granularity, now) {
  const nowSec = nowSeconds(now);
  return candles.filter((c) => c.timestamp + granularity <= nowSec);
}

// 周线由已收盘日线按 UTC 周一 00:00 切分合成（Binance 周线同口径）；当周没走完（周日收盘前）整根丢弃。
function synthesizeWeekly(dailyClosed) {
  if (!dailyClosed.length) return [];
  const weekly = transformCandles(dailyClosed, TIMEFRAMES['1w']);
  const lastDailyClose = dailyClosed[dailyClosed.length - 1].timestamp + DAY;
  return weekly.filter((w) => w.timestamp + WEEK <= lastDailyClose);
}

// 经 candle-cache 拉 1D 全量与 4H 最近 400 根。transport/cacheDir/now 可注入，离线测试用。
async function fetchMarketData(symbol, options = {}) {
  const now = options.now === undefined ? new Date() : options.now;
  const nowSec = nowSeconds(now);
  const base = {
    source: 'binance', transport: options.transport || fetchBinancePage, granularities: BINANCE_GRANULARITIES,
    now: new Date(nowSec * 1000), refresh: Boolean(options.refresh),
    ...(options.cacheDir ? { cacheDir: options.cacheDir } : {}),
    ...(options.retryDelayMs !== undefined ? { retryDelayMs: options.retryDelayMs } : {}),
    ...(options.attempts !== undefined ? { attempts: options.attempts } : {}),
    warn: options.warn || (() => {}),
  };
  const end = new Date(nowSec * 1000);
  const h4Start = new Date((Math.floor(nowSec / H4) * H4 - H4_BARS * H4) * 1000);
  const [dailyRaw, h4Raw] = await Promise.all([
    getCandles(symbol, DAY, 'all', end, base),
    getCandles(symbol, H4, h4Start, end, base),
  ]);
  for (const [label, raw] of [['1D', dailyRaw], ['4H', h4Raw]]) {
    if (raw.fetchErrors && raw.fetchErrors.length) {
      throw new Error(`Binance ${label} K 线 ${raw.fetchErrors.length} 个分页请求失败：${raw.fetchErrors[0].reason}`);
    }
  }
  const dailyClosed = dropUnclosed(dailyRaw, DAY, now);
  const h4Closed = dropUnclosed(h4Raw, H4, now);
  const daily = dailyClosed.filter(finiteBar);
  const h4 = h4Closed.filter(finiteBar);
  if (!daily.length) throw new Error(`${symbol} 没有可用的日线数据（交易对不存在或网络不可达）`);
  return { symbol, fetchedAt: new Date(nowSec * 1000).toISOString(), daily, h4, weekly: synthesizeWeekly(daily), dropped: { daily: dailyClosed.length - daily.length, h4: h4Closed.length - h4.length } };
}

// 合约公开接口：标记价 + 资金费率。任何失败返回 null，不阻断。
async function fetchFuturesPremium(symbol, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetchImpl(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${encodeURIComponent(String(symbol).toUpperCase())}`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'crypto-wave-analyzer', Accept: 'application/json' },
    });
    if (!res || !res.ok) return null;
    const data = await res.json();
    const markPrice = Number(data && data.markPrice);
    if (!Number.isFinite(markPrice) || markPrice <= 0) return null;
    const fundingRate = Number(data.lastFundingRate);
    const nextFundingTime = Number(data.nextFundingTime);
    return {
      markPrice,
      indexPrice: Number.isFinite(Number(data.indexPrice)) ? Number(data.indexPrice) : null,
      fundingRate: Number.isFinite(fundingRate) ? fundingRate : null,
      nextFundingTime: Number.isFinite(nextFundingTime) && nextFundingTime > 0 ? new Date(nextFundingTime).toISOString() : null,
    };
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchMarketData, fetchFuturesPremium, synthesizeWeekly, dropUnclosed };
