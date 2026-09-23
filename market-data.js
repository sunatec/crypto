'use strict';

/**
 * 多市场数据源（add-stock-data-sources）：按代码识别市场，美股走 Twelve Data、A 股走东方财富，
 * 加密货币仍由 analyze-wave-manual.js 的 Coinbase 管道负责（本模块只做识别）。
 *
 * K 线约定（design D2）：股票日线 timestamp = 该交易日的 UTC 零点，日期即交易所本地日期；
 * 输出与 Coinbase 管道同形 { timestamp, timeUtc, open, high, low, close, volume }。
 */

const TWELVE_DATA_API = 'https://api.twelvedata.com/time_series';
const EASTMONEY_KLINE_API = 'https://push2his.eastmoney.com/api/qt/stock/kline/get';
const TWELVE_DATA_MAX = 5000;

const MARKETS = {
  crypto: { source: 'coinbase', tz: null },
  us: { source: 'twelvedata', tz: 'America/New_York', closeHour: 16, tzLabel: '美东' },
  cn: { source: 'eastmoney', tz: 'Asia/Shanghai', closeHour: 15, tzLabel: 'UTC+8' },
};

const SOURCES = ['coinbase', 'twelvedata', 'eastmoney'];

// 市场按代码格式识别（D1）；source 只换数据源，市场仍按代码定（决定时区/收盘/精度）
function detectMarket(product, source) {
  const code = String(product || '').trim();
  let market;
  if (code.includes('-')) market = 'crypto';
  else if (/^\d{6}$/.test(code)) market = 'cn';
  else if (/^[A-Za-z.]+$/.test(code)) market = 'us';
  else throw new Error(`无法识别代码格式：${code}（加密货币如 BTC-USD，A 股如 600519，美股如 AAPL）`);
  if (source != null && !SOURCES.includes(source)) {
    throw new Error(`不支持的数据源：${source}，可选 ${SOURCES.join(' / ')}`);
  }
  return { market, source: source || MARKETS[market].source };
}

// 沪市（主板 6、ETF 5、B 股 9）→ 1.，深市/北交所 → 0.
function eastmoneySecId(code) {
  return /^[569]/.test(code) ? `1.${code}` : `0.${code}`;
}

// 美股 105/106/107 需先查询才能确定交易所，--source eastmoney 时按 NASDAQ(105) 优先依次尝试
const EASTMONEY_US_PREFIXES = ['105', '106', '107'];

// D5：美股 2 位；A 股 ETF/LOF（5、15~18 开头）3 位，其余 2 位
function priceDecimals(market, code) {
  if (market === 'cn') return /^(5|1[5-8])/.test(code) ? 3 : 2;
  if (market === 'us') return 2;
  return null;
}

const ymd = (d) => d.toISOString().slice(0, 10);
const dayTs = (dateStr) => Math.floor(Date.parse(`${dateStr}T00:00:00Z`) / 1000);

function toCandle(dateStr, open, high, low, close, volume) {
  const ts = dayTs(dateStr);
  const vals = [open, high, low, close].map(Number);
  if (!Number.isFinite(ts) || vals.some((v) => !Number.isFinite(v))) return null;
  return {
    timestamp: ts,
    timeUtc: new Date(ts * 1000).toISOString(),
    open: vals[0], high: vals[1], low: vals[2], close: vals[3],
    volume: Number(volume) || 0,
  };
}

// Windows 兜底：东方财富偶发拒绝 Node fetch（"fetch failed"），PowerShell Invoke-WebRequest 可稳定取到
// （与 analyze-etf-stocks.js 同一做法）。仅在真实 fetch 时启用，注入的测试 fetch 不走兜底。
async function powershellGetJson(url, headers) {
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const hdr = Object.entries(headers).map(([k, v]) => `'${k}' = '${String(v).replace(/'/g, "''")}'`).join('; ');
  const command = [
    "$ProgressPreference='SilentlyContinue'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12',
    `$h = @{ ${hdr} }`,
    `(Invoke-WebRequest -Uri '${url.replace(/'/g, "''")}' -Headers $h -UseBasicParsing -TimeoutSec 20).Content`,
  ].join('; ');
  const { stdout } = await promisify(execFile)('powershell', ['-NoProfile', '-Command', command], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 50 });
  return JSON.parse(stdout);
}

