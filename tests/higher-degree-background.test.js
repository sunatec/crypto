'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../analyze-wave-tree');
const { getCandles } = require('../candle-cache');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);

const DAY = 86400;
const MONDAY = Date.parse('2020-01-06T00:00:00Z') / 1000;
function fixture(prices, s = 220, e = 60) {
  const daily = prices.flatMap((price, i) => Array.from({ length: 7 }, (_, d) => ({
    timestamp: MONDAY + (i * 7 + d) * DAY, open: price, high: price, low: price, close: price, volume: 1,
  })));
  const S = { timestamp: MONDAY + prices.length * 7 * DAY, price: s, type: s > e ? 'H' : 'L', index: daily.length };
  const end = { timestamp: S.timestamp + 7 * DAY, price: e, type: s > e ? 'L' : 'H', index: daily.length + 7 };
  daily.push({ timestamp: S.timestamp, open: s, high: s, low: s, close: s, volume: 1 },
    { timestamp: end.timestamp, open: e, high: e, low: e, close: e, volume: 1 });
  return { daily, listingTs: daily[0].timestamp, structure: { points: [S, end], direction: s > e ? 'down' : 'up' } };
}
const starts = b => b.ladder.filter(l => !l.zero).map(l => l.start.price);
const calculate = f => E.buildHigherDegreeBackground(f);

test('聚合使用 UTC 周/月，上市开盘、历史极值精确到日，月线全量保存', () => {
  const f = fixture([10, 100, 20, 120, 25, 130, 40, 150, 50, 200]);
  const b = calculate(f);
  assert.equal(b.available, true);
  assert.deepEqual(b.listing, { timestamp: MONDAY, price: 10 });
  assert.deepEqual(b.extremes.high, { timestamp: f.structure.points[0].timestamp, price: 220 });
  assert.deepEqual(b.extremes.low, { timestamp: MONDAY, price: 10 });
  assert.equal(b.startPosition.isHistoricalExtreme, true);
  const monthly = calculate(fixture([100, 20, 200, 30, 300].flatMap(p => Array(6).fill(p)), 320, 80));
  assert.ok(monthly.monthlySwings.length > 0);
  assert.ok(monthly.monthlySwings.some(p => p.price === 20 && p.type === 'L'));
  assert.deepEqual(E.transformCandles(f.daily, E.TIMEFRAMES['1w']).slice(0, 10).map(c => c.open), [10, 100, 20, 120, 25, 130, 40, 150, 50, 200]);
});

test('阶梯逐级更深；内部最大回撤任一口径增大才升级；0 级最高', () => {
  const b = calculate(fixture([10, 100, 20, 120, 25, 130, 40, 150, 50, 200]));
  assert.deepEqual(starts(b), [50, 40, 25, 20, 10]);
  assert.equal(b.ladder.at(-1).zero, true);
  assert.equal(b.ladder.at(-1).start.price, 0);
  assert.equal(b.ladder.at(-1).start.timestamp, MONDAY - DAY);
  assert.equal(b.ladder.at(-1).amplitude.percentage, null);
  assert.equal(b.ladder.at(-1).retrace.percentage, null);
  assert.equal(b.ladder.at(-1).retrace.absolute, 160 / 220);
  assert.equal(b.ladder.at(-1).maxInternalRetrace.percentage.ratio, 0.8);
});

test('同级取最深起点，排除被窗口完全回撤和相等的前段', () => {
  const b = calculate(fixture([10, 30, 12, 40, 15, 50, 20, 200, 60, 300, 80, 310, 90, 315], 320, 80));
  assert.deepEqual(starts(calculate(fixture([10, 30, 12, 40, 15, 50, 20, 200, 60, 300], 320, 80))), [60, 10]);
  assert.deepEqual(starts(b), [10]);
  assert.ok(b.ladder.every(l => l.start.price < 80));
});

