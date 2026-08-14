'use strict';

/**
 * 波浪理论「验证手册」分析器（P1）。
 *
 * 独立于 analyze-kline-wave.js（不 require、不修改该文件）。
 * 核心差异：老脚本用加权综合分排序；本脚本用《波浪理论详解》的「否定法」——
 * 规则（Rules）是硬性闸门，任一条不满足即淘汰候选；指引（Guidelines）只用于
 * 给幸存候选排名。参见 openspec/changes/restructure-wave-engine-to-verification-manual/。
 */

const fs = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');

// ============================================================
// 1. 数据层（从 analyze-kline-wave.js 复制并隔离，供本脚本独立取数）
// ============================================================

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
    lookback: 2,
    atrPeriod: 14,
    atrMultiplier: 1.5,
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
    } else if (item === '--lookback' && next) {
      args.lookback = Number(next);
      i += 1;
    } else if (item === '--atr-period' && next) {
      args.atrPeriod = Number(next);
      i += 1;
    } else if (item === '--atr-multiplier' && next) {
      args.atrMultiplier = Number(next);
      i += 1;
    } else if (item === '--help' || item === '-h') {
      args.help = true;
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  node analyze-wave-manual.js --product BTC-USD --tf 1h --start 2026-02-06T00:00:00+08:00 --end now

依《波浪理论详解》验证手册（否定法）分析波浪结构，与 analyze-kline-wave.js 并存、互不依赖。

Options:
  --product   交易对，默认 BTC-USD
  --tf        5m | 1h | 4h | 1d | 1w | 1m | 1y
  --start     起始时间 ISO 字符串，默认 end - 30d
  --end       结束时间 ISO 字符串或 now，默认 now
  --out       输出 JSON 文件路径
  --report    输出 Markdown 报告路径
  --lookback  枢轴检测回看窗口，默认 2
  --atr-period      ATR 周期（枢轴噪音过滤），默认 14
  --atr-multiplier  最小枢轴间距 = ATR * multiplier，默认 1.5
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

function pad2(n) {
  return String(n).padStart(2, '0');
}

function toFileTimeTag(date, offsetHours = 8) {
  const shifted = new Date(date.getTime() + offsetHours * 3600 * 1000);
  const y = shifted.getUTCFullYear();
  const m = pad2(shifted.getUTCMonth() + 1);
  const d = pad2(shifted.getUTCDate());
  const hh = pad2(shifted.getUTCHours());
  const mm = pad2(shifted.getUTCMinutes());
  return `${y}${m}${d}${hh}${mm}`;
}

function formatToUtcOffset(input, offsetHours = 8) {
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
          'User-Agent': 'kline-wave-manual-analyzer/1.0',
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
    if (mode === 'month') return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
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

// ============================================================
// 2. 度量层（wave-measurement）：价格 / 运行总量 / 价格运动百分比
// ============================================================

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function safeRatio(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  return numerator / denominator;
}

/**
 * 对一段由 [first ... last] 边界点定义的浪型/子浪计算三种度量。
 * gross 用该区间内的真实 K 线高低点计算（而非仅端点），
 * 因此未衰竭时 price === gross，出现衰竭/失败 c 浪等情形时 price !== gross。
 */
function computeMeasures(points, direction, candles) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];

  let hi = -Infinity;
  let lo = Infinity;

  if (Array.isArray(candles) && candles.length > 0) {
    const idxLo = Math.min(first.index, last.index);
    const idxHi = Math.max(first.index, last.index);
    for (let i = idxLo; i <= idxHi; i += 1) {
      const c = candles[i];
      if (!c) continue;
      if (c.high > hi) hi = c.high;
      if (c.low < lo) lo = c.low;
    }
  }

  if (!Number.isFinite(hi) || !Number.isFinite(lo)) {
    hi = -Infinity;
    lo = Infinity;
    for (const p of points) {
      const price = Number(p.price);
      if (price > hi) hi = price;
      if (price < lo) lo = price;
    }
  }

  const price = direction === 'up' ? (last.price - first.price) : (first.price - last.price);
  const gross = hi - lo;
  const movePct = Number.isFinite(lo) && lo !== 0 ? (hi - lo) / Math.abs(lo) : null;

  return { price, gross, movePct, hi, lo, first, last };
}

function rangeExtreme(candles, fromIndex, toIndex) {
  const lo = Math.min(fromIndex, toIndex);
  const hi = Math.max(fromIndex, toIndex);
  let maxHigh = -Infinity;
  let minLow = Infinity;
  for (let i = lo; i <= hi; i += 1) {
    const c = candles[i];
    if (!c) continue;
    if (c.high > maxHigh) maxHigh = c.high;
    if (c.low < minLow) minLow = c.low;
  }
  return { maxHigh, minLow };
}

/**
 * 整段K线的汇总统计，用于报告头：样本数量、区间最高/最低、最新收盘及其时间。
 */
function computeCandleStats(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  let hi = -Infinity;
  let lo = Infinity;
  for (const c of candles) {
    if (c.high > hi) hi = c.high;
    if (c.low < lo) lo = c.low;
  }
  const last = candles[candles.length - 1];
  return {
    sampleCount: candles.length,
    rangeHigh: hi,
    rangeLow: lo,
    latestClose: last.close,
    latestCloseTs: last.timestamp,
  };
}

// ============================================================
// 3. 验证手册引擎（wave-verification-manual）：Rule/Guideline + 否定法
// ============================================================

const LAYER_ORDER = { pattern: 0, ratio: 1, time: 2 };

function makeJudge(id, layer, desc, testFn, options = {}) {
  return {
    id,
    layer,
    basis: options.basis || null,
    weight: Number.isFinite(options.weight) ? options.weight : 1,
    desc,
    test: testFn,
    detail: options.detail || null,
  };
}

function evaluateManual(ctx, manual) {
  const rules = manual.rules.slice().sort((a, b) => LAYER_ORDER[a.layer] - LAYER_ORDER[b.layer]);

  for (const rule of rules) {
    let ok = false;
    try {
      ok = Boolean(rule.test(ctx));
    } catch (err) {
      ok = false;
    }
    if (!ok) {
      return {
        survived: false,
        manual,
        failedRule: rule,
        layer: rule.layer,
        detailText: rule.detail ? safeDetail(rule, ctx) : null,
      };
    }
  }

  const hits = [];
  for (const g of manual.guidelines) {
    let ok = false;
    try {
      ok = Boolean(g.test(ctx));
    } catch (err) {
      ok = false;
    }
    if (ok) hits.push(g);
  }

  const guidelineScore = hits.reduce((acc, g) => acc + (g.weight || 1), 0);
  const guidelineTotal = manual.guidelines.reduce((acc, g) => acc + (g.weight || 1), 0);

  return {
    survived: true,
    manual,
    guidelineScore,
    guidelineTotal,
    hits,
  };
}

function safeDetail(judge, ctx) {
  try {
    return judge.detail(ctx);
  } catch (err) {
    return null;
  }
}

// ============================================================
// 4. 子浪内部结构探测（用于「a浪是否为推动浪/引导楔形」等判据）
// ============================================================

function buildSegmentPivots(sourcePivots, fromPoint, toPoint) {
  const lo = Math.min(fromPoint.index, toPoint.index);
  const hi = Math.max(fromPoint.index, toPoint.index);
  const seg = sourcePivots.filter((p) => p.index >= lo && p.index <= hi).slice();

  const upsert = (pt) => {
    if (!seg.some((p) => p.index === pt.index && p.type === pt.type)) seg.push(pt);
  };
  upsert(fromPoint);
  upsert(toPoint);
  seg.sort((a, b) => a.index - b.index);

  const cleaned = [];
  for (const p of seg) {
    if (cleaned.length === 0) {
      cleaned.push(p);
      continue;
    }
    const last = cleaned[cleaned.length - 1];
    if (last.type !== p.type) {
      cleaned.push(p);
      continue;
    }
    const shouldReplace = (p.type === 'H' && p.price >= last.price) || (p.type === 'L' && p.price <= last.price);
    if (shouldReplace) cleaned[cleaned.length - 1] = p;
  }
  return cleaned;
}

/**
 * 在一段子枢轴序列上滑动 6 点窗口，尝试用推动浪/楔形验证手册套一层，
 * 存在任一通过全部规则的推动浪/楔形即返回 true（即「实证出驱动浪」）。
 *
 * 只做一层校验（书 3.23 / 分形限制）：推动浪与楔形手册的规则都是纯价格/
 * 比率/时间几何（不回调 legShape），故天然无无限递归；其 test 也不读取
 * ctx.candles / ctx.measures，因此这里用最小 ctx（仅 points+direction）即可。
 */
function legHasValidImpulse(seg, direction) {
  if (!Array.isArray(seg) || seg.length < 6) return false;
  const want = direction === 'up'
    ? ['L', 'H', 'L', 'H', 'L', 'H']
    : ['H', 'L', 'H', 'L', 'H', 'L'];
  for (let i = 0; i + 6 <= seg.length; i += 1) {
    const w = seg.slice(i, i + 6);
    if (!w.every((p, k) => p.type === want[k])) continue;
    const ctx = { points: w, direction };
    if (evaluateManual(ctx, buildImpulseStrictManual(direction)).survived) return true;
    if (evaluateManual(ctx, buildImpulseDiagonalManual(direction)).survived) return true;
  }
  return false;
}

/**
 * 重叠兜底：推动浪要求「更高的低点、更高的高点」（上行）或「更低的高点、
 * 更低的低点」（下行）。若同向极值序列出现逆序（上行腿出现更低的低点，或
 * 下行腿出现更高的高点），说明子浪相互重叠 —— 是调整浪的典型特征。
 */
function legHasOverlap(seg, direction) {
  if (!Array.isArray(seg) || seg.length < 3) return false;
  const wantType = direction === 'up' ? 'L' : 'H';
  const seq = seg.filter((p) => p.type === wantType);
  for (let i = 1; i < seq.length; i += 1) {
    if (direction === 'up' && seq[i].price < seq[i - 1].price - 1e-9) return true;
    if (direction === 'down' && seq[i].price > seq[i - 1].price + 1e-9) return true;
  }
  return false;
}

/**
 * 判断一段子浪是「驱动浪形态」还是「调整浪形态」。
 *
 * P4 修正（fix-subwave-impulse-classification）：`impulseLike` 不再用「子枢轴数
 * ≥6」这种计数假象判定，而是要求该腿内部**实证出一个通过全部规则的推动浪/楔形，
 * 且无明显重叠**。这消除了「长而重叠的复杂调整腿被误判为驱动浪」的假阴性
 * （如 BTC-USD 1d 的 80524→97963 反弹）。
 */
function legShape(sourcePivots, fromPoint, toPoint, direction) {
  const seg = buildSegmentPivots(sourcePivots, fromPoint, toPoint);
  const swingCount = Math.max(0, seg.length - 1);
  const impulseLike = legHasValidImpulse(seg, direction) && !legHasOverlap(seg, direction);
  const abcLike = swingCount >= 2 && swingCount <= 4;
  return { swingCount, impulseLike, abcLike, pivotCount: seg.length, points: seg };
}

/**
 * 判断一段子浪在细粒度枢轴下是否恰好呈「单锯齿」形态（4点、5-3-5、
 * b浪不破a浪起点）。用于区分双/三锯齿的 w/y/z 腿（须自身是单锯齿）
 * 与单锯齿本身的 a/c 腿（须是驱动浪）——这是书中「浪中有浪」在 P2
 * 范围内的一个有边界的可计算近似：仅当细粒度枢轴恰好给出干净的
 * 4 点子结构时才判定，不做更深层递归。
 */
function legIsZigzagShaped(sourcePivots, fromPoint, toPoint, direction, candles) {
  const seg = buildSegmentPivots(sourcePivots, fromPoint, toPoint);
  if (seg.length !== 4) return false;
  const expectedTypes = direction === 'up' ? ['L', 'H', 'L', 'H'] : ['H', 'L', 'H', 'L'];
  if (!seg.every((p, i) => p.type === expectedTypes[i])) return false;
  const [q0, q1, q2] = seg;
  const ext = rangeExtreme(candles, q1.index, q2.index);
  const bNotBreakAStart = direction === 'up' ? ext.minLow >= q0.price - 1e-9 : ext.maxHigh <= q0.price + 1e-9;
  return bNotBreakAStart;
}

