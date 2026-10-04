'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { getCandles, mergeCovered, uncovered } = require('../candle-cache');
const { fetchSharedHourly } = require('../wave-subwave-verification');

const hour = 3600, day = 86400, base = Date.parse('2020-01-01T00:00:00Z') / 1000;
const date = ts => new Date(ts * 1000);
const row = (ts, price = 100) => [ts, price - 1, price + 1, price, price, 2];

async function fixture(t, granularity = hour) {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'candle-cache-test-'));
  t.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
  const calls = [];
  const options = {
    cacheDir, now: base + 2000 * day, settleSeconds: 0, retryDelayMs: 0,
    transport: async (_, g, a, b) => {
      calls.push([a.getTime() / 1000, b.getTime() / 1000]);
      const rows = [];
      for (let ts = a.getTime() / 1000; ts < b.getTime() / 1000; ts += g) rows.push(row(ts));
      return rows.reverse();
    },
  };
  const filename = path.join(cacheDir, 'candles', 'coinbase', 'TEST', `${granularity}.json`);
  const read = async () => JSON.parse(await fs.readFile(filename, 'utf8'));
  const get = (a, b, extra = {}) => getCandles('TEST', granularity, date(a), date(b), { ...options, ...extra });
  return { cacheDir, calls, options, filename, read, get };
}

test('coverage subtraction merges adjacent/overlapping inclusive starts', () => {
  assert.deepEqual(mergeCovered([[8, 10], [2, 4], [4, 6], [0, 0], [12, 12]], 2), [[0, 12]]);
  assert.deepEqual(uncovered(0, 14, [[2, 4], [10, 12]], 2), [[0, 0], [6, 8], [14, 14]]);
});

test('second request uses disk only, inclusive historical endpoint persists, extension fetches only tail', async t => {
  const f = await fixture(t);
  const first = await f.get(base, base + 5 * hour);
  assert.equal(first.length, 6);
  assert.deepEqual((await f.read()).covered, [[base, base + 5 * hour]]);
  const second = await f.get(base, base + 5 * hour);
  assert.deepEqual(first, second);
  assert.equal(f.calls.length, 1);
  const extended = await f.get(base, base + 8 * hour);
  assert.deepEqual(f.calls[1], [base + 6 * hour, base + 9 * hour]);
  assert.equal(extended.length, 9);
  assert.deepEqual((await f.read()).covered, [[base, base + 8 * hour]]);
});

test('sparse windows request just the middle, genuine missing bars stay covered', async t => {
  const f = await fixture(t);
  const real = f.options.transport;
  f.options.transport = async (...args) => (await real(...args)).filter(r => r[0] !== base + hour);
  await f.get(base, base + 2 * hour);
  await f.get(base + 6 * hour, base + 8 * hour);
  assert.equal((await f.read()).covered.length, 2);
  const got = await f.get(base, base + 8 * hour);
  assert.deepEqual(f.calls[2], [base + 3 * hour, base + 6 * hour]);
  assert.equal(got.length, 8);
  await f.get(base, base + 8 * hour);
  assert.equal(f.calls.length, 3);
});

test('one failed page persists other pages and only the failed page retries', async t => {
  const f = await fixture(t);
  const real = f.options.transport;
  let fail = true;
  f.options.pageBars = 3;
  f.options.transport = async (...args) => {
    if (fail && args[2].getTime() / 1000 === base + 3 * hour) throw Error('offline');
    return real(...args);
  };
  const partial = await f.get(base, base + 8 * hour);
  assert.equal(partial.length, 6);
  assert.equal(partial.fetchErrors.length, 1);
  assert.deepEqual((await f.read()).covered, [[base, base + 2 * hour], [base + 6 * hour, base + 8 * hour]]);
  fail = false;
  const full = await f.get(base, base + 8 * hour);
  assert.equal(full.length, 9);
  assert.deepEqual(full.fetchErrors, []);
  assert.deepEqual(f.calls.at(-1), [base + 3 * hour, base + 6 * hour]);
});

test('open candle returns transiently, re-fetches, and persists only after closing', async t => {
  const f = await fixture(t);
  f.options.now = base + 2.5 * hour;
  const first = await f.get(base, base + 2.5 * hour);
  assert.equal(first.length, 3);
  const cache = await f.read();
  assert.equal(cache.bars.length, 2);
  assert.deepEqual(cache.covered, [[base, base + hour]]);
  await f.get(base, base + 2.5 * hour);
  assert.deepEqual(f.calls.at(-1), [base + 2 * hour, base + 2.5 * hour]);
  f.options.now = base + 3 * hour;
  await f.get(base, base + 2.5 * hour);
  assert.equal((await f.read()).bars.length, 3);
});