test('两口径数字可复核，结论一致与不一致均披露；等于最大回撤不算超过', () => {
  const b = calculate(fixture([10, 100, 20, 120, 25, 130, 40, 150, 50, 200]));
  const l = b.ladder.find(l => l.start.price === 20);
  assert.equal(l.amplitude.absolute, 200);
  assert.equal(l.amplitude.percentage, 10);
  assert.equal(l.retrace.absolute, 0.8);
  assert.equal(l.retrace.percentage, Math.log(220 / 60) / Math.log(220 / 20));
  assert.deepEqual(l.maxInternalRetrace.absolute, { depth: 100, from: 150, to: 50 });
  assert.equal(l.maxInternalRetrace.percentage.ratio, 95 / 120);
  assert.equal(l.section33.absoluteExceeds, true);
  assert.equal(l.section33.percentageExceeds, false);
  assert.equal(l.section33.consistent, false);
  assert.match(l.section33.conclusion, /口径不一致，书未规定口径/);
  assert.match(b.ladder[1].section33.conclusion, /可假设这段上涨已结束/);
  const equal = calculate(fixture([10, 100, 20, 120, 25, 130, 40, 150, 50, 200], 220, 120));
  assert.equal(equal.ladder.find(l => l.start.price === 20).section33.absoluteExceeds, false);
});

test('上涨结构镜像：逐级更高前段，价差与百分比同时计算，省略价格 0', () => {
  const b = calculate(fixture([10, 100, 20, 120, 25, 130, 40, 150, 50, 200].map(p => 400 - p), 180, 340));
  assert.equal(b.startPosition.extremeType, 'low');
  assert.equal(b.startPosition.isHistoricalExtreme, true);
  assert.ok(b.ladder.length > 1);
  assert.equal(b.ladder.some(l => l.zero), false);
  assert.equal(starts(b)[0], 350);
  assert.ok(starts(b).every((p, i, a) => p > 340 && (!i || p > a[i - 1])));
  const first = b.ladder[0];
  assert.equal(first.amplitude.absolute, 170);
  assert.equal(first.amplitude.percentage, 170 / 350);
  assert.equal(first.retrace.percentage, Math.log(180 / 340) / Math.log(180 / 350));
});

test('S 所在整周的窗口外高价不能替换 S 或参与内部回撤', () => {
  const f = fixture([10, 100, 20, 120, 25, 130, 40, 150, 50, 200]);
  const original = calculate(f);
  const s = f.structure.points[0];
  // S 改为周二，周一另有更高价：原始结构起点仍是 S。
  s.timestamp += DAY;
  f.daily[f.daily.length - 2].timestamp = s.timestamp;
  f.daily.push({ timestamp: s.timestamp - DAY, open: 1000, high: 1000, low: 1000, close: 1000, volume: 1 });
  const b = calculate(f);
  assert.equal(b.extremes.high.price, 1000);
  assert.equal(b.startPosition.isHistoricalExtreme, false);
  assert.equal(b.startPosition.distancePercentage, 0.78);
  assert.deepEqual(starts(b), starts(original));
  assert.ok(b.ladder.every(l => l.end.price === 220));
  assert.deepEqual(b.ladder.map(l => l.maxInternalRetrace), original.ladder.map(l => l.maxInternalRetrace));
});

test('级数上限为 8，保留价格 0 并记录省略数', () => {
  const prices = [];
  for (let i = 1; i <= 12; i++) prices.push(i * 10, 1000 - i * 50);
  const b = calculate(fixture(prices, 1100, 200));
  assert.equal(b.ladder.length, 8);
  assert.equal(b.ladder.at(-1).zero, true);
  assert.ok(b.omittedLevels > 0);
  assert.match(E.renderHigherDegreeBackground(b), new RegExp(`省略 ${b.omittedLevels} 级`));
});

test('0.06 型低点截取披露；输入不变，价格阈值边界可由结构条件命中', () => {
  const f = fixture(Array(12).fill(1175), 1300, 1200);
  Object.assign(f.daily[20], { open: 1173.13, close: 1178.85, low: 0.06, high: 1180 });
  Object.assign(f.daily[35], { high: 10000 });
  f.daily[45].low = 1175 * 0.7;
  f.daily[55].low = 1175 * 0.5;
  f.daily[65].high = 1175 * 2;
  const snapshot = structuredClone(f);
  const b = calculate(f);
  assert.deepEqual(f, snapshot);
  assert.deepEqual(b.spikes.map(p => [p.type, p.originalPrice, p.adjustedPrice]), [['L', 0.06, 1173.13], ['H', 10000, 1175], ['L', 587.5, 1175], ['H', 2350, 1175]]);
  assert.ok(b.spikes.slice(2).every(s => s.conditions.join(',') === 'structure'));
  assert.ok(b.spikes.every(s => s.classification === 'thin' && s.clipped && s.confidence === 'low'));
  assert.notEqual(b.extremes.low.price, 0.06);
  assert.ok(!starts(b).includes(0.06));
  assert.match(E.renderHigherDegreeBackground(b), /0.06 → 1173.13/);
});

