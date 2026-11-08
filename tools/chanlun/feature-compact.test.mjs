import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {extractCore} from './build-validation.mjs';
import {encodeFeatureFixture,generateFeatureCompact,buildFeatureCompact} from './build-feature-compact.mjs';

const production=fs.readFileSync(new URL('../../chanlun_original.pine',import.meta.url),'utf8');
const directory=new URL('../../tests/fixtures/chanlun/',import.meta.url);
const fixtures=fs.readdirSync(directory).filter(n=>n.endsWith('.json')).sort().map(n=>JSON.parse(fs.readFileSync(new URL(n,directory),'utf8'))).filter(f=>f.input.kind==='feature-strokes');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');

// Decode only constructor literals (never execute generated code), so encoded
// data can be compared with all independent input and expectation fields.
function decode(text){
  let index=0;
  const space=()=>{while(/\s/.test(text[index]??'') && index<text.length)index++;};
  function value(){
    space();
    if(text[index]==='"'){
      const start=index++;
      while(index<text.length){if(text[index++]==='\\')index++;else if(text[index-1]==='"')return JSON.parse(text.slice(start,index));}
      assert.fail('unterminated string');
    }
    const literal=/^(?:-?\d+|true|false|na)\b/.exec(text.slice(index));
    if(literal){index+=literal[0].length;return literal[0]==='na'?null:JSON.parse(literal[0]);}
    const constructor=/^[\w.]+(?:<\w+>)?/.exec(text.slice(index));
    assert(constructor,'unexpected constructor');index+=constructor[0].length;space();assert.equal(text[index++],'(');
    const args=[];space();
    if(text[index]!==')')while(true){args.push(value());space();if(text[index]!==',')break;index++;}
    assert.equal(text[index++],')');
    return constructor[0].startsWith('array.')?args:{type:constructor[0],args};
  }
  const result=value();space();assert.equal(index,text.length);return result;
}

test('all sixteen feature cases round-trip every independent input and prefix field',()=>{
  const before=JSON.stringify(fixtures);
  assert.equal(fixtures.length,16);
  let prefixes=0;
  for(const fixture of fixtures){
    const encoded=encodeFeatureFixture(fixture),context=fixture.input.context;
    const dirs={up:1,down:-1,waiting:0};
    assert.deepEqual(decode(encoded.initial),{type:'chan_feature_new',args:[fixture.id,dirs[context.segmentDirection],dirs[context.initialDirection],dirs[context.postDirection],context.boundaryTime,context.secondSequence,context.maxElements,context.maxSources]});
    const inputs=decode(encoded.inputs);
    assert.equal(inputs.length,fixture.input.items.length);
    for(const [i,input] of fixture.input.items.entries())assert.deepEqual(inputs[i],{type:'ChanStructure.new',args:[input.id,'stroke',0,dirs[input.direction],input.startTime,input.endTime,input.startTicks,input.endTicks,true,input.completedAt,'P-001/P-002',input.dependencies,input.ordinal]});
    assert.equal(encoded.rows.length,fixture.expected.length);
    for(const [i,snapshot] of fixture.expected.entries()){
      const row=decode(encoded.rows[i]),state=snapshot.state;
      assert.equal(row.type,'ChanFVExpected.new');
      assert.deepEqual(row.args.slice(0,10),[state.inputCount,state.selectedCount,dirs[state.mergeDirection],state.boundaryCuts,state.waitingDirection,state.blocked,state.heldId??'',{none:0,top:1,bottom:-1}[state.turnKind],state.gap??false,state.seedEligible]);
      const fields=['id','lowTicks','highTicks','lowTime','highTime','firstTime','lastTime','firstOrdinal','lastOrdinal','firstSide','lastSide','availableAt','sealed','sourceIds'];
      assert.deepEqual(row.args[10].map(feature=>{assert.equal(feature.type,'ChanFeature.new');assert.equal(feature.args.length,fields.length);return Object.fromEntries(fields.map((field,j)=>[field,feature.args[j]]));}),state.features);
      prefixes++;
    }
    assert.equal(encoded.fixtureHash,sha(JSON.stringify(fixture)));
  }
  assert.equal(prefixes,101);
  assert.equal(JSON.stringify(fixtures),before);
});

test('compact driver uses exact CORE and retains state, turn, provenance and lifecycle assertions',()=>{
  const result=generateFeatureCompact(production,fixtures),source=result.source;
  assert(source.includes(extractCore(production)));
  assert.equal(result.coreHash,sha(extractCore(production)));
  assert.equal(result.sha256,sha(source));
  assert.deepEqual([result.cases,result.prefixes,result.expectedDisplay],[16,101,'PASS: F16, 101 prefixes']);
  assert(result.bytes<150000);
  for(const check of ['inputCount','selectedCount','mergeDirection','boundaryCuts','waitingDirection','blocked','held-input','feature-count','source-count','source-','segment-seed-eligibility','no-turn','turn-exists','turn-kind-gap','turn-endpoint','turn-leftId','turn-middleId','turn-rightId','turn-availability','prefix-reload','duplicate-input','deep-copy-isolation','initial-isolation'])assert(source.includes('"/'+check+'"'),check);
  for(const field of ['id','lowTicks','highTicks','lowTime','highTime','firstTime','lastTime','firstOrdinal','lastOrdinal','firstSide','lastSide','availableAt','sealed'])assert(source.includes(`actual.${field} == expected.${field}`));
  assert(source.includes('for i = 0 to index'));
  assert(source.includes('if barstate.isconfirmed and caseIndex < 16'));
  assert.equal((source.match(/online := chan_fv_prefix\(/g)||[]).length,1);
  assert.equal((source.match(/^chan_fv_case_\d+\(\) =>/gm)||[]).length,16);
  assert(!source.includes('chan_case_0()'));
  assert.equal(result.execution,'not run in Pine');
});

test('encoding rejects omitted expectations, unknown fields, draft and duplicate cases',()=>{
  for(const mutate of [f=>f.expected.pop(),f=>{f.expected[0].state.unknown=true;},f=>{f.expectationStatus='draft';},f=>{f.expected[1].state.features[0].sourceIds=['future'];}]){
    const bad=structuredClone(fixtures.find(f=>f.id==='S-FEATURE-UP'));mutate(bad);assert.throws(()=>encodeFeatureFixture(bad));
  }
  assert.throws(()=>generateFeatureCompact(production,[]),/no feature/);
  assert.throws(()=>generateFeatureCompact(production,[fixtures[0],fixtures[0]]),/duplicate/);
});

test('build manifest binds current production and exact executable artifact without a platform-pass claim',()=>{
  const output=fs.mkdtempSync(path.join(os.tmpdir(),'chanlun-feature-'));
  try{
    const manifest=buildFeatureCompact(output);
    assert.equal(manifest.productionSha256,sha(production));
    assert.equal(manifest.sha256,sha(fs.readFileSync(manifest.output)));
    assert.equal(manifest.bytes,fs.statSync(manifest.output).size);
    assert.deepEqual(JSON.parse(fs.readFileSync(manifest.output+'.json','utf8')),manifest);
    assert.equal(manifest.execution,'not run in Pine');
  }finally{
    for(const name of ['feature-compact-validation.pine','feature-compact-validation.pine.json'])if(fs.existsSync(path.join(output,name)))fs.unlinkSync(path.join(output,name));
    fs.rmdirSync(output);
  }
});