/**
 * 粗略判断一条腿（通常是某个推动浪候选窗口的 2 浪腿）风格是
 * 「陡直」（锯齿类形态）还是「横向」（回撤幅度大、呈平台/箱体状），
 * 用于交替原则指引（书 1.7）。判不出时返回 'unknown'。
 */
function classifyLegStyle(sourcePivots, fromPoint, toPoint, direction, candles) {
  if (legIsZigzagShaped(sourcePivots, fromPoint, toPoint, direction, candles)) return 'steep';
  const seg = buildSegmentPivots(sourcePivots, fromPoint, toPoint);
  if (seg.length === 4) {
    const [q0, q1, q2] = seg;
    const aM = computeMeasures([q0, q1], direction, candles);
    const bM = computeMeasures([q1, q2], direction === 'up' ? 'down' : 'up', candles);
    const r = safeRatio(bM.gross, aM.gross);
    if (r !== null && r >= 0.7) return 'sideways';
  }
  return 'unknown';
}

// ============================================================
// 5. 浪型手册（wave-taxonomy）：推动浪 / 单锯齿 / 平台形（基础版）
// ============================================================
//
// 判据 id → 《波浪理论详解》章节对照表（task 4.4）：
//   impulse.pattern.wave2-not-retrace-100      → 1.5「驱动浪的2浪不能折返1浪的100%」
//   impulse.pattern.wave3-exceeds-wave1-end    → 1.5「驱动浪的3浪须超过1浪的终点」
//   impulse.pattern.wave4-not-cross-wave1      → 1.5「驱动浪的4浪不能切入1浪」（推动浪子类）
//   impulse.pattern.wave3-not-shortest         → 1.5「驱动浪的3浪一定不是最短的」
//   impulse-diagonal.pattern.wave4-allowed-*   → 1.5「驱动浪允许4浪切入1浪」（楔形子类）
//   zigzag.pattern.a/b/c-is-*                  → 4.1 单锯齿浪型规则「a浪须为推动浪…b浪须为调整浪…c浪须为推动浪…」
//   zigzag.ratio.b-price-between-0.2a-and-a    → 4.1/4.8「b>=a×0.2 且 b<=a」
//   zigzag.ratio.b-not-break-a-start           → 4.8「b浪的任何部分都不能超过a浪的起点」
//   zigzag.ratio.c-between-0.9b-and-5b         → 4.1/4.9「c浪价格>=b浪90%、<b浪5倍、<a浪5倍」
//   zigzag.time.b-lt-10a / c-lt-10a-and-10b    → 4.1 单锯齿时间规则
//   flat.pattern.a/b/c-is-*                    → 5.1 平台形浪型规则
//   flat.ratio.b-gross-at-least-70pct-of-a     → 5.1/5.6「b浪运行总量须回撤a浪运行总量的70%以上」
//   flat.ratio.b-gross-below-200pct-of-a       → 5.1/5.4.2/5.4.3「b浪运行总量须小于a浪运行总量的2倍」
//   flat.ratio.c-overlaps-a                    → 5.7「c浪必须与a浪有重叠」
//   flat.time.b-lt-10a / c-lt-10a-and-10b      → 5.1 平台形时间规则
//
// 各 Guideline 的 desc 字段本身即引用书中对应的「指引」表述（如常见比率、时间窗口等）。

function absLen(a, b) {
  return Math.abs(Number(b.price) - Number(a.price));
}

function fmtNum(n, digits = 2) {
  return Number.isFinite(n) ? Number(n).toFixed(digits) : 'n/a';
}

function fmtRatio(n) {
  return Number.isFinite(n) ? Number(n).toFixed(3) : 'n/a';
}

function legIndexTime(p0, p1) {
  return Math.max(1, Math.abs(p1.index - p0.index));
}

// ---- 5.1 推动浪（标准 Impulse） ----

function buildImpulseStrictManual(direction) {
  const isUp = direction === 'up';

  const rules = [
    makeJudge(
      'impulse.pattern.wave2-not-retrace-100',
      'pattern',
      '2浪不能折返1浪的100%',
      (ctx) => {
        const [p0, , p2] = ctx.points;
        return isUp ? p2.price > p0.price : p2.price < p0.price;
      },
      { detail: (ctx) => `p0=${ctx.points[0].price}, p2=${ctx.points[2].price}` },
    ),
    makeJudge(
      'impulse.pattern.wave3-exceeds-wave1-end',
      'pattern',
      '3浪须超过1浪的终点',
      (ctx) => {
        const [, p1, , p3] = ctx.points;
        return isUp ? p3.price > p1.price : p3.price < p1.price;
      },
      { detail: (ctx) => `p1=${ctx.points[1].price}, p3=${ctx.points[3].price}` },
    ),
    makeJudge(
      'impulse.pattern.wave4-not-cross-wave1',
      'pattern',
      '推动浪的4浪不能切入1浪',
      (ctx) => {
        const [, p1, , , p4] = ctx.points;
        return isUp ? p4.price > p1.price : p4.price < p1.price;
      },
      { detail: (ctx) => `p1=${ctx.points[1].price}, p4=${ctx.points[4].price}` },
    ),
    makeJudge(
      'impulse.pattern.wave3-not-shortest',
      'pattern',
      '3浪一定不是1/3/5浪中最短的',
      (ctx) => {
        const [p0, p1, p2, p3, p4, p5] = ctx.points;
        const w1 = absLen(p0, p1);
        const w3 = absLen(p2, p3);
        const w5 = absLen(p4, p5);
        return w3 >= Math.min(w1, w5);
      },
      { detail: (ctx) => {
        const [p0, p1, p2, p3, p4, p5] = ctx.points;
        return `w1=${fmtNum(absLen(p0, p1))}, w3=${fmtNum(absLen(p2, p3))}, w5=${fmtNum(absLen(p4, p5))}`;
      } },
    ),
    makeJudge(
      'impulse.ratio.wave2-retrace-range',
      'ratio',
      '2浪回撤须在1浪的23.6%~88.6%之间',
      (ctx) => {
        const [p0, p1, p2] = ctx.points;
        const w1 = absLen(p0, p1);
        const w2 = absLen(p1, p2);
        const r = safeRatio(w2, w1);
        return r !== null && r >= 0.236 && r <= 0.886;
      },
      { basis: 'price' },
    ),
    makeJudge(
      'impulse.ratio.wave3-extend-range',
      'ratio',
      '3浪相对1浪的扩展须在1~4.236倍之间',
      (ctx) => {
        const [p0, p1, p2, p3] = ctx.points;
        const w1 = absLen(p0, p1);
        const w3 = absLen(p2, p3);
        const r = safeRatio(w3, w1);
        return r !== null && r >= 1.0 && r <= 4.236;
      },
      { basis: 'price' },
    ),
  ];

  const guidelines = [
    makeJudge(
      'impulse.guide.alternation-2-4',
      'pattern',
      '2浪与4浪呈现交替（回撤比率不同）',
      (ctx) => {
        const [p0, p1, p2, p3, p4] = ctx.points;
        const w1 = absLen(p0, p1);
        const w3 = absLen(p2, p3);
        const retrace2 = Math.abs(safeRatio(absLen(p1, p2), w1) || 0);
        const retrace4 = Math.abs(safeRatio(absLen(p3, p4), w3) || 0);
        return Math.abs(retrace2 - retrace4) > 0.15;
      },
    ),
    makeJudge(
      'impulse.guide.wave3-common-extension',
      'ratio',
      '3浪扩展接近常见斐波那契倍数（1.618/2.618）',
      (ctx) => {
        const [p0, p1, p2, p3] = ctx.points;
        const r = safeRatio(absLen(p2, p3), absLen(p0, p1));
        if (r === null) return false;
        return Math.abs(r - 1.618) < 0.3 || Math.abs(r - 2.618) < 0.4;
      },
      { basis: 'price' },
    ),
    makeJudge(
      'impulse.guide.wave4-time-balance',
      'time',
      '4浪与2浪耗时比在0.2~5倍之间（时间平衡）',
      (ctx) => {
        const [p0, p1, p2, p3, p4] = ctx.points;
        const t2 = legIndexTime(p1, p2);
        const t4 = legIndexTime(p3, p4);
        const r = t4 / t2;
        return r >= 0.2 && r <= 5.0;
      },
    ),
  ];

  return { patternType: 'impulse', direction, mode: 'strict', label: '推动浪（标准 Impulse）', rules, guidelines };
}

/**
 * 楔形（Diagonal）手册。P2 起按出现位置区分引导楔形（Leading，通常在
 * 1浪/A浪位置——一段全新趋势的开端）与终结楔形（Ending，通常在5浪/C浪
 * 位置——一段趋势的收尾），替换 P1 的统一 diagonal 标签（书 1.5、6.8节
 * 附近关于 Leading/Ending Diagonal 的位置区分）。
 *
 * positionHint: 'leading' | 'ending'（不传时默认按 'ending' 处理，
 * 因为终结楔形在实盘中出现频率更高、也是本书重点讨论的子类）。
 * 两者内部规则形状相同（P2 未取得引导/终结楔形在比率上的确认差异），
 * 仅 label/mode 随位置切换，用于报告可读性与「替换统一标签」的要求。
 */
function buildImpulseDiagonalManual(direction, positionHint) {
  const isUp = direction === 'up';
  const isLeading = positionHint === 'leading';
  const mode = isLeading ? 'leading_diagonal' : 'ending_diagonal';
  const label = isLeading ? '推动浪（引导楔形 Leading Diagonal）' : '推动浪（终结楔形 Ending Diagonal）';
  const idPrefix = isLeading ? 'leading-diagonal' : 'ending-diagonal';

  const rules = [
    makeJudge(
      `${idPrefix}.pattern.wave2-not-retrace-100`,
      'pattern',
      '2浪不能折返1浪的100%',
      (ctx) => {
        const [p0, , p2] = ctx.points;
        return isUp ? p2.price > p0.price : p2.price < p0.price;
      },
    ),
    makeJudge(
      `${idPrefix}.pattern.wave3-exceeds-wave1-end`,
      'pattern',
      '3浪须超过1浪的终点',
      (ctx) => {
        const [, p1, , p3] = ctx.points;
        return isUp ? p3.price > p1.price : p3.price < p1.price;
      },
    ),
    makeJudge(
      `${idPrefix}.pattern.wave4-allowed-cross-wave1`,
      'pattern',
      '楔形允许4浪切入1浪，但须切入2浪之内（4浪终点须在2、1浪终点之间）',
      (ctx) => {
        const [, p1, p2, , p4] = ctx.points;
        return isUp
          ? p4.price <= p1.price && p4.price > p2.price
          : p4.price >= p1.price && p4.price < p2.price;
      },
    ),
    makeJudge(
      `${idPrefix}.pattern.wave4-not-retrace-100-of-3`,
      'pattern',
      '4浪不能折返3浪的100%',
      (ctx) => {
        const [, , p2, , p4] = ctx.points;
        return isUp ? p4.price > p2.price : p4.price < p2.price;
      },
    ),
    makeJudge(
      `${idPrefix}.pattern.wave3-not-shortest`,
      'pattern',
      '3浪一定不是1/3/5浪中最短的',
      (ctx) => {
        const [p0, p1, p2, p3, p4, p5] = ctx.points;
        const w1 = absLen(p0, p1);
        const w3 = absLen(p2, p3);
        const w5 = absLen(p4, p5);
        return w3 >= Math.min(w1, w5);
      },
    ),
    makeJudge(
      `${idPrefix}.ratio.converging`,
      'ratio',
      '楔形须收敛：3浪短于1浪，5浪短于3浪',
      (ctx) => {
        const [p0, p1, p2, p3, p4, p5] = ctx.points;
        const w1 = absLen(p0, p1);
        const w3 = absLen(p2, p3);
        const w5 = absLen(p4, p5);
        return w3 < w1 && w5 < w3;
      },
      { basis: 'price' },
    ),
  ];

  const guidelines = [
    makeJudge(
      `${idPrefix}.guide.wave5-time-shorter`,
      'time',
      '5浪耗时通常短于3浪（楔形加速收敛）',
      (ctx) => {
        const [, , p2, p3, p4, p5] = ctx.points;
        return legIndexTime(p4, p5) <= legIndexTime(p2, p3);
      },
    ),
  ];

  return { patternType: 'impulse', direction, mode, label, rules, guidelines };
}