test('全部历史加载传递 refresh；开关关闭、股票不取数；取数和发现失败不阻断', async () => {
  const f = fixture([10, 30, 12, 40, 15, 50, 20, 200, 60, 300], 320, 80);
  let calls = 0;
  const fetcher = async (...args) => {
    calls++;
    assert.deepEqual(args, ['BTC-USD', 86400, 'all', '2026-01-01', { refresh: true }]);
    return Object.assign(f.daily, { listingTs: f.listingTs, fetchErrors: [] });
  };
  const args = { product: 'BTC-USD', source: 'coinbase', end: '2026-01-01', refresh: true, structure: f.structure };
  assert.equal((await E.loadHigherDegreeBackground(args, fetcher)).available, true);
  assert.equal((await E.loadHigherDegreeBackground({ ...args, mode: 'off' }, fetcher)).available, false);
  assert.equal((await E.loadHigherDegreeBackground({ ...args, isStock: true }, fetcher)).available, false);
  assert.equal(calls, 1);
  assert.match((await E.loadHigherDegreeBackground(args, async () => { throw new Error('offline'); })).reason, /offline/);
  assert.match((await E.loadHigherDegreeBackground(args, async () => Object.assign(f.daily, { listingTs: null }))).reason, /上市首日/);
  assert.match(calculate({ ...f, daily: Object.assign(f.daily, { fetchErrors: [{ reason: 'page failed' }] }) }).reason, /page failed/);
});

let goldenTree;
function reportFixture() {
  if (!goldenTree) {
    const candles = require('./fixtures/btc-usd-1d-golden.json').map((c, i) => ({ ...c, index: i }));
    goldenTree = E.buildCountTree(E.anchorBoundaryExtremes(candles, E.detectPivots(candles, 1)), candles, { maxDepth: 5, beamK: 3 });
  }
  return { tree: goldenTree, meta: { product: 'BTC-USD', timeframe: '1d', startUtc: '2025-10-05T00:00:00Z', endUtc: '2026-10-03T00:00:00Z', generatedAtUtc: '2026-10-04T00:00:00Z', rangeHigh: 126296, rangeLow: 57717.55, sampleCount: 314 } };
}

test('报告范围、轴①背景、不可用原因，已验证父级首位仍标为暂定；父级 JSON 不变', () => {
  const { meta, tree } = reportFixture();
  const before = E.serializeMultiDegree(tree, '1d');
  const background = calculate(fixture([10, 100, 20, 120, 25, 130, 40, 150, 50, 200]));
  const md = E.renderMarkdownReport(meta, tree, null, { background });
  assert.match(md, /数浪范围：从 2025-10-05 起按日线数浪，起点为窗口内极值 126296/);
  assert.match(md, /未按 §3.10\/§3.12 自上而下数浪，父级身份为推断/);
  assert.ok(md.indexOf('数浪范围') < md.indexOf('<details>'));
  assert.ok(md.indexOf('## 大级别背景') > md.indexOf('## 在更大结构里的角色'));
  assert.ok(md.indexOf('## 大级别背景') < md.indexOf('# 轴②'));
  assert.match(md, /大级别背景见轴①/);
  assert.match(md, /口径不一致/);
  const verified = { ...tree, primary: { ...tree.primary, score: { ...tree.primary.score, verificationStatus: 'verified' } } };
  const pd = E.deriveParentDegree(verified);
  assert.equal(pd.primary.verificationStatus, 'verified');
  const parent = E.renderParentRole(verified, 2, background);
  assert.match(parent, /⏳ 暂定主选（未经大级别数浪验证）/);
  assert.ok(!parent.includes('✅ 主选'));
  assert.deepEqual(E.serializeMultiDegree(tree, '1d'), before);
  const failed = E.renderMarkdownReport(meta, tree, null, { background: { available: false, reason: '网络超时' } });
  assert.match(failed, /大级别背景不可用：网络超时/);
  const stock = E.buildWaveScope({ ...meta, product: 'MU' }, tree, { available: false, reason: '股票本次未生成大级别背景' });
  assert.match(stock.note, /股票本次未生成大级别背景/);
  assert.equal(stock.topDown, false);
});

