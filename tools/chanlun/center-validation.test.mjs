import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import test from 'node:test';
import {extractCore} from './build-validation.mjs';
import {validateCenterCases,generateCenterValidation,buildCenterValidation} from './build-center-validation.mjs';
const load=()=>JSON.parse(fs.readFileSync(new URL('../../tests/fixtures/chanlun/centers/cases.json',import.meta.url),'utf8'));
const source=fs.readFileSync(new URL('../../chanlun_original.pine',import.meta.url),'utf8');
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
test('manual center fixtures cover fixed core, Z-only statistics, degenerate contact and stopping',()=>{
  const data=validateCenterCases(load());assert.equal(data.cases.length,13);
  const up=data.cases.find(c=>c.id==='Z-UP-EXTEND');
  assert.deepEqual(up.expected.at(-1).core,[8,10]);assert.equal(up.expected.at(-1).stats[1],9);
  const middle=data.cases.find(c=>c.id==='Z-MIDDLE-NOT-WAVE');
  assert.equal(middle.inputs[1][3],20);assert.equal(middle.expected.at(-1).stats[0],15);
  assert(data.cases.some(c=>c.expected.some(e=>e?.pending)));
  assert(data.cases.some(c=>c.expected.some(e=>e?.blocked)));
  assert(data.cases.some(c=>c.expected.some(e=>e?.core[0]===e?.core[1])));
});
test('center contract rejects changed cores, missing prefixes, repeat events and unknown assertions',()=>{
  for(const mutate of [
    d=>{d.cases[0].expected.pop();},
    d=>{d.cases[0].expected[4].core=[8,9];},
    d=>{d.cases[0].expected[4].event=true;},
    d=>{d.cases[0].expected[2].event=false;},
    d=>{d.cases[0].expected[3].unknown=true;},
    d=>{d.cases[0].inputs[1][0]=9;},
  ]){const data=load();mutate(data);assert.throws(()=>validateCenterCases(data));}
});
test('center driver uses verbatim production core and only bounded prefix replay',()=>{
  const data=load(),before=JSON.stringify(data),result=generateCenterValidation(source,data);
  assert.equal(JSON.stringify(data),before);assert.equal(result.prefixes,91);
  assert(result.source.includes(extractCore(source)));assert.equal(result.coreHash,sha(extractCore(source)));
  for(const check of ['fixed-core','Z-statistics','formation-time','source-order','atomic-consumption','unique-formation','confirmed-event-immutable','prefix-reload','duplicate-state','copy-isolation','held-input','pending-ownership','closure-proof','closed-event-immutable','archive-order','relation-evidence'])assert(result.source.includes(check));
  assert(result.source.includes('for i = 0 to prefix\n        replay := chan_center_step'));
  assert(result.source.includes('PASS: 13 Z cases, 91 prefixes'));
  assert(result.bytes<130000);assert(!/\(\)\.\w+\s*(?:\+=|:=|-=)/.test(result.source));
  assert(!/ChanComponent input\s*=/.test(result.source));
});

test('manual pair evidence excludes connectors, includes returned waves, and can evolve without changing core',()=>{
  const data=load(),get=id=>data.cases.find(c=>c.id===id);
  const up=get('Z-UP-CONTINUATION');
  assert.equal(up.inputs[4][3],20);assert.equal(up.expected[5].stats[0],11);
  assert.equal(up.expected[5].leave,5);assert.equal(up.expected[5].extent,4);
  assert.equal(up.expected[7].relation,'up-continuation');
  assert.equal(up.expected.at(-1).count,3);assert.equal(up.expected.at(-1).start,12);
  assert.equal(up.expected.at(-1).relation,'up-continuation');
  assert.equal(get('Z-RETURN-MERGES').expected.at(-1).stats[0],20);
  const equal=get('Z-EQUAL-ENVELOPE');
  assert.equal(equal.expected.at(-1).stats[3],equal.expected[5].stats[0]);
  assert.equal(equal.expected.at(-1).relation,'range-overlap');
  const evolves=get('Z-RELATION-EVOLVES');
  assert.equal(evolves.expected[7].relation,'up-continuation');
  assert.equal(evolves.expected.at(-1).relation,'range-overlap');
  assert.deepEqual(evolves.expected[7].core,evolves.expected.at(-1).core);
});
test('center build binds exact generated artifact and production identities',()=>{
  const manifest=buildCenterValidation();const pine=fs.readFileSync(manifest.output);
  assert.equal(manifest.sha256,sha(pine));assert.equal(manifest.productionSha256,sha(source));
  assert.equal(manifest.execution,'not run in Pine');
});

test('shared-tail Z cases preserve the C99 price prefix and distinguish closure from extension',()=>{
  const fixtures=new URL('../../tests/fixtures/chanlun/',import.meta.url);
  const readFixture=name=>JSON.parse(fs.readFileSync(new URL(name,fixtures),'utf8'));
  const data=validateCenterCases(readFixture('centers/shared-tail.json'));
  const [closes,extendsCenter]=data.cases;
  const prices=fixture=>fixture.input.items.map(({startTicks,endTicks,lowTicks,highTicks})=>[startTicks,endTicks,lowTicks,highTicks]);
  assert.deepEqual(closes.inputs,prices(readFixture('r-c99-tail-absorb.json')));
  assert.deepEqual(extendsCenter.inputs,prices(readFixture('r-c99-tail-preserve.json')));
  assert.deepEqual(closes.inputs.slice(0,6),extendsCenter.inputs.slice(0,6));
  assert.deepEqual(closes.expected.slice(0,6),extendsCenter.expected.slice(0,6));
  assert.equal(closes.expected[6].pending,7);
  assert.equal(closes.expected[7].closedAt,8);
  assert.equal(extendsCenter.expected[7].closedEvent,undefined);
  assert.equal(extendsCenter.expected[7].extent,8);
  assert(generateCenterValidation(source,data).source.includes('PASS: 2 Z cases, 16 prefixes'));
});

test('center loader dispatch keeps expanded fixture data outside conditional branches',()=>{
  const result=generateCenterValidation(source,load());
  // Digest of the normalized assignment lines from the user-reported CE10205
  // artifact (83838b75...). Do not require mutable tmp artifacts to run tests.
  const dataLines=code=>code.split(/\r?\n/).map(s=>s.trim()).filter(s=>/^result\.(?:id|limit|inputs|expected) :=/.test(s));
  assert.equal(sha(dataLines(result.source).join('\n')),'3168bb9f58a683b791d54c79151515e58aa8811484b3ac2f02900d55d1d2d0d0','every case constructor and expected prefix must remain byte-identical');
  const harness=result.source.slice(result.source.indexOf('\ntype ChanZExpected'),result.source.indexOf('\nchan_zv_case_0()')).trimEnd();
  assert.equal(sha(harness),'48fe23988b9bee2cff631da8a4f41565069bff0092ec64946044a1600a26a43f','all assertions, replay, isolation probes and scheduling inputs stay unchanged');
  assert.equal((result.source.match(/^chan_zv_case_\d+\(\) =>/gm)||[]).length,13);
  const dispatcher=result.source.slice(result.source.indexOf('chan_zv_case(int index) =>')).split('\nvar int caseIndex')[0];
  assert(!dispatcher.includes('array.from('),'dispatcher must not expand fixture data');
  for(let i=0;i<13;i++)assert(dispatcher.includes(`result := chan_zv_case_${i}()`));
  assert(Buffer.byteLength(dispatcher)<1400,'source-size guard, not a measured Pine compiler limit');
});
