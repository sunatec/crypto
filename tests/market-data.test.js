'use strict';

// add-stock-data-sources：多市场数据源离线测试（注入假 fetch，不发真实请求）

const test = require('node:test');
const assert = require('node:assert/strict');

const md = require('../market-data.js');
const t = require('../analyze-wave-tree.js');

const okJson = (body) => ({ ok: true, status: 200, json: async () => body });

test('市场识别：按代码格式分派，--source 可覆盖', () => {
  assert.deepEqual(md.detectMarket('BTC-USD'), { market: 'crypto', source: 'coinbase' });
  assert.deepEqual(md.detectMarket('600519'), { market: 'cn', source: 'eastmoney' });
  assert.deepEqual(md.detectMarket('AAPL'), { market: 'us', source: 'twelvedata' });
  assert.deepEqual(md.detectMarket('AAPL', 'eastmoney'), { market: 'us', source: 'eastmoney' });
  assert.throws(() => md.detectMarket('00700.HK1'), /无法识别/);
  assert.throws(() => md.detectMarket('AAPL', 'yahoo'), /不支持的数据源/);
});

test('东方财富 secid 与价格小数位', () => {
  assert.equal(md.eastmoneySecId('600519'), '1.600519');
  assert.equal(md.eastmoneySecId('510300'), '1.510300');
  assert.equal(md.eastmoneySecId('000001'), '0.000001');
  assert.equal(md.eastmoneySecId('159915'), '0.159915');
  assert.equal(md.priceDecimals('us', 'AAPL'), 2);
  assert.equal(md.priceDecimals('cn', '600519'), 2);
  assert.equal(md.priceDecimals('cn', '510300'), 3);
  assert.equal(md.priceDecimals('cn', '159915'), 3);
  assert.equal(md.priceDecimals('crypto', 'BTC-USD'), null);
});

test('剔除未收盘 K 线：美股按美东 16:00、A 股按北京时间 15:00', () => {
  const bars = ['2026-09-21', '2026-09-22'].map((d) => ({ timestamp: Date.parse(`${d}T00:00:00Z`) / 1000, timeUtc: `${d}T00:00:00.000Z` }));
  // 2026-09-22 14:00Z = 美东 10:00（盘中）→ 剔除当天
  assert.equal(md.dropUnclosedBar(bars, 'us', new Date('2026-09-22T14:00:00Z')).length, 1);
  // 2026-09-22 21:00Z = 美东 17:00（已收盘）→ 保留
  assert.equal(md.dropUnclosedBar(bars, 'us', new Date('2026-09-22T21:00:00Z')).length, 2);
  // 2026-09-22 05:00Z = 北京 13:00（盘中）→ 剔除；08:00Z = 北京 16:00 → 保留
  assert.equal(md.dropUnclosedBar(bars, 'cn', new Date('2026-09-22T05:00:00Z')).length, 1);
  assert.equal(md.dropUnclosedBar(bars, 'cn', new Date('2026-09-22T08:00:00Z')).length, 2);
  // 加密货币不剔除
  assert.equal(md.dropUnclosedBar(bars, 'crypto', new Date('2026-09-22T05:00:00Z')).length, 2);
});

test('Twelve Data：参数含 adjust=splits，解析为交易日 UTC 零点，错误透传', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return okJson({
      meta: { symbol: 'AAPL' },
      values: [
        { datetime: '2026-09-21', open: '10', high: '12', low: '9', close: '11', volume: '100' },
        { datetime: '2026-09-22', open: '11', high: '13', low: '10', close: '12.5', volume: '200' },
      ],
      status: 'ok',
    });
  };
  const res = await md.fetchTwelveData('aapl', new Date('2026-09-01T00:00:00Z'), new Date('2026-09-23T00:00:00Z'), 'KEY', fetchImpl);
  const u = new URL(urls[0]);
  assert.equal(u.searchParams.get('symbol'), 'AAPL');
  assert.equal(u.searchParams.get('adjust'), 'splits');
  assert.equal(u.searchParams.get('interval'), '1day');
  assert.equal(res.candles.length, 2);
  assert.equal(res.candles[1].timeUtc, '2026-09-22T00:00:00.000Z');
  assert.deepEqual([res.candles[1].open, res.candles[1].high, res.candles[1].low, res.candles[1].close], [11, 13, 10, 12.5]);

  const errFetch = async () => okJson({ status: 'error', code: 404, message: 'symbol not found' });
  await assert.rejects(md.fetchTwelveData('ZZZZ', new Date('2026-09-01'), new Date('2026-09-23'), 'KEY', errFetch), /symbol not found/);
});

