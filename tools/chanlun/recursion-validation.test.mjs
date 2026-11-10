import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import test from 'node:test';
import {extractCore} from './build-validation.mjs';
import {validateRecursionCases,generateRecursionValidation} from './build-recursion-validation.mjs';
const load=()=>JSON.parse(fs.readFileSync(new URL('../../tests/fixtures/chanlun/recursion/structure-completion.json',import.meta.url),'utf8'));
const source=fs.readFileSync(new URL('../../chanlun_original.pine',import.meta.url),'utf8');
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
test('R fixtures encode the rules table: two completions, no early completion on the counterexamples',()=>{
  const data=validateRecursionCases(load());assert.equal(data.cases.length,6);
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
  assert.equal(result.cases,6);assert.equal(result.prefixes,79);
  for(const label of ['source-immutable','completion-event','unique-completion','completion-immutable','prefix-reload','duplicate-event','duplicate-state','copy-isolation','atomic-consumption','upper-component','center-set','stop-kind'])assert(result.source.includes(label),label);
  assert(result.source.includes('PASS: 6 R cases, 79 prefixes'));assert(result.source.includes('不验证L2提交'));
  assert(!/\(\)\.\w+\s*(?:\+=|:=|-=)/.test(result.source));assert(result.bytes<200000);
  assert.equal(result.execution,'not run in Pine');
});
test('R engine lives inside the shared core and exposes no drawing or display input',()=>{
  const core=extractCore(source);
  for(const name of ['chan_movement_new','chan_movement_step','chan_movement_complete','chan_movement_clone','chan_movement_signature'])assert(core.includes(name+'('),name);
  assert(core.includes('chan_movement_step(source.movements, state.normalized.event, state.centers)'));
  const start=core.indexOf('type ChanMovementState'),end=core.indexOf('type ChanRuntime\n');
  const block=core.slice(start,end);
  for(const banned of ['line.new','label.new','box.new','barstate','chan_draw','showCenters'])assert(!block.includes(banned),banned);
  assert(!/\binput\.(int|bool|string|color|float|time)\(/.test(block),'display input in R block');
});
