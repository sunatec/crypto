'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { collectCandidates, mergeZones, selectZones, buildLevels } = require('../advisor/levels');
const { resolveParams } = require('../advisor/params');

const P = resolveParams();
const TS = Date.UTC(2026, 8, 1) / 1000;
const ma = (value) => ({ value, slope: 'up' });

// 日线收盘 100000、ATR 1000；波段 86000→104000，斐波 0.5 恰为 95000，与日线 MA90 重合。
function makeFacts({ dailyLows = [], h4 = {} } = {}) {
  return {
    weekly: { close: 100000, ma: { 30: ma(90000) } },
    daily: {
      close: 100000, atr: 1000,
      ma: { 30: ma(101500), 90: ma(95000), 120: ma(93000), 256: ma(80000) },
      lastBars: [{ ts: 1, open: 96000, high: 97000, low: 94500, close: 96500 }],
      glueBreakout: { dir: null, retest: false },
      structure: {
        pivots: [
          { type: 'L', price: 86000, ts: TS },
          ...dailyLows.map((price, i) => ({ type: 'L', price, ts: TS + (i + 1) * 86400 })),
          { type: 'H', price: 104000, ts: TS + 20 * 86400 },
        ].sort((a, b) => a.ts - b.ts),
        lastSwing: { from: { price: 86000, ts: TS }, fromType: 'L', to: { price: 104000, ts: TS + 20 * 86400 }, toType: 'H' },
        pattern: 'HH/HL',
      },
    },
    h4: {
      close: 100200, ma: { 30: ma(99500), 90: ma(97800), 120: ma(98500) },
      structure: { pivots: [], pattern: 'HH/HL', lastHigh: { price: 100000 }, lastLow: { price: 98000 } },
      ...h4,
    },
  };
}

test('候选价位收集：MA、结构高低点、斐波都带来源标签', () => {
  const cands = collectCandidates(makeFacts(), P);
  const labels = cands.map((c) => c.label);
  assert.ok(labels.includes('日线MA90'));
  assert.ok(labels.includes('周线MA30'));
  assert.ok(labels.includes('4H MA30'));
  assert.ok(labels.some((l) => l.startsWith('斐波0.5')));
  assert.ok(labels.some((l) => l.startsWith('日线高点')));
  const fib5 = cands.find((c) => c.label.startsWith('斐波0.5'));
  assert.equal(fib5.price, 95000);
});

test('共振合并：MA90 与斐波 0.5 相距 < 0.5×ATR → 一个区，来源数 2 且两项都列出', () => {
  const zones = mergeZones(collectCandidates(makeFacts(), P), 1000, P.mergeAtr);
  const z = zones.find((x) => x.low <= 95000 && x.high >= 95000);
  assert.equal(z.count, 2);
  assert.ok(z.sources.some((s) => s.label === '日线MA90'));
  assert.ok(z.sources.some((s) => s.label.startsWith('斐波0.5')));
});

test('合并按相邻差：差 > 0.5×ATR 的不合并；同名来源去重', () => {
  const zones = mergeZones([
    { price: 100, label: 'a' }, { price: 100.4, label: 'b' }, { price: 100.4, label: 'b' }, { price: 101.5, label: 'c' },
  ], 1, 0.5);
  assert.equal(zones.length, 2);
  assert.equal(zones[0].count, 2);
  assert.deepEqual([zones[0].low, zones[0].high], [100, 100.4]);
});

test('选区：上下方各至多 3 个，来源数多者优先，输出由近到远', () => {
  const zones = [];
  for (let i = 1; i <= 5; i += 1) zones.push({ low: 100 - i, high: 100 - i, mid: 100 - i, count: i === 5 ? 1 : 2, sources: [] });
  for (let i = 1; i <= 4; i += 1) zones.push({ low: 100 + i, high: 100 + i, mid: 100 + i, count: 1, sources: [] });
  const sel = selectZones(zones, 100, P);
  assert.equal(sel.support.length, 3);
  assert.equal(sel.resistance.length, 3);
  assert.ok(sel.support.every((z) => z.mid !== 95), '来源数最少的最远一个被挤出');
  assert.deepEqual(sel.support.map((z) => z.mid), [99, 98, 97]);
  assert.ok(sel.support.every((z) => z.side === 'support'));
});

