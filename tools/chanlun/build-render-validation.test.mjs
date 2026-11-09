import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import { extractCore, extractSection } from './build-validation.mjs';
import { generateRenderValidation } from './build-render-validation.mjs';

const production = fs.readFileSync(new URL('../../chanlun_original.pine', import.meta.url), 'utf8');
const hash = source => crypto.createHash('sha256').update(source).digest('hex');

test('display validation executes the identical production renderer and core', () => {
  const result = generateRenderValidation(production);
  const core = extractCore(production);
  const renderer = extractSection(production, 'RENDERER');
  assert(result.source.includes(core));
  assert(result.source.includes(renderer));
  assert.equal(result.coreHash, hash(core));
  assert.equal(result.rendererHash, hash(renderer));
  assert(!renderer.includes('input.'));
  assert(!renderer.includes('request.security'));
  assert(result.source.includes('非行情分析'));
  assert.match(result.source, /indicator\([^\n]+overlay = false/);
  for (const caption of ['L1-M#1 · 盘整', 'L2-M#1 · 待定 · 进行中', 'L3-M#1 · 下跌']) {
    assert(result.source.includes(caption));
  }
  assert(result.source.includes('label.get_text(caption.labelId) == expectedCaption'));
});

test('a missing or duplicate display boundary cannot silently omit renderer checks', () => {
  assert.throws(() => generateRenderValidation(production.replace('// END CHANLUN RENDERER', '')));
  assert.throws(() => generateRenderValidation(production + '\n// BEGIN CHANLUN RENDERER'));
  assert.throws(() => extractSection(production, 'UNKNOWN'));
});
