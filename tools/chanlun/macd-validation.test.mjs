import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import { extractCore, extractSection } from './build-validation.mjs';
import { collectSignalQueries, generateMacdValidation, loadSignalFixtures, validateMacdCases } from './build-macd-validation.mjs';
import { segmentArea } from './signal-fixtures.mjs';

const read = relative => JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/chanlun/${relative}`, import.meta.url), 'utf8'));
const production = fs.readFileSync(new URL('../../chanlun_original.pine', import.meta.url), 'utf8');
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const near = (a, b) => (a === null ? b === null : b !== null && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)));

// Line-for-line model of the Pine module (prefix sums, binary search, recycling), used only
// to catch logic slips before the platform run. It does not stand in for the platform check.
function model({ fast, slow, signal, capacity, warmup }) {
  const state = { fast, slow, signal, capacity, warmup: warmup ?? slow + signal, seen: 0, dropped: 0, lastTime: null, ema: null, sumFast: 0, sumSlow: 0, sumSignal: 0, difCount: 0, emaFast: null, emaSlow: null, emaSignal: null, sumPos: 0, sumNeg: 0, rows: [] };
  state.peek = price => {
    const a = n => 2 / (n + 1), count = state.seen + 1, nul = value => value === null;
    const sumFast = count <= fast ? state.sumFast + price : state.sumFast, sumSlow = count <= slow ? state.sumSlow + price : state.sumSlow;
    const emaFast = count < fast ? null : count === fast ? sumFast / fast : a(fast) * price + (1 - a(fast)) * state.emaFast;
    const emaSlow = count < slow ? null : count === slow ? sumSlow / slow : a(slow) * price + (1 - a(slow)) * state.emaSlow;
    const dif = nul(emaFast) || nul(emaSlow) ? null : emaFast - emaSlow;
    const difCount = state.difCount + (nul(dif) ? 0 : 1);
    const sumSignal = !nul(dif) && difCount <= signal ? state.sumSignal + dif : state.sumSignal;
    const emaSignal = nul(dif) ? null : difCount < signal ? null : difCount === signal ? sumSignal / signal : a(signal) * dif + (1 - a(signal)) * state.emaSignal;
    return { emaFast, emaSlow, emaSignal, sumFast, sumSlow, sumSignal, difCount, dif, dea: emaSignal, hist: nul(dif) || nul(emaSignal) ? null : dif - emaSignal };
  };
  state.store = (time, dif, dea) => {
    const hist = dif === null || dea === null ? null : dif - dea;
    state.seen += 1;
    if (state.seen > state.warmup && hist !== null) {
      if (hist > 0) state.sumPos += hist;
      if (hist < 0) state.sumNeg -= hist;
      if (state.rows.length >= state.capacity) { state.rows.shift(); state.dropped += 1; }
      state.rows.push({ time, cumPos: state.sumPos, cumNeg: state.sumNeg, dif, dea });
    }
    state.lastTime = time;
  };
  state.push = (time, price) => {
    if (state.lastTime !== null && time <= state.lastTime) return false;
    const bar = state.peek(price);
    state.ema = bar;
    Object.assign(state, { emaFast: bar.emaFast, emaSlow: bar.emaSlow, emaSignal: bar.emaSignal, sumFast: bar.sumFast, sumSlow: bar.sumSlow, sumSignal: bar.sumSignal, difCount: bar.difCount });
    state.store(time, bar.dif, bar.dea);
    return true;
  };
  const index = target => { let lo = 0, hi = state.rows.length - 1, found = -1; while (lo <= hi) { const mid = Math.floor((lo + hi) / 2); if (state.rows[mid].time <= target) { found = mid; lo = mid + 1; } else hi = mid - 1; } return found; };
  state.area = (ts, te, direction) => {
    const none = reason => ({ available: false, reason, area: null, bars: 0, difExtreme: null, deaExtreme: null });
    if (te < ts) return none('bad-range');
    if (state.rows.length === 0) return none('warmup');
    if (ts < state.rows[0].time) return none(state.dropped > 0 ? 'recycled' : 'before-start');
    if (te > state.lastTime) return none('not-closed');
    const s = index(ts), e = index(te), key = direction === 1 ? 'cumPos' : 'cumNeg';
    const out = { available: true, reason: 'ok', area: state.rows[e][key] - state.rows[s][key], bars: e - s, difExtreme: null, deaExtreme: null };
    if (e > s) {
      const span = state.rows.slice(s + 1, e + 1), pick = direction === 1 ? Math.max : Math.min;
      out.difExtreme = pick(...span.map(r => r.dif)); out.deaExtreme = pick(...span.map(r => r.dea));
    }
    return out;
  };
  return state;
}

test('hand-derived MACD cases are internally consistent and rejected when malformed', () => {
  const data = validateMacdCases(read('macd/cases.json'));
  assert.equal(data.areas.length, 4);
  for (const mutate of [
    d => { d.areas[0].queries[0].reason = 'before-start'; },
    d => { d.areas[0].bars[1][0] = 500; },
    d => { d.ema.expected.pop(); },
    d => { d.areas[0].queries[0].direction = 0; },
    d => { d.areas[0].queries[6].difExtreme = 1; },
    d => { d.areas[1].config.warmup = -1; }
  ]) { const copy = read('macd/cases.json'); mutate(copy); assert.throws(() => validateMacdCases(copy)); }
});

test('the EMA expectations follow the platform ta.ema: na before length, SMA seed, then recursion', () => {
  const { ema } = read('macd/cases.json');
  const state = model({ ...ema.config, capacity: 10 });
  ema.closes.forEach(([time, close], i) => {
    const bar = state.peek(close), [dif, dea] = ema.expected[i];
    assert(near(bar.dif, dif) && near(bar.dea, dea), `bar ${i + 1}`);
    assert.equal(bar.hist === null, dif === null || dea === null);
    assert(state.push(time, close));
    assert(!state.push(time, close + 1) && !state.push(time - 1, close));
  });
  assert.equal(state.rows.length, ema.expectStored);
  // Independent exact fractions: dif = -, -, -1/6, 1/18, 11/27, 53/324 and dea = -, -, -, -1/18, 41/162, 47/243.
  const exact = [[1 / 18, -1 / 18], [11 / 27, 41 / 162], [53 / 324, 47 / 243]];
  exact.forEach(([d, e], i) => assert(near(state.rows[i].dif, d) && near(state.rows[i].dea, e)));
  // Platform fact (TradingView, BTCUSDT 1h, 2026-11-12): the first valid index of macd/signal/hist for 12/26/9.
  const real = model({ fast: 12, slow: 26, signal: 9, capacity: 1000 });
  const first = { dif: null, dea: null, hist: null };
  for (let i = 0; i < 60; i++) { const b = real.peek(100 + (i * 7) % 13); for (const k of ['dif', 'dea', 'hist']) if (first[k] === null && b[k] !== null) first[k] = i; real.push(1000 * (i + 1), 100 + (i * 7) % 13); }
  assert.deepEqual(first, { dif: 25, dea: 33, hist: 33 });
});

test('the module model reproduces every hand-derived area case', () => {
  for (const area of read('macd/cases.json').areas) {
    const state = model(area.config);
    for (const [time, dif, dea] of area.bars) state.store(time, dif, dea);
    assert.equal(state.rows.length, area.expectSize, area.id); assert.equal(state.dropped, area.expectDropped, area.id);
    area.queries.forEach((query, i) => {
      const got = state.area(query.ts, query.te, query.direction), label = `${area.id}/${i + 1}`;
      assert.equal(got.available, query.available, label); assert.equal(got.reason, query.reason, label); assert.equal(got.bars, query.bars, label);
      assert(near(got.area, query.area) && near(got.difExtreme, query.difExtreme) && near(got.deaExtreme, query.deaExtreme), label);
    });
  }
});

test('signal samples: queries match the checker area, at the closing bar and at the end', () => {
  const fixtures = loadSignalFixtures();
  assert.equal(fixtures.length, 19);
  let queries = 0;
  for (const fixture of fixtures) {
    const { fast, slow, signal, warmupBars } = fixture.input.macd, bars = fixture.input.bars;
    for (const query of collectSignalQueries(fixture)) {
      queries += 1;
      const direction = query.direction === 1 ? 'up' : 'down';
      const checker = segmentArea(bars, warmupBars, query.ts, query.te, direction);
      assert.equal(checker, query.area, fixture.id);
      const state = model({ fast, slow, signal, capacity: bars.length + 1, warmup: warmupBars });
      let early = null;
      for (const bar of bars) {
        state.store(bar.time, bar.dif, bar.dea);
        if (early === null && bar.time >= query.te) early = state.area(query.ts, query.te, query.direction);
      }
      const final = state.area(query.ts, query.te, query.direction);
      assert.equal(final.available, query.area !== null, `${fixture.id} availability`);
      assert(near(final.area, query.area), `${fixture.id} final`);
      assert(near(early.area, query.area), `${fixture.id} closing bar`);
    }
  }
  assert(queries >= 26);
});

test('the prefix-sum model agrees with a plain scan on random data, including recycling', () => {
  let seed = 7;
  const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
  const warmup = 10, capacity = 40, times = [], hist = [];
  const state = model({ fast: 3, slow: 6, signal: 4, capacity, warmup });
  for (let i = 0; i < 200; i++) {
    const time = 1000 * (i + 1), close = 100 + (next() % 2000) / 50;
    state.push(time, close);
    times.push(time); hist.push(state.ema.hist);
  }
  assert.equal(state.dropped, 200 - warmup - capacity);
  const keptFrom = Math.max(warmup, 200 - capacity);
  for (let probe = 0; probe < 500; probe++) {
    const a = next() % 200, b = next() % 200, lo = Math.min(a, b), hi = Math.max(a, b);
    const ts = times[lo] + (probe % 2), te = times[hi] + (probe % 3 === 0 ? 1 : 0), direction = probe % 2 ? 1 : -1;
    let expected = 0;
    for (let k = 0; k < 200; k++) if (times[k] > ts && times[k] <= te && (direction === 1 ? hist[k] > 0 : hist[k] < 0)) expected += Math.abs(hist[k]);
    const got = state.area(ts, te, direction);
    const available = te >= ts && ts >= times[keptFrom] && te <= times.at(-1);
    assert.equal(got.available, available, `probe ${probe}`);
    if (available) assert(Math.abs(got.area - expected) <= 1e-9 * Math.max(1, expected), `probe ${probe}`);
  }
});

test('generated validation script uses the production SIGNALS section and leaves the CORE untouched', () => {
  const data = read('macd/cases.json'), before = JSON.stringify(data);
  const result = generateMacdValidation(production, data, loadSignalFixtures());
  assert.equal(JSON.stringify(data), before);
  assert.equal(result.sectionHash, sha(extractSection(production, 'SIGNALS')));
  assert(result.source.includes(extractSection(production, 'SIGNALS')));
  assert.equal(result.coreHash, sha(extractCore(production)));
  // CORE hash of the shipped pattern engine before this change; any difference must be a deliberate, read-only interface.
  assert.equal(result.coreHash, '7bea4f3a789c862e6beaa3ea2f21e60843f21b52c13cc4e7f9a7db61ba5479d0');
  assert.equal(result.staticQueries, 22);
  const withQueries = loadSignalFixtures().filter(f => collectSignalQueries(f).length > 0);
  assert.equal(result.cases, 1 + 4 + withQueries.length); assert.equal(result.fixtureQueries, 26);
  assert.equal(result.fixtureBars, withQueries.reduce((sum, f) => sum + f.input.bars.length, 0));
  for (const label of ['peek-immutable', 'duplicate-rejected', 'rejected-no-change', 'at-close', 'should-be-unavailable', 'LIVE/na-pattern', 'LIVE/dropped count', 'LIVE/probe mix', 'ta.macd(close, 12, 26, 9)', 'PASS: MACD']) assert(result.source.includes(label), label);
  assert(!result.source.includes('BEGIN CHANLUN CORE'));
  assert(result.bytes < 110000);
});

test('the SIGNALS section never indexes history by bar_index and the chart only feeds closed bars', () => {
  const section = extractSection(production, 'SIGNALS').split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  assert(!section.includes('bar_index'));
  assert(!/\w\[[^\]]+\]/.test(section.replace(/array<[^>]+>/g, '')));
  const chart = production.slice(production.indexOf('// ==================== Chart scheduling'));
  assert(/if (?:signalsOn and )?barstate\.isconfirmed\r?\n\s+chan_macd_push\(macd, time, close\)/.test(chart));
  assert(chart.indexOf('chan_macd_push(macd, time, close)') > chart.indexOf('if supported and inRange'));
  assert(chart.includes('var ChanMacd macd = chan_macd_new(macdFast, macdSlow, macdSignal, fixedStart ? sampleLimit : 2 * initialBars)'));
});

test('every chan_ function in the generated script is defined before its first use (Pine has no hoisting)', () => {
  const { source } = generateMacdValidation(production, read('macd/cases.json'), loadSignalFixtures());
  const lines = source.split('\n');
  const defined = new Map();
  lines.forEach((line, i) => { const m = /^(chan_\w+)\(/.exec(line); if (m && !defined.has(m[1])) defined.set(m[1], i); });
  assert(defined.size > 15);
  lines.forEach((line, i) => {
    if (line.trim().startsWith('//')) return;
    for (const m of line.matchAll(/\b(chan_\w+)\(/g)) {
      if (!defined.has(m[1])) continue;
      assert(defined.get(m[1]) <= i, `${m[1]} used on line ${i + 1} before its definition on line ${defined.get(m[1]) + 1}`);
    }
  });
});

test('no Pine string literal in the generated script is split across lines', () => {
  const { source } = generateMacdValidation(production, read('macd/cases.json'), loadSignalFixtures());
  source.split('\n').forEach((line, i) => {
    if (line.trim().startsWith('//')) return;
    const quotes = (line.match(/(?<!\\)"/g) ?? []).length;
    assert.equal(quotes % 2, 0, `line ${i + 1} has an unterminated string literal`);
  });
});