// ---- 5.2 单锯齿（Single Zigzag, 5-3-5） ----

function buildSingleZigzagManual(direction, fineContext) {
  const isUp = direction === 'up';

  const rules = [
    makeJudge(
      'zigzag.pattern.a-is-driving',
      'pattern',
      'a浪必须是推动浪或引导楔形（内部呈驱动浪形态）',
      (ctx) => legShape(fineContext.pivotsFine, ctx.points[0], ctx.points[1], direction).impulseLike,
    ),
    makeJudge(
      'zigzag.pattern.b-is-corrective',
      'pattern',
      'b浪必须是调整浪',
      (ctx) => !legShape(fineContext.pivotsFine, ctx.points[1], ctx.points[2], isUp ? 'down' : 'up').impulseLike,
    ),
    makeJudge(
      'zigzag.pattern.c-is-driving',
      'pattern',
      'c浪必须是推动浪或终结楔形（内部呈驱动浪形态）',
      (ctx) => legShape(fineContext.pivotsFine, ctx.points[2], ctx.points[3], direction).impulseLike,
    ),
    makeJudge(
      'zigzag.ratio.b-price-between-0.2a-and-a',
      'ratio',
      'b浪价格须≥a浪价格的20%，且≤a浪价格的100%',
      (ctx) => {
        const [p0, p1, p2] = ctx.points;
        const a = absLen(p0, p1);
        const b = absLen(p1, p2);
        const r = safeRatio(b, a);
        return r !== null && r >= 0.2 && r <= 1.0;
      },
      { basis: 'price' },
    ),
    makeJudge(
      'zigzag.ratio.b-not-break-a-start',
      'ratio',
      'b浪任何部分不能超过a浪的起点（b运行总量不超a运行总量）',
      (ctx) => {
        const [p0, p1, p2] = ctx.points;
        const ext = rangeExtreme(ctx.candles, p1.index, p2.index);
        return isUp ? ext.minLow >= p0.price - 1e-9 : ext.maxHigh <= p0.price + 1e-9;
      },
      { basis: 'gross' },
    ),
    makeJudge(
      'zigzag.ratio.c-between-0.9b-and-5b',
      'ratio',
      'c浪价格须≥b浪价格的90%，且<b浪价格的5倍，且<a浪价格的5倍',
      (ctx) => {
        const [p0, p1, p2, p3] = ctx.points;
        const a = absLen(p0, p1);
        const b = absLen(p1, p2);
        const c = absLen(p2, p3);
        const cOverB = safeRatio(c, b);
        const cOverA = safeRatio(c, a);
        return cOverB !== null && cOverB >= 0.9 && cOverB < 5 && cOverA !== null && cOverA < 5;
      },
      { basis: 'price' },
    ),
    makeJudge(
      'zigzag.time.b-lt-10a',
      'time',
      'b浪时间不能超过a浪时间的10倍',
      (ctx) => {
        const [p0, p1, p2] = ctx.points;
        return legIndexTime(p1, p2) <= 10 * legIndexTime(p0, p1);
      },
    ),
    makeJudge(
      'zigzag.time.c-lt-10a-and-10b',
      'time',
      'c浪时间不能超过a浪、b浪时间的10倍',
      (ctx) => {
        const [p0, p1, p2, p3] = ctx.points;
        const aTime = legIndexTime(p0, p1);
        const bTime = legIndexTime(p1, p2);
        const cTime = legIndexTime(p2, p3);
        return cTime <= 10 * aTime && cTime <= 10 * bTime;
      },
    ),
  ];

  const guidelines = [
    makeJudge(
      'zigzag.guide.b-common-ratio',
      'ratio',
      'b浪价格接近常见比率（0.382/0.5/0.618）',
      (ctx) => {
        const [p0, p1, p2] = ctx.points;
        const r = Math.abs(safeRatio(absLen(p1, p2), absLen(p0, p1)) || 0);
        return [0.382, 0.5, 0.618].some((t) => Math.abs(r - t) < 0.08);
      },
    ),
    makeJudge(
      'zigzag.guide.c-common-ratio',
      'ratio',
      'c浪价格接近常见比率（1/0.618/1.618）',
      (ctx) => {
        const [p0, p1, p2, p3] = ctx.points;
        const r = Math.abs(safeRatio(absLen(p2, p3), absLen(p0, p1)) || 0);
        return [1, 0.618, 1.618].some((t) => Math.abs(r - t) < 0.1);
      },
    ),
    makeJudge(
      'zigzag.guide.c-not-far-beyond-1.618a',
      'ratio',
      'c浪未远超a浪的1.618倍（否则更可能是推动浪而非单锯齿）',
      (ctx) => {
        const [p0, p1, p2, p3] = ctx.points;
        const r = Math.abs(safeRatio(absLen(p2, p3), absLen(p0, p1)) || 0);
        return r <= 1.618;
      },
    ),
    makeJudge(
      'zigzag.guide.b-time-window',
      'time',
      'b浪时间落在a浪时间的61.8%~161.8%之间',
      (ctx) => {
        const [p0, p1, p2] = ctx.points;
        const r = legIndexTime(p1, p2) / legIndexTime(p0, p1);
        return r >= 0.618 && r <= 1.618;
      },
    ),
  ];

  return { patternType: 'zigzag', direction, mode: 'single', label: '单锯齿（Zigzag 5-3-5）', rules, guidelines };
}

// ---- 5.3 平台形（基础版, 3-3-5） ----

function buildFlatManual(direction, fineContext) {
  const isUp = direction === 'up';

  const rules = [
    makeJudge(
      'flat.pattern.a-is-corrective',
      'pattern',
      'a浪必须是调整浪（内部非驱动浪形态）',
      (ctx) => !legShape(fineContext.pivotsFine, ctx.points[0], ctx.points[1], direction).impulseLike,
    ),
    makeJudge(
      'flat.pattern.b-is-corrective',
      'pattern',
      'b浪必须是调整浪（内部非驱动浪形态）',
      (ctx) => !legShape(fineContext.pivotsFine, ctx.points[1], ctx.points[2], isUp ? 'down' : 'up').impulseLike,
    ),
    makeJudge(
      'flat.pattern.c-is-driving',
      'pattern',
      'c浪必须是推动浪或终结楔形（内部呈驱动浪形态）',
      (ctx) => legShape(fineContext.pivotsFine, ctx.points[2], ctx.points[3], direction).impulseLike,
    ),
    makeJudge(
      'flat.ratio.b-gross-at-least-70pct-of-a',
      'ratio',
      'b浪运行总量须≥a浪运行总量的70%',
      (ctx) => {
        const [p0, p1, p2] = ctx.points;
        const aM = computeMeasures([p0, p1], direction, ctx.candles);
        const bM = computeMeasures([p1, p2], isUp ? 'down' : 'up', ctx.candles);
        const r = safeRatio(bM.gross, aM.gross);
        return r !== null && r >= 0.7;
      },
      { basis: 'gross' },
    ),
    makeJudge(
      'flat.ratio.b-gross-below-200pct-of-a',
      'ratio',
      'b浪运行总量须<a浪运行总量的2倍',
      (ctx) => {
        const [p0, p1, p2] = ctx.points;
        const aM = computeMeasures([p0, p1], direction, ctx.candles);
        const bM = computeMeasures([p1, p2], isUp ? 'down' : 'up', ctx.candles);
        const r = safeRatio(bM.gross, aM.gross);
        return r !== null && r < 2.0;
      },
      { basis: 'gross' },
    ),
    makeJudge(
      'flat.ratio.c-overlaps-a',
      'ratio',
      'c浪必须与a浪有价格重叠',
      (ctx) => {
        const [p0, p1, p2, p3] = ctx.points;
        const aM = computeMeasures([p0, p1], direction, ctx.candles);
        const cM = computeMeasures([p2, p3], direction, ctx.candles);
        return isUp ? cM.lo <= aM.hi : cM.hi >= aM.lo;
      },
      { basis: 'gross' },
    ),
    makeJudge(
      'flat.time.b-lt-10a',
      'time',
      'b浪时间不能超过a浪时间的10倍',
      (ctx) => {
        const [p0, p1, p2] = ctx.points;
        return legIndexTime(p1, p2) <= 10 * legIndexTime(p0, p1);
      },
    ),
    makeJudge(
      'flat.time.c-lt-10a-and-10b',
      'time',
      'c浪时间不能超过a浪、b浪时间的10倍',
      (ctx) => {
        const [p0, p1, p2, p3] = ctx.points;
        const aTime = legIndexTime(p0, p1);
        const bTime = legIndexTime(p1, p2);
        const cTime = legIndexTime(p2, p3);
        return cTime <= 10 * aTime && cTime <= 10 * bTime;
      },
    ),
  ];

  const guidelines = [
    makeJudge(
      'flat.guide.b-price-window',
      'ratio',
      'b浪价格通常大于a浪价格的0.95倍、小于1.4倍',
      (ctx) => {
        const [p0, p1, p2] = ctx.points;
        const r = Math.abs(safeRatio(absLen(p1, p2), absLen(p0, p1)) || 0);
        return r >= 0.95 && r <= 1.4;
      },
      { basis: 'price' },
    ),
    makeJudge(
      'flat.guide.c-common-ratio',
      'ratio',
      'c浪接近常见比率（c=a 或 c=1.618a）',
      (ctx) => {
        const [p0, p1, p2, p3] = ctx.points;
        const r = Math.abs(safeRatio(absLen(p2, p3), absLen(p0, p1)) || 0);
        return Math.abs(r - 1) < 0.15 || Math.abs(r - 1.618) < 0.2;
      },
      { basis: 'price' },
    ),
    makeJudge(
      'flat.guide.b-time-window',
      'time',
      'b浪时间落在a浪时间的61.8%~161.8%之间',
      (ctx) => {
        const [p0, p1, p2] = ctx.points;
        const r = legIndexTime(p1, p2) / legIndexTime(p0, p1);
        return r >= 0.618 && r <= 1.618;
      },
    ),
  ];

  return { patternType: 'flat', direction, mode: 'basic', label: '平台形（Flat 3-3-5，基础版）', rules, guidelines };
}

// ---- 5.4 平台形三子类（Regular / Expanded / Running，P2）----
//
// 判据 id → 章节对照：
//   flat-regular.*   → 5.4.1 规则平台形（b∈[0.7,1]×a，c 接近 a 终点）
//   flat-expanded.*  → 5.4.2 扩散平台形（b∈(1,2)×a，c 超 a 终点但 <3×a.price）
//   flat-running.*   → 5.4.3 顺势平台形（b∈(1,2)×a，c 不超 a 终点但与 a 重叠；几乎不出现在2浪位置）

function makeFlatPatternRules(prefix, direction, fineContext) {
  const isUp = direction === 'up';
  return [
    makeJudge(
      `${prefix}.pattern.a-is-corrective`,
      'pattern',
      'a浪必须是调整浪（内部非驱动浪形态）',
      (ctx) => !legShape(fineContext.pivotsFine, ctx.points[0], ctx.points[1], direction).impulseLike,
    ),
    makeJudge(
      `${prefix}.pattern.b-is-corrective`,
      'pattern',
      'b浪必须是调整浪（内部非驱动浪形态）',
      (ctx) => !legShape(fineContext.pivotsFine, ctx.points[1], ctx.points[2], isUp ? 'down' : 'up').impulseLike,
    ),
    makeJudge(
      `${prefix}.pattern.c-is-driving`,
      'pattern',
      'c浪必须是推动浪或终结楔形（内部呈驱动浪形态）',
      (ctx) => legShape(fineContext.pivotsFine, ctx.points[2], ctx.points[3], direction).impulseLike,
    ),
  ];
}

