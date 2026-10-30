'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyState, STATE_LABELS } = require('../advisor/state');

const deep = (base, patch) => {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? deep(base[k], v) : v;
  }
  return out;
};

// 默认是一份标准的上升趋势事实；各用例只改要紧的字段。
const uptrend = () => ({
  weekly: { close: 100, alignment: 'bull', ma: { 30: { value: 90, slope: 'up' } } },
  daily: {
    close: 110, glue: { glued: false },
    ma: { 30: { value: 105, slope: 'up' }, 90: { value: 95, slope: 'up' }, 120: { value: 90, slope: 'up' } },
    structure: { pattern: 'HH/HL', lastLow: { price: 100 }, prevLow: { price: 90 }, lastHigh: { price: 115 }, prevHigh: { price: 105 } },
  },
  h4: { structure: { pattern: 'HH/HL' } },
});

const downtrend = () => ({
  weekly: { close: 80, alignment: 'bear', ma: { 30: { value: 90, slope: 'down' } } },
  daily: {
    close: 85, glue: { glued: false },
    ma: { 30: { value: 92, slope: 'down' }, 90: { value: 95, slope: 'down' }, 120: { value: 98, slope: 'down' } },
    structure: { pattern: 'LH/LL', lastLow: { price: 82 }, prevLow: { price: 90 }, lastHigh: { price: 100 }, prevHigh: { price: 110 } },
  },
  h4: { structure: { pattern: 'LH/LL' } },
});

test('TREND_LONG：周线偏多、HL 未破、MA90/120 上行', () => {
  const r = classifyState(uptrend());
  assert.equal(r.state, 'TREND_LONG');
  assert.equal(r.label, STATE_LABELS.TREND_LONG);
  assert.equal(r.family, 'long');
  assert.ok(r.conditions.length >= 10);
  assert.equal(r.conditions.find((c) => c.id === 'W_UP').met, true);
});

test('PULLBACK_IN_UPTREND：周线收于上行 MA30 之上、日线 HL 未破但收在 MA30 下', () => {
  const r = classifyState(deep(uptrend(), { daily: { close: 103 } }));
  assert.equal(r.state, 'PULLBACK_IN_UPTREND');
  assert.equal(r.conditions.find((c) => c.id === 'D_BELOW_MA30').met, true);
  assert.equal(r.conditions.find((c) => c.id === 'D_HL_INTACT').met, true);
});

test('PULLBACK_IN_UPTREND：日线站上 MA30 但 4H 为 LH/LL 也算回调', () => {
  const r = classifyState(deep(uptrend(), { h4: { structure: { pattern: 'LH/LL' } } }));
  assert.equal(r.state, 'PULLBACK_IN_UPTREND');
});

test('TREND_BROKEN_LONG：日线收盘跌破 HL 且 MA90 走平/下行', () => {
  const r = classifyState(deep(uptrend(), { daily: { close: 98, ma: { 90: { slope: 'flat' } } } }));
  assert.equal(r.state, 'TREND_BROKEN_LONG');
  assert.equal(r.family, 'broken');
});

test('TREND_BROKEN_LONG：周线收在下行 MA30 下，日线还不是完整 LH/LL', () => {
  const f = deep(uptrend(), { weekly: { close: 80, ma: { 30: { value: 90, slope: 'down' } } }, daily: { structure: { pattern: 'mixed' } } });
  assert.equal(classifyState(f).state, 'TREND_BROKEN_LONG');
});

test('优先级：破坏优先于区间与趋势', () => {
  const f = deep(uptrend(), { daily: { close: 98, glue: { glued: true }, ma: { 90: { slope: 'down' } } } });
  assert.equal(classifyState(f).state, 'TREND_BROKEN_LONG');
  // HL 破了但 MA90 仍上行：不判破坏，也不是任何多头趋势
  const g = deep(uptrend(), { daily: { close: 98 } });
  const rg = classifyState(g);
  assert.notEqual(rg.state, 'TREND_LONG');
  assert.notEqual(rg.state, 'TREND_BROKEN_LONG');
});

test('RANGE：日线粘合；或周线交错且 MA30 走平；或无任何命中', () => {
  assert.equal(classifyState(deep(uptrend(), { daily: { glue: { glued: true } } })).state, 'RANGE');
  const f = deep(uptrend(), { weekly: { alignment: 'mixed', ma: { 30: { slope: 'flat' } } } });
  assert.equal(classifyState(f).state, 'RANGE');
  const none = deep(uptrend(), { daily: { ma: { 90: { slope: 'flat' } } } });
  const r = classifyState(none);
  assert.equal(r.state, 'RANGE');
  assert.match(r.rule, /未命中/);
});

test('TREND_SHORT：多头判定的镜像', () => {
  const r = classifyState(downtrend());
  assert.equal(r.state, 'TREND_SHORT');
  assert.equal(r.family, 'short');
});

test('RALLY_IN_DOWNTREND：日线反抽到 MA30 上方但 LH 未破', () => {
  const r = classifyState(deep(downtrend(), { daily: { close: 95 } }));
  assert.equal(r.state, 'RALLY_IN_DOWNTREND');
});

test('数据缺失时不编造：缺周线 MA30 → 条件为 null，落到 RANGE', () => {
  const f = deep(uptrend(), { weekly: { ma: { 30: null } } });
  const r = classifyState(f);
  assert.equal(r.state, 'RANGE');
  assert.equal(r.conditions.find((c) => c.id === 'W_UP').met, null);
});

test('回调中连续更低的低点不算 HL 被破：以最近"更高的低点"为准（真实行情回归）', () => {
  // 日线最近低点 79 < 前低 80（LL），但最近一个 HL 是 70；收盘 78 仍在 HL 之上，MA90 上行 → 回调而非 RANGE
  const f = deep(uptrend(), {
    daily: {
      close: 78,
      structure: { pattern: 'mixed', lastLow: { price: 79 }, prevLow: { price: 80 }, lastHL: { price: 70 }, lastHigh: { price: 115 }, prevHigh: { price: 105 } },
    },
  });
  const r = classifyState(f);
  assert.equal(r.state, 'PULLBACK_IN_UPTREND');
  assert.equal(r.conditions.find((c) => c.id === 'D_HL_BROKEN').met, false);
});

test('周线下行 + 日线 HH/HL 反抽：不是多头破坏，走空头镜像的反抽态', () => {
  const f = deep(downtrend(), {
    daily: { close: 95, structure: { pattern: 'HH/HL', lastHigh: { price: 120 }, prevHigh: { price: 110 }, lastLow: { price: 90 }, prevLow: { price: 85 } } },
    h4: { structure: { pattern: 'HH/HL' } },
  });
  const r = classifyState(f);
  assert.equal(r.state, 'RALLY_IN_DOWNTREND');
  assert.equal(r.family, 'short');
});
