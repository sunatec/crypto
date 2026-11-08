import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {buildCompactValidation,encodeSegmentFixture,generateCompactValidation} from './build-segment-compact.mjs';
import {extractCore,generateValidation} from './build-validation.mjs';

const source=fs.readFileSync(new URL('../../chanlun_original.pine',import.meta.url),'utf8');
const load=name=>JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/chanlun/${name}.json`,import.meta.url),'utf8'));
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const fixtures=fs.readdirSync(new URL('../../tests/fixtures/chanlun/',import.meta.url)).filter(n=>n.endsWith('.json')).sort()
  .map(n=>load(n.slice(0,-5))).filter(f=>f.expectationStatus==='reviewed' && f.input.kind==='completed-components' && f.ruleIds.every(id=>['S-001','S-002','S-003','E-007'].includes(id)));

test('compact suite retains exact production CORE and independently specified fixture data',()=>{
  const before=JSON.stringify(fixtures),result=generateCompactValidation(source,fixtures);
  assert.equal(fixtures.length,12);
  assert.equal(result.prefixes,110);
  assert.equal(result.requiredClosedBars,111);
  assert.equal(result.coreHash,hash(extractCore(source)));
  assert(result.source.includes(extractCore(source)));
  assert.equal(JSON.stringify(fixtures),before);
  for(const fixture of fixtures){
    const encoded=encodeSegmentFixture(fixture);
    assert(result.source.includes(encoded.input));
    assert(result.source.includes(encoded.expected));
    assert.equal(encoded.fixtureHash,hash(JSON.stringify(fixture)));
  }
});

test('compact data binds simultaneous event order and segment parent aliases',()=>{
  const fixture=load('s81-lower'),data=encodeSegmentFixture(fixture);
  assert.equal(data.events,2);
  assert.equal(data.ordinals,'array.from(1, 2)');
  assert.equal(data.counts,'array.from(0, 0, 0, 0, 0, 0, 0, 0, 2)');
  // Encoding-only mutation: test stable identity binding without asserting a new market case.
  for(const snapshot of fixture.expected) if(snapshot.structures.length>1) snapshot.structures[1].dependencies.push('segment-1');
  assert(encodeSegmentFixture(fixture).expected.includes('"S81-LOWER/S/1/1701000000000"'));
});

test('compact encoder rejects assertions the driver cannot represent',()=>{
  for(const mutate of [
    f=>{f.expected[0].state.unknown=true;},
    f=>{f.expected.at(-1).structures[0].unknown=true;},
    f=>{f.expected.at(-1).events[0].unknown=true;},
    f=>{f.expected.at(-1).structures[0].direction='sideways';},
    f=>{f.expectationStatus='draft';},
  ]){
    const fixture=load('s-first-end');mutate(fixture);
    assert.throws(()=>encodeSegmentFixture(fixture));
  }
});

test('compact encoder rejects changing confirmed history, duplicate or unbound events',()=>{
  for(const mutate of [
    f=>{f.expected.at(-1).structures[0].endTicks+=1;},
    f=>{f.expected.at(-1).structures=[];f.expected.at(-1).state.confirmedSegments=0;f.expected.at(-1).events=[];},
    f=>{f.expected[6].events.push({...f.expected[5].events[0]});},
    f=>{f.expected[5].events[0].objectId='missing';},
    f=>{f.expected[5].events[0].confirmedAt+=1;},
    f=>{f.expected[5].events=[];},
  ]){
    const fixture=load('s-first-locked-prefix');mutate(fixture);
    assert.throws(()=>encodeSegmentFixture(fixture));
  }
});

test('source size and transition call sites shrink without claiming Pine compile timing',()=>{
  const result=generateCompactValidation(source,fixtures),legacy=generateValidation(source,fixtures).source;
  assert(result.bytes<Buffer.byteLength(legacy)*0.2);
  assert.equal(result.segmentCallSites,10); // Two shared runtime/preview call sites.
  const smoke=generateCompactValidation(source,[load('s-first-wait-inclusion')]);
  // Source-size guard grows with the shared N/Z/runtime core; no compiler limit implied.
  assert(smoke.bytes<90000);
  assert.equal(smoke.segmentCallSites,6);
  assert.equal(smoke.fixtures.length,1);
  assert.equal(smoke.prefixes,10);
  assert.equal(smoke.requiredClosedBars,10);
  assert.equal(smoke.resourceChecks,false);
  assert(!smoke.source.includes('chan_cv_limits'));
});

test('shared driver checks each prefix, retained records, events, replay and copy isolation',()=>{
  const {source:pine}=generateCompactValidation(source,fixtures);
  for(const text of ['source-state-immutable','confirmed-count','member-extreme-witness','event-count','prefix-reload','duplicate-event','duplicate-state','deep-copy-isolation','within-budgets','atomic-work-stop','preserve-unconsumed-input','blocked-future-does-not-restart','pending-cap-preserves-prefix']) assert(pine.includes(text),text);
  assert(pine.includes('for i = 0 to prefix\n        replay := chan_segment_step'));
  assert(pine.includes('chan_cv_record(observed.get(i), fixture.expected.get(i), fixture, prefix'));
  assert(pine.includes('if barstate.isconfirmed and (na(lastProcessedBar) or bar_index != lastProcessedBar)'));
  assert(pine.includes('bool passed = caseIndex == 12 and budgetsDone'));
  assert(pine.includes('需要111根已收盘图表K线'));
  assert(!/\(\)\.\w+\s*(?:\+=|:=|-=)/.test(pine));
  assert.equal((pine.match(/online := chan_cv_prefix\(/g)||[]).length,1);
  assert(pine.includes('/confirmed-count expected='));
  assert(pine.includes('str.tostring(next.segmentCount)'));
  assert(pine.includes('for record in observed'));
  assert(pine.includes('record.ruleId'));
});

test('build emits twelve single cases, one smoke and one full suite with verifiable manifest',()=>{
  const directory=fileURLToPath(new URL('../../tmp/chanlun/test-compact/',import.meta.url));
  const result=buildCompactValidation(directory);
  assert.equal(result.status,'awaiting-cloud-compilation');
  assert.equal(result.productionSha256,hash(source));
  assert.equal(result.files.length,14);
  for(const entry of result.files){
    const pine=fs.readFileSync(path.join(directory,entry.file),'utf8');
    assert.equal(entry.sha256,hash(pine));
    assert.equal(entry.coreHash,hash(extractCore(source)));
    assert.equal(entry.bytes,Buffer.byteLength(pine));
    assert.equal(entry.resourceChecks,entry.file==='all-cases.pine');
    if(entry.file!=='all-cases.pine'){
      assert.equal(entry.fixtures.length,1);
      assert(!pine.includes('PASS: 12'));
    }
  }
  assert.equal(new Set(result.files.filter(f=>f.file.startsWith('cases')).flatMap(f=>f.fixtures.map(x=>x.id))).size,12);
  const manifest=JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'),'utf8'));
  assert.deepEqual(manifest.files,result.files);
});
