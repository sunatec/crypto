'use strict';

// 离线单测（add-binance-source）：符号映射 / kline 解析重排 / 粒度→interval / 缓存按源分目录。
// 不联网——transport 注入假 JSON 取数，缓存注入假 transport。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  fetchBinancePage, binanceSymbol, BINANCE_GRANULARITIES, INTERVAL_BY_GRANULARITY,
} = require('../binance-candle-transport');
const { getCandles } = require('../candle-cache');

test('binanceSymbol：-USD→USDT，已是稳定计价/带后缀则原样', () => {
  assert.equal(binanceSymbol('BTC-USD'), 'BTCUSDT');
  assert.equal(binanceSymbol('ETH-USD'), 'ETHUSDT');
  assert.equal(binanceSymbol('btc-usd'), 'BTCUSDT');
  assert.equal(binanceSymbol('BTC-USDC'), 'BTCUSDC');
  assert.equal(binanceSymbol('BTCUSDT'), 'BTCUSDT');
  assert.equal(binanceSymbol('SOL-USDT'), 'SOLUSDT');
});

test('粒度→interval 映射含 4h/1d，且为原生（无合成）', () => {
  assert.equal(INTERVAL_BY_GRANULARITY[14400], '4h');
  assert.equal(INTERVAL_BY_GRANULARITY[3600], '1h');
  assert.equal(INTERVAL_BY_GRANULARITY[86400], '1d');
  assert.ok(BINANCE_GRANULARITIES.includes(14400), '4h 粒度应在支持集内（主周期原生取）');
});

test('fetchBinancePage：kline 重排为 [秒, 低, 高, 开, 收, 量]，时间转秒，endTime 为 stop-1ms', async () => {
  let seenUrl = null;
  const fakeJson = async (url) => {
    seenUrl = url;
    // [openTimeMs, open, high, low, close, volume, closeTimeMs, ...]
    return [[1_600_000_000_000, '100', '110', '90', '105', '12.5', 1_600_003_599_999, '0', 0]];
  };
  const start = new Date(1_600_000_000_000);
  const end = new Date(1_600_000_000_000 + 3600 * 1000);
  const rows = await fetchBinancePage('BTCUSDT', 3600, start, end, fakeJson);
  assert.deepEqual(rows, [[1_600_000_000, 90, 110, 100, 105, 12.5]]);
  const u = new URL(seenUrl);
  assert.equal(u.searchParams.get('symbol'), 'BTCUSDT');
  assert.equal(u.searchParams.get('interval'), '1h');
  assert.equal(u.searchParams.get('startTime'), String(start.getTime()));
  assert.equal(u.searchParams.get('endTime'), String(end.getTime() - 1));
});

test('fetchBinancePage：未知粒度抛错（不静默合成）', async () => {
  await assert.rejects(() => fetchBinancePage('BTCUSDT', 777, new Date(0), new Date(1000), async () => []),
    /Unsupported Binance granularity/);
});

test('getCandles source=binance：缓存写入 candles/binance/<symbol>/<gran>.json，不碰 coinbase 目录', async (t) => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'binance-cache-'));
  t.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
  const day = 86400, base = Date.parse('2020-01-01T00:00:00Z') / 1000;
  const transport = async (_product, g, a, b) => {
    const rows = [];
    for (let ts = a.getTime() / 1000; ts < b.getTime() / 1000; ts += g) rows.push([ts, 99, 101, 100, 100, 5]);
    return rows.reverse();
  };
  const got = await getCandles('BTCUSDT', day, new Date(base * 1000), new Date((base + 4 * day) * 1000), {
    cacheDir, source: 'binance', granularities: BINANCE_GRANULARITIES, transport, settleSeconds: 0, retryDelayMs: 0, now: base + 100 * day,
  });
  assert.equal(got.length, 5);
  const binFile = path.join(cacheDir, 'candles', 'binance', 'BTCUSDT', `${day}.json`);
  const cache = JSON.parse(await fs.readFile(binFile, 'utf8'));
  assert.equal(cache.bars.length, 5);
  await assert.rejects(() => fs.access(path.join(cacheDir, 'candles', 'coinbase')), 'coinbase 目录不应被创建');
});

test('getCandles 默认源仍是 coinbase（路径与行为不受 binance 改动影响）', async (t) => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'coinbase-default-'));
  t.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
  const hour = 3600, base = Date.parse('2020-01-01T00:00:00Z') / 1000;
  const transport = async (_p, g, a, b) => {
    const rows = [];
    for (let ts = a.getTime() / 1000; ts < b.getTime() / 1000; ts += g) rows.push([ts, 99, 101, 100, 100, 5]);
    return rows.reverse();
  };
  await getCandles('TEST', hour, new Date(base * 1000), new Date((base + 3 * hour) * 1000), {
    cacheDir, transport, settleSeconds: 0, retryDelayMs: 0, now: base + 100 * hour,
  });
  await fs.access(path.join(cacheDir, 'candles', 'coinbase', 'TEST', `${hour}.json`));
});
