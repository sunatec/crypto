'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const S = require('../spike-detection');
const E = require('../analyze-wave-tree');
const { buildVerifiedCountTree } = require('../wave-subwave-verification');
const DAY = 86400, HOUR = 3600, BASE = Date.parse('2017-03-16T00:00:00Z') / 1000;

function days(n = 70, price = 100) {
  return Array.from({ length: n }, (_, i) => ({ timestamp: BASE + i * DAY, index: i, open: price, close: price,
    high: price + 1, low: price - 1, volume: 10 }));
}
function sample(type = 'L', price = 0.06, body = 100) {
  const candles = days(70, body);
  candles[30][type === 'L' ? 'low' : 'high'] = price;
  const candidate = S.detectSpikeCandidates(candles, { timeframe: '1d' }).find(c => c.index === 30 && c.type === type);
  assert.ok(candidate);
  return { candles, candidate };
}
function hoursFor(candidate, body, ratio, offset = 23) {
  const hours = Array.from({ length: 73 }, (_, i) => ({ timestamp: candidate.timestamp - DAY + i * HOUR,
    open: body, close: body, high: body + 1, low: body - 1, volume: 10 }));
  const hour = hours[24 + offset];
  hour[candidate.type === 'L' ? 'low' : 'high'] = candidate.originalPrice;
  hour.open = candidate.originalPrice;
  hour.volume = ratio * 10;
  return hours;
}
async function classify(f, ratio = 3.06, body = 100) {
  return S.classifySpikes([f.candidate], { candles: f.candles, product: 'TEST-USD', timeframe: '1d',
    fetchFiner: async () => hoursFor(f.candidate, body, ratio) });
}

test('结构条件与价格条件独立命中；正常长影线次日续跌不触发', () => {
  const extreme = sample();
  assert.deepEqual(extreme.candidate.conditions, ['structure', 'price']);
  assert.equal(extreme.candidate.referencePrice, 99);
  assert.equal(extreme.candidate.endTimestamp - extreme.candidate.timestamp, DAY);
  const ordinary = sample('L', 70);
  assert.deepEqual(ordinary.candidate.conditions, ['structure']);
  ordinary.candles[31].low = 60;
  assert.ok(!S.detectSpikeCandidates(ordinary.candles).some(c => c.index === 30));
  const short = days(8);
  short[3].low = 0.06;
  const c = S.detectSpikeCandidates(short)[0];
  assert.equal(c.atr, null);
  assert.deepEqual(c.conditions, ['price']);
});

test('首尾只按价格条件，阈值为严格 50%/2 倍；支持同根两侧及自然月跨度', () => {
  const candles = days(40);
  candles[0].low = 49.5;
  candles.at(-1).high = 202;
  assert.equal(S.detectSpikeCandidates(candles).length, 0);
  candles[0].low = 49;
  candles.at(-1).high = 203;
  const both = S.detectSpikeCandidates(candles, { timeframe: '1h' });
  assert.deepEqual(both.map(c => c.conditions), [['price'], ['price']]);
  assert.ok(both.every(c => c.endTimestamp - c.timestamp === HOUR));
  const f = sample();
  f.candles[30].high = 500;
  assert.deepEqual(S.detectSpikeCandidates(f.candles).filter(c => c.index === 30).map(c => c.type), ['L', 'H']);
  const monthly = [{ ...candles[0], timestamp: Date.parse('2024-02-01T00:00:00Z') / 1000 }];
  assert.equal(S.detectSpikeCandidates(monthly, { timeframe: '1m' })[0].endTimestamp, Date.parse('2024-03-01T00:00:00Z') / 1000);
});

test('小时分类取极值所在小时，排除自身的前后各 24 根中位数，传递 refresh', async () => {
  const f = sample();
  const spikes = await S.classifySpikes([f.candidate], { candles: f.candles, product: 'BTC-USD', refresh: true,
    fetchFiner: async (product, granularity, start, end, options) => {
      assert.equal(product, 'BTC-USD'); assert.equal(granularity, HOUR);
      assert.equal(start.getTime() / 1000, f.candidate.timestamp - DAY);
      assert.equal(end.getTime() / 1000, f.candidate.endTimestamp + DAY);
      assert.deepEqual(options, { refresh: true });
      const h = hoursFor(f.candidate, 100, 5);
      h[0].volume = 100000; // 不在极值小时 ±24 样本内。
      return h;
    } });
  const s = spikes[0];
  assert.equal(s.volumeRatio, 5);
  assert.equal(s.volumeSamples, 48);
  assert.equal(s.medianVolume, 10);
  assert.equal(s.classification, 'volume');
  assert.equal(s.usedTimeframe, '1h');
  assert.equal(s.volumeTimestamp, f.candidate.timestamp + 23 * HOUR);
  assert.equal(s.confidence, 'normal');
  assert.equal((await classify(f, 4.99))[0].classification, 'thin');
});

