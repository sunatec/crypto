import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import test from 'node:test';
import {extractCore} from './build-validation.mjs';
import {validateRecursionCases,validateChainCases,generateRecursionValidation,generateChainValidation} from './build-recursion-validation.mjs';
const load=()=>JSON.parse(fs.readFileSync(new URL('../../tests/fixtures/chanlun/recursion/structure-completion.json',import.meta.url),'utf8'));
const loadChain=()=>JSON.parse(fs.readFileSync(new URL('../../tests/fixtures/chanlun/recursion/level-chain.json',import.meta.url),'utf8'));
const source=fs.readFileSync(new URL('../../chanlun_original.pine',import.meta.url),'utf8');
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
test('R fixtures encode the rules table: two completions, no early completion on the counterexamples',()=>{
  const data=validateRecursionCases(load());assert.equal(data.cases.length,9);
  const positive=data.cases.find(c=>c.id==='R-STRUCT-POSITIVE');
  const events=positive.expected.map((e,i)=>e.event?{prefix:i+1,...e.event}:null).filter(Boolean);
  assert.deepEqual(events.map(e=>e.prefix),[11,18]);
  assert.deepEqual(events.map(e=>e.type),['trend','consolidation']);
  assert.deepEqual(events.map(e=>e.range),[[4,20],[4,18]]);
  assert.deepEqual(events.map(e=>e.end),[[7,4],[14,18]]);
  assert.deepEqual(events.map(e=>[e.truncated,e.upper]),[[true,false],[false,true]]);
  for(const id of ['R-STRUCT-RETURN-TOUCH','R-STRUCT-SAME-SIDE','R-C99-TAIL-ABSORB-NO-COMPLETION','R-C99-TAIL-PRESERVE-NO-COMPLETION','R-STRUCT-MEMBER-BUDGET']){
    const c=data.cases.find(x=>x.id===id);assert(c,id);
    const completions=c.expected.filter(e=>e.event).length;
    assert.equal(completions,id==='R-STRUCT-RETURN-TOUCH'||id==='R-STRUCT-SAME-SIDE'?1:0,id);
  }
  const touch=data.cases.find(c=>c.id==='R-STRUCT-RETURN-TOUCH');
  assert.equal(touch.expected.at(-1).done,1);assert.equal(touch.expected.at(-1).members,11);
  const budget=data.cases.find(c=>c.id==='R-STRUCT-MEMBER-BUDGET');
  assert.equal(budget.maxMembers,5);assert(budget.expected.slice(5).every(e=>e.blocked&&e.kind==='budget'&&e.held===6&&e.members===5));
});
test('R contract rejects early completion, rewritten endpoints, missing prefixes and unknown assertions',()=>{
  for(const mutate of [
    d=>{d.cases[0].expected.pop();},
    d=>{d.cases[0].expected[5].done=1;},
    d=>{d.cases[0].expected[10].event=undefined;},
    d=>{d.cases[0].expected[10].event.members[1]=6;},
    d=>{d.cases[0].expected[10].event.upper=true;},
    d=>{d.cases[0].expected[10].first=7;},
    d=>{d.cases[0].expected[3].unknown=true;},
    d=>{d.cases[0].expected[17].event.centers=2;},
    d=>{d.cases[0].inputs[1][0]=9;},
    d=>{d.cases[5].expected[5].held=0;},
  ]){const data=load();mutate(data);assert.throws(()=>validateRecursionCases(data));}
});
test('R driver uses the verbatim production core and replays only bounded prefixes',()=>{
  const data=load(),result=generateRecursionValidation(source,data),core=extractCore(source);
  assert(result.source.includes(core));assert.equal(result.coreHash,sha(core));
  assert.equal(result.cases,9);assert.equal(result.prefixes,133);
  for(const label of ['source-immutable','completion-event','unique-completion','completion-immutable','prefix-reload','duplicate-event','duplicate-state','copy-isolation','atomic-consumption','upper-component','center-set','stop-kind','capped'])assert(result.source.includes(label),label);
  assert(result.source.includes('PASS: 9 R cases, 133 prefixes'));
  assert(!/\(\)\.\w+\s*(?:\+=|:=|-=)/.test(result.source));assert(result.bytes<200000);
  assert.equal(result.execution,'not run in Pine');
});
test('R engine lives inside the shared core and exposes no drawing or display input',()=>{
  const core=extractCore(source);
  for(const name of ['chan_movement_new','chan_movement_step','chan_movement_complete','chan_movement_clone','chan_movement_signature'])assert(core.includes(name+'('),name);
  assert(core.includes('chan_movement_step(source.movements, part, result.centers)'));assert(core.includes('chan_stack_step(stack, state.normalized.event)'));
  const start=core.indexOf('type ChanMovementState'),end=core.indexOf('type ChanRuntime\n');
  const block=core.slice(start,end);
  for(const banned of ['line.new','label.new','box.new','barstate','chan_draw','showCenters'])assert(!block.includes(banned),banned);
  assert(!/\binput\.(int|bool|string|color|float|time)\(/.test(block),'display input in R block');
});

test('level fixtures: upper layers keep the same completions, only the time seam is required, the top layer is capped',()=>{
  const data=validateRecursionCases(load());
  const pos=data.cases.find(c=>c.id==='R-STRUCT-POSITIVE'),l2=data.cases.find(c=>c.id==='R-L2-POSITIVE'),gap=data.cases.find(c=>c.id==='R-L2-GAP-ADJACENCY'),cap=data.cases.find(c=>c.id==='R-L3-CAP');
  assert.equal(l2.level,2);assert.deepEqual(l2.expected,pos.expected);assert.deepEqual(gap.expected,pos.expected);
  assert.notEqual(gap.inputs[8][0],gap.inputs[7][1]);assert.equal(gap.level,2);
  assert.equal(cap.level,3);assert.equal(cap.submit,false);
  assert.equal(cap.expected[17].capped,true);assert.equal(cap.expected[17].submitted,0);assert.equal(cap.expected[17].event.upper,false);
  assert(cap.expected.slice(0,17).every(e=>!e.capped));
});
test('chain fixtures: L1 parts reach L2 in order and a cap of 1 submits nothing',()=>{
  const data=validateChainCases(loadChain());assert.equal(data.cases.length,3);
  const three=data.cases.find(c=>c.levelLimit===3),one=data.cases.find(c=>c.levelLimit===1);
  assert.deepEqual(three.expected.filter(x=>x.l1.event).map(x=>x.l2in),[0,1,2,3]);
  const formed=three.expected.findIndex(x=>x.l2);assert.equal(formed,27);
  assert.deepEqual(three.expected[27].l2.core,[9,17]);assert.deepEqual(three.expected[27].l2.stats,[18,17,9,4]);
  assert(one.expected.every(x=>x.l2in===0&&x.l2centers===0&&!x.l2));
  assert.equal(one.expected[17].l1.capped,true);assert.equal(one.expected[10].l1.capped,false);
  assert(one.expected.every(x=>x.l1.submitted===0));
  for(const mutate of [
    d=>{d.cases[0].expected[27].l2=undefined;},
    d=>{d.cases[0].expected[20].l2in=2;},
    d=>{d.cases[0].expected[27].l2.from=2;},
    d=>{d.cases[2].expected[17].l1.capped=false;},
    d=>{d.cases[0].expected[10].l3in=1;},
  ]){const bad=loadChain();mutate(bad);assert.throws(()=>validateChainCases(bad));}
});
test('chain driver shares chan_stack_step with the runtime and checks provenance and isolation',()=>{
  const data=loadChain(),result=generateChainValidation(source,data),core=extractCore(source);
  assert(result.source.includes(core));assert.equal(result.coreHash,sha(core));
  assert.equal(result.cases,3);assert.equal(result.prefixes,84);assert(result.source.includes('PASS: 3 chain cases, 84 prefixes'));
  for(const label of ['L2-source-provenance','upper-layers-do-not-rewrite-L1','L1-completion-immutable','L2-formation-immutable','prefix-reload','duplicate-event','copy-isolation','L2-inputs','L3-inputs','L2-core'])assert(result.source.includes(label),label);
  assert(core.includes('chan_stack_step(stack, state.normalized.event)'));assert(result.bytes<200000);
});
