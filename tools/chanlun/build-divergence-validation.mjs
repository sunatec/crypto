import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractCore, extractSection } from './build-validation.mjs';
import { loadSignalFixtures } from './build-macd-validation.mjs';

// Shared-section validation for the divergence layer (tasks 4.1/4.2).
// The expected signals and suppressed notes are the hand-derived ones in tests/fixtures/chanlun/signals/;
// the script feeds the fixture components through the CORE Z/R functions and the DIVERGENCE section
// and compares every prefix. It uses only the CORE units those sections depend on, copied verbatim.
const root = new URL('../../', import.meta.url);
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const q = JSON.stringify;
export const divergenceTypes = ['first', 'consolidation-divergence-point', 'second', 'third'];

// Top-level units of the CORE section: a `type X` block or a `name(...) =>` function with its comment lines.
export function coreUnits(core) {
  const lines = core.split('\n'), units = [];
  let current = null, pending = [];
  for (const line of lines) {
    const type = /^type (\w+)/.exec(line), fn = /^(\w+)\(.*\) =>/.exec(line);
    if (type || fn) { current = { kind: type ? 'type' : 'fn', name: (type || fn)[1], lines: [...pending, line] }; units.push(current); pending = []; continue; }
    if (line.startsWith('//')) { pending.push(line); continue; }
    if (current) { if (pending.length) { current.lines.push(...pending); pending = []; } current.lines.push(line); }
  }
  return units;
}

// The CORE units reachable from the identifiers used by the given Pine text.
export function coreDependencies(core, texts) {
  const units = coreUnits(core), byName = new Map(units.map(unit => [unit.name, unit]));
  const need = new Set();
  const visit = name => {
    if (need.has(name) || !byName.has(name)) return;
    need.add(name);
    for (const match of byName.get(name).lines.join('\n').matchAll(/\b(chan_\w+|Chan\w+)\b/g)) visit(match[1]);
  };
  for (const text of texts) for (const match of text.matchAll(/\b(chan_\w+|Chan\w+)\b/g)) visit(match[1]);
  return units.filter(unit => need.has(unit.name));
}

const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
const normalizeId = (fixtureId, id) => (id.startsWith(`${fixtureId}/Z/`) ? `Z#${id.split('/').pop()}` : id);

function encodeFixture(fixture) {
  const { bars, items, macd } = fixture.input;
  const base = bars[0].time;
  const step = bars.slice(1).reduce((value, bar) => gcd(value, bar.time - base), 0) || 1;
  const k = time => { assert.equal((time - base) % step, 0, `${fixture.id}: time ${time} is off the bar grid`); return (time - base) / step; };
  const text = value => { assert(/^-?\d+(\.\d+)?$/.test(String(value)), `${fixture.id}: ${value} is not a plain decimal`); return String(value); };
  const seg = s => [k(s.startTime), k(s.endTime), s.direction === 'up' ? 1 : -1, s.areaUnits === null ? 'na' : Math.round(s.areaUnits * 1e6), s.extremeTicks].join(':');
  const cmp = c => (c ? [c.kind, c.aIds.join(','), c.cId, seg(c.a), seg(c.c)].join(';') : '-');
  const deps = list => list.map(id => normalizeId(fixture.id, id)).join(',');
  const signalLine = s => ['S', s.type, s.side, s.priceTicks, k(s.occurredAt), k(s.confirmedAt), deps(s.dependencies), cmp(s.comparison)].join('|');
  const noteLine = s => ['N', s.type, s.reason, deps(s.dependencies), cmp(s.comparison)].join('|');
  const byId = new Map();
  fixture.expected.forEach(snapshot => snapshot.signals.forEach(signal => byId.set(signal.id, signal)));
  let events = 0, notes = 0, noteKinds = new Set();
  const expected = fixture.expected.map(snapshot => {
    const lines = [];
    for (const id of snapshot.events) {
      const signal = byId.get(id);
      assert(signal, `${fixture.id}: event ${id} has no record`);
      if (divergenceTypes.includes(signal.type)) { lines.push(signalLine(signal)); events += 1; }
    }
    for (const note of snapshot.suppressed) if (divergenceTypes.includes(note.type)) { lines.push(noteLine(note)); notes += 1; noteKinds.add(note.reason); }
    return `.${lines.join('^')}`;
  });
  const barsText = bars.map(bar => `${k(bar.time)},${text(bar.dif)},${text(bar.dea)}`).join(';');
  const itemsText = items.map(item => [item.id, k(item.startTime), k(item.endTime), k(item.completedAt), item.startTicks, item.endTicks, item.lowTicks, item.highTicks, item.direction === 'up' ? 1 : -1].join(',')).join(';');
  for (const item of items) assert(!/[;,~^|]/.test(item.id), `${fixture.id}: component id would break the encoding`);
  return {
    call: `    chan_dv_run(${q(fixture.id)}, ${macd.fast}, ${macd.slow}, ${macd.signal}, ${macd.warmupBars}, ${base}, ${step}, ${q(barsText)}, ${q(itemsText)}, ${q(expected.join('~'))})`,
    prefixes: items.length, events, notes, noteKinds: [...noteKinds]
  };
}