function makeFlatTimeRules(prefix) {
  return [
    makeJudge(`${prefix}.time.b-lt-10a`, 'time', 'b浪时间不能超过a浪时间的10倍', (ctx) => {
      const [p0, p1, p2] = ctx.points;
      return legIndexTime(p1, p2) <= 10 * legIndexTime(p0, p1);
    }),
    makeJudge(`${prefix}.time.c-lt-10a-and-10b`, 'time', 'c浪时间不能超过a浪、b浪时间的10倍', (ctx) => {
      const [p0, p1, p2, p3] = ctx.points;
      const aTime = legIndexTime(p0, p1);
      const bTime = legIndexTime(p1, p2);
      const cTime = legIndexTime(p2, p3);
      return cTime <= 10 * aTime && cTime <= 10 * bTime;
    }),
  ];
}

function buildRegularFlatManual(direction, fineContext) {
  const isUp = direction === 'up';
  const prefix = 'flat-regular';

  const rules = [
    ...makeFlatPatternRules(prefix, direction, fineContext),
    makeJudge(
      `${prefix}.ratio.b-gross-0.7-to-1.0-of-a`,
      'ratio',
      '规则平台形：b浪运行总量须在a浪运行总量的70%~100%之间',
      (ctx) => {
        const [p0, p1, p2] = ctx.points;
        const aM = computeMeasures([p0, p1], direction, ctx.candles);
        const bM = computeMeasures([p1, p2], isUp ? 'down' : 'up', ctx.candles);
        const r = safeRatio(bM.gross, aM.gross);
        return r !== null && r >= 0.7 && r <= 1.0;
      },
      { basis: 'gross' },
    ),
    makeJudge(
      `${prefix}.ratio.c-overlaps-a`,
      'ratio',
      'c浪必须与a浪有价格重叠',
      (ctx) => {
        const [p0, p1, p2, p3] = ctx.points;
        const aM = computeMeasures([p0, p1], direction, ctx.candles);
        const cM = computeMeasures([p2, p3], direction, ctx.candles);
        return isUp ? cM.lo <= aM.hi : cM.hi >= aM.lo;
      },
      { basis: 'gross' },
    ),
    ...makeFlatTimeRules(prefix),
  ];

  const guidelines = [
    makeJudge(
      `${prefix}.guide.c-common-ratio`,
      'ratio',
      'c浪运行总量接近a浪(或b浪)运行总量的0.618/1/1.236倍',
      (ctx) => {
        const [p0, p1, p2, p3] = ctx.points;
        const aM = computeMeasures([p0, p1], direction, ctx.candles);
        const cM = computeMeasures([p2, p3], direction, ctx.candles);
        const r = Math.abs(safeRatio(cM.gross, aM.gross) || 0);
        return [0.618, 1, 1.236].some((t) => Math.abs(r - t) < 0.12);
      },
      { basis: 'gross' },
    ),
  ];

  return { patternType: 'flat', direction, mode: 'regular', label: '平台形（规则平台形 Regular Flat）', rules, guidelines };
}

function buildExpandedFlatManual(direction, fineContext) {
  const isUp = direction === 'up';
  const prefix = 'flat-expanded';

  const rules = [
    ...makeFlatPatternRules(prefix, direction, fineContext),
    makeJudge(
      `${prefix}.ratio.b-gross-1.0-to-2.0-of-a`,
      'ratio',
      '扩散平台形：b浪运行总量须大于a浪运行总量、且小于其2倍',
      (ctx) => {
        const [p0, p1, p2] = ctx.points;
        const aM = computeMeasures([p0, p1], direction, ctx.candles);
        const bM = computeMeasures([p1, p2], isUp ? 'down' : 'up', ctx.candles);
        const r = safeRatio(bM.gross, aM.gross);
        return r !== null && r > 1.0 && r < 2.0;
      },
      { basis: 'gross' },
    ),
    makeJudge(
      `${prefix}.ratio.c-exceeds-a-end`,
      'ratio',
      'c浪须超过a浪终点',
      (ctx) => {
        const [, p1, , p3] = ctx.points;
        return isUp ? p3.price > p1.price : p3.price < p1.price;
      },
      { basis: 'price' },
    ),
    makeJudge(
      `${prefix}.ratio.c-below-3x-a-price`,
      'ratio',
      'c浪价格须小于a浪价格的3倍',
      (ctx) => {
        const [p0, p1, p2, p3] = ctx.points;
        const r = safeRatio(absLen(p2, p3), absLen(p0, p1));
        return r !== null && r < 3.0;
      },
      { basis: 'price' },
    ),
    ...makeFlatTimeRules(prefix),
  ];

  const guidelines = [
    makeJudge(
      `${prefix}.guide.b-near-1.236a`,
      'ratio',
      'b浪运行总量接近a浪运行总量的1.236倍',
      (ctx) => {
        const [p0, p1, p2] = ctx.points;
        const aM = computeMeasures([p0, p1], direction, ctx.candles);
        const bM = computeMeasures([p1, p2], isUp ? 'down' : 'up', ctx.candles);
        const r = Math.abs(safeRatio(bM.gross, aM.gross) || 0);
        return Math.abs(r - 1.236) < 0.2;
      },
      { basis: 'gross' },
    ),
    makeJudge(
      `${prefix}.guide.c-near-1.618a`,
      'ratio',
      'c浪运行总量接近a浪运行总量的1.618倍',
      (ctx) => {
        const [p0, p1, p2, p3] = ctx.points;
        const aM = computeMeasures([p0, p1], direction, ctx.candles);
        const cM = computeMeasures([p2, p3], direction, ctx.candles);
        const r = Math.abs(safeRatio(cM.gross, aM.gross) || 0);
        return Math.abs(r - 1.618) < 0.25;
      },
      { basis: 'gross' },
    ),
  ];

  return { patternType: 'flat', direction, mode: 'expanded', label: '平台形（扩散平台形 Expanded Flat）', rules, guidelines };
}

function buildRunningFlatManual(direction, fineContext) {
  const isUp = direction === 'up';
  const prefix = 'flat-running';

  const rules = [
    ...makeFlatPatternRules(prefix, direction, fineContext),
    makeJudge(
      `${prefix}.pattern.not-wave2-position`,
      'pattern',
      '顺势平台形几乎不出现在2浪位置',
      (ctx) => ctx.positionHint !== 'wave2',
    ),
    makeJudge(
      `${prefix}.ratio.b-gross-1.0-to-2.0-of-a`,
      'ratio',
      '顺势平台形：b浪运行总量须大于a浪运行总量、且小于其2倍',
      (ctx) => {
        const [p0, p1, p2] = ctx.points;
        const aM = computeMeasures([p0, p1], direction, ctx.candles);
        const bM = computeMeasures([p1, p2], isUp ? 'down' : 'up', ctx.candles);
        const r = safeRatio(bM.gross, aM.gross);
        return r !== null && r > 1.0 && r < 2.0;
      },
      { basis: 'gross' },
    ),
    makeJudge(
      `${prefix}.ratio.c-not-exceed-a-end`,
      'ratio',
      'c浪不超过a浪终点',
      (ctx) => {
        const [, p1, , p3] = ctx.points;
        return isUp ? p3.price <= p1.price : p3.price >= p1.price;
      },
      { basis: 'price' },
    ),
    makeJudge(
      `${prefix}.ratio.c-overlaps-a`,
      'ratio',
      'c浪须与a浪有重叠（切入a浪起点附近）',
      (ctx) => {
        const [p0, p1, p2, p3] = ctx.points;
        const aM = computeMeasures([p0, p1], direction, ctx.candles);
        const cM = computeMeasures([p2, p3], direction, ctx.candles);
        return isUp ? cM.hi >= aM.lo : cM.lo <= aM.hi;
      },
      { basis: 'gross' },
    ),
    ...makeFlatTimeRules(prefix),
  ];

  const guidelines = [
    makeJudge(
      `${prefix}.guide.c-in-0.618-to-1.0-of-a`,
      'ratio',
      'c浪运行总量接近a浪(或b浪)运行总量的0.618~1倍',
      (ctx) => {
        const [p0, p1, p2, p3] = ctx.points;
        const aM = computeMeasures([p0, p1], direction, ctx.candles);
        const cM = computeMeasures([p2, p3], direction, ctx.candles);
        const r = Math.abs(safeRatio(cM.gross, aM.gross) || 0);
        return r >= 0.55 && r <= 1.05;
      },
      { basis: 'gross' },
    ),
    makeJudge(
      `${prefix}.guide.alternation-with-wave2`,
      'pattern',
      '交替原则：若2浪呈陡直形态，顺势平台形（横向）作为4浪更常见',
      (ctx) => ctx.wave2Style === 'steep',
    ),
  ];

  return { patternType: 'flat', direction, mode: 'running', label: '平台形（顺势平台形 Running Flat）', rules, guidelines };
}

// ---- 5.5 收缩三角形（Contracting Triangle, a-b-c-d-e, P2）----
//
// 判据 id → 章节对照：triangle.pattern.legs-converge → 6.4/6.7；
// triangle.pattern.wave4-not-cross-wave1 → 6.20「收缩三角形作为4浪时不能切入1浪」；
// triangle.guide.e-fakeout → 6.19「e浪的骗线」（此处用非通道几何的轻量代理实现，
// 真正基于通道边界的骗线判定留给 P3 的艾略特通道模块）。
//
// 范围限定：P2 仅在「4浪位置」（某个6点推动浪窗口的 p3→p4 子区间）生成三角形候选，
// 尚不做自由式扫描——这与本书三角形最常见于4浪/B浪/最后一浪位置的论述一致，
// 也是「4浪不能切入1浪」规则天然适用的位置。

function buildContractingTriangleManual(direction, options = {}) {
  const wave1Ref = options.wave1Ref || null;

  const rules = [
    makeJudge(
      'triangle.pattern.legs-converge',
      'pattern',
      '各子浪振幅须依次收敛（c<=a, d<=b, e<=c）',
      (ctx) => {
        const [p0, p1, p2, p3, p4, p5] = ctx.points;
        const w1 = absLen(p0, p1);
        const w2 = absLen(p1, p2);
        const w3 = absLen(p2, p3);
        const w4 = absLen(p3, p4);
        const w5 = absLen(p4, p5);
        return w3 <= w1 && w4 <= w2 && w5 <= w3;
      },
    ),
    makeJudge(
      'triangle.pattern.wave4-not-cross-wave1',
      'pattern',
      '收缩三角形作为4浪时，任一子浪不能切入1浪终点',
      (ctx) => {
        if (!wave1Ref) return true;
        const prices = ctx.points.map((p) => p.price);
        return wave1Ref.impulseDirection === 'up'
          ? Math.min(...prices) > wave1Ref.p1.price
          : Math.max(...prices) < wave1Ref.p1.price;
      },
    ),
  ];

  const guidelines = [
    makeJudge(
      'triangle.guide.e-fakeout',
      'pattern',
      'e浪内部出现超出其净价格区间的插针，可能是突破假象（骗线）迹象',
      (ctx) => {
        const [, , , p3, p4, p5] = ctx.points;
        const ext = rangeExtreme(ctx.candles, p4.index, p5.index);
        const netHi = Math.max(p4.price, p5.price);
        const netLo = Math.min(p4.price, p5.price);
        const span = Math.max(1e-9, netHi - netLo);
        return (ext.maxHigh - netHi) > span * 0.05 || (netLo - ext.minLow) > span * 0.05;
      },
    ),
  ];

  return {
    patternType: 'triangle',
    direction,
    mode: 'contracting',
    label: '收缩三角形（Contracting Triangle a-b-c-d-e）',
    rules,
    guidelines,
  };
}

