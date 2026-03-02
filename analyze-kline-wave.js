'use strict';

const fs = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');

const API_BASE = 'https://api.exchange.coinbase.com/products';
const API_LIMIT = 300;

const TIMEFRAMES = {
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
  --tf        1h | 4h | 1d | 1w | 1m | 1y
  --start     Start time ISO string, default: end - 30d
  --end       End time ISO string or now, default: now
  --out       Output JSON file, default: <product>_<tf>_<start>_<end>.json
  --report    Output markdown file, default: <product>_<tf>_<start>_<end>.md
  --html      Output interactive dashboard HTML, default: <product>_<tf>_<start>_<end>.html
  --lookback  Pivot lookback window, default: 2
  --atr-period      ATR period for pivot noise filter, default: 14
  --atr-multiplier  Min pivot distance = ATR * multiplier, default: 1.5
  --rsi-period      RSI period for momentum-divergence checks, default: 14
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
    inRange(w2Retrace, 0.236, 0.886) &&
    inRange(w3Extend, 1.0, 4.236);

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
    w5 < w3;

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
    inRange(w2Retrace, 0.236, 0.886) &&
    inRange(w3Extend, 1.0, 4.236);

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
    w5 < w3;

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
    inRange(w2Retrace, 0.236, 0.886) &&
    inRange(w3Extend, 1.0, 4.236) &&
    inRange(w4Retrace, 0.146, 0.886);

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
    w3 < w1;

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
    inRange(w2Retrace, 0.236, 0.886) &&
    inRange(w3Extend, 1.0, 4.236) &&
    inRange(w4Retrace, 0.146, 0.886);

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
    w3 < w1;

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
  const valid = a > 0 && b > 0 && c > 0 && p[2].price < p[0].price && p[3].price < p[2].price;

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
  const valid = a > 0 && b > 0 && c > 0 && p[2].price > p[0].price && p[3].price > p[2].price;

  if (!valid) return null;
  return { type: 'abc', direction: 'up', points: p, lengths: { a, b, c } };
}

