'use strict';

const fs = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');

const API_BASE = 'https://api.exchange.coinbase.com/products';
const API_LIMIT = 300;

const TIMEFRAMES = {
  '5m': { fetchGranularity: 300, aggregate: 'none' },
  '1h': { fetchGranularity: 3600, aggregate: 'none' },
  '4h': { fetchGranularity: 3600, aggregate: 'fixed', seconds: 4 * 3600 },
  '1d': { fetchGranularity: 86400, aggregate: 'none' },
  '1w': { fetchGranularity: 86400, aggregate: 'week' },
  '1m': { fetchGranularity: 86400, aggregate: 'month' },
  '1y': { fetchGranularity: 86400, aggregate: 'year' },
};

function parseArgs(argv) {
  const args = {
    product: 'BTC-USD',
    tf: '1h',
    start: null,
    end: 'now',
    out: null,
    report: null,
    html: null,
    lookback: 2,
    atrPeriod: 14,
    atrMultiplier: 1.5,
    rsiPeriod: 14,
    brief: false,
    fullReport: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    const next = argv[i + 1];

    if ((item === '--tf' || item === '--timeframe') && next) {
      args.tf = next.toLowerCase();
      i += 1;
    } else if (item === '--product' && next) {
      args.product = next;
      i += 1;
    } else if (item === '--start' && next) {
      args.start = next;
      i += 1;
    } else if (item === '--end' && next) {
      args.end = next;
      i += 1;
    } else if (item === '--out' && next) {
      args.out = next;
      i += 1;
    } else if (item === '--report' && next) {
      args.report = next;
      i += 1;
    } else if (item === '--html' && next) {
      args.html = next;
      i += 1;
    } else if (item === '--lookback' && next) {
      args.lookback = Number(next);
      i += 1;
    } else if (item === '--atr-period' && next) {
      args.atrPeriod = Number(next);
      i += 1;
    } else if (item === '--atr-multiplier' && next) {
      args.atrMultiplier = Number(next);
      i += 1;
    } else if (item === '--rsi-period' && next) {
      args.rsiPeriod = Number(next);
      i += 1;
    } else if (item === '--brief') {
      args.brief = true;
    } else if (item === '--full-report') {
      args.fullReport = true;
    } else if (item === '--help' || item === '-h') {
      args.help = true;
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  node analyze-kline-wave.js --product BTC-USD --tf 1h --start 2026-02-06T00:00:00+08:00 --end now

Options:
  --product   Trading pair, default BTC-USD
  --tf        5m | 1h | 4h | 1d | 1w | 1m | 1y
  --start     Start time ISO string, default: end - 30d
  --end       End time ISO string or now, default: now
  --out       Output JSON file, default: <product>_<tf>_<start>_<end>.json
  --report    Output markdown file, default: <product>_<tf>_<start>_<end>.md
  --html      Output interactive dashboard HTML, default: <product>_<tf>_<start>_<end>.html
  --lookback  Pivot lookback window, default: 2
  --atr-period      ATR period for pivot noise filter, default: 14
  --atr-multiplier  Min pivot distance = ATR * multiplier, default: 1.5
  --rsi-period      RSI period for momentum-divergence checks, default: 14
  --brief     Only output concise WXY narrative to console (no files)
  --full-report  Output the legacy full markdown report
`);
}

function parseDateInput(value, fallback) {
  if (!value) return fallback;
  if (String(value).toLowerCase() === 'now') return new Date();
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) {
    throw new Error(`Invalid date: ${value}`);
  }
  return dt;
}

function toIsoNoMs(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function toFileTimeTag(date, offsetHours = 8) {
  const shifted = new Date(date.getTime() + offsetHours * 3600 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  const hh = String(shifted.getUTCHours()).padStart(2, '0');
  const mm = String(shifted.getUTCMinutes()).padStart(2, '0');
  return `${y}${m}${d}${hh}${mm}`;
}

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  let lastErr = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25000);

      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'kline-wave-analyzer/1.0',
          Accept: 'application/json',
        },
      });

      clearTimeout(timer);

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Coinbase API error ${res.status}: ${text}`);
      }

      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < 3) await sleep(450 * attempt);
    }
  }

  if (process.platform !== 'win32') throw lastErr;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const escapedUrl = String(url).replace(/'/g, "''");
      const command = [
        "$ProgressPreference='SilentlyContinue'",
        `(Invoke-RestMethod -Uri '${escapedUrl}' -UseBasicParsing -TimeoutSec 30) | ConvertTo-Json -Depth 8 -Compress`,
      ].join('; ');
      const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', command], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024 * 50,
      });
      return JSON.parse(stdout);
    } catch (err) {
      lastErr = err;
      if (attempt < 3) await sleep(700 * attempt);
    }
  }

  const wrapped = new Error(`Failed to fetch Coinbase candles after retries: ${lastErr?.message || String(lastErr)}`);
  wrapped.cause = lastErr;
  throw wrapped;
}

function normalizeRows(rows) {
  const out = [];
  for (const row of rows) {
    if (Array.isArray(row)) {
      out.push(row);
    } else if (row && Array.isArray(row.value)) {
      out.push(row.value);
    }
  }
  return out;
}

async function fetchCandles(product, granularity, start, end) {
  const rows = [];
  const stepMs = granularity * 1000;
  const chunkMs = (API_LIMIT - 1) * stepMs;

  let cursor = start.getTime();
  const endMs = end.getTime();

  while (cursor <= endMs) {
    const chunkEnd = Math.min(cursor + chunkMs, endMs);
    const url = new URL(`${API_BASE}/${product}/candles`);
    url.searchParams.set('granularity', String(granularity));
    url.searchParams.set('start', new Date(cursor).toISOString());
    url.searchParams.set('end', new Date(chunkEnd).toISOString());

    const data = await fetchJson(url.toString());
    rows.push(...normalizeRows(data));

    cursor = chunkEnd + stepMs;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  const dedup = new Map();
  for (const row of rows) {
    dedup.set(row[0], row);
  }

  return Array.from(dedup.values())
    .sort((a, b) => a[0] - b[0])
    .map((row) => ({
      timestamp: Number(row[0]),
      timeUtc: new Date(Number(row[0]) * 1000).toISOString(),
      low: Number(row[1]),
      high: Number(row[2]),
      open: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
    }));
}

function aggregateFixed(candles, seconds) {
  const map = new Map();

  for (const c of candles) {
    const bucket = Math.floor(c.timestamp / seconds) * seconds;
    const prev = map.get(bucket);
    if (!prev) {
      map.set(bucket, {
        timestamp: bucket,
        timeUtc: new Date(bucket * 1000).toISOString(),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      });
    } else {
      prev.high = Math.max(prev.high, c.high);
      prev.low = Math.min(prev.low, c.low);
      prev.close = c.close;
      prev.volume += c.volume;
    }
  }

  return Array.from(map.values()).sort((a, b) => a.timestamp - b.timestamp);
}

function weekStartTs(ts) {
  const d = new Date(ts * 1000);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - day);
  return Math.floor(d.getTime() / 1000);
}

function aggregateCalendar(candles, mode) {
  const map = new Map();

  const keyFn = (ts) => {
    const d = new Date(ts * 1000);
    if (mode === 'week') return `W-${weekStartTs(ts)}`;
    if (mode === 'month') return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    if (mode === 'year') return String(d.getUTCFullYear());
    return String(ts);
  };

  const bucketTsFn = (ts) => {
    if (mode === 'week') return weekStartTs(ts);
    const d = new Date(ts * 1000);
    d.setUTCHours(0, 0, 0, 0);
    if (mode === 'month') d.setUTCDate(1);
    if (mode === 'year') d.setUTCMonth(0, 1);
    return Math.floor(d.getTime() / 1000);
  };

  for (const c of candles) {
    const key = keyFn(c.timestamp);
    const bucketTs = bucketTsFn(c.timestamp);
    const prev = map.get(key);

    if (!prev) {
      map.set(key, {
        timestamp: bucketTs,
        timeUtc: new Date(bucketTs * 1000).toISOString(),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      });
    } else {
      prev.high = Math.max(prev.high, c.high);
      prev.low = Math.min(prev.low, c.low);
      prev.close = c.close;
      prev.volume += c.volume;
    }
  }

  return Array.from(map.values()).sort((a, b) => a.timestamp - b.timestamp);
}

function transformCandles(candles, tfConfig) {
  if (tfConfig.aggregate === 'none') return candles;
  if (tfConfig.aggregate === 'fixed') return aggregateFixed(candles, tfConfig.seconds);
  if (tfConfig.aggregate === 'week') return aggregateCalendar(candles, 'week');
  if (tfConfig.aggregate === 'month') return aggregateCalendar(candles, 'month');
  if (tfConfig.aggregate === 'year') return aggregateCalendar(candles, 'year');
  return candles;
}

function computeATR(candles, period = 14) {
  const p = Math.max(2, Math.floor(period));
  if (candles.length === 0) return [];

  const tr = new Array(candles.length).fill(null);
  tr[0] = Math.abs(candles[0].high - candles[0].low);
  for (let i = 1; i < candles.length; i += 1) {
    const curr = candles[i];
    const prevClose = candles[i - 1].close;
    const hl = Math.abs(curr.high - curr.low);
    const hc = Math.abs(curr.high - prevClose);
    const lc = Math.abs(curr.low - prevClose);
    tr[i] = Math.max(hl, hc, lc);
  }

  const atr = new Array(candles.length).fill(null);
  if (candles.length <= p) return atr;

  let seed = 0;
  for (let i = 1; i <= p; i += 1) seed += tr[i];
  atr[p] = seed / p;
  for (let i = p + 1; i < candles.length; i += 1) {
    atr[i] = ((atr[i - 1] * (p - 1)) + tr[i]) / p;
  }
  return atr;
}

function computeRSI(candles, period = 14) {
  const p = Math.max(2, Math.floor(period));
  if (candles.length === 0) return [];

  const rsi = new Array(candles.length).fill(null);
  if (candles.length <= p) return rsi;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= p; i += 1) {
    const change = candles[i].close - candles[i - 1].close;
    if (change >= 0) gainSum += change;
    else lossSum += Math.abs(change);
  }

  let avgGain = gainSum / p;
  let avgLoss = lossSum / p;
  const firstRs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  rsi[p] = avgLoss === 0 ? 100 : 100 - (100 / (1 + firstRs));

  for (let i = p + 1; i < candles.length; i += 1) {
    const change = candles[i].close - candles[i - 1].close;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    avgGain = ((avgGain * (p - 1)) + gain) / p;
    avgLoss = ((avgLoss * (p - 1)) + loss) / p;
    if (avgLoss === 0) {
      rsi[i] = 100;
      continue;
    }
    const rs = avgGain / avgLoss;
    rsi[i] = 100 - (100 / (1 + rs));
  }
  return rsi;
}

function detectPivots(candles, lookback = 2, options = {}) {
  const atrSeries = options.atrSeries || null;
  const atrMultiplier = Number.isFinite(options.atrMultiplier) ? Number(options.atrMultiplier) : 0;
  if (candles.length < lookback * 2 + 1) return [];
  const pivots = [];

  for (let i = lookback; i < candles.length - lookback; i += 1) {
    const c = candles[i];
    let isHigh = true;
    let isLow = true;

    for (let j = i - lookback; j <= i + lookback; j += 1) {
      if (j === i) continue;
      if (candles[j].high > c.high) isHigh = false;
      if (candles[j].low < c.low) isLow = false;
      if (!isHigh && !isLow) break;
    }

    if (!isHigh && !isLow) continue;

    if (isHigh && isLow) {
      const prev = candles[i - 1];
      const next = candles[i + 1];
      const highStrength = Math.abs(c.high - Math.max(prev.high, next.high));
      const lowStrength = Math.abs(Math.min(prev.low, next.low) - c.low);
      if (highStrength >= lowStrength) {
        pivots.push({ index: i, type: 'H', price: c.high, timestamp: c.timestamp });
      } else {
        pivots.push({ index: i, type: 'L', price: c.low, timestamp: c.timestamp });
      }
    } else if (isHigh) {
      pivots.push({ index: i, type: 'H', price: c.high, timestamp: c.timestamp });
    } else {
      pivots.push({ index: i, type: 'L', price: c.low, timestamp: c.timestamp });
    }
  }

  if (pivots.length === 0) return pivots;

  const cleaned = [pivots[0]];
  for (let i = 1; i < pivots.length; i += 1) {
    const current = pivots[i];
    const last = cleaned[cleaned.length - 1];

    if (current.type === last.type) {
      const shouldReplace =
        (current.type === 'H' && current.price >= last.price) ||
        (current.type === 'L' && current.price <= last.price);
      if (shouldReplace) cleaned[cleaned.length - 1] = current;
    } else {
      cleaned.push(current);
    }
  }

  if (!atrSeries || atrMultiplier <= 0) return cleaned;

  const filtered = [cleaned[0]];
  for (let i = 1; i < cleaned.length; i += 1) {
    const current = cleaned[i];
    const last = filtered[filtered.length - 1];
    const atr = atrSeries[current.index] || atrSeries[last.index] || null;
    const minMove = Number.isFinite(atr) ? atr * atrMultiplier : 0;

    if (current.type === last.type) {
      const shouldReplace =
        (current.type === 'H' && current.price >= last.price) ||
        (current.type === 'L' && current.price <= last.price);
      if (shouldReplace) filtered[filtered.length - 1] = current;
      continue;
    }

    if (minMove <= 0 || Math.abs(current.price - last.price) >= minMove) {
      filtered.push(current);
    }
  }

  return filtered;
}

function inRange(value, min, max) {
  return Number.isFinite(value) && value >= min && value <= max;
}

function checkDownImpulse(p) {
  if (p.length !== 6) return null;
  const okType = p[0].type === 'H' && p[1].type === 'L' && p[2].type === 'H' && p[3].type === 'L' && p[4].type === 'H' && p[5].type === 'L';
  if (!okType) return null;

  const w1 = p[0].price - p[1].price;
  const w3 = p[2].price - p[3].price;
  const w5 = p[4].price - p[5].price;
  const w2 = p[2].price - p[1].price;
  const w4 = p[4].price - p[3].price;
  const w2Retrace = safeRatio(w2, w1);
  const w3Extend = safeRatio(w3, w1);

  const validBase =
    p[1].price < p[0].price &&
    p[2].price < p[0].price &&
    p[3].price < p[1].price &&
    p[4].price < p[2].price &&
    p[5].price < p[3].price &&
    w1 > 0 &&
    w3 > 0 &&
    w5 > 0 &&
    w3 >= Math.min(w1, w5);

  if (!validBase) return null;

  const strictValid =
    p[4].price < p[1].price &&
    w2Retrace > 0 &&
    w2Retrace < 1;

  if (strictValid) {
    return {
      type: 'impulse',
      direction: 'down',
      mode: 'strict',
      points: p,
      lengths: { w1, w2, w3, w4, w5 },
      ratios: { w2Retrace, w3Extend },
    };
  }

  const diagonalValid =
    p[4].price >= p[1].price &&
    p[4].price < p[2].price &&
    p[5].price < p[1].price &&
    w3 < w1 &&
    w5 < w3 &&
    w4 < w2;

  if (!diagonalValid) return null;
  return {
    type: 'impulse',
    direction: 'down',
    mode: 'diagonal',
    points: p,
    lengths: { w1, w2, w3, w4, w5 },
    ratios: { w2Retrace, w3Extend },
  };
}

function checkUpImpulse(p) {
  if (p.length !== 6) return null;
  const okType = p[0].type === 'L' && p[1].type === 'H' && p[2].type === 'L' && p[3].type === 'H' && p[4].type === 'L' && p[5].type === 'H';
  if (!okType) return null;

  const w1 = p[1].price - p[0].price;
  const w3 = p[3].price - p[2].price;
  const w5 = p[5].price - p[4].price;
  const w2 = p[1].price - p[2].price;
  const w4 = p[3].price - p[4].price;
  const w2Retrace = safeRatio(w2, w1);
  const w3Extend = safeRatio(w3, w1);

  const validBase =
    p[1].price > p[0].price &&
    p[2].price > p[0].price &&
    p[3].price > p[1].price &&
    p[4].price > p[2].price &&
    p[5].price > p[3].price &&
    w1 > 0 &&
    w3 > 0 &&
    w5 > 0 &&
    w3 >= Math.min(w1, w5);

  if (!validBase) return null;

  const strictValid =
    p[4].price > p[1].price &&
    w2Retrace > 0 &&
    w2Retrace < 1;

  if (strictValid) {
    return {
      type: 'impulse',
      direction: 'up',
      mode: 'strict',
      points: p,
      lengths: { w1, w2, w3, w4, w5 },
      ratios: { w2Retrace, w3Extend },
    };
  }

  const diagonalValid =
    p[4].price <= p[1].price &&
    p[4].price > p[2].price &&
    p[5].price > p[1].price &&
    w3 < w1 &&
    w5 < w3 &&
    w4 < w2;

  if (!diagonalValid) return null;
  return {
    type: 'impulse',
    direction: 'up',
    mode: 'diagonal',
    points: p,
    lengths: { w1, w2, w3, w4, w5 },
    ratios: { w2Retrace, w3Extend },
  };
}

function checkDownWave4(p) {
  if (p.length !== 5) return null;
  const okType = p[0].type === 'H' && p[1].type === 'L' && p[2].type === 'H' && p[3].type === 'L' && p[4].type === 'H';
  if (!okType) return null;

  const w1 = p[0].price - p[1].price;
  const w2 = p[2].price - p[1].price;
  const w3 = p[2].price - p[3].price;
  const w4 = p[4].price - p[3].price;
  const w2Retrace = safeRatio(w2, w1);
  const w3Extend = safeRatio(w3, w1);
  const w4Retrace = safeRatio(w4, w3);

  const validBase =
    p[1].price < p[0].price &&
    p[2].price < p[0].price &&
    p[3].price < p[1].price &&
    p[4].price < p[2].price &&
    w1 > 0 &&
    w3 > 0;

  if (!validBase) return null;

  const strictValid =
    p[4].price < p[1].price &&
    w2Retrace > 0 &&
    w2Retrace < 1 &&
    w4Retrace > 0 &&
    w4Retrace < 1;

  if (strictValid) {
    return {
      type: 'impulse_building',
      direction: 'down',
      mode: 'strict',
      points: p,
      lengths: { w1, w2, w3, w4 },
      ratios: { w2Retrace, w3Extend, w4Retrace },
    };
  }

  const diagonalValid =
    p[4].price >= p[1].price &&
    p[4].price < p[2].price &&
    w3 < w1 &&
    w4 < w2;

  if (!diagonalValid) return null;
  return {
    type: 'impulse_building',
    direction: 'down',
    mode: 'diagonal',
    points: p,
    lengths: { w1, w2, w3, w4 },
    ratios: { w2Retrace, w3Extend, w4Retrace },
  };
}

function checkUpWave4(p) {
  if (p.length !== 5) return null;
  const okType = p[0].type === 'L' && p[1].type === 'H' && p[2].type === 'L' && p[3].type === 'H' && p[4].type === 'L';
  if (!okType) return null;

  const w1 = p[1].price - p[0].price;
  const w2 = p[1].price - p[2].price;
  const w3 = p[3].price - p[2].price;
  const w4 = p[3].price - p[4].price;
  const w2Retrace = safeRatio(w2, w1);
  const w3Extend = safeRatio(w3, w1);
  const w4Retrace = safeRatio(w4, w3);

  const validBase =
    p[1].price > p[0].price &&
    p[2].price > p[0].price &&
    p[3].price > p[1].price &&
    p[4].price > p[2].price &&
    w1 > 0 &&
    w3 > 0;

  if (!validBase) return null;

  const strictValid =
    p[4].price > p[1].price &&
    w2Retrace > 0 &&
    w2Retrace < 1 &&
    w4Retrace > 0 &&
    w4Retrace < 1;

  if (strictValid) {
    return {
      type: 'impulse_building',
      direction: 'up',
      mode: 'strict',
      points: p,
      lengths: { w1, w2, w3, w4 },
      ratios: { w2Retrace, w3Extend, w4Retrace },
    };
  }

  const diagonalValid =
    p[4].price <= p[1].price &&
    p[4].price > p[2].price &&
    w3 < w1 &&
    w4 < w2;

  if (!diagonalValid) return null;
  return {
    type: 'impulse_building',
    direction: 'up',
    mode: 'diagonal',
    points: p,
    lengths: { w1, w2, w3, w4 },
    ratios: { w2Retrace, w3Extend, w4Retrace },
  };
}

// 检测：仅有3个点（1/2浪完成，第3浪或C浪运行中）
function checkDownWave3_Building(p) {
  if (p.length !== 3) return null;
  const okType = p[0].type === 'H' && p[1].type === 'L' && p[2].type === 'H';
  if (!okType) return null;

  const w1 = p[0].price - p[1].price;
  const w2 = p[2].price - p[1].price;
  const retrace = safeRatio(w2, w1);

  const valid = w1 > 0 && w2 > 0 && p[2].price < p[0].price && inRange(retrace, 0.146, 0.886);
  if (!valid) return null;
  return {
    type: 'wave3_building',
    direction: 'down',
    points: p,
    lengths: { w1, w2 },
    ratios: { retrace },
  };
}

function checkUpWave3_Building(p) {
  if (p.length !== 3) return null;
  const okType = p[0].type === 'L' && p[1].type === 'H' && p[2].type === 'L';
  if (!okType) return null;

  const w1 = p[1].price - p[0].price;
  const w2 = p[1].price - p[2].price;
  const retrace = safeRatio(w2, w1);

  const valid = w1 > 0 && w2 > 0 && p[2].price > p[0].price && inRange(retrace, 0.146, 0.886);
  if (!valid) return null;
  return {
    type: 'wave3_building',
    direction: 'up',
    points: p,
    lengths: { w1, w2 },
    ratios: { retrace },
  };
}

// 检测：仅有4个点（1/2/3浪完成，第4浪运行中）
function checkDownWave4_Building(p) {
  if (p.length !== 4) return null;
  const okType = p[0].type === 'H' && p[1].type === 'L' && p[2].type === 'H' && p[3].type === 'L';
  if (!okType) return null;

  const w1 = p[0].price - p[1].price;
  const w2 = p[2].price - p[1].price;
  const w3 = p[2].price - p[3].price;
  const retrace = safeRatio(w2, w1);
  const w3Extend = safeRatio(w3, w1);

  const valid =
    w1 > 0 &&
    w2 > 0 &&
    w3 > 0 &&
    p[2].price < p[0].price &&
    p[3].price < p[1].price;
  if (!valid) return null;
  return {
    type: 'wave4_building',
    direction: 'down',
    points: p,
    lengths: { w1, w2, w3 },
    ratios: { retrace, w3Extend },
  };
}

function checkUpWave4_Building(p) {
  if (p.length !== 4) return null;
  const okType = p[0].type === 'L' && p[1].type === 'H' && p[2].type === 'L' && p[3].type === 'H';
  if (!okType) return null;

  const w1 = p[1].price - p[0].price;
  const w2 = p[1].price - p[2].price;
  const w3 = p[3].price - p[2].price;
  const retrace = safeRatio(w2, w1);
  const w3Extend = safeRatio(w3, w1);

  const valid =
    w1 > 0 &&
    w2 > 0 &&
    w3 > 0 &&
    p[2].price > p[0].price &&
    p[3].price > p[1].price;
  if (!valid) return null;
  return {
    type: 'wave4_building',
    direction: 'up',
    points: p,
    lengths: { w1, w2, w3 },
    ratios: { retrace, w3Extend },
  };
}

function checkDownABC(p) {
  if (p.length !== 4) return null;
  const okType = p[0].type === 'H' && p[1].type === 'L' && p[2].type === 'H' && p[3].type === 'L';
  if (!okType) return null;

  const a = p[0].price - p[1].price;
  const b = p[2].price - p[1].price;
  const c = p[2].price - p[3].price;
  // B may exceed the start of A in an expanded flat. Subtype-specific
  // constraints are applied later, after inspecting the internal waves.
  const valid = a > 0 && b > 0 && c > 0 && p[3].price < p[2].price;

  if (!valid) return null;
  return { type: 'abc', direction: 'down', points: p, lengths: { a, b, c } };
}

function checkUpABC(p) {
  if (p.length !== 4) return null;
  const okType = p[0].type === 'L' && p[1].type === 'H' && p[2].type === 'L' && p[3].type === 'H';
  if (!okType) return null;

  const a = p[1].price - p[0].price;
  const b = p[1].price - p[2].price;
  const c = p[3].price - p[2].price;
  // B may exceed the start of A in an expanded flat.
  const valid = a > 0 && b > 0 && c > 0 && p[3].price > p[2].price;

  if (!valid) return null;
  return { type: 'abc', direction: 'up', points: p, lengths: { a, b, c } };
}

function checkDownWXY(p) {
  if (p.length !== 10) return null;
  const okType =
    p[0].type === 'H' && p[1].type === 'L' &&
    p[2].type === 'H' && p[3].type === 'L' &&
    p[4].type === 'H' && p[5].type === 'L' &&
    p[6].type === 'H' && p[7].type === 'L' &&
    p[8].type === 'H' && p[9].type === 'L';
  if (!okType) return null;

  const w = checkDownABC(p.slice(0, 4));
  const x = checkUpABC(p.slice(3, 7));
  const y = checkDownABC(p.slice(6, 10));
  if (!w || !x || !y) return null;

  const wNet = p[0].price - p[3].price;
  const xNet = p[6].price - p[3].price;
  const yNet = p[6].price - p[9].price;
  const xRetrace = safeRatio(xNet, wNet);
  const yOverW = safeRatio(yNet, wNet);

  const valid =
    wNet > 0 &&
    xNet > 0 &&
    yNet > 0 &&
    p[9].price < p[3].price &&
    p[6].price < p[0].price &&
    inRange(xRetrace, 0.1, 1.0) &&
    inRange(yOverW, 0.382, 2.5);

  if (!valid) return null;
  return {
    type: 'wxy',
    direction: 'down',
    points: p,
    lengths: { w: wNet, x: xNet, y: yNet },
    ratios: { xRetrace, yOverW },
  };
}

function checkUpWXY(p) {
  if (p.length !== 10) return null;
  const okType =
    p[0].type === 'L' && p[1].type === 'H' &&
    p[2].type === 'L' && p[3].type === 'H' &&
    p[4].type === 'L' && p[5].type === 'H' &&
    p[6].type === 'L' && p[7].type === 'H' &&
    p[8].type === 'L' && p[9].type === 'H';
  if (!okType) return null;

  const w = checkUpABC(p.slice(0, 4));
  const x = checkDownABC(p.slice(3, 7));
  const y = checkUpABC(p.slice(6, 10));
  if (!w || !x || !y) return null;

  const wNet = p[3].price - p[0].price;
  const xNet = p[3].price - p[6].price;
  const yNet = p[9].price - p[6].price;
  const xRetrace = safeRatio(xNet, wNet);
  const yOverW = safeRatio(yNet, wNet);

  const valid =
    wNet > 0 &&
    xNet > 0 &&
    yNet > 0 &&
    p[9].price > p[3].price &&
    p[6].price > p[0].price &&
    inRange(xRetrace, 0.1, 1.0) &&
    inRange(yOverW, 0.382, 2.5);

  if (!valid) return null;
  return {
    type: 'wxy',
    direction: 'up',
    points: p,
    lengths: { w: wNet, x: xNet, y: yNet },
    ratios: { xRetrace, yOverW },
  };
}

function comparePatternPriority(a, b) {
  if (b.endIndex !== a.endIndex) return b.endIndex - a.endIndex;
  return (b.score || 0) - (a.score || 0);
}

function detectPatterns(pivots, options = {}) {
  const scale = options.scale || 'base';
  const candidates = [];

  for (let i = 0; i <= pivots.length - 10; i += 1) {
    const segment = pivots.slice(i, i + 10);
    const down = checkDownWXY(segment);
    const up = checkUpWXY(segment);

    if (down) candidates.push({ ...down, endIndex: i + 9, score: 280 + i, scale });
    if (up) candidates.push({ ...up, endIndex: i + 9, score: 280 + i, scale });
  }

  for (let i = 0; i <= pivots.length - 6; i += 1) {
    const segment = pivots.slice(i, i + 6);
    const down = checkDownImpulse(segment);
    const up = checkUpImpulse(segment);

    if (down) candidates.push({ ...down, endIndex: i + 5, score: 360 + i, scale });
    if (up) candidates.push({ ...up, endIndex: i + 5, score: 360 + i, scale });
  }

  for (let i = 0; i <= pivots.length - 5; i += 1) {
    const segment = pivots.slice(i, i + 5);
    const down = checkDownWave4(segment);
    const up = checkUpWave4(segment);

    if (down) candidates.push({ ...down, endIndex: i + 4, score: 300 + i, scale });
    if (up) candidates.push({ ...up, endIndex: i + 4, score: 300 + i, scale });
  }

  for (let i = 0; i <= pivots.length - 4; i += 1) {
    const segment = pivots.slice(i, i + 4);
    const down = checkDownABC(segment);
    const up = checkUpABC(segment);

    if (down) candidates.push({ ...down, endIndex: i + 3, score: 220 + i, scale });
    if (up) candidates.push({ ...up, endIndex: i + 3, score: 220 + i, scale });
  }

  for (let i = 0; i <= pivots.length - 4; i += 1) {
    const segment = pivots.slice(i, i + 4);
    const down = checkDownWave4_Building(segment);
    const up = checkUpWave4_Building(segment);

    if (down) candidates.push({ ...down, endIndex: i + 3, score: 200 + i, scale });
    if (up) candidates.push({ ...up, endIndex: i + 3, score: 200 + i, scale });
  }

  for (let i = 0; i <= pivots.length - 3; i += 1) {
    const segment = pivots.slice(i, i + 3);
    const down = checkDownWave3_Building(segment);
    const up = checkUpWave3_Building(segment);

    if (down) candidates.push({ ...down, endIndex: i + 2, score: 160 + i, scale });
    if (up) candidates.push({ ...up, endIndex: i + 2, score: 160 + i, scale });
  }

  if (candidates.length === 0) return { primary: null, alternatives: [], candidates: [] };

  candidates.sort(comparePatternPriority);

  return {
    primary: candidates[0],
    alternatives: candidates.slice(1, 5),
    candidates,
  };
}

function patternSignature(pattern) {
  const mode = pattern.mode || 'normal';
  const points = pattern.points
    .map((p) => `${p.type}:${p.timestamp}:${Number(p.price).toFixed(2)}`)
    .join('|');
  return `${pattern.type}|${pattern.direction}|${mode}|${points}`;
}

function mergePatternCandidates(candidateGroups) {
  const bestBySignature = new Map();
  for (const group of candidateGroups) {
    for (const candidate of group) {
      const key = patternSignature(candidate);
      const prev = bestBySignature.get(key);
      if (!prev || comparePatternPriority(candidate, prev) < 0) {
        bestBySignature.set(key, candidate);
      }
    }
  }
  return Array.from(bestBySignature.values()).sort(comparePatternPriority);
}

function fibRetrace(high, low) {
  const d = high - low;
  return {
    l236: high - d * 0.236,
    l382: high - d * 0.382,
    l500: high - d * 0.5,
    l618: high - d * 0.618,
  };
}