// ---- 5.6 锯齿类分级：双锯齿 / 三锯齿（P2）----
//
// 与单锯齿的区别：单锯齿的 a/c 腿须是「驱动浪形态」；双/三锯齿的 w/y/z 腿
// 须自身恰好呈「单锯齿形态」（legIsZigzagShaped），x/xx 连接段须是调整浪。
// 判据 id → 章节对照：zigzag-double.* / zigzag-triple.* → 第7章 双锯齿/三锯齿。

function buildDoubleZigzagManual(direction, fineContext) {
  const isUp = direction === 'up';

  const rules = [
    makeJudge(
      'zigzag-double.pattern.w-is-zigzag-shaped',
      'pattern',
      'w浪自身须呈单锯齿形态（而非驱动浪）',
      (ctx) => legIsZigzagShaped(fineContext.pivotsFine, ctx.points[0], ctx.points[1], direction, ctx.candles),
    ),
    makeJudge(
      'zigzag-double.pattern.x-is-corrective',
      'pattern',
      'x连接段须是调整浪',
      (ctx) => !legShape(fineContext.pivotsFine, ctx.points[1], ctx.points[2], isUp ? 'down' : 'up').impulseLike,
    ),
    makeJudge(
      'zigzag-double.pattern.y-is-zigzag-shaped',
      'pattern',
      'y浪自身须呈单锯齿形态',
      (ctx) => legIsZigzagShaped(fineContext.pivotsFine, ctx.points[2], ctx.points[3], direction, ctx.candles),
    ),
  ];

  const guidelines = [
    makeJudge(
      'zigzag-double.guide.y-not-far-below-w',
      'ratio',
      'y浪价格与w浪价格量级相当（未远小于w浪）',
      (ctx) => {
        const [p0, p1, p2, p3] = ctx.points;
        const r = Math.abs(safeRatio(absLen(p2, p3), absLen(p0, p1)) || 0);
        return r >= 0.382;
      },
    ),
  ];

  return { patternType: 'zigzag', direction, mode: 'double', label: '双锯齿（Double Zigzag, w-x-y）', rules, guidelines };
}

function buildTripleZigzagManual(direction, fineContext) {
  const isUp = direction === 'up';

  const rules = [
    makeJudge(
      'zigzag-triple.pattern.w-is-zigzag-shaped',
      'pattern',
      'w浪自身须呈单锯齿形态',
      (ctx) => legIsZigzagShaped(fineContext.pivotsFine, ctx.points[0], ctx.points[1], direction, ctx.candles),
    ),
    makeJudge(
      'zigzag-triple.pattern.x-is-corrective',
      'pattern',
      'x连接段须是调整浪',
      (ctx) => !legShape(fineContext.pivotsFine, ctx.points[1], ctx.points[2], isUp ? 'down' : 'up').impulseLike,
    ),
    makeJudge(
      'zigzag-triple.pattern.y-is-zigzag-shaped',
      'pattern',
      'y浪自身须呈单锯齿形态',
      (ctx) => legIsZigzagShaped(fineContext.pivotsFine, ctx.points[2], ctx.points[3], direction, ctx.candles),
    ),
    makeJudge(
      'zigzag-triple.pattern.xx-is-corrective',
      'pattern',
      'xx连接段须是调整浪',
      (ctx) => !legShape(fineContext.pivotsFine, ctx.points[3], ctx.points[4], isUp ? 'down' : 'up').impulseLike,
    ),
    makeJudge(
      'zigzag-triple.pattern.z-is-zigzag-shaped',
      'pattern',
      'z浪自身须呈单锯齿形态',
      (ctx) => legIsZigzagShaped(fineContext.pivotsFine, ctx.points[4], ctx.points[5], direction, ctx.candles),
    ),
  ];

  const guidelines = [];

  return { patternType: 'zigzag', direction, mode: 'triple', label: '三锯齿（Triple Zigzag, w-x-y-xx-z）', rules, guidelines };
}

// ---- 5.7 联合形：双重 / 三重横向整理（P2）----
//
// 与双/三锯齿的区别：w/y/z 腿只需是「任意调整浪」（不要求恰好是单锯齿形态），
// 但连接段有明确的量化门槛——x 须回撤 w 的70%（三重整理另加 xx 须回撤 y 的70%）。
// 判据 id → 章节对照：sideways-double.* / sideways-triple.* → 第8章 联合形。

function buildDoubleSidewaysManual(direction, fineContext) {
  const rules = [
    makeJudge(
      'sideways-double.pattern.w-is-corrective',
      'pattern',
      'w浪须是调整浪',
      (ctx) => !legShape(fineContext.pivotsFine, ctx.points[0], ctx.points[1], direction).impulseLike,
    ),
    makeJudge(
      'sideways-double.pattern.y-is-corrective',
      'pattern',
      'y浪须是调整浪',
      (ctx) => !legShape(fineContext.pivotsFine, ctx.points[2], ctx.points[3], direction).impulseLike,
    ),
    makeJudge(
      'sideways-double.ratio.x-retrace-70pct-of-w',
      'ratio',
      'x浪须回撤w浪运行总量的70%以上',
      (ctx) => {
        const [p0, p1, p2] = ctx.points;
        const wM = computeMeasures([p0, p1], direction, ctx.candles);
        const xM = computeMeasures([p1, p2], direction === 'up' ? 'down' : 'up', ctx.candles);
        const r = safeRatio(xM.gross, wM.gross);
        return r !== null && r >= 0.7;
      },
      { basis: 'gross' },
    ),
  ];

  const guidelines = [];

  return { patternType: 'sideways', direction, mode: 'double', label: '双重横向整理（Double Sideways, w-x-y）', rules, guidelines };
}

function buildTripleSidewaysManual(direction, fineContext) {
  const rules = [
    makeJudge(
      'sideways-triple.pattern.w-is-corrective',
      'pattern',
      'w浪须是调整浪',
      (ctx) => !legShape(fineContext.pivotsFine, ctx.points[0], ctx.points[1], direction).impulseLike,
    ),
    makeJudge(
      'sideways-triple.pattern.y-is-corrective',
      'pattern',
      'y浪须是调整浪',
      (ctx) => !legShape(fineContext.pivotsFine, ctx.points[2], ctx.points[3], direction).impulseLike,
    ),
    makeJudge(
      'sideways-triple.pattern.z-is-corrective',
      'pattern',
      'z浪须是调整浪',
      (ctx) => !legShape(fineContext.pivotsFine, ctx.points[4], ctx.points[5], direction).impulseLike,
    ),
    makeJudge(
      'sideways-triple.ratio.x-retrace-70pct-of-w',
      'ratio',
      'x浪须回撤w浪运行总量的70%以上',
      (ctx) => {
        const [p0, p1, p2] = ctx.points;
        const wM = computeMeasures([p0, p1], direction, ctx.candles);
        const xM = computeMeasures([p1, p2], direction === 'up' ? 'down' : 'up', ctx.candles);
        const r = safeRatio(xM.gross, wM.gross);
        return r !== null && r >= 0.7;
      },
      { basis: 'gross' },
    ),
    makeJudge(
      'sideways-triple.ratio.xx-retrace-70pct-of-y',
      'ratio',
      'xx浪须回撤y浪运行总量的70%以上',
      (ctx) => {
        const [, , , p3, p4] = ctx.points;
        const yM = computeMeasures([ctx.points[2], p3], direction, ctx.candles);
        const xxM = computeMeasures([p3, p4], direction === 'up' ? 'down' : 'up', ctx.candles);
        const r = safeRatio(xxM.gross, yM.gross);
        return r !== null && r >= 0.7;
      },
      { basis: 'gross' },
    ),
  ];

  const guidelines = [];

  return { patternType: 'sideways', direction, mode: 'triple', label: '三重横向整理（Triple Sideways, w-x-y-xx-z）', rules, guidelines };
}

// ============================================================
// 6. 候选扫描与排名
// ============================================================

function pointTypesMatch(points, expectedTypes) {
  if (points.length !== expectedTypes.length) return false;
  return points.every((p, i) => p.type === expectedTypes[i]);
}

function makeRecorder(candles, survivors, eliminated) {
  return (patternType, direction, manual, points, extraCtx = {}) => {
    const measures = computeMeasures(points, direction, candles);
    const ctx = { points, direction, candles, measures, ...extraCtx };
    const evalResult = evaluateManual(ctx, manual);
    const candidate = {
      patternType: manual.patternType,
      mode: manual.mode,
      direction,
      label: manual.label,
      points,
      measures,
      startIndex: points[0].index,
      endIndex: points[points.length - 1].index,
      startTime: points[0].timestamp,
      endTime: points[points.length - 1].timestamp,
      evalResult,
    };
    if (evalResult.survived) survivors.push(candidate);
    else eliminated.push(candidate);
  };
}

function scanCandidates(pivots, candles, fineContext) {
  const survivors = [];
  const eliminated = [];
  const record = makeRecorder(candles, survivors, eliminated);

  // 推动浪：6 点窗口（标准推动浪 + 引导/终结楔形）。
  // 楔形位置采用简化启发式：整个序列的第一个窗口（i===0，前面没有更早的观测数据）
  // 视为引导楔形候选；其余窗口默认按终结楔形处理（书中讨论更多、实盘也更常见的子类）。
  for (let i = 0; i <= pivots.length - 6; i += 1) {
    const seg = pivots.slice(i, i + 6);
    const diagonalPosition = i === 0 ? 'leading' : 'ending';
    if (pointTypesMatch(seg, ['L', 'H', 'L', 'H', 'L', 'H'])) {
      record('impulse', 'up', buildImpulseStrictManual('up'), seg);
      record('impulse', 'up', buildImpulseDiagonalManual('up', diagonalPosition), seg);
    } else if (pointTypesMatch(seg, ['H', 'L', 'H', 'L', 'H', 'L'])) {
      record('impulse', 'down', buildImpulseStrictManual('down'), seg);
      record('impulse', 'down', buildImpulseDiagonalManual('down', diagonalPosition), seg);
    }
  }

  // 三锯齿 / 三重横向整理：6 点窗口（w-x-y-xx-z，自由扫描，不要求特定位置）
  for (let i = 0; i <= pivots.length - 6; i += 1) {
    const seg = pivots.slice(i, i + 6);
    if (pointTypesMatch(seg, ['L', 'H', 'L', 'H', 'L', 'H'])) {
      record('zigzag', 'up', buildTripleZigzagManual('up', fineContext), seg);
      record('sideways', 'up', buildTripleSidewaysManual('up', fineContext), seg);
    } else if (pointTypesMatch(seg, ['H', 'L', 'H', 'L', 'H', 'L'])) {
      record('zigzag', 'down', buildTripleZigzagManual('down', fineContext), seg);
      record('sideways', 'down', buildTripleSidewaysManual('down', fineContext), seg);
    }
  }

  // 单锯齿 / 双锯齿 / 平台形三子类 / 双重横向整理：4 点窗口
  for (let i = 0; i <= pivots.length - 4; i += 1) {
    const seg = pivots.slice(i, i + 4);
    if (pointTypesMatch(seg, ['L', 'H', 'L', 'H'])) {
      record('zigzag', 'up', buildSingleZigzagManual('up', fineContext), seg);
      record('zigzag', 'up', buildDoubleZigzagManual('up', fineContext), seg);
      record('flat', 'up', buildRegularFlatManual('up', fineContext), seg);
      record('flat', 'up', buildExpandedFlatManual('up', fineContext), seg);
      record('flat', 'up', buildRunningFlatManual('up', fineContext), seg);
      record('sideways', 'up', buildDoubleSidewaysManual('up', fineContext), seg);
    } else if (pointTypesMatch(seg, ['H', 'L', 'H', 'L'])) {
      record('zigzag', 'down', buildSingleZigzagManual('down', fineContext), seg);
      record('zigzag', 'down', buildDoubleZigzagManual('down', fineContext), seg);
      record('flat', 'down', buildRegularFlatManual('down', fineContext), seg);
      record('flat', 'down', buildExpandedFlatManual('down', fineContext), seg);
      record('flat', 'down', buildRunningFlatManual('down', fineContext), seg);
      record('sideways', 'down', buildDoubleSidewaysManual('down', fineContext), seg);
    }
  }

  return { survivors, eliminated };
}