const helpers = `
chan_dv_assert(bool value, string context) =>
    if not value
        runtime.error("FAIL: " + context)
    true
chan_dv_k(int time, int base, int step) =>
    int(math.round((time - base) / float(step)))
chan_dv_norm(string id) =>
    string result = id
    array<string> parts = str.split(id, "/")
    if parts.size() >= 2
        for i = 0 to parts.size() - 2
            if parts.get(i) == "Z" and result == id
                result := "Z#" + parts.get(i + 1)
    result
chan_dv_deps(array<string> dependencies) =>
    array<string> parts = array.new<string>()
    for dependency in dependencies
        parts.push(chan_dv_norm(dependency))
    array.join(parts, ",")
chan_dv_seg(ChanSegmentArea segment, int base, int step) =>
    str.tostring(chan_dv_k(segment.startTime, base, step)) + ":" + str.tostring(chan_dv_k(segment.endTime, base, step)) + ":" + str.tostring(segment.direction) + ":" + (na(segment.area) ? "na" : str.tostring(math.round(segment.area * 1000000))) + ":" + str.tostring(segment.extremeTicks)
chan_dv_cmp(ChanComparison comparison, int base, int step) =>
    string result = "-"
    if not na(comparison)
        result := comparison.kind + ";" + array.join(comparison.aIds, ",") + ";" + comparison.cId + ";" + chan_dv_seg(comparison.a, base, step) + ";" + chan_dv_seg(comparison.c, base, step)
    result
chan_dv_signal(ChanSignal signal, int base, int step) =>
    "S|" + signal.type + "|" + (signal.side == 1 ? "buy" : "sell") + "|" + str.tostring(signal.priceTicks) + "|" + str.tostring(chan_dv_k(signal.occurredAt, base, step)) + "|" + str.tostring(chan_dv_k(signal.confirmedAt, base, step)) + "|" + chan_dv_deps(signal.dependencies) + "|" + chan_dv_cmp(signal.comparison, base, step)
chan_dv_note(ChanSignalNote note, int base, int step) =>
    "N|" + note.type + "|" + note.reason + "|" + chan_dv_deps(note.dependencies) + "|" + chan_dv_cmp(note.comparison, base, step)
chan_dv_lines(array<ChanSignal> events, array<ChanSignalNote> notes, int base, int step) =>
    array<string> lines = array.new<string>()
    for event in events
        lines.push(chan_dv_signal(event, base, step))
    for note in notes
        lines.push(chan_dv_note(note, base, step))
    "." + array.join(lines, "^")
chan_dv_segment(string id, int ordinal, int direction, int startTime, int endTime, int startTicks, int endTicks, int low, int high) =>
    ChanStructure segment = ChanStructure.new()
    segment.id := id
    segment.objectType := "segment"
    segment.level := 0
    segment.direction := direction
    segment.startTime := startTime
    segment.endTime := endTime
    segment.startTicks := startTicks
    segment.endTicks := endTicks
    segment.confirmed := false
    segment.ruleId := "fixture"
    segment.dependencies := array.from(id)
    segment.ordinal := ordinal
    segment.memberLowTicks := low
    segment.memberHighTicks := high
    segment.memberLowTime := direction == 1 ? startTime : endTime
    segment.memberHighTime := direction == 1 ? endTime : startTime
    segment
// Two hypothetical segments become two confirmed-looking parts at the preview time; nothing else moves.
chan_dv_preview_parts() =>
    ChanNormalizationState normalized = chan_normalization_new("PV")
    array<ChanStructure> hypothetical = array.from(chan_dv_segment("h1", 1, 1, 1000, 4000, 0, 10, 0, 10), chan_dv_segment("h2", 2, -1, 4000, 7000, 10, 6, 6, 10))
    array<ChanComponent> parts = chan_signal_preview_parts(normalized, hypothetical, 9000)
    chan_dv_assert(parts.size() == 2, "PREVIEW/parts")
    ChanComponent first = parts.get(0)
    ChanComponent second = parts.get(1)
    chan_dv_assert(first.ordinal == 1 and second.ordinal == 2 and first.direction == 1 and second.direction == -1, "PREVIEW/order")
    chan_dv_assert(first.realEndTicks == 10 and first.actualHighTicks == 10 and second.realEndTicks == 6 and second.actualLowTicks == 6, "PREVIEW/ranges")
    chan_dv_assert(first.confirmedAt == 9000 and second.confirmedAt == 9000, "PREVIEW/confirmedAt")
    chan_dv_assert(normalized.count == 0 and na(normalized.lastInput), "PREVIEW/normalization-untouched")
    ChanStructure kept = hypothetical.get(0)
    chan_dv_assert(not kept.confirmed and na(kept.confirmedAt), "PREVIEW/hypothetical-untouched")
    true
// Feeds the fixture components one at a time through the CORE Z/R functions and the DIVERGENCE section,
// storing the MACD bars that are closed by each component's confirmation time.
chan_dv_run(string id, int fast, int slow, int signal, int warmup, int base, int step, string barsText, string itemsText, string expectText) =>
    array<string> rows = str.split(barsText, ";")
    array<string> items = str.split(itemsText, ";")
    array<string> expected = str.split(expectText, "~")
    chan_dv_assert(items.size() == expected.size(), id + "/prefix count")
    ChanMacd macd = chan_macd_new(fast, slow, signal, rows.size() + 1)
    macd.warmup := warmup
    ChanSignalRuntime engine = chan_signal_runtime_new(id, 1)
    int stored = 0
    int total = 0
    string online = ""
    array<ChanComponent> parts = array.new<ChanComponent>()
    for p = 0 to items.size() - 1
        array<string> f = str.split(items.get(p), ",")
        int startTime = base + int(str.tonumber(f.get(1))) * step
        int endTime = base + int(str.tonumber(f.get(2))) * step
        int confirmedAt = base + int(str.tonumber(f.get(3))) * step
        int startTicks = int(str.tonumber(f.get(4)))
        int endTicks = int(str.tonumber(f.get(5)))
        int low = int(str.tonumber(f.get(6)))
        int high = int(str.tonumber(f.get(7)))
        int dir = int(str.tonumber(f.get(8)))
        bool more = true
        while more and stored < rows.size()
            array<string> g = str.split(rows.get(stored), ",")
            int barTime = base + int(str.tonumber(g.get(0))) * step
            if barTime + step <= confirmedAt
                chan_macd_store(macd, barTime, str.tonumber(g.get(1)), str.tonumber(g.get(2)))
                stored += 1
            else
                more := false
        ChanComponent part = ChanComponent.new(f.get(0), f.get(0), startTime, endTime, startTicks, endTicks, low, high, dir == 1 ? startTime : endTime, dir == 1 ? endTime : startTime, startTime, endTime, dir == 1 ? low : high, dir == 1 ? high : low, dir, confirmedAt, "fixture", array.from(f.get(0)), p + 1)
        // Preview first: the open bar shows what the confirmation will show, and the engine is left untouched.
        int committedCount = engine.d1.count
        int committedSize = engine.d1.signals.size()
        ChanSignalCandidates candidate = chan_signal_candidates(engine, array.from(part), macd)
        string previewText = chan_dv_lines(candidate.events, candidate.notes, base, step)
        chan_dv_assert(previewText == expected.get(p), id + "/prefix-" + str.tostring(p + 1) + "/preview actual=" + previewText + " expected=" + expected.get(p))
        chan_dv_assert(engine.stack.centers.inputCount == p and engine.d1.lastOrdinal == p and engine.d1.count == committedCount and engine.d1.signals.size() == committedSize, id + "/prefix-" + str.tostring(p + 1) + "/preview-isolated")
        engine := chan_signal_part(engine, part, macd)
        string actual = chan_dv_lines(engine.events, engine.notes, base, step)
        total += engine.events.size() + engine.notes.size()
        chan_dv_assert(actual == expected.get(p), id + "/prefix-" + str.tostring(p + 1) + " actual=" + actual + " expected=" + expected.get(p))
        online += (p == 0 ? "" : "~") + actual
        parts.push(part)
        // Closing the same part again submits nothing a second time.
        ChanSignalRuntime again = chan_signal_part(engine, part, macd)
        chan_dv_assert(again.events.size() == 0 and again.notes.size() == 0 and again.d1.count == engine.d1.count and again.d1.signals.size() == engine.d1.signals.size(), id + "/prefix-" + str.tostring(p + 1) + "/repeat")
    // Reload: one uninterrupted pass over the same parts gives the same signals and notes, prefix by prefix.
    ChanSignalRuntime reloaded = chan_signal_runtime_new(id, 1)
    string replay = ""
    for q = 0 to parts.size() - 1
        reloaded := chan_signal_part(reloaded, parts.get(q), macd)
        replay += (q == 0 ? "" : "~") + chan_dv_lines(reloaded.events, reloaded.notes, base, step)
    chan_dv_assert(replay == online and reloaded.d1.count == engine.d1.count and reloaded.d1.signals.size() == engine.d1.signals.size(), id + "/reload")
    total
`;

