import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractCore, extractSection } from './build-validation.mjs';

// Shared-section validation for the MACD prefix-sum module (tasks 3.1/3.2).
// Expected values come from hand-derived cases and from the independent signal samples,
// never from the Pine implementation. The generated script also compares the module with
// the built-in ta.macd on whatever chart it is loaded on; that part can only run on the platform.
const root = new URL('../../', import.meta.url);
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const q = JSON.stringify;
const num = value => (value === null ? 'na' : Number.isInteger(value) ? `${value}.0` : String(value));
const isNumber = value => typeof value === 'number' && Number.isFinite(value);

export const liveSeeds = { minBars: 150, queries: 120, capacity: 1000 };

export function validateMacdCases(data) {
  assert.equal(data.schemaVersion, 1);
  assert(data.note && data.ema && data.areas.length > 0);
  const { fast, slow, signal } = data.ema.config;
  assert([fast, slow, signal].every(Number.isSafeInteger) && fast >= 1 && slow > fast && signal >= 1);
  assert.equal(data.ema.closes.length, data.ema.expected.length);
  let last = -1;
  for (const [time, close] of data.ema.closes) {
    assert(Number.isSafeInteger(time) && time > last && isNumber(close));
    last = time;
  }
  data.ema.expected.forEach(pair => assert(pair.length === 2 && pair.every(value => value === null || isNumber(value))));
  assert(Number.isSafeInteger(data.ema.config.warmup) && Number.isSafeInteger(data.ema.expectStored));
  const ids = new Set();
  for (const area of data.areas) {
    assert(!ids.has(area.id)); ids.add(area.id);
    const c = area.config;
    assert(c.slow > c.fast && c.fast >= 1 && c.signal >= 1 && Number.isSafeInteger(c.warmup) && c.warmup >= 0 && c.capacity >= 1);
    let previous = -1;
    for (const [time, dif, dea] of area.bars) { assert(Number.isSafeInteger(time) && time > previous && isNumber(dif) && isNumber(dea)); previous = time; }
    assert(Number.isSafeInteger(area.expectSize) && Number.isSafeInteger(area.expectDropped));
    assert(area.queries.length > 0);
    for (const query of area.queries) {
      assert(Number.isSafeInteger(query.ts) && Number.isSafeInteger(query.te) && [1, -1].includes(query.direction));
      assert.equal(typeof query.available, 'boolean'); assert.equal(typeof query.reason, 'string');
      assert.equal(query.available, query.reason === 'ok');
      if (query.available) assert(isNumber(query.area) && Number.isSafeInteger(query.bars) && query.bars >= 0);
      else assert(query.area === null && query.bars === 0);
      assert.equal(query.bars === 0, query.difExtreme === null && query.deaExtreme === null);
    }
  }
  return data;
}

// Every (A, C) segment of the independent signal samples becomes a prefix-sum query.
export function collectSignalQueries(fixture) {
  const times = fixture.input.bars.map(bar => bar.time);
  const seen = new Map();
  for (const snapshot of fixture.expected) {
    for (const entry of [...snapshot.signals, ...snapshot.suppressed]) {
      if (!entry.comparison) continue;
      for (const key of ['a', 'c']) {
        const segment = entry.comparison[key];
        assert(times.includes(segment.startTime) && times.includes(segment.endTime), `${fixture.id}: segment off the bar grid`);
        const id = `${segment.startTime}/${segment.endTime}/${segment.direction}`;
        if (seen.has(id)) assert.equal(seen.get(id).area, segment.areaUnits, `${fixture.id}: conflicting area for ${id}`);
        else seen.set(id, { ts: segment.startTime, te: segment.endTime, direction: segment.direction === 'up' ? 1 : -1, area: segment.areaUnits });
      }
    }
  }
  return [...seen.values()];
}

