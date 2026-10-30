'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { computeRisk, buildPositionAdvice, loadSnapshot, locateZone } = require('../advisor/position');
const { resolveParams } = require('../advisor/params');
const { fmtPct } = require('../advisor/format');

const P = resolveParams();
const TS = Date.UTC(2026, 8, 1) / 1000;

// 成本 98000 落在 [97800,98200] 支撑区；区下方最近确认低点 95300 → 失效价 95300 − 0.3×1000 = 95000。
function makeCtx() {
  const facts = {
    weekly: { close: 100000, ma: { 30: { value: 90000, slope: 'up' } } },
    daily: {
      close: 100000, atr: 1000,
      ma: { 30: { value: 99000, slope: 'up' }, 90: { value: 96000, slope: 'up' } },
      lastBars: [{ ts: 1, open: 99000, high: 100500, low: 98500, close: 100000 }],
      glueBreakout: { dir: null, retest: false },
      structure: { pivots: [{ type: 'L', price: 95300, ts: TS }, { type: 'H', price: 104000, ts: TS + 86400 }] },
    },
    h4: { close: 100100, ma: { 30: { value: 99800, slope: 'up' } }, structure: { pivots: [], pattern: 'HH/HL', lastHigh: { price: 100050 }, lastLow: { price: 99000 } } },
  };
  const levels = {
    price: 100000,
    zones: { support: [{ low: 97800, high: 98200, mid: 98000, count: 2, sources: [{ label: '日线MA90', price: 98000 }] }], resistance: [] },
    plans: [],
  };
  return { facts, levels, state: { family: 'long', label: '趋势多头' } };
}

test('只给成本与方向：失效价 95000，相对成本约 -3.06%，其余字段待查', () => {
  const { facts, levels, state } = makeCtx();
  const adv = buildPositionAdvice({ symbol: 'BTCUSDT', side: 'long', cost: 98000, riskPct: 0.01 }, facts, levels, state, P);
  assert.equal(adv.invalidation.price, 95000);
  assert.ok(Math.abs(adv.stopPnlPct - (-3 / 98)) < 1e-12);
  assert.equal(fmtPct(adv.stopPnlPct), '-3.06%');
  assert.equal(adv.risk.leverage, '待查');
  assert.equal(adv.risk.riskAmount, '待查');
  assert.equal(adv.qty, '待查');
  assert.equal(adv.liq, '待查');
  assert.deepEqual(adv.pending, ['持仓数量', '相关风险池权益', '设置杠杆', '强平价']);
  assert.match(adv.priceSource, /现货日线收盘价/);
  assert.ok(adv.location.zone && adv.location.zone.low === 97800);
  assert.ok(adv.location.vsMA.some((m) => m.label === '日线MA90'));
  for (const k of ['hold', 'reduce', 'stop', 'add']) assert.ok(adv.actions[k].length > 0, k);
});

test('成本不在任何区内：取成本下方最近区；仍没有则以成本下方最近低点估算', () => {
  const { facts, levels } = makeCtx();
  assert.equal(locateZone('long', 99000, levels).low, 97800);
  assert.equal(locateZone('long', 97000, levels), null);
  const adv = buildPositionAdvice({ symbol: 'BTCUSDT', side: 'long', cost: 97000, riskPct: 0.01 }, facts, levels, { family: 'long', label: 'x' }, P);
  assert.equal(adv.invalidation.price, 95000);
  assert.equal(adv.location.zone, null);
});

test('超出风险预算：逐步 25% 减仓直到止损亏损 ≤ 预算，并逐步重算杠杆与压力损失', () => {
  const { facts, levels, state } = makeCtx();
  const adv = buildPositionAdvice({
    symbol: 'BTCUSDT', side: 'long', cost: 98000, qty: 0.1, equity: 10000, markPrice: 100000, riskPct: 0.01,
  }, facts, levels, state, P);
  const r = adv.risk;
  assert.equal(r.notional, 10000);
  assert.equal(r.leverage, 1);
  assert.equal(r.riskBudget, 100);
  assert.equal(r.tradeLoss, 300);                 // 0.1 × (98000−95000)
  assert.equal(r.deltaLoss, 500);                 // 0.1 × (100000−95000)
  assert.ok(Math.abs(r.qMax - 0.02) < 1e-12);     // 100 / 5000
  assert.equal(r.overBudget, true);
  assert.deepEqual(r.stress.map((s) => s.loss), [300, 500, 1000]);
  const rows = r.reduction;
  assert.deepEqual(rows.map((x) => x.step), [0, 1, 2, 3]);
  rows.map((x) => x.tradeLoss).forEach((v, i) => assert.ok(Math.abs(v - [300, 225, 150, 75][i]) < 1e-9, `第 ${i} 步亏损 ${v}`));
  assert.equal(rows[2].withinBudget, false);
  assert.equal(rows[3].withinBudget, true);
  assert.ok(Math.abs(rows[3].remainQty - 0.025) < 1e-12);
  assert.ok(Math.abs(rows[3].leverage - 0.25) < 1e-12);
  rows[3].stress.map((x) => x.loss).forEach((v, i) => assert.ok(Math.abs(v - [75, 125, 250][i]) < 1e-9));
  assert.ok(adv.warnings.some((w) => /超出风险预算/.test(w)));
});

test('预算内且杠杆不高：不出减仓表', () => {
  const r = computeRisk({ side: 'long', cost: 100000, qty: 0.01, equity: 10000, P: 100000, S: 95000, riskPct: 0.01 }, P);
  assert.equal(r.overBudget, false);
  assert.deepEqual(r.reduction, []);
});

