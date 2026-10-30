'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

// granularity(seconds) -> Binance kline interval. Binance natively serves every timeframe
// this tool uses (notably 4h/14400), so no finer-then-aggregate synthesis is needed.
const INTERVAL_BY_GRANULARITY = {
  60: '1m', 180: '3m', 300: '5m', 900: '15m', 1800: '30m',
  3600: '1h', 7200: '2h', 14400: '4h', 21600: '6h', 28800: '8h',
  43200: '12h', 86400: '1d', 259200: '3d', 604800: '1w',
};

const BINANCE_GRANULARITIES = Object.keys(INTERVAL_BY_GRANULARITY).map(Number);

// BTC-USD -> BTCUSDT. Binance spot has almost no true USD pairs, so -USD maps to the USDT quote.
// Already-stable quotes (USDT/USDC/BUSD/FDUSD) are left untouched; use --binance-symbol to override.
function binanceSymbol(product) {
  const p = String(product || '').toUpperCase().replace(/-/g, '');
  if (/(USDT|USDC|BUSD|FDUSD|TUSD|DAI)$/.test(p)) return p;
  return p.replace(/USD$/, 'USDT');
}

async function getJsonWin(url) {
  const command = "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; (Invoke-WebRequest -Uri '"
    + url.replace(/'/g, "''") + "' -Headers @{'User-Agent'='crypto-wave-analyzer'} -UseBasicParsing -TimeoutSec 30).Content";
  const { stdout } = await promisify(execFile)('powershell', ['-NoProfile', '-Command', command], {
    encoding: 'utf8', windowsHide: true, timeout: 35000, maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function getJson(url) {
  if (process.platform === 'win32') return getJsonWin(url);
  const response = await fetch(url, {
    headers: { 'User-Agent': 'crypto-wave-analyzer', Accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Binance HTTP ${response.status}`);
  return response.json();
}

// Page transport only: pagination/persistence belong to candle-cache. Returns rows in the engine's
// canonical order [tsSec, low, high, open, close, volume] (same as the Coinbase transport), so
// candle-cache stays source-agnostic. `product` here is the resolved Binance symbol (e.g. BTCUSDT).
async function fetchBinancePage(product, granularity, start, end, fetchJson = getJson) {
  const interval = INTERVAL_BY_GRANULARITY[granularity];
  if (!interval) throw new Error(`Unsupported Binance granularity ${granularity}`);
  const url = new URL('https://api.binance.com/api/v3/klines');
  url.searchParams.set('symbol', String(product).toUpperCase());
  url.searchParams.set('interval', interval);
  url.searchParams.set('startTime', String(start.getTime()));
  url.searchParams.set('endTime', String(end.getTime() - 1)); // candle-cache treats stop as exclusive
  url.searchParams.set('limit', '1000');
  const rows = await fetchJson(url.toString());
  if (!Array.isArray(rows)) throw new Error('Invalid Binance candle response');
  // Binance kline: [openTimeMs, open, high, low, close, volume, closeTimeMs, ...]
  //   -> engine canonical row [tsSec, low, high, open, close, volume] (Coinbase order).
  return rows.map((k) => [k[0] / 1000, Number(k[3]), Number(k[2]), Number(k[1]), Number(k[4]), Number(k[5])]);
}

// Price precision via exchangeInfo PRICE_FILTER.tickSize (parallel to Coinbase quote_increment).
// Enhancement only: returns null on any failure so the caller falls back to OHLC-inferred precision.
async function fetchBinanceTickSize(symbol, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetchImpl(`https://api.binance.com/api/v3/exchangeInfo?symbol=${encodeURIComponent(String(symbol).toUpperCase())}`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'wave-tree-analyzer/1.0', Accept: 'application/json' },
    });
    if (!res || !res.ok) return null;
    const data = await res.json();
    const sym = data && Array.isArray(data.symbols) && data.symbols[0];
    const priceFilter = sym && Array.isArray(sym.filters) && sym.filters.find((f) => f.filterType === 'PRICE_FILTER');
    const tick = priceFilter && priceFilter.tickSize;
    return Number.isFinite(Number(tick)) && Number(tick) > 0 ? String(tick) : null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  fetchBinancePage,
  fetchBinanceTickSize,
  binanceSymbol,
  BINANCE_GRANULARITIES,
  INTERVAL_BY_GRANULARITY,
};
