import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {generateBaselineShards,buildBaselineShards} from './build-validation-shards.mjs';
import {extractCore,generateValidation} from './build-validation.mjs';
const source=fs.readFileSync(new URL('../../chanlun_original.pine',import.meta.url),'utf8');
const directory=new URL('../../tests/fixtures/chanlun/',import.meta.url);
const fixtures=fs.readdirSync(directory).filter(n=>n.endsWith('.json')).sort().map(n=>JSON.parse(fs.readFileSync(new URL(n,directory),'utf8')));
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');

test('baseline shards cover eighteen reviewed fixtures once and separate input seams',()=>{
  const before=JSON.stringify(fixtures),groups=generateBaselineShards(source,fixtures);
  assert.deepEqual(groups.map(g=>[g.id,g.fixtureIds.length]),[['KF6',6],['P5',5],['P3A',3],['P3B',3],['I1',1]]);
  assert.equal(new Set(groups.flatMap(g=>g.fixtureIds)).size,18);
  assert.equal(JSON.stringify(fixtures),before);
  assert.deepEqual(groups.at(-1).fixtureIds,['P-OHLC-INTEGRATION']);
  assert(groups[0].fixtureIds.every(id=>id.startsWith('K-') || id.startsWith('F-')));
});
test('each shard embeds exact core and reports only its own coverage',()=>{
  for(const group of generateBaselineShards(source,fixtures)){
    assert(group.source.includes(extractCore(source)));
    assert.equal(group.coreHash,sha(extractCore(source)));
    assert.equal(group.sha256,sha(group.source));
    assert(group.source.includes(JSON.stringify(group.expectedDisplay)));
    for(const id of group.fixtureIds)assert(group.source.includes(id));
    assert(group.bytes<180000);
    assert(!group.source.includes('PASS: 18'));
    assert.equal(group.execution,'not run; compile and execute in TradingView');
  }
});
test('baseline build manifest binds each generated file',()=>{
  const result=buildBaselineShards(fileURLToPath(new URL('../../tmp/chanlun/test-baseline/',import.meta.url)));
  assert.equal(result.fixtureCount,18);assert.equal(result.files.length,5);
  for(const file of result.files)assert.equal(sha(fs.readFileSync(path.join(result.directory,file.file))),file.sha256);
  assert.equal(result.productionSha256,sha(source));
  assert.equal(result.status,'awaiting-platform-results');
});

test('OHLC integration splits long bodies without dropping any original assertion',()=>{
  const fixture=fixtures.find(f=>f.id==='P-OHLC-INTEGRATION');
  const original=generateValidation(source,[fixture]).source;
  const split=generateBaselineShards(source,fixtures).find(f=>f.id==='I1').source;
  assert.equal((split.match(/^chan_case_0_prefix_\d+\(/gm)||[]).length,12);
  const assertions=code=>code.split('\n').filter(line=>line.trimStart().startsWith('chan_assert('));
  assert.deepEqual(assertions(split),assertions(original));
  for(let prefix=1;prefix<=12;prefix++)assert(split.includes(`online := chan_case_0_prefix_${prefix}(online, observedFractals, observedStrokes)`));
  const functions=split.slice(split.indexOf('chan_case_0_prefix_1(')).split(/\n(?=chan_case_0)/);
  // Source-size guard only; the actual compiler verdict still comes from Pine.
  for(const body of functions)assert(Buffer.byteLength(body)<24000);
  assert(split.includes('chan_case_0_replay(int prefix) =>'));
  assert(split.includes('for i = 0 to prefix - 1'));
  assert(split.includes('state := chan_step(state, inputs.get(i))'));
  for(let prefix=1;prefix<=12;prefix++)assert(split.includes(`ChanState replay${prefix} = chan_case_0_replay(${prefix})`));
  const calls=code=>(code.match(/\bchan_step\(/g)||[]).length;
  assert(calls(split)<calls(original)/2);
});
