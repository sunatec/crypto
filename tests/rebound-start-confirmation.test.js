'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../analyze-wave-tree.js');

const T0 = Date.parse('2026-11-01T00:00:00Z') / 1000;
const bars = (hl) => hl.map(([high, low], i) => ({ index: i, timestamp: T0 + i * 3600, open: low, close: high, high, low }));
const piv = (type, price, i, dt = 0) => ({ type, price, index: i, timestamp: T0 + i * 3600 + dt });

// 用户手工读法：87395.67 → 75736.38，途中最大反弹 79800→84898；末段起点 78063.3；
// 止跌后 78718 / 78001.77 / 81196.01 / 80236.2 / 80719.58 / 79952 / 80962。
const BASE = [
  [87395.67, 87000], [86000, 79800], [84898, 82000], [82000, 77000], [78063.3, 77500], [77000, 75736.38],
  [78718, 76000], [78500, 78001.77], [81196.01, 78500], [80900, 80236.2], [80719.58, 80300], [80500, 79952],
  [80962, 80100], [80800, 80256],
];
const BASE_FINE = [piv('H', 87395.67, 0), piv('L', 79800, 1), piv('H', 84898, 2), piv('L', 77000, 3), piv('H', 78063.3, 4), piv('L', 75736.38, 5),
  piv('H', 81196.01, 8), piv('L', 79952, 11), piv('H', 80962, 12)];
const SWING = { price: 87395.67, timestamp: T0 };

const build = (hl, fine, extra = {}) => E.buildReboundConfirmation({ candles: bars(hl), fine, swingExtreme: SWING, tf: '1h', ...extra });

test('用户手工读法：确认线 78063.3 / 80834.38 / 87395.67，门槛 守住 79952 且冲破 81196.01', () => {
  const rc = build(BASE, BASE_FINE);
  assert.equal(rc.low.price, 75736.38);
  assert.deepEqual(rc.lines.map((l) => [l.key, l.price, l.crossed]), [
    ['finalLeg', 78063.3, true], ['degree', 80834.38, true], ['origin', 87395.67, false],
  ]);
  assert.equal(rc.lines[1].bounce.from, 79800);
  assert.equal(rc.lines[1].bounce.depth, 5098);
  assert.equal(rc.next.key, 'origin');
  assert.equal(rc.gate.state, 'pending');
  assert.equal(rc.gate.h1.price, 81196.01);
  assert.equal(rc.gate.l2.price, 79952);
  assert.equal(rc.gate.l2.provisional, false);
  assert.deepEqual(rc.gate.targets.map((t) => Number(t.price.toFixed(2))), [85411.63, 88785.68]);
});

test('跌出新低：按 75208.42 全部重算，15m 最早信号一行排在最前', () => {
  const hl = [...BASE, [77500, 75568], [76559.8, 75701], [76200, 75208.42], [76416.24, 75900], [76300, 75360.81], [75800, 75600]];
  const fine = [...BASE_FINE, piv('L', 75568, 14), piv('H', 76559.8, 15), piv('L', 75208.42, 16)];
  const finerFine = [piv('H', 76559.8, 15), piv('L', 75766.66, 15, 900), piv('H', 76126.01, 15, 1800), piv('L', 75208.42, 16)];
  const rc = build(hl, fine, { finerFine, finerTf: '15m' });
  assert.equal(rc.low.price, 75208.42);
  assert.deepEqual(rc.lines.map((l) => [l.key, l.price, l.crossed]), [
    ['finer', 76126.01, true], ['finalLeg', 76559.8, false], ['degree', 80668.05, false], ['origin', 87395.67, false],
  ]);
  assert.equal(rc.lines[2].bounce.from, 75736.38);
  assert.equal(rc.lines[2].bounce.to, 81196.01);
  assert.equal(rc.finerTf, '15m');
  assert.equal(rc.next.price, 76559.8);
  assert.equal(rc.gate.h1.price, 76416.24);
  assert.equal(rc.gate.l2.price, 75360.81);
});

test('冲破 ① 高点：third；冲破后又跌回 ① 高点下方（浅于 ②）：overlap，不给浪③目标', () => {
  const third = build([...BASE, [81500, 80500], [81800, 81300]], BASE_FINE);
  assert.equal(third.gate.state, 'third');
  assert.equal(third.gate.h1.price, 81196.01);
  assert.equal(third.gate.targets.length, 2);
  const overlap = build([...BASE, [81500, 80500], [81400, 81000]], BASE_FINE);
  assert.equal(overlap.gate.state, 'overlap');
  assert.equal(overlap.gate.h1.price, 81196.01);
  assert.deepEqual(overlap.gate.targets, []);
});

test('反弹只有一段（还没回调）：不出门槛；低点是最后一根 K 线时也不出', () => {
  const one = build([...BASE.slice(0, 6), [76500, 75900], [77500, 76400]], BASE_FINE.slice(0, 6));
  assert.equal(one.gate, null);
  const atLow = build(BASE.slice(0, 6), BASE_FINE.slice(0, 6));
  assert.equal(atLow.gate, null);
  assert.ok(atLow.lines.every((l) => !l.crossed));
  // ② 低点落在最后一根 K 线：暂定
  const live = build(BASE.slice(0, 12), BASE_FINE.slice(0, 6));
  assert.equal(live.gate.l2.price, 79952);
  assert.equal(live.gate.l2.provisional, true);
});

test('默认 md 只出表与门槛，verbose 才有推算、§3.3 与 0.236', () => {
  const rc = build(BASE, BASE_FINE);
  const nr = { reboundConfirmation: rc, axis2Roles: [{ legCn: 'b 腿' }], higherDegree: { state: 'reached', invalid: false }, completedReading: { nextLegs: [] } };
  const md = E.renderReboundConfirmation(nr, 2);
  assert.match(md, /### 止跌后反弹到哪算开始（低点 75736\.38/);
  assert.match(md, /\| 78063\.3 \| 最后一小段下跌结束，小级别反弹开始 \| 已越过/);
  assert.match(md, /\| 87395\.67 \| 整段回调结束（b 腿 走完） \| 未到/);
  assert.match(md, /守住 \*\*79952\*\* 且冲破 \*\*81196\.01\*\* → 可能在走五浪，支持“已走完”/);
  assert.match(md, /先跌破 79952 → 反弹更像三波，支持“横着走”/);
  assert.doesNotMatch(md, /§3\.3|0\.236|浪③ 目标/);
  const v = E.renderReboundConfirmation(nr, 2, { verbose: true });
  assert.match(v, /80834\.38 = 75736\.38 \+ 5098/);
  assert.match(v, /0\.236 回撤位 78487\.97/);
  assert.match(v, /锯齿形的 C 浪同样会越过 A 浪终点/);
  assert.match(v, /85411\.63 \/ 88785\.68/);
  assert.equal(E.renderReboundConfirmation({ reboundConfirmation: null }, 2), '');
});

test('主周期 1h：直接用主周期 K 线；15m 取数失败时省掉最早信号一行', async () => {
  const candles = bars(BASE);
  const rc = await E.loadReboundConfirmation(
    { product: 'BTC-USD', mainTf: '1h', finePivots: BASE_FINE, candles, endTs: candles.at(-1).timestamp },
    SWING, async () => { throw new Error('offline'); });
  assert.equal(rc.tf, '1h');
  assert.equal(rc.finerTf, null);
  assert.deepEqual(rc.lines.map((l) => l.price), [78063.3, 80834.38, 87395.67]);
});