test('股票/取数失败/分页失败/无匹配极值降级至主周期 ±20；量能不足保留', async () => {
  const f = sample();
  f.candles[30].volume = 20;
  for (const fetchFiner of [async () => { throw new Error('offline'); }, async () => [], async () => Object.assign(hoursFor(f.candidate, 100, 25), { fetchErrors: [{}] })]) {
    const [s] = await S.classifySpikes([f.candidate], { candles: f.candles, product: 'BTC-USD', fetchFiner });
    assert.equal(s.usedTimeframe, '1d');
    assert.equal(s.volumeRatio, 2);
    assert.equal(s.volumeSamples, 40);
    assert.equal(s.classification, 'thin');
    assert.equal(s.confidence, 'low');
    assert.match(s.note, /仅主周期量能，置信度较低/);
    assert.ok(s.fallbackReason);
  }
  const [stock] = await S.classifySpikes([f.candidate], { candles: f.candles, isStock: true, fetchFiner: async () => { assert.fail('股票不请求小时线'); } });
  assert.equal(stock.usedTimeframe, '1d'); assert.match(stock.note, /置信度较低/);
  for (const c of f.candles) c.volume = 0;
  const [unknown] = await S.classifySpikes([f.candidate], { candles: f.candles, isStock: true });
  assert.equal(unknown.classification, 'unknown');
  assert.equal(unknown.volumeRatio, null);
  assert.equal(S.clipThinSpikes(f.candles, [unknown]).clips.length, 0);
});

test('1h/5m 使用已有主周期 ±24 根，不请求更粗的小时行情', async () => {
  const f = sample();
  for (const timeframe of ['1h', '5m']) {
    const interval = timeframe === '1h' ? HOUR : 300;
    const candles = f.candles.map((c, i) => ({ ...c, timestamp: BASE + i * interval }));
    const candidate = S.detectSpikeCandidates(candles, { timeframe })[0];
    const [s] = await S.classifySpikes([candidate], { candles, timeframe, fetchFiner: async () => { assert.fail('不应请求'); } });
    assert.equal(s.usedTimeframe, timeframe);
    assert.equal(s.volumeSamples, 48);
  }
});

test('三例合成复现：BTC 0.06/3.06 倍、ETH 74.98/1.27 倍、ETH 0.10/24.6 倍', async () => {
  for (const [type, price, body, ratio, expected] of [['L', 0.06, 1175, 3.06, 'thin'], ['H', 74.98, 48, 1.27, 'thin'], ['L', 0.10, 340, 24.6, 'volume']]) {
    const f = sample(type, price, body);
    const [s] = await classify(f, ratio, body);
    assert.ok(Math.abs(s.volumeRatio - ratio) < 1e-12);
    assert.equal(s.classification, expected);
    const clipped = S.clipThinSpikes(f.candles, [s]);
    const treated = S.markSpikeTreatment([s], clipped.clips)[0];
    assert.equal(treated.clipped, expected === 'thin');
    if (expected === 'volume') assert.match(S.formatSpike(treated), /§3.15：真实的一浪，常作为 X 连接段/);
  }
});

test('截取返回副本，保留有量扎针，小时线含开盘异常时 OHLC 与日线一致，跨度外不改', async () => {
  const f = sample();
  const [thin] = await classify(f);
  const hours = hoursFor(f.candidate, 100, 3.06);
  const snapshot = structuredClone(hours);
  const d = S.clipThinSpikes(f.candles, [thin]);
  const h = S.clipThinSpikes(hours, [thin]);
  assert.deepEqual(hours, snapshot);
  assert.notEqual(d.candles, f.candles);
  assert.equal(d.candles[30].low, thin.referencePrice);
  assert.ok(h.candles.filter(c => c.timestamp >= thin.timestamp && c.timestamp < thin.endTimestamp).every(c => c.low >= thin.referencePrice && c.open >= c.low && c.close <= c.high));
  assert.equal(h.candles[47].open, thin.referencePrice);
  assert.deepEqual(h.candles[0], hours[0]);
  assert.deepEqual(S.clipThinSpikes(hours, [{ ...thin, classification: 'volume' }]).candles, hours);
  const below = [{ ...hours[47], high: 1, close: 1 }];
  const fixed = S.clipThinSpikes(below, [thin]).candles[0];
  assert.ok(fixed.low <= fixed.high && fixed.low <= fixed.open && fixed.open <= fixed.high);
});

