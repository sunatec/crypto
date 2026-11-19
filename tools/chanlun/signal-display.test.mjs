import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import { extractCore, extractSection } from './build-validation.mjs';

const production = fs.readFileSync(new URL('../../chanlun_original.pine', import.meta.url), 'utf8');
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const chart = production.slice(production.indexOf('// ==================== Chart scheduling'));
const display = production.slice(production.indexOf('// ==================== Signal display and alerts'), production.indexOf('// ==================== Chart scheduling'));
const code = text => text.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');

// Group 6 only adds projections. The sections the platform already validated (D5 PASS on 2026-11-13) stay byte-identical.
test('CORE, SIGNALS and DIVERGENCE are byte-identical to the platform-validated versions', () => {
  assert.equal(sha(extractCore(production)), '7bea4f3a789c862e6beaa3ea2f21e60843f21b52c13cc4e7f9a7db61ba5479d0');
  assert.equal(sha(extractSection(production, 'SIGNALS')), 'f5869e11d7ccf2784cf9c66019167facfe4bf15c261020f22db3a422a8f0b178');
  assert.equal(sha(extractSection(production, 'DIVERGENCE')), '89ebf4da55d2375b03948f98cb8691a1c6c0d27a5f3f477bfc4f31ea5f903d04');
});

test('the signal inputs exist with the agreed defaults, and nothing is on by accident', () => {
  const input = name => new RegExp(`^bool ${name} = input\\.bool\\((true|false), "([^"]+)"`, 'm').exec(production);
  const defaults = { signalsOn: 'true', showSignals: 'true', showSignalL1: 'true', showSignalL2: 'true', showSignalL3: 'true', showFirst: 'true', showConsolidation: 'true', showSecond: 'true', showThird: 'true', showComparison: 'true', showNotes: 'false', showCandidates: 'false', alertsOn: 'false', alertL1: 'true', alertL2: 'true', alertL3: 'true', alertFirst: 'true', alertConsolidation: 'true', alertSecond: 'true', alertThird: 'true' };
  for (const [name, value] of Object.entries(defaults)) { const found = input(name); assert(found, `${name} input is missing`); assert.equal(found[1], value, `${name} default`); }
  assert(/group = groupSignals/.test(production) && /string groupSignals = "买卖点（信号阶段）"/.test(production));
  assert(/string groupAlerts = "提醒（信号阶段）"/.test(production));
  assert(/^color buyColor = input\.color\(/m.test(production) && /^color sellColor = input\.color\(/m.test(production));
});

test('every signal setting has a Chinese label and none is a placeholder', () => {
  const labels = [...production.matchAll(/^(?:bool|color) (?:signalsOn|show(?:Signals|SignalL\d|First|Consolidation|Second|Third|Comparison|Notes)|alert\w+|buyColor|sellColor) = input\.\w+\(.*?, "([^"]+)"/gm)].map(match => match[1]);
  assert(labels.length >= 20, `${labels.length} labels`);
  for (const label of labels) assert(/[一-龥]/.test(label), label);
  assert.equal(new Set(labels).size, labels.length, 'duplicate setting labels');
});

test('marks, alerts and candidates share one layer-and-type filter', () => {
  assert(/chan_signal_allowed\(ChanSignal signal, bool l1, bool l2, bool l3, bool first, bool consolidation, bool second, bool third\)/.test(display));
  assert(/if showSignals and chan_signal_allowed\(signal, showSignalL1, showSignalL2, showSignalL3, showFirst, showConsolidation, showSecond, showThird\)/.test(chart));
  assert(/if alertsOn and barstate\.isrealtime and chan_signal_allowed\(signal, alertL1, alertL2, alertL3, alertFirst, alertConsolidation, alertSecond, alertThird\)/.test(chart));
  assert(/if chan_signal_allowed\(candidate, showSignalL1, showSignalL2, showSignalL3, showFirst, showConsolidation, showSecond, showThird\)/.test(chart));
  // The filter needs both the layer switch and the type switch.
  assert(/layerOn and typeOn/.test(display));
});

test('alert() is called once, on the closing execution of a live bar, for a committed signal only', () => {
  const calls = [...code(production).matchAll(/\balert\(/g)];
  assert.equal(calls.length, 1, 'exactly one alert() call');
  const at = chart.indexOf('alert(chan_signal_alert_text(');
  assert(at > chart.indexOf('if frame.submitted'), 'alert is inside the confirmed-frame branch');
  assert(at < chart.indexOf('// ==================== Last-bar research projection'), 'alert is not in the last-bar projection');
  assert(chart.slice(at, at + 140).includes('alert.freq_all'), 'one alert per signal');
  // The loop reads the events returned for this very part, not the layer history.
  const loop = chart.slice(chart.indexOf('chan_signal_part(signals, component, macd)'), at);
  assert(/for signal in signals\.events/.test(loop));
  assert(!/signals\.d[123]\.signals/.test(loop));
  // Candidates never alert.
  const candidateBlock = chart.slice(chart.indexOf('if supported and inRange and signalsOn and showCandidates'), chart.indexOf('if showFractals and supported'));
  assert(!candidateBlock.includes('alert('));
});

test('the alert text carries symbol, period, layer, type, side, price and the signal id', () => {
  const text = display.slice(display.indexOf('chan_signal_alert_text('));
  for (const part of ['syminfo.tickerid', 'timeframe.period', 'signal.layer', 'chan_signal_type_text(signal.type)', 'signal.side == 1 ? "买点" : "卖点"', 'signal.priceTicks * tickSize', 'signal.id']) assert(text.includes(part), part);
});

test('signal marks are distinct from structure ids and protected in the shared drawing registry', () => {
  const renderer = extractSection(production, 'RENDERER');
  for (const category of ['D-signal-buy', 'D-signal-sell', 'D-candidate-buy', 'D-candidate-sell']) assert(renderer.includes(`"${category}" =>`), category);
  // A confirmed mark is solid, a candidate and a structure caption stay hollow.
  assert(renderer.includes('bool solidMark = str.startswith(spec.category, "D-signal")'));
  assert(renderer.includes('label.set_color(record.labelId, solidMark ? spec.hue : color.new(spec.hue, 100))'));
  // Global label eviction takes anything else before a confirmed mark.
  const oldest = renderer.slice(renderer.indexOf('chan_draw_oldest('), renderer.indexOf('chan_draw_put('));
  assert(oldest.includes('str.startswith(record.category, "D-signal")') && oldest.includes('found >= 0 ? found : protectedFound'));
  // The mark text names layer and type; structure captions use P#/S#/L1-M# so the two never read alike.
  assert(display.includes('"L" + str.tostring(signal.layer) + " " + chan_signal_type_text(signal.type) + (signal.side == 1 ? "买" : "卖")'));
  // The drawing registry is not told anything about signal state.
  assert(!/signals?\./.test(code(renderer)));
});

test('signals draw only from committed events; research extras need the research view', () => {
  const draw = display.slice(display.indexOf('chan_signal_draw('), display.indexOf('chan_signal_note_draw('));
  assert(draw.includes('if withComparison and not na(signal.comparison)'));
  assert(/research and showComparison/.test(chart));
  assert(/if research and showNotes/.test(chart));
  // The comparison line is put in time order, otherwise the registry would raise a runtime error.
  assert(draw.includes('bool ordered = comparison.a.endTime <= comparison.c.endTime'));
  // Display code never assigns into engine, MACD or the signal runtime.
  assert(!/\b(engine|macd|signals)(\.\w+)*\s*:=/.test(code(display)));
  // The only write to the signal runtime in the chart is the per-part step.
  const writes = [...code(chart).matchAll(/\bsignals\s*:=\s*([^\n]+)/g)].map(match => match[1].trim());
  assert.deepEqual(writes, ['chan_signal_part(signals, component, macd)']);
});

test('turning signals off skips MACD, the per-part step and the candidate preview', () => {
  assert(/if signalsOn and barstate\.isconfirmed\r?\n\s+chan_macd_push/.test(chart));
  const step = chart.indexOf('chan_signal_part(signals, component, macd)');
  assert(/if signalsOn\r?\n\s+signals := chan_signal_part/.test(chart.slice(step - 80, step + 60)));
  assert(chart.includes('if supported and inRange and signalsOn and showCandidates and not barstate.isconfirmed'));
  // Structure drawing keeps running regardless: no structure call is nested under signalsOn.
  assert(/if showSegments\r?\n\s+chan_draw_structure\(drawings, segment/.test(chart));
});

test('every chan_ function and type used by the display block is defined before it is used', () => {
  const lines = production.split('\n');
  const defined = new Map(), types = new Map();
  lines.forEach((line, i) => { const f = /^(chan_\w+)\(/.exec(line); if (f && !defined.has(f[1])) defined.set(f[1], i); const t = /^type (\w+)/.exec(line); if (t) types.set(t[1], i); });
  const start = lines.findIndex(line => line.startsWith('// ==================== Signal display and alerts'));
  lines.slice(start).forEach((line, offset) => {
    if (line.trim().startsWith('//')) return;
    const i = start + offset;
    for (const m of line.matchAll(/\b(chan_\w+)\(/g)) { assert(defined.has(m[1]), `${m[1]} is not defined (line ${i + 1})`); assert(defined.get(m[1]) <= i, `${m[1]} used on line ${i + 1} before its definition`); }
    for (const m of line.matchAll(/\b(Chan[A-Z]\w+)\b/g)) assert(types.has(m[1]), `${m[1]} is not a defined type (line ${i + 1})`);
  });
});

// TradingView rejects a variable that has the name of a built-in namespace (text, label, line, box, table, color, ...).
test('no variable or parameter in the display block is named like a Pine namespace', () => {
  const reserved = ['text', 'label', 'line', 'box', 'table', 'color', 'str', 'math', 'array', 'map', 'matrix', 'chart', 'syminfo', 'timeframe', 'barstate', 'alert', 'input', 'size', 'position', 'plot', 'strategy', 'ta', 'request', 'runtime', 'session', 'ticker', 'time', 'format', 'font'];
  const found = [];
  for (const line of code(display).split('\n')) {
    const declared = /^\s*(?:(?:string|int|float|bool|color|array<\w+>|Chan\w+)\s+)(\w+)\s*(?:=|:=)/.exec(line);
    if (declared && reserved.includes(declared[1])) found.push(declared[1]);
    const params = /^chan_\w+\((.*)\) =>/.exec(line);
    if (params) for (const part of params[1].split(',')) { const name = part.trim().split(/\s+/).pop(); if (reserved.includes(name)) found.push(name); }
  }
  assert.deepEqual(found, []);
});

test('the research status line reports how many signal marks are in the registry, per side', () => {
  assert(chart.includes('"\\n买卖点标记 买" + str.tostring(chan_draw_count(drawings, "label", "D-signal-buy")) + " / 卖" + str.tostring(chan_draw_count(drawings, "label", "D-signal-sell"))'));
});