test('Twelve Data：满 5000 根时向前翻页', async () => {
  let calls = 0;
  const mk = (startDay, n) => Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(2000, 0, 1) + (startDay + i) * 86400000).toISOString().slice(0, 10);
    return { datetime: d, open: '1', high: '1', low: '1', close: '1', volume: '0' };
  });
  const fetchImpl = async () => {
    calls += 1;
    return okJson({ status: 'ok', values: calls === 1 ? mk(100, 5000) : mk(0, 100) });
  };
  const res = await md.fetchTwelveData('SPY', new Date('2000-01-01'), new Date('2030-01-01'), 'KEY', fetchImpl);
  assert.equal(calls, 2);
  assert.equal(res.candles.length, 5100);
});

test('美股缺 key：报错并提示设置方式，不发请求', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return okJson({}); };
  await assert.rejects(
    md.fetchStockDaily({ product: 'AAPL', market: 'us', source: 'twelvedata', start: new Date('2026-01-01'), end: new Date('2026-09-01'), apiKey: null, fetchImpl }),
    /TWELVE_DATA_API_KEY/,
  );
  assert.equal(called, false);
});

test('东方财富：fqt=1 前复权、字段顺序 date,open,close,high,low、带名称', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return okJson({ data: { name: '贵州茅台', klines: ['2026-09-21,1500.00,1510.00,1520.00,1490.00,1000', '2026-09-22,1510.00,1530.00,1540.00,1505.00,2000'] } });
  };
  const res = await md.fetchEastmoney('600519', 'cn', new Date('2026-09-01'), new Date('2026-09-23'), fetchImpl);
  assert.ok(urls[0].includes('secid=1.600519'));
  assert.ok(urls[0].includes('fqt=1'));
  assert.equal(res.name, '贵州茅台');
  const c = res.candles[1];
  assert.deepEqual([c.open, c.high, c.low, c.close], [1510, 1540, 1505, 1530]);
});

test('东方财富美股：按 105/106/107 依次尝试', async () => {
  const tried = [];
  const fetchImpl = async (url) => {
    const secid = /secid=([^&]+)/.exec(url)[1];
    tried.push(secid);
    return okJson(secid === '106.KO' ? { data: { name: '可口可乐', klines: ['2026-09-22,60,61,62,59,1'] } } : { data: null });
  };
  const res = await md.fetchEastmoney('KO', 'us', new Date('2026-09-01'), new Date('2026-09-23'), fetchImpl);
  assert.deepEqual(tried, ['105.KO', '106.KO']);
  assert.equal(res.candles.length, 1);
});

test('股票报告：标题带名称，时间按交易所时区，来源为对应数据源', () => {
  const meta = {
    product: '600519', name: '贵州茅台', timeframe: '1d', market: 'cn', displayTz: 'Asia/Shanghai',
    startUtc: '2025-12-31T16:00:00.000Z', endUtc: '2026-09-23T07:00:00.000Z', generatedAtUtc: '2026-09-23T07:00:00.000Z',
    source: '东方财富 K线 API', sampleCount: 180, pricePrecision: 2,
    rangeHigh: 1600, rangeLow: 1400, lastClose: 1530, lastCloseTs: Date.parse('2026-09-22T00:00:00Z') / 1000,
  };
  const out = t.renderMarkdownReport(meta, null);
  assert.ok(out.startsWith('# 600519 贵州茅台 日线波浪分析简报'));
  assert.ok(out.includes('- 时间范围（UTC+8）：2026-01-01 00:00:00 ~ 2026-09-23 15:00:00'));
  assert.ok(out.includes('- 最新收盘：1530（2026-09-22 交易日）'));
  assert.ok(out.includes('- 数据来源：东方财富 K线 API'));

  const us = t.renderMarkdownReport({ ...meta, product: 'AAPL', name: null, market: 'us', displayTz: 'America/New_York', source: 'Twelve Data time_series API' }, null);
  assert.ok(us.startsWith('# AAPL 日线波浪分析简报'));
  // 2026-09-23T07:00Z = 美东 03:00（夏令时 UTC-4）
  assert.ok(us.includes('- 时间范围（美东）：2025-12-31 11:00:00 ~ 2026-09-23 03:00:00'));
});