test('discovery records daily listing boundary, clips older requests, and reuses all history', async t => {
  const f = await fixture(t, day);
  const real = f.options.transport;
  f.options.transport = async (...args) => (await real(...args)).filter(r => r[0] >= base);
  const got = await getCandles('TEST', day, null, date(base + 5 * day), f.options);
  assert.equal(got.length, 6);
  assert.equal((await f.read()).listingTs, base);
  const count = f.calls.length;
  assert.deepEqual(await getCandles('TEST', day, 'all', date(base + 5 * day), f.options), got);
  await f.get(base - 1000 * day, base + 5 * day);
  assert.equal(f.calls.length, count);
  assert.equal((await f.get(base - 1000 * day, base - day)).length, 0);
  assert.equal(f.calls.length, count);
});

test('all-history fills gaps between cached oldest data and requested latest data', async t => {
  const f = await fixture(t, day);
  const real = f.options.transport;
  f.options.transport = async (...args) => (await real(...args)).filter(r => r[0] >= base);
  await f.get(base, base + day);
  const got = await getCandles('TEST', day, null, date(base + 10 * day), f.options);
  assert.equal(got.length, 11);
  assert.equal((await f.read()).listingTs, base);
});

test('failed discovery does not assert a listing boundary', async t => {
  const f = await fixture(t, day);
  await f.get(base, base + day);
  const got = await f.get(base, base + day, { discoverListing: true, transport: async () => { throw Error('offline'); } });
  assert.equal(got.fetchErrors.length, 1);
  assert.equal((await f.read()).listingTs, null);
});

test('refresh replaces successes including deleted bars and preserves other ranges/listing', async t => {
  const f = await fixture(t, day);
  await f.get(base, base + 8 * day);
  const cache = await f.read(); cache.listingTs = base;
  await fs.writeFile(f.filename, JSON.stringify(cache));
  const got = await f.get(base + 2 * day, base + 4 * day, {
    refresh: true, transport: async () => [row(base + 2 * day, 200), row(base + 4 * day, 300)],
  });
  assert.deepEqual(got.map(c => c.close), [200, 300]);
  const stored = await f.read();
  assert.equal(stored.listingTs, base);
  assert.equal(stored.bars.length, 8);
  assert.deepEqual(stored.covered, [[base, base + 8 * day]]);
  assert.equal(stored.bars[0][4], 100);
});

test('corrupt, mismatched versions, and malformed coverage are warned and replaced atomically', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.dirname(f.filename), { recursive: true });
  for (const contents of ['{', JSON.stringify({ version: 999 }), JSON.stringify({ version: 1, product: 'TEST', granularity: hour, bars: [], covered: [[base + 1, base + hour]], listingTs: null })]) {
    await fs.writeFile(f.filename, contents);
    const warnings = [];
    await f.get(base, base + hour, { warn: text => warnings.push(text) });
    assert.equal(warnings.length, 1);
    assert.equal((await f.read()).version, 1);
    assert.deepEqual(await fs.readdir(path.dirname(f.filename)), [`${hour}.json`]);
  }
});

test('default shared hourly cache serves main-hourly data and forwards refresh', async t => {
  const f = await fixture(t);
  await f.get(base, base + 8 * hour);
  const got = await fetchSharedHourly(null, 'TEST', date(base), date(base + 8 * hour), 298, f.options);
  assert.equal(got.length, 9);
  assert.deepEqual(got.fetchErrors, []);
  assert.equal(f.calls.length, 1);
  await fetchSharedHourly(null, 'TEST', date(base), date(base + 8 * hour), 298, { ...f.options, refresh: true });
  assert.equal(f.calls.length, 2);
});

test('injected shared hourly fetcher never uses persistent transport/directory', async t => {
  const f = await fixture(t);
  const got = await fetchSharedHourly(async () => [{ timestamp: base }], 'TEST', date(base), date(base + hour), 298, {
    ...f.options, transport: async () => { throw Error('cache path must not run'); },
  });
  assert.equal(got.length, 1);
  assert.deepEqual(await fs.readdir(f.cacheDir), []);
});

