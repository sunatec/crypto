import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import { extractCore, extractSection } from './build-validation.mjs';
import { coreDependencies, generateDivergenceValidation, divergenceTypes } from './build-divergence-validation.mjs';
import { loadSignalFixtures } from './build-macd-validation.mjs';

const production = fs.readFileSync(new URL('../../chanlun_original.pine', import.meta.url), 'utf8');
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const CORE_BASELINE = '7bea4f3a789c862e6beaa3ea2f21e60843f21b52c13cc4e7f9a7db61ba5479d0';

test('the pattern CORE is byte-identical to the version before this change', () => {
  assert.equal(sha(extractCore(production)), CORE_BASELINE);
});

test('the DIVERGENCE section is read-only with respect to CORE state', () => {
  const code = extractSection(production, 'DIVERGENCE').split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  // No assignment into a CORE-owned state: centers/movements/levels/stack and their fields are only read.
  for (const name of ['centers', 'movements', 'levels', 'stack']) {
    const assigned = new RegExp(`\\b${name}(\\.\\w+)+\\s*(:=|\\+=|-=)`, 'g');
    const hits = [...code.matchAll(assigned)].filter(match => !/^result\.stack/.test(code.slice(match.index - 7, match.index + 12)) && !match[0].startsWith('result.'));
    assert.deepEqual(hits.map(match => match[0]), [], `${name} must not be assigned`);
  }
  // The only CORE mutation entry points are the step functions on the mirror, never on the engine.
  for (const call of code.matchAll(/\b(chan_(?:center|movement|levels|stack)_\w+)\(/g)) assert(['chan_center_new', 'chan_movement_new_level', 'chan_levels_new', 'chan_stack_step'].includes(call[1]), call[1]);
  assert(!code.includes('engine'));
  assert(!/\bbar_index\b/.test(code));
});

test('the chart feeds D only with confirmed parts, after MACD, and only the signal layer is wired', () => {
  const chart = production.slice(production.indexOf('// ==================== Chart scheduling'));
  assert(/var ChanSignalRuntime signals = chan_signal_runtime_new\(/.test(chart));
  const macdAt = chart.indexOf('chan_macd_push(macd, time, close)'), partAt = chart.indexOf('chan_signal_part(signals');
  assert(macdAt > 0 && partAt > macdAt, 'MACD must be pushed before parts are judged');
  assert(chart.indexOf('chan_signal_part(signals') > chart.indexOf('if frame.submitted'));
});

test('the generated divergence script is a verbatim CORE subset plus the signal sections', () => {
  const result = generateDivergenceValidation(production, loadSignalFixtures());
  assert.equal(result.coreHash, CORE_BASELINE);
  assert.equal(result.fixtures, 19);
  assert.equal(result.prefixes, 154);
  assert.equal(result.events, 25); assert.equal(result.notes, 28);
  assert.deepEqual(result.reasons, ['area-not-smaller', 'area-unavailable', 'breaks-first-class-price', 'no-entry-segment', 'no-same-direction-entry', 'not-new-extreme', 'touch-edge']);
  const core = extractCore(production);
  for (const unit of coreDependencies(core, [extractSection(production, 'SIGNALS'), extractSection(production, 'DIVERGENCE')])) assert(core.includes(unit.lines.join('\n')), `${unit.name} is not verbatim`);
  for (const name of ['ChanStack', 'chan_stack_step', 'chan_center_step', 'chan_movement_step', 'chan_levels_step']) assert(result.coreUnits.includes(name), name);
  assert(!result.coreUnits.some(name => /^chan_(step|clone|fractal|stroke|segment)/.test(name)), 'only Z/R/levels units are needed');
  for (const label of ['chan_dv_run', 'prefix count', 'PASS: D5', '/preview-isolated', '/repeat', '/reload', 'chan_signal_candidates', 'chan_signal_preview_parts', 'PREVIEW/normalization-untouched']) assert(result.source.includes(label), label);
  assert(result.source.includes(extractSection(production, 'DIVERGENCE')));
});

test('every Pine function in the generated script is defined before use and no string literal is split', () => {
  const { source } = generateDivergenceValidation(production, loadSignalFixtures());
  const lines = source.split('\n'), defined = new Map();
  lines.forEach((line, i) => { const m = /^(chan_\w+)\(/.exec(line); if (m && !defined.has(m[1])) defined.set(m[1], i); });
  lines.forEach((line, i) => {
    if (line.trim().startsWith('//')) return;
    for (const m of line.matchAll(/\b(chan_\w+)\(/g)) if (defined.has(m[1])) assert(defined.get(m[1]) <= i, `${m[1]} used on line ${i + 1} before line ${defined.get(m[1]) + 1}`);
    assert.equal((line.match(/(?<!\\)"/g) ?? []).length % 2, 0, `line ${i + 1} has an unterminated string`);
  });
  const types = new Map();
  lines.forEach((line, i) => { const m = /^type (\w+)/.exec(line); if (m) types.set(m[1], i); });
  // Every project function / type the script mentions must be defined in it (a missing one is a platform compile error).
  lines.forEach((line, i) => {
    if (line.trim().startsWith('//')) return;
    for (const m of line.matchAll(/\b(chan_\w+)\(/g)) assert(defined.has(m[1]), `${m[1]} is called on line ${i + 1} but never defined`);
    for (const m of line.matchAll(/\b(Chan[A-Z]\w+)\b/g)) assert(types.has(m[1]), `${m[1]} is used on line ${i + 1} but never defined`);
  });
  lines.forEach((line, i) => { for (const m of line.matchAll(/\b(Chan\w+)\.new\(/g)) if (types.has(m[1])) assert(types.get(m[1]) <= i, `${m[1]} used before its type on line ${i + 1}`); });
});

test('expected lines come from the independent samples and cover every divergence outcome', () => {
  const fixtures = loadSignalFixtures();
  const { source } = generateDivergenceValidation(production, fixtures);
  const first = fixtures.find(f => f.id === 'SIG-TREND-DIV');
  const call = source.split('\n').find(line => line.includes('chan_dv_run("SIG-TREND-DIV",'));
  assert(call.includes('S|first|sell|24|29|31|Z#2,Z#1,c5,c9|trend;c5;c9;12:16:1:12000000:16;25:29:1:8000000:24'));
  assert(call.includes('N|consolidation-divergence-point|no-entry-segment|Z#1,c5|-'));
  const down = source.split('\n').find(line => line.includes('chan_dv_run("SIG-TREND-DIV-DOWN",'));
  assert(down.includes('S|first|buy|'));
  const cons = source.split('\n').find(line => line.includes('chan_dv_run("SIG-CONS-DIV",'));
  assert(cons.includes('S|consolidation-divergence-point|sell|24|'));
  assert.deepEqual(divergenceTypes, ['first', 'consolidation-divergence-point', 'second', 'third']);
  const coincide = source.split('\n').find(line => line.includes('chan_dv_run("SIG-SECOND-THIRD-COINCIDE",'));
  // Same batch: the second-class point is listed before the third-class point (B-005).
  assert(coincide.indexOf('S|second|sell|13|') > 0 && coincide.indexOf('S|second|sell|13|') < coincide.indexOf('S|third|sell|13|'));
  assert(coincide.includes('S|second|sell|13|35|37|SIG-SECOND-THIRD-COINCIDE/L1/first/c9,c10,c11|-'));
  assert(coincide.includes('S|third|sell|13|35|37|Z#2,c10,c11|-'));
  const breaks = source.split('\n').find(line => line.includes('chan_dv_run("SIG-SECOND-BREAKS",'));
  assert(breaks.includes('N|second|breaks-first-class-price|SIG-SECOND-BREAKS/L1/first/c9,c10,c11|-'));
  assert(breaks.includes('N|third|touch-edge|Z#2,c9,c10|-'));
  const touch = source.split('\n').find(line => line.includes('chan_dv_run("SIG-THIRD-TOUCH-EQUAL",'));
  assert(touch.includes('N|third|touch-edge|Z#1,c5,c6|-'));
  assert(first.expected.length > 0);
});