test('同一输入背景 on/off/取数失败：完整 CLI 的既有 JSON 与报告正文一致（离线）', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wave-background-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.resolve(__dirname, '..');
  const hook = path.join(directory, 'hook.cjs');
  await fs.writeFile(hook, `
const NativeDate = Date;
global.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : ['2026-10-04T00:00:00Z'])); } };
const cache = require(${JSON.stringify(path.join(root, 'candle-cache.js'))});
const raw = require(${JSON.stringify(path.join(root, 'tests/fixtures/btc-usd-1d-golden.json'))});
cache.getCandles = async (product, granularity, start, end) => {
  if (start === 'all' && process.env.BACKGROUND_FAIL === 'yes') throw new Error('simulated background network failure');
  return Object.assign(raw.map(c => ({...c})), { fetchErrors: [], listingTs: raw[0].timestamp });
};
global.fetch = async () => ({ok:true, json:async () => ({quote_increment:'0.01'})});
`);
  const results = [];
  for (const mode of ['on', 'off', 'failed']) {
    const out = path.join(directory, `${mode}.json`), report = path.join(directory, `${mode}.md`);
    await exec(process.execPath, ['--require', hook, path.join(root, 'analyze-wave-tree.js'), '--product', 'BTC-USD', '--tf', '1d', '--start', '2025-10-05', '--end', '2026-10-03', '--verify-tf', 'off', '--background', mode === 'failed' ? 'on' : mode, '--out', out, '--report', report], { windowsHide: true, env: { ...process.env, BACKGROUND_FAIL: mode === 'failed' ? 'yes' : 'no' } });
    const json = JSON.parse(await fs.readFile(out, 'utf8'));
    assert.equal(json.scope.topDown, false);
    assert.equal(json.background.available, mode === 'on');
    if (mode === 'failed') assert.match(json.background.reason, /simulated background network failure/);
    delete json.scope;
    delete json.background;
    const md = (await fs.readFile(report, 'utf8'))
      .replace(/^> 数浪范围：.*\n/gm, '')
      .replace(/^大级别背景(?:不可用|：).*\n/gm, '')
      .replace(/## 大级别背景（周线\/月线）[\s\S]*?(?=\n---\n)/, '')
      .replace(/\n{3,}/g, '\n\n');
    results.push({ json, md });
  }
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[0], results[2]);
});

test('缓存返回已确认上市首日，全历史第二次零请求', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'background-cache-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const f = fixture([10, 20, 15]);
  let calls = 0;
  const transport = async (_, __, from, to) => { calls++; return f.daily.filter(c => c.timestamp >= from.getTime() / 1000 && c.timestamp < to.getTime() / 1000); };
  const args = ['BTC-USD', DAY, 'all', f.daily.at(-1).timestamp, { cacheDir: directory, transport, now: f.daily.at(-1).timestamp + 3 * DAY }];
  const first = await getCandles(...args);
  assert.equal(first.listingTs, MONDAY);
  assert.ok(calls > 0);
  calls = 0;
  const second = await getCandles(...args);
  assert.deepEqual(second, first);
  assert.equal(calls, 0);
});

test('数浪范围的日期与报告元信息同一时区（UTC+8 / 交易所时区）', () => {
  const { meta, tree } = reportFixture();
  // --start 2025-10-05T00:00:00+08:00 → startUtc 为前一天 16:00Z，报告须写 2025-10-05
  const md = E.renderMarkdownReport({ ...meta, market: 'crypto', startUtc: '2025-10-04T16:00:00.000Z' }, tree, null, { background: { available: false, reason: 'x' } });
  assert.match(md, /时间范围（UTC\+8）：2025-10-05 00:00:00/);
  assert.match(md, /数浪范围：从 2025-10-05 起按日线数浪/);
  assert.match(md, /S @ 2025-10-06/);
  // 日内周期显示到分钟
  assert.equal(E.scopeTime('2026-03-01T05:00:00.000Z', { timeframe: '1h', market: 'crypto' }, 'bar'), '2026-03-01 13:00');
  // 美股：区间起点按美东，K 线时间戳即交易日
  assert.equal(E.scopeTime('2026-03-02T03:00:00.000Z', { timeframe: '1d', market: 'us' }, 'window'), '2026-03-01');
  assert.equal(E.scopeTime('2026-03-02T00:00:00.000Z', { timeframe: '1d', market: 'us' }, 'bar'), '2026-03-02');
});
