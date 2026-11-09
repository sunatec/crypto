import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { validateFixture } from './check-fixtures.mjs';
import { generateValidation } from './build-validation.mjs';
import { generateRenderValidation } from './build-render-validation.mjs';

const rules = new Set(['S-001', 'S-002', 'S-003', 'E-002', 'E-006']);
const sources = new Set(['C65-168', 'C67-172', 'C71-182', 'C78-198', 'C81-209', 'C81-210']);
const load = name => JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/chanlun/s-feature-${name}.json`, import.meta.url), 'utf8'));
const validate = fixture => validateFixture(fixture, rules, sources);
const production = fs.readFileSync(new URL('../../chanlun_original.pine', import.meta.url), 'utf8');

test('feature contracts reject future, unselected, repeated and lost stroke sources', () => {
  for (const change of [f => { f.expected[1].state.features[0].sourceIds = ['p4']; }, f => { f.expected[1].state.features[0].sourceIds = ['p1']; }, f => { f.expected[1].state.features[0].sourceIds.push('p2'); }, f => { f.expected[1].state.features = []; }]) {
    const fixture = load('up'); change(fixture);
    assert.throws(() => validate(fixture), /source|duplicate|lost/);
  }
});
test('feature contracts retain sealed prefixes, extrema provenance and stroke continuity', () => {
  const sealed = load('up'); sealed.expected[4].state.features[0].highTicks++;
  assert.throws(() => validate(sealed), /provenance|sealed/);
  const origin = load('equal-origin'); origin.expected[5].state.features[1].lowTime = origin.input.items[0].startTime;
  assert.throws(() => validate(origin), /provenance/);
  const disconnected = load('up'); disconnected.input.items[2].startTicks++;
  assert.throws(() => validate(disconnected), /disconnected/);
});
test('feature diagnostics cannot become segment confirmations or hide unresolved inputs', () => {
  const fabricated = load('up'); fabricated.expected[5].events.push({type:'segment'});
  assert.throws(() => validate(fabricated), /segment events/);
  const waiting = load('wait-direction'); waiting.expected[3].state.heldId = null;
  assert.throws(() => validate(waiting), /held input/);
  const blocked = load('element-limit'); blocked.expected[5].state.turnKind = 'top'; blocked.expected[5].state.gap = false;
  assert.throws(() => validate(blocked), /blocked feature turn/);
});
test('first and second sequence fixtures preserve their distinct boundary contracts', () => {
  const first = load('first-boundary'), second = load('second-boundary');
  assert.deepEqual(first.input.items, second.input.items);
  validate(first); validate(second);
  const invalid = structuredClone(first); invalid.expected[3].state.features[1].firstSide = 0;
  assert.throws(() => validate(invalid), /across boundary/);
  const badSide = structuredClone(second); badSide.expected[3].state.features[0].lastSide = 0;
  assert.throws(() => validate(badSide), /boundary provenance/);
  const resumed = load('element-limit'); resumed.expected[6].state.blocked = false;
  assert.throws(() => validate(resumed), /resumed/);
  const inside = load('first-boundary'); inside.input.context.boundaryTime -= 1;
  assert.throws(() => validate(inside), /boundary inside/);
});
test('shared Pine feature driver asserts boundaries, gaps, provenance and isolation at each prefix', () => {
  for (const name of ['up', 'down', 'first-boundary', 'second-boundary', 'gap', 'touch', 'wait-direction', 'element-limit', 'source-limit', 'equal-origin', '81-lower', '81-equal', '81-higher']) {
    const fixture = load(name), result = generateValidation(production, [fixture]);
    assert(result.source.includes('online := chan_feature_step(online,'));
    for (const {prefix} of fixture.expected) for (const check of ['feature-count','held-input','prefix-reload','duplicate-input','deep-copy-isolation']) assert(result.source.includes(`${fixture.id}/prefix-${prefix}/${check}`));
  }
  const gap = generateValidation(production, [load('gap')]).source;
  assert(gap.includes('turn6.gap == true'));
  assert(gap.includes('S-FEATURE-GAP/prefix-6/turn-availability'));
  assert(gap.includes('S-FEATURE-GAP/prefix-6/feature-1/highTime'));
  const noStart = load('no-start');
  validate(noStart);
  const startCheck = generateValidation(production, [noStart]).source;
  assert(startCheck.includes('S-FEATURE-NO-START/prefix-3/segment-seed-eligibility'));
  assert(startCheck.includes('chan_segment_seed(ChanStructure.new('));
});
test('feature fixture shape and renderer checks cannot silently omit expected fields', () => {
  const unknown = load('up'); unknown.expected[0].state.unknown = true;
  assert.throws(() => validate(unknown), /unexpected/);
  assert.throws(() => generateValidation(production, [unknown]), /unsupported feature state/);
  const result = generateRenderValidation(production);
  assert(result.source.includes('features := chan_feature_step(features, featureInput)'));
  assert(result.source.includes('chan_draw_features(gallery, features,'));
  assert(result.source.includes('feature-rendering-does-not-mutate-core'));
});