test('default pullback drill caches its windows and injected fetchers bypass persistence', async t => {
  const f = await fixture(t);
  const { drillPullback } = require('../analyze-wave-tree');
  const window = { fromTs: base, toTs: base + 12 * hour };
  const real = f.options.transport;
  f.options.transport = async (...args) => (await real(...args)).map(r => row(r[0], Math.floor(r[0] / args[1]) % 2 ? 110 : 90));
  const first = await drillPullback('TEST', '4h', window, undefined, f.options);
  assert.ok(first && first.fine.length >= 4);
  const count = f.calls.length;
  assert.deepEqual(await drillPullback('TEST', '4h', window, undefined, f.options), first);
  assert.equal(f.calls.length, count);
  const isolated = await fixture(t);
  const candles = first.candles.map(c => ({ ...c, high: c.high + 1 }));
  const injected = await drillPullback('TEST', '4h', window, async () => candles, isolated.options);
  assert.equal(injected.candles[0].high, candles[0].high);
  assert.deepEqual(await fs.readdir(isolated.cacheDir), []);
});

test('unaligned ranges filter leaked endpoints and duplicate rows, page spans respect limit', async t => {
  const f = await fixture(t);
  const real = f.options.transport;
  f.options.transport = async (...args) => {
    const rows = await real(...args);
    return [...rows, ...rows, row(base - hour), row(base + 700 * hour)];
  };
  const got = await f.get(base + 1, base + 601.5 * hour);
  assert.equal(got.length, 601);
  assert.equal(got[0].timestamp, base + hour);
  assert.equal(got.at(-1).timestamp, base + 601 * hour);
  assert.ok(f.calls.every(([a, b]) => (b - a) / hour <= 299));
  const count = f.calls.length;
  assert.deepEqual(await f.get(base + 1, base + 601.5 * hour), got);
  assert.equal(f.calls.length, count);
});

test('just-closed candle is used but not cached until the settle buffer passes', async t => {
  const f = await fixture(t);
  const real = f.options.transport;
  // 10:00:05: the 09:00 candle has closed but Coinbase has not published it yet.
  f.options.now = base + 10 * hour + 5;
  f.options.settleSeconds = 300;
  f.options.transport = async (product, g, a, b) => (await real(product, g, a, b)).filter(r => r[0] < base + 9 * hour);
  const early = await f.get(base, base + 10 * hour);
  assert.equal(early.at(-1).timestamp, base + 8 * hour);
  assert.deepEqual((await f.read()).covered, [[base, base + 8 * hour]], '09:00 is not yet covered');
  // An hour later the bar is published and must be fetched rather than treated as an exchange gap.
  f.options.now = base + 11 * hour;
  f.options.transport = real;
  const later = await f.get(base, base + 9 * hour);
  assert.equal(later.at(-1).timestamp, base + 9 * hour);
  assert.ok((await f.read()).bars.some(r => r[0] === base + 9 * hour));
});

test('a closed candle inside the settle buffer is returned but kept off disk', async t => {
  const f = await fixture(t);
  f.options.now = base + 3 * hour + 60;
  f.options.settleSeconds = 300;
  const got = await f.get(base, base + 3 * hour);
  assert.equal(got.length, 4, '02:00 (settling) and 03:00 (open) are still returned');
  assert.deepEqual((await f.read()).bars.map(r => r[0]), [base, base + hour]);
});

test('transient page errors are retried before counting as failed', async t => {
  const f = await fixture(t);
  const real = f.options.transport;
  let failures = 2, attempts = 0;
  f.options.transport = async (...args) => {
    attempts += 1;
    if (failures-- > 0) throw Error('ECONNRESET');
    return real(...args);
  };
  const got = await f.get(base, base + 4 * hour);
  assert.equal(attempts, 3);
  assert.deepEqual(got.fetchErrors, []);
  assert.equal(got.length, 5);
});

test('a page failing every attempt is reported once with the last error', async t => {
  const f = await fixture(t);
  let attempts = 0;
  const got = await f.get(base, base + 4 * hour, { attempts: 3, transport: async () => { attempts += 1; throw Error('offline'); } });
  assert.equal(attempts, 3);
  assert.equal(got.fetchErrors.length, 1);
  assert.equal(got.fetchErrors[0].reason, 'offline');
});
