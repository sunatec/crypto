'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildFacts } = require('../advisor/facts');
const { renderReport, renderTerminal, DISCLAIMER } = require('../advisor/report');
const { findUnverifiedNumbers } = require('../advisor/numbers');
const { makeMarket, LAST_CLOSE, FUTURES } = require('./advise-helpers');

const SECTIONS = ['## A. 一句话结论', '## B. 账户体检', '## C. 多周期图形', '## D. 主情景 / 备选情景与共振点位', '## E. 单笔风控', '## F. 分步操作表', '## G. 组合压力测试', '## H. 最终建议', '## 附录：本次参数与来源级别'];

function assertSectionsInOrder(md) {
  let at = -1;
  for (const s of SECTIONS) {
    const i = md.indexOf(s);
    assert.ok(i > at, `章节缺失或顺序不对：${s}`);
    at = i;
  }
}

test('点位模式报告：A–H 章节齐全且顺序固定，首尾免责声明，B 节写未提供账户信息', () => {
  const facts = buildFacts(makeMarket(), { positions: [] });
  const md = renderReport(facts);
  assertSectionsInOrder(md);
  assert.ok(md.startsWith(`> ${DISCLAIMER}`));
  assert.ok(md.trimEnd().endsWith(`> ${DISCLAIMER}`));
  assert.match(md, /未提供账户信息/);
  assert.match(md, /点位模式没有持仓，不适用/);
  assert.match(md, /附录[\s\S]*slopeFlat[\s\S]*D（手册执行建议）/);
  assert.match(md, /MA256/);
  assert.match(md, /数据不足/); // 周线 MA90 等历史不足
});

test('报告中的每个数字（≥3 位有效数字）都出自事实 JSON：点位模式', () => {
  const facts = buildFacts(makeMarket(), { positions: [], futures: null });
  const bad = findUnverifiedNumbers(renderReport(facts), facts);
  assert.deepEqual(bad, []);
});

test('报告中的每个数字都出自事实 JSON：持仓模式（含减仓表、压力测试、逐仓）', () => {
  const positions = [{
    symbol: 'BTCUSDT', side: 'long', cost: LAST_CLOSE * 0.97, qty: 0.5, equity: 20000, lev: 10, liq: LAST_CLOSE * 0.9, margin: 'isolated',
  }, { symbol: 'BTCUSDT', side: 'short', cost: LAST_CLOSE * 1.02, qty: 0.2, equity: 20000, lev: null, liq: null, margin: 'cross' }];
  const facts = buildFacts(makeMarket(), { positions, futures: FUTURES, futuresTried: true });
  const md = renderReport(facts);
  assertSectionsInOrder(md);
  assert.deepEqual(findUnverifiedNumbers(md, facts), []);
  assert.match(md, /\| 步骤 \| 操作 \|/);
  assert.match(md, /实际杠杆（保留保证金）/);
  assert.match(md, /实际杠杆（释放保证金）/);
  assert.match(md, /合约标记价 /);
  assert.doesNotMatch(md, /未提供账户信息/);
});

test('只给成本与方向：风险金额与杠杆标待查', () => {
  const facts = buildFacts(makeMarket(), { positions: [{ symbol: 'BTCUSDT', side: 'long', cost: LAST_CLOSE * 0.97 }], futures: null, futuresTried: true });
  const md = renderReport(facts);
  assert.match(md, /实际杠杆（名义 ÷ 权益） \| 待查/);
  assert.match(md, /合约标记价：获取失败/);
  assert.match(md, /现货日线收盘价（合约标记价获取失败/);
  assert.match(md, /减仓分步表待查/);
  assert.deepEqual(findUnverifiedNumbers(md, facts), []);
});

test('终端摘要：包含状态、关键价位与动作清单', () => {
  const pointFacts = buildFacts(makeMarket(), { positions: [] });
  const t1 = renderTerminal(pointFacts);
  assert.match(t1, /点位模式/);
  assert.match(t1, /状态：/);
  assert.match(t1, /支撑区/);
  const posFacts = buildFacts(makeMarket(), { positions: [{ symbol: 'BTCUSDT', side: 'long', cost: LAST_CLOSE * 0.97 }], futures: FUTURES, futuresTried: true });
  const t2 = renderTerminal(posFacts);
  for (const k of ['止损：', '减仓：', '持有：', '加仓：']) assert.ok(t2.includes(k), k);
});

test('事实层确定性：同一输入两次 JSON 完全一致', () => {
  const a = JSON.stringify(buildFacts(makeMarket(), { positions: [] }));
  const b = JSON.stringify(buildFacts(makeMarket(), { positions: [] }));
  assert.equal(a, b);
});

test('numbers 校验器自测：能抓出编造的价格，放过日期与标识符', () => {
  const facts = { price: 95000.123, pctRatio: -0.030612, label: 'MA90 在 2026-10-25 的值 95000.12' };
  assert.deepEqual(findUnverifiedNumbers('MA90 收于 95000.12，相对成本 -3.06%，4H 12/26/9，2026-10-25 14:00', facts), []);
  assert.deepEqual(findUnverifiedNumbers('目标 101234 附近', facts), ['101234']);
  assert.deepEqual(findUnverifiedNumbers('涨 1.5 倍、减 25%', facts), []);
});

test('校验器不放过价格/ATR 的 100 倍编造值，仍认百分比口径', () => {
  const facts = { atr: 1500, ratio: 0.0306, rr: 1.5 };
  assert.deepEqual(findUnverifiedNumbers('目标 150000', facts), ['150000']);
  assert.deepEqual(findUnverifiedNumbers('成本 -3.06%', facts), []);
});
