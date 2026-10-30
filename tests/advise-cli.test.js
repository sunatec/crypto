'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, resolveSymbol, UsageError } = require('../advisor/cli');
const { PARAM_DEFS, VALID_SOURCES, resolveParams, describeParams } = require('../advisor/params');

test('未给成本价进入点位模式', () => {
  const a = parseArgs(['BTC-USD']);
  assert.equal(a.mode, 'points');
  assert.equal(a.symbol, 'BTCUSDT');
  assert.equal(a.narrate, false);
});

test('给成本价缺方向以 UsageError 退出并提示 --side', () => {
  assert.throws(() => parseArgs(['BTC-USD', '--cost', '98000']), (e) => e instanceof UsageError && /--side/.test(e.message));
});

test('给成本价与方向进入持仓模式，数值参数转为数字', () => {
  const a = parseArgs(['BTC-USD', '--cost', '98000', '--side', 'LONG', '--qty', '0.1', '--equity', '10000', '--lev', '5', '--liq', '90000', '--margin', 'isolated', '--risk', '0.02']);
  assert.deepEqual([a.mode, a.cost, a.side, a.qty, a.equity, a.lev, a.liq, a.margin, a.risk], ['position', 98000, 'long', 0.1, 10000, 5, 90000, 'isolated', 0.02]);
});

test('交易对识别：BTC-USD / btcusdt / ETHUSDT', () => {
  assert.equal(resolveSymbol('BTC-USD'), 'BTCUSDT');
  assert.equal(resolveSymbol('btcusdt'), 'BTCUSDT');
  assert.equal(resolveSymbol('ETHUSDT'), 'ETHUSDT');
  assert.throws(() => resolveSymbol('BTC'), UsageError);
  assert.throws(() => resolveSymbol(''), UsageError);
});

test('非法输入一律 UsageError', () => {
  assert.throws(() => parseArgs([]), UsageError);
  assert.throws(() => parseArgs(['BTC-USD', 'ETH-USD']), UsageError);
  assert.throws(() => parseArgs(['BTC-USD', '--bogus']), UsageError);
  assert.throws(() => parseArgs(['BTC-USD', '--cost']), UsageError);
  assert.throws(() => parseArgs(['BTC-USD', '--cost', 'abc', '--side', 'long']), UsageError);
  assert.throws(() => parseArgs(['BTC-USD', '--cost', '1', '--side', 'up']), UsageError);
  assert.throws(() => parseArgs(['BTC-USD', '--qty', '1']), /持仓参数/);
  assert.throws(() => parseArgs(['BTC-USD', '--risk', '1']), UsageError);
  assert.throws(() => parseArgs(['BTC-USD', '--model', 'x']), UsageError);
});

test('--snapshot 可替代持仓参数；--narrate/--json/--model 解析', () => {
  const a = parseArgs(['BTC-USD', '--snapshot', 'p.yaml', '--narrate', '--model', 'claude-opus-5-5', '--json']);
  assert.equal(a.mode, 'position');
  assert.equal(a.snapshot, 'p.yaml');
  assert.deepEqual([a.narrate, a.model, a.json], [true, 'claude-opus-5-5', true]);
});

test('params：每项阈值都带 A/B/D 来源标注与说明', () => {
  for (const [name, def] of Object.entries(PARAM_DEFS)) {
    assert.ok(VALID_SOURCES.includes(def.source), `${name} 缺来源标注`);
    assert.ok(def.note && def.note.length > 0, `${name} 缺说明`);
  }
  const p = resolveParams();
  assert.equal(p.slopeFlat, 0.001);
  assert.equal(p.gluePct, 0.03);
  assert.equal(p.stopWickRatio, 0.5);
  assert.equal(p.mergeAtr, 0.5);
  assert.equal(p.invalidationBufferAtr, 0.3);
  assert.equal(p.minRR, 1.5);
  assert.equal(p.riskPct, 0.01);
  assert.equal(p.levRef, 3);
  assert.equal(describeParams(p).length, Object.keys(PARAM_DEFS).length);
  assert.equal(resolveParams({ minRR: 2 }).minRR, 2);
  assert.throws(() => resolveParams({ nope: 1 }), /未知参数/);
});

test('require("yaml") 可用', () => {
  assert.deepEqual(require('yaml').parse('a: 1\nb: [x]'), { a: 1, b: ['x'] });
});