const REPORT_TZ_OFFSET_HOURS = 8;
const REPORT_TZ_LABEL = 'UTC+8';

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function safeRatio(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  return numerator / denominator;
}

function formatRatio(value) {
  if (!Number.isFinite(value)) return 'n/a';
  return Number(value).toFixed(3);
}

function computeAlternationScore(pattern) {
  if (!pattern || (pattern.type !== 'impulse' && pattern.type !== 'impulse_building')) return 0.5;

  const points = pattern.points;
  if (!Array.isArray(points) || points.length < 5) return 0.5;

  const p0 = points[0];
  const p1 = points[1];
  const p2 = points[2];
  const p3 = points[3];
  const p4 = points[4];

  const w1 = Math.abs(p1.price - p0.price);
  const w3 = Math.abs(p3.price - p2.price);
  if (w1 <= 0 || w3 <= 0) return 0.5;

  const retrace2 = Math.abs(safeRatio(p1.price - p2.price, w1) || 0);
  const retrace4 = Math.abs(safeRatio(p3.price - p4.price, w3) || 0);
  const retraceDiff = Math.abs(retrace2 - retrace4);
  const retraceAlternation = clamp(retraceDiff / 0.5, 0, 1);

  const time2 = Math.max(1, p2.index - p1.index);
  const time4 = Math.max(1, p4.index - p3.index);
  const timeSimilarity = Math.min(time2, time4) / Math.max(time2, time4);
  const timeAlternation = clamp(1 - timeSimilarity, 0, 1);

  // 价格回撤交替优先级更高，时间交替作为辅助。
  return clamp(retraceAlternation * 0.7 + timeAlternation * 0.3, 0, 1);
}

function calcLegVolume(candles, fromIndex, toIndex) {
  if (!Array.isArray(candles) || candles.length === 0) return { sum: 0, avg: 0, count: 0 };
  const start = Math.max(0, Math.min(fromIndex, toIndex));
  const end = Math.min(candles.length - 1, Math.max(fromIndex, toIndex));
  let sum = 0;
  let count = 0;
  for (let i = start; i <= end; i += 1) {
    sum += Number(candles[i].volume) || 0;
    count += 1;
  }
  return { sum, avg: count > 0 ? sum / count : 0, count };
}

function getVolumeConfirmationScore(pattern, candles) {
  if (!pattern || !Array.isArray(candles) || candles.length === 0) return 0.5;

  if (pattern.type === 'impulse') {
    const points = pattern.points;
    if (!points || points.length < 6) return 0.5;

    const v1 = calcLegVolume(candles, points[0].index, points[1].index).avg;
    const v2 = calcLegVolume(candles, points[1].index, points[2].index).avg;
    const v3 = calcLegVolume(candles, points[2].index, points[3].index).avg;
    const v4 = calcLegVolume(candles, points[3].index, points[4].index).avg;
    const v5 = calcLegVolume(candles, points[4].index, points[5].index).avg;

    let score = 0.5;
    if (v3 > v1 && v4 < v3) score = 1.0;
    else if (v3 >= v1 * 0.9) score = 0.65;
    else score = 0.25;

    if (v2 < v1) score += 0.08;
    if (v5 <= v3) score += 0.07;
    return clamp(score, 0, 1);
  }

  if (pattern.type === 'impulse_building') {
    const points = pattern.points;
    if (!points || points.length < 5) return 0.5;

    const v1 = calcLegVolume(candles, points[0].index, points[1].index).avg;
    const v2 = calcLegVolume(candles, points[1].index, points[2].index).avg;
    const v3 = calcLegVolume(candles, points[2].index, points[3].index).avg;
    const v4 = calcLegVolume(candles, points[3].index, points[4].index).avg;

    let score = 0.5;
    if (v3 > v1 && v4 < v3) score = 0.95;
    else if (v3 >= v1 * 0.85) score = 0.62;
    else score = 0.28;
    if (v2 < v1) score += 0.08;
    return clamp(score, 0, 1);
  }

  if (pattern.type === 'abc' || pattern.type === 'wxy') {
    // 调整浪通常表现为缩量，C/Y 末端再放量。
    const points = pattern.points;
    if (!points || points.length < 4) return 0.5;
    const first = calcLegVolume(candles, points[0].index, points[1].index).avg;
    const mid = calcLegVolume(candles, points[1].index, points[2].index).avg;
    const last = calcLegVolume(candles, points[points.length - 2].index, points[points.length - 1].index).avg;
    const contraction = mid < first ? 0.6 : 0.45;
    const terminal = last >= mid ? 0.4 : 0.25;
    return clamp(contraction + terminal, 0, 1);
  }

  return 0.5;
}

function getTimeSymmetryScore(pattern) {
  if (!pattern || !pattern.points || pattern.points.length < 4) return 0.5;

  if (pattern.type === 'impulse') {
    const p = pattern.points;
    const t1 = Math.max(1, p[1].index - p[0].index);
    const t2 = Math.max(1, p[2].index - p[1].index);
    const t3 = Math.max(1, p[3].index - p[2].index);
    const t4 = Math.max(1, p[4].index - p[3].index);
    const t5 = Math.max(1, p[5].index - p[4].index);
    const t4t2 = t4 / t2;
    const tBalance = inRange(t4t2, 0.2, 5.0) ? 1 : 0.35;
    const wave3Time = t3 >= Math.min(t1, t5) ? 1 : 0.35;
    return clamp(tBalance * 0.6 + wave3Time * 0.4, 0, 1);
  }

  if (pattern.type === 'impulse_building') {
    const p = pattern.points;
    const t2 = Math.max(1, p[2].index - p[1].index);
    const t4 = Math.max(1, p[4].index - p[3].index);
    const ratio = t4 / t2;
    return inRange(ratio, 0.2, 5.0) ? 1 : 0.35;
  }

  if (pattern.type === 'abc') {
    const p = pattern.points;
    const ta = Math.max(1, p[1].index - p[0].index);
    const tc = Math.max(1, p[3].index - p[2].index);
    const ratio = tc / ta;
    return inRange(ratio, 0.236, 4.236) ? 0.9 : 0.45;
  }

  if (pattern.type === 'wxy') {
    const p = pattern.points;
    const tw = Math.max(1, p[3].index - p[0].index);
    const ty = Math.max(1, p[9].index - p[6].index);
    const ratio = ty / tw;
    return inRange(ratio, 0.236, 4.236) ? 0.9 : 0.45;
  }

  return 0.5;
}

function getMomentumDivergenceScore(pattern, indicators) {
  if (!pattern || pattern.type !== 'impulse') {
    return { score: 0.5, state: 'n/a' };
  }
  const rsiSeries = indicators?.rsiSeries || null;
  if (!rsiSeries) return { score: 0.5, state: 'n/a' };

  const p = pattern.points;
  if (!p || p.length < 6) return { score: 0.5, state: 'n/a' };

  const rsi3 = rsiSeries[p[3].index];
  const rsi5 = rsiSeries[p[5].index];
  if (!Number.isFinite(rsi3) || !Number.isFinite(rsi5)) return { score: 0.5, state: 'n/a' };

  if (pattern.direction === 'up') {
    const divergence = p[5].price > p[3].price && rsi5 < rsi3;
    return {
      score: divergence ? 0.95 : 0.45,
      state: divergence ? 'bearish_divergence' : 'no_divergence',
    };
  }

  const divergence = p[5].price < p[3].price && rsi5 > rsi3;
  return {
    score: divergence ? 0.95 : 0.45,
    state: divergence ? 'bullish_divergence' : 'no_divergence',
  };
}

function getPivotsInRange(pivots, fromIndex, toIndex) {
  if (!Array.isArray(pivots) || pivots.length === 0) return [];
  const start = Math.min(fromIndex, toIndex);
  const end = Math.max(fromIndex, toIndex);
  return pivots
    .filter((p) => p.index >= start && p.index <= end)
    .sort((a, b) => a.index - b.index || a.timestamp - b.timestamp);
}

function buildSegmentPivots(sourcePivots, fromPoint, toPoint) {
  const segment = getPivotsInRange(sourcePivots, fromPoint.index, toPoint.index).slice();
  const upsertBoundary = (point) => {
    const exists = segment.some((p) => p.index === point.index && p.type === point.type);
    if (!exists) segment.push(point);
  };
  upsertBoundary(fromPoint);
  upsertBoundary(toPoint);
  segment.sort((a, b) => a.index - b.index || a.timestamp - b.timestamp);

  // 清理同类连续枢轴，防止子浪检测被噪音枢轴干扰。
  const cleaned = [];
  for (const p of segment) {
    if (cleaned.length === 0) {
      cleaned.push(p);
      continue;
    }
    const last = cleaned[cleaned.length - 1];
    if (last.type !== p.type) {
      cleaned.push(p);
      continue;
    }
    const shouldReplace =
      (p.type === 'H' && p.price >= last.price) ||
      (p.type === 'L' && p.price <= last.price);
    if (shouldReplace) cleaned[cleaned.length - 1] = p;
  }
  return cleaned;
}

function hasDirectionalSubstructure(segmentPivots, direction, structureType) {
  if (!Array.isArray(segmentPivots) || segmentPivots.length === 0) return false;

  if (structureType === 'impulse') {
    if (segmentPivots.length < 6) return false;
    for (let i = 0; i <= segmentPivots.length - 6; i += 1) {
      const seg = segmentPivots.slice(i, i + 6);
      const hit = direction === 'up' ? checkUpImpulse(seg) : checkDownImpulse(seg);
      if (hit) return true;
    }
    return false;
  }

  if (structureType === 'abc') {
    if (segmentPivots.length < 4) return false;
    for (let i = 0; i <= segmentPivots.length - 4; i += 1) {
      const seg = segmentPivots.slice(i, i + 4);
      const hit = direction === 'up' ? checkUpABC(seg) : checkDownABC(seg);
      if (hit) return true;
    }
    return false;
  }

  return false;
}

function analyzeLegSubwaves(sourcePivots, fromPoint, toPoint, direction) {
  const segment = buildSegmentPivots(sourcePivots, fromPoint, toPoint);
  const swingCount = Math.max(0, segment.length - 1);
  const impulseLike = hasDirectionalSubstructure(segment, direction, 'impulse');
  const abcLike = hasDirectionalSubstructure(segment, direction, 'abc');
  return {
    swingCount,
    impulseLike,
    abcLike,
    pivotCount: segment.length,
  };
}

function evaluateFractalValidation(pattern, context = null) {
  if (!pattern || !context?.pivotsMicro || !Array.isArray(context.pivotsMicro)) return 0.5;

  if (pattern.type === 'impulse') {
    const [p0, p1, p2, p3, p4, p5] = pattern.points;
    const trend = pattern.direction;
    const counter = trend === 'up' ? 'down' : 'up';

    const w1 = analyzeLegSubwaves(context.pivotsMicro, p0, p1, trend);
    const w2 = analyzeLegSubwaves(context.pivotsMicro, p1, p2, counter);
    const w3 = analyzeLegSubwaves(context.pivotsMicro, p2, p3, trend);
    const w4 = analyzeLegSubwaves(context.pivotsMicro, p3, p4, counter);
    const w5 = analyzeLegSubwaves(context.pivotsMicro, p4, p5, trend);

    // 第3浪是分形校验核心，内部不是5浪时重罚。
    const w3Score = w3.impulseLike ? 1 : (w3.swingCount >= 5 ? 0.45 : 0.05);
    const w1Score = w1.impulseLike ? 1 : (w1.swingCount >= 5 ? 0.5 : 0.2);
    const w5Score = w5.impulseLike ? 1 : (w5.swingCount >= 5 ? 0.5 : 0.2);
    const w2Score = w2.abcLike ? 1 : (w2.swingCount >= 3 ? 0.55 : 0.2);
    const w4Score = w4.abcLike ? 1 : (w4.swingCount >= 3 ? 0.55 : 0.2);

    return clamp(
      w3Score * 0.45
      + w1Score * 0.17
      + w5Score * 0.17
      + w2Score * 0.105
      + w4Score * 0.105,
      0,
      1,
    );
  }

  if (pattern.type === 'impulse_building') {
    const [p0, p1, p2, p3, p4] = pattern.points;
    const trend = pattern.direction;
    const counter = trend === 'up' ? 'down' : 'up';
    const w1 = analyzeLegSubwaves(context.pivotsMicro, p0, p1, trend);
    const w2 = analyzeLegSubwaves(context.pivotsMicro, p1, p2, counter);
    const w3 = analyzeLegSubwaves(context.pivotsMicro, p2, p3, trend);
    const w4 = analyzeLegSubwaves(context.pivotsMicro, p3, p4, counter);
    const w3Score = w3.impulseLike ? 1 : (w3.swingCount >= 5 ? 0.4 : 0.05);
    const w1Score = w1.impulseLike ? 1 : (w1.swingCount >= 5 ? 0.5 : 0.2);
    const w2Score = w2.abcLike ? 1 : (w2.swingCount >= 3 ? 0.55 : 0.2);
    const w4Score = w4.abcLike ? 1 : (w4.swingCount >= 3 ? 0.55 : 0.2);
    return clamp(w3Score * 0.5 + w1Score * 0.2 + w2Score * 0.15 + w4Score * 0.15, 0, 1);
  }

  if (pattern.type === 'abc') {
    const [p0, p1, p2, p3] = pattern.points;
    const trend = pattern.direction;
    const counter = trend === 'up' ? 'down' : 'up';
    const a = analyzeLegSubwaves(context.pivotsMicro, p0, p1, trend);
    const b = analyzeLegSubwaves(context.pivotsMicro, p1, p2, counter);
    const c = analyzeLegSubwaves(context.pivotsMicro, p2, p3, trend);
    const aScore = a.impulseLike ? 1 : (a.abcLike ? 0.65 : 0.35);
    const bScore = b.abcLike ? 1 : (b.swingCount >= 3 ? 0.6 : 0.3);
    const cScore = c.impulseLike ? 1 : (c.swingCount >= 5 ? 0.6 : 0.3);
    return clamp(aScore * 0.34 + bScore * 0.33 + cScore * 0.33, 0, 1);
  }

  return 0.5;
}

function computeImpulseChannelScore(pattern) {
  if (!pattern || pattern.type !== 'impulse' || !Array.isArray(pattern.points) || pattern.points.length < 6) return 0.5;
  const [p0, p1, p2, p3, p4, p5] = pattern.points;

  const baseStart = p2;
  const baseEnd = p4;
  const dx = baseEnd.index - baseStart.index;
  if (dx <= 0) return 0.5;

  const slope = (baseEnd.price - baseStart.price) / dx;
  const proj = (anchor, targetIndex) => anchor.price + slope * (targetIndex - anchor.index);

  const scale = Math.max(
    1,
    Math.abs(p1.price - p0.price),
    Math.abs(p3.price - p2.price),
    Math.abs(p5.price - p4.price),
  );

  if (pattern.direction === 'up') {
    const upperFrom1At3 = proj(p1, p3.index);
    const upperFrom1At5 = proj(p1, p5.index);
    const upperFrom3At5 = proj(p3, p5.index);
    const targetUpper = (upperFrom1At5 + upperFrom3At5) / 2;
    const parallelError = Math.abs(p3.price - upperFrom1At3);
    const touchError = Math.abs(p5.price - targetUpper);
    const railDrift = Math.abs(upperFrom1At5 - upperFrom3At5);
    const parallelScore = clamp(1 - parallelError / (scale * 0.7), 0, 1);
    const touchScore = clamp(1 - touchError / (scale * 0.7), 0, 1);
    const driftScore = clamp(1 - railDrift / (scale * 0.8), 0, 1);
    return clamp(parallelScore * 0.35 + touchScore * 0.45 + driftScore * 0.2, 0, 1);
  }

  const lowerFrom1At3 = proj(p1, p3.index);
  const lowerFrom1At5 = proj(p1, p5.index);
  const lowerFrom3At5 = proj(p3, p5.index);
  const targetLower = (lowerFrom1At5 + lowerFrom3At5) / 2;
  const parallelError = Math.abs(p3.price - lowerFrom1At3);
  const touchError = Math.abs(p5.price - targetLower);
  const railDrift = Math.abs(lowerFrom1At5 - lowerFrom3At5);
  const parallelScore = clamp(1 - parallelError / (scale * 0.7), 0, 1);
  const touchScore = clamp(1 - touchError / (scale * 0.7), 0, 1);
  const driftScore = clamp(1 - railDrift / (scale * 0.8), 0, 1);
  return clamp(parallelScore * 0.35 + touchScore * 0.45 + driftScore * 0.2, 0, 1);
}

function computeFibClusterInfo(pattern) {
  if (!pattern || pattern.type !== 'impulse' || !pattern.lengths || !Array.isArray(pattern.points) || pattern.points.length < 6) {
    return null;
  }

  const [p0, p1, p2, p3, p4, p5] = pattern.points;
  const { w1, w3 } = pattern.lengths;
  const w4 = pattern.direction === 'up' ? p3.price - p4.price : p4.price - p3.price;
  if (!Number.isFinite(w1) || !Number.isFinite(w3) || !Number.isFinite(w4) || w1 <= 0 || w3 <= 0 || w4 <= 0) return null;

  const targets = pattern.direction === 'up'
    ? [p4.price + w1, p4.price + w3 * 0.618, p4.price + w4 * 1.272]
    : [p4.price - w1, p4.price - w3 * 0.618, p4.price - w4 * 1.272];

  const mean = targets.reduce((acc, v) => acc + v, 0) / targets.length;
  const variance = targets.reduce((acc, v) => acc + (v - mean) ** 2, 0) / targets.length;
  const std = Math.sqrt(variance);
  const actual = p5.price;
  const scale = Math.max(1, Math.abs(w1), Math.abs(w3), Math.abs(w4));

  const tightness = clamp(1 - std / (scale * 0.45), 0, 1);
  const meanHit = clamp(1 - Math.abs(actual - mean) / (scale * 0.55), 0, 1);
  const targetHit = targets
    .map((t) => clamp(1 - Math.abs(actual - t) / (scale * 0.65), 0, 1))
    .reduce((acc, v) => acc + v, 0) / targets.length;

  const score = clamp(tightness * 0.35 + meanHit * 0.4 + targetHit * 0.25, 0, 1);
  return { score, targets, mean, std, actual };
}

function detectImpulseInSegment(segmentPivots, direction) {
  if (!Array.isArray(segmentPivots) || segmentPivots.length < 6) return null;
  let best = null;
  for (let i = 0; i <= segmentPivots.length - 6; i += 1) {
    const seg = segmentPivots.slice(i, i + 6);
    const hit = direction === 'up' ? checkUpImpulse(seg) : checkDownImpulse(seg);
    if (!hit) continue;
    if (!best || comparePatternPriority(hit, best) < 0) best = hit;
  }
  return best;
}

function calcSegmentRunningTotal(segmentPivots) {
  if (!Array.isArray(segmentPivots) || segmentPivots.length === 0) return 0;
  let hi = -Infinity;
  let lo = Infinity;
  for (const p of segmentPivots) {
    hi = Math.max(hi, Number(p.price));
    lo = Math.min(lo, Number(p.price));
  }
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return 0;
  return Math.max(0, hi - lo);
}

function calcLargestSubwavePrice(segmentPivots) {
  if (!Array.isArray(segmentPivots) || segmentPivots.length < 2) return 0;
  let maxLen = 0;
  for (let i = 1; i < segmentPivots.length; i += 1) {
    const len = Math.abs(Number(segmentPivots[i].price) - Number(segmentPivots[i - 1].price));
    if (Number.isFinite(len)) maxLen = Math.max(maxLen, len);
  }
  return maxLen;
}

function scoreNear(value, target, tolerance) {
  if (!Number.isFinite(value) || !Number.isFinite(target) || !Number.isFinite(tolerance) || tolerance <= 0) return 0;
  return clamp(1 - Math.abs(value - target) / tolerance, 0, 1);
}

function evaluateSingleZigzag(pattern, context = null) {
  if (!pattern || pattern.type !== 'abc' || !pattern.lengths || !Array.isArray(pattern.points) || pattern.points.length < 4) {
    return null;
  }

  const [p0, p1, p2, p3] = pattern.points;
  const { a, b, c } = pattern.lengths;
  const trend = pattern.direction;
  const counter = trend === 'up' ? 'down' : 'up';
  const sourcePivots = Array.isArray(context?.pivotsMicro) ? context.pivotsMicro : pattern.points;

  const segA = buildSegmentPivots(sourcePivots, p0, p1);
  const segB = buildSegmentPivots(sourcePivots, p1, p2);
  const segC = buildSegmentPivots(sourcePivots, p2, p3);

  const aImpulse = detectImpulseInSegment(segA, trend);
  const cImpulse = detectImpulseInSegment(segC, trend);
  const bLeg = analyzeLegSubwaves(sourcePivots, p1, p2, counter);
  const bCorrective = bLeg.abcLike || !bLeg.impulseLike;

  const bOverA = Math.abs(safeRatio(b, a) || 0);
  const cOverB = Math.abs(safeRatio(c, b) || 0);
  const cOverA = Math.abs(safeRatio(c, a) || 0);

  const aTime = Math.max(1, Math.abs(p1.index - p0.index));
  const bTime = Math.max(1, Math.abs(p2.index - p1.index));
  const cTime = Math.max(1, Math.abs(p3.index - p2.index));
  const bOverATime = bTime / aTime;
  const cOverATime = cTime / aTime;
  const cOverBTime = cTime / bTime;

  const aRunningTotal = calcSegmentRunningTotal(segA);
  const bRunningTotal = calcSegmentRunningTotal(segB);
  const cRunningTotal = calcSegmentRunningTotal(segC);
  const bLargestSubwave = calcLargestSubwavePrice(segB);
  const cLargestSubwave = calcLargestSubwavePrice(segC);

  const aMode = aImpulse?.mode || 'unknown';
  const cMode = cImpulse?.mode || 'unknown';
  const aFailure = aImpulse ? Math.abs(safeRatio(aImpulse.lengths?.w5, aImpulse.lengths?.w3) || 0) < 0.45 : false;
  const cFailure = cImpulse ? Math.abs(safeRatio(cImpulse.lengths?.w5, cImpulse.lengths?.w3) || 0) < 0.45 : false;

  const hardRules = {
    structure_a_impulse_or_diagonal: Boolean(aImpulse),
    structure_b_corrective: bCorrective,
    structure_c_impulse_or_diagonal: Boolean(cImpulse),
    structure_if_a_diagonal_c_not_diagonal: !(aMode === 'diagonal' && cMode === 'diagonal'),
    structure_no_double_fifth_failure: !(aFailure && cFailure),
    ratio_b_over_a_0_2_to_1_0: inRange(bOverA, 0.2, 1.0),
    ratio_b_total_not_exceed_a_total: bRunningTotal <= aRunningTotal + 1e-8,
    ratio_b_not_break_a_start: trend === 'up' ? p2.price > p0.price : p2.price < p0.price,
    ratio_c_over_b_0_9_to_5: inRange(cOverB, 0.9, 5),
    ratio_c_over_a_lt_5: cOverA < 5,
    time_b_lt_10a: bOverATime <= 10,
    time_c_lt_10a: cOverATime <= 10,
    time_c_lt_10b: cOverBTime <= 10,
  };

  const hardEntries = Object.entries(hardRules);
  const hardPassCount = hardEntries.filter(([, ok]) => ok).length;
  const hardScore = hardPassCount / hardEntries.length;
  const hardValid = hardEntries.every(([, ok]) => ok);

  const guideScores = {
    guide_b_not_near_a_start: clamp((1 - bOverA) / 0.5, 0, 1),
    guide_b_largest_subwave_lt_a_total: clamp(1 - safeRatio(bLargestSubwave, aRunningTotal || 1), 0, 1),
    guide_c_largest_subwave_lt_a_total: clamp(1 - safeRatio(cLargestSubwave, aRunningTotal || 1), 0, 1),
    guide_b_ratio_common: Math.max(
      scoreNear(bOverA, 0.382, 0.25),
      scoreNear(bOverA, 0.5, 0.25),
      scoreNear(bOverA, 0.618, 0.25),
    ),
    guide_c_ratio_common: Math.max(
      scoreNear(cOverA, 1.0, 0.45),
      scoreNear(cOverA, 0.618, 0.38),
      scoreNear(cOverA, 1.618, 0.55),
    ),
    guide_c_not_far_over_1618: clamp(1 - Math.max(0, (cOverA - 1.618) / 1.2), 0, 1),
    guide_failed_c_case: inRange(cOverB, 0.9, 1.0) ? 0.7 : 0.45,
    guide_time_b_0_618_to_1_618: inRange(bOverATime, 0.618, 1.618) ? 1 : 0.35,
    guide_time_c_window: inRange(cTime, aTime * 0.618, Math.min(aTime, bTime) * 1.618) ? 1 : 0.35,
  };

  const guideValues = Object.values(guideScores);
  const guideScore = guideValues.reduce((acc, v) => acc + v, 0) / guideValues.length;
  const score = hardValid
    ? clamp(hardScore * 0.68 + guideScore * 0.32, 0, 1)
    : clamp(hardScore * 0.55 + guideScore * 0.2, 0, 0.62);

  return {
    hardValid,
    hardScore,
    guideScore,
    score,
    failedHardRules: hardEntries.filter(([, ok]) => !ok).map(([k]) => k),
    bOverA,
    cOverB,
    cOverA,
    bOverATime,
    cOverATime,
    cOverBTime,
    aRunningTotal,
    bRunningTotal,
    cRunningTotal,
    bLargestSubwave,
    cLargestSubwave,
  };
}

function classifyCorrectionStructure(pattern, context = null) {
  if (!pattern) return { subtype: 'unknown', label: '未分类', score: 0.5 };
  if (pattern.type === 'wxy') return { subtype: 'complex', label: '复杂调整（WXY）', score: 0.85 };
  if (pattern.type !== 'abc') return { subtype: 'n/a', label: 'n/a', score: 0.5 };

  const [p0, p1, p2, p3] = pattern.points;
  const { a, b, c } = pattern.lengths;
  const bOverA = Math.abs(safeRatio(b, a) || 0);
  const cOverA = Math.abs(safeRatio(c, a) || 0);
  const sourcePivots = Array.isArray(context?.pivotsMicro) ? context.pivotsMicro : null;

  let legA = null;
  let legB = null;
  if (sourcePivots) {
    const trend = pattern.direction;
    const counter = trend === 'up' ? 'down' : 'up';
    legA = analyzeLegSubwaves(sourcePivots, p0, p1, trend);
    legB = analyzeLegSubwaves(sourcePivots, p1, p2, counter);
  }

  const aFiveLike = legA ? legA.impulseLike || legA.swingCount >= 5 : bOverA < 0.786;
  const aThreeLike = legA ? legA.abcLike || legA.swingCount <= 4 : bOverA >= 0.786;
  const bThreeLike = legB ? legB.abcLike || (legB.swingCount >= 3 && legB.swingCount <= 4) : true;
  const zigzagValidation = evaluateSingleZigzag(pattern, context);

  const zigzag = aFiveLike && bThreeLike && bOverA <= 0.786 && cOverA >= 0.618 && Boolean(zigzagValidation?.hardValid);
  if (zigzag) {
    const retraceFit = clamp(1 - bOverA / 0.786, 0, 1);
    return {
      subtype: 'zigzag',
      label: '锯齿形（Zigzag 5-3-5）',
      score: clamp((0.48 + retraceFit * 0.15) + (zigzagValidation?.score || 0.6) * 0.37, 0, 1),
      legA,
      legB,
      zigzagValidation,
    };
  }

  const flat = aThreeLike && bThreeLike && bOverA >= 0.786 && bOverA <= 1.236 && cOverA >= 0.618;
  if (flat) {
    const retraceCenter = clamp(1 - Math.abs(bOverA - 1) / 0.3, 0, 1);
    return {
      subtype: 'flat',
      label: '平台形（Flat 3-3-5）',
      score: clamp(0.7 + retraceCenter * 0.3, 0, 1),
      legA,
      legB,
      zigzagValidation,
    };
  }

  return {
    subtype: 'complex',
    label: '复杂调整（Complex）',
    score: clamp(0.5 + (zigzagValidation?.score || 0.5) * 0.1, 0, 1),
    legA,
    legB,
    zigzagValidation,
  };
}

function validatePatternHardRules(pattern, context = null) {
  if (!pattern) return false;

  const sourcePivots = Array.isArray(context?.pivotsMicro) ? context.pivotsMicro : [];
  const hasFinerStructure = pattern.points.some((point, index) => (
    index > 0
    && sourcePivots.some((pivot) => (
      pivot.index > pattern.points[index - 1].index
      && pivot.index < point.index
    ))
  ));

  // A candidate detected on the finest available pivot scale cannot prove its
  // own subdivisions. Preserve it as unverified instead of treating missing
  // lower-degree data as a failed Elliott rule.
  if (!hasFinerStructure) return true;

  const validateAbc = (abcPattern) => {
    if (!abcPattern || sourcePivots.length === 0) return false;
    const correction = classifyCorrectionStructure(abcPattern, context);
    if (correction.subtype === 'zigzag') return Boolean(correction.zigzagValidation?.hardValid);
    if (correction.subtype !== 'flat') return false;

    const [p0, p1, p2, p3] = abcPattern.points;
    const trend = abcPattern.direction;
    const counter = trend === 'up' ? 'down' : 'up';
    const a = analyzeLegSubwaves(sourcePivots, p0, p1, trend);
    const b = analyzeLegSubwaves(sourcePivots, p1, p2, counter);
    const c = analyzeLegSubwaves(sourcePivots, p2, p3, trend);
    return a.abcLike && b.abcLike && c.impulseLike;
  };

  if (pattern.type === 'impulse') {
    if (sourcePivots.length === 0) return false;
    const trend = pattern.direction;
    const counter = trend === 'up' ? 'down' : 'up';
    const legs = pattern.points.slice(0, -1).map((from, index) => (
      analyzeLegSubwaves(
        sourcePivots,
        from,
        pattern.points[index + 1],
        index % 2 === 0 ? trend : counter,
      )
    ));

    if (pattern.mode === 'diagonal') {
      // Ending diagonals are 3-3-3-3-3. Leading diagonals may have motive
      // actionary legs, but their reactionary waves must still be corrective.
      return legs.every((leg, index) => (
        index % 2 === 0 ? (leg.abcLike || leg.impulseLike) : leg.abcLike
      ));
    }

    return legs[0].impulseLike
      && legs[1].abcLike
      && legs[2].impulseLike
      && legs[3].abcLike
      && legs[4].impulseLike;
  }

  if (pattern.type === 'abc') {
    return validateAbc(pattern);
  }

  if (pattern.type === 'wxy') {
    const w = pattern.direction === 'up'
      ? checkUpABC(pattern.points.slice(0, 4))
      : checkDownABC(pattern.points.slice(0, 4));
    const x = pattern.direction === 'up'
      ? checkDownABC(pattern.points.slice(3, 7))
      : checkUpABC(pattern.points.slice(3, 7));
    const y = pattern.direction === 'up'
      ? checkUpABC(pattern.points.slice(6, 10))
      : checkDownABC(pattern.points.slice(6, 10));
    return validateAbc(w) && validateAbc(x) && validateAbc(y);
  }

  return true;
}