/**
 * 位置相关的修正浪候选：顺势平台形（2浪位置）与收缩三角形（4浪位置）。
 * 这两个浪型的部分规则/指引依赖「这是哪一浪」的位置信息（书 5.4.3、6.20、1.7 交替原则），
 * 而这种位置信息只有在一个假设性的推动浪窗口内部才有意义——因此复用推动浪的
 * 6 点滑动窗口作为位置锚点：[p1,p2] 视为该窗口的 2 浪腿，[p3,p4] 视为 4 浪腿，
 * 分别在其细粒度枢轴上尝试更精细的修正浪结构。不要求外层 6 点窗口本身通过
 * 推动浪验证手册——候选生成阶段本就应「大胆假设」，筛选交给否定法。
 */
function scanPositionalCandidates(pivots, pivotsFine, candles) {
  const survivors = [];
  const eliminated = [];
  const record = makeRecorder(candles, survivors, eliminated);

  for (let i = 0; i <= pivots.length - 6; i += 1) {
    const seg = pivots.slice(i, i + 6);
    let direction = null;
    if (pointTypesMatch(seg, ['L', 'H', 'L', 'H', 'L', 'H'])) direction = 'up';
    else if (pointTypesMatch(seg, ['H', 'L', 'H', 'L', 'H', 'L'])) direction = 'down';
    else continue;

    const [p0, p1, p2, p3, p4] = seg;
    const oppositeDir = direction === 'up' ? 'down' : 'up';
    const wave2Style = classifyLegStyle(pivotsFine, p1, p2, oppositeDir, candles);

    const leg2Fine = buildSegmentPivots(pivotsFine, p1, p2);
    if (leg2Fine.length === 4) {
      record(
        'flat',
        oppositeDir,
        buildRunningFlatManual(oppositeDir, { pivotsFine }),
        leg2Fine,
        { positionHint: 'wave2' },
      );
    }

    const leg4Fine = buildSegmentPivots(pivotsFine, p3, p4);
    if (leg4Fine.length === 6) {
      record(
        'triangle',
        oppositeDir,
        buildContractingTriangleManual(oppositeDir, {
          positionHint: 'wave4',
          wave1Ref: { p0, p1, impulseDirection: direction },
        }),
        leg4Fine,
        { positionHint: 'wave4', wave2Style },
      );
    }
  }

  return { survivors, eliminated };
}

function rankSurvivors(survivors) {
  return survivors.slice().sort((a, b) => {
    const scoreDiff = (b.evalResult.guidelineScore || 0) - (a.evalResult.guidelineScore || 0);
    if (scoreDiff !== 0) return scoreDiff;
    return b.endIndex - a.endIndex;
  });
}

// ============================================================
// 6b. P3：艾略特通道 / 斐波那契 / 级别体系
// ============================================================

// ---- 艾略特通道（wave-channels）----
//
// 章节对照：第 2 章。三类通道：
//   平行（parallel）——推动浪、单/双/三锯齿、平台形（规则/顺势）、双三重横向整理
//   收缩（contracting）——引导/终结楔形、收缩三角形
//   扩散（expanding）——扩散平台形
// 通道一律用算术坐标（书 2.7/3.9），线以两枢轴锚点表示：y(x)=a.price+slope·(x-a.index)。

function lineThrough(a, b) {
  const dx = (b.index - a.index) || 1;
  const slope = (b.price - a.price) / dx;
  return {
    from: a,
    to: b,
    slope,
    at: (index) => a.price + slope * (index - a.index),
  };
}

function lineParallelThrough(refLine, anchor) {
  return {
    from: anchor,
    slope: refLine.slope,
    at: (index) => anchor.price + refLine.slope * (index - anchor.index),
  };
}

function channelTypeFor(candidate) {
  const { patternType, mode } = candidate;
  if (mode === 'leading_diagonal' || mode === 'ending_diagonal') return 'contracting';
  if (patternType === 'triangle') return 'contracting';
  if (patternType === 'flat' && mode === 'expanded') return 'expanding';
  return 'parallel';
}

/**
 * 按浪型指定的子浪拐点构建艾略特通道。返回 { channelType, base, rail, note }，
 * base/rail 为两条边界线（含 at(index) 投影）。构建不出时返回 null。
 */
function buildChannel(candidate) {
  const p = candidate.points;
  const channelType = channelTypeFor(candidate);
  const { patternType, mode } = candidate;

  // 推动浪（标准）：连 2、4 浪终点为基线，过 1 浪终点作平行线（书 2.x 经典画法）
  if (patternType === 'impulse' && mode === 'strict' && p.length >= 6) {
    const base = lineThrough(p[2], p[4]);
    const rail = lineParallelThrough(base, p[1]);
    return { channelType, base, rail, note: '连 2、4 浪终点为基线，过 1 浪终点作平行线' };
  }

  // 楔形：收缩通道——连 1、3 浪终点与 2、4 浪终点两条收敛线
  if (patternType === 'impulse' && (mode === 'leading_diagonal' || mode === 'ending_diagonal') && p.length >= 5) {
    const line13 = lineThrough(p[1], p[3]);
    const line24 = lineThrough(p[2], p[4]);
    return { channelType, base: line24, rail: line13, note: '连 1、3 与 2、4 浪终点，形成收敛通道' };
  }

  // 收缩三角形：连 a、c（p1,p3）与 b、d（p2,p4）两条收敛线（书 6.5/6.14）
  if (patternType === 'triangle' && p.length >= 6) {
    const lineAC = lineThrough(p[1], p[3]);
    const lineBD = lineThrough(p[2], p[4]);
    return { channelType, base: lineBD, rail: lineAC, note: '连 a、c 终点与 b、d 终点，形成收缩三角通道' };
  }

  // 单/双锯齿、平台形、横向整理（4 点 0-a-b-c 或 w-x-y）：前两点取 0 与 b、第三点取 a
  if (p.length >= 4) {
    const base = lineThrough(p[0], p[2]);
    const rail = lineParallelThrough(base, p[1]);
    const note = channelType === 'expanding'
      ? '连 0 与 b、过 a 作参考线（扩散平台形对应扩散通道）'
      : '连 0 与 b 为基线，过 a 作平行线（c 到达 a 的 1 倍时正好触通道边缘）';
    return { channelType, base, rail, note };
  }

  return null;
}

/**
 * 通道作用一：价格有效流出通道 ⇒ 提示上一浪型可能已完成（Guideline，书 2.5）。
 * 在候选结束后的 horizon 根 K 线内，若收盘越过通道相应边界，返回提示文本；否则 null。
 */
function channelExitHint(candidate, candles, channel, horizon = 10) {
  if (!channel) return null;
  const endIdx = candidate.endIndex;
  const isUp = candidate.direction === 'up';
  // 上涨浪型完成后应向下跌破下轨；下跌浪型完成后应向上升破上轨。
  const boundaryLine = isUp
    ? (channel.base.slope <= channel.rail.slope ? channel.base : channel.rail)
    : (channel.base.slope >= channel.rail.slope ? channel.base : channel.rail);
  for (let i = endIdx + 1; i <= Math.min(candles.length - 1, endIdx + horizon); i += 1) {
    const c = candles[i];
    if (!c) continue;
    const boundary = boundaryLine.at(i);
    if (isUp && c.close < boundary) {
      return `价格于 ${formatToUtcOffset(new Date(c.timestamp * 1000))} 收盘跌破通道下轨（${fmtNum(boundary)}），提示该${candidate.label}可能已完成`;
    }
    if (!isUp && c.close > boundary) {
      return `价格于 ${formatToUtcOffset(new Date(c.timestamp * 1000))} 收盘升破通道上轨（${fmtNum(boundary)}），提示该${candidate.label}可能已完成`;
    }
  }
  return null;
}

/**
 * 通道作用二：用通道边缘预测下一拐点的价格（书 2.5，仅辅助非确定）。
 * 取候选最后一段的平均时长作为投影步长，给出两条边界在该未来位置的价格。
 */
function channelNextPivotProjection(candidate, channel) {
  if (!channel) return null;
  const p = candidate.points;
  const lastLegSpan = Math.max(1, p[p.length - 1].index - p[p.length - 2].index);
  const projIndex = candidate.endIndex + lastLegSpan;
  return {
    projIndex,
    baseAt: channel.base.at(projIndex),
    railAt: channel.rail.at(projIndex),
  };
}

// ---- 斐波那契（wave-fibonacci）----
//
// 章节对照：3.18（回撤）、3.19（扩展）、3.22（时间周期/共振）。

const FIB_RETRACE_RATIOS = [0.236, 0.382, 0.5, 0.618, 0.7, 0.786];
const FIB_EXTENSION_RATIOS = [0.5, 0.618, 1, 1.618, 2, 2.618];
const FIB_SEQUENCE = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144];

/**
 * 判断推动浪是否 5 浪衰竭（5 浪终点未超过 3 浪终点）。
 */
function isImpulseFailure(candidate) {
  if (candidate.patternType !== 'impulse' || candidate.points.length < 6) return false;
  const p = candidate.points;
  return candidate.direction === 'up' ? p[5].price < p[3].price : p[5].price > p[3].price;
}

/**
 * 回撤取点规则（书 3.18.3）：返回 { from, to } 两拐点及回撤价位表。
 */
function fibRetracementForPattern(candidate) {
  const p = candidate.points;
  const { patternType, mode } = candidate;
  let from = p[0];
  let to = p[p.length - 1];

  if (patternType === 'impulse' && (mode === 'strict' || mode === 'leading_diagonal' || mode === 'ending_diagonal')) {
    // 未衰竭取 0 与 5；衰竭取 0 与 3
    to = isImpulseFailure(candidate) ? p[3] : p[5];
  } else if (patternType === 'zigzag' && mode === 'triple') {
    to = p[5]; // 0 与 z
  } else if (patternType === 'sideways' && mode === 'triple') {
    to = p[5]; // 0 与 z
  } else {
    // 单/双锯齿(0-c 或 0-y)、平台形(0-c)、双重横向整理(0-y)：4 点窗口的末点
    to = p[3] !== undefined ? p[3] : p[p.length - 1];
  }

  const hi = Math.max(from.price, to.price);
  const lo = Math.min(from.price, to.price);
  const span = hi - lo;
  const levels = FIB_RETRACE_RATIOS.map((r) => ({
    ratio: r,
    // 回撤自 to 向 from 方向折返
    price: candidate.direction === 'up' ? to.price - span * r : to.price + span * r,
  }));
  return { from, to, span, levels };
}

/**
 * 扩展取点规则（书 3.19.3）：按预测目标返回 3 个锚点。
 * 若中间浪（第 3 个点所属子浪）是收缩三角形，调用方应改取其 e 点——
 * 此处提供 triangleERef 覆盖 point3。
 */
function fibExtensionPoints(candidate, targetWave, triangleERef = null) {
  const p = candidate.points;
  const { patternType, mode } = candidate;
  let idx = null;

  if (patternType === 'impulse') {
    if (targetWave === 'wave3') idx = [0, 1, 2];
    else if (targetWave === 'wave5') idx = [0, 1, 4];
  } else if (patternType === 'zigzag' && (mode === 'single')) {
    if (targetWave === 'waveC') idx = [0, 1, 2]; // 0/a/b
  } else if (patternType === 'flat') {
    if (targetWave === 'waveC') idx = [0, 1, 2]; // 0/a/b
  } else if (patternType === 'zigzag' && mode === 'double') {
    if (targetWave === 'waveY') idx = [0, 1, 2]; // 0/w/x
  } else if (patternType === 'sideways' && mode === 'double') {
    if (targetWave === 'waveY') idx = [0, 1, 2];
  } else if ((patternType === 'zigzag' || patternType === 'sideways') && mode === 'triple') {
    if (targetWave === 'waveZ') idx = [2, 3, 4]; // x/y/xx
  }

  if (!idx) return null;
  const pts = idx.map((i) => p[i]);
  if (triangleERef) pts[2] = triangleERef; // 中间浪为三角形时第 3 点取 e
  const [a, b, c] = pts;
  const legLen = Math.abs(b.price - a.price);
  const dir = candidate.direction === 'up' ? 1 : -1;
  const levels = FIB_EXTENSION_RATIOS.map((r) => ({
    ratio: r,
    price: c.price + dir * legLen * r,
  }));
  return { points: pts, legLen, levels };
}

