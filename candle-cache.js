'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fetchCoinbasePage } = require('./coinbase-candle-transport');

const CACHE_DIR = path.join(__dirname, '.cache');
const VERSION = 1;
const GRANULARITIES = [60, 300, 900, 3600, 21600, 86400];
// Coinbase publishes/finalizes a just-closed candle with some delay. Until this buffer has
// passed, a closed candle is used transiently but neither stored nor counted as covered —
// otherwise a not-yet-published bar would be recorded as a permanent exchange gap.
const SETTLE_SECONDS = 300;
const PAGE_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;

// Coverage uses inclusive, aligned candle starts, including genuine exchange gaps.
function mergeCovered(segments, granularity) {
  const merged = [];
  for (const [from, to] of segments.filter(([a, b]) => a <= b).sort((a, b) => a[0] - b[0])) {
    const previous = merged.at(-1);
    if (previous && from <= previous[1] + granularity) previous[1] = Math.max(previous[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

function uncovered(from, to, covered, granularity) {
  const gaps = [];
  let cursor = from;
  for (const [a, b] of mergeCovered(covered, granularity)) {
    if (b < cursor) continue;
    if (a > to) break;
    if (a > cursor) gaps.push([cursor, Math.min(to, a - granularity)]);
    cursor = Math.max(cursor, b + granularity);
  }
  if (cursor <= to) gaps.push([cursor, to]);
  return gaps;
}

function seconds(value) {
  return value instanceof Date ? value.getTime() / 1000 : typeof value === 'number' ? value : Date.parse(value) / 1000;
}

function toRow(candle) {
  const row = Array.isArray(candle) ? candle : [candle.timestamp, candle.low, candle.high, candle.open, candle.close, candle.volume];
  if (row.length !== 6 || row.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error('Invalid Coinbase candle row');
  }
  return row;
}

function toCandle([timestamp, low, high, open, close, volume]) {
  return { timestamp, timeUtc: new Date(timestamp * 1000).toISOString(), open, high, low, close, volume };
}

async function readCache(filename, product, granularity, warn) {
  const empty = { version: VERSION, product, granularity, bars: [], covered: [], listingTs: null };
  try {
    const cache = JSON.parse(await fs.readFile(filename, 'utf8'));
    if (cache.version !== VERSION || cache.product !== product || cache.granularity !== granularity
      || !Array.isArray(cache.bars) || !Array.isArray(cache.covered)
      || !(cache.listingTs === null || Number.isFinite(cache.listingTs))) throw new Error('Invalid cache format/version');
    cache.bars.forEach(row => {
      toRow(row);
      if (row[0] % granularity !== 0) throw new Error('Unaligned cached candle');
    });
    if (cache.covered.some(segment => !Array.isArray(segment) || segment.length !== 2
      || segment.some(ts => !Number.isFinite(ts) || ts % granularity !== 0) || segment[0] > segment[1])) {
      throw new Error('Invalid cache coverage');
    }
    return cache;
  } catch (error) {
    if (error.code !== 'ENOENT') warn(`Candle cache unreadable (${filename}): ${error.message}; fetching again`);
    return empty;
  }
}

async function writeCache(filename, cache) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(cache), 'utf8');
    await fs.rename(temporary, filename);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/**
 * start/end/now are Dates, ISO strings, or Unix seconds. Returns engine candles
 * with fetchErrors. Use start=null (or 'all') to discover all daily history;
 * discoverListing=true also discovers the boundary for a bounded daily request.
 * cacheDir/transport/now are injectable for isolated tests.
 */
async function getCandles(product, granularity, start, end, options = {}) {
  if (!/^[A-Za-z0-9_-]+$/.test(product)) throw new Error('Invalid Coinbase product');
  if (!GRANULARITIES.includes(granularity)) throw new Error('Unsupported Coinbase granularity');
  const allHistory = start == null || start === 'all';
  const discover = allHistory || options.discoverListing;
  if (discover && granularity !== 86400) throw new Error('Listing discovery requires daily candles');
  const now = seconds(options.now === undefined ? new Date() : options.now);
  const endTs = seconds(end);
  const startTs = allHistory ? 0 : seconds(start);
  if (![now, startTs, endTs].every(Number.isFinite) || startTs > endTs) throw new Error('Invalid candle time range');
  const filename = path.join(options.cacheDir || CACHE_DIR, 'candles', 'coinbase', product, `${granularity}.json`);
  const cache = await readCache(filename, product, granularity, options.warn || console.warn);
  // A previously open (or not yet settled) candle must never survive on disk or count as coverage.
  const settle = options.settleSeconds ?? SETTLE_SECONDS;
  if (!Number.isFinite(settle) || settle < 0) throw new Error('Invalid settle seconds');
  const settled = ts => ts + granularity + settle <= now;
  const lastClosed = (Math.floor((now - settle) / granularity) - 1) * granularity;
  const bars = new Map(cache.bars.filter(row => row[0] <= lastClosed).map(row => [row[0], row]));
  cache.covered = mergeCovered(cache.covered.map(([a, b]) => [a, Math.min(b, lastClosed)]), granularity);
  const transport = options.transport || fetchCoinbasePage;
  const fetchErrors = [];
  const transient = new Map();
  const pageBars = options.pageBars || 299; // inclusive-end APIs can return one extra row (max 300).
  if (!Number.isInteger(pageBars) || pageBars < 1 || pageBars > 299) throw new Error('Invalid candle page size');

  async function persist() {
    cache.bars = [...bars.values()].sort((a, b) => a[0] - b[0]);
    await writeCache(filename, cache);
  }

  const attempts = options.attempts ?? PAGE_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error('Invalid page attempts');

  async function requestOnce(from, stop) {
    const result = await transport(product, granularity, new Date(from * 1000), new Date(stop * 1000));
    if (!Array.isArray(result)) throw new Error('Invalid Coinbase candle response');
    if (result.fetchErrors && result.fetchErrors.length) throw new Error('Incomplete candle page');
    const rows = result.map(toRow).filter(row => row[0] >= from && row[0] < stop);
    if (rows.some(row => row[0] % granularity !== 0)) throw new Error('Unaligned Coinbase candle');
    return { rows };
  }

  // Transient network errors are retried with a growing delay before the page counts as failed.
  async function requestPage(from, stop) {
    let error;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await requestOnce(from, stop);
      } catch (e) {
        error = e;
        if (attempt < attempts && retryDelayMs > 0) await new Promise(resolve => setTimeout(resolve, retryDelayMs * attempt));
      }
    }
    return { error };
  }

  async function acceptPage(from, stop, result) {
    if (result.error) {
      fetchErrors.push({ fromTimestamp: from, toTimestamp: stop, reason: result.error.message });
      return false;
    }
    if (options.refresh) {
      // Replace only successful pages, keeping failed-page data available for retry.
      for (const ts of bars.keys()) if (ts >= from && ts < stop) bars.delete(ts);
    }
    for (const row of result.rows) {
      if (settled(row[0])) bars.set(row[0], row);
      else transient.set(row[0], row);
    }
    const last = Math.min(Math.floor(stop / granularity) * granularity - granularity, lastClosed);
    cache.covered = mergeCovered([...cache.covered, [from, last]], granularity);
    await persist();
    return true;
  }

  const from = Math.max(Math.ceil(startTs / granularity) * granularity, cache.listingTs ?? -Infinity);
  const to = Math.floor(Math.min(endTs, now) / granularity) * granularity;
  // All-history discovery starts at the latest requested bucket instead of the epoch.
  const earliestCached = bars.size ? Math.min(...bars.keys()) : to;
  const forwardFrom = allHistory ? Math.max(cache.listingTs ?? earliestCached, from) : from;
  const gaps = options.refresh ? (forwardFrom <= to ? [[forwardFrom, to]] : [])
    : uncovered(forwardFrom, to, cache.covered, granularity);
  const pages = [];
  for (const [a, b] of gaps) {
    for (let cursor = a; cursor <= b;) {
      const stop = Math.min(cursor + pageBars * granularity, b + granularity, now);
      if (stop <= cursor) break;
      pages.push([cursor, stop]);
      cursor = stop;
    }
  }
  // Independent pages can use three connections; commit in order for stable merges.
  for (let i = 0; i < pages.length; i += 3) {
    const batch = pages.slice(i, i + 3);
    const results = await Promise.all(batch.map(([a, b]) => requestPage(a, b)));
    for (let j = 0; j < batch.length; j += 1) await acceptPage(...batch[j], results[j]);
  }

  if (discover && cache.listingTs === null && fetchErrors.length === 0) {
    let earliest = bars.size ? Math.min(...bars.keys()) : Math.floor(Math.min(startTs || endTs, endTs) / granularity) * granularity;
    while (earliest > 0) {
      const previous = Math.max(0, earliest - 300 * granularity);
      // A discovery window is 300 days, split to stay below inclusive API limits.
      let empty = true, failed = false;
      for (let cursor = previous; cursor < earliest;) {
        const stop = Math.min(cursor + pageBars * granularity, earliest);
        const result = await requestPage(cursor, stop);
        if (!await acceptPage(cursor, stop, result)) { failed = true; break; }
        empty = empty && result.rows.length === 0;
        cursor = stop;
      }
      if (failed) break;
      if (empty) {
        if (bars.size) { cache.listingTs = Math.min(...bars.keys()); await persist(); }
        break;
      }
      earliest = previous;
    }
  }
  const merged = new Map([...bars, ...transient]);
  const result = [...merged.values()].filter(row => row[0] >= startTs && row[0] <= endTs)
    .sort((a, b) => a[0] - b[0]).map(toCandle);
  result.fetchErrors = fetchErrors;
  result.listingTs = cache.listingTs;
  return result;
}

module.exports = { getCandles, mergeCovered, uncovered, CACHE_DIR };