function areaCase(area, index) {
  const lines = [`chan_ma_area_case_${index}() =>`, `    ChanMacd state = chan_macd_new(${area.config.fast}, ${area.config.slow}, ${area.config.signal}, ${area.config.capacity})`, `    state.warmup := ${area.config.warmup}`];
  for (const [time, dif, dea] of area.bars) lines.push(`    chan_macd_store(state, ${time}, ${num(dif)}, ${num(dea)})`);
  lines.push(`    chan_ma_assert(state.times.size() == ${area.expectSize} and state.dropped == ${area.expectDropped}, ${q(area.id + '/retention')})`);
  area.queries.forEach((query, i) => lines.push(`    chan_ma_query(state, ${query.ts}, ${query.te}, ${query.direction}, ${query.available}, ${q(query.reason)}, ${num(query.area)}, ${query.bars}, ${num(query.difExtreme)}, ${num(query.deaExtreme)}, ${q(`${area.id}/query-${i + 1}`)})`));
  lines.push('    true', '');
  return lines;
}

const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));

// Compact encoding keeps the script small enough to paste: bars are "k,dif,dea" with time = base + k * step,
// segments are "tsPosition,tePosition,direction,area" (positions are bar positions, area na = unavailable).
function fixtureCase(fixture) {
  const { fast, slow, signal, warmupBars } = fixture.input.macd, bars = fixture.input.bars;
  for (const bar of bars) assert(Math.abs(bar.hist - (bar.dif - bar.dea)) < 1e-9, `${fixture.id}: hist must equal dif-dea`);
  const queries = collectSignalQueries(fixture);
  if (queries.length === 0) return null;
  const base = bars[0].time;
  const step = bars.slice(1).reduce((value, bar) => gcd(value, bar.time - base), 0) || 1;
  const position = time => bars.findIndex(bar => bar.time === time);
  const text = value => { assert(/^-?\d+(\.\d+)?$/.test(String(value)), `${fixture.id}: ${value} is not plain decimal`); return String(value); };
  const barsText = bars.map(bar => `${(bar.time - base) / step},${text(bar.dif)},${text(bar.dea)}`).join(';');
  const queryText = queries.map(query => `${position(query.ts)},${position(query.te)},${query.direction},${query.area === null ? 'na' : text(query.area)}`).join(';');
  assert(queries.every(query => query.te <= bars.at(-1).time));
  return { call: `    chan_ma_fixture_run(${q(fixture.id)}, ${fast}, ${slow}, ${signal}, ${warmupBars}, ${base}, ${step}, ${q(barsText)}, ${q(queryText)})`, queries: queries.length, bars: bars.length };
}

function emaCase(ema) {
  const { fast, slow, signal, warmup } = ema.config;
  const lines = ['chan_ma_ema_case() =>', `    ChanMacd state = chan_macd_new(${fast}, ${slow}, ${signal}, 10)`, `    state.warmup := ${warmup}`];
  ema.closes.forEach(([time, close], i) => {
    const [dif, dea] = ema.expected[i];
    const hist = dif === null || dea === null ? null : dif - dea;
    const context = q(`EMA/bar-${i + 1}`);
    lines.push(`    string before${i} = chan_macd_signature(state)`,
      `    ChanMacdBar peek${i} = chan_macd_peek(state, ${num(close)})`,
      `    chan_ma_assert(chan_macd_signature(state) == before${i}, ${context} + "/peek-immutable")`,
      `    chan_ma_assert(chan_ma_near(peek${i}.dif, ${num(dif)}) and chan_ma_near(peek${i}.dea, ${num(dea)}) and chan_ma_near(peek${i}.hist, ${num(hist)}), ${context} + "/values dif=" + str.tostring(peek${i}.dif) + " dea=" + str.tostring(peek${i}.dea))`,
      `    chan_ma_assert(chan_macd_push(state, ${time}, ${num(close)}), ${context} + "/accepted")`,
      `    string after${i} = chan_macd_signature(state)`,
      `    chan_ma_assert(not chan_macd_push(state, ${time}, ${num(close + 1)}), ${context} + "/duplicate-rejected")`,
      `    chan_ma_assert(not chan_macd_push(state, ${time - 1}, ${num(close + 1)}), ${context} + "/older-rejected")`,
      `    chan_ma_assert(chan_macd_signature(state) == after${i}, ${context} + "/rejected-no-change")`);
  });
  lines.push(`    chan_ma_assert(state.times.size() == ${ema.expectStored}, "EMA/stored")`, '    true', '');
  return lines;
}

