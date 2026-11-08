import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {validateFixture} from './check-fixtures.mjs';
import {componentFields} from './normalization-fixtures.mjs';
import {extractCore} from './build-validation.mjs';
import {buildNormalizationValidation,generateNormalizationValidation} from './build-normalization-validation.mjs';
const source=fs.readFileSync(new URL('../../chanlun_original.pine',import.meta.url),'utf8');
const load=name=>JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/chanlun/${name}.json`,import.meta.url),'utf8'));
const fixtures=['n-internal-low','n-ordinary','n-own-ranges','n-second-batch','n-wait-no-event'].map(load);
const rules=new Set(['N-001','E-008','S-001','S-002','S-003','E-007']);
const validate=f=>validateFixture(f,rules,new Set(f.source.sourceIds));
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');

test('independent interval expectations preserve source times, ownership and neighboring records',()=>{
  const fixture=load('n-own-ranges');validate(fixture);
  const [a,b,c]=fixture.expected.at(-1).structures;
  assert.equal(a.actualHighTicks,10);assert.equal(b.realStartTicks,10);assert.equal(b.analysisStartTicks,12);
  assert(b.actualHighTime>b.analysisStartTime);assert.equal(b.actualHighTicks,12);assert.equal(c.actualHighTicks,15);
  assert.deepEqual(fixture.expected[5].structures[0],a);
  const mirrored=load('n-internal-low');validate(mirrored);
  assert.equal(mirrored.expected.at(-1).structures[1].analysisStartTicks,-12);
  assert.equal(load('n-wait-no-event').expected.at(-1).state.normalizedCount,0);
  const batch=load('n-second-batch');assert.equal(batch.expected.at(-1).events.length,2);validate(batch);
});

test('normalization contract rejects unknown fields, changing confirmations and future or proof-only extrema',()=>{
  for(const mutate of [
    f=>{f.expected[0].state.unknown=true;},
    f=>{f.expected.at(-1).structures[1].unknown=true;},
    f=>{f.expected.at(-1).structures[0].analysisStartTicks-=1;},
    f=>{f.expected.at(-1).structures[1].actualHighTicks=15;f.expected.at(-1).structures[1].analysisStartTicks=15;},
    f=>{f.expected.at(-1).structures[1].actualHighTime=f.input.items.at(-1).completedAt;},
    f=>{f.expected[5].events=[];},
    f=>{f.expected[6].events.push({...f.expected[5].events[0]});},
    f=>{f.expected[6].structures=[];f.expected[6].state.normalizedCount=0;},
  ]){const fixture=load('n-own-ranges');mutate(fixture);assert.throws(()=>validate(fixture));}
});

test('N driver embeds exact production core and covers all rich mapping fields without mutating fixtures',()=>{
  const before=JSON.stringify(fixtures),result=generateNormalizationValidation(source,fixtures);
  assert.equal(result.fixtures.length,5);assert.equal(result.prefixes,59);assert.equal(result.requiredClosedBars,59);
  assert.equal(result.coreHash,sha(extractCore(source)));assert(result.source.includes(extractCore(source)));
  assert.equal(JSON.stringify(fixtures),before);
  for(const field of componentFields.filter(k=>k!=='dependencies'))assert(result.source.includes(`actual.${field} == expected.${field}`),field);
  for(const label of ['source-state-immutable','source-segment-immutable','duplicate-event','duplicate-state','reject-candidate','reject-outside-source','reject-missing-range','deep-copy-isolation','segment-prefix-reload','normalization-prefix-reload','event-count-and-batch-order'])assert(result.source.includes(label),label);
  assert(result.source.includes('for i = 0 to prefix'));
  assert(result.source.includes('observed.push(nextN.event)'));
  assert(result.source.includes('PASS: 5 N cases, 59 prefixes'));
  assert(result.bytes<120000);
  assert(!/\(\)\.\w+\s*(?:\+=|:=|-=)/.test(result.source));
  // Two extra call sites in the shared runtime and sequential preview helpers.
  assert.equal((result.source.match(/\bchan_segment_step\(/g)||[]).length,5);
  assert.equal(result.execution,'not run; compile and execute in TradingView');
});

test('N generator rejects draft, duplicate and unsupported fixtures',()=>{
  const fixture=load('n-ordinary');fixture.expectationStatus='draft';
  assert.throws(()=>generateNormalizationValidation(source,[fixture]));
  assert.throws(()=>generateNormalizationValidation(source,[]));
  assert.throws(()=>generateNormalizationValidation(source,[fixtures[0],fixtures[0]]));
  const unknown=load('n-ordinary');unknown.ruleIds.push('R-001');
  assert.throws(()=>generateNormalizationValidation(source,[unknown]));
});

test('N build records artifact and independent fixture identities',()=>{
  const output=fileURLToPath(new URL('../../tmp/chanlun/test-normalization.pine',import.meta.url));
  const result=buildNormalizationValidation(output),pine=fs.readFileSync(output,'utf8');
  assert.equal(result.sha256,sha(pine));assert.equal(result.productionSha256,sha(source));
  assert.equal(result.bytes,Buffer.byteLength(pine));
  assert.deepEqual(result.fixtures.map(f=>f.id).sort(),fixtures.map(f=>f.id).sort());
});
