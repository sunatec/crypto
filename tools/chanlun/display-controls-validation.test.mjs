import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import test from 'node:test';
import {extractCore,extractSection} from './build-validation.mjs';
import {generateDisplayControlsValidation,buildDisplayControlsValidation} from './build-display-controls-validation.mjs';
const source=fs.readFileSync(new URL('../../chanlun_original.pine',import.meta.url),'utf8');
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
test('display controls validate real renderer lifecycle with exact production core',()=>{
  const result=generateDisplayControlsValidation(source);
  assert(result.source.includes(extractCore(source)));assert(result.source.includes(extractSection(source,'RENDERER')));
  assert.equal(result.coreHash,sha(extractCore(source)));assert.equal(result.rendererHash,sha(extractSection(source,'RENDERER')));
  for(const label of ['global-quota','group-quota','degenerate-and-hide-label','stride-does-not-hide-line','selected-ordinal','candidate-always-labelled','candidate-sweep','remove-existing-caption','segment-stride','real-core-isolation'])assert(result.source.includes(label),label);
  assert(result.source.includes('PASS: D4, 4 cases'));assert(result.source.includes('合成展示 · 非行情识别'));
  assert(result.bytes<120000);assert(!/\(\)\.\w+\s*(?:\+=|:=|-=)/.test(result.source));
});
test('production visual controls affect renderer projections without entering calculation core',()=>{
  const renderer=extractSection(source,'RENDERER'),core=extractCore(source);
  assert.equal(sha(core),'f66e1055bf34300751ca977114e5ea6f0819d2b29594d0a80b87348ed7ef8e1f');
  assert(renderer.includes('style.centerWidth, confirmed'));
  assert(renderer.includes('stroke ? style.strokeLabelStride : style.segmentLabelStride'));
  assert(renderer.includes('chan_draw_remove_id(registry, source.id + "/caption")'));
  assert(source.includes('strokeStyle.centerWidth := centerWidth'));
  assert(source.includes('strokeStyle.strokeLabelStride := strokeLabelStride'));
  assert(source.includes('strokeStyle.segmentLabelStride := segmentLabelStride'));
  assert(source.includes('chan_draw_center(drawings, historicalCenter, syminfo.mintick, strokeStyle, showCenterIds)'));
  assert(!core.includes('showCenterIds'));assert(!core.includes('strokeLabelStride'));
});
test('display artifact binds exact requested bytes and renderer identity',()=>{
  const m=buildDisplayControlsValidation();assert.equal(m.sha256,sha(fs.readFileSync(m.output)));
  assert.equal(m.productionSha256,sha(source));assert.equal(m.execution,'not run in Pine');
});