async function getJson(url, fetchImpl, headers = {}) {
  const allHeaders = { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json', ...headers };
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetchImpl(url, { headers: allHeaders });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  if (process.platform === 'win32' && fetchImpl === globalThis.fetch) {
    try {
      return await powershellGetJson(url, allHeaders);
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`请求失败 ${url.replace(/apikey=[^&]+/, 'apikey=***')}：${lastErr && lastErr.message}`);
}

/** Twelve Data 日线（adjust=splits）；满 5000 根则向前翻页。 */
async function fetchTwelveData(symbol, start, end, apiKey, fetchImpl = globalThis.fetch) {
  if (!apiKey) {
    throw new Error('美股需要 Twelve Data API key：用 --apikey YOUR_KEY 或设置环境变量 TWELVE_DATA_API_KEY（免费注册 https://twelvedata.com）。'
      + '\n如需改用东方财富，加 --source eastmoney。');
  }
  const byDate = new Map();
  let endDate = ymd(end);
  const startDate = ymd(start);
  for (let page = 0; page < 20; page += 1) {
    const url = new URL(TWELVE_DATA_API);
    url.searchParams.set('symbol', symbol.toUpperCase());
    url.searchParams.set('interval', '1day');
    url.searchParams.set('start_date', startDate);
    url.searchParams.set('end_date', endDate);
    url.searchParams.set('outputsize', String(TWELVE_DATA_MAX));
    url.searchParams.set('adjust', 'splits');
    url.searchParams.set('order', 'ASC');
    url.searchParams.set('apikey', apiKey);
    const data = await getJson(url.toString(), fetchImpl);
    if (data && data.status === 'error') throw new Error(`Twelve Data 错误（${data.code}）：${data.message}`);
    const values = (data && data.values) || [];
    values.forEach((v) => {
      const c = toCandle(String(v.datetime).slice(0, 10), v.open, v.high, v.low, v.close, v.volume);
      if (c) byDate.set(c.timestamp, c);
    });
    if (values.length < TWELVE_DATA_MAX) break;
    const earliest = values.map((v) => String(v.datetime).slice(0, 10)).sort()[0];
    const prev = new Date(`${earliest}T00:00:00Z`);
    prev.setUTCDate(prev.getUTCDate() - 1);
    if (ymd(prev) < startDate) break;
    endDate = ymd(prev);
  }
  return { candles: [...byDate.values()].sort((a, b) => a.timestamp - b.timestamp), name: null };
}

function parseEastmoney(data) {
  const d = data && data.data;
  if (!d || !Array.isArray(d.klines)) return null;
  const candles = [];
  d.klines.forEach((line) => {
    // 字段顺序：date,open,close,high,low,volume（注意 close 在第 3 位）
    const [date, open, close, high, low, volume] = String(line).split(',');
    const c = toCandle(date, open, high, low, close, volume);
    if (c) candles.push(c);
  });
  return { candles: candles.sort((a, b) => a.timestamp - b.timestamp), name: d.name || null };
}

/** 东方财富日线（前复权 fqt=1），返回名称。美股代码按 105/106/107 依次尝试。 */
async function fetchEastmoney(code, market, start, end, fetchImpl = globalThis.fetch) {
  const secids = market === 'us'
    ? EASTMONEY_US_PREFIXES.map((p) => `${p}.${code.toUpperCase()}`)
    : [eastmoneySecId(code)];
  const beg = ymd(start).replace(/-/g, '');
  const fin = ymd(end).replace(/-/g, '');
  for (const secid of secids) {
    const url = `${EASTMONEY_KLINE_API}?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=1&beg=${beg}&end=${fin}&lmt=100000`;
    const parsed = parseEastmoney(await getJson(url, fetchImpl, { Referer: 'https://quote.eastmoney.com/' }));
    if (parsed && parsed.candles.length) return parsed;
  }
  throw new Error(`东方财富无 ${code} 的 K 线数据（secid 试过 ${secids.join(' / ')}）`);
}

// 交易所时区的"现在"：{ date: 'YYYY-MM-DD', hour }
function exchangeNow(tz, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/** D4：最后一根是交易所"今天"且未到收盘 → 剔除。 */
function dropUnclosedBar(candles, market, now = new Date()) {
  const m = MARKETS[market];
  if (!m || !m.tz || !candles.length) return candles;
  const { date, hour } = exchangeNow(m.tz, now);
  const last = candles[candles.length - 1];
  if (last.timeUtc.slice(0, 10) === date && hour < m.closeHour) return candles.slice(0, -1);
  return candles;
}

/** 股票统一入口：取数 → 剔除未收盘 → { candles, name } */
async function fetchStockDaily({ product, market, source, start, end, apiKey, fetchImpl = globalThis.fetch, now = new Date() }) {
  const res = source === 'twelvedata'
    ? await fetchTwelveData(product, start, end, apiKey, fetchImpl)
    : await fetchEastmoney(product, market, start, end, fetchImpl);
  return { candles: dropUnclosedBar(res.candles, market, now), name: res.name };
}

// 按时区格式化 YYYY-MM-DD HH:mm:ss（报告头用）
function fmtTimeInTz(input, tz) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return String(input);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

module.exports = {
  MARKETS,
  detectMarket,
  eastmoneySecId,
  priceDecimals,
  fetchTwelveData,
  fetchEastmoney,
  parseEastmoney,
  dropUnclosedBar,
  exchangeNow,
  fetchStockDaily,
  fmtTimeInTz,
};
