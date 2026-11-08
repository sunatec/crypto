import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import test from 'node:test';
import {extractCore} from './build-validation.mjs';
import {generateBudgetValidation,buildBudgetValidation} from './build-budget-validation.mjs';
const source=fs.readFileSync(new URL('../../chanlun_original.pine',import.meta.url),'utf8');
const read=n=>JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/chanlun/${n}.json`,import.meta.url),'utf8'));
const fixtures=()=>['s-first-end','s-first-equal-third','n-own-ranges'].map(read);
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
test('budget driver uses production stop paths and preserves independent inputs',()=>{
  const f=fixtures(),before=JSON.stringify(f),result=generateBudgetValidation(source,...f);
  assert.equal(JSON.stringify(f),before);assert.equal(result.cases,5);
  assert(result.source.includes(extractCore(source)));assert.equal(result.coreHash,sha(extractCore(source)));
  for(const label of ['no-partial-delivery','atomic-stop','held-input','upstream-continues','future-does-not-restart','atomic-stop-N-continues','blocked-future-keeps-first-held','KFP-continues','no-consumption','resource-over-wait','lowest-blocked-layer'])assert(result.source.includes(label),label);
  assert(result.source.includes('PASS: B5, 5 cases'));assert(result.bytes<105000);
});
test('chart gate and displayed status use the same tested functions',()=>{
  const chart=source.slice(source.indexOf('// ==================== Chart scheduling'));
  assert(chart.includes('chan_context_allows(supported, windowFrame)'));
  assert(chart.includes('chan_status_text(chan_status_code(engine, analysisWindow, supported))'));
  const core=extractCore(source),status=core.slice(core.indexOf('chan_status_code('));
  assert(status.indexOf('S_PENDING_LIMIT')<status.indexOf('HISTORY_SHORT'));
  for(const code of ['UNSUPPORTED','TRUNCATED','SAMPLE_LIMIT','S_PENDING_LIMIT','S_WORK_LIMIT','Z_SOURCE_LIMIT','HISTORY_SHORT','WAIT_START','INITIALIZING','S_PROOF_PENDING','Z_RETURN_PENDING','Z_NEW_PENDING'])assert(status.includes(code),code);
  const delivery=core.slice(core.indexOf('chan_runtime_component('),core.indexOf('chan_runtime_update('));
  assert(delivery.includes('chan_normalization_step(source.normalized, segment)'));
  assert(delivery.includes('chan_center_step(source.centers, state.normalized.event)'));
  assert(delivery.includes('result.committed := state'));
});
test('budget manifest binds pending artifact without assuming platform success',()=>{
  const manifest=buildBudgetValidation();assert.equal(manifest.sha256,sha(fs.readFileSync(manifest.output)));
  assert.equal(manifest.productionSha256,sha(source));assert.equal(manifest.execution,'not run in Pine');
});