function computePatternQuality(pattern, candles, indicators = null, context = null) {
  if (!pattern) return 0;
  const volumeScore = getVolumeConfirmationScore(pattern, candles);
  const timeScore = getTimeSymmetryScore(pattern);
  const fractalScore = evaluateFractalValidation(pattern, context);
  const channelScore = computeImpulseChannelScore(pattern);
  const fibClusterInfo = computeFibClusterInfo(pattern);
  const clusterScore = fibClusterInfo ? fibClusterInfo.score : 0.5;
  const correctionInfo = classifyCorrectionStructure(pattern, context);

  if (pattern.type === 'impulse') {
    const { w1, w3, w5 } = pattern.lengths;
    const w3OverW1 = Math.abs(safeRatio(w3, w1) || 0);
    const w5OverW1 = Math.abs(safeRatio(w5, w1) || 0);
    const wave3Quality = clamp(w3OverW1 / 1.618, 0, 1);
    const wave5Quality = clamp(w5OverW1 / 1.2, 0, 1);
    const alternation = computeAlternationScore(pattern);
    const momentum = getMomentumDivergenceScore(pattern, indicators).score;
    const diagonalPenalty = pattern.mode === 'diagonal' ? 0.88 : 1;
    return clamp(
      (
        wave3Quality * 0.11
        + wave5Quality * 0.06
        + alternation * 0.08
        + volumeScore * 0.1
        + timeScore * 0.06
        + momentum * 0.06
        + fractalScore * 0.17
        + channelScore * 0.14
        + clusterScore * 0.22
      )
      * diagonalPenalty,
      0,
      1,
    );
  }

  if (pattern.type === 'impulse_building') {
    const { w1, w3 } = pattern.lengths;
    const w3OverW1 = Math.abs(safeRatio(w3, w1) || 0);
    const wave3Quality = clamp(w3OverW1 / 1.618, 0, 1);
    const alternation = computeAlternationScore(pattern);
    const diagonalPenalty = pattern.mode === 'diagonal' ? 0.9 : 1;
    return clamp(
      (wave3Quality * 0.18 + alternation * 0.12 + volumeScore * 0.2 + timeScore * 0.14 + fractalScore * 0.36)
      * diagonalPenalty,
      0,
      1,
    );
  }

  if (pattern.type === 'wave3_building') {
    const { w1, w2 } = pattern.lengths;
    const retrace = Math.abs(safeRatio(w2, w1) || 0);
    const retraceQuality = clamp(1 - Math.abs(retrace - 0.5) / 0.45, 0, 1);
    return clamp(retraceQuality * 0.55 + volumeScore * 0.2 + timeScore * 0.15 + fractalScore * 0.1, 0, 1);
  }

  if (pattern.type === 'wave4_building') {
    const { w1, w3 } = pattern.lengths;
    const w3Extend = Math.abs(safeRatio(w3, w1) || 0);
    const w3Quality = clamp(w3Extend / 1.618, 0, 1);
    return clamp(w3Quality * 0.5 + volumeScore * 0.2 + timeScore * 0.15 + fractalScore * 0.15, 0, 1);
  }

  if (pattern.type === 'wxy') {
    const { w, x, y } = pattern.lengths;
    const xOverW = Math.abs(safeRatio(x, w) || 0);
    const yOverW = Math.abs(safeRatio(y, w) || 0);
    const xQuality = clamp(1 - Math.abs(xOverW - 0.5) / 0.8, 0, 1);
    const yQualityBy1 = clamp(1 - Math.abs(yOverW - 1.0) / 0.9, 0, 1);
    const yQualityBy1618 = clamp(1 - Math.abs(yOverW - 1.618) / 1.0, 0, 1);
    const priceQuality = clamp(xQuality * 0.35 + Math.max(yQualityBy1, yQualityBy1618) * 0.65, 0, 1);
    return clamp(priceQuality * 0.42 + volumeScore * 0.22 + timeScore * 0.2 + correctionInfo.score * 0.16, 0, 1);
  }

  const { a, b, c } = pattern.lengths;
  const bOverA = Math.abs(safeRatio(b, a) || 0);
  const cOverA = Math.abs(safeRatio(c, a) || 0);
  const bQuality = clamp(1 - Math.abs(bOverA - 0.5) / 0.8, 0, 1);
  const cQualityBy1 = clamp(1 - Math.abs(cOverA - 1) / 0.8, 0, 1);
  const cQualityBy1618 = clamp(1 - Math.abs(cOverA - 1.618) / 0.9, 0, 1);
  const priceQuality = clamp(bQuality * 0.4 + Math.max(cQualityBy1, cQualityBy1618) * 0.6, 0, 1);
  return clamp(
    priceQuality * 0.35
    + volumeScore * 0.18
    + timeScore * 0.12
    + correctionInfo.score * 0.25
    + fractalScore * 0.1,
    0,
    1,
  );
}

function computeScenarioScore(pattern, candles, last, indicators = null, context = null) {
  if (!pattern) return 0;
  const endPoint = pattern.points[pattern.points.length - 1];
  const barBase = Math.max(1, candles.length - 1);
  const recency = clamp(endPoint.index / barBase, 0, 1);
  const quality = computePatternQuality(pattern, candles, indicators, context);
  const barsSinceEnd = Math.max(0, candles.length - 1 - endPoint.index);
  const freshness = clamp(1 - barsSinceEnd / Math.max(15, candles.length * 0.45), 0, 1);
  const proximityScale = Math.max(1, Math.abs(endPoint.price) * 0.15);
  const priceProximity = clamp(1 - Math.abs(last.close - endPoint.price) / proximityScale, 0, 1);
  const momentum = getMomentumDivergenceScore(pattern, indicators).score;
  if (pattern.type === 'impulse' || pattern.type === 'impulse_building') {
    const fractalScore = evaluateFractalValidation(pattern, context);
    const clusterScore = computeFibClusterInfo(pattern)?.score ?? 0.5;
    return Number((
      recency * 22
      + quality * 28
      + freshness * 12
      + priceProximity * 8
      + momentum * 6
      + fractalScore * 12
      + clusterScore * 12
    ).toFixed(1));
  }
  return Number((recency * 30 + quality * 38 + freshness * 16 + priceProximity * 10 + momentum * 6).toFixed(1));
}

function buildWaveLegs(pattern, candles = null, indicators = null) {
  if (!pattern?.points || pattern.points.length < 2) return [];

  const legs = [];
  const addLeg = (name, from, to) => {
    const volume = Array.isArray(candles) ? calcLegVolume(candles, from.index, to.index) : { sum: 0, avg: 0 };
    const rsiSeries = indicators?.rsiSeries || null;
    legs.push({
      name,
      from,
      to,
      change: to.price - from.price,
      bars: Math.max(0, to.index - from.index),
      volumeSum: volume.sum,
      volumeAvg: volume.avg,
      rsiFrom: rsiSeries ? rsiSeries[from.index] : null,
      rsiTo: rsiSeries ? rsiSeries[to.index] : null,
    });
  };

  if (pattern.type === 'impulse') {
    const labels = pattern.direction === 'down'
      ? ['1浪（下跌）', '2浪（反弹）', '3浪（下跌）', '4浪（反弹）', '5浪（下跌）']
      : ['1浪（上涨）', '2浪（回调）', '3浪（上涨）', '4浪（回调）', '5浪（上涨）'];
    for (let i = 0; i < 5; i += 1) {
      addLeg(labels[i], pattern.points[i], pattern.points[i + 1]);
    }
    return legs;
  }

  if (pattern.type === 'impulse_building') {
    const labels = pattern.direction === 'down'
      ? ['1浪（下跌）', '2浪（反弹）', '3浪（下跌）', '4浪（反弹）']
      : ['1浪（上涨）', '2浪（回调）', '3浪（上涨）', '4浪（回调）'];
    for (let i = 0; i < 4; i += 1) {
      addLeg(labels[i], pattern.points[i], pattern.points[i + 1]);
    }
    return legs;
  }

  if (pattern.type === 'wave3_building') {
    const labels = pattern.direction === 'down'
      ? ['1浪（下跌）', '2浪（反弹）']
      : ['1浪（上涨）', '2浪（回调）'];
    for (let i = 0; i < 2; i += 1) {
      addLeg(labels[i], pattern.points[i], pattern.points[i + 1]);
    }
    return legs;
  }

  if (pattern.type === 'wave4_building') {
    const labels = pattern.direction === 'down'
      ? ['1浪（下跌）', '2浪（反弹）', '3浪（下跌）']
      : ['1浪（上涨）', '2浪（回调）', '3浪（上涨）'];
    for (let i = 0; i < 3; i += 1) {
      addLeg(labels[i], pattern.points[i], pattern.points[i + 1]);
    }
    return legs;
  }

  if (pattern.type === 'wxy') {
    const labels = pattern.direction === 'down'
      ? ['W-A（下跌）', 'W-B（反弹）', 'W-C（下跌）', 'X-A（反弹）', 'X-B（回调）', 'X-C（反弹）', 'Y-A（下跌）', 'Y-B（反弹）', 'Y-C（下跌）']
      : ['W-A（上涨）', 'W-B（回调）', 'W-C（上涨）', 'X-A（回调）', 'X-B（反弹）', 'X-C（回调）', 'Y-A（上涨）', 'Y-B（回调）', 'Y-C（上涨）'];
    for (let i = 0; i < 9; i += 1) {
      addLeg(labels[i], pattern.points[i], pattern.points[i + 1]);
    }
    return legs;
  }

  const labels = pattern.direction === 'down'
    ? ['A浪（下跌）', 'B浪（反弹）', 'C浪（下跌）']
    : ['A浪（上涨）', 'B浪（回调）', 'C浪（上涨）'];
  for (let i = 0; i < 3; i += 1) {
    addLeg(labels[i], pattern.points[i], pattern.points[i + 1]);
  }
  return legs;
}

function buildScenario(pattern, candles, last, indicators = null, context = null) {
  if (!pattern) return null;

  const endPoint = pattern.points[pattern.points.length - 1];
  const barsSinceEnd = Math.max(0, candles.length - 1 - endPoint.index);
  const momentumInfo = getMomentumDivergenceScore(pattern, indicators);
  const fractalScore = evaluateFractalValidation(pattern, context);
  const channelScore = computeImpulseChannelScore(pattern);
  const fibClusterInfo = computeFibClusterInfo(pattern);
  const correctionInfo = classifyCorrectionStructure(pattern, context);
  const scenario = {
    title: patternTitle(pattern),
    patternType: pattern.type,
    direction: pattern.direction,
    bias: pattern.direction === 'down' ? '偏空' : '偏多',
    stage: '结构仍在演化中',
    currentWave: '浪位待确认',
    confidenceScore: computeScenarioScore(pattern, candles, last, indicators, context),
    barsSinceEnd,
    mode: pattern.mode || 'normal',
    scale: pattern.scale || 'base',
    correctionSubtype: correctionInfo.subtype,
    pivots: pattern.points,
    waveLegs: buildWaveLegs(pattern, candles, indicators),
    momentumState: momentumInfo.state,
    invalidation: null,
    confirmation: null,
    keyLevels: [],
    targets: [],
    metrics: [],
  };

  if (pattern.type === 'impulse' && pattern.direction === 'down') {
    const [p0, p1, p2, p3, p4, p5] = pattern.points;
    const { w1, w3, w5 } = pattern.lengths;
    const retrace = fibRetrace(p0.price, p5.price);
    const alternation = computeAlternationScore(pattern);
    const modeNote = pattern.mode === 'diagonal'
      ? '（倾斜三角形结构，允许4浪与1浪重叠）'
      : '';

    scenario.stage = last.timestamp > p5.timestamp && last.close > p5.price
      ? '5浪下跌后反弹阶段（可能转入修正浪）'
      : `下跌推动浪运行中（倾向第5浪延伸）${modeNote}`;
    scenario.currentWave = last.timestamp > p5.timestamp && last.close > p5.price
      ? '5浪结束后的反弹修正'
      : '第5浪下跌';
    scenario.invalidation = { name: '失效点', value: p4.price, note: '有效上破第4浪高点，当前下跌推动浪计数失效' };
    scenario.confirmation = { name: '延续确认位', value: p5.price, note: '有效跌破第5浪低点，偏向继续下行' };
    scenario.keyLevels.push(
      { name: '第4浪高点', value: p4.price, note: '短线空头失效边界' },
      { name: '第5浪低点', value: p5.price, note: '当前结构关键支撑' },
      { name: '0.618反弹阻力', value: retrace.l618, note: '反弹常见强阻力区' },
    );
    scenario.targets.push(
      { name: '下行目标 0.618xW1', value: p5.price - w1 * 0.618, note: '第5浪延伸的保守目标' },
      { name: '下行目标 1.0xW1', value: p5.price - w1, note: '第5浪常见等长目标' },
      { name: '反弹阻力 0.382', value: retrace.l382, note: '若进入反弹，先看0.382回撤' },
      { name: '反弹阻力 0.5', value: retrace.l500, note: '若反弹增强，关注0.5回撤' },
    );
    scenario.metrics.push(
      { name: 'W3/W1', value: formatRatio(safeRatio(w3, w1)) },
      { name: 'W5/W1', value: formatRatio(safeRatio(w5, w1)) },
      { name: 'W2回撤幅度', value: formatRatio(safeRatio(p2.price - p1.price, w1)) },
      { name: 'W4回撤幅度', value: formatRatio(safeRatio(p4.price - p3.price, w3)) },
      { name: '交替原则得分', value: formatRatio(alternation) },
      { name: '动能背离', value: scenario.momentumState },
    );
    if (scenario.waveLegs.length >= 5) {
      scenario.metrics.push(
        { name: 'V3/V1', value: formatRatio(safeRatio(scenario.waveLegs[2].volumeAvg, scenario.waveLegs[0].volumeAvg)) },
        { name: 'V4/V3', value: formatRatio(safeRatio(scenario.waveLegs[3].volumeAvg, scenario.waveLegs[2].volumeAvg)) },
      );
    }
  } else if (pattern.type === 'impulse' && pattern.direction === 'up') {
    const [p0, p1, p2, p3, p4, p5] = pattern.points;
    const { w1, w3, w5 } = pattern.lengths;
    const retrace = fibRetrace(p5.price, p0.price);
    const alternation = computeAlternationScore(pattern);
    const modeNote = pattern.mode === 'diagonal'
      ? '（倾斜三角形结构，允许4浪与1浪重叠）'
      : '';

    scenario.stage = last.timestamp > p5.timestamp && last.close < p5.price
      ? '5浪上涨后回撤阶段（可能转入修正浪）'
      : `上涨推动浪运行中（倾向第5浪延伸）${modeNote}`;
    scenario.currentWave = last.timestamp > p5.timestamp && last.close < p5.price
      ? '5浪结束后的回撤修正'
      : '第5浪上涨';
    scenario.invalidation = { name: '失效点', value: p4.price, note: '有效跌破第4浪低点，当前上涨推动浪计数失效' };
    scenario.confirmation = { name: '延续确认位', value: p5.price, note: '有效突破第5浪高点，偏向继续上行' };
    scenario.keyLevels.push(
      { name: '第4浪低点', value: p4.price, note: '短线多头失效边界' },
      { name: '第5浪高点', value: p5.price, note: '当前结构关键压力' },
      { name: '0.618回撤支撑', value: retrace.l618, note: '回撤常见强支撑区' },
    );
    scenario.targets.push(
      { name: '上行目标 0.618xW1', value: p5.price + w1 * 0.618, note: '第5浪延伸的保守目标' },
      { name: '上行目标 1.0xW1', value: p5.price + w1, note: '第5浪常见等长目标' },
      { name: '回撤支撑 0.382', value: retrace.l382, note: '若进入回撤，先看0.382回撤' },
      { name: '回撤支撑 0.5', value: retrace.l500, note: '若回撤增强，关注0.5回撤' },
    );
    scenario.metrics.push(
      { name: 'W3/W1', value: formatRatio(safeRatio(w3, w1)) },
      { name: 'W5/W1', value: formatRatio(safeRatio(w5, w1)) },
      { name: 'W2回撤幅度', value: formatRatio(safeRatio(p1.price - p2.price, w1)) },
      { name: 'W4回撤幅度', value: formatRatio(safeRatio(p3.price - p4.price, w3)) },
      { name: '交替原则得分', value: formatRatio(alternation) },
      { name: '动能背离', value: scenario.momentumState },
    );
    if (scenario.waveLegs.length >= 5) {
      scenario.metrics.push(
        { name: 'V3/V1', value: formatRatio(safeRatio(scenario.waveLegs[2].volumeAvg, scenario.waveLegs[0].volumeAvg)) },
        { name: 'V4/V3', value: formatRatio(safeRatio(scenario.waveLegs[3].volumeAvg, scenario.waveLegs[2].volumeAvg)) },
      );
    }
  } else if (pattern.type === 'impulse_building' && pattern.direction === 'down') {
    const [p0, p1, p2, p3, p4] = pattern.points;
    const { w1, w3 } = pattern.lengths;
    const modeNote = pattern.mode === 'diagonal'
      ? '（倾斜三角形构建中，允许4浪与1浪重叠）'
      : '';
    const alternation = computeAlternationScore(pattern);

    scenario.stage = `1-2-3-4 已完成，等待第5浪下跌确认${modeNote}`;
    scenario.currentWave = last.close < p3.price ? '第5浪可能已启动' : '第4浪回调末端';
    scenario.invalidation = { name: '失效点', value: p4.price, note: '若反弹上破4浪高点，5浪下跌预期减弱' };
    scenario.confirmation = { name: '启动确认位', value: p3.price, note: '有效跌破3浪低点后，5浪下跌概率提升' };
    scenario.keyLevels.push(
      { name: '第4浪高点', value: p4.price, note: '5浪预期失效边界' },
      { name: '第3浪低点', value: p3.price, note: '5浪启动确认位' },
      { name: '第2浪高点', value: p2.price, note: '下跌过程中的次级阻力' },
    );
    scenario.targets.push(
      { name: '第5浪预估 0.618xW1', value: p4.price - w1 * 0.618, note: '保守目标' },
      { name: '第5浪预估 1.0xW1', value: p4.price - w1, note: '常见等长目标' },
      { name: '第5浪预估 1.272xW1', value: p4.price - w1 * 1.272, note: '扩展目标' },
    );
    scenario.metrics.push(
      { name: 'W3/W1', value: formatRatio(safeRatio(w3, w1)) },
      { name: 'W2回撤幅度', value: formatRatio(safeRatio(p2.price - p1.price, w1)) },
      { name: 'W4回撤幅度', value: formatRatio(safeRatio(p4.price - p3.price, w3)) },
      { name: '交替原则得分', value: formatRatio(alternation) },
    );
    if (scenario.waveLegs.length >= 4) {
      scenario.metrics.push(
        { name: 'V3/V1', value: formatRatio(safeRatio(scenario.waveLegs[2].volumeAvg, scenario.waveLegs[0].volumeAvg)) },
        { name: 'V4/V3', value: formatRatio(safeRatio(scenario.waveLegs[3].volumeAvg, scenario.waveLegs[2].volumeAvg)) },
      );
    }
  } else if (pattern.type === 'impulse_building' && pattern.direction === 'up') {
    const [p0, p1, p2, p3, p4] = pattern.points;
    const { w1, w3 } = pattern.lengths;
    const modeNote = pattern.mode === 'diagonal'
      ? '（倾斜三角形构建中，允许4浪与1浪重叠）'
      : '';
    const alternation = computeAlternationScore(pattern);

    scenario.stage = `1-2-3-4 已完成，等待第5浪上涨确认${modeNote}`;
    scenario.currentWave = last.close > p3.price ? '第5浪可能已启动' : '第4浪回调末端';
    scenario.invalidation = { name: '失效点', value: p4.price, note: '若回落跌破4浪低点，5浪上涨预期减弱' };
    scenario.confirmation = { name: '启动确认位', value: p3.price, note: '有效突破3浪高点后，5浪上涨概率提升' };
    scenario.keyLevels.push(
      { name: '第4浪低点', value: p4.price, note: '5浪预期失效边界' },
      { name: '第3浪高点', value: p3.price, note: '5浪启动确认位' },
      { name: '第2浪低点', value: p2.price, note: '上涨过程中的次级支撑' },
    );
    scenario.targets.push(
      { name: '第5浪预估 0.618xW1', value: p4.price + w1 * 0.618, note: '保守目标' },
      { name: '第5浪预估 1.0xW1', value: p4.price + w1, note: '常见等长目标' },
      { name: '第5浪预估 1.272xW1', value: p4.price + w1 * 1.272, note: '扩展目标' },
    );
    scenario.metrics.push(
      { name: 'W3/W1', value: formatRatio(safeRatio(w3, w1)) },
      { name: 'W2回撤幅度', value: formatRatio(safeRatio(p1.price - p2.price, w1)) },
      { name: 'W4回撤幅度', value: formatRatio(safeRatio(p3.price - p4.price, w3)) },
      { name: '交替原则得分', value: formatRatio(alternation) },
    );
    if (scenario.waveLegs.length >= 4) {
      scenario.metrics.push(
        { name: 'V3/V1', value: formatRatio(safeRatio(scenario.waveLegs[2].volumeAvg, scenario.waveLegs[0].volumeAvg)) },
        { name: 'V4/V3', value: formatRatio(safeRatio(scenario.waveLegs[3].volumeAvg, scenario.waveLegs[2].volumeAvg)) },
      );
    }
  } else if (pattern.type === 'wave3_building') {
    const [p0, p1, p2] = pattern.points;
    const { w1 } = pattern.lengths;
    const isDown = pattern.direction === 'down';

    scenario.stage = '1浪(或A浪)与2浪(或B浪)已确认，第3浪/C浪主升(跌)段运行中';
    scenario.currentWave = isDown ? '第3浪/C浪下跌' : '第3浪/C浪上涨';
    scenario.invalidation = {
      name: '防守底线',
      value: p0.price,
      note: isDown ? '若上破起点高点，当前下行结构失效' : '若下破起点低点，当前上行结构失效',
    };
    scenario.confirmation = {
      name: '突破确认',
      value: p1.price,
      note: isDown ? '有效跌破1浪末端，3浪下行延续概率提升' : '有效突破1浪末端，3浪上行延续概率提升',
    };

    const target1 = isDown ? p2.price - w1 : p2.price + w1;
    const target1618 = isDown ? p2.price - w1 * 1.618 : p2.price + w1 * 1.618;
    scenario.targets.push(
      { name: '未来目标 (1.0xW1)', value: target1, note: '常作为C浪终点或3浪初步目标' },
      { name: '未来目标 (1.618xW1)', value: target1618, note: '标准第3浪延伸目标' },
    );
    scenario.keyLevels.push(
      { name: '起点防守位', value: p0.price, note: '结构失效边界' },
      { name: '1浪末端', value: p1.price, note: '主干浪延续确认位' },
      { name: '2浪末端', value: p2.price, note: '当前观察枢轴位' },
    );
    scenario.metrics.push(
      { name: 'W2/W1回撤比', value: formatRatio(pattern.ratios?.retrace) },
    );
  } else if (pattern.type === 'wave4_building') {
    const [p0, p1, p2, p3] = pattern.points;
    const { w3 } = pattern.lengths;
    const isDown = pattern.direction === 'down';

    scenario.stage = '第3浪结构疑似完成，第4浪回调/反弹运行中（未完成）';
    scenario.currentWave = isDown ? '第4浪反弹' : '第4浪回调';
    scenario.invalidation = {
      name: '失效边界',
      value: p1.price,
      note: isDown ? '若反弹重叠第1浪，需警惕结构转为倾斜三角形/调整浪' : '若回调重叠第1浪，需警惕结构转为倾斜三角形/调整浪',
    };
    scenario.confirmation = {
      name: '完成确认',
      value: p3.price,
      note: isDown ? '有效跌破3浪终点，代表4浪可能结束并进入5浪下跌' : '有效突破3浪终点，代表4浪可能结束并进入5浪上涨',
    };

    const retrace382 = isDown ? p3.price + w3 * 0.382 : p3.price - w3 * 0.382;
    const retrace500 = isDown ? p3.price + w3 * 0.5 : p3.price - w3 * 0.5;
    scenario.targets.push(
      { name: 'W4预期回撤 (0.382)', value: retrace382, note: '强势趋势中第4浪常见终点' },
      { name: 'W4预期回撤 (0.500)', value: retrace500, note: '深度调整目标' },
    );
    scenario.keyLevels.push(
      { name: '第1浪终点', value: p1.price, note: '重叠风险边界' },
      { name: '第3浪终点', value: p3.price, note: '第5浪启动确认位' },
      { name: '第3浪起点', value: p2.price, note: '4浪回撤过程关键锚点' },
    );
    scenario.metrics.push(
      { name: 'W3/W1扩展比', value: formatRatio(pattern.ratios?.w3Extend) },
      { name: 'W2/W1回撤比', value: formatRatio(pattern.ratios?.retrace) },
    );
  } else if (pattern.type === 'abc' && pattern.direction === 'down') {
    const [p0, p1, p2, p3] = pattern.points;
    const { a, b, c } = pattern.lengths;
    const cEqualA = p2.price - a;
    const c1272A = p2.price - a * 1.272;
    const c1618A = p2.price - a * 1.618;
    const c2A = p2.price - a * 2;

    scenario.stage = last.close > p3.price
      ? `ABC下跌后反弹阶段（关注是否演化为更大级别反转，类型：${correctionInfo.label}）`
      : `ABC下跌中的C浪阶段（仍有延伸可能，类型：${correctionInfo.label}）`;
    scenario.currentWave = last.close > p3.price ? 'C浪结束后反弹' : 'C浪下跌进行中';
    scenario.invalidation = { name: '失效点', value: p2.price, note: '有效上破B点，当前下跌ABC计数失效' };
    scenario.confirmation = {
      name: '延续确认位',
      value: p3.price,
      note: '有效跌破C点，偏向C浪继续延伸',
    };
    scenario.keyLevels.push(
      { name: 'C浪低点', value: p3.price, note: '当前结构关键支撑' },
      { name: 'B浪高点', value: p2.price, note: '下跌ABC失效边界' },
      { name: 'A浪起点', value: p0.price, note: '反弹回到此处说明修正可能结束' },
    );
    scenario.targets.push(
      { name: 'C=A目标', value: cEqualA, note: '最常见的C浪等长目标' },
      { name: 'C=1.272A目标', value: c1272A, note: 'C浪延伸的中性目标' },
      { name: 'C=1.618A目标', value: c1618A, note: 'C浪延伸的强势目标' },
      { name: 'C=2.0A目标', value: c2A, note: '极端延伸目标，需配合趋势确认' },
    );
    scenario.metrics.push(
      { name: 'B/A', value: formatRatio(safeRatio(b, a)) },
      { name: 'C/A', value: formatRatio(safeRatio(c, a)) },
      { name: 'A浪长度', value: fmt(a) },
      { name: 'C浪长度', value: fmt(c) },
    );
  } else if (pattern.type === 'abc' && pattern.direction === 'up') {
    const [p0, p1, p2, p3] = pattern.points;
    const { a, b, c } = pattern.lengths;
    const cEqualA = p2.price + a;
    const c1272A = p2.price + a * 1.272;
    const c1618A = p2.price + a * 1.618;
    const c2A = p2.price + a * 2;

    scenario.stage = last.close < p3.price
      ? `ABC上涨后回撤阶段（关注是否演化为更大级别回调，类型：${correctionInfo.label}）`
      : `ABC上涨中的C浪阶段（仍有延伸可能，类型：${correctionInfo.label}）`;
    scenario.currentWave = last.close < p3.price ? 'C浪结束后回撤' : 'C浪上涨进行中';
    scenario.invalidation = { name: '失效点', value: p2.price, note: '有效跌破B点，当前上涨ABC计数失效' };
    scenario.confirmation = {
      name: '延续确认位',
      value: p3.price,
      note: '有效突破C点，偏向C浪继续延伸',
    };
    scenario.keyLevels.push(
      { name: 'C浪高点', value: p3.price, note: '当前结构关键压力' },
      { name: 'B浪低点', value: p2.price, note: '上涨ABC失效边界' },
      { name: 'A浪起点', value: p0.price, note: '回撤到此处说明修正可能结束' },
    );
    scenario.targets.push(
      { name: 'C=A目标', value: cEqualA, note: '最常见的C浪等长目标' },
      { name: 'C=1.272A目标', value: c1272A, note: 'C浪延伸的中性目标' },
      { name: 'C=1.618A目标', value: c1618A, note: 'C浪延伸的强势目标' },
      { name: 'C=2.0A目标', value: c2A, note: '极端延伸目标，需配合趋势确认' },
    );
    scenario.metrics.push(
      { name: 'B/A', value: formatRatio(safeRatio(b, a)) },
      { name: 'C/A', value: formatRatio(safeRatio(c, a)) },
      { name: 'A浪长度', value: fmt(a) },
      { name: 'C浪长度', value: fmt(c) },
    );
  } else if (pattern.type === 'wxy' && pattern.direction === 'down') {
    const [p0, , , p3, , , p6, , p8, p9] = pattern.points;
    const { w, x, y } = pattern.lengths;

    scenario.stage = last.close > p9.price
      ? 'WXY 下跌完成后的反弹阶段（复杂调整）'
      : 'WXY 下跌结构延伸中（复杂调整）';
    scenario.currentWave = last.close > p9.price ? 'Y浪结束后反弹' : 'Y浪下跌进行中';
    scenario.invalidation = { name: '失效点', value: p8.price, note: '有效上破Y-B，当前WXY计数减弱' };
    scenario.confirmation = { name: '延续确认位', value: p9.price, note: '有效跌破Y-C，WXY下跌延续概率提升' };
    scenario.keyLevels.push(
      { name: 'W终点', value: p3.price, note: 'W段下跌完成位置' },
      { name: 'X终点', value: p6.price, note: '连接浪反弹终点' },
      { name: 'Y终点', value: p9.price, note: '当前复合调整关键支撑' },
    );
    scenario.targets.push(
      { name: 'Y=1.0W 参考', value: p6.price - w, note: '常见WXY等幅目标' },
      { name: 'Y=1.272W 参考', value: p6.price - w * 1.272, note: '延伸目标' },
      { name: 'Y=1.618W 参考', value: p6.price - w * 1.618, note: '强延伸目标' },
    );
    scenario.metrics.push(
      { name: 'X/W', value: formatRatio(safeRatio(x, w)) },
      { name: 'Y/W', value: formatRatio(safeRatio(y, w)) },
      { name: 'W长度', value: fmt(w) },
      { name: 'Y长度', value: fmt(y) },
    );

    // ── WXY 前瞻叙述（下跌方向）──
    const yExceedsW = y > w;
    const yVsWLabel = yExceedsW ? `Y浪（${fmt(y)}）已超过W浪（${fmt(w)}）` : `Y浪（${fmt(y)}）尚未超过W浪（${fmt(w)}）`;
    scenario.wxyNarrative = {
      startPrice: p0.price,
      wEndPrice: p3.price,
      xEndPrice: p6.price,
      yEndPrice: p9.price,
      monitorPoint: p8.price,
      yExceedsW,
      narrativeLines: [
        `从 ${fmt(p0.price)} 开始有可能是下行联合修正形WXY，`,
        `（1）一种是Y浪大于X浪即跌破 ${fmt(p3.price)}（${yVsWLabel}）；`,
        `（2）另一种是Y浪是三角形。`,
        `监测点 ${fmt(p8.price)}（Y-B高点），如果突破它说明Y浪下行结构失效`,
        `WXY以后或者继续发展到Z浪，或者向上突破`,
      ],
    };
  } else if (pattern.type === 'wxy' && pattern.direction === 'up') {
    const [p0, , , p3, , , p6, , p8, p9] = pattern.points;
    const { w, x, y } = pattern.lengths;

    scenario.stage = last.close < p9.price
      ? 'WXY 上涨完成后的回撤阶段（复杂调整）'
      : 'WXY 上涨结构延伸中（复杂调整）';
    scenario.currentWave = last.close < p9.price ? 'Y浪结束后回撤' : 'Y浪上涨进行中';
    scenario.invalidation = { name: '失效点', value: p8.price, note: '有效下破Y-B，当前WXY计数减弱' };
    scenario.confirmation = { name: '延续确认位', value: p9.price, note: '有效上破Y-C，WXY上涨延续概率提升' };
    scenario.keyLevels.push(
      { name: 'W终点', value: p3.price, note: 'W段上涨完成位置' },
      { name: 'X终点', value: p6.price, note: '连接浪回撤终点' },
      { name: 'Y终点', value: p9.price, note: '当前复合调整关键压力' },
    );
    scenario.targets.push(
      { name: 'Y=1.0W 参考', value: p6.price + w, note: '常见WXY等幅目标' },
      { name: 'Y=1.272W 参考', value: p6.price + w * 1.272, note: '延伸目标' },
      { name: 'Y=1.618W 参考', value: p6.price + w * 1.618, note: '强延伸目标' },
    );
    scenario.metrics.push(
      { name: 'X/W', value: formatRatio(safeRatio(x, w)) },
      { name: 'Y/W', value: formatRatio(safeRatio(y, w)) },
      { name: 'W长度', value: fmt(w) },
      { name: 'Y长度', value: fmt(y) },
    );

    // ── WXY 前瞻叙述（上涨方向）──
    const yExceedsW = y > w;
    const yVsWLabel = yExceedsW ? `Y浪（${fmt(y)}）已超过W浪（${fmt(w)}）` : `Y浪（${fmt(y)}）尚未超过W浪（${fmt(w)}）`;
    scenario.wxyNarrative = {
      startPrice: p0.price,
      wEndPrice: p3.price,
      xEndPrice: p6.price,
      yEndPrice: p9.price,
      monitorPoint: p8.price,
      yExceedsW,
      narrativeLines: [
        `从 ${fmt(p0.price)} 开始有可能是上行联合修正形WXY，`,
        `（1）一种是Y浪大于X浪即超过 ${fmt(p3.price)}（${yVsWLabel}）；`,
        `（2）另一种是Y浪是三角形。`,
        `监测点 ${fmt(p8.price)}（Y-B低点），如果跌破它说明Y浪上行结构失效`,
        `WXY以后或者继续发展到Z浪，或者向下突破`,
      ],
    };
  }

  if (pattern.type === 'impulse' || pattern.type === 'impulse_building') {
    scenario.metrics.push(
      { name: '分形嵌套得分', value: formatRatio(fractalScore) },
      { name: '通道几何得分', value: formatRatio(channelScore) },
    );
    if (fibClusterInfo) {
      scenario.metrics.push(
        { name: '斐波那契共振簇得分', value: formatRatio(fibClusterInfo.score) },
        { name: 'W5共振均值偏差', value: fmtSigned(fibClusterInfo.actual - fibClusterInfo.mean) },
      );
    }
  } else if (pattern.type === 'abc' || pattern.type === 'wxy') {
    scenario.metrics.push({ name: '调整类型', value: correctionInfo.label });
    if (correctionInfo.legA && correctionInfo.legB) {
      scenario.metrics.push(
        { name: 'A内部摆动数', value: String(correctionInfo.legA.swingCount) },
        { name: 'B内部摆动数', value: String(correctionInfo.legB.swingCount) },
      );
    }
    if (pattern.type === 'abc' && correctionInfo.zigzagValidation) {
      const z = correctionInfo.zigzagValidation;
      scenario.metrics.push(
        { name: '单锯齿硬规则', value: z.hardValid ? 'pass' : 'fail' },
        { name: '单锯齿硬规则得分', value: formatRatio(z.hardScore) },
        { name: '单锯齿指引得分', value: formatRatio(z.guideScore) },
        { name: 'B/A', value: formatRatio(z.bOverA) },
        { name: 'C/B', value: formatRatio(z.cOverB) },
        { name: 'C/A', value: formatRatio(z.cOverA) },
        { name: 'B时间/A时间', value: formatRatio(z.bOverATime) },
        { name: 'C时间/A时间', value: formatRatio(z.cOverATime) },
      );
      if (!z.hardValid && Array.isArray(z.failedHardRules) && z.failedHardRules.length > 0) {
        scenario.metrics.push({ name: '单锯齿失败规则', value: z.failedHardRules.join(', ') });
      }
    }
  }

  return scenario;
}