/**
 * 斐波那契时间周期与共振日（书 3.22）。从每个枢轴向后按斐波数列标记潜在拐点 K 线，
 * 两个枢轴的序列日落在同一根 K 线时标为共振日。返回共振日索引及命中的枢轴对。
 */
function fibTimeResonance(pivots, candleCount) {
  const marks = new Map(); // barIndex -> [pivotIndex...]
  for (const piv of pivots) {
    for (const n of FIB_SEQUENCE) {
      const bar = piv.index + n;
      if (bar >= candleCount) break;
      if (!marks.has(bar)) marks.set(bar, []);
      marks.get(bar).push(piv.index);
    }
  }
  const resonances = [];
  for (const [bar, srcs] of marks.entries()) {
    if (srcs.length >= 2) resonances.push({ bar, sources: srcs });
  }
  resonances.sort((a, b) => a.bar - b.bar);
  return resonances;
}

// ---- 级别体系（wave-degree）----
//
// 章节对照：3.2（级别概念）、3.10（月→周→日 自顶向下）、3.23（级别与手册的关系）。
//
// 单时间框内的「级别」用逐级放大的枢轴过滤近似（分形等价）：级别数字越小越粗（大级别）。
// 这解决了「一段大跌含数十个枢轴、无法套进任一 4/6 点窗口」的问题——在更粗的级别上，
// 大结构会坍缩为少数枢轴，从而能被 ABC/12345/WXY 手册识别。跨时间框（真正的月→周→日）
// 需要分别取数，属后续工作；此处以「同一时间框、逐级放大过滤」实现自顶向下的等价能力。

const DEGREE_CONFIGS = [
  { degree: 0, label: '0（最粗·大级别）', lookbackMult: 4, atrMult: 3 },
  { degree: 1, label: '1（中级别）', lookbackMult: 2, atrMult: 2 },
  { degree: 2, label: '2（最细·小级别）', lookbackMult: 1, atrMult: 1 },
];

function scanAtDegree(candles, cfg, baseLookback, baseAtrMultiplier, atrSeries, pivotsFine) {
  const lookback = Math.max(1, Math.round(baseLookback * cfg.lookbackMult));
  const atrMultiplier = baseAtrMultiplier * cfg.atrMult;
  const pivots = detectPivots(candles, lookback, { atrSeries, atrMultiplier });
  const fineContext = { pivotsFine };
  const mainScan = scanCandidates(pivots, candles, fineContext);
  const positionalScan = scanPositionalCandidates(pivots, pivotsFine, candles);
  const survivors = rankSurvivors([...mainScan.survivors, ...positionalScan.survivors]);
  const eliminated = [...mainScan.eliminated, ...positionalScan.eliminated];
  for (const c of survivors) c.degree = cfg.degree;
  for (const c of eliminated) c.degree = cfg.degree;
  return {
    degree: cfg.degree,
    label: cfg.label,
    lookback,
    atrMultiplier,
    pivots,
    survivors,
    eliminated,
    primary: survivors[0] || null,
    alternates: survivors.slice(1, 4),
  };
}

/**
 * 统计某父候选跨度内、在更细一级枢轴序列中包含多少子枢轴（父子嵌套，书 3.2）。
 */
function countChildPivots(parent, finerPivots) {
  if (!parent || !Array.isArray(finerPivots)) return 0;
  const lo = Math.min(parent.startIndex, parent.endIndex);
  const hi = Math.max(parent.startIndex, parent.endIndex);
  return finerPivots.filter((p) => p.index >= lo && p.index <= hi).length;
}

/**
 * 自顶向下（从最粗级别到最细级别）梳理各级别主选，形成级别链（书 3.10）。
 * 某一级别无幸存主选时记录「该级别未通过／回退」，不强行下探（书 3.23 酌情忽略）。
 */
function buildDegreeChain(degrees) {
  const chain = [];
  for (let i = 0; i < degrees.length; i += 1) {
    const d = degrees[i];
    const finer = degrees[i + 1];
    const childPivotCount = d.primary && finer ? countChildPivots(d.primary, finer.pivots) : null;
    chain.push({
      degree: d.degree,
      label: d.label,
      pivotCount: d.pivots.length,
      primary: d.primary,
      childPivotCount,
      note: d.primary
        ? null
        : '该级别未找到通过全部规则的主选浪型（按书 3.23，以更粗级别的判断为准，可酌情忽略本级别不符）',
    });
  }
  return chain;
}

// ============================================================
// 7. 报告渲染（控制台 + Markdown）
// ============================================================

function candidateBasisNote(candidate) {
  const manual = candidate.evalResult.manual;
  const ratioRules = manual.rules.filter((r) => r.layer === 'ratio' && r.basis);
  if (ratioRules.length === 0) return null;
  return ratioRules.map((r) => `${r.id} → basis=${r.basis}`).join('; ');
}

function describeCandidate(candidate) {
  const dirLabel = candidate.direction === 'up' ? '上涨' : '下跌';
  const range = `[${formatToUtcOffset(new Date(candidate.startTime * 1000))} ~ ${formatToUtcOffset(new Date(candidate.endTime * 1000))}]`;
  return `${candidate.label} · ${dirLabel} ${range}`;
}

function degreeChainLine(entry) {
  if (!entry.primary) {
    return `  级别 ${entry.label}｜枢轴 ${entry.pivotCount} 个｜（无主选：${entry.note ? '按 3.23 以更粗级别为准' : 'n/a'}）`;
  }
  const p = entry.primary;
  const nest = Number.isFinite(entry.childPivotCount) ? `｜内含更细级别枢轴 ${entry.childPivotCount} 个` : '';
  return `  级别 ${entry.label}｜枢轴 ${entry.pivotCount} 个｜主选：${describeCandidate(p)}${nest}`;
}

function renderConsoleSummary(result) {
  const lines = [];
  lines.push('='.repeat(60));
  lines.push('波浪理论详解 · 验证手册分析（否定法 + 多级别）');
  lines.push('='.repeat(60));

  if (Array.isArray(result.degreeChain) && result.degreeChain.length > 0) {
    lines.push('\n【多级别概览（自顶向下：级别越小越粗）】');
    for (const entry of result.degreeChain) {
      lines.push(degreeChainLine(entry));
    }
    const coarse = result.degreeChain.find((e) => e.primary);
    if (coarse) {
      lines.push(`  ▶ 大级别（级别 ${coarse.degree}）主结构：${describeCandidate(coarse.primary)}`);
    }
  }

  if (!result.primary) {
    lines.push('\n（最细级别未找到通过全部规则闸门的候选浪型；见上方更粗级别结论）');
    return lines.join('\n');
  }

  const p = result.primary;
  lines.push('\n────────────────────────────────────────');
  lines.push('最细级别（级别 2）详情：');
  lines.push(`\n【主选浪型】${describeCandidate(p)}`);
  lines.push(`  通过全部 ${p.evalResult.manual.rules.length} 条规则（Rules）`);
  lines.push(`  命中指引（Guidelines）：${p.evalResult.hits.length}/${p.evalResult.manual.guidelines.length}`);
  for (const g of p.evalResult.hits) {
    lines.push(`    ✓ [${g.layer}] ${g.desc}`);
  }
  const basisNote = candidateBasisNote(p);
  if (basisNote) lines.push(`  比率判据基准：${basisNote}`);

  if (result.alternates.length > 0) {
    lines.push('\n【备选浪型（均通过规则闸门，按指引得分排序）】');
    result.alternates.forEach((alt, idx) => {
      lines.push(`  ${idx + 1}. ${describeCandidate(alt)} — 指引 ${alt.evalResult.hits.length}/${alt.evalResult.manual.guidelines.length}`);
    });
  }

  if (result.eliminatedNearLatest.length > 0) {
    lines.push('\n【最近区间被淘汰的假设（否定法）】');
    for (const e of result.eliminatedNearLatest) {
      const rule = e.evalResult.failedRule;
      lines.push(`  ✗ ${describeCandidate(e)}`);
      lines.push(`     淘汰原因：[${rule.layer}] ${rule.desc}${e.evalResult.detailText ? `（${e.evalResult.detailText}）` : ''}`);
    }
  }

  return lines.join('\n');
}

function renderToolsMd(candidate) {
  const lines = [];
  const tools = candidate && candidate.tools;
  if (!tools) return lines;

  if (tools.channel) {
    const ch = tools.channel;
    const typeLabel = ch.channelType === 'parallel' ? '平行通道' : ch.channelType === 'contracting' ? '收缩通道' : '扩散通道';
    lines.push(`- 艾略特通道：${typeLabel}（${ch.note}）`);
    if (tools.channelExit) {
      lines.push(`  - 完成提示：${tools.channelExit}`);
    }
    if (tools.channelNextPivot) {
      const np = tools.channelNextPivot;
      lines.push(`  - 下一拐点通道边界投影：${fmtNum(np.baseAt)} / ${fmtNum(np.railAt)}（辅助，非确定）`);
    }
  }

  if (tools.fibRetracement) {
    const fr = tools.fibRetracement;
    const levelStr = fr.levels.map((l) => `${(l.ratio * 100).toFixed(1)}%=${fmtNum(l.price)}`).join('，');
    lines.push(`- 斐波那契回撤（取点 ${fmtNum(fr.from.price)}→${fmtNum(fr.to.price)}）：${levelStr}`);
  }

  return lines;
}

