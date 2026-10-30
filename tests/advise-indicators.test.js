'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ind = require('../advisor/indicators');
const { resolveParams } = require('../advisor/params');

const DAILY = require('./fixtures/btcusdt-1d-20261025.json');
const P = resolveParams();
const near = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

test('sma 手算小样本', () => {
  assert.deepEqual(ind.sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  assert.deepEqual(ind.sma([2], 3), [null]);
});

test('ema 以首值为种子，手算 alpha=0.5', () => {
  assert.deepEqual(ind.ema([1, 2, 3], 3), [1, 1.5, 2.25]);
});

test('macd 手算：fast=2 slow=3 signal=2，closes=[1,2,3,4]', () => {
  const m = ind.macd([1, 2, 3, 4], 2, 3, 2);
  // 预热 slow+signal−2 = 3 根，仅最后一根有值：DIF=0.39352、DEA=0.34259、柱=0.05093
  assert.deepEqual(m.hist.slice(0, 3), [null, null, null]);
  near(m.dif[3], 0.39352);
  near(m.dea[3], 0.34259);
  near(m.hist[3], 0.05093);
});

test('斜率方向：上行 / 下行 / 走平（阈值 0.1%）', () => {
  assert.equal(ind.slopeOf([100, 100, 100, 100, 100, 101], 5, 5, 0.001).dir, 'up');
  assert.equal(ind.slopeOf([100, 0, 0, 0, 0, 99], 5, 5, 0.001).dir, 'down');
  const flat = ind.slopeOf([100, 0, 0, 0, 0, 100.05], 5, 5, 0.001);
  assert.equal(flat.dir, 'flat');
  near(flat.slopePct, 0.0005, 1e-9);
  assert.equal(ind.slopeOf([1, 2], 1, 5, 0.001), null);
});

test('排列与粘合', () => {
  assert.equal(ind.alignmentOf(3, 2, 1), 'bull');
  assert.equal(ind.alignmentOf(1, 2, 3), 'bear');
  assert.equal(ind.alignmentOf(2, 3, 1), 'mixed');
  assert.equal(ind.alignmentOf(null, 3, 1), null);
  const g = ind.glueAt(100, 102, 101, 100);
  near(g.spreadPct, 0.02, 1e-12);
  assert.equal(ind.glueAt(null, 1, 1, 1), null);
});

test('止跌 K：长下影 / 看涨吞没 / 支撑价约束；止涨对称', () => {
  const hammer = { open: 100, high: 101, low: 90, close: 100.5 }; // 下影 10 / 振幅 11
  assert.equal(ind.reversalCandle([hammer], 'long', 95, P).kind, 'wick');
  assert.equal(ind.reversalCandle([hammer], 'long', 101, P).met, false, '收盘低于支撑价不算止跌');
  assert.equal(ind.reversalCandle([hammer], 'long', null, P).met, true);
  const prev = { open: 105, high: 106, low: 99, close: 100 };
  const engulf = { open: 99.5, high: 106.5, low: 99, close: 106 };
  assert.equal(ind.reversalCandle([prev, engulf], 'long', null, P).kind, 'engulf');
});

test('止涨 K：长上影且收盘不高于阻力价', () => {
  const star = { open: 100, high: 110, low: 99.5, close: 99.8 };
  assert.equal(ind.reversalCandle([star], 'short', 105, P).kind, 'wick');
  assert.equal(ind.reversalCandle([star], 'short', 99, P).met, false);
});

test('analyzeTimeframe：均线数值可复现，且与手算一致', () => {
  const a = ind.analyzeTimeframe(DAILY, '日线', P);
  const b = ind.analyzeTimeframe(DAILY, '日线', P);
  assert.deepEqual(a.facts, b.facts);
  const closes = DAILY.map((c) => c.close);
  for (const n of [5, 10, 30, 90, 120, 256]) {
    const manual = closes.slice(-n).reduce((s, v) => s + v, 0) / n;
    near(a.facts.ma[n].value, manual, 1e-6);
    near(a.facts.ma[n].devPct, (closes[closes.length - 1] - manual) / manual, 1e-12);
  }
  assert.ok(['up', 'flat', 'down'].includes(a.facts.ma[90].slope));
  assert.ok(['bull', 'bear', 'mixed'].includes(a.facts.alignment));
  assert.ok(a.facts.macd && Number.isFinite(a.facts.macd.hist));
  assert.equal(a.facts.lastBars.length, 3);
});

test('历史不足：对应指标为 null 并写入 dataGaps（含实际根数）', () => {
  const short = DAILY.slice(0, 100);
  const { facts } = ind.analyzeTimeframe(short, '日线', P);
  assert.equal(facts.ma[120], null);
  assert.equal(facts.ma[256], null);
  assert.ok(facts.ma[90]);
  assert.ok(facts.dataGaps.some((g) => /MA256 数据不足，未计算（实际 100 根/.test(g)));
  assert.ok(facts.dataGaps.some((g) => /MA120/.test(g)));
  const tiny = ind.analyzeTimeframe(DAILY.slice(0, 10), '日线', P).facts;
  assert.equal(tiny.macd, null);
  assert.equal(tiny.glue, null);
  assert.equal(tiny.atr, null);
});

test('glueBreakout：粘合后上破并回踩 → up + retest', () => {
  // 构造 40 根：前 30 根几乎不动（粘合），随后上破，最近几根回踩带上沿
  const candles = [];
  for (let i = 0; i < 30; i += 1) candles.push({ open: 100, high: 100.5, low: 99.5, close: 100, timestamp: i });
  for (let i = 30; i < 36; i += 1) candles.push({ open: 100 + (i - 29) * 2, high: 102 + (i - 29) * 2, low: 99.5 + (i - 29) * 2, close: 101 + (i - 29) * 2, timestamp: i });
  candles.push({ open: 113, high: 113.5, low: 100.2, close: 113, timestamp: 36 }); // 下探回踩
  const closes = candles.map((c) => c.close);
  const m = (n) => ind.sma(closes, n);
  const m30 = m(30); const m90 = candles.map(() => 100); const m120 = candles.map(() => 100);
  const glueSeries = candles.map((c, i) => ind.glueAt(m30[i], m90[i], m120[i], c.close));
  glueSeries.atr = 2;
  const r = ind.glueBreakout(candles, glueSeries, { ...P, glueLookback: 20 });
  assert.equal(r.dir, 'up');
  assert.equal(r.retest, true);
  assert.equal(r.glueRecent, true);
});