test('杠杆高于参考线 3 但预算内：减仓表按杠杆停止', () => {
  // 名义 40000 / 权益 10000 = 4x；止损距离 1% → 亏损 400... 预算 1% = 100 → 先超预算；这里放宽预算到 5%
  const r = computeRisk({ side: 'long', cost: 100000, qty: 0.4, equity: 10000, P: 100000, S: 99000, riskPct: 0.05 }, P);
  assert.equal(r.overBudget, false);
  assert.equal(r.overLeverage, true);
  const rows = r.reduction;
  assert.ok(rows.length >= 2);
  assert.ok(rows[rows.length - 1].withinLevRef);
  assert.equal(rows[0].withinLevRef, false);
});

test('强平早于止损：多单强平价高于失效价 → 结论首行提示', () => {
  const { facts, levels, state } = makeCtx();
  const adv = buildPositionAdvice({
    symbol: 'BTCUSDT', side: 'long', cost: 98000, qty: 0.1, equity: 10000, liq: 96000, markPrice: 100000, riskPct: 0.01,
  }, facts, levels, state, P);
  assert.equal(adv.risk.liquidation.liqBeforeStop, true);
  assert.ok(adv.headline.startsWith('强平先于止损'));
  assert.ok(adv.warnings[0].startsWith('强平先于止损'));
  const safe = buildPositionAdvice({
    symbol: 'BTCUSDT', side: 'long', cost: 98000, qty: 0.1, equity: 10000, liq: 90000, markPrice: 100000, riskPct: 0.01,
  }, facts, levels, state, P);
  assert.equal(safe.risk.liquidation.liqBeforeStop, false);
  assert.ok(!safe.headline.startsWith('强平先于止损'));
  assert.ok(Math.abs(safe.risk.liquidation.bufferPct - 0.1) < 1e-12);
});

test('逐仓：减仓表同时列出"保留保证金"与"释放保证金"两种杠杆', () => {
  const r = computeRisk({ side: 'long', cost: 98000, qty: 0.1, equity: 10000, P: 100000, S: 95000, riskPct: 0.01, margin: 'isolated' }, P);
  assert.ok(r.reduction.length > 1);
  assert.equal(r.reduction[2].leverageKeepMargin, 0.5);
  assert.equal(r.reduction[2].leverageReleaseMargin, 1);
});

test('空单镜像：亏损按失效价在上方计算', () => {
  const r = computeRisk({ side: 'short', cost: 100, qty: 1, equity: 1000, P: 98, S: 105, riskPct: 0.01, liq: 104 }, P);
  assert.equal(r.deltaLoss, 7);
  assert.equal(r.tradeLoss, 5);
  assert.equal(r.liquidation.liqBeforeStop, true); // 空单强平 104 < 失效价 105
  assert.equal(computeRisk({ side: 'short', cost: 100, qty: 1, equity: 1000, P: 98, S: 105, riskPct: 0.01, liq: 120 }, P).liquidation.liqBeforeStop, false);
});

test('缺失输入一律待查：不给 qty 时 risk.available=false', () => {
  const r = computeRisk({ side: 'long', cost: 1, qty: null, equity: 100, P: 1, S: 0.9, riskPct: 0.01 }, P);
  assert.equal(r.available, false);
  assert.equal(r.leverage, '待查');
  assert.deepEqual(r.reduction, []);
});

test('快照：yaml 读取 §20.2 字段子集，逐仓位输出，币本位标不支持', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'advise-snap-'));
  try {
    const file = path.join(dir, 'position.yaml');
    fs.writeFileSync(file, [
      "snapshot_at: '2026-10-30 12:00:00 +08:00'",
      'exchange: Binance',
      'totalMarginBalance: 20000',
      'positions:',
      '  - symbol: BTCUSDT',
      '    positionSide: LONG',
      '    positionAmt: 0.5',
      '    entryPrice: 98000',
      '    markPrice: 100100',
      '    leverage_configured: 10',
      '    marginType: ISOLATED',
      '    isolatedWallet: 5000',
      '    liquidationPrice: 90000',
      '  - symbol: BTCUSDT',
      '    positionSide: SHORT',
      '    positionAmt: -0.2',
      '    entryPrice: 103000',
      '    marginType: CROSSED',
      '    liquidationPrice: null',
      '  - symbol: BTCUSD_PERP',
      '    positionAmt: 3',
      '    entryPrice: 99000',
      '  - symbol: ETHUSDT',
      '    positionAmt: 0',
    ].join('\n'));
    const snap = loadSnapshot(file);
    assert.equal(snap.positions.length, 3, '数量为 0 的仓位被忽略');
    const [a, b, c] = snap.positions;
    assert.deepEqual([a.symbol, a.side, a.qty, a.cost, a.markPrice, a.lev, a.margin, a.equity, a.liq], ['BTCUSDT', 'long', 0.5, 98000, 100100, 10, 'isolated', 5000, 90000]);
    assert.deepEqual([b.side, b.qty, b.margin, b.equity, b.liq, b.lev], ['short', 0.2, 'cross', 20000, null, null]);
    assert.equal(c.supported, false);
    assert.match(c.reason, /币本位/);
    assert.equal(a.supported, true);

    const json = path.join(dir, 'p.json');
    fs.writeFileSync(json, JSON.stringify({ totalMarginBalance: 10, positions: [{ symbol: 'ETHUSDT', positionAmt: '-2', entryPrice: '3000' }] }));
    const s2 = loadSnapshot(json);
    assert.deepEqual([s2.positions[0].side, s2.positions[0].qty, s2.positions[0].cost, s2.positions[0].equity], ['short', 2, 3000, 10]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('快照：内容为空时抛错', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'advise-snap-'));
  try {
    const file = path.join(dir, 'empty.yaml');
    fs.writeFileSync(file, '');
    assert.throws(() => loadSnapshot(file), /内容为空/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