const helpers = `
chan_ma_assert(bool value, string context) =>
    if not value
        runtime.error("FAIL: " + context)
    true
chan_ma_near(float actual, float expected) =>
    na(expected) ? na(actual) : (not na(actual) and math.abs(actual - expected) <= 1e-9 * math.max(1.0, math.abs(expected)))
chan_ma_query(ChanMacd state, int ts, int te, int direction, bool available, string reason, float area, int bars, float difExtreme, float deaExtreme, string context) =>
    ChanMacdArea r = chan_macd_area(state, ts, te, direction)
    chan_ma_assert(r.available == available, context + "/available actual=" + str.tostring(r.available) + " reason=" + r.reason)
    chan_ma_assert(r.reason == reason, context + "/reason actual=" + r.reason)
    chan_ma_assert(chan_ma_near(r.area, area), context + "/area actual=" + str.tostring(r.area) + " expected=" + str.tostring(area))
    chan_ma_assert(r.bars == bars, context + "/bars actual=" + str.tostring(r.bars))
    chan_ma_assert(chan_ma_near(r.difExtreme, difExtreme) and chan_ma_near(r.deaExtreme, deaExtreme), context + "/extremes")
    chan_ma_assert(r.fast == state.fast and r.slow == state.slow and r.signal == state.signal, context + "/params")
    true
// A signal-sample segment: a number is the area the sample records, na means "area unavailable".
chan_ma_fixture_query(ChanMacd state, int ts, int te, int direction, float area, string context) =>
    ChanMacdArea r = chan_macd_area(state, ts, te, direction)
    if na(area)
        chan_ma_assert(not r.available and r.reason != "ok" and na(r.area), context + "/should-be-unavailable reason=" + r.reason)
    else
        chan_ma_assert(r.available and chan_ma_near(r.area, area), context + "/area actual=" + str.tostring(r.area) + " expected=" + str.tostring(area))
    true
// Signal sample driver: store every bar, ask each segment right after its closing bar (prefix sums are
// append-only, so that answer must already be final), then ask again after the last bar.
chan_ma_fixture_run(string id, int fast, int slow, int signal, int warmup, int base, int step, string barsText, string queryText) =>
    array<string> rows = str.split(barsText, ";")
    array<string> segments = str.split(queryText, ";")
    array<int> times = array.new<int>()
    ChanMacd state = chan_macd_new(fast, slow, signal, rows.size() + 1)
    state.warmup := warmup
    for i = 0 to rows.size() - 1
        array<string> f = str.split(rows.get(i), ",")
        int t = base + int(str.tonumber(f.get(0))) * step
        times.push(t)
        chan_macd_store(state, t, str.tonumber(f.get(1)), str.tonumber(f.get(2)))
        for q = 0 to segments.size() - 1
            array<string> g = str.split(segments.get(q), ",")
            if int(str.tonumber(g.get(1))) == i
                chan_ma_fixture_query(state, times.get(int(str.tonumber(g.get(0)))), t, int(str.tonumber(g.get(2))), str.tonumber(g.get(3)), id + "/segment-" + str.tostring(q + 1) + "/at-close")
    for q = 0 to segments.size() - 1
        array<string> g = str.split(segments.get(q), ",")
        chan_ma_fixture_query(state, times.get(int(str.tonumber(g.get(0)))), times.get(int(str.tonumber(g.get(1)))), int(str.tonumber(g.get(2))), str.tonumber(g.get(3)), id + "/segment-" + str.tostring(q + 1) + "/final")
    true
`;