function analyzeWave(candles, baseLookback, options = {}) {
  const atrPeriod = Math.max(2, Math.floor(options.atrPeriod || 14));
  const atrMultiplier = Number.isFinite(options.atrMultiplier) ? Number(options.atrMultiplier) : 1.5;
  const rsiPeriod = Math.max(2, Math.floor(options.rsiPeriod || 14));
  const atrSeries = computeATR(candles, atrPeriod);
  const rsiSeries = computeRSI(candles, rsiPeriod);
  const indicators = { atrSeries, rsiSeries };

  // 多尺度自适应扫描：斐波那契窗口并行探测。
  const maxLookback = Math.max(3, Math.floor(candles.length / 4));
  const autoLookbacks = [2, 3, 5, 8, 13, 21].filter((lb) => lb <= maxLookback);
  const normalizedBase = Math.max(1, Math.floor(baseLookback || 2));
  if (!autoLookbacks.includes(normalizedBase)) autoLookbacks.push(normalizedBase);
  autoLookbacks.sort((a, b) => a - b);

  const candidateGroups = [];
  let microPivotsForContext = null;
  let macroPivotsForContext = null;

  for (const lb of autoLookbacks) {
    const currentPivots = detectPivots(candles, lb, { atrSeries, atrMultiplier });
    if (!microPivotsForContext) microPivotsForContext = currentPivots;
    macroPivotsForContext = currentPivots;

    const detection = detectPatterns(currentPivots, { scale: `lookback_${lb}` });
    candidateGroups.push(detection.candidates);
  }

  const candidates = mergePatternCandidates(candidateGroups);
  const rankedPatterns = candidates.filter(Boolean);

  const pivots = microPivotsForContext || [];
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const high = Math.max(...highs);
  const low = Math.min(...lows);
  const last = candles[candles.length - 1];
  const span = high - low;
  const rangePosition = span > 0 ? (last.close - low) / span : 0.5;
  const distanceToHighPct = high > 0 ? (high - last.close) / high : 0;
  const distanceToLowPct = last.close > 0 ? (last.close - low) / last.close : 0;
  const lastPivot = pivots.length > 0 ? pivots[pivots.length - 1] : null;
  const qualityContext = {
    pivotsMicro: microPivotsForContext,
    pivotsMacro: macroPivotsForContext,
    globalHigh: high,
    globalLow: low,
  };

  const scenarioEntries = rankedPatterns
    .filter((pattern) => validatePatternHardRules(pattern, qualityContext))
    .map((pattern) => ({ pattern, scenario: buildScenario(pattern, candles, last, indicators, qualityContext) }))
    .filter((entry) => Boolean(entry.scenario))
    .sort((a, b) => {
      const scoreDiff = (b.scenario.confidenceScore || 0) - (a.scenario.confidenceScore || 0);
      if (scoreDiff !== 0) return scoreDiff;
      return comparePatternPriority(a.pattern, b.pattern);
    });
  const patternScenarios = scenarioEntries.map((entry) => entry.scenario);
  const primaryEntry = scenarioEntries[0] || null;
  const primaryPattern = primaryEntry?.pattern || null;
  const alternativePatterns = scenarioEntries.slice(1, 5).map((entry) => entry.pattern);
  const primaryScenario = primaryEntry?.scenario || null;
  const stage = primaryScenario?.stage || '结构不清晰，价格更偏向区间震荡';
  const keyLevels = [];
  const targets = [];

  if (primaryScenario?.invalidation) keyLevels.push(primaryScenario.invalidation);
  if (primaryScenario?.confirmation) keyLevels.push(primaryScenario.confirmation);
  if (primaryScenario) {
    keyLevels.push(...primaryScenario.keyLevels);
    targets.push(...primaryScenario.targets);
  }

  const trendOutlook = buildTrendOutlook(patternScenarios);
  const currentPosition = buildCurrentPositionSummary(last.close, rangePosition, primaryScenario);
  const tradingSetup = buildTradingSetup(primaryScenario, last.close);
  const waveContext = buildWaveContextInsights(
    patternScenarios,
    trendOutlook,
    primaryScenario,
    last.close,
    autoLookbacks,
  );

  return {
    candleCount: candles.length,
    high,
    low,
    stage,
    pivots,
    pivotsMicro: microPivotsForContext,
    pivotsMacro: macroPivotsForContext,
    lastPivot,
    primaryPattern,
    alternativePatterns,
    allPatternCandidates: candidates,
    patternScenarios,
    primaryScenario,
    keyLevels,
    targets,
    lastClose: last.close,
    lastTimeUtc: last.timeUtc,
    rangePosition,
    distanceToHighPct,
    distanceToLowPct,
    trendOutlook,
    currentPosition,
    microWavePosition: waveContext.microWavePosition,
    macroTrendPosition: waveContext.macroTrendPosition,
    multiScaleWavePositions: waveContext.multiScaleWavePositions,
    majorBreakRisk: waveContext.majorBreakRisk,
    tradingSetup,
    indicatorsMeta: {
      atrPeriod,
      atrMultiplier,
      rsiPeriod,
      scannedLookbacks: autoLookbacks,
    },
  };
}

function fmt(n) {
  return Number(n).toFixed(2);
}

function fmtPctByRatio(v) {
  if (!Number.isFinite(v)) return 'n/a';
  return `${(v * 100).toFixed(2)}%`;
}

function fmtSigned(n) {
  const value = Number(n);
  if (!Number.isFinite(value)) return 'n/a';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
}

function describeRangeZone(rangePosition) {
  if (!Number.isFinite(rangePosition)) return '区间位置未知';
  if (rangePosition <= 0.2) return '区间低位（0%~20%）';
  if (rangePosition <= 0.4) return '区间偏低（20%~40%）';
  if (rangePosition <= 0.6) return '区间中部（40%~60%）';
  if (rangePosition <= 0.8) return '区间偏高（60%~80%）';
  return '区间高位（80%~100%）';
}

function buildTrendOutlook(patternScenarios) {
  if (!Array.isArray(patternScenarios) || patternScenarios.length === 0) {
    return {
      likely: '震荡/待确认',
      note: '未识别到足够的候选浪型，趋势方向不明确',
      upPct: 0,
      downPct: 0,
    };
  }

  let upScore = 0;
  let downScore = 0;
  for (const scenario of patternScenarios) {
    if (scenario.direction === 'up') upScore += scenario.confidenceScore || 0;
    if (scenario.direction === 'down') downScore += scenario.confidenceScore || 0;
  }

  const total = upScore + downScore;
  if (total <= 0) {
    return {
      likely: '震荡/待确认',
      note: '候选浪型分数不足，趋势方向不明确',
      upPct: 0,
      downPct: 0,
    };
  }

  const upPct = (upScore / total) * 100;
  const downPct = (downScore / total) * 100;
  const diffPct = Math.abs(upPct - downPct);

  let likely = '震荡偏空';
  if (diffPct < 10) {
    likely = '震荡/方向不明';
  } else if (upPct > downPct) {
    likely = upPct >= 60 ? '上行概率更高' : '震荡偏多';
  } else if (downPct >= 60) {
    likely = '下行概率更高';
  }

  return {
    likely,
    note: `候选浪型权重：偏多 ${upPct.toFixed(1)}% / 偏空 ${downPct.toFixed(1)}%`,
    upPct,
    downPct,
  };
}

function parseLookbackFromScale(scale) {
  if (typeof scale !== 'string') return null;
  const match = /^lookback_(\d+)$/.exec(scale);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function pickTopScenarioByDirection(patternScenarios, direction) {
  if (!Array.isArray(patternScenarios)) return null;
  const list = patternScenarios
    .filter((s) => s && s.direction === direction)
    .sort((a, b) => (b.confidenceScore || 0) - (a.confidenceScore || 0));
  return list[0] || null;
}

function pickScenarioByLookback(patternScenarios, lookback, preferredDirection = null) {
  if (!Array.isArray(patternScenarios) || !Number.isFinite(lookback)) return null;
  const list = patternScenarios
    .filter((s) => parseLookbackFromScale(s?.scale) === lookback)
    .filter((s) => (preferredDirection ? s.direction === preferredDirection : true))
    .sort((a, b) => (b.confidenceScore || 0) - (a.confidenceScore || 0));
  return list[0] || null;
}

function pickMacroBoundaryFromScenario(scenario) {
  if (!scenario) return null;
  if (scenario.invalidation && Number.isFinite(scenario.invalidation.value)) return Number(scenario.invalidation.value);
  const pivots = Array.isArray(scenario.pivots) ? scenario.pivots : [];
  if (pivots.length === 0) return null;
  const prices = pivots.map((p) => Number(p.price)).filter((v) => Number.isFinite(v));
  if (prices.length === 0) return null;
  if (scenario.direction === 'up') return Math.min(...prices);
  return Math.max(...prices);
}

function buildWaveContextInsights(patternScenarios, trendOutlook, primaryScenario, lastClose, scannedLookbacks = []) {
  const lookbacks = Array.isArray(scannedLookbacks) && scannedLookbacks.length > 0
    ? scannedLookbacks.slice().sort((a, b) => a - b)
    : [];
  const microLb = lookbacks.length > 0 ? lookbacks[0] : null;
  const macroLb = lookbacks.length > 0 ? lookbacks[lookbacks.length - 1] : null;

  const dominantDirection = (trendOutlook?.upPct || 0) >= (trendOutlook?.downPct || 0) ? 'up' : 'down';
  const dominantPct = dominantDirection === 'up' ? (trendOutlook?.upPct || 0) : (trendOutlook?.downPct || 0);
  const bestUp = pickTopScenarioByDirection(patternScenarios, 'up');
  const bestDown = pickTopScenarioByDirection(patternScenarios, 'down');

  const microWaveScenario =
    pickScenarioByLookback(patternScenarios, microLb) ||
    (dominantDirection === 'up' ? bestUp : bestDown) ||
    primaryScenario ||
    null;

  const macroMainScenario =
    pickScenarioByLookback(patternScenarios, macroLb, dominantDirection) ||
    pickScenarioByLookback(patternScenarios, macroLb) ||
    (dominantDirection === 'up' ? bestUp : bestDown) ||
    primaryScenario ||
    null;

  const macroAltScenario = dominantDirection === 'up' ? bestDown : bestUp;
  const hierarchyDirection = macroMainScenario?.direction || dominantDirection;
  const orderedLookbacks = lookbacks.slice().sort((a, b) => b - a);
  const multiScaleWavePositions = orderedLookbacks.map((lb) => {
    const aligned = pickScenarioByLookback(patternScenarios, lb, hierarchyDirection);
    const fallback = aligned || pickScenarioByLookback(patternScenarios, lb);

    if (!fallback) {
      return {
        lookback: lb,
        scale: `lookback_${lb}`,
        status: 'missing',
        note: `lookback_${lb} 未识别到可用浪型`,
      };
    }

    const pivots = Array.isArray(fallback.pivots) ? fallback.pivots : [];
    return {
      lookback: lb,
      scale: fallback.scale || `lookback_${lb}`,
      status: 'ok',
      title: fallback.title,
      direction: fallback.direction,
      currentWave: fallback.currentWave,
      stage: fallback.stage,
      confidenceScore: Number((fallback.confidenceScore || 0).toFixed(1)),
      barsSinceEnd: fallback.barsSinceEnd,
      startPivot: pivots[0] || null,
      endPivot: pivots[pivots.length - 1] || null,
      waveLegs: fallback.waveLegs || [],
      pivots,
      alignedWithMacro: fallback.direction === hierarchyDirection,
      note: fallback.direction === hierarchyDirection ? '与大周期主方向一致' : '与大周期主方向相反',
    };
  });

  // --- 构建微观浪位叙述 ---
  const buildMicroNarrative = (scenario) => {
    if (!scenario) return '当前缺少足够的局部结构信息，无法给出微观浪位判断。';
    const wave = scenario.currentWave || '浪位待确认';
    const title = scenario.title || '未知浪型';
    const score = (scenario.confidenceScore || 0).toFixed(1);
    const dir = scenario.direction === 'down' ? '偏空' : '偏多';
    const inv = scenario.invalidation;
    const conf = scenario.confirmation;
    const parts = [`当前微观结构识别为「${title}」（${dir}，评分 ${score}），正在运行的浪位为「${wave}」。`];
    if (scenario.stage) parts.push(`阶段描述：${scenario.stage}。`);
    if (inv && Number.isFinite(inv.value)) {
      parts.push(`失效边界 ${fmt(inv.value)}（${inv.note || ''}）。`);
    }
    if (conf && Number.isFinite(conf.value)) {
      parts.push(`延续确认位 ${fmt(conf.value)}（${conf.note || ''}）。`);
    }
    return parts.join('');
  };

  const microWavePosition = microWaveScenario
    ? {
      wave: microWaveScenario.currentWave || '浪位待确认',
      stage: microWaveScenario.stage || '阶段待确认',
      scenarioTitle: microWaveScenario.title || '主情景',
      direction: microWaveScenario.direction || 'unknown',
      confidenceScore: Number((microWaveScenario.confidenceScore || 0).toFixed(1)),
      lookback: parseLookbackFromScale(microWaveScenario.scale),
      note: `微观：基于 ${microWaveScenario.scale || 'unknown'}`,
      narrative: buildMicroNarrative(microWaveScenario),
      waveLegs: microWaveScenario.waveLegs || [],
      pivots: microWaveScenario.pivots || [],
    }
    : {
      wave: '浪位不明',
      stage: '暂无可靠微观结构',
      scenarioTitle: 'n/a',
      direction: 'unknown',
      confidenceScore: 0,
      lookback: null,
      note: '微观定位失败：候选浪型不足',
      narrative: '当前缺少足够的局部结构信息，无法给出微观浪位判断。',
    };

  // --- 构建宏观多头叙述 ---
  const buildBullishNarrative = (scenario) => {
    if (!scenario) return '当前未识别到有效的多头浪型结构。';
    const title = scenario.title || '未知结构';
    const wave = scenario.currentWave || '浪位待确认';
    const score = (scenario.confidenceScore || 0).toFixed(1);
    const parts = [`多头视角（评分 ${score}）：`];
    // 根据浪型类型生成不同的解读
    if (scenario.patternType === 'wave3_building' || scenario.patternType === 'impulse_building') {
      parts.push(`如果把此前的下跌视为更大级别上涨中的修正（第2浪/B浪），那么目前识别到的「${title}」表明修正可能已经结束。`);
      parts.push(`当前正在走的是更大级别上涨推动浪的初期阶段（「${wave}」），一旦确认突破关键阻力，上行空间将打开。`);
    } else if (scenario.patternType === 'abc' && scenario.direction === 'up') {
      parts.push(`识别到「${title}」，如果此前的下跌是更大级别上涨中的修正浪，那么目前的上行 ABC 可能是新一轮主升浪的起步阶段。`);
      parts.push(`当前处于「${wave}」。`);
    } else {
      parts.push(`识别到「${title}」，当前处于「${wave}」。如果这个结构得到确认，意味着向下的调整已经全部结束，更大级别上涨趋势回归。`);
    }
    if (scenario.confirmation && Number.isFinite(scenario.confirmation.value)) {
      parts.push(`确认信号：上破 ${fmt(scenario.confirmation.value)}（${scenario.confirmation.note || ''}）。`);
    }
    if (scenario.invalidation && Number.isFinite(scenario.invalidation.value)) {
      parts.push(`失效条件：跌破 ${fmt(scenario.invalidation.value)}（${scenario.invalidation.note || ''}）。`);
    }
    return parts.join('');
  };

  // --- 构建宏观空头叙述 ---
  const buildBearishNarrative = (scenario) => {
    if (!scenario) return '当前未识别到有效的空头浪型结构。';
    const title = scenario.title || '未知结构';
    const wave = scenario.currentWave || '浪位待确认';
    const score = (scenario.confidenceScore || 0).toFixed(1);
    const parts = [`空头视角（评分 ${score}）：`];
    if (scenario.patternType === 'abc' && scenario.direction === 'down') {
      // 判断是否C浪结束
      const isCDone = wave.includes('C浪结束') || wave.includes('反弹');
      if (isCDone) {
        parts.push(`识别到「${title}」，C浪已疑似触底。但在空头剧本下，刚走完的 ABC 并不是调整的全部，它仅仅是更大级别复杂调整浪（如 W-X-Y）中的 W 浪（第一段下跌）。`);
        parts.push(`当前正在走的是连接两段下跌的 X 浪（反弹修正浪），之后可能再次转头向下走 Y 浪（甚至跌破此前低点）。`);
      } else {
        parts.push(`识别到「${title}」，当前处于「${wave}」，下跌动能尚未耗尽。`);
        parts.push(`在更大级别中，这可能是复合调整浪的一部分，后续下行空间仍然存在。`);
      }
    } else if (scenario.patternType === 'wxy') {
      parts.push(`识别到「${title}」（复合调整），当前处于「${wave}」。这表明当前的下跌具备多层嵌套结构，整体调整尚未结束。`);
    } else if (scenario.patternType === 'impulse' || scenario.patternType === 'impulse_building') {
      parts.push(`识别到「${title}」，当前处于「${wave}」。下跌推动浪结构意味着更大级别的趋势方向偏空，当前的反弹可能是逆势修正。`);
    } else {
      parts.push(`识别到「${title}」，当前处于「${wave}」。空头浪型暗示上方压力较大，反弹可能受阻。`);
    }
    if (scenario.confirmation && Number.isFinite(scenario.confirmation.value)) {
      parts.push(`延续确认：跌破 ${fmt(scenario.confirmation.value)}（${scenario.confirmation.note || ''}）。`);
    }
    if (scenario.invalidation && Number.isFinite(scenario.invalidation.value)) {
      parts.push(`失效条件：上破 ${fmt(scenario.invalidation.value)}（${scenario.invalidation.note || ''}）。`);
    }
    return parts.join('');
  };

  // --- 构建破局点叙述 ---
  const buildBreakpointNarrative = (bull, bear, close) => {
    if (!bull && !bear) return '当前缺少多空双方的对立结构，无法确定明确的破局点。';
    const keyLevel = bull?.invalidation?.value ?? bear?.invalidation?.value ?? null;
    if (!Number.isFinite(keyLevel)) return '暂无明确的多空分界关键价位。';
    const isAbove = close > keyLevel;
    const dist = Math.abs(close - keyLevel);
    const distPct = close > 0 ? ((dist / close) * 100).toFixed(2) : 'n/a';
    const parts = [`破局关键位：${fmt(keyLevel)}（当前价 ${fmt(close)}，${isAbove ? '位于其上方' : '位于其下方'}，距离 ${distPct}%）。`];
    if (bull?.invalidation && Number.isFinite(bull.invalidation.value)) {
      parts.push(`若跌破 ${fmt(bull.invalidation.value)}，多头结构失效，空头剧本激活。`);
    }
    if (bear?.invalidation && Number.isFinite(bear.invalidation.value)) {
      parts.push(`若上破 ${fmt(bear.invalidation.value)}，空头计数失效，多头剧本回归。`);
    }
    return parts.join('');
  };

  const bullishNarrative = buildBullishNarrative(bestUp);
  const bearishNarrative = buildBearishNarrative(bestDown);
  const breakpointNarrative = buildBreakpointNarrative(bestUp, bestDown, lastClose);

  const macroTrendPosition = {
    dominantDirection,
    dominantProbabilityPct: Number(dominantPct.toFixed(1)),
    dominantScenario: macroMainScenario
      ? {
        title: macroMainScenario.title,
        stage: macroMainScenario.stage,
        currentWave: macroMainScenario.currentWave,
        confidenceScore: Number((macroMainScenario.confidenceScore || 0).toFixed(1)),
        scale: macroMainScenario.scale || 'unknown',
        confirmation: macroMainScenario.confirmation || null,
        invalidation: macroMainScenario.invalidation || null,
        waveLegs: macroMainScenario.waveLegs || [],
        pivots: macroMainScenario.pivots || [],
      }
      : null,
    bullishPath: bestUp
      ? {
        title: bestUp.title,
        currentWave: bestUp.currentWave,
        stage: bestUp.stage || '',
        confidenceScore: Number((bestUp.confidenceScore || 0).toFixed(1)),
        triggerLevel: bestUp.confirmation?.value ?? null,
        failureLevel: bestUp.invalidation?.value ?? null,
        narrative: bullishNarrative,
        waveLegs: bestUp.waveLegs || [],
        pivots: bestUp.pivots || [],
      }
      : null,
    bearishPath: bestDown
      ? {
        title: bestDown.title,
        currentWave: bestDown.currentWave,
        stage: bestDown.stage || '',
        confidenceScore: Number((bestDown.confidenceScore || 0).toFixed(1)),
        triggerLevel: bestDown.confirmation?.value ?? null,
        failureLevel: bestDown.invalidation?.value ?? null,
        narrative: bearishNarrative,
        waveLegs: bestDown.waveLegs || [],
        pivots: bestDown.pivots || [],
      }
      : null,
    breakpointNarrative,
    note: macroAltScenario
      ? `宏观主推：${macroMainScenario?.title || 'n/a'}；备选路径：${macroAltScenario.title}`
      : `宏观主推：${macroMainScenario?.title || 'n/a'}`,
  };

  const upReference = pickScenarioByLookback(patternScenarios, macroLb, 'up') || bestUp;
  const majorLevel = pickMacroBoundaryFromScenario(upReference);
  let breakProbability = null;

  if (Number.isFinite(majorLevel)) {
    const dist = (lastClose - majorLevel) / Math.max(1, Math.abs(lastClose));
    const bearishWeight = clamp((trendOutlook?.downPct || 0) / 100, 0, 1);
    const distanceRisk = dist <= 0 ? 1 : clamp(1 - dist / 0.12, 0, 1);
    const structureFragility = upReference ? clamp(1 - (upReference.confidenceScore || 0) / 100, 0, 1) : 0.5;
    const score = dist <= 0
      ? 1
      : clamp(bearishWeight * 0.55 + distanceRisk * 0.3 + structureFragility * 0.15, 0, 1);
    breakProbability = {
      referenceScenario: upReference?.title || 'n/a',
      breakLevel: majorLevel,
      probabilityPct: Number((score * 100).toFixed(1)),
      distanceToLevelPct: Number((dist * 100).toFixed(2)),
      bearishWeightPct: Number((bearishWeight * 100).toFixed(1)),
      state: dist <= 0 ? 'already_broken' : (score >= 0.6 ? 'high_risk' : (score >= 0.4 ? 'medium_risk' : 'low_risk')),
      note: dist <= 0
        ? '价格已跌破大级别支撑，大级别上行浪型假设失效'
        : '概率综合空头权重、价格与大级别边界距离、结构质量脆弱度',
    };
  }

  return {
    microWavePosition,
    macroTrendPosition,
    multiScaleWavePositions: {
      anchorDirection: hierarchyDirection,
      anchorLookback: macroLb,
      note: `按 lookback 从大到小逐级定位；优先选择与大周期主方向一致的浪型`,
      levels: multiScaleWavePositions,
    },
    majorBreakRisk: breakProbability,
  };
}

function buildCurrentPositionSummary(lastClose, rangePosition, primaryScenario) {
  const summary = {
    rangeZone: describeRangeZone(rangePosition),
    levelStatus: '暂无主结构关键位参考',
  };

  if (!primaryScenario?.invalidation || !primaryScenario?.confirmation) {
    return summary;
  }

  const invalidation = primaryScenario.invalidation.value;
  const confirmation = primaryScenario.confirmation.value;
  const isBullish = primaryScenario.direction === 'up';

  if (isBullish) {
    if (lastClose < invalidation) {
      summary.levelStatus = `当前价 ${fmt(lastClose)} 已跌破失效点 ${fmt(invalidation)}，主情景偏多失效`;
    } else if (lastClose > confirmation) {
      summary.levelStatus = `当前价 ${fmt(lastClose)} 已突破确认位 ${fmt(confirmation)}，主情景偏多延续`;
    } else {
      summary.levelStatus = `当前价 ${fmt(lastClose)} 位于失效点 ${fmt(invalidation)} 与确认位 ${fmt(confirmation)} 之间`;
    }
  } else if (lastClose > invalidation) {
    summary.levelStatus = `当前价 ${fmt(lastClose)} 已上破失效点 ${fmt(invalidation)}，主情景偏空失效`;
  } else if (lastClose < confirmation) {
    summary.levelStatus = `当前价 ${fmt(lastClose)} 已跌破确认位 ${fmt(confirmation)}，主情景偏空延续`;
  } else {
    summary.levelStatus = `当前价 ${fmt(lastClose)} 位于确认位 ${fmt(confirmation)} 与失效点 ${fmt(invalidation)} 之间`;
  }

  return summary;
}

function calcRiskReward(direction, entry, stop, target) {
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || !Number.isFinite(target)) return null;
  if (direction === 'short') {
    const risk = stop - entry;
    const reward = entry - target;
    if (risk <= 0 || reward <= 0) return null;
    return reward / risk;
  }
  const risk = entry - stop;
  const reward = target - entry;
  if (risk <= 0 || reward <= 0) return null;
  return reward / risk;
}

function normalizeNumberList(values) {
  const unique = new Set();
  for (const v of values || []) {
    if (Number.isFinite(v)) unique.add(Number(v));
  }
  return Array.from(unique.values());
}

function pickDirectionalTargets(direction, entry, targetValues, fallbackSpan) {
  const span = Math.max(1, Number(fallbackSpan) || 1);
  const values = normalizeNumberList(targetValues);
  const directional = direction === 'short'
    ? values.filter((v) => v < entry).sort((a, b) => b - a)
    : values.filter((v) => v > entry).sort((a, b) => a - b);

  if (directional.length === 0) {
    const tp1 = direction === 'short' ? entry - span * 0.9 : entry + span * 0.9;
    const tp2 = direction === 'short' ? entry - span * 1.6 : entry + span * 1.6;
    return [tp1, tp2];
  }
  if (directional.length === 1) {
    const tp1 = directional[0];
    const tp2 = direction === 'short'
      ? Math.min(tp1 - span * 0.8, tp1 * 0.998)
      : Math.max(tp1 + span * 0.8, tp1 * 1.002);
    return [tp1, tp2];
  }
  return [directional[0], directional[1]];
}

