import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import { extractCore, generateValidation } from './build-validation.mjs';

const source = fs.readFileSync(new URL('../../chanlun_original.pine', import.meta.url), 'utf8');
const fixture = JSON.parse(fs.readFileSync(new URL('../../tests/fixtures/chanlun/f-top-seal.json', import.meta.url), 'utf8'));
test('generated validation includes the exact production core, without a second algorithm', () => {
  const result = generateValidation(source, [fixture]);
  const core = extractCore(source);
  assert(result.source.includes(core));
  assert.equal(result.coreHash, crypto.createHash('sha256').update(core).digest('hex'));
  assert(result.source.includes('F-TOP-SEAL/prefix-3/candidateKind'));
  assert(result.source.includes('F-TOP-SEAL/prefix-4/event-time'));
  assert(result.source.includes('F-TOP-SEAL/prefix-4/prefix-reload'));
  assert(result.source.includes('F-TOP-SEAL/prefix-4/deep-copy-isolation'));
  assert(result.source.includes('F-TOP-SEAL/prefix-4/duplicate-input'));
  assert(result.source.includes('/leftId'));
});
test('missing, duplicate, or reversed markers fail instead of silently extracting wrong code', () => {
  assert.throws(() => extractCore('missing'));
  assert.throws(() => extractCore(source + '\n// BEGIN CHANLUN CORE'));
  assert.throws(() => extractCore('// END CHANLUN CORE\n// BEGIN CHANLUN CORE'));
});
test('draft and unsupported fixtures cannot silently become passing cases', () => {
  assert.throws(() => generateValidation(source, [{ ...fixture, expectationStatus: 'draft' }]), /unsupported/);
  assert.throws(() => generateValidation(source, [{ ...fixture, ruleIds: ['R-001'] }]), /unsupported/);
  assert.throws(() => generateValidation(source, []), /no reviewed/);
});
test('unknown state assertions are rejected instead of dropped', () => {
  const f = structuredClone(fixture); f.expected[0].state.unknownFlag = true;
  assert.throws(() => generateValidation(source, [f]), /unsupported K\/F assertion/);
});

test('pair assertions call the production qualification predicate without manufacturing stroke events', () => {
  const pair = JSON.parse(fs.readFileSync(new URL('../../tests/fixtures/chanlun/p-merged-distance.json', import.meta.url), 'utf8'));
  const result = generateValidation(source, [pair]);
  assert(result.source.includes('chan_stroke_eligible(first0, last0) == false'));
  assert(result.source.includes('P-MERGED-DISTANCE/prefix-1/strokeEligible'));
  assert(!result.source.includes('chan_case_0() =>\n    ChanState online'));
});

test('stroke lifecycle driver observes immutable event references and checks each prefix', () => {
  const fixture = JSON.parse(fs.readFileSync(new URL('../../tests/fixtures/chanlun/p-locked-prefix.json', import.meta.url), 'utf8'));
  const result = generateValidation(source, [fixture]);
  assert(result.source.includes('observed.push(online.strokeEvent)'));
  for (const prefix of [1, 3, 6]) {
    assert(result.source.includes(`P-LOCKED-PREFIX/prefix-${prefix}/prefix-reload`));
    assert(result.source.includes(`P-LOCKED-PREFIX/prefix-${prefix}/duplicate-event`));
    assert(result.source.includes(`P-LOCKED-PREFIX/prefix-${prefix}/deep-copy-isolation`));
  }
  assert(result.source.includes('P-LOCKED-PREFIX/prefix-6/stroke-1/confirmed-at'));
});

test('OHLC integration assertions observe both fractal and stroke event streams', () => {
  const fixture = JSON.parse(fs.readFileSync(new URL('../../tests/fixtures/chanlun/p-ohlc-integration.json', import.meta.url), 'utf8'));
  const result = generateValidation(source, [fixture]);
  assert(result.source.includes('observedFractals.push(online.event)'));
  assert(result.source.includes('observedStrokes.push(online.strokeEvent)'));
  assert(result.source.includes('P-OHLC-INTEGRATION/prefix-12/confirmedStrokes'));
  assert(result.source.includes('P-OHLC-INTEGRATION/prefix-12/stroke-confirmed-at'));
  assert(result.source.includes('P-OHLC-INTEGRATION/prefix-12/pending-lock-retained'));
  assert(result.source.includes('chan_stroke_pending(projected12, online.strokeCount)'));
  assert(result.source.includes('P-OHLC-INTEGRATION/prefix-12/intrabar-isolation'));
});

test('full segment driver checks independent expectations against the production S kernel', () => {
  for (const name of ['s-first-end', 's-first-continue', 's-first-wait-end', 's-first-wait-inclusion', 's-wait-direction-inside', 's-first-equal-third', 's-first-locked-prefix', 's-start-after-invalid', 's-special-internal-extreme', 's81-lower', 's81-equal', 's81-higher']) {
    const fixture = JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/chanlun/${name}.json`, import.meta.url), 'utf8'));
    assert.equal(fixture.expectationStatus, 'reviewed');
    const result=generateValidation(source,[fixture]);
    assert(result.source.includes('chan_segment_step(online,'));
    for(const {prefix} of fixture.expected) for(const check of ['confirmed-count','event-count','prefix-reload','duplicate-event','deep-copy-isolation','source-state-immutable']) assert(result.source.includes(`${fixture.id}/prefix-${prefix}/${check}`));
    assert(result.source.includes('observed.push(event)'));
  }
});