const live = `
// Live part: the module against the built-in ta.macd on the loaded chart, then the
// prefix-sum answer against a plain scan of the stored built-in histogram.
type ChanMaLive
    ChanMacd state
    int compared = 0
    int worstBar = na
    float worstGap = 0.0
chan_ma_live_new(int fast, int slow, int signal, int capacity) =>
    ChanMaLive result = ChanMaLive.new()
    result.state := chan_macd_new(fast, slow, signal, capacity)
    result
chan_ma_live_step(ChanMaLive live, int openTime, float price, float builtinDif, float builtinDea, float builtinHist, int barIndex) =>
    ChanMacdBar peek = chan_macd_peek(live.state, price)
    // The first valid bar of each line must be the same as the platform's, not only the values after it.
    chan_ma_assert(na(peek.dif) == na(builtinDif) and na(peek.dea) == na(builtinDea) and na(peek.hist) == na(builtinHist), "LIVE/na-pattern bar=" + str.tostring(barIndex) + " mine=" + str.tostring(peek.hist) + " builtin=" + str.tostring(builtinHist))
    float gap = na(builtinHist) ? 0.0 : math.max(math.abs(peek.dif - builtinDif), math.max(math.abs(peek.dea - builtinDea), math.abs(peek.hist - builtinHist)))
    chan_ma_assert(gap <= 1e-9 * math.max(1.0, math.abs(nz(builtinDif))), "LIVE/" + str.tostring(live.state.fast) + "-" + str.tostring(live.state.slow) + "-" + str.tostring(live.state.signal) + "/bar=" + str.tostring(barIndex) + " mine=" + str.tostring(peek.hist) + " builtin=" + str.tostring(builtinHist) + " gap=" + str.tostring(gap))
    if gap > live.worstGap
        live.worstGap := gap
        live.worstBar := barIndex
    chan_ma_assert(chan_macd_push(live.state, openTime, price), "LIVE/push-accepted bar=" + str.tostring(barIndex))
    live.compared += 1
    true
`;