function checkDownWXY(p) {
  if (p.length !== 8) return null;
  const okType =
    p[0].type === 'H' && p[1].type === 'L' &&
    p[2].type === 'H' && p[3].type === 'L' &&
    p[4].type === 'H' && p[5].type === 'L' &&
    p[6].type === 'H' && p[7].type === 'L';
  if (!okType) return null;

  const w = checkDownABC(p.slice(0, 4));
  const y = checkDownABC(p.slice(4, 8));
  if (!w || !y) return null;

  const wNet = p[0].price - p[3].price;
  const xNet = p[4].price - p[3].price;
  const yNet = p[4].price - p[7].price;
  const xRetrace = safeRatio(xNet, wNet);
  const yOverW = safeRatio(yNet, wNet);

  const valid =
    wNet > 0 &&
    xNet > 0 &&
    yNet > 0 &&
    p[7].price < p[3].price &&
    p[4].price < p[0].price &&
    inRange(xRetrace, 0.146, 1.146) &&
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
  if (p.length !== 8) return null;
  const okType =
    p[0].type === 'L' && p[1].type === 'H' &&
    p[2].type === 'L' && p[3].type === 'H' &&
    p[4].type === 'L' && p[5].type === 'H' &&
    p[6].type === 'L' && p[7].type === 'H';
  if (!okType) return null;

  const w = checkUpABC(p.slice(0, 4));
  const y = checkUpABC(p.slice(4, 8));
  if (!w || !y) return null;

  const wNet = p[3].price - p[0].price;
  const xNet = p[3].price - p[4].price;
  const yNet = p[7].price - p[4].price;
  const xRetrace = safeRatio(xNet, wNet);
  const yOverW = safeRatio(yNet, wNet);

  const valid =
    wNet > 0 &&
    xNet > 0 &&
    yNet > 0 &&
    p[7].price > p[3].price &&
    p[4].price > p[0].price &&
    inRange(xRetrace, 0.146, 1.146) &&
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

  for (let i = 0; i <= pivots.length - 8; i += 1) {
    const segment = pivots.slice(i, i + 8);
    const down = checkDownWXY(segment);
    const up = checkUpWXY(segment);

    if (down) candidates.push({ ...down, endIndex: i + 7, score: 280 + i, scale });
    if (up) candidates.push({ ...up, endIndex: i + 7, score: 280 + i, scale });
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
    const ty = Math.max(1, p[7].index - p[4].index);
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
  const impulseLike = hasDirectionalSubstructure(segment, direction, 'impulse') || swingCount >= 5;
  const abcLike = hasDirectionalSubstructure(segment, direction, 'abc') || (swingCount >= 3 && swingCount <= 4);
  return {
    swingCount,
    impulseLike,
    abcLike,
    pivotCount: segment.length,
  };
}

function evaluateFractalValidation(pattern, context = null) {
  if (!pattern || !context?.pivotsMicro || !Array.isArray(context.pivotsMicro)) return 0.5;
  if (pattern.scale !== 'macro') return 0.6;

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
      ? ['W-A（下跌）', 'W-B（反弹）', 'W-C（下跌）', 'X（反弹）', 'Y-A（下跌）', 'Y-B（反弹）', 'Y-C（下跌）']
      : ['W-A（上涨）', 'W-B（回调）', 'W-C（上涨）', 'X（回调）', 'Y-A（上涨）', 'Y-B（回调）', 'Y-C（上涨）'];
    for (let i = 0; i < 7; i += 1) {
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
    const [p0, p1, p2, p3, p4, p5, p6, p7] = pattern.points;
    const { w, x, y } = pattern.lengths;

    scenario.stage = last.close > p7.price
      ? 'WXY 下跌完成后的反弹阶段（复杂调整）'
      : 'WXY 下跌结构延伸中（复杂调整）';
    scenario.currentWave = last.close > p7.price ? 'Y浪结束后反弹' : 'Y浪下跌进行中';
    scenario.invalidation = { name: '失效点', value: p6.price, note: '有效上破Y-B，当前WXY计数减弱' };
    scenario.confirmation = { name: '延续确认位', value: p7.price, note: '有效跌破Y-C，WXY下跌延续概率提升' };
    scenario.keyLevels.push(
      { name: 'W终点', value: p3.price, note: 'W段下跌完成位置' },
      { name: 'X终点', value: p4.price, note: '连接浪反弹终点' },
      { name: 'Y终点', value: p7.price, note: '当前复合调整关键支撑' },
    );
    scenario.targets.push(
      { name: 'Y=1.0W 参考', value: p4.price - w, note: '常见WXY等幅目标' },
      { name: 'Y=1.272W 参考', value: p4.price - w * 1.272, note: '延伸目标' },
      { name: 'Y=1.618W 参考', value: p4.price - w * 1.618, note: '强延伸目标' },
    );
    scenario.metrics.push(
      { name: 'X/W', value: formatRatio(safeRatio(x, w)) },
      { name: 'Y/W', value: formatRatio(safeRatio(y, w)) },
      { name: 'W长度', value: fmt(w) },
      { name: 'Y长度', value: fmt(y) },
    );
  } else if (pattern.type === 'wxy' && pattern.direction === 'up') {
    const [p0, p1, p2, p3, p4, p5, p6, p7] = pattern.points;
    const { w, x, y } = pattern.lengths;

    scenario.stage = last.close < p7.price
      ? 'WXY 上涨完成后的回撤阶段（复杂调整）'
      : 'WXY 上涨结构延伸中（复杂调整）';
    scenario.currentWave = last.close < p7.price ? 'Y浪结束后回撤' : 'Y浪上涨进行中';
    scenario.invalidation = { name: '失效点', value: p6.price, note: '有效下破Y-B，当前WXY计数减弱' };
    scenario.confirmation = { name: '延续确认位', value: p7.price, note: '有效上破Y-C，WXY上涨延续概率提升' };
    scenario.keyLevels.push(
      { name: 'W终点', value: p3.price, note: 'W段上涨完成位置' },
      { name: 'X终点', value: p4.price, note: '连接浪回撤终点' },
      { name: 'Y终点', value: p7.price, note: '当前复合调整关键压力' },
    );
    scenario.targets.push(
      { name: 'Y=1.0W 参考', value: p4.price + w, note: '常见WXY等幅目标' },
      { name: 'Y=1.272W 参考', value: p4.price + w * 1.272, note: '延伸目标' },
      { name: 'Y=1.618W 参考', value: p4.price + w * 1.618, note: '强延伸目标' },
    );
    scenario.metrics.push(
      { name: 'X/W', value: formatRatio(safeRatio(x, w)) },
      { name: 'Y/W', value: formatRatio(safeRatio(y, w)) },
      { name: 'W长度', value: fmt(w) },
      { name: 'Y长度', value: fmt(y) },
    );
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

  const microWavePosition = microWaveScenario
    ? {
      wave: microWaveScenario.currentWave || '浪位待确认',
      stage: microWaveScenario.stage || '阶段待确认',
      scenarioTitle: microWaveScenario.title || '主情景',
      direction: microWaveScenario.direction || 'unknown',
      confidenceScore: Number((microWaveScenario.confidenceScore || 0).toFixed(1)),
      lookback: parseLookbackFromScale(microWaveScenario.scale),
      note: `微观：基于 ${microWaveScenario.scale || 'unknown'}`,
    }
    : {
      wave: '浪位不明',
      stage: '暂无可靠微观结构',
      scenarioTitle: 'n/a',
      direction: 'unknown',
      confidenceScore: 0,
      lookback: null,
      note: '微观定位失败：候选浪型不足',
    };

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
      }
      : null,
    bullishPath: bestUp
      ? {
        title: bestUp.title,
        currentWave: bestUp.currentWave,
        confidenceScore: Number((bestUp.confidenceScore || 0).toFixed(1)),
        triggerLevel: bestUp.confirmation?.value ?? null,
        failureLevel: bestUp.invalidation?.value ?? null,
      }
      : null,
    bearishPath: bestDown
      ? {
        title: bestDown.title,
        currentWave: bestDown.currentWave,
        confidenceScore: Number((bestDown.confidenceScore || 0).toFixed(1)),
        triggerLevel: bestDown.confirmation?.value ?? null,
        failureLevel: bestDown.invalidation?.value ?? null,
      }
      : null,
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
            ? ['0', 'W-A', 'W-B', 'W-C', 'X', 'Y-A', 'Y-B', 'Y-C']
            : ['0', 'w-a', 'w-b', 'w-c', 'x', 'y-a', 'y-b', 'y-c'];
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
    })();
  </script>
</body>
</html>
`;
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

  await fs.writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await fs.writeFile(reportPath, `${buildReport(payload.meta, analysis)}\n`, 'utf8');
  await fs.writeFile(htmlPath, `${buildHtmlDashboard(payload)}\n`, 'utf8');

  console.log(`Saved candles JSON: ${jsonPath}`);
  console.log(`Saved analysis report: ${reportPath}`);
  console.log(`Saved interactive dashboard: ${htmlPath}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