export function generateDivergenceValidation(source, signalFixtures) {
  const core = extractCore(source), macdSection = extractSection(source, 'SIGNALS'), divergence = extractSection(source, 'DIVERGENCE');
  const units = coreDependencies(core, [macdSection, divergence, helpers]);
  const coreText = units.map(unit => unit.lines.join('\n')).join('\n');
  const encoded = signalFixtures.map(encodeFixture);
  const totals = encoded.reduce((sum, e) => ({ prefixes: sum.prefixes + e.prefixes, events: sum.events + e.events, notes: sum.notes + e.notes }), { prefixes: 0, events: 0, notes: 0 });
  const reasons = new Set(encoded.flatMap(e => e.noteKinds));
  const schedule = `
var table panel = table.new(position.top_left, 1, 2)
var string verdict = "RUNNING"
if barstate.isfirst
    chan_dv_preview_parts()
${encoded.map(e => e.call).join('\n')}
    verdict := "PASS: D5, ${signalFixtures.length} fixtures,\\n${totals.prefixes} prefixes,\\n${totals.events} signals / ${totals.notes} notes,\\npreview / repeat / reload / preview parts"
table.cell(panel, 0, 0, verdict, text_color = str.startswith(verdict, "PASS") ? color.green : color.orange)
plot(na)
`;
  const pine = ['//@version=6', 'indicator("缠论背驰层共享验证", overlay=false)', `// CORE units (verbatim subset) SHA-256: ${sha(coreText)}`, `// SIGNALS section SHA-256: ${sha(macdSection)}`, `// DIVERGENCE section SHA-256: ${sha(divergence)}`, '// Generated from the independent signal samples. Run in TradingView; generation is not a test pass.', coreText, macdSection, divergence, helpers, schedule].join('\n') + '\n';
  const lean = pine.split('\n').filter(line => (!line.trim().startsWith('//') || line.startsWith('//@version')) && line.trim() !== '').join('\n') + '\n';
  return {
    source: pine,
    lean,
    sha256: sha(pine),
    leanSha256: sha(lean),
    coreHash: sha(core),
    coreSubsetHash: sha(coreText),
    coreUnits: units.map(unit => unit.name),
    sectionHash: sha(macdSection),
    divergenceHash: sha(divergence),
    fixtures: signalFixtures.length,
    ...totals,
    reasons: [...reasons].sort(),
    bytes: Buffer.byteLength(pine),
    leanBytes: Buffer.byteLength(lean),
    execution: 'not run in Pine'
  };
}

export function buildDivergenceValidation() {
  const source = fs.readFileSync(new URL('chanlun_original.pine', root), 'utf8');
  const { source: pine, lean, ...result } = generateDivergenceValidation(source, loadSignalFixtures());
  const output = fileURLToPath(new URL('tmp/chanlun/divergence-validation.pine', root));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, pine);
  fs.writeFileSync(`${output}.lean`, lean);
  const manifest = { output, productionSha256: sha(source), ...result };
  fs.writeFileSync(`${output}.json`, JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(buildDivergenceValidation(), null, 2));