function renderDegreeOverviewMd(result) {
  const lines = [];
  if (!Array.isArray(result.degreeChain) || result.degreeChain.length === 0) return lines;

  lines.push('## 多级别概览（自顶向下：级别越小越粗）');
  lines.push('');
  lines.push('> 单时间框内的「级别」用逐级放大的枢轴过滤近似（分形等价）。大级别把数十个小摆动坍缩为少数枢轴，');
  lines.push('> 从而让一段长跨度走势能够被 ABC/12345/WXY 手册整体识别——这正是解决「大跌含数十枢轴、无法套进单一窗口」的关键。');
  lines.push('');
  lines.push('| 级别 | 枢轴数 | 主选浪型 | 内含更细级别枢轴 |');
  lines.push('|---|---|---|---|');
  for (const entry of result.degreeChain) {
    const primaryStr = entry.primary ? describeCandidate(entry.primary) : '（无主选，按 3.23 以更粗级别为准）';
    const nest = Number.isFinite(entry.childPivotCount) ? `${entry.childPivotCount}` : '—';
    lines.push(`| ${entry.label} | ${entry.pivotCount} | ${primaryStr} | ${nest} |`);
  }
  lines.push('');

  // 逐级别主选的通道 + 斐波
  for (const entry of result.degreeChain) {
    if (!entry.primary) continue;
    lines.push(`### 级别 ${entry.label} 主选详情`);
    lines.push('');
    const p = entry.primary;
    lines.push(`**${describeCandidate(p)}**`);
    lines.push('');
    lines.push(`- 起点→终点：${fmtNum(p.points[0].price)} → ${fmtNum(p.points[p.points.length - 1].price)}`);
    lines.push(`- 价格/运行总量：${fmtNum(p.measures.price)} / ${fmtNum(p.measures.gross)}`);
    lines.push(`- 命中指引：${p.evalResult.hits.length}/${p.evalResult.manual.guidelines.length}`);
    for (const l of renderToolsMd(p)) lines.push(l);
    lines.push('');
  }

  if (Array.isArray(result.fibTime) && result.fibTime.length > 0) {
    const upcoming = result.fibTime.slice(-5);
    lines.push('### 斐波那契时间共振日（Guideline，仅辅助）');
    lines.push('');
    lines.push(`- 共检测到 ${result.fibTime.length} 个共振日（两个及以上枢轴的斐波序列日重合，书 3.22.4）。`);
    lines.push(`- 最近若干个共振日的 K 线序号：${upcoming.map((r) => `#${r.bar}(${r.sources.length}源)`).join('，')}`);
    lines.push('');
  }

  return lines;
}

function renderMarkdownReport(meta, result) {
  const lines = [];
  lines.push(`# 波浪理论详解 · 验证手册分析报告`);
  lines.push('');
  lines.push(`- 品种：${meta.product}`);
  lines.push(`- 周期：${meta.timeframe}`);
  lines.push(`- 时间范围（UTC+8）：${formatToUtcOffset(meta.startUtc)} ~ ${formatToUtcOffset(meta.endUtc)}`);
  if (Number.isFinite(meta.sampleCount)) {
    lines.push(`- 样本数量：${meta.sampleCount} 根K线`);
  }
  if (Number.isFinite(meta.rangeHigh) && Number.isFinite(meta.rangeLow)) {
    lines.push(`- 区间最高/最低：${fmtNum(meta.rangeHigh)} / ${fmtNum(meta.rangeLow)}`);
  }
  if (Number.isFinite(meta.latestClose) && Number.isFinite(meta.latestCloseTs)) {
    lines.push(`- 最新收盘：${fmtNum(meta.latestClose)}（${formatToUtcOffset(new Date(meta.latestCloseTs * 1000))} UTC+8）`);
  }
  lines.push(`- 生成时间：${formatToUtcOffset(meta.generatedAtUtc)}（UTC+8）`);
  lines.push(`- 数据来源：${meta.source}`);
  lines.push('');
  lines.push('> 评分方法：否定法（Negation Method）。规则（Rules）是硬性闸门，任一条不满足即淘汰候选；');
  lines.push('> 指引（Guidelines）只用于给幸存候选排名，不能抵消规则的失败。RSI 等书外技术指标不参与判定。');
  lines.push('');

  for (const l of renderDegreeOverviewMd(result)) lines.push(l);

  if (!result.primary) {
    lines.push('## 最细级别结论');
    lines.push('');
    lines.push('最细级别（级别 2）未找到通过全部规则闸门的候选浪型；请以上方更粗级别的结论为准（书 3.23）。');
    return lines.join('\n');
  }

  const p = result.primary;
  lines.push('## 最细级别（级别 2）主选浪型');
  lines.push('');
  lines.push(`**${describeCandidate(p)}**`);
  lines.push('');
  lines.push(`- 起点：${fmtNum(p.points[0].price)} @ ${formatToUtcOffset(new Date(p.startTime * 1000))}`);
  lines.push(`- 终点：${fmtNum(p.points[p.points.length - 1].price)} @ ${formatToUtcOffset(new Date(p.endTime * 1000))}`);
  lines.push(`- 价格（price）：${fmtNum(p.measures.price)}`);
  lines.push(`- 运行总量（gross）：${fmtNum(p.measures.gross)}`);
  lines.push(`- 价格运动百分比（movePct）：${p.measures.movePct !== null ? `${(p.measures.movePct * 100).toFixed(2)}%` : 'n/a'}`);
  lines.push('');
  lines.push('### 通过的规则（Rules）');
  lines.push('');
  for (const r of p.evalResult.manual.rules) {
    lines.push(`- ✓ \`${r.id}\` [${r.layer}] ${r.desc}`);
  }
  lines.push('');
  lines.push('### 命中的指引（Guidelines）');
  lines.push('');
  if (p.evalResult.hits.length === 0) {
    lines.push('（未命中任何指引，但规则全部通过，仍作为幸存候选）');
  } else {
    for (const g of p.evalResult.hits) {
      lines.push(`- ✓ \`${g.id}\` [${g.layer}] ${g.desc}`);
    }
  }
  const missedGuidelines = p.evalResult.manual.guidelines.filter((g) => !p.evalResult.hits.includes(g));
  if (missedGuidelines.length > 0) {
    lines.push('');
    lines.push('未命中的指引：');
    for (const g of missedGuidelines) {
      lines.push(`- ✗ \`${g.id}\` [${g.layer}] ${g.desc}`);
    }
  }

  const basisRules = p.evalResult.manual.rules.filter((r) => r.basis);
  if (basisRules.length > 0) {
    lines.push('');
    lines.push('### 比率判据基准（price / gross）');
    lines.push('');
    for (const r of basisRules) {
      lines.push(`- \`${r.id}\` 使用 **${r.basis}** 作为基准 — ${r.desc}`);
    }
  }

  if (result.alternates.length > 0) {
    lines.push('');
    lines.push('## 备选浪型（均通过规则闸门）');
    lines.push('');
    result.alternates.forEach((alt, idx) => {
      lines.push(`${idx + 1}. **${describeCandidate(alt)}** — 指引 ${alt.evalResult.hits.length}/${alt.evalResult.manual.guidelines.length}`);
    });
  }

  if (result.eliminatedNearLatest.length > 0) {
    lines.push('');
    lines.push('## 最近区间被淘汰的假设（否定法可解释性）');
    lines.push('');
    for (const e of result.eliminatedNearLatest) {
      const rule = e.evalResult.failedRule;
      lines.push(`- **${describeCandidate(e)}**`);
      lines.push(`  - 淘汰原因：\`${rule.id}\` [${rule.layer}] ${rule.desc}${e.evalResult.detailText ? `（${e.evalResult.detailText}）` : ''}`);
    }
  }

  return lines.join('\n');
}

// ============================================================
// 8. 主流程
// ============================================================

/**
 * 为一个候选附加 P3 的通道与斐波那契信息（就地写入 candidate.tools）。
 */
function attachTools(candidate, candles) {
  if (!candidate) return;
  const channel = buildChannel(candidate);
  candidate.tools = {
    channel,
    channelExit: channelExitHint(candidate, candles, channel),
    channelNextPivot: channelNextPivotProjection(candidate, channel),
    fibRetracement: fibRetracementForPattern(candidate),
  };
}

async function analyze(candlesWithIndex, lookback, options = {}) {
  const atrPeriod = options.atrPeriod ?? 14;
  const atrMultiplier = options.atrMultiplier ?? 1.5;

  const atrSeries = computeATR(candlesWithIndex, atrPeriod);
  const pivotsFine = detectPivots(candlesWithIndex, 1, {});

  // 逐级别扫描（自顶向下：级别 0 最粗 → 级别 2 最细）
  const degrees = DEGREE_CONFIGS.map((cfg) =>
    scanAtDegree(candlesWithIndex, cfg, lookback, atrMultiplier, atrSeries, pivotsFine));

  for (const d of degrees) {
    attachTools(d.primary, candlesWithIndex);
    for (const alt of d.alternates) attachTools(alt, candlesWithIndex);
  }

  const degreeChain = buildDegreeChain(degrees);
  const fibTime = fibTimeResonance(pivotsFine, candlesWithIndex.length);

  // 最细级别（级别 2）作为顶层向后兼容字段（沿用 P1/P2 的报告与 JSON 结构）
  const finest = degrees[degrees.length - 1];
  const pivots = finest.pivots;
  const survivors = finest.survivors;
  const eliminated = finest.eliminated;
  const primary = finest.primary;
  const alternates = finest.alternates.slice(0, 4);

  const latestIndex = pivots.length > 0 ? pivots[pivots.length - 1].index : -1;
  const secondLatestIndex = pivots.length > 1 ? pivots[pivots.length - 2].index : latestIndex;
  const eliminatedNearLatest = eliminated
    .filter((c) => c.endIndex >= secondLatestIndex)
    .sort((a, b) => b.endIndex - a.endIndex)
    .slice(0, 8);

  return {
    degrees,
    degreeChain,
    fibTime,
    pivots,
    pivotsFine,
    survivors,
    eliminated,
    primary,
    alternates,
    eliminatedNearLatest,
  };
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
  const startTag = toFileTimeTag(startDate, 8);
  const endTag = toFileTimeTag(endDate, 8);
  const baseName = `${safeProduct}_${args.tf}_${startTag}_${endTag}_manual`;
  const outName = args.out || `${baseName}.json`;
  const reportName = args.report || `${baseName}.md`;

  const base = await fetchCandles(args.product, tfConfig.fetchGranularity, startDate, endDate);
  const transformed = transformCandles(base, tfConfig);
  const startTs = Math.floor(startDate.getTime() / 1000);
  const endTs = Math.floor(endDate.getTime() / 1000);
  const candles = transformed.filter((c) => c.timestamp >= startTs && c.timestamp <= endTs);

  const minCandlesRequired = Math.max(10, Math.floor(args.lookback) * 4 + 2);
  if (candles.length < minCandlesRequired) {
    throw new Error(
      `Not enough candles after transform (${candles.length}). Need at least ${minCandlesRequired} bars.`,
    );
  }

  const result = await analyze(candles, Math.max(1, Math.floor(args.lookback)), {
    atrPeriod: Math.max(2, Math.floor(args.atrPeriod)),
    atrMultiplier: Number(args.atrMultiplier),
  });

  const stats = computeCandleStats(candles) || {};
  const meta = {
    product: args.product,
    timeframe: args.tf,
    startUtc: toIsoNoMs(startDate),
    endUtc: toIsoNoMs(endDate),
    generatedAtUtc: toIsoNoMs(new Date()),
    source: 'Coinbase Exchange candles API',
    ...stats,
  };

  const consoleSummary = renderConsoleSummary(result);
  console.log(consoleSummary);

  const reportContent = renderMarkdownReport(meta, result);

  const serializePrimary = (c) => (c
    ? {
      patternType: c.patternType,
      mode: c.mode,
      direction: c.direction,
      label: c.label,
      degree: c.degree,
      points: c.points,
      measures: c.measures,
      guidelineScore: c.evalResult.guidelineScore,
      guidelineTotal: c.evalResult.guidelineTotal,
      channelType: c.tools?.channel?.channelType || null,
      fibRetracement: c.tools?.fibRetracement
        ? { from: c.tools.fibRetracement.from.price, to: c.tools.fibRetracement.to.price, levels: c.tools.fibRetracement.levels }
        : null,
    }
    : null);

  const payload = {
    meta,
    pivotCount: result.pivots.length,
    survivorCount: result.survivors.length,
    eliminatedCount: result.eliminated.length,
    primary: serializePrimary(result.primary),
    degrees: result.degreeChain.map((entry) => ({
      degree: entry.degree,
      label: entry.label,
      pivotCount: entry.pivotCount,
      childPivotCount: entry.childPivotCount,
      primary: serializePrimary(entry.primary),
      note: entry.note,
    })),
    fibTimeResonanceCount: Array.isArray(result.fibTime) ? result.fibTime.length : 0,
  };

  const jsonPath = path.resolve(process.cwd(), outName);
  const reportPath = path.resolve(process.cwd(), reportName);

  await fs.writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await fs.writeFile(reportPath, `${reportContent}\n`, 'utf8');

  console.log(`\nSaved data JSON: ${jsonPath}`);
  console.log(`Saved analysis report: ${reportPath}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = {
  TIMEFRAMES,
  parseArgs,
  computeATR,
  detectPivots,
  fetchCandles,
  transformCandles,
  computeMeasures,
  rangeExtreme,
  computeCandleStats,
  makeJudge,
  evaluateManual,
  legShape,
  legIsZigzagShaped,
  classifyLegStyle,
  buildSegmentPivots,
  buildImpulseStrictManual,
  buildImpulseDiagonalManual,
  buildSingleZigzagManual,
  buildFlatManual,
  buildRegularFlatManual,
  buildExpandedFlatManual,
  buildRunningFlatManual,
  buildContractingTriangleManual,
  buildDoubleZigzagManual,
  buildTripleZigzagManual,
  buildDoubleSidewaysManual,
  buildTripleSidewaysManual,
  legHasValidImpulse,
  legHasOverlap,
  scanCandidates,
  scanPositionalCandidates,
  rankSurvivors,
  lineThrough,
  buildChannel,
  channelTypeFor,
  channelExitHint,
  isImpulseFailure,
  fibRetracementForPattern,
  fibExtensionPoints,
  fibTimeResonance,
  scanAtDegree,
  countChildPivots,
  buildDegreeChain,
  analyze,
  renderConsoleSummary,
  renderMarkdownReport,
};
