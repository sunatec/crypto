import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {generateValidation,buildValidation,extractCore} from './build-validation.mjs';

const source=fs.readFileSync(new URL('../../chanlun_original.pine',import.meta.url),'utf8');
const load=name=>JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/chanlun/${name}.json`,import.meta.url),'utf8'));

test('second-sequence driver asserts both simultaneous confirmations and their proof dependencies',()=>{
  const result=generateValidation(source,[load('s81-lower')]).source;
  assert(result.includes('online.events.size() == 2'));
  assert(result.includes('S81-LOWER/prefix-9/segment-1/confirmedAt'));
  assert(result.includes('S81-LOWER/prefix-9/segment-2/source-5'));
  for(const name of ['s81-equal','s81-higher']) {
    const negative=generateValidation(source,[load(name)]).source;
    assert(negative.includes('online.segmentCount == 0'));
    assert(!negative.includes('observed.get(0)'));
  }
});
test('segment budget cases use the production transition and forbid partial events or silent restart',()=>{
  const result=generateValidation(source,[load('s-first-end'),load('s-first-equal-third')]).source;
  for(const check of ['atomic-work-stop','preserve-unconsumed-input','blocked-future-does-not-restart','pending-cap-preserves-prefix']) assert(result.includes(`S-LIMIT/${check}`));
  assert(result.includes('chan_segment_limits()'));
  assert(result.includes('pending := chan_segment_step(pending,'));
});
test('unsupported segment assertions cannot be silently omitted',()=>{
  const fixture=load('s-first-end');fixture.expected[0].state.unknown=true;
  assert.throws(()=>generateValidation(source,[fixture]),/unsupported segment state/);
  const candidate=load('s-first-end');candidate.expected.at(-1).structures[0].status='candidate';
  assert.throws(()=>generateValidation(source,[candidate]),/unsupported segment structure/);
});
test('segment shard preserves the exact production kernel and excludes unrelated fixture drivers',()=>{
  const output=new URL('../../tmp/chanlun/test-shards/full.pine',import.meta.url);
  const result=buildValidation(fileURLToPath(output));
  const shard=fs.readFileSync(result.segmentOutput,'utf8');
  assert.equal(result.segmentFixtureIds.length,12);
  assert(shard.includes(extractCore(source)));
  for(const id of result.segmentFixtureIds) assert(shard.includes(id));
  assert(!shard.includes('P-OHLC-INTEGRATION'));
  assert(shard.includes('S-LIMIT/atomic-work-stop'));
});
test('special segment assertions retain original boundaries and owned internal extrema',()=>{
  const fixture=load('s-special-internal-extreme');
  const result=generateValidation(source,[fixture]).source;
  assert(result.includes('S-SPECIAL-INTERNAL-EXTREME/prefix-13/segment-2/source-9'));
  assert(result.includes('S-SPECIAL-INTERNAL-EXTREME/prefix-16/segment-2/member-High-witness'));
  assert(result.includes('S-SPECIAL-INTERNAL-EXTREME/prefix-16/segment-3/member-bound-3'));
});
test('first breaking stroke regressions preserve the unresolved prefixes independently of feature geometry',()=>{
  for(const name of ['s-first-wait-inclusion','s-wait-direction-inside']) {
    const fixture=load(name), generated=generateValidation(source,[fixture]).source;
    assert.equal(fixture.expected[7].state.confirmedSegments,0);
    assert(generated.includes(`${fixture.id}/prefix-8/confirmed-count`));
  }
});
test('Pine isolation probes bind returned objects before assigning UDT fields',()=>{
  const result=generateValidation(source,[load('s-first-equal-third')]).source;
  assert(result.includes('ChanSegmentHypothesis hypothesisProbe6 = copy6.hypotheses.first()'));
  assert(result.includes('hypothesisProbe6.priceTicks += 1'));
  assert(!/\(\)\.\w+\s*(?:\+=|:=|-=)/.test(result));
});