test('顺势方向出完整计划：区、右侧三条触发、失效价、TP、盈亏比', () => {
  const facts = makeFacts({ dailyLows: [94000] });
  const out = buildLevels(facts, { family: 'long' }, P);
  const card = out.plans.find((c) => c.side === 'support' && c.zone.low <= 95000 && c.zone.high >= 95000);
  assert.equal(card.kind, 'plan');
  assert.equal(card.direction, 'long');
  assert.equal(card.triggers.length, 3);
  // 4H 收 100200 > MA30 99500，且 > 最近 LH 100000，结构 HH/HL → R1 满足
  assert.equal(card.triggers[0].met, true);
  assert.equal(card.triggerMet, true);
  assert.equal(card.invalidation.price, 94000 - 0.3 * 1000);
  assert.equal(card.tp1, 101500);
  const expectRR = (101500 - 95000) / (95000 - 93700);
  assert.ok(Math.abs(card.rr - expectRR) < 1e-9);
  assert.equal(card.rrFlag, null);
  // 上方阻力区只作观察位
  assert.ok(out.plans.filter((c) => c.side === 'resistance').every((c) => c.kind === 'watch'));
});

test('盈亏比不足：标"性价比不足"但保留在输出中', () => {
  const facts = makeFacts(); // 最近低点是 86000 → 失效价 85700，TP1 101500 → rr ≈ 0.70
  const out = buildLevels(facts, { family: 'long' }, P);
  const card = out.plans.find((c) => c.side === 'support' && c.zone.low <= 95000 && c.zone.high >= 95000);
  assert.ok(card.rr < 1.5);
  assert.equal(card.rrFlag, '性价比不足');
  assert.equal(card.kind, 'plan');
});

test('逆势方向只作观察位：TREND_SHORT 下的支撑区不给多头入场计划', () => {
  const out = buildLevels(makeFacts(), { family: 'short' }, P);
  const supports = out.plans.filter((c) => c.side === 'support');
  assert.ok(supports.length > 0);
  for (const c of supports) {
    assert.equal(c.kind, 'watch');
    assert.equal(c.direction, null);
    assert.match(c.tag, /观察位，不建议参与/);
    assert.equal(c.triggers, undefined);
  }
  assert.ok(out.plans.filter((c) => c.side === 'resistance').every((c) => c.direction === 'short' && c.kind === 'plan'));
});

test('TREND_BROKEN_LONG 不出多头计划；RANGE 两侧都出并标区间边缘·轻仓', () => {
  const broken = buildLevels(makeFacts(), { family: 'broken' }, P);
  assert.ok(broken.plans.every((c) => c.direction !== 'long'));
  assert.ok(broken.plans.every((c) => c.kind === 'watch'));
  const range = buildLevels(makeFacts(), { family: 'range' }, P);
  assert.ok(range.plans.every((c) => c.kind === 'plan' && /区间边缘·轻仓/.test(c.tag)));
  assert.ok(range.plans.some((c) => c.direction === 'long') && range.plans.some((c) => c.direction === 'short'));
});

test('空头计划镜像：失效价在区上方，TP 取下方支撑区上沿', () => {
  const out = buildLevels(makeFacts(), { family: 'short' }, P);
  const card = out.plans.find((c) => c.side === 'resistance' && c.kind === 'plan');
  assert.ok(card.invalidation.price > card.zone.high);
  if (card.tp1 != null) assert.ok(card.tp1 < card.zone.mid);
  assert.equal(card.triggers.length, 3);
});

test('日线 ATR 不足：不输出计划并写 dataGaps', () => {
  const facts = makeFacts();
  facts.daily.atr = null;
  const out = buildLevels(facts, { family: 'long' }, P);
  assert.deepEqual(out.plans, []);
  assert.ok(out.dataGaps.length === 1);
});
