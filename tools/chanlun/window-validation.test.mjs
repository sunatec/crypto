import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import test from 'node:test';
import {extractCore} from './build-validation.mjs';
import {validateWindowCases,generateWindowValidation,buildWindowValidation} from './build-window-validation.mjs';
const read=p=>JSON.parse(fs.readFileSync(new URL('../../tests/fixtures/chanlun/'+p,import.meta.url),'utf8'));
const load=()=>read('windows/cases.json');
const production=fs.readFileSync(new URL('../../chanlun_original.pine',import.meta.url),'utf8');
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
test('manual window expectations preserve opens, duplicate closes, fixed cap and ongoing automatic context',()=>{
  const data=validateWindowCases(load());assert.equal(data.cases.length,7);
  const auto=data.cases.find(c=>c.id==='W-AUTO-ANCHOR');assert.equal(auto.rows.at(-1)[5],4);assert.equal(auto.config[2],3);
  const fixed=data.cases.find(c=>c.id==='W-FIXED-CAP');assert.equal(fixed.rows[4][5],2);assert.equal(fixed.rows[5][8],false);assert.equal(fixed.rows[7][8],true);
  for(const mutate of [d=>d.cases[0].rows[2][5]=1,d=>d.cases[0].rows[0].pop(),d=>d.cases[0].rows[0][3]=1,d=>d.cases[0].config[5]=0]){const d=load();mutate(d);assert.throws(()=>validateWindowCases(d));}
});
test('window driver uses production gate and independent rows with bounded prefix reload',()=>{
  const data=load(),before=JSON.stringify(data),result=generateWindowValidation(production,data,read('p-ohlc-integration.json'));
  assert.equal(JSON.stringify(data),before);assert.equal(result.prefixes,44);assert.equal(result.cases,8);
  assert.equal(result.coreHash,sha(extractCore(production)));assert(result.source.includes(extractCore(production)));
  for(const label of ['source-immutable','actual-start','frozen-boundary','history-missing','preview-no-consumption','prefix-reload','W-INTEGRATION/consumption','W-INTEGRATION/stopped','W-INTEGRATION/reload'])assert(result.source.includes(label));
  assert(result.source.includes('PASS: W8, 44 prefixes'));assert(result.bytes<110000);
  const chart=production.slice(production.indexOf('// ==================== Chart scheduling'));
  assert(chart.includes('var ChanWindow analysisWindow = chan_window_new'));
  assert(chart.includes('chan_window_step(analysisWindow, time, bar_index, supported and barstate.isconfirmed)'));
  assert(!chart.includes('bar_index >= last_bar_index - initialBars'));
  assert(/if supported and inRange\r?\n/.test(chart));
  assert(!chart.includes('if supported and inRange and not limited'));
});
test('window artifact manifest binds requested bytes without claiming platform execution',()=>{
  const manifest=buildWindowValidation();assert.equal(manifest.sha256,sha(fs.readFileSync(manifest.output)));
  assert.equal(manifest.productionSha256,sha(production));assert.equal(manifest.execution,'not run in Pine');
});
