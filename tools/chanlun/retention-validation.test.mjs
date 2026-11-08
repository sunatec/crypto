import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import test from 'node:test';
import {extractCore} from './build-validation.mjs';
import {generateRetentionValidation,buildRetentionValidation} from './build-retention-validation.mjs';
const source=fs.readFileSync(new URL('../../chanlun_original.pine',import.meta.url),'utf8');
const read=p=>JSON.parse(fs.readFileSync(new URL('../../tests/fixtures/chanlun/'+p,import.meta.url),'utf8'));
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
test('retention expectations describe connected long input and independently fixed terminal summaries',()=>{
  const d=read('retention/cases.json'),f=read('n-own-ranges.json'),before=JSON.stringify([d,f]);
  const result=generateRetentionValidation(source,d,f);
  assert.equal(JSON.stringify([d,f]),before);assert.equal(result.cases,3);assert.equal(result.prefixes,338);
  assert.equal(d.centers.points.at(-1),d.centers.points[0]+d.centers.translation);
  assert(d.centers.expectedCount>d.centers.archiveSize);assert.equal(d.centers.oldestOrdinal,6);
  assert.deepEqual(d.centers.lastCore,[384,390]);assert.deepEqual(d.centers.nextCore,[404,410]);
  assert.equal(f.expected.at(-1).state.normalizedCount,d.strokes.expectedSegments);
});
test('retention driver embeds unchanged production core and checks behavior after reclamation',()=>{
  const result=generateRetentionValidation(source,read('retention/cases.json'),read('n-own-ranges.json'));
  assert(result.source.includes(extractCore(source)));assert.equal(result.coreHash,sha(extractCore(source)));
  for(const label of ['cumulative-counts','bounded-tail','retained-ordinals','reclaimed-prefix-boundary','bounded-dependency-tail','closed-record-survives-reclaim','previous-independent-of-archive','independent-clipped-archive','continued-after-reclaim','reload-after-reclaim'])assert(result.source.includes(label),label);
  assert(result.source.includes('PASS: G3, 338 prefixes'));assert(result.bytes<100000);
  assert(!/\(\)\.\w+\s*(?:\+=|:=|-=)/.test(result.source));
});
test('retention artifact records exact bytes and remains pending platform execution',()=>{
  const manifest=buildRetentionValidation();assert.equal(manifest.sha256,sha(fs.readFileSync(manifest.output)));
  assert.equal(manifest.productionSha256,sha(source));assert.equal(manifest.execution,'not run in Pine');
});