test('验证器 transformHourly 对已提供和新获取的小时线都生效，保留分页错误', async () => {
  const f = sample(), [thin] = await classify(f);
  const raw = Object.assign(hoursFor(f.candidate, 100, 3.06), { fetchErrors: [{ reason: 'partial' }] });
  const candles = S.clipThinSpikes(f.candles, [thin]).candles;
  const fine = E.anchorBoundaryExtremes(candles, E.detectPivots(candles, 1));
  for (const opts of [{ hourly: raw }, { fetchHourly: async () => raw }]) {
    let transforms = 0;
    const result = await buildVerifiedCountTree(E, fine, candles, { ...opts, mainTf: '1d', finestTf: '1h', maxDepth: 1,
      transformHourly: hours => { transforms++; return S.clipThinSpikes(hours, [thin]).candles; } });
    assert.equal(transforms, 1);
    assert.equal(result.hourly[47].low, 99);
    assert.deepEqual(result.hourly.fetchErrors, raw.fetchErrors);
    assert.equal(result.verifier.locate({ timestamp: thin.timestamp, type: 'L', price: 0.06 }, '1d'), null);
  }
});

test('背景共用分类：乌龙针截取，有量针原价保留，两者统一披露且输入不变', async () => {
  const f = sample(), before = structuredClone(f.candles);
  const structure = { points: [{ timestamp: BASE, price: 101 }, { timestamp: BASE + 69 * DAY, price: 99 }] };
  for (const ratio of [3.06, 24.6]) {
    const spikes = await classify(f, ratio);
    const b = E.buildHigherDegreeBackground({ daily: f.candles, listingTs: BASE, structure, spikes });
    assert.equal(b.extremes.low.price, ratio < 5 ? 99 : 0.06);
    assert.equal(b.spikes[0].clipped, ratio < 5);
    assert.equal(b.spikes[0].usedTimeframe, '1h');
    assert.match(E.renderHigherDegreeBackground(b), /所用周期 1h/);
    if (ratio >= 5) assert.match(E.renderHigherDegreeBackground(b), /真实的一浪/);
  }
  assert.deepEqual(f.candles, before);
});

test('端点依赖必须同时匹配跨度与原价；首尾与相邻两腿均点名，截后不依赖原针', () => {
  const f = sample();
  const s = { ...f.candidate, classification: 'thin' };
  const tree = { primary: { patternId: 'zigzag', points: [{ price: 101, timestamp: BASE }, { price: 0.06, timestamp: s.timestamp }, { price: 100, timestamp: s.timestamp + DAY }, { price: 80, timestamp: s.timestamp + 2 * DAY }] } };
  const dependencies = E.spikeEndpointDependencies(tree, [s]);
  assert.deepEqual(dependencies.map(d => [d.leg, d.endpoint]), [['a', '终点'], ['b', '起点']]);
  tree.primary.points[1].price = s.referencePrice;
  assert.equal(E.spikeEndpointDependencies(tree, [s]).length, 0);
});

test('无扎针：CLI 默认和忽略开关的 JSON/Markdown 一致，数法与接入前管道一致', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'spike-cli-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.resolve(__dirname, '..');
  const hook = path.join(dir, 'hook.cjs');
  await fs.writeFile(hook, `
const NativeDate=Date; global.Date=class extends NativeDate {constructor(...args){super(...(args.length?args:['2026-10-04T00:10:00Z']));}};
const raw=require(${JSON.stringify(path.join(root, 'tests/fixtures/btc-usd-1d-golden.json'))});
require(${JSON.stringify(path.join(root, 'candle-cache.js'))}).getCandles=async()=>Object.assign(raw.map(c=>({...c})),{fetchErrors:[]});
global.fetch=async()=>({ok:true,json:async()=>({quote_increment:'0.01'})});
`);
  const outputs = [];
  for (const ignore of [false, true]) {
    const out = path.join(dir, `${ignore}.json`), report = path.join(dir, `${ignore}.md`);
    await promisify(execFile)(process.execPath, ['--require', hook, path.join(root, 'analyze-wave-tree.js'), '--tf', '1d', '--start', '2025-10-05', '--end', '2026-10-03', '--verify-tf', 'off', '--background', 'off', '--out', out, '--report', report, ...(ignore ? ['--ignore-thin-spikes'] : [])], { windowsHide: true });
    const json = JSON.parse(await fs.readFile(out, 'utf8'));
    assert.deepEqual(json.spikes, []);
    assert.ok(!('spikes' in json.meta));
    const md = await fs.readFile(report, 'utf8');
    assert.ok(!md.includes('- 扎针：'));
    outputs.push({ json, md });
  }
  assert.deepEqual(outputs[0], outputs[1]);
  const raw = require('./fixtures/btc-usd-1d-golden.json').map((c, index) => ({ ...c, index }));
  const fine = E.anchorBoundaryExtremes(raw, E.detectPivots(raw, 1));
  const baseline = await buildVerifiedCountTree(E, fine, raw, { maxDepth: 5, beamK: 4, pricePrecision: 2, product: 'BTC-USD', mainTf: '1d', finestTf: 'off', endTs: Date.parse('2026-10-03') / 1000 });
  assert.deepEqual(outputs[0].json.tree, JSON.parse(JSON.stringify(E.serializeTree(baseline.tree))));
});
