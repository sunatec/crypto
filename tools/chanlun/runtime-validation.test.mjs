import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import test from 'node:test';
import {extractCore} from './build-validation.mjs';
import {generateRuntimeValidation,buildRuntimeValidation} from './build-runtime-validation.mjs';
const source=fs.readFileSync(new URL('../../chanlun_original.pine',import.meta.url),'utf8');
const load=n=>JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/chanlun/${n}.json`,import.meta.url),'utf8'));
const fixtures=()=>['p-ohlc-integration','n-own-ranges','n-second-batch'].map(load);
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
test('runtime driver binds original expectations and exact production close gate',()=>{
  const f=fixtures(),before=JSON.stringify(f),result=generateRuntimeValidation(source,...f);
  assert.equal(before,JSON.stringify(f));assert.equal(result.prefixes,38);assert.equal(result.cases,4);
  assert(result.source.includes(extractCore(source)));assert.equal(result.coreHash,sha(extractCore(source)));
  for(const label of ['no-open-delivery','tick-rollback','one-close','close-equivalence','independent-counts','independent-candidate','duplicate-close','prefix-reload','all-layers-open-isolation','batch-order-mapping','S-N-Z-delivery','duplicate-stream','deep-copy','sequential-two-strokes'])assert(result.source.includes(label),label);
  assert(result.bytes<110000);assert(result.source.includes('PASS: T4, 38 prefixes'));
});
test('chart uses tested frame events and sequential preview instead of independent scheduling',()=>{
  const chart=source.slice(source.indexOf('// ==================== Chart scheduling'));
  assert(chart.includes('chan_runtime_update(engine, incoming, barstate.isconfirmed)'));
  assert(chart.includes('if frame.submitted'));assert(chart.includes('frame.componentEvents.get(eventIndex)'));
  assert(!chart.includes('chan_step('));assert(!chart.includes('chan_normalization_step('));
  assert(chart.includes('chan_runtime_segment_preview(engine, visible, strokePreview)'));
  assert(!/ChanRuntime runtime\b/.test(chart));
  const preview=source.slice(source.indexOf('chan_runtime_segment_preview('),source.indexOf('// END CHANLUN CORE'));
  assert(preview.indexOf('strokes.push(visible.strokeEvent)')<preview.indexOf('strokes.push(projected.lastStroke)'));
  assert(!preview.includes('chan_normalization_step'));assert(!preview.includes('chan_center_step'));
});
test('runtime build binds pending artifact hash without declaring a Pine pass',()=>{
  const manifest=buildRuntimeValidation();assert.equal(manifest.sha256,sha(fs.readFileSync(manifest.output)));
  assert.equal(manifest.productionSha256,sha(source));assert.equal(manifest.execution,'not run in Pine');
});
