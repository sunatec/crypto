'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { fetchMarketData, fetchFuturesPremium, synthesizeWeekly, dropUnclosed } = require('../advisor/data');

const DAILY = require('./fixtures/btcusdt-1d-20261025.json');
const DAY = 86400;
const WEEK = 604800;
const WEEK_OFFSET = 345600; // 周一 00:00 UTC 对 604800 取余

// 假 transport：返回 [tsSec, low, high, open, close, volume]，按 [start,end) 过滤，不联网。
function makeTransport(rowsByGran) {
  const calls = [];
  const transport = async (product, gran, start, end) => {
    calls.push({ product, gran });
    const a = start.getTime() / 1000;
    const b = end.getTime() / 1000;
    return (rowsByGran[gran] || []).filter((r) => r[0] >= a && r[0] < b);
  };
  transport.calls = calls;
  return transport;
}

const toRow = (c) => [c.timestamp, c.low, c.high, c.open, c.close, c.volume];

function synthH4(fromTs, count) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const ts = fromTs + i * 14400;
    const close = 100000 + Math.sin(i / 7) * 3000;
    rows.push([ts, close - 200, close + 300, close - 50, close, 10]);
  }
  return rows;
}

test('周线合成：周起点均为周一 00:00 UTC，OHLC 取值正确', () => {
  const weekly = synthesizeWeekly(DAILY);
  assert.ok(weekly.length >= 50);
  for (const w of weekly) assert.equal(w.timestamp % WEEK, WEEK_OFFSET, `${w.timeUtc} 不是周一 00:00 UTC`);

  const mid = weekly[10];
  const days = DAILY.filter((d) => d.timestamp >= mid.timestamp && d.timestamp < mid.timestamp + WEEK);
  assert.equal(days.length, 7);
  assert.equal(mid.open, days[0].open);
  assert.equal(mid.close, days[6].close);
  assert.equal(mid.high, Math.max(...days.map((d) => d.high)));
  assert.equal(mid.low, Math.min(...days.map((d) => d.low)));
});

test('周线合成：丢弃未走完的当周', () => {
  const last = DAILY[DAILY.length - 1];
  const weekly = synthesizeWeekly(DAILY);
  const lastWeek = weekly[weekly.length - 1];
  assert.ok(lastWeek.timestamp + WEEK <= last.timestamp + DAY, '保留的最后一周必须已走完');
  // 把日线截到最后一个完整周的周三，则该周不应出现，最后一周回到上一周
  const cutIdx = DAILY.findIndex((d) => d.timestamp === lastWeek.timestamp) + 3;
  const w2 = synthesizeWeekly(DAILY.slice(0, cutIdx));
  assert.equal(w2[w2.length - 1].timestamp, weekly[weekly.length - 2].timestamp);
  assert.deepEqual(synthesizeWeekly([]), []);
});

test('dropUnclosed：收盘时刻晚于当前的 K 线被剔除', () => {
  const candles = [{ timestamp: 0 }, { timestamp: DAY }, { timestamp: 2 * DAY }];
  assert.equal(dropUnclosed(candles, DAY, new Date((2 * DAY) * 1000)).length, 2);
  assert.equal(dropUnclosed(candles, DAY, new Date((2 * DAY - 1) * 1000)).length, 1);
});

test('fetchMarketData：拉 1D 全量 + 4H 最近 400 根并剔除未收盘 K 线', async () => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'advise-data-'));
  try {
    const last = DAILY[DAILY.length - 1];
    const nowSec = last.timestamp + DAY + 5 * 3600; // 最后一根日线已收盘 5 小时
    const openDay = [last.timestamp + DAY, 1, 2, 1.5, 1.8, 1]; // 当日未收盘的日线
    const h4Start = Math.floor(nowSec / 14400) * 14400 - 410 * 14400;
    const transport = makeTransport({
      86400: [...DAILY.map(toRow), openDay],
      14400: synthH4(h4Start, 411),
    });
    const data = await fetchMarketData('BTCUSDT', { now: new Date(nowSec * 1000), transport, cacheDir, retryDelayMs: 0 });
    assert.equal(data.daily[data.daily.length - 1].timestamp, last.timestamp, '未收盘日线必须被剔除');
    assert.equal(data.daily.length, DAILY.length);
    const lastH4 = data.h4[data.h4.length - 1];
    assert.ok(lastH4.timestamp + 14400 <= nowSec, '未收盘 4H 必须被剔除');
    assert.ok(data.h4.length >= 395 && data.h4.length <= 401, `4H 根数 ${data.h4.length}`);
    assert.ok(data.weekly.length > 40);
    assert.ok(transport.calls.every((c) => c.product === 'BTCUSDT'));
  } finally {
    await fs.rm(cacheDir, { recursive: true, force: true });
  }
});

test('fetchMarketData：分页失败时抛错', async () => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'advise-data-'));
  try {
    const transport = async () => { throw new Error('boom'); };
    await assert.rejects(
      fetchMarketData('BTCUSDT', { now: new Date(1.8e12), transport, cacheDir, retryDelayMs: 0, attempts: 1 }),
      /Binance 1D K 线 .*分页请求失败/,
    );
  } finally {
    await fs.rm(cacheDir, { recursive: true, force: true });
  }
});

test('fetchFuturesPremium：成功解析标记价与资金费率', async () => {
  let url = '';
  const fakeFetch = async (u) => {
    url = u;
    return { ok: true, json: async () => ({ symbol: 'BTCUSDT', markPrice: '99123.45', indexPrice: '99100.00', lastFundingRate: '0.00010000', nextFundingTime: 1793000000000 }) };
  };
  const r = await fetchFuturesPremium('btcusdt', fakeFetch);
  assert.match(url, /fapi\.binance\.com\/fapi\/v1\/premiumIndex\?symbol=BTCUSDT/);
  assert.equal(r.markPrice, 99123.45);
  assert.equal(r.fundingRate, 0.0001);
  assert.match(r.nextFundingTime, /^\d{4}-\d{2}-\d{2}T/);
});

test('fetchFuturesPremium：HTTP 错误 / 网络异常 / 坏数据都返回 null 不抛错', async () => {
  assert.equal(await fetchFuturesPremium('BTCUSDT', async () => ({ ok: false, status: 451 })), null);
  assert.equal(await fetchFuturesPremium('BTCUSDT', async () => { throw new Error('net'); }), null);
  assert.equal(await fetchFuturesPremium('BTCUSDT', async () => ({ ok: true, json: async () => ({ markPrice: 'x' }) })), null);
  assert.equal(await fetchFuturesPremium('BTCUSDT', null), null);
});

test('fetchMarketData：OHLC 非有限数的坏行在缓存层就被拒绝并明确报错（不会渗进事实层）', async () => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'advise-data-'));
  try {
    const last = DAILY[DAILY.length - 1];
    const nowSec = last.timestamp + DAY + 5 * 3600;
    const bad = DAILY.map(toRow);
    bad[100] = [bad[100][0], NaN, NaN, NaN, NaN, 1];
    const transport = makeTransport({ 86400: bad, 14400: [] });
    await assert.rejects(
      fetchMarketData('BTCUSDT', { now: new Date(nowSec * 1000), transport, cacheDir, retryDelayMs: 0, attempts: 1 }),
      /Invalid .* candle row/,
    );
  } finally {
    await fs.rm(cacheDir, { recursive: true, force: true });
  }
});