function buildTradePlan(name, type, direction, entry, stop, targets, rrThreshold) {
  const [tp1, tp2] = targets;
  const rrToTp1 = calcRiskReward(direction, entry, stop, tp1);
  const rrToTp2 = calcRiskReward(direction, entry, stop, tp2);
  const rrBest = Math.max(rrToTp1 || 0, rrToTp2 || 0);
  const valid = rrBest >= rrThreshold;
  return {
    name,
    type,
    direction,
    entry,
    stop,
    tp1,
    tp2,
    rrToTp1: rrToTp1 ? Number(rrToTp1.toFixed(2)) : null,
    rrToTp2: rrToTp2 ? Number(rrToTp2.toFixed(2)) : null,
    rrBest: Number(rrBest.toFixed(2)),
    pass: valid,
  };
}

function buildTradingSetup(scenario, lastClose) {
  const rrThreshold = 1.5;
  const wait = (reason) => ({
    status: 'wait',
    reason,
    rrThreshold,
    direction: 'n/a',
    boundary: null,
    hardStop: null,
    zone: null,
    plans: [],
    recommendedPlan: null,
  });

  if (!scenario || !scenario.invalidation || !scenario.confirmation) {
    return wait('缺少主情景边界（失效点/确认位），无法生成可执行交易计划。');
  }

  const invalidation = Number(scenario.invalidation.value);
  const confirmation = Number(scenario.confirmation.value);
  if (!Number.isFinite(invalidation) || !Number.isFinite(confirmation) || !Number.isFinite(lastClose)) {
    return wait('关键价位数据异常，建议观望。');
  }

  const direction = scenario.direction === 'down' ? 'short' : 'long';
  const upper = Math.max(invalidation, confirmation);
  const lower = Math.min(invalidation, confirmation);
  const span = upper - lower;
  if (span <= 0) return wait('边界区间过小或无效，建议观望。');

  const relPos = (lastClose - lower) / span;
  const inBoundary = lastClose > lower && lastClose < upper;
  const inNoMansLand = inBoundary && relPos >= 0.35 && relPos <= 0.65;
  const slBuffer = Math.max(Math.abs(lastClose) * 0.0015, span * 0.08);
  const hardStop = direction === 'short' ? upper + slBuffer : lower - slBuffer;

  const targetValues = [
    confirmation,
    ...(scenario.targets || []).map((t) => Number(t.value)),
  ].filter((v) => Number.isFinite(v));

  let pullbackPlan = null;
  let breakoutPlan = null;
  if (direction === 'short') {
    const pullbackUpper = upper - span * 0.03;
    const pullbackLower = upper - span * 0.22;
    const pullbackEntry = (pullbackUpper + pullbackLower) / 2;
    const breakoutEntry = lower - span * 0.08;
    const pullbackTargets = pickDirectionalTargets(direction, pullbackEntry, targetValues, span);
    const breakoutTargets = pickDirectionalTargets(direction, breakoutEntry, targetValues, span);
    pullbackPlan = buildTradePlan(
      '左侧高空（反弹做空）',
      'sell_limit',
      direction,
      pullbackEntry,
      hardStop,
      pullbackTargets,
      rrThreshold,
    );
    pullbackPlan.entryZone = { low: pullbackLower, high: pullbackUpper };
    breakoutPlan = buildTradePlan(
      '右侧突破（顺势追空）',
      'sell_stop',
      direction,
      breakoutEntry,
      hardStop,
      breakoutTargets,
      rrThreshold,
    );
  } else {
    const pullbackLower = lower + span * 0.03;
    const pullbackUpper = lower + span * 0.22;
    const pullbackEntry = (pullbackUpper + pullbackLower) / 2;
    const breakoutEntry = upper + span * 0.08;
    const pullbackTargets = pickDirectionalTargets(direction, pullbackEntry, targetValues, span);
    const breakoutTargets = pickDirectionalTargets(direction, breakoutEntry, targetValues, span);
    pullbackPlan = buildTradePlan(
      '左侧低吸（回踩做多）',
      'buy_limit',
      direction,
      pullbackEntry,
      hardStop,
      pullbackTargets,
      rrThreshold,
    );
    pullbackPlan.entryZone = { low: pullbackLower, high: pullbackUpper };
    breakoutPlan = buildTradePlan(
      '右侧突破（顺势追多）',
      'buy_stop',
      direction,
      breakoutEntry,
      hardStop,
      breakoutTargets,
      rrThreshold,
    );
  }

  const plans = [pullbackPlan, breakoutPlan];
  const validPlans = plans.filter((p) => p.pass);
  validPlans.sort((a, b) => b.rrBest - a.rrBest);

  if (validPlans.length === 0) {
    const rrBest = Math.max(...plans.map((p) => p.rrBest));
    const reason = inNoMansLand
      ? `当前位于边界中段（No Man's Land），且最佳盈亏比仅 ${rrBest.toFixed(2)} < ${rrThreshold}，建议观望等待靠近边界。`
      : `当前最佳盈亏比 ${rrBest.toFixed(2)} < ${rrThreshold}，不建议开仓。`;
    return {
      status: 'wait',
      reason,
      rrThreshold,
      direction,
      boundary: {
        invalidation,
        confirmation,
        upper,
        lower,
        span,
      },
      hardStop,
      zone: {
        inBoundary,
        inNoMansLand,
        relativePosition: Number(relPos.toFixed(3)),
      },
      plans,
      recommendedPlan: null,
    };
  }

  return {
    status: 'ready',
    reason: inNoMansLand
      ? '虽然位于中段，但已有满足盈亏比过滤的挂单方案。'
      : '存在满足盈亏比过滤的可执行挂单方案。',
    rrThreshold,
    direction,
    boundary: {
      invalidation,
      confirmation,
      upper,
      lower,
      span,
    },
    hardStop,
    zone: {
      inBoundary,
      inNoMansLand,
      relativePosition: Number(relPos.toFixed(3)),
    },
    plans,
    recommendedPlan: validPlans[0],
  };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatToUtcOffset(input, offsetHours = REPORT_TZ_OFFSET_HOURS) {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return String(input);

  const shifted = new Date(date.getTime() + offsetHours * 3600 * 1000);
  const y = shifted.getUTCFullYear();
  const m = pad2(shifted.getUTCMonth() + 1);
  const d = pad2(shifted.getUTCDate());
  const hh = pad2(shifted.getUTCHours());
  const mm = pad2(shifted.getUTCMinutes());
  const ss = pad2(shifted.getUTCSeconds());
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

function formatPivotPoint(p) {
  const t = formatToUtcOffset(new Date(p.timestamp * 1000));
  return `${p.type}@${fmt(p.price)} (${t} ${REPORT_TZ_LABEL})`;
}

function patternTitle(p) {
  if (!p) return '未识别到清晰浪型';
  if (p.type === 'impulse') {
    if (p.mode === 'diagonal') {
      return p.direction === 'down' ? '看跌倾斜三角形（5浪）' : '看涨倾斜三角形（5浪）';
    }
    return p.direction === 'down' ? '看跌推动浪（1-2-3-4-5）' : '看涨推动浪（1-2-3-4-5）';
  }
  if (p.type === 'impulse_building') {
    if (p.mode === 'diagonal') {
      return p.direction === 'down' ? '看跌倾斜三角形构建中（1-2-3-4）' : '看涨倾斜三角形构建中（1-2-3-4）';
    }
    return p.direction === 'down' ? '看跌推动浪构建中（1-2-3-4）' : '看涨推动浪构建中（1-2-3-4）';
  }
  if (p.type === 'wave3_building') {
    return p.direction === 'down' ? '第3浪/C浪构建中（下行）' : '第3浪/C浪构建中（上行）';
  }
  if (p.type === 'wave4_building') {
    return p.direction === 'down' ? '第4浪构建中（下行主趋势）' : '第4浪构建中（上行主趋势）';
  }
  if (p.type === 'wxy') {
    return p.direction === 'down' ? '看跌WXY复合调整' : '看涨WXY复合调整';
  }
  return p.direction === 'down' ? '看跌ABC调整浪' : '看涨ABC调整浪';
}

function priceNear(value, target, tolerance = 120) {
  return Number.isFinite(value) && Number.isFinite(target) && Math.abs(Number(value) - Number(target)) <= tolerance;
}

function getScenarioStartPrice(scenario) {
  const first = Array.isArray(scenario?.pivots) && scenario.pivots.length > 0 ? scenario.pivots[0] : null;
  return Number(first?.price);
}

function getScenarioTargetValues(scenario) {
  return (scenario?.targets || [])
    .map((t) => Number(t.value))
    .filter((v) => Number.isFinite(v));
}

function findScenario(patternScenarios, matcher) {
  if (!Array.isArray(patternScenarios)) return null;
  return patternScenarios
    .filter((scenario) => scenario && matcher(scenario))
    .sort((a, b) => (b.confidenceScore || 0) - (a.confidenceScore || 0))[0] || null;
}

function uniqSortedNumbers(values) {
  const uniq = [];
  for (const value of values || []) {
    const num = Number(value);
    if (!Number.isFinite(num)) continue;
    if (uniq.some((existing) => Math.abs(existing - num) < 1)) continue;
    uniq.push(num);
  }
  return uniq.sort((a, b) => a - b);
}

function buildTargetBuckets(values, lastClose) {
  const near = [];
  const mid = [];
  const far = [];
  for (const value of uniqSortedNumbers(values)) {
    if (!(value > lastClose)) continue;
    if (value <= lastClose + 2000) {
      near.push(value);
    } else if (value <= lastClose + 5000) {
      mid.push(value);
    } else {
      far.push(value);
    }
  }
  return {
    near: near.slice(0, 3),
    mid: mid.slice(0, 3),
    far: far.slice(0, 3),
  };
}

function formatTargetBucket(values) {
  if (!Array.isArray(values) || values.length === 0) return 'n/a';
  return values.map((value) => fmt(value)).join(' / ');
}

function buildManualAlternateStructureNotes(meta, analysis) {
  if (meta?.product !== 'BTC-USD' || meta?.timeframe !== '1h') return [];
  if (!priceNear(analysis?.low, 60001, 300)) return [];

  const patternScenarios = analysis?.patternScenarios || [];
  const primaryScenario = analysis?.primaryScenario || null;
  const lastClose = Number(analysis?.lastClose);
  if (!Number.isFinite(lastClose)) return [];

  const diagonalScenario = findScenario(patternScenarios, (scenario) => (
    scenario.direction === 'up'
    && (scenario.title || '').includes('鍊炬枩涓夎褰?')
    && priceNear(getScenarioStartPrice(scenario), 65618.51, 180)
  ));
  const abcFrom65618 = findScenario(patternScenarios, (scenario) => (
    scenario.direction === 'up'
    && (scenario.title || '').includes('ABC')
    && priceNear(getScenarioStartPrice(scenario), 65618.51, 180)
  ));
  const wave3From69180 = findScenario(patternScenarios, (scenario) => (
    scenario.direction === 'up'
    && (scenario.title || '').includes('绗?娴?C娴瀯寤轰腑')
    && priceNear(getScenarioStartPrice(scenario), 69180.01, 180)
  ));
  const comboFrom62534 = findScenario(patternScenarios, (scenario) => (
    scenario.direction === 'up'
    && (scenario.title || '').includes('WXY')
    && priceNear(getScenarioStartPrice(scenario), 62534.61, 180)
  ));

  const leadingBuckets = buildTargetBuckets(
    [
      ...getScenarioTargetValues(diagonalScenario),
      ...getScenarioTargetValues(abcFrom65618),
      ...getScenarioTargetValues(wave3From69180),
    ],
    lastClose,
  );
  const comboBuckets = buildTargetBuckets(
    [
      ...getScenarioTargetValues(comboFrom62534),
      ...getScenarioTargetValues(abcFrom65618),
      ...getScenarioTargetValues(wave3From69180),
    ],
    lastClose,
  );

  const shortSupport = Number(primaryScenario?.invalidation?.value);
  const shortConfirm = Number(primaryScenario?.confirmation?.value);
  const shortSupportLabel = Number.isFinite(shortSupport) ? fmt(shortSupport) : '72276.24';
  const shortConfirmLabel = Number.isFinite(shortConfirm) ? fmt(shortConfirm) : '74444.00';

  const leadingState = primaryScenario?.currentWave?.includes('鍥炴挙')
    ? `澶у懆鏈?5娴唴閮ㄥ凡缁忓啿鍑轰竴娈碉紝褰撳墠鏇村儚5娴湯绔悗鐨勫洖鎾?鏁寸悊锛堝井瑙傚弬鑰冧负銆?${primaryScenario.currentWave}銆嶏級`
    : '澶у懆鏈?5娴粛鍦ㄦ帹杩涳紝鐭嚎绛夊緟鍐嶆涓婂啿纭';
  const comboState = primaryScenario?.title?.includes('WXY')
    ? `褰撳墠寰涓绘儏鏅笌鑱斿悎褰㈡渶鍚庝竴娈礫娴粨鏉熷悗鍥炴挙鐩稿悎锛岀幇闃舵鍙互鎸夈?${primaryScenario.currentWave}銆嶇悊瑙?`
    : '濡傛灉鎸夎仈鍚堝舰锛屽綋鍓嶆洿鍍忔槸Z娴唴閮ㄤ笂娑ㄥ畬鎴愬悗鐨勫洖鎾?';

  return [
    {
      title: '澶囬€夌粨鏋勪竴锛氬紩瀵兼褰紙鎵嬪伐鏁版氮锛?',
      lines: [
        '濡傛灉鎶?60001.00 鍚庣殑鏁翠綋涓婅瑙嗕负寮曞妤旓紝鍙互鎸夌浉鍚岀骇鍒墜宸ュ垎涓?1-2-3-4-5',
        '1娴?60001.00 -> 72232.17锛?2娴?72232.17 -> 62534.61锛?3娴?62534.61 -> 74100.00锛?4娴?74100.00 -> 65618.51锛?5娴?65618.51 -> now',
        '鎸夊紩瀵兼褰㈢殑鐞嗚В锛?1銆?3銆?5娴唴閮ㄦ洿鍋忎笁娈碉紝2銆?4娴篃鏄慨姝ｆ锛?4娴笌1娴尯闂撮噸鍙犳槸鍙互鎺ュ彈鐨?',
        `褰撳墠鎵€澶勬尝娈碉細${leadingState}`,
        `缁撴瀯闃插畧锛?65618.51锛涚煭绾胯瀵熶綅锛?${shortSupportLabel}`,
        `鍐嶄笂琛屽彲鍚﹀欢缁紝鍏堢湅鏄惁鏈夋晥绔欏洖 ${shortConfirmLabel}`,
        `5娴笂鏂圭洰鏍囷細杩戠 ${formatTargetBucket(leadingBuckets.near)}锛涗腑娈?${formatTargetBucket(leadingBuckets.mid)}锛涘己寤朵几 ${formatTargetBucket(leadingBuckets.far)}`,
      ],
    },
    {
      title: '澶囬€夌粨鏋勪簩锛氳仈鍚堝舰锛圵-X-Y-X-Z锛?',
      lines: [
        '濡傛灉鎸夎仈鍚堝舰鐞嗚В锛岃繖缁勯攨鐐规洿閫傚悎鏁版垚 W-X-Y-X-Z 鑰屼笉鏄帹鍔?1-2-3-4-5',
        'W锛?60001.00 -> 72232.17锛孹锛?72232.17 -> 62534.61锛塝锛?62534.61 -> 74100.00锛孹锛?74100.00 -> 65618.51锛塦锛?65618.51 -> now',
        '鎸夎繖绉嶆暟娉曪紝65618.51 涔嬪悗鐨勪笂娑ㄤ笉鏄ぇ5娴紝鑰屾槸鏈€鍚庝竴娈礫娴?',
        `褰撳墠鎵€澶勬尝娈碉細${comboState}`,
        `缁撴瀯闃插畧锛?65618.51锛涚煭绾挎敮鎾戝弬鑰冿細${shortSupportLabel}`,
        `濡傛灉Z娴繕瑕佸啀鍐蹭竴娆★紝鍏堢湅鏄惁鑳介噸鏂扮珯鍥?${shortConfirmLabel}`,
        `Z娴悗缁洰鏍囷細杩戠 ${formatTargetBucket(comboBuckets.near)}锛涗腑娈?${formatTargetBucket(comboBuckets.mid)}锛涘己寤朵几 ${formatTargetBucket(comboBuckets.far)}`,
      ],
    },
  ];
}

function buildManualAlternateStructureNotes(meta, analysis) {
  if (meta?.product !== 'BTC-USD' || meta?.timeframe !== '1h') return [];
  if (!priceNear(analysis?.low, 60001, 300)) return [];

  const patternScenarios = analysis?.patternScenarios || [];
  const primaryScenario = analysis?.primaryScenario || null;
  const lastClose = Number(analysis?.lastClose);
  if (!Number.isFinite(lastClose)) return [];

  const diagonalScenario = findScenario(patternScenarios, (scenario) => (
    scenario.direction === 'up'
    && scenario.patternType === 'impulse_building'
    && scenario.mode === 'diagonal'
    && priceNear(getScenarioStartPrice(scenario), 65618.51, 180)
  ));
  const abcFrom65618 = findScenario(patternScenarios, (scenario) => (
    scenario.direction === 'up'
    && scenario.patternType === 'abc'
    && priceNear(getScenarioStartPrice(scenario), 65618.51, 180)
  ));
  const wave3From69180 = findScenario(patternScenarios, (scenario) => (
    scenario.direction === 'up'
    && scenario.patternType === 'wave3_building'
    && priceNear(getScenarioStartPrice(scenario), 69180.01, 180)
  ));
  const comboFrom62534 = findScenario(patternScenarios, (scenario) => (
    scenario.direction === 'up'
    && scenario.patternType === 'wxy'
    && priceNear(getScenarioStartPrice(scenario), 62534.61, 180)
  ));

  const leadingBuckets = buildTargetBuckets(
    [
      ...getScenarioTargetValues(diagonalScenario),
      ...getScenarioTargetValues(abcFrom65618),
      ...getScenarioTargetValues(wave3From69180),
    ],
    lastClose,
  );
  const comboBuckets = buildTargetBuckets(
    [
      ...getScenarioTargetValues(comboFrom62534),
      ...getScenarioTargetValues(abcFrom65618),
      ...getScenarioTargetValues(wave3From69180),
    ],
    lastClose,
  );

  const shortSupport = Number(primaryScenario?.invalidation?.value);
  const shortConfirm = Number(primaryScenario?.confirmation?.value);
  const shortSupportLabel = Number.isFinite(shortSupport) ? fmt(shortSupport) : '72276.24';
  const shortConfirmLabel = Number.isFinite(shortConfirm) ? fmt(shortConfirm) : '74444.00';

  const leadingState = primaryScenario?.currentWave
    ? `当前阶段：大级别按第5浪推进，细分结构暂按“${primaryScenario.currentWave}”跟踪。`
    : '当前阶段：大级别按第5浪推进。';
  const comboState = primaryScenario?.currentWave
    ? `当前阶段：把 65618.51 以来的上涨视为 Z 段，细分结构暂按“${primaryScenario.currentWave}”跟踪。`
    : '当前阶段：把 65618.51 以来的上涨视为 Z 段。';

  return [
    {
      title: '备选结构一：引导楔形',
      lines: [
        '如果把 60001.00 之后的整段上涨视为引导楔形，可按手动 1-2-3-4-5 分段。',
        '第1浪：60001.00 -> 72232.17；第2浪：72232.17 -> 62534.61；第3浪：62534.61 -> 74100.00；第4浪：74100.00 -> 65618.51；第5浪：65618.51 -> 当前。',
        '该解释下，第1、3、5浪都按三段式推进处理，第1浪与第4浪允许重叠，符合引导楔形特征。',
        leadingState,
        `结构失效位：65618.51；短线支撑关注：${shortSupportLabel}。`,
        `若第5浪继续延伸，价格仍需重新站稳 ${shortConfirmLabel} 上方。`,
        `第5浪上方目标：近端 ${formatTargetBucket(leadingBuckets.near)}；中继 ${formatTargetBucket(leadingBuckets.mid)}；延伸 ${formatTargetBucket(leadingBuckets.far)}。`,
      ],
    },
    {
      title: '备选结构二：联合形（W-X-Y-X-Z）',
      lines: [
        '如果把这段结构视为联合形，这组拐点链更接近 W-X-Y-X-Z，而不是标准推动浪。',
        'W：60001.00 -> 72232.17；X：72232.17 -> 62534.61；Y：62534.61 -> 74100.00；X：74100.00 -> 65618.51；Z：65618.51 -> 当前。',
        '该解释下，65618.51 之后的上涨归属于 Z 段，而不是大级别第5浪。',
        comboState,
        `结构失效位：65618.51；短线支撑关注：${shortSupportLabel}。`,
        `若 Z 段还在向上延伸，价格应重新收复 ${shortConfirmLabel}。`,
        `Z 段上方目标：近端 ${formatTargetBucket(comboBuckets.near)}；中继 ${formatTargetBucket(comboBuckets.mid)}；延伸 ${formatTargetBucket(comboBuckets.far)}。`,
      ],
    },
  ];
}

function getScenarioEndPrice(scenario) {
  const pivots = Array.isArray(scenario?.pivots) ? scenario.pivots : [];
  const lastPivot = pivots.length > 0 ? pivots[pivots.length - 1] : null;
  if (Number.isFinite(Number(lastPivot?.price))) return Number(lastPivot.price);
  const legs = Array.isArray(scenario?.waveLegs) ? scenario.waveLegs : [];
  const lastLeg = legs.length > 0 ? legs[legs.length - 1] : null;
  return Number(lastLeg?.to?.price);
}

function getScenarioFamilyKey(scenario) {
  const patternType = scenario?.patternType || '';
  if (patternType === 'impulse_building' && scenario?.mode === 'diagonal') return 'leading_diagonal';
  return patternType || 'unknown';
}

function isCorrectiveFamilyKey(familyKey) {
  return familyKey === 'wxy' || familyKey === 'abc';
}

function getScenarioFamilyLabel(scenario) {
  const familyKey = getScenarioFamilyKey(scenario);
  if (familyKey === 'leading_diagonal') return '引导楔形';
  if (familyKey === 'impulse_building') return '推进浪构建';
  if (familyKey === 'wave3_building') return '第3浪/C浪构建';
  if (familyKey === 'wave4_building') return '第4浪整理';
  if (familyKey === 'wxy') return '联合形（W-X-Y）';
  if (familyKey === 'abc') return 'ABC 调整';
  return scenario?.title || '候选结构';
}

function getScenarioSpan(scenario) {
  const start = getScenarioStartPrice(scenario);
  const end = getScenarioEndPrice(scenario);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.abs(end - start);
}

function compareScenarioPriority(a, b) {
  const scoreDiff = (Number(b?.confidenceScore) || 0) - (Number(a?.confidenceScore) || 0);
  if (Math.abs(scoreDiff) > 0.01) return scoreDiff;
  const lookbackDiff = (parseLookbackFromScale(b?.scale) || 0) - (parseLookbackFromScale(a?.scale) || 0);
  if (lookbackDiff !== 0) return lookbackDiff;
  return getScenarioSpan(b) - getScenarioSpan(a);
}

function pickRepresentativeScenario(scenarios) {
  if (!Array.isArray(scenarios) || scenarios.length === 0) return null;
  return scenarios.slice().sort(compareScenarioPriority)[0] || null;
}

function uniqSortedNumbers(values, direction = 'up') {
  const uniq = [];
  for (const value of values || []) {
    const num = Number(value);
    if (!Number.isFinite(num)) continue;
    if (uniq.some((existing) => Math.abs(existing - num) < 1)) continue;
    uniq.push(num);
  }
  return uniq.sort((a, b) => (direction === 'down' ? b - a : a - b));
}

function buildTargetBuckets(values, lastClose, direction = 'up') {
  const near = [];
  const mid = [];
  const far = [];
  for (const value of uniqSortedNumbers(values, direction)) {
    const distance = direction === 'down' ? lastClose - value : value - lastClose;
    if (!(distance > 0)) continue;
    if (distance <= 2000) {
      near.push(value);
    } else if (distance <= 5000) {
      mid.push(value);
    } else {
      far.push(value);
    }
  }
  return {
    near: near.slice(0, 3),
    mid: mid.slice(0, 3),
    far: far.slice(0, 3),
  };
}

function formatScenarioLegSummary(scenario) {
  const legs = Array.isArray(scenario?.waveLegs) ? scenario.waveLegs.slice(0, 7) : [];
  if (legs.length === 0) return '关键分段不足';
  return legs.map((leg) => {
    const name = leg?.name || '分段';
    const from = Number(leg?.from?.price);
    const to = Number(leg?.to?.price);
    if (Number.isFinite(from) && Number.isFinite(to)) {
      return `${name}：${fmt(from)} -> ${fmt(to)}`;
    }
    return name;
  }).join('；');
}

function buildScenarioCheckpointLine(scenario) {
  const parts = [];
  if (Number.isFinite(Number(scenario?.invalidation?.value))) {
    parts.push(`结构失效位：${fmt(scenario.invalidation.value)}`);
  }
  if (Number.isFinite(Number(scenario?.confirmation?.value))) {
    parts.push(`延续确认位：${fmt(scenario.confirmation.value)}`);
  }
  if (parts.length === 0) return '关键价位：暂无清晰失效/确认位。';
  return `${parts.join('；')}。`;
}

function buildScenarioTargetLine(scenario, lastClose) {
  const buckets = buildTargetBuckets(
    getScenarioTargetValues(scenario),
    lastClose,
    scenario?.direction === 'down' ? 'down' : 'up',
  );
  const prefix = scenario?.direction === 'down' ? '下方目标' : '上方目标';
  return `${prefix}：近端 ${formatTargetBucket(buckets.near)}；中继 ${formatTargetBucket(buckets.mid)}；延伸 ${formatTargetBucket(buckets.far)}。`;
}

function buildScenarioIntroLine(scenario) {
  const start = getScenarioStartPrice(scenario);
  const startLabel = Number.isFinite(start) ? fmt(start) : '当前可见起点';
  const familyKey = getScenarioFamilyKey(scenario);
  const directionLabel = scenario?.direction === 'down' ? '下行' : '上行';
  if (familyKey === 'leading_diagonal') {
    return `如果把 ${startLabel} 以来的走势视为${directionLabel}引导楔形，可按 1-2-3-4-5 结构继续跟踪。`;
  }
  if (familyKey === 'impulse_building') {
    return `如果把 ${startLabel} 以来的走势视为${directionLabel}推进浪，当前更像主趋势中的推动段。`;
  }
  if (familyKey === 'wave3_building') {
    return `如果把 ${startLabel} 以来的走势视为 1-2 完成后的延伸段，当前结构更偏向第3浪/C浪继续发展。`;
  }
  if (familyKey === 'wave4_building') {
    return '如果把前一段主趋势视为第3浪，当前更像第4浪的整理或回撤阶段。';
  }
  if (familyKey === 'wxy') {
    return `如果把 ${startLabel} 以来的走势视为${directionLabel}联合调整，当前结构可按 W-X-Y 继续推演。`;
  }
  if (familyKey === 'abc') {
    return `如果把 ${startLabel} 以来的走势视为${directionLabel}ABC 调整，当前结构可按 A-B-C 继续跟踪。`;
  }
  return `如果把 ${startLabel} 以来的走势视为“${getScenarioFamilyLabel(scenario)}”，当前结构仍可继续观察。`;
}

function buildScenarioStageLine(scenario) {
  const parts = [];
  if (scenario?.currentWave) parts.push(`当前浪位：${scenario.currentWave}`);
  if (scenario?.stage) parts.push(`阶段描述：${scenario.stage}`);
  if (parts.length === 0) return '当前阶段：浪位待确认。';
  return `${parts.join('；')}。`;
}

function buildManualAlternateNote(scenario, index, lastClose) {
  const numeral = ['一', '二', '三'][index] || String(index + 1);
  const score = Number.isFinite(Number(scenario?.confidenceScore))
    ? Number(scenario.confidenceScore).toFixed(1)
    : 'n/a';
  return {
    title: `备选结构${numeral}：${getScenarioFamilyLabel(scenario)}`,
    lines: [
      buildScenarioIntroLine(scenario),
      `关键分段：${formatScenarioLegSummary(scenario)}。`,
      `识别依据：${scenario?.title || getScenarioFamilyLabel(scenario)}，评分 ${score}。`,
      buildScenarioStageLine(scenario),
      buildScenarioCheckpointLine(scenario),
      buildScenarioTargetLine(scenario, lastClose),
    ],
  };
}

function pickContrastingScenario(representatives, primaryFamilyKey, preferredDirection) {
  const oppositeFamilies = isCorrectiveFamilyKey(primaryFamilyKey)
    ? ['leading_diagonal', 'wave3_building', 'impulse_building', 'wave4_building']
    : ['wxy', 'abc'];
  const candidates = oppositeFamilies
    .map((familyKey) => representatives.get(familyKey))
    .filter((scenario) => scenario && (!preferredDirection || scenario.direction === preferredDirection));
  if (candidates.length === 0) return null;

  const bestScore = Math.max(...candidates.map((scenario) => Number(scenario.confidenceScore) || 0));
  for (const familyKey of oppositeFamilies) {
    const scenario = representatives.get(familyKey);
    if (!scenario || (preferredDirection && scenario.direction !== preferredDirection)) continue;
    if ((Number(scenario.confidenceScore) || 0) >= bestScore - 15) return scenario;
  }
  return pickRepresentativeScenario(candidates);
}

function buildAnchoredDiagonalTargets(candidateScenarios, anchorPrice, lastClose, direction = 'up') {
  const relatedTargets = (candidateScenarios || [])
    .filter((scenario) => {
      if (!scenario || scenario.direction !== direction) return false;
      const start = getScenarioStartPrice(scenario);
      return Number.isFinite(start) && Math.abs(start - anchorPrice) <= 2500;
    })
    .flatMap((scenario) => getScenarioTargetValues(scenario));
  return buildTargetBuckets(relatedTargets, lastClose, direction);
}

function getScenarioTargetsDetailed(scenario) {
  return (scenario?.targets || [])
    .map((target) => ({
      name: target?.name || '目标位',
      note: target?.note || '参考目标',
      value: Number(target?.value),
    }))
    .filter((target) => Number.isFinite(target.value));
}

function buildAbcTargetAnchorSummary(scenario) {
  if (!scenario || scenario.patternType !== 'abc') return null;
  const legs = Array.isArray(scenario.waveLegs) ? scenario.waveLegs : [];
  if (legs.length < 3) return null;
  const legA = legs[0];
  const legB = legs[1];
  const legC = legs[2];
  const aFrom = Number(legA?.from?.price);
  const aTo = Number(legA?.to?.price);
  const bTo = Number(legB?.to?.price);
  const cFrom = Number(legC?.from?.price);

  if (![aFrom, aTo, bTo, cFrom].every(Number.isFinite)) return null;
  return `A浪 ${fmt(aFrom)} -> ${fmt(aTo)}；B浪回到 ${fmt(bTo)}；C浪自 ${fmt(cFrom)} 起算`;
}

function formatTargetReasonLabel(scenario, target) {
  const name = target?.name || '目标位';
  const note = target?.note || '参考目标';
  if (scenario?.patternType === 'abc') {
    const anchorSummary = buildAbcTargetAnchorSummary(scenario);
    if (anchorSummary) {
      return `${name}（${anchorSummary}）：${note}`;
    }
  }
  return `${name}：${note}`;
}

function findAnchoredScenario(candidateScenarios, anchorPrice, direction = 'up', patternTypes = null) {
  const matches = (candidateScenarios || []).filter((scenario) => {
    if (!scenario || scenario.direction !== direction) return false;
    if (Array.isArray(patternTypes) && !patternTypes.includes(scenario.patternType)) return false;
    const start = getScenarioStartPrice(scenario);
    return Number.isFinite(start) && Math.abs(start - anchorPrice) <= 2500;
  });
  if (matches.length === 0) return null;
  matches.sort((a, b) => (Number(b?.confidenceScore) || 0) - (Number(a?.confidenceScore) || 0));
  return matches[0];
}

function buildAnchoredTargetReasonSummary(candidateScenarios, anchorPrice, lastClose, direction = 'up', patternTypes = null) {
  const buckets = { near: [], mid: [], far: [] };
  for (const scenario of candidateScenarios || []) {
    if (!scenario || scenario.direction !== direction) continue;
    if (Array.isArray(patternTypes) && !patternTypes.includes(scenario.patternType)) continue;
    const start = getScenarioStartPrice(scenario);
    if (!(Number.isFinite(start) && Math.abs(start - anchorPrice) <= 2500)) continue;
    for (const target of getScenarioTargetsDetailed(scenario)) {
      const distance = direction === 'down' ? lastClose - target.value : target.value - lastClose;
      if (!(distance > 0)) continue;
      const bucketName = distance <= 2000 ? 'near' : distance <= 5000 ? 'mid' : 'far';
      buckets[bucketName].push(formatTargetReasonLabel(scenario, target));
    }
  }

  const summarize = (items, fallback) => {
    const uniq = [];
    for (const item of items) {
      if (!uniq.includes(item)) uniq.push(item);
    }
    if (uniq.length === 0) return fallback;
    return uniq.slice(0, 2).join('；');
  };

  return {
    near: summarize(buckets.near, '近端目标主要来自保守测算或短距离延伸。'),
    mid: summarize(buckets.mid, '中继目标主要来自等长或常见延伸测算。'),
    far: summarize(buckets.far, '延伸目标主要来自 1.272/1.618/2.0 倍扩展测算。'),
  };
}

function mergeTargetArrays(arrays, direction = 'up', limit = 3) {
  return uniqSortedNumbers((arrays || []).flatMap((items) => items || []), direction).slice(0, limit);
}

function getPullbackScenarioLabel(scenario) {
  if (!scenario) return '下行小结构';
  switch (scenario.patternType) {
    case 'wave3_building':
      return '下行第3浪/C浪构建';
    case 'abc':
      return '下行ABC';
    case 'wxy':
      return '下行WXY';
    case 'impulse':
      return '下行5浪';
    case 'wave4_building':
      return '下行第4浪构建';
    default:
      return scenario.title || '下行小结构';
  }
}

function formatPullbackScenarioSegments(scenario) {
  const legs = Array.isArray(scenario?.waveLegs) ? scenario.waveLegs : [];
  if (legs.length === 0) {
    const start = Number(getScenarioStartPrice(scenario));
    const end = Number(getScenarioEndPrice(scenario));
    if (Number.isFinite(start) && Number.isFinite(end)) {
      return `${fmt(start)} -> ${fmt(end)}`;
    }
    return '分段信息不足';
  }
  return legs
    .map((leg) => `${leg.name} ${fmt(Number(leg?.from?.price))} -> ${fmt(Number(leg?.to?.price))}`)
    .join('；');
}

function buildAnchoredPullbackSummary(candidateScenarios, anchorHigh, lastClose, structuralLevel, patternTypes = null) {
  const matchedScenarios = (candidateScenarios || []).filter((scenario) => {
    if (!scenario || scenario.direction !== 'down') return false;
    if (Array.isArray(patternTypes) && !patternTypes.includes(scenario.patternType)) return false;
    const start = getScenarioStartPrice(scenario);
    return Number.isFinite(start) && Math.abs(start - anchorHigh) <= 2500;
  });

  const firstTargets = uniqSortedNumbers(
    matchedScenarios
      .map((scenario) => Number(scenario?.confirmation?.value))
      .filter((value) => Number.isFinite(value) && value < lastClose),
    'down',
  ).slice(0, 3);

  const buckets = buildTargetBuckets(
    [
      ...matchedScenarios.flatMap((scenario) => getScenarioTargetValues(scenario)),
      ...(Number.isFinite(structuralLevel) ? [structuralLevel] : []),
    ],
    lastClose,
    'down',
  );

  const orderedReasonScenarios = matchedScenarios
    .filter((scenario) => Number.isFinite(Number(scenario?.confirmation?.value)) && Number(scenario.confirmation.value) < lastClose)
    .sort((a, b) => Number(b.confirmation.value) - Number(a.confirmation.value));

  const firstSourceEntries = [];
  const firstSourceDetailLines = [];
  for (const target of firstTargets) {
    const labels = [];
    const detailParts = [];
    for (const scenario of orderedReasonScenarios) {
      const confirmation = Number(scenario?.confirmation?.value);
      if (!Number.isFinite(confirmation) || Math.abs(confirmation - target) >= 1) continue;
      const start = Number(getScenarioStartPrice(scenario));
      const end = Number(getScenarioEndPrice(scenario));
      const span = Number.isFinite(start) && Number.isFinite(end)
        ? `（${fmt(start)} -> ${fmt(end)}）`
        : '';
      const label = `${getPullbackScenarioLabel(scenario)}${span}`;
      if (!labels.includes(label)) labels.push(label);
      const detail = `${getPullbackScenarioLabel(scenario)}：${formatPullbackScenarioSegments(scenario)}`;
      if (!detailParts.includes(detail)) detailParts.push(detail);
      if (labels.length >= 2) break;
    }
    if (labels.length > 0) {
      firstSourceEntries.push(`${fmt(target)} <- ${labels.join(' / ')}`);
    }
    if (detailParts.length > 0) {
      firstSourceDetailLines.push(`${fmt(target)}：${detailParts.join(' | ')}`);
    }
  }

  const firstReasons = [];
  for (const scenario of orderedReasonScenarios) {
    const confirmation = Number(scenario?.confirmation?.value);
    if (!Number.isFinite(confirmation) || confirmation >= lastClose) continue;
    const note = scenario?.confirmation?.note || `${scenario?.title || '下行结构'}确认后回调延续`;
    const label = `${fmt(confirmation)}：${note}`;
    if (!firstReasons.includes(label)) firstReasons.push(label);
    if (firstReasons.length >= 3) break;
  }

  const bucketReasons = buildAnchoredTargetReasonSummary(
    candidateScenarios,
    anchorHigh,
    lastClose,
    'down',
    patternTypes,
  );

  const deepTargets = mergeTargetArrays([buckets.mid, buckets.far], 'down', 4);
  const deepReasonBase = mergeTargetArrays([buckets.far], 'down', 1).length > 0
    ? `${bucketReasons.mid}；${bucketReasons.far}`
    : bucketReasons.mid;
  const deepReason = Number.isFinite(structuralLevel)
    ? `${deepReasonBase}；${fmt(structuralLevel)} 同时是结构起涨点/第二个 X 段低点回测位`
    : deepReasonBase;

  return {
    firstTargets,
    middleTargets: buckets.near,
    deepTargets,
    firstSourceEntries,
    firstSourceDetailLines,
    firstReason: firstReasons.slice(0, 2).join('；') || '先看离当前最近的下破确认位，再看更低一级确认位。',
    middleReason: bucketReasons.near,
    deepReason,
  };
}

function buildPullbackReasonPlainText(pullback, structuralLevel, endingLabel) {
  const first = Array.isArray(pullback?.firstTargets) ? pullback.firstTargets : [];
  const deep = Array.isArray(pullback?.deepTargets) ? pullback.deepTargets : [];
  const lines = [];

  if (first.length > 0) {
    lines.push(`为什么先看 ${fmt(first[0])}：这是离当前价格最近的一道下破确认位，最容易先被触发；先跌破它，才更像 ${endingLabel} 后的回调已经启动。`);
  }
  if (first.length > 1) {
    lines.push(`为什么再看 ${fmt(first[1])}：如果连这个更低的位置也跌破，说明回调不只是试探，而是在继续加深。`);
  }
  if (first.length > 2) {
    lines.push(`补充观察 ${fmt(first[2])}：这是更深一档的下行确认位，用来判断回调是否进一步扩展。`);
  }
  if (deep.length > 0) {
    lines.push(`深回调区看 ${formatTargetBucket(deep)}：这些位置来自等长或延伸测算，通常是回调扩大后更容易落脚的区域。`);
  }
  if (Number.isFinite(structuralLevel)) {
    lines.push(`极限支撑看 ${fmt(structuralLevel)}：这里是这段上涨的起点，也是整套结构是否还成立的关键位置。`);
  }

  return lines.join('；');
}

function resolveMajorManualStructureChain(analysis) {
  const pivots = Array.isArray(analysis?.pivotsMacro) ? analysis.pivotsMacro : [];
  const startPrice = Number(analysis?.low);
  const lastClose = Number(analysis?.lastClose);
  if (!Number.isFinite(startPrice) || !Number.isFinite(lastClose) || pivots.length < 4) return null;

  const highs = pivots.filter((pivot) => pivot.type === 'H');
  const lows = pivots.filter((pivot) => pivot.type === 'L');
  if (highs.length < 2 || lows.length < 2) return null;

  const wave1 = highs[0] || null;
  if (!wave1) return null;

  const wave3 = highs.find((pivot) => pivot.index > wave1.index && pivot.price > wave1.price);
  if (!wave3) return null;

  const wave2Candidates = lows.filter((pivot) => (
    pivot.index > wave1.index
    && pivot.index < wave3.index
    && pivot.price > startPrice
  ));
  if (wave2Candidates.length === 0) return null;
  const wave2 = wave2Candidates.reduce((min, pivot) => (pivot.price < min.price ? pivot : min), wave2Candidates[0]);

  const wave4Candidates = lows.filter((pivot) => (
    pivot.index > wave3.index
    && pivot.price > wave2.price
  ));
  if (wave4Candidates.length === 0) return null;
  const wave4 = wave4Candidates.reduce((min, pivot) => (pivot.price < min.price ? pivot : min), wave4Candidates[0]);

  if (!(wave3.price > wave1.price && wave2.price > startPrice && wave4.price > wave2.price)) return null;

  return {
    startPrice,
    lastClose,
    wave1,
    wave2,
    wave3,
    wave4,
  };
}

function buildMajorAnchoredDiagonalNote(analysis, candidateScenarios) {
  const chain = resolveMajorManualStructureChain(analysis);
  if (!chain) return null;
  const {
    startPrice, lastClose, wave1, wave2, wave3, wave4,
  } = chain;

  const targetBuckets = buildAnchoredDiagonalTargets(candidateScenarios, wave4.price, lastClose, 'up');
  const targetReasons = buildAnchoredTargetReasonSummary(
    candidateScenarios,
    wave4.price,
    lastClose,
    'up',
    ['impulse_building', 'wave3_building', 'abc'],
  );
  const anchoredAbc = findAnchoredScenario(candidateScenarios, wave4.price, 'up', ['abc']);
  const abcAnchorLine = anchoredAbc
    ? `ABC目标锚点：${buildAbcTargetAnchorSummary(anchoredAbc)}。`
    : null;
  const supportParts = [`结构失效位：${fmt(wave4.price)}`];
  const invalidationReason = `失效原因：若回落跌破第4浪低点 ${fmt(wave4.price)}，说明这段上涨已经不能继续按“第5浪延伸”来解释，引导楔形计数失效。`;
  const confirmLine = `延续条件：只要价格还站在第4浪低点 ${fmt(wave4.price)} 上方，并继续向上刷新第5浪高点，这套引导楔形计数就还能保留。`;
  const stageLine = '当前阶段：先把当前上涨按大级别第5浪候选跟踪。';

  return {
    title: '结构推演一：引导楔形',
    lines: [
      `如果把 ${fmt(startPrice)} 以来的走势视为上行引导楔形，可按 1-2-3-4-5 结构继续跟踪。`,
      `1浪：${fmt(startPrice)} -> ${fmt(wave1.price)}；2浪：${fmt(wave1.price)} -> ${fmt(wave2.price)}；3浪：${fmt(wave2.price)} -> ${fmt(wave3.price)}；4浪：${fmt(wave3.price)} -> ${fmt(wave4.price)}；5浪：${fmt(wave4.price)} -> 当前。`,
      '该解释下，第1、3、5浪都可按三段式推进处理，第1浪与第4浪允许重叠，符合引导楔形特征。',
      stageLine,
      `${supportParts.join('；')}。`,
      invalidationReason,
      confirmLine,
      abcAnchorLine,
      `第5浪上方目标：近端 ${formatTargetBucket(targetBuckets.near)}；中继 ${formatTargetBucket(targetBuckets.mid)}；延伸 ${formatTargetBucket(targetBuckets.far)}。`,
      `目标原因：近端看 ${targetReasons.near}；中继看 ${targetReasons.mid}；延伸看 ${targetReasons.far}`,
    ].filter(Boolean),
  };
}

function buildMajorAnchoredComboNote(analysis, candidateScenarios) {
  const chain = resolveMajorManualStructureChain(analysis);
  if (!chain) return null;
  const {
    startPrice, lastClose, wave1, wave2, wave3, wave4,
  } = chain;

  const comboTargets = buildAnchoredDiagonalTargets(
    (candidateScenarios || []).filter((scenario) => ['wxy', 'abc'].includes(scenario?.patternType)),
    wave4.price,
    lastClose,
    'up',
  );
  const targetReasons = buildAnchoredTargetReasonSummary(
    candidateScenarios,
    wave4.price,
    lastClose,
    'up',
    ['wxy', 'abc'],
  );
  const anchoredAbc = findAnchoredScenario(candidateScenarios, wave4.price, 'up', ['abc']);
  const abcAnchorLine = anchoredAbc
    ? `ABC目标锚点：${buildAbcTargetAnchorSummary(anchoredAbc)}。`
    : null;
  const supportParts = [`结构失效位：${fmt(wave4.price)}`];
  const invalidationReason = `失效原因：若回落跌破第二个 X 段低点 ${fmt(wave4.price)}，说明 ${fmt(wave4.price)} 以来这段上涨已经不能继续按“Z 段延伸”来解释，联合形计数失效。`;
  const confirmLine = `延续条件：只要价格还站在第二个 X 段低点 ${fmt(wave4.price)} 上方，并继续向上刷新 Z 段高点，这套联合形计数就还能保留。`;
  const stageLine = `当前阶段：先把 ${fmt(wave4.price)} 以来的上涨当作 Z 段候选跟踪。`;

  return {
    title: '结构推演二：联合形（W-X-Y-X-Z）',
    lines: [
      `如果把 ${fmt(startPrice)} 以来的走势视为联合形，这组拐点链更接近 W-X-Y-X-Z，而不是标准推动浪。`,
      `W段：${fmt(startPrice)} -> ${fmt(wave1.price)}；X段：${fmt(wave1.price)} -> ${fmt(wave2.price)}；Y段：${fmt(wave2.price)} -> ${fmt(wave3.price)}；X段：${fmt(wave3.price)} -> ${fmt(wave4.price)}；Z段：${fmt(wave4.price)} -> 当前。`,
      `该解释下，${fmt(wave4.price)} 之后的上涨归属于 Z 段，而不是大级别第5浪。`,
      stageLine,
      `${supportParts.join('；')}。`,
      invalidationReason,
      confirmLine,
      abcAnchorLine,
      `Z 段上方目标：近端 ${formatTargetBucket(comboTargets.near)}；中继 ${formatTargetBucket(comboTargets.mid)}；延伸 ${formatTargetBucket(comboTargets.far)}。`,
      `目标原因：近端看 ${targetReasons.near}；中继看 ${targetReasons.mid}；延伸看 ${targetReasons.far}`,
    ].filter(Boolean),
  };
}

function buildRepresentativeMap(scenarios) {
  const representatives = new Map();
  for (const scenario of scenarios || []) {
    const familyKey = getScenarioFamilyKey(scenario);
    const current = representatives.get(familyKey);
    if (!current || compareScenarioPriority(scenario, current) < 0) {
      representatives.set(familyKey, scenario);
    }
  }
  return representatives;
}

function pickRepresentativeByFamilyOrder(representatives, familyKeys, preferredDirection) {
  const matches = [];
  for (const familyKey of familyKeys) {
    const scenario = representatives.get(familyKey);
    if (!scenario) continue;
    if (preferredDirection && scenario.direction !== preferredDirection) continue;
    matches.push(scenario);
  }
  if (matches.length === 0) return null;
  return pickRepresentativeScenario(matches);
}

function collectScenarioLevelsAbovePrice(scenario, price, ceiling = Infinity) {
  const values = [];
  for (const level of scenario?.keyLevels || []) {
    const value = Number(level?.value);
    if (Number.isFinite(value) && value > price && value <= ceiling) values.push(value);
  }
  const invalidation = Number(scenario?.invalidation?.value);
  if (Number.isFinite(invalidation) && invalidation > price && invalidation <= ceiling) values.push(invalidation);
  const confirmation = Number(scenario?.confirmation?.value);
  if (Number.isFinite(confirmation) && confirmation > price && confirmation <= ceiling) values.push(confirmation);
  return uniqSortedNumbers(values, 'up');
}

function buildGenericPullbackBand(candidateScenarios, dominantScenario, direction, lastClose) {
  if (!dominantScenario || !direction || !Number.isFinite(lastClose)) return null;
  const span = Math.max(getScenarioSpan(dominantScenario), Math.abs(lastClose) * 0.08, 40);
  const sameDirectionScenarios = (candidateScenarios || []).filter((scenario) => (
    scenario
    && scenario.direction === direction
  ));
  if (sameDirectionScenarios.length === 0) return null;
  const nearScenarios = sameDirectionScenarios.filter((scenario) => {
    const lookback = parseLookbackFromScale(scenario?.scale);
    return !Number.isFinite(lookback) || lookback <= 8;
  });
  const relatedScenarios = nearScenarios.length > 0 ? nearScenarios : sameDirectionScenarios;

  const lowerFloor = lastClose + span * 0.25;
  const ceiling = lastClose + span * 0.5;
  const preferredTargetValues = uniqSortedNumbers(
    relatedScenarios.flatMap((scenario) => (scenario?.targets || [])
      .filter((target) => /1\.272|1\.618|扩展|延伸|强势|强延伸/.test(`${target?.name || ''}${target?.note || ''}`))
      .map((target) => Number(target?.value)))
      .filter((value) => value >= lowerFloor && value <= ceiling),
    'up',
  );
  const fallbackTargetValues = uniqSortedNumbers(
    relatedScenarios.flatMap((scenario) => getScenarioTargetValues(scenario))
      .filter((value) => value >= lowerFloor && value <= ceiling),
    'up',
  );
  const targetValues = preferredTargetValues.length > 0 ? preferredTargetValues : fallbackTargetValues;
  if (targetValues.length === 0) return null;

  const rawLow = targetValues[0];
  const bandWidthCap = Math.max(span * 0.14, Math.abs(lastClose) * 0.018, 35);
  const upperCandidates = uniqSortedNumbers(
    relatedScenarios.flatMap((scenario) => collectScenarioLevelsAbovePrice(scenario, lastClose, ceiling))
      .filter((value) => value >= rawLow && value <= rawLow + bandWidthCap),
    'up',
  );
  const rawHigh = upperCandidates.length > 0 ? upperCandidates[upperCandidates.length - 1] : Math.min(rawLow + bandWidthCap, ceiling);

  return {
    low: Math.floor(rawLow) - 1,
    high: Math.ceil(rawHigh) + 2,
    rawLow,
    rawHigh,
  };
}

function buildGenericMajorCyclePossibilityNote(meta, analysis, candidateScenarios) {
  const macro = analysis?.macroTrendPosition || null;
  const dominantScenario = macro?.dominantScenario || null;
  const dominantDirection = macro?.dominantDirection || dominantScenario?.direction || null;
  const lastClose = Number(analysis?.lastClose);
  if (!dominantScenario || !dominantDirection || !Number.isFinite(lastClose)) return null;

  const legs = Array.isArray(dominantScenario.waveLegs) ? dominantScenario.waveLegs : [];
  if (dominantDirection === 'down' && legs.length >= 3) {
    const firstLen = Math.abs(Number(legs[0]?.change));
    const thirdLen = Math.abs(Number(legs[2]?.change));
    const ratio = firstLen > 0 ? thirdLen / firstLen : null;
    const band = buildGenericPullbackBand(candidateScenarios, dominantScenario, dominantDirection, lastClose);
    const lines = [
      '从开始时间看，这里更像已经走了 3 段下跌。',
    ];
    if (Number.isFinite(ratio)) {
      if (ratio > 1.618) {
        lines.push(`其中第3段长度约为第1段的 ${ratio.toFixed(3)} 倍，已经超过 1.618，有发展为推动浪的风险。`);
      } else {
        lines.push(`其中第3段长度约为第1段的 ${ratio.toFixed(3)} 倍，暂时先按三段式下跌跟踪。`);
      }
    }
    if (band) {
      lines.push(`关注压力带 ${band.low}--${band.high}。`);
      lines.push('如果冲不过去，注意再次下跌的风险。');
    } else if (Number.isFinite(Number(dominantScenario.invalidation?.value))) {
      lines.push(`上方先关注 ${fmt(Number(dominantScenario.invalidation.value))} 一带。`);
      lines.push('如果反弹受阻，注意再次下跌的风险。');
    }
    return {
      title: '大周期可能性：空头剧本',
      lines,
    };
  }

  if (dominantDirection === 'up' && legs.length >= 3) {
    const firstLen = Math.abs(Number(legs[0]?.change));
    const thirdLen = Math.abs(Number(legs[2]?.change));
    const ratio = firstLen > 0 ? thirdLen / firstLen : null;
    const lines = [
      '从开始时间看，这里更像已经走了 3 段上涨。',
    ];
    if (Number.isFinite(ratio)) {
      if (ratio > 1.618) {
        lines.push(`其中第3段长度约为第1段的 ${ratio.toFixed(3)} 倍，已经超过 1.618，有发展为推动浪的风险。`);
      } else {
        lines.push(`其中第3段长度约为第1段的 ${ratio.toFixed(3)} 倍，暂时先按三段式上涨跟踪。`);
      }
    }
    if (Number.isFinite(Number(dominantScenario.invalidation?.value))) {
      lines.push(`下方先关注 ${fmt(Number(dominantScenario.invalidation.value))} 一带。`);
      lines.push('如果跌回去并失守，注意再次转弱的风险。');
    }
    return {
      title: '大周期可能性：多头剧本',
      lines,
    };
  }

  return null;
}

function buildCompletedImpulseReboundNote(meta, analysis, candidateScenarios) {
  const lastClose = Number(analysis?.lastClose);
  const rangeHigh = Number(analysis?.high);
  const rangeLow = Number(analysis?.low);
  if (!Number.isFinite(lastClose)) return null;

  const completedDownImpulses = (candidateScenarios || [])
    .filter((scenario) => (
      scenario
      && scenario.patternType === 'impulse'
      && scenario.direction === 'down'
      && /反弹/.test(`${scenario.currentWave || ''}${scenario.stage || ''}`)
    ));
  if (completedDownImpulses.length === 0) return null;

  const majorImpulse = completedDownImpulses.slice().sort((a, b) => {
    const startA = Number(getScenarioStartPrice(a));
    const startB = Number(getScenarioStartPrice(b));
    const distA = Number.isFinite(rangeHigh) && Number.isFinite(startA) ? Math.abs(startA - rangeHigh) : Number.POSITIVE_INFINITY;
    const distB = Number.isFinite(rangeHigh) && Number.isFinite(startB) ? Math.abs(startB - rangeHigh) : Number.POSITIVE_INFINITY;
    if (distA !== distB) return distA - distB;
    return compareScenarioPriority(a, b);
  })[0];
  if (!majorImpulse) return null;

  const localSupportScenario = completedDownImpulses
    .filter((scenario) => Number.isFinite(Number(scenario?.invalidation?.value)) && Number(scenario.invalidation.value) < lastClose)
    .sort((a, b) => Number(b.invalidation.value) - Number(a.invalidation.value))[0] || null;

  const reboundResistance = [
    ...(majorImpulse?.targets || []),
    ...(majorImpulse?.keyLevels || []),
  ]
    .map((level) => ({
      value: Number(level?.value),
      weight: /0\.382/.test(`${level?.name || ''}${level?.note || ''}`) ? 0
        : /0\.5|0\.500/.test(`${level?.name || ''}${level?.note || ''}`) ? 1
          : /0\.618/.test(`${level?.name || ''}${level?.note || ''}`) ? 2
            : /反弹阻力|回撤/.test(`${level?.name || ''}${level?.note || ''}`) ? 3
              : 10,
    }))
    .filter((item) => Number.isFinite(item.value) && item.value > lastClose)
    .sort((a, b) => (a.weight - b.weight) || (a.value - b.value))[0]?.value;

  const supportLevel = Number(localSupportScenario?.invalidation?.value);
  const fallbackResistance = collectScenarioLevelsAbovePrice(majorImpulse, lastClose)[0];
  const resistanceLevel = Number.isFinite(reboundResistance) ? reboundResistance : fallbackResistance;

  const deferredDownsideTarget = (majorImpulse?.targets || [])
    .map((target) => ({
      value: Number(target?.value),
      score: /1\.0xW1|等长/.test(`${target?.name || ''}${target?.note || ''}`) ? 0
        : /0\.618xW1/.test(`${target?.name || ''}${target?.note || ''}`) ? 1
          : 10,
    }))
    .filter((item) => Number.isFinite(item.value) && item.value < rangeLow)
    .sort((a, b) => (a.score - b.score) || (b.value - a.value))[0]?.value;

  const startPrice = Number(getScenarioStartPrice(majorImpulse));
  const impulseLine = Number.isFinite(startPrice)
    ? `从 ${fmt(startPrice)} 开始，算法更倾向这里已经走出完整的五段下跌，可先按向下推动浪跟踪。`
    : '算法更倾向这里已经走出完整的五段下跌，可先按向下推动浪跟踪。';
  const stageLine = majorImpulse?.momentumState === 'bullish_divergence'
    ? `当前浪位为「${majorImpulse.currentWave}」，末段出现动能背离，这段下跌更像已经结束，价格正在进入反弹修正。`
    : `当前浪位为「${majorImpulse.currentWave}」，这段下跌更像已经告一段落，价格正在进入反弹修正。`;

  const lines = [
    impulseLine,
    stageLine,
  ];

  if (Number.isFinite(supportLevel)) {
    lines.push(`短线只要维持在 ${fmt(supportLevel)} 上方，反弹仍有继续上冲的动力。`);
  }
  if (Number.isFinite(resistanceLevel)) {
    lines.push(`上方先关注 ${fmt(resistanceLevel)} 一带的反弹压力。`);
  }
  if (Number.isFinite(deferredDownsideTarget)) {
    lines.push(`但由于这轮下跌尚未完成对 ${fmt(deferredDownsideTarget)} 一带等长/扩展目标的测试，当前更偏反弹而不是反转，若反弹受阻仍要防范再次下探。`);
  } else if (Number.isFinite(Number(majorImpulse?.confirmation?.value))) {
    lines.push(`若反弹受阻，仍要防范再次回落测试 ${fmt(Number(majorImpulse.confirmation.value))} 一带。`);
  }

  return {
    title: '大周期可能性：五浪下跌后的反弹',
    lines,
  };
}

function buildManualAlternateStructureNotes(meta, analysis) {
  const patternScenarios = Array.isArray(analysis?.patternScenarios) ? analysis.patternScenarios : [];
  const lastClose = Number(analysis?.lastClose);
  if (patternScenarios.length === 0 || !Number.isFinite(lastClose)) return [];

  const candidateScenarios = patternScenarios.filter((scenario) => (
    scenario
    && ['impulse_building', 'wave3_building', 'wave4_building', 'wxy', 'abc', 'impulse'].includes(scenario.patternType)
  ));
  if (candidateScenarios.length === 0) return [];

  const completedImpulseNote = buildCompletedImpulseReboundNote(meta, analysis, candidateScenarios);
  if (completedImpulseNote) return [completedImpulseNote];

  const preferredDirection = 'up';
  const notes = [];

  const majorDiagonalNote = buildMajorAnchoredDiagonalNote(analysis, candidateScenarios);
  const majorComboNote = buildMajorAnchoredComboNote(analysis, candidateScenarios);

  if (preferredDirection === 'up' && majorDiagonalNote) notes.push(majorDiagonalNote);
  if (preferredDirection === 'up' && majorComboNote) notes.push(majorComboNote);

  if (notes.length === 0) {
    const genericNote = buildGenericMajorCyclePossibilityNote(meta, analysis, candidateScenarios);
    if (genericNote) notes.push(genericNote);
  }

  return notes.slice(0, 2);
}

function buildManualAlternateOnlyReport(meta, analysis) {
  const manualAlternateNotes = buildManualAlternateStructureNotes(meta, analysis);
  const lines = [];

  lines.push('## 数据概览');
  lines.push(`- 品种：${meta.product}`);
  lines.push(`- 周期：${meta.timeframe}`);
  lines.push(`- 时间范围（${REPORT_TZ_LABEL}）：${formatToUtcOffset(meta.startUtc)} ~ ${formatToUtcOffset(meta.endUtc)}`);
  lines.push(`- 样本数量：${analysis.candleCount} 根K线`);
  lines.push(`- 区间最高/最低：${fmt(analysis.high)} / ${fmt(analysis.low)}`);
  lines.push(`- 最新收盘：${fmt(analysis.lastClose)}（${formatToUtcOffset(analysis.lastTimeUtc)} ${REPORT_TZ_LABEL}）`);
  lines.push(`- 当前价格在区间位置：${fmtPctByRatio(analysis.rangePosition)}`);
  lines.push(`- 距离区间高点：${fmtPctByRatio(analysis.distanceToHighPct)}`);
  lines.push(`- 距离区间低点：${fmtPctByRatio(analysis.distanceToLowPct)}`);
  lines.push('');
  lines.push('## 算法结构推演');

  if (manualAlternateNotes.length === 0) {
    lines.push('');
    lines.push('- 当前条件下没有可输出的算法结构推演。');
    return lines.join('\n');
  }

  for (const note of manualAlternateNotes) {
    lines.push('');
    lines.push(`### ${note.title}`);
    for (const line of note.lines) {
      lines.push(`- ${line}`);
    }
  }

  return lines.join('\n');
}

function buildReport(meta, analysis) {
  const lines = [];

  lines.push('# K线波浪分析（增强版）');
  lines.push('');
  lines.push('## 数据概览');
  lines.push(`- 品种：${meta.product}`);
  lines.push(`- 周期：${meta.timeframe}`);
  lines.push(`- 时间范围（${REPORT_TZ_LABEL}）：${formatToUtcOffset(meta.startUtc)} ~ ${formatToUtcOffset(meta.endUtc)}`);
  lines.push(`- 样本数量：${analysis.candleCount} 根K线`);
  lines.push(`- 区间最高/最低：${fmt(analysis.high)} / ${fmt(analysis.low)}`);
  lines.push(`- 最新收盘：${fmt(analysis.lastClose)}（${formatToUtcOffset(analysis.lastTimeUtc)} ${REPORT_TZ_LABEL}）`);
  lines.push(`- 当前价格在区间位置：${fmtPctByRatio(analysis.rangePosition)}`);
  lines.push(`- 距离区间高点：${fmtPctByRatio(analysis.distanceToHighPct)}`);
  lines.push(`- 距离区间低点：${fmtPctByRatio(analysis.distanceToLowPct)}`);
  lines.push(`- 识别到的枢轴点（微观/宏观）：${analysis.pivotsMicro.length} / ${analysis.pivotsMacro.length}`);
  lines.push(`- 识别到的候选浪型：${analysis.allPatternCandidates.length}`);
  if (analysis.indicatorsMeta) {
    lines.push(`- ATR过滤：period=${analysis.indicatorsMeta.atrPeriod}, multiplier=${analysis.indicatorsMeta.atrMultiplier}`);
    lines.push(`- RSI参数：period=${analysis.indicatorsMeta.rsiPeriod}`);
  }
  if (analysis.lastPivot) {
    lines.push(`- 最近枢轴：${formatPivotPoint(analysis.lastPivot)}`);
  }
  lines.push('');

  lines.push('## 当前位置与可能趋势');
  lines.push(`- 当前位置：${analysis.currentPosition.rangeZone}`);
  lines.push(`- 关键位状态：${analysis.currentPosition.levelStatus}`);
  lines.push(`- 可能趋势：${analysis.trendOutlook.likely}`);
  lines.push(`- 趋势权重：偏多 ${analysis.trendOutlook.upPct.toFixed(1)}% / 偏空 ${analysis.trendOutlook.downPct.toFixed(1)}%`);
  lines.push(`- 判断依据：${analysis.trendOutlook.note}`);
  lines.push('');

  lines.push('## 多周期逐级浪位（从大到小）');
  if (analysis.multiScaleWavePositions?.levels?.length > 0) {
    const chain = analysis.multiScaleWavePositions;
    const anchorLabel = chain.anchorDirection === 'down' ? '偏空' : '偏多';
    const anchorLb = Number.isFinite(chain.anchorLookback) ? `lookback_${chain.anchorLookback}` : 'n/a';
    lines.push(`- 锚定方向：${anchorLabel}（来源：${anchorLb}）`);
    if (chain.note) {
      lines.push(`- 说明：${chain.note}`);
    }

    for (const level of chain.levels) {
      if (!level || level.status === 'missing') {
        lines.push(`- ${level?.scale || 'unknown'}：未识别到可用浪型`);
        continue;
      }
      const dirLabel = level.direction === 'down' ? '偏空' : '偏多';
      lines.push(`- ${level.scale}：${level.title} | 方向：${dirLabel} | 评分：${level.confidenceScore}`);
      lines.push(`  - 当前浪位：${level.currentWave || '浪位待确认'}`);
      if (level.stage) lines.push(`  - 阶段：${level.stage}`);
      if (Number.isFinite(level.barsSinceEnd)) lines.push(`  - 距结构终点：${level.barsSinceEnd} 根K线`);
      if (level.startPivot && level.endPivot) {
        lines.push(`  - 起止：${formatPivotPoint(level.startPivot)} -> ${formatPivotPoint(level.endPivot)}`);
      }
      lines.push(`  - 与大周期关系：${level.alignedWithMacro ? '同向' : '逆向'}`);
    }
  } else {
    lines.push('- 暂无可用的多周期逐级浪位信息。');
  }
  lines.push('');

  // ============= 新增：微观浪位定位 =============
  // 辅助函数：输出波浪划分（枢轴 + 浪段）
  const appendWaveSubdivision = (lines, waveLegs, pivots, indent = '') => {
    if (Array.isArray(pivots) && pivots.length > 0) {
      lines.push(`${indent}- 枢轴点划分：`);
      for (const p of pivots) {
        lines.push(`${indent}  - ${formatPivotPoint(p)}`);
      }
    }
    if (Array.isArray(waveLegs) && waveLegs.length > 0) {
      lines.push(`${indent}- 浪段路径：`);
      for (const leg of waveLegs) {
        lines.push(
          `${indent}  - ${leg.name}: ${formatPivotPoint(leg.from)} -> ${formatPivotPoint(leg.to)} | 价格变化=${fmtSigned(leg.change)} | 用时=${leg.bars} 根K线 | 均量=${fmt(leg.volumeAvg)}`,
        );
      }
    }
  };

  lines.push('## 微观浪位定位（现在正在走什么浪？）');
  if (analysis.microWavePosition) {
    const mp = analysis.microWavePosition;
    lines.push(`- 当前浪位：${mp.wave}`);
    lines.push(`- 阶段：${mp.stage}`);
    lines.push(`- 来源浪型：${mp.scenarioTitle}`);
    lines.push(`- 方向：${mp.direction === 'down' ? '偏空' : mp.direction === 'up' ? '偏多' : '未知'}`);
    lines.push(`- 置信度：${mp.confidenceScore}`);
    if (mp.narrative) {
      lines.push(`- 叙述：${mp.narrative}`);
    }
    appendWaveSubdivision(lines, mp.waveLegs, mp.pivots);
  } else {
    lines.push('- 暂无可靠的微观浪位定位信息。');
  }
  lines.push('');

  // ============= 新增：宏观趋势推演 =============
  lines.push('## 宏观趋势推演（处于更大一级趋势的什么位置？）');
  if (analysis.macroTrendPosition) {
    const mt = analysis.macroTrendPosition;
    const dominantLabel = mt.dominantDirection === 'up' ? '偏多' : '偏空';
    lines.push(`- 主导方向：${dominantLabel}（概率权重 ${mt.dominantProbabilityPct}%）`);
    if (mt.dominantScenario) {
      lines.push(`- 主导情景：${mt.dominantScenario.title}（评分 ${mt.dominantScenario.confidenceScore}）`);
      lines.push(`  - 阶段：${mt.dominantScenario.stage}`);
      lines.push(`  - 当前浪位：${mt.dominantScenario.currentWave}`);
      appendWaveSubdivision(lines, mt.dominantScenario.waveLegs, mt.dominantScenario.pivots, '  ');
    }
    lines.push(`- ${mt.note}`);
    lines.push('');

    // 多头路径
    lines.push('### 可能性一：多头剧本（更大级别上涨趋势修正结束，开启新升浪）');
    if (mt.bullishPath) {
      const bp = mt.bullishPath;
      lines.push(`- 浪型：${bp.title}（评分 ${bp.confidenceScore}）`);
      lines.push(`- 当前浪位：${bp.currentWave}`);
      if (bp.stage) lines.push(`- 阶段：${bp.stage}`);
      if (Number.isFinite(bp.triggerLevel)) lines.push(`- 确认触发位：${fmt(bp.triggerLevel)}`);
      if (Number.isFinite(bp.failureLevel)) lines.push(`- 失效点：${fmt(bp.failureLevel)}`);
      if (bp.narrative) lines.push(`- 解读：${bp.narrative}`);
      appendWaveSubdivision(lines, bp.waveLegs, bp.pivots);
    } else {
      lines.push('- 当前未识别到有效的多头浪型结构。');
    }
    lines.push('');

    // 空头路径
    lines.push('### 可能性二：空头剧本（复合调整浪中的反弹，随后还有下跌）');
    if (mt.bearishPath) {
      const br = mt.bearishPath;
      lines.push(`- 浪型：${br.title}（评分 ${br.confidenceScore}）`);
      lines.push(`- 当前浪位：${br.currentWave}`);
      if (br.stage) lines.push(`- 阶段：${br.stage}`);
      if (Number.isFinite(br.triggerLevel)) lines.push(`- 延续确认位：${fmt(br.triggerLevel)}`);
      if (Number.isFinite(br.failureLevel)) lines.push(`- 失效点：${fmt(br.failureLevel)}`);
      if (br.narrative) lines.push(`- 解读：${br.narrative}`);
      appendWaveSubdivision(lines, br.waveLegs, br.pivots);
    } else {
      lines.push('- 当前未识别到有效的空头浪型结构。');
    }
    lines.push('');

    // 破局点汇总
    lines.push('### 破局点');
    if (mt.breakpointNarrative) {
      lines.push(`- ${mt.breakpointNarrative}`);
    }
  } else {
    lines.push('- 暂无宏观趋势推演信息。');
  }
  lines.push('');

  // ============= 新增：跌破大级别浪型风险 =============
  lines.push('## 跌破大级别浪型风险评估');
  if (analysis.majorBreakRisk) {
    const risk = analysis.majorBreakRisk;
    const stateMap = {
      already_broken: '已跌破',
      high_risk: '高风险',
      medium_risk: '中风险',
      low_risk: '低风险',
    };
    lines.push(`- 参考浪型：${risk.referenceScenario}`);
    lines.push(`- 关键支撑位：${fmt(risk.breakLevel)}`);
    lines.push(`- 跌破概率：${risk.probabilityPct}%`);
    lines.push(`- 风险状态：${stateMap[risk.state] || risk.state}`);
    lines.push(`- 当前价距该位置：${risk.distanceToLevelPct}%`);
    lines.push(`- 空头权重贡献：${risk.bearishWeightPct}%`);
    lines.push(`- 说明：${risk.note}`);
  } else {
    lines.push('- 暂无大级别浪型跌破风险数据（可能缺少有效的多头参考浪型）。');
  }
  lines.push('');

  lines.push('## 主情景判断');
  lines.push(`- 主浪型：${analysis.primaryScenario?.title || patternTitle(analysis.primaryPattern)}`);
  lines.push(`- 当前阶段：${analysis.stage}`);
  if (analysis.primaryScenario) {
    lines.push(`- 方向倾向：${analysis.primaryScenario.bias}`);
    lines.push(`- 当前浪位：${analysis.primaryScenario.currentWave}`);
    lines.push(`- 结构来源：${analysis.primaryScenario.scale === 'macro' ? '宏观枢轴' : '微观枢轴'}`);
    lines.push(`- 结构评分（0-100）：${analysis.primaryScenario.confidenceScore}`);
    lines.push(`- 距离主结构终点：${analysis.primaryScenario.barsSinceEnd} 根K线`);
  }

  if (analysis.primaryScenario?.waveLegs?.length > 0) {
    lines.push('- 主结构浪段（从哪里到哪里，属于哪一浪）：');
    for (const leg of analysis.primaryScenario.waveLegs) {
      lines.push(
        `  - ${leg.name}: ${formatPivotPoint(leg.from)} -> ${formatPivotPoint(leg.to)} | 价格变化=${fmtSigned(leg.change)} | 用时=${leg.bars} 根K线 | 均量=${fmt(leg.volumeAvg)}`,
      );
    }
  }

  if (analysis.primaryScenario?.pivots?.length > 0) {
    lines.push('- 主结构枢轴：');
    for (const p of analysis.primaryScenario.pivots) {
      lines.push(`  - ${formatPivotPoint(p)}`);
    }
  }

  if (analysis.primaryScenario?.metrics?.length > 0) {
    lines.push('- 结构比例：');
    for (const m of analysis.primaryScenario.metrics) {
      lines.push(`  - ${m.name}: ${m.value}`);
    }
  }
  lines.push('');

  // ============= WXY 联合修正前瞻叙述 =============
  const manualAlternateNotes = buildManualAlternateStructureNotes(meta, analysis);
  if (manualAlternateNotes.length > 0) { /*
    lines.push('## 鎵嬪伐澶囬€夌粨鏋勬帹婕?);
    for (const note of manualAlternateNotes) {
      lines.push('');
      lines.push(`### ${note.title}`);
      for (const line of note.lines) {
        lines.push(`- ${line}`);
      }
    }
    lines.push('');
  }

  */
  }
  if (manualAlternateNotes.length > 0) {
    lines.push('## 算法结构推演');
    for (const note of manualAlternateNotes) {
      lines.push('');
      lines.push(`### ${note.title}`);
      for (const line of note.lines) {
        lines.push(`- ${line}`);
      }
    }
    lines.push('');
  }

  const wxyNarratives = [];
  // 先从主情景提取
  if (analysis.primaryScenario?.wxyNarrative) {
    wxyNarratives.push(analysis.primaryScenario.wxyNarrative);
  }
  // 再从所有候选情景提取（去重，基于起始价格）
  const seenStarts = new Set(wxyNarratives.map((n) => fmt(n.startPrice)));
  for (const s of analysis.patternScenarios || []) {
    if (s.wxyNarrative && !seenStarts.has(fmt(s.wxyNarrative.startPrice))) {
      wxyNarratives.push(s.wxyNarrative);
      seenStarts.add(fmt(s.wxyNarrative.startPrice));
    }
  }

  if (wxyNarratives.length > 0) {
    lines.push('## WXY联合修正前瞻');
    for (const narr of wxyNarratives) {
      lines.push('');
      for (const line of narr.narrativeLines) {
        lines.push(`- ${line}`);
      }
    }
    lines.push('');
  }

  lines.push('## 可能浪型（按优先级）');
  if (analysis.patternScenarios.length === 0) {
    lines.push('- 暂未识别出可用浪型，请扩大时间范围或调整 --lookback。');
  } else {
    analysis.patternScenarios.forEach((scenario, idx) => {
      lines.push(`${idx + 1}. ${scenario.title} | 倾向：${scenario.bias} | 评分：${scenario.confidenceScore}`);
      lines.push(`   - 阶段：${scenario.stage}`);
      lines.push(`   - 当前浪位：${scenario.currentWave}`);
      lines.push(`   - 枢轴级别：${scenario.scale === 'macro' ? '宏观' : '微观'}`);
      if (scenario.momentumState && scenario.momentumState !== 'n/a') {
        lines.push(`   - 动能信号：${scenario.momentumState}`);
      }
      if (scenario.waveLegs.length > 0) {
        lines.push('   - 各阶段起点/终点：');
        for (const leg of scenario.waveLegs) {
          lines.push(
            `     - ${leg.name}: 起点 ${formatPivotPoint(leg.from)} | 终点 ${formatPivotPoint(leg.to)} | 价格变化=${fmtSigned(leg.change)} | 用时=${leg.bars} 根K线 | 均量=${fmt(leg.volumeAvg)}`,
          );
        }
      }
      if (scenario.invalidation) {
        lines.push(`   - 失效点：${fmt(scenario.invalidation.value)}（${scenario.invalidation.note}）`);
      }
      if (scenario.confirmation) {
        lines.push(`   - 确认位：${fmt(scenario.confirmation.value)}（${scenario.confirmation.note}）`);
      }
      if (scenario.targets.length > 0) {
        const briefTargets = scenario.targets.slice(0, 3)
          .map((t) => `${t.name}=${fmt(t.value)}`)
          .join('；');
        lines.push(`   - 目标位：${briefTargets}`);
      }
      if (scenario.wxyNarrative) {
        lines.push(`   - WXY前瞻：${scenario.wxyNarrative.narrativeLines[0]}${scenario.wxyNarrative.narrativeLines[1]}`);
      }
    });
  }

  if (analysis.keyLevels.length > 0) {
    lines.push('');
    lines.push('## 主情景关键价位');
    for (const k of analysis.keyLevels) {
      lines.push(`- ${k.name}：${fmt(k.value)}（${k.note}）`);
    }
  }

  if (analysis.targets.length > 0) {
    lines.push('');
    lines.push('## 主情景目标位');
    for (const t of analysis.targets) {
      lines.push(`- ${t.name}：${fmt(t.value)}（${t.note || '参考目标'}）`);
    }
  }

  if (analysis.tradingSetup) {
    const ts = analysis.tradingSetup;
    lines.push('');
    lines.push('## 交易策略执行模块（Trading Setup）');
    lines.push(`- 执行状态：${ts.status === 'ready' ? 'Ready（可执行）' : 'Wait（观望）'}`);
    lines.push(`- 执行结论：${ts.reason}`);
    lines.push(`- 盈亏比阈值：${ts.rrThreshold}`);
    if (ts.boundary) {
      lines.push(`- 结构边界：失效点 ${fmt(ts.boundary.invalidation)} / 确认位 ${fmt(ts.boundary.confirmation)}`);
      lines.push(`- 硬止损（Hard SL）：${fmt(ts.hardStop)}`);
    }
    if (ts.zone) {
      lines.push(`- 区域状态：${ts.zone.inNoMansLand ? 'No Mans Land（中段噪音区）' : '非中段噪音区'}`);
    }
    if (Array.isArray(ts.plans) && ts.plans.length > 0) {
      lines.push('- 挂单计划：');
      ts.plans.forEach((plan, idx) => {
        const passLabel = plan.pass ? '通过' : '未通过';
        lines.push(`  ${idx + 1}. ${plan.name} | ${plan.type} | 过滤：${passLabel}`);
        if (plan.entryZone) {
          lines.push(`     - Entry 区间：${fmt(plan.entryZone.low)} ~ ${fmt(plan.entryZone.high)}（中值 ${fmt(plan.entry)}）`);
        } else {
          lines.push(`     - Entry：${fmt(plan.entry)}`);
        }
        lines.push(`     - SL：${fmt(plan.stop)} | TP1：${fmt(plan.tp1)} | TP2：${fmt(plan.tp2)}`);
        lines.push(`     - R:R（TP1/TP2）：${plan.rrToTp1 ?? 'n/a'} / ${plan.rrToTp2 ?? 'n/a'}（best=${plan.rrBest}）`);
      });
    }
    if (ts.recommendedPlan) {
      const rp = ts.recommendedPlan;
      lines.push(`- 推荐执行：${rp.name}（${rp.type}），best R:R=${rp.rrBest}`);
    } else {
      lines.push('- 推荐执行：暂无（等待价格靠近边界或触发更优盈亏比）');
    }
  }

  lines.push('');
  lines.push('## 说明');
  lines.push('- 本报告基于局部枢轴的自动化艾略特波浪估计，属于概率推演，不构成投资建议。');
  lines.push('- 失效点用于否定当前计数；确认位用于验证结构延续，建议结合成交量与趋势过滤器。');

  return lines.join('\n');
}

/**
 * 精简版报告：只输出一个大周期浪型。
 * 从最大 lookback 层级中取主导浪型，一目了然。
 */
function buildMacroReport(meta, analysis) {
  const lines = [];

  lines.push('# 大周期浪型分析');
  lines.push('');
  lines.push(`| 项目 | 值 |`);
  lines.push(`|------|-----|`);
  lines.push(`| 品种 | ${meta.product} |`);
  lines.push(`| 周期 | ${meta.timeframe} |`);
  lines.push(`| 时间范围 | ${formatToUtcOffset(meta.startUtc)} ~ ${formatToUtcOffset(meta.endUtc)}（${REPORT_TZ_LABEL}）|`);
  lines.push(`| K线数量 | ${analysis.candleCount} |`);
  lines.push(`| 区间 | ${fmt(analysis.low)} ~ ${fmt(analysis.high)} |`);
  lines.push(`| 最新收盘 | **${fmt(analysis.lastClose)}**（${formatToUtcOffset(analysis.lastTimeUtc)}）|`);
  lines.push(`| 区间位置 | ${fmtPctByRatio(analysis.rangePosition)} |`);
  lines.push('');

  // ─── 找到最大周期的那个浪型 ───
  // 优先用 multiScaleWavePositions 的第一个（最大 lookback），否则用 macroTrendPosition.dominantScenario
  let macroWave = null;

  if (analysis.multiScaleWavePositions?.levels?.length > 0) {
    // 第一个是最大 lookback
    const biggestLevel = analysis.multiScaleWavePositions.levels.find((l) => l && l.status !== 'missing');
    if (biggestLevel) {
      macroWave = {
        title: biggestLevel.title,
        direction: biggestLevel.direction,
        score: biggestLevel.confidenceScore,
        currentWave: biggestLevel.currentWave,
        stage: biggestLevel.stage,
        scale: biggestLevel.scale,
        startPivot: biggestLevel.startPivot,
        endPivot: biggestLevel.endPivot,
        barsSinceEnd: biggestLevel.barsSinceEnd,
        waveLegs: biggestLevel.waveLegs || [],
        pivots: biggestLevel.pivots || [],
      };
    }
  }

  // 如果 multiScale 没有，用 macroTrendPosition
  if (!macroWave && analysis.macroTrendPosition?.dominantScenario) {
    const ds = analysis.macroTrendPosition.dominantScenario;
    macroWave = {
      title: ds.title,
      direction: analysis.macroTrendPosition.dominantDirection,
      score: ds.confidenceScore,
      currentWave: ds.currentWave,
      stage: ds.stage,
      scale: 'macro',
      waveLegs: ds.waveLegs || [],
      pivots: ds.pivots || [],
    };
  }

  // 最后 fallback 到 primaryScenario
  if (!macroWave && analysis.primaryScenario) {
    const ps = analysis.primaryScenario;
    macroWave = {
      title: ps.title,
      direction: ps.direction,
      score: ps.confidenceScore,
      currentWave: ps.currentWave,
      stage: ps.stage || analysis.stage,
      scale: ps.scale,
      waveLegs: ps.waveLegs || [],
      pivots: ps.pivots || [],
    };
  }

  lines.push('## 大周期浪型');
  if (macroWave) {
    const dirEmoji = macroWave.direction === 'down' ? '🔴' : '🟢';
    const dirText = macroWave.direction === 'down' ? '偏空' : '偏多';
    lines.push('');
    lines.push(`> **${dirEmoji} ${macroWave.title}**（${macroWave.scale}）`);
    lines.push('');
    lines.push(`| 项目 | 值 |`);
    lines.push(`|------|-----|`);
    lines.push(`| 方向 | ${dirEmoji} ${dirText} |`);
    lines.push(`| 评分 | ${macroWave.score} |`);
    lines.push(`| 当前浪位 | **${macroWave.currentWave || '待确认'}** |`);
    lines.push(`| 阶段 | ${macroWave.stage || '-'} |`);
    if (macroWave.startPivot && macroWave.endPivot) {
      lines.push(`| 起点 | ${formatPivotPoint(macroWave.startPivot)} |`);
      lines.push(`| 终点 | ${formatPivotPoint(macroWave.endPivot)} |`);
    }
    if (Number.isFinite(macroWave.barsSinceEnd)) {
      lines.push(`| 距结构终点 | ${macroWave.barsSinceEnd} 根K线 |`);
    }
    lines.push('');

    // ─── 浪段划分 ───
    if (macroWave.waveLegs.length > 0) {
      lines.push('### 浪段划分');
      lines.push('');
      lines.push('| 浪段 | 起点 | 终点 | 价格变化 | K线数 | 均量 |');
      lines.push('|------|------|------|----------|-------|------|');
      for (const leg of macroWave.waveLegs) {
        const fromStr = `${leg.from.type}@${fmt(leg.from.price)}`;
        const toStr = `${leg.to.type}@${fmt(leg.to.price)}`;
        lines.push(`| **${leg.name}** | ${fromStr} | ${toStr} | ${fmtSigned(leg.change)} | ${leg.bars} | ${fmt(leg.volumeAvg)} |`);
      }
      lines.push('');
    }
  } else {
    lines.push('- 暂未识别到大周期浪型。');
  }
  lines.push('');

  // ─── 关键价位（简洁汇总）───
  const hasLevels = analysis.primaryScenario?.invalidation || analysis.primaryScenario?.confirmation || analysis.targets?.length > 0;
  if (hasLevels) {
    lines.push('## 关键价位');
    lines.push('');
    lines.push(`| 类型 | 价格 | 说明 |`);
    lines.push(`|------|------|------|`);
    if (analysis.primaryScenario?.invalidation) {
      const inv = analysis.primaryScenario.invalidation;
      lines.push(`| ❌ 失效点 | ${fmt(inv.value)} | ${inv.note} |`);
    }
    if (analysis.primaryScenario?.confirmation) {
      const conf = analysis.primaryScenario.confirmation;
      lines.push(`| ✅ 确认位 | ${fmt(conf.value)} | ${conf.note} |`);
    }
    if (analysis.targets?.length > 0) {
      for (const t of analysis.targets.slice(0, 3)) {
        lines.push(`| 🎯 ${t.name} | ${fmt(t.value)} | ${t.note || '参考目标'} |`);
      }
    }
    lines.push('');
  }

  // ─── 跌破风险（一行汇总）───
  if (analysis.majorBreakRisk) {
    const risk = analysis.majorBreakRisk;
    const stateMap = {
      already_broken: '🔴 已跌破',
      high_risk: '🟠 高风险',
      medium_risk: '🟡 中风险',
      low_risk: '🟢 低风险',
    };
    lines.push(`> **跌破风险**：${stateMap[risk.state] || risk.state} — 支撑位 ${fmt(risk.breakLevel)}，${risk.note}`);
    lines.push('');
  }

  lines.push('---');
  lines.push('*本报告基于自动化艾略特波浪估计，属于概率推演，不构成投资建议。*');

  return lines.join('\n');
}

function buildHtmlDashboard(payload) {
  const previewData = {
    meta: payload.meta,
    candles: payload.candles.map((c) => ({
      timestamp: c.timestamp,
      timeUtc: c.timeUtc,
      timeUtc8: c.timeUtc8,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    })),
    analysis: {
      stage: payload.analysis.stage,
      trendOutlook: payload.analysis.trendOutlook,
      currentPosition: payload.analysis.currentPosition,
      primaryScenario: payload.analysis.primaryScenario,
      keyLevels: payload.analysis.keyLevels,
      targets: payload.analysis.targets,
      patternScenarios: (payload.analysis.patternScenarios || [])
        .slice(0, 12)
        .map((s) => ({
          title: s.title,
          direction: s.direction,
          bias: s.bias,
          confidenceScore: s.confidenceScore,
          stage: s.stage,
          currentWave: s.currentWave,
        })),
      microWavePosition: payload.analysis.microWavePosition || null,
      macroTrendPosition: payload.analysis.macroTrendPosition || null,
      multiScaleWavePositions: payload.analysis.multiScaleWavePositions || null,
      majorBreakRisk: payload.analysis.majorBreakRisk || null,
    },
  };

  const safeJson = JSON.stringify(previewData).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>K线波浪分析看板</title>
  <script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0b1020; color: #d8def2; }
    .wrap { display: grid; grid-template-columns: 1fr 360px; gap: 12px; height: 100vh; padding: 12px; box-sizing: border-box; }
    #chart { width: 100%; height: calc(100vh - 24px); border: 1px solid #26314f; border-radius: 8px; background: #111933; }
    .panel { overflow: auto; border: 1px solid #26314f; border-radius: 8px; background: #111933; padding: 12px; }
    h2 { margin: 0 0 10px; font-size: 18px; }
    h3 { margin: 14px 0 8px; font-size: 14px; color: #9fb0e8; }
    .kv { margin: 0 0 8px; font-size: 13px; line-height: 1.5; }
    .tag { display: inline-block; padding: 1px 6px; border-radius: 12px; font-size: 11px; background: #22315a; color: #c9d5ff; margin-left: 6px; }
    ul { margin: 6px 0 0 18px; padding: 0; font-size: 12px; line-height: 1.5; }
    li { margin-bottom: 6px; }
    .muted { color: #94a2c9; }
    .good { color: #34d399; }
    .bad { color: #f87171; }
    .warn { color: #fbbf24; }
    .section-box { background: #151e3a; border: 1px solid #26314f; border-radius: 6px; padding: 10px 12px; margin: 8px 0; font-size: 12px; line-height: 1.6; }
    .section-box p { margin: 4px 0; }
    .path-label { display: inline-block; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; margin-bottom: 4px; }
    .path-bull { background: #064e3b; color: #34d399; }
    .path-bear { background: #4c0519; color: #f87171; }
    .risk-badge { display: inline-block; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; }
    .risk-low { background: #064e3b; color: #34d399; }
    .risk-medium { background: #713f12; color: #fbbf24; }
    .risk-high { background: #4c0519; color: #f87171; }
    .risk-broken { background: #7f1d1d; color: #fecaca; }
    .narrative { color: #b8c4e3; font-style: italic; margin-top: 4px; }
    h4 { margin: 10px 0 6px; font-size: 13px; color: #7d8ec5; }
  </style>
</head>
<body>
  <div class="wrap">
    <div id="chart"></div>
    <div class="panel">
      <h2>K线波浪分析看板</h2>
      <div id="meta" class="kv"></div>
      <div id="trend" class="kv"></div>
      <div id="stage" class="kv"></div>
      <h3>微观浪位定位</h3>
      <div id="micro-wave" class="section-box"></div>
      <h3>宏观趋势推演</h3>
      <div id="macro-trend" class="section-box"></div>
      <h3>跌破大级别风险</h3>
      <div id="break-risk" class="section-box"></div>
      <h3>主情景关键价位</h3>
      <ul id="levels"></ul>
      <h3>主情景目标位</h3>
      <ul id="targets"></ul>
      <h3>候选浪型 Top 12</h3>
      <ul id="scenarios"></ul>
      <p class="muted">提示：驱动浪仅用数字标记（如 1-2-3-4-5 / (1)-(2)-(3)-(4)-(5) / I-II-III-IV-V），避免与 a-b-c 调整浪混淆。</p>
    </div>
  </div>
  <script id="dashboard-data" type="application/json">${safeJson}</script>
  <script>
    (function () {
      const payload = JSON.parse(document.getElementById('dashboard-data').textContent);
      const candles = payload.candles || [];
      if (!candles.length) return;

      const meta = payload.meta || {};
      const analysis = payload.analysis || {};
      const primary = analysis.primaryScenario || null;
      const labels = candles.map((c) => c.timeUtc8 || c.timeUtc || new Date(c.timestamp * 1000).toISOString());
      const kData = candles.map((c) => [Number(c.open), Number(c.close), Number(c.low), Number(c.high)]);
      const volumeData = candles.map((c) => Number(c.volume) || 0);
      const xCount = labels.length;

      const toImpulseLabel = (n, style) => {
        if (n === 0) return '0';
        const roman = ['', 'I', 'II', 'III', 'IV', 'V'];
        if (style === 'roman') return roman[n] || String(n);
        if (style === 'bracket') return '(' + String(n) + ')';
        return String(n);
      };

      const buildPivotLabels = (scenario, count) => {
        const fallback = Array.from({ length: count }, (_, i) => String(i + 1));
        if (!scenario || count <= 0) return fallback;
        const type = scenario.patternType;
        const scale = scenario.scale;

        if (type === 'impulse' || type === 'impulse_building' || type === 'wave3_building' || type === 'wave4_building') {
          const style = scale === 'macro' ? 'roman' : (scale === 'micro' ? 'bracket' : 'arabic');
          const out = ['0'];
          for (let i = 1; i < count; i += 1) out.push(toImpulseLabel(i, style));
          return out;
        }

        if (type === 'abc') {
          const alpha = scale === 'macro' ? ['0', 'A', 'B', 'C'] : ['0', 'a', 'b', 'c'];
          return alpha.slice(0, count);
        }

        if (type === 'wxy') {
          const alpha = scale === 'macro'
            ? ['0', 'W-A', 'W-B', 'W-C', 'X-A', 'X-B', 'X-C', 'Y-A', 'Y-B', 'Y-C']
            : ['0', 'w-a', 'w-b', 'w-c', 'x-a', 'x-b', 'x-c', 'y-a', 'y-b', 'y-c'];
          return alpha.slice(0, count);
        }

        return fallback;
      };

      const pivotLine = new Array(xCount).fill(null);
      const pivotScatter = [];
      if (primary && Array.isArray(primary.pivots)) {
        const pivotLabels = buildPivotLabels(primary, primary.pivots.length);
        primary.pivots.forEach((p, i) => {
          if (Number.isInteger(p.index) && p.index >= 0 && p.index < xCount) {
            pivotLine[p.index] = Number(p.price);
            pivotScatter.push({
              value: [p.index, Number(p.price)],
              label: {
                show: true,
                formatter: String(pivotLabels[i] || (i + 1)),
                position: p.type === 'H' ? 'top' : 'bottom',
                color: '#f8fafc',
                fontWeight: 'bold',
              },
            });
          }
        });
      }

      const levelLines = [];
      const addLevelLine = (name, value, color, dashed) => {
        if (!Number.isFinite(value)) return;
        levelLines.push({
          name,
          type: 'line',
          data: [[0, value], [xCount - 1, value]],
          symbol: 'none',
          lineStyle: { color, width: 1.6, type: dashed ? 'dashed' : 'solid' },
          showSymbol: false,
          emphasis: { disabled: true },
          tooltip: { valueFormatter: (v) => Number(v).toFixed(2) },
        });
      };

      if (primary && primary.invalidation) addLevelLine('失效点', Number(primary.invalidation.value), '#ef4444', false);
      if (primary && primary.confirmation) addLevelLine('确认位', Number(primary.confirmation.value), '#22c55e', false);
      (analysis.targets || []).slice(0, 5).forEach((t, i) => addLevelLine(t.name || ('目标' + (i + 1)), Number(t.value), '#f59e0b', true));

      const chart = echarts.init(document.getElementById('chart'));
      const option = {
        animation: false,
        backgroundColor: '#111933',
        legend: {
          top: 8,
          textStyle: { color: '#9fb0e8' },
          data: ['K线', '主浪枢轴', '枢轴点', '成交量'].concat(levelLines.map((s) => s.name)),
        },
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'cross' },
        },
        axisPointer: { link: [{ xAxisIndex: [0, 1] }] },
        dataZoom: [
          { type: 'inside', xAxisIndex: [0, 1], start: 72, end: 100 },
          { type: 'slider', xAxisIndex: [0, 1], bottom: 2, height: 18, borderColor: '#26314f', textStyle: { color: '#9fb0e8' } },
        ],
        grid: [
          { left: 56, right: 18, top: 44, height: '64%' },
          { left: 56, right: 18, top: '74%', height: '16%' },
        ],
        xAxis: [
          {
            type: 'category',
            data: labels,
            boundaryGap: true,
            axisLine: { lineStyle: { color: '#3d4b74' } },
            axisLabel: { color: '#9fb0e8' },
            splitLine: { show: false },
          },
          {
            type: 'category',
            gridIndex: 1,
            data: labels,
            boundaryGap: true,
            axisLine: { lineStyle: { color: '#3d4b74' } },
            axisLabel: { show: false },
            axisTick: { show: false },
            splitLine: { show: false },
          },
        ],
        yAxis: [
          {
            scale: true,
            axisLine: { lineStyle: { color: '#3d4b74' } },
            axisLabel: { color: '#9fb0e8' },
            splitLine: { lineStyle: { color: '#1e2a4b' } },
          },
          {
            gridIndex: 1,
            scale: true,
            axisLine: { lineStyle: { color: '#3d4b74' } },
            axisLabel: { color: '#9fb0e8' },
            splitLine: { show: false },
          },
        ],
        series: [
          {
            name: 'K线',
            type: 'candlestick',
            data: kData,
            itemStyle: {
              color: '#22c55e',
              color0: '#ef4444',
              borderColor: '#22c55e',
              borderColor0: '#ef4444',
            },
          },
          {
            name: '主浪枢轴',
            type: 'line',
            data: pivotLine,
            connectNulls: true,
            symbol: 'circle',
            symbolSize: 6,
            lineStyle: { color: '#38bdf8', width: 2.2 },
            itemStyle: { color: '#38bdf8' },
            z: 4,
          },
          {
            name: '枢轴点',
            type: 'scatter',
            data: pivotScatter,
            symbolSize: 10,
            itemStyle: { color: '#f59e0b' },
            z: 5,
          },
          {
            name: '成交量',
            type: 'bar',
            xAxisIndex: 1,
            yAxisIndex: 1,
            data: volumeData,
            itemStyle: {
              color: function (params) {
                const idx = params.dataIndex;
                return kData[idx][1] >= kData[idx][0] ? '#22c55e99' : '#ef444499';
              },
            },
          },
        ].concat(levelLines),
      };
      chart.setOption(option);
      window.addEventListener('resize', function () { chart.resize(); });

      const metaText = '品种: ' + (meta.product || '-') + ' | 周期: ' + (meta.timeframe || '-') + ' | 范围: ' + (meta.startUtc || '-') + ' ~ ' + (meta.endUtc || '-');
      document.getElementById('meta').textContent = metaText;
      const trend = analysis.trendOutlook || {};
      document.getElementById('trend').innerHTML = '趋势: <span class="' + ((trend.downPct || 0) > (trend.upPct || 0) ? 'bad' : 'good') + '">' + (trend.likely || '-') + '</span>' +
        ' <span class="tag">偏多 ' + ((trend.upPct || 0).toFixed(1)) + '%</span><span class="tag">偏空 ' + ((trend.downPct || 0).toFixed(1)) + '%</span>';
      document.getElementById('stage').textContent = '阶段: ' + (analysis.stage || '-');

      const levelsEl = document.getElementById('levels');
      (analysis.keyLevels || []).slice(0, 8).forEach((k) => {
        const li = document.createElement('li');
        li.textContent = (k.name || '价位') + ': ' + Number(k.value).toFixed(2) + (k.note ? ' | ' + k.note : '');
        levelsEl.appendChild(li);
      });

      const targetsEl = document.getElementById('targets');
      (analysis.targets || []).slice(0, 8).forEach((t) => {
        const li = document.createElement('li');
        li.textContent = (t.name || '目标') + ': ' + Number(t.value).toFixed(2) + (t.note ? ' | ' + t.note : '');
        targetsEl.appendChild(li);
      });

      const scenariosEl = document.getElementById('scenarios');
      (analysis.patternScenarios || []).forEach((s, i) => {
        const li = document.createElement('li');
        li.textContent = (i + 1) + '. ' + s.title + ' | ' + s.bias + ' | 评分 ' + s.confidenceScore + ' | ' + s.currentWave;
        scenariosEl.appendChild(li);
      });

      // === 微观浪位定位 ===
      const microEl = document.getElementById('micro-wave');
      const micro = analysis.microWavePosition;
      if (micro) {
        const dirLabel = micro.direction === 'down' ? '偏空' : micro.direction === 'up' ? '偏多' : '未知';
        microEl.innerHTML = '<p><strong>当前浪位：</strong>' + (micro.wave || '-') + ' <span class="tag">' + dirLabel + '</span> <span class="tag">评分 ' + (micro.confidenceScore || 0) + '</span></p>' +
          '<p><strong>来源浪型：</strong>' + (micro.scenarioTitle || '-') + '</p>' +
          '<p><strong>阶段：</strong>' + (micro.stage || '-') + '</p>' +
          (micro.narrative ? '<p class="narrative">' + micro.narrative + '</p>' : '');
      } else {
        microEl.innerHTML = '<p class="muted">暂无可靠微观浪位定位。</p>';
      }

      // === 宏观趋势推演 ===
      const macroEl = document.getElementById('macro-trend');
      const macro = analysis.macroTrendPosition;
      if (macro) {
        var macroHtml = '<p><strong>主导方向：</strong>' + (macro.dominantDirection === 'up' ? '<span class="good">偏多</span>' : '<span class="bad">偏空</span>') + ' <span class="tag">' + (macro.dominantProbabilityPct || 0) + '%</span></p>';
        if (macro.dominantScenario) {
          macroHtml += '<p><strong>主导情景：</strong>' + macro.dominantScenario.title + '（评分 ' + (macro.dominantScenario.confidenceScore || 0) + '）</p>';
        }
        // 多头路径
        macroHtml += '<h4><span class="path-label path-bull">多头剧本</span></h4>';
        if (macro.bullishPath) {
          macroHtml += '<p>' + macro.bullishPath.title + ' | 浪位: ' + macro.bullishPath.currentWave + ' | 评分 ' + (macro.bullishPath.confidenceScore || 0) + '</p>';
          if (macro.bullishPath.narrative) macroHtml += '<p class="narrative">' + macro.bullishPath.narrative + '</p>';
        } else {
          macroHtml += '<p class="muted">未识别到有效多头浪型。</p>';
        }
        // 空头路径
        macroHtml += '<h4><span class="path-label path-bear">空头剧本</span></h4>';
        if (macro.bearishPath) {
          macroHtml += '<p>' + macro.bearishPath.title + ' | 浪位: ' + macro.bearishPath.currentWave + ' | 评分 ' + (macro.bearishPath.confidenceScore || 0) + '</p>';
          if (macro.bearishPath.narrative) macroHtml += '<p class="narrative">' + macro.bearishPath.narrative + '</p>';
        } else {
          macroHtml += '<p class="muted">未识别到有效空头浪型。</p>';
        }
        // 破局点
        if (macro.breakpointNarrative) {
          macroHtml += '<h4>破局点</h4>';
          macroHtml += '<p class="warn">' + macro.breakpointNarrative + '</p>';
        }
        macroEl.innerHTML = macroHtml;
      } else {
        macroEl.innerHTML = '<p class="muted">暂无宏观趋势推演信息。</p>';
      }

      // === 跌破大级别风险 ===
      const riskEl = document.getElementById('break-risk');
      const risk = analysis.majorBreakRisk;
      if (risk) {
        var riskClass = risk.state === 'already_broken' ? 'risk-broken' :
          risk.state === 'high_risk' ? 'risk-high' :
          risk.state === 'medium_risk' ? 'risk-medium' : 'risk-low';
        var stateLabel = risk.state === 'already_broken' ? '已跌破' :
          risk.state === 'high_risk' ? '高风险' :
          risk.state === 'medium_risk' ? '中风险' : '低风险';
        riskEl.innerHTML = '<p><strong>参考浪型：</strong>' + (risk.referenceScenario || '-') + '</p>' +
          '<p><strong>关键支撑位：</strong>' + Number(risk.breakLevel).toFixed(2) + '</p>' +
          '<p><strong>跌破概率：</strong>' + (risk.probabilityPct || 0) + '% <span class="risk-badge ' + riskClass + '">' + stateLabel + '</span></p>' +
          '<p><strong>距离该位置：</strong>' + (risk.distanceToLevelPct || 0) + '%' + ' | <strong>空头权重：</strong>' + (risk.bearishWeightPct || 0) + '%</p>' +
          '<p class="muted">' + (risk.note || '') + '</p>';
      } else {
        riskEl.innerHTML = '<p class="muted">暂无大级别跌破风险数据。</p>';
      }
    })();
  </script>
</body>
</html>
`;
}

/**
 * --brief 模式：只输出最简洁的 WXY 联合修正叙述。
 * 从整个数据区间的宏观结构合成 WXY：
 *   - W浪 = 区间起始极值 → 对侧极值
 *   - X浪 = W终点 → W之后最深回撤（X终点）
 *   - Y浪 = X终点 → now（正在发展中）
 * 监测点 = Y浪内部的关键枢轴（非X终点），区分Y浪走势类型。
 */
function buildBriefWxyOutput(analysis, product, tf, candles) {
  const lines = [];
  lines.push(`[${product} ${tf}] WXY联合修正前瞻`);
  lines.push('');

  const confirmedWxy = (analysis.patternScenarios || [])
    .filter((scenario) => scenario?.patternType === 'wxy' && scenario?.wxyNarrative)
    .sort((a, b) => (Number(b.confidenceScore) || 0) - (Number(a.confidenceScore) || 0))[0] || null;
  if (!confirmedWxy) {
    lines.push('未识别到满足 W-X-Y 内部结构约束的联合修正。');
    lines.push('当前不强行套用 WXY 计数；请查看完整报告中的有效候选和失效位。');
    return lines.join('\n');
  }

  const confirmedStart = Number(confirmedWxy.wxyNarrative.startPrice);
  const confirmedWEnd = Number(confirmedWxy.wxyNarrative.wEndPrice);
  const confirmedXEnd = Number(confirmedWxy.wxyNarrative.xEndPrice);
  const confirmedYEnd = Number(confirmedWxy.wxyNarrative.yEndPrice);
  lines.push(`已确认候选：${confirmedWxy.title}（评分 ${confirmedWxy.confidenceScore}）`);
  lines.push(`W：${fmt(confirmedStart)} -> ${fmt(confirmedWEnd)}`);
  lines.push(`X：${fmt(confirmedWEnd)} -> ${fmt(confirmedXEnd)}`);
  lines.push(`Y：${fmt(confirmedXEnd)} -> ${fmt(confirmedYEnd)}`);
  if (confirmedWxy.invalidation) lines.push(`结构失效位：${fmt(confirmedWxy.invalidation.value)}`);
  if (confirmedWxy.confirmation) lines.push(`延续确认位：${fmt(confirmedWxy.confirmation.value)}`);
  return lines.join('\n');

  // ── 1. 从K线中定位区间极值 ──
  let highIdx = 0;
  let lowIdx = 0;
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].high >= candles[highIdx].high) highIdx = i;
    if (candles[i].low <= candles[lowIdx].low) lowIdx = i;
  }
  const rangeHigh = candles[highIdx].high;
  const rangeLow = candles[lowIdx].low;

  // 判断是上行 WXY（低在前）还是下行 WXY（高在前）
  const isUp = lowIdx < highIdx;
  const startPrice = isUp ? rangeLow : rangeHigh;
  const wEndPrice = isUp ? rangeHigh : rangeLow;
  const wEndIdx = isUp ? highIdx : lowIdx;

  // ── 2. 找 X 浪终点（W之后的最深回撤点）──
  const macroPivots = analysis.pivotsMacro || [];
  let xEndPrice = null;
  let xEndIdx = -1;

  if (isUp) {
    // 上行WXY：W到顶后回撤，X低点 = W之后的最深低枢轴
    const lowPivotsAfterW = macroPivots.filter((p) => p.index > wEndIdx && p.type === 'L');
    if (lowPivotsAfterW.length > 0) {
      const xPivot = lowPivotsAfterW.reduce((min, p) => (p.price < min.price ? p : min), lowPivotsAfterW[0]);
      xEndPrice = xPivot.price;
      xEndIdx = xPivot.index;
    }
  } else {
    // 下行WXY：W到底后反弹，X高点 = W之后的最高枢轴
    const highPivotsAfterW = macroPivots.filter((p) => p.index > wEndIdx && p.type === 'H');
    if (highPivotsAfterW.length > 0) {
      const xPivot = highPivotsAfterW.reduce((max, p) => (p.price > max.price ? p : max), highPivotsAfterW[0]);
      xEndPrice = xPivot.price;
      xEndIdx = xPivot.index;
    }
  }

  // 回退：如果宏观枢轴找不到，从K线中找 X 终点
  if (xEndPrice === null) {
    if (isUp) {
      let minLow = rangeHigh;
      for (let i = wEndIdx + 1; i < candles.length; i++) {
        if (candles[i].low < minLow) {
          minLow = candles[i].low;
          xEndIdx = i;
        }
      }
      xEndPrice = minLow;
    } else {
      let maxHigh = rangeLow;
      for (let i = wEndIdx + 1; i < candles.length; i++) {
        if (candles[i].high > maxHigh) {
          maxHigh = candles[i].high;
          xEndIdx = i;
        }
      }
      xEndPrice = maxHigh;
    }
  }

  // ── 3. 找 Y 浪内部的监测点（X终点之后的关键枢轴）──
  // 监测点是Y浪内部的显著回调低/高点，用于区分Y浪是突破型还是三角形
  let monitorPoint = null;

  if (isUp) {
    // 上行Y：找Y浪内部的最近一个显著低点枢轴作为监测点
    // 最近的swing low是最有意义的监测点，跌破它意味着Y浪动能减弱
    const yPivotsLow = macroPivots.filter((p) => p.index > xEndIdx && p.type === 'L');
    if (yPivotsLow.length > 0) {
      // 取Y浪内部最近的（index最大的）低点枢轴作为监测点
      monitorPoint = yPivotsLow.reduce((latest, p) => (p.index > latest.index ? p : latest), yPivotsLow[0]).price;
    }
    // 如果宏观枢轴没有，尝试微观枢轴
    if (monitorPoint === null) {
      const microPivots = analysis.pivotsMicro || [];
      const yMicroLow = microPivots.filter((p) => p.index > xEndIdx && p.type === 'L');
      if (yMicroLow.length > 0) {
        monitorPoint = yMicroLow.reduce((latest, p) => (p.index > latest.index ? p : latest), yMicroLow[0]).price;
      }
    }
    // 最终回退：从K线找Y波段内部最低点（排除X终点附近）
    if (monitorPoint === null) {
      const ySearchStart = Math.min(xEndIdx + Math.max(3, Math.floor((candles.length - xEndIdx) * 0.15)), candles.length - 1);
      let minLow = candles[ySearchStart].low;
      for (let i = ySearchStart; i < candles.length; i++) {
        if (candles[i].low < minLow) minLow = candles[i].low;
      }
      monitorPoint = minLow;
    }
  } else {
    // 下行Y：找Y浪内部最近的显著高点枢轴作为监测点
    const yPivotsHigh = macroPivots.filter((p) => p.index > xEndIdx && p.type === 'H');
    if (yPivotsHigh.length > 0) {
      monitorPoint = yPivotsHigh.reduce((latest, p) => (p.index > latest.index ? p : latest), yPivotsHigh[0]).price;
    }
    if (monitorPoint === null) {
      const microPivots = analysis.pivotsMicro || [];
      const yMicroHigh = microPivots.filter((p) => p.index > xEndIdx && p.type === 'H');
      if (yMicroHigh.length > 0) {
        monitorPoint = yMicroHigh.reduce((latest, p) => (p.index > latest.index ? p : latest), yMicroHigh[0]).price;
      }
    }
    if (monitorPoint === null) {
      const ySearchStart = Math.min(xEndIdx + Math.max(3, Math.floor((candles.length - xEndIdx) * 0.15)), candles.length - 1);
      let maxHigh = candles[ySearchStart].high;
      for (let i = ySearchStart; i < candles.length; i++) {
        if (candles[i].high > maxHigh) maxHigh = candles[i].high;
      }
      monitorPoint = maxHigh;
    }
  }

  // ── 4. 生成叙述（含W/X/Y浪段明细）──
  const lastClose = analysis.lastClose;
  const xAmplitude = Math.abs(wEndPrice - xEndPrice);
  lines.push(`${fmt(startPrice)} 开始有可能是联合修正形WXY，`);
  if (isUp) {
    lines.push(`（1）一种是Y浪大于X浪即超过 ${fmt(wEndPrice)}`);
    lines.push(`    ↳ 依据：X浪幅度 = |${fmt(wEndPrice)} - ${fmt(xEndPrice)}| = ${fmt(xAmplitude)}。`);
    lines.push(`      Y浪起点 ${fmt(xEndPrice)} + ${fmt(xAmplitude)} = ${fmt(xEndPrice + xAmplitude)}，`);
    lines.push(`      即Y浪需超过W浪高点 ${fmt(wEndPrice)} 才能使 Y ≥ X。`);
    lines.push(`（2）另一种是Y浪是三角形。`);
    lines.push(`    ↳ 依据：艾略特波浪理论中，WXY联合修正的Y浪可以是锯齿形、`);
    lines.push(`      平台形或三角形。如果Y浪动能不足以突破W浪高点，`);
    lines.push(`      则可能以收敛三角形(contracting triangle)结束，`);
    lines.push(`      表现为逐渐缩窄的高低点震荡区间。`);
    lines.push(`监测点 ${fmt(monitorPoint)}，如果跌破它更可能是（2）`);
    lines.push(`    ↳ 依据：${fmt(monitorPoint)} 是Y浪内部最近的显著回调低点。`);
    lines.push(`      上行锯齿形Y浪应维持"更高的低点"结构；`);
    lines.push(`      跌破此位意味着Y浪上升动能衰竭，更倾向于`);
    lines.push(`      在 ${fmt(xEndPrice)}~${fmt(wEndPrice)} 区间内形成三角形震荡。`);
    lines.push(`WXY以后或者继续发展到Z浪，或者向下突破`);
  } else {
    lines.push(`（1）一种是Y浪大于X浪即跌破 ${fmt(wEndPrice)}`);
    lines.push(`    ↳ 依据：X浪幅度 = |${fmt(wEndPrice)} - ${fmt(xEndPrice)}| = ${fmt(xAmplitude)}。`);
    lines.push(`      Y浪起点 ${fmt(xEndPrice)} - ${fmt(xAmplitude)} = ${fmt(xEndPrice - xAmplitude)}，`);
    lines.push(`      即Y浪需跌破W浪低点 ${fmt(wEndPrice)} 才能使 Y ≥ X。`);
    lines.push(`（2）另一种是Y浪是三角形。`);
    lines.push(`    ↳ 依据：艾略特波浪理论中，WXY联合修正的Y浪可以是锯齿形、`);
    lines.push(`      平台形或三角形。如果Y浪动能不足以跌破W浪低点，`);
    lines.push(`      则可能以收敛三角形(contracting triangle)结束，`);
    lines.push(`      表现为逐渐缩窄的高低点震荡区间。`);
    lines.push(`监测点 ${fmt(monitorPoint)}，如果突破它更可能是（2）`);
    lines.push(`    ↳ 依据：${fmt(monitorPoint)} 是Y浪内部最近的显著反弹高点。`);
    lines.push(`      下行锯齿形Y浪应维持"更低的高点"结构；`);
    lines.push(`      突破此位意味着Y浪下行动能衰竭，更倾向于`);
    lines.push(`      在 ${fmt(wEndPrice)}~${fmt(xEndPrice)} 区间内形成三角形震荡。`);
    lines.push(`WXY以后或者继续发展到Z浪，或者向上突破`);
  }

  // ── 5. 浪段明细 ──
  lines.push('');
  lines.push(`── 浪段划分 ──`);
  lines.push(`W浪：${fmt(startPrice)} → ${fmt(wEndPrice)}（幅度 ${fmtSigned(wEndPrice - startPrice)}）`);
  lines.push(`X浪：${fmt(wEndPrice)} → ${fmt(xEndPrice)}（幅度 ${fmtSigned(xEndPrice - wEndPrice)}）`);
  lines.push(`Y浪：${fmt(xEndPrice)} → ${fmt(lastClose)}（进行中，幅度 ${fmtSigned(lastClose - xEndPrice)}）`);

  // ── 6. 附加当前状态 ──
  lines.push('');
  lines.push(`── 当前状态 ──`);
  lines.push(`最新收盘：${fmt(lastClose)}`);
  lines.push(`区间：${fmt(rangeLow)} ~ ${fmt(rangeHigh)}`);

  // Y浪进度评估
  const wAmplitude = Math.abs(wEndPrice - startPrice);
  const yAmplitude = Math.abs(lastClose - xEndPrice);
  const yProgress = wAmplitude > 0 ? (yAmplitude / wAmplitude * 100).toFixed(1) : '0.0';
  lines.push(`Y浪/W浪比例：${yProgress}%`);

  if (isUp) {
    const distToTarget = wEndPrice - lastClose;
    if (distToTarget > 0) {
      lines.push(`距突破目标（${fmt(wEndPrice)}）：${fmt(distToTarget)}（${(distToTarget / lastClose * 100).toFixed(2)}%）`);
    } else {
      lines.push(`已突破W浪高点，Y > W 确认中`);
    }
    if (monitorPoint) {
      const distToMonitor = lastClose - monitorPoint;
      lines.push(`距监测点（${fmt(monitorPoint)}）：${fmt(distToMonitor)}（${(distToMonitor / lastClose * 100).toFixed(2)}%）`);
    }
  } else {
    const distToTarget = lastClose - wEndPrice;
    if (distToTarget > 0) {
      lines.push(`距突破目标（${fmt(wEndPrice)}）：${fmt(distToTarget)}（${(distToTarget / lastClose * 100).toFixed(2)}%）`);
    } else {
      lines.push(`已突破W浪低点，Y > W 确认中`);
    }
    if (monitorPoint) {
      const distToMonitor = monitorPoint - lastClose;
      lines.push(`距监测点（${fmt(monitorPoint)}）：${fmt(distToMonitor)}（${(distToMonitor / lastClose * 100).toFixed(2)}%）`);
    }
  }

  // 尝试从已识别的 WXY 中补充浪位信息
  const wxyScenarios = (analysis.patternScenarios || []).filter((s) => s.wxyNarrative);
  if (wxyScenarios.length > 0) {
    lines.push('');
    lines.push(`── 算法识别 ──`);
    // 选最大跨度的
    wxyScenarios.sort((a, b) => {
      const sa = Math.abs(a.wxyNarrative.wEndPrice - a.wxyNarrative.startPrice);
      const sb = Math.abs(b.wxyNarrative.wEndPrice - b.wxyNarrative.startPrice);
      return sb - sa;
    });
    const best = wxyScenarios[0];
    lines.push(`识别到的最大WXY：从 ${fmt(best.wxyNarrative.startPrice)} 到 ${fmt(best.wxyNarrative.wEndPrice)}`);
    lines.push(`当前浪位：${best.currentWave}（评分 ${best.confidenceScore}）`);
    if (best.invalidation) lines.push(`失效点：${fmt(best.invalidation.value)}`);
    if (best.confirmation) lines.push(`确认位：${fmt(best.confirmation.value)}`);
  }

  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const tfConfig = TIMEFRAMES[args.tf];
  if (!tfConfig) {
    throw new Error(`Unsupported timeframe: ${args.tf}. Use: ${Object.keys(TIMEFRAMES).join(', ')}`);
  }

  const endDate = parseDateInput(args.end, new Date());
  const defaultStart = new Date(endDate.getTime() - 30 * 24 * 3600 * 1000);
  const startDate = parseDateInput(args.start, defaultStart);

  if (startDate >= endDate) {
    throw new Error('start must be earlier than end');
  }

  const safeProduct = args.product.replace(/[^A-Za-z0-9-]/g, '_');
  const startTag = toFileTimeTag(startDate, REPORT_TZ_OFFSET_HOURS);
  const endTag = toFileTimeTag(endDate, REPORT_TZ_OFFSET_HOURS);
  const baseName = `${safeProduct}_${args.tf}_${startTag}_${endTag}`;
  const outName = args.out || `${baseName}.json`;
  const reportName = args.report || `${baseName}.md`;
  const htmlName = args.html || `${baseName}.html`;

  const base = await fetchCandles(args.product, tfConfig.fetchGranularity, startDate, endDate);
  const transformed = transformCandles(base, tfConfig);
  const startTs = Math.floor(startDate.getTime() / 1000);
  const endTs = Math.floor(endDate.getTime() / 1000);
  const candles = transformed.filter((c) => c.timestamp >= startTs && c.timestamp <= endTs);
  const candlesWithUtc8 = candles.map((c) => ({
    ...c,
    timeUtc8: formatToUtcOffset(c.timeUtc, REPORT_TZ_OFFSET_HOURS),
  }));

  const minCandlesRequired = Math.max(10, Math.floor(args.lookback) * 4 + 2);
  if (candlesWithUtc8.length < minCandlesRequired) {
    throw new Error(
      `Not enough candles after transform (${candlesWithUtc8.length}). Need at least ${minCandlesRequired} bars for partial-wave inference.`,
    );
  }

  const analysis = analyzeWave(candlesWithUtc8, Math.max(1, Math.floor(args.lookback)), {
    atrPeriod: Math.max(2, Math.floor(args.atrPeriod)),
    atrMultiplier: Number(args.atrMultiplier),
    rsiPeriod: Math.max(2, Math.floor(args.rsiPeriod)),
  });

  // ── brief 模式：只输出简洁WXY叙述 + 保存到 md 和 json ──
  if (args.brief) {
    const briefText = buildBriefWxyOutput(analysis, args.product, args.tf, candlesWithUtc8);
    console.log(briefText);

    const briefMdPath = path.resolve(process.cwd(), args.report || `${baseName}_brief.md`);
    const briefJsonPath = path.resolve(process.cwd(), args.out || `${baseName}.json`);

    const briefPayload = {
      meta: {
        product: args.product,
        timeframe: args.tf,
        startUtc: toIsoNoMs(startDate),
        endUtc: toIsoNoMs(endDate),
        generatedAtUtc: toIsoNoMs(new Date()),
        source: 'Coinbase Exchange candles API',
        mode: 'brief',
      },
      candles: candlesWithUtc8,
      analysis,
    };

    const briefHtmlPath = path.resolve(process.cwd(), args.html || `${baseName}.html`);

    await fs.writeFile(briefMdPath, `${briefText}\n`, 'utf8');
    await fs.writeFile(briefJsonPath, `${JSON.stringify(briefPayload, null, 2)}\n`, 'utf8');
    await fs.writeFile(briefHtmlPath, `${buildHtmlDashboard(briefPayload)}\n`, 'utf8');
    console.log(`\nSaved brief report: ${briefMdPath}`);
    console.log(`Saved data JSON: ${briefJsonPath}`);
    console.log(`Saved dashboard: ${briefHtmlPath}`);
    return;
  }

  const payload = {
    meta: {
      product: args.product,
      timeframe: args.tf,
      startUtc: toIsoNoMs(startDate),
      endUtc: toIsoNoMs(endDate),
      generatedAtUtc: toIsoNoMs(new Date()),
      source: 'Coinbase Exchange candles API',
    },
    candles: candlesWithUtc8,
    analysis,
  };

  const jsonPath = path.resolve(process.cwd(), outName);
  const reportPath = path.resolve(process.cwd(), reportName);
  const htmlPath = path.resolve(process.cwd(), htmlName);

  const reportContent = args.fullReport
    ? buildReport(payload.meta, analysis)
    : buildManualAlternateOnlyReport(payload.meta, analysis);

  await fs.writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await fs.writeFile(reportPath, `${reportContent}\n`, 'utf8');
  await fs.writeFile(htmlPath, `${buildHtmlDashboard(payload)}\n`, 'utf8');

  console.log(`Saved candles JSON: ${jsonPath}`);
  console.log(`Saved analysis report: ${reportPath}`);
  console.log(`Saved interactive dashboard: ${htmlPath}`);
}

// Export core analysis functions for reuse by other scripts
module.exports = {
  analyzeWave,
  buildManualAlternateStructureNotes,
  buildManualAlternateOnlyReport,
  buildReport,
  buildMacroReport,
  buildHtmlDashboard,
  computeATR,
  computeRSI,
  detectPivots,
  detectPatterns,
  checkUpImpulse,
  checkDownImpulse,
  checkUpABC,
  checkDownABC,
  checkUpWXY,
  checkDownWXY,
  validatePatternHardRules,
  buildBriefWxyOutput,
  mergePatternCandidates,
  buildScenario,
  buildTrendOutlook,
  buildCurrentPositionSummary,
  buildTradingSetup,
  buildWaveContextInsights,
  buildWaveLegs,
  formatToUtcOffset,
  formatPivotPoint,
  patternTitle,
  fmt,
  fmtSigned,
  fmtPctByRatio,
  REPORT_TZ_OFFSET_HOURS,
  REPORT_TZ_LABEL,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