export function generateMacdValidation(source, data, signalFixtures) {
  validateMacdCases(data);
  assert(signalFixtures.length > 0);
  const section = extractSection(source, 'SIGNALS');
  const lines = [];
  lines.push(...emaCase(data.ema));
  data.areas.forEach((area, index) => lines.push(...areaCase(area, index)));
  let fixtureQueries = 0, fixtureBars = 0;
  const fixtureCalls = [];
  for (const fixture of signalFixtures) {
    const built = fixtureCase(fixture);
    if (!built) continue;
    fixtureCalls.push(built.call);
    fixtureQueries += built.queries; fixtureBars += built.bars;
  }
  const staticCalls = ['    chan_ma_ema_case()', ...data.areas.map((_, i) => `    chan_ma_area_case_${i}()`), ...fixtureCalls];
  const staticQueries = data.areas.reduce((sum, area) => sum + area.queries.length, 0);
  const caseCount = 1 + data.areas.length + fixtureCalls.length;
  const { minBars, queries: liveQueries, capacity } = liveSeeds;
  const schedule = `
if barstate.isfirst
${staticCalls.join('\n')}

[builtinDif, builtinDea, builtinHist] = ta.macd(close, 12, 26, 9)
[builtinDif2, builtinDea2, builtinHist2] = ta.macd(close, 5, 35, 5)
var ChanMaLive primary = chan_ma_live_new(12, 26, 9, ${capacity})
var ChanMaLive secondary = chan_ma_live_new(5, 35, 5, ${capacity})
var array<int> allTimes = array.new<int>()
var array<float> allHist = array.new<float>()
if barstate.isconfirmed and not na(time)
    chan_ma_live_step(primary, time, close, builtinDif, builtinDea, builtinHist, bar_index)
    chan_ma_live_step(secondary, time, close, builtinDif2, builtinDea2, builtinHist2, bar_index)
    allTimes.push(time)
    allHist.push(builtinHist)

var string verdict = "RUNNING"
if barstate.islast
    int total = allTimes.size()
    chan_ma_assert(total >= ${minBars}, "LIVE/need at least ${minBars} closed bars, have " + str.tostring(total))
    ChanMacd subject = primary.state
    chan_ma_assert(subject.seen == total, "LIVE/seen")
    int keptFrom = math.max(subject.warmup, total - subject.capacity)
    chan_ma_assert(subject.dropped == math.max(0, total - subject.warmup - subject.capacity), "LIVE/dropped count")
    chan_ma_assert(subject.times.size() == total - keptFrom, "LIVE/kept size")
    int checked = 0
    int available = 0
    int unavailable = 0
    int seed = 20261112
    for probe = 0 to ${liveQueries - 1}
        seed := (seed * 1103515245 + 12345) % 2147483648
        // Four probes in five stay inside the kept window so the area really is compared; the fifth reaches back into recycled history.
        int i = probe % 5 == 0 ? seed % total : keptFrom + seed % (total - keptFrom)
        seed := (seed * 1103515245 + 12345) % 2147483648
        int j = probe % 5 == 0 ? seed % total : keptFrom + seed % (total - keptFrom)
        int lo = math.min(i, j)
        int hi = math.max(i, j)
        // Half of the probes sit between two bars, to check the "last bar not later than" rule.
        int startOffset = probe % 2 == 0 ? 0 : 1
        int ts = allTimes.get(lo) + startOffset
        int te = allTimes.get(hi) + (probe % 3 == 0 ? 1 : 0)
        int direction = probe % 4 < 2 ? 1 : -1
        float expected = 0.0
        for k = lo to hi
            float h = allHist.get(k)
            int t = allTimes.get(k)
            if t > ts and t <= te and ((direction == 1 and h > 0.0) or (direction == -1 and h < 0.0))
                expected += math.abs(h)
        bool expectAvailable = te >= ts and keptFrom < total and ts >= allTimes.get(keptFrom) and te <= allTimes.last()
        ChanMacdArea r = chan_macd_area(subject, ts, te, direction)
        chan_ma_assert(r.available == expectAvailable, "LIVE/probe-" + str.tostring(probe) + "/available actual=" + str.tostring(r.available) + " reason=" + r.reason)
        if expectAvailable
            chan_ma_assert(math.abs(r.area - expected) <= 1e-6 * math.max(1.0, expected), "LIVE/probe-" + str.tostring(probe) + "/area actual=" + str.tostring(r.area) + " scan=" + str.tostring(expected))
            available += 1
        else
            unavailable += 1
        checked += 1
    chan_ma_assert(available >= 60 and unavailable >= 5, "LIVE/probe mix available=" + str.tostring(available) + " unavailable=" + str.tostring(unavailable))
    verdict := "PASS: MACD, " + str.tostring(primary.compared) + " bars vs ta.macd,\\n" + str.tostring(checked) + " probes\\n(" + str.tostring(available) + " available / " + str.tostring(unavailable) + " unavailable),\\nrecycled " + str.tostring(subject.dropped) + ",\\nworst gap " + str.tostring(math.max(primary.worstGap, secondary.worstGap), "#.#############")
var table panel = table.new(position.top_left, 1, 2)
table.cell(panel, 0, 0, verdict, text_color = str.startswith(verdict, "PASS") ? color.green : color.orange)
table.cell(panel, 0, 1, "手算用例 ${caseCount} 组 · 样例面积 ${fixtureQueries} 段 · 需 ≥${minBars} 根已收盘图表K线")
plot(na)
`;
  const pine = ['//@version=6', 'indicator("缠论MACD前缀和共享验证", overlay=false)', `// SIGNALS section SHA-256: ${sha(section)}`, '// Generated from hand-derived cases and independent signal samples. Run in TradingView; generation is not a test pass.', section, helpers, lines.join('\n'), live, schedule].join('\n') + '\n';
  return {
    source: pine,
    sha256: sha(pine),
    sectionHash: sha(section),
    coreHash: sha(extractCore(source)),
    fixtureHash: sha(JSON.stringify(data) + JSON.stringify(signalFixtures.map(f => f.id))),
    bytes: Buffer.byteLength(pine),
    cases: caseCount,
    staticQueries,
    fixtureQueries,
    fixtureBars,
    execution: 'not run in Pine'
  };
}

export function loadSignalFixtures() {
  const directory = new URL('tests/fixtures/chanlun/signals/', root);
  return fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort().map(name => JSON.parse(fs.readFileSync(new URL(name, directory), 'utf8')));
}

export function buildMacdValidation() {
  const source = fs.readFileSync(new URL('chanlun_original.pine', root), 'utf8');
  const data = JSON.parse(fs.readFileSync(new URL('tests/fixtures/chanlun/macd/cases.json', root), 'utf8'));
  const { source: pine, ...result } = generateMacdValidation(source, data, loadSignalFixtures());
  const output = fileURLToPath(new URL('tmp/chanlun/macd-validation.pine', root));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, pine);
  const manifest = { output, productionSha256: sha(source), ...result };
  fs.writeFileSync(`${output}.json`, JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(buildMacdValidation(), null, 2));
