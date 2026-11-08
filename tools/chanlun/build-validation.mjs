import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDirectory } from './check-fixtures.mjs';
import { generateStrokeCase } from './stroke-validation.mjs';
import { generateFeatureCase } from './feature-validation.mjs';
import { generateSegmentCase, generateSegmentLimits } from './segment-validation.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const supportedRules = new Set(['K-001', 'K-002', 'F-001', 'F-002', 'P-001', 'P-002', 'S-001', 'S-002', 'S-003', 'E-007', 'E-006', 'E-005', 'E-001', 'E-002', 'E-003']);
const q = value => JSON.stringify(value);
const raw = r => `ChanRaw.new(${r.time}, ${r.closeTime}, ${r.openTicks}, ${r.highTicks}, ${r.lowTicks}, ${r.closeTicks})`;
const fractal = f => `ChanFractal.new(${q(f.id)}, ${f.kind === 'top' ? 1 : -1}, ${f.endpointTime}, ${f.priceTicks}, ${f.confirmedAt}, ${q(f.leftId)}, ${q(f.middleId)}, ${q(f.rightId)}, "F-001/F-002", ${f.leftOrdinal}, ${f.middleOrdinal}, ${f.rightOrdinal}, ${f.middleHighTicks}, ${f.middleLowTicks})`;
export function extractSection(source, section) {
  assert(['CORE', 'RENDERER'].includes(section), 'unknown shared section');
  const start = `// BEGIN CHANLUN ${section}`, end = `// END CHANLUN ${section}`;
  assert.equal(source.split(start).length, 2, 'expected exactly one core start');
  assert.equal(source.split(end).length, 2, 'expected exactly one core end');
  assert(source.indexOf(start) < source.indexOf(end), 'reversed core markers');
  return source.slice(source.indexOf(start) + start.length, source.indexOf(end)).trim();
}
export function extractCore(source) {
  return extractSection(source, 'CORE');
}
function assertion(expression, context) {
  return `    chan_assert(${expression}, ${q(context)})`;
}
function stateChecks(state, fixture, snapshot, tail) {
  const result = [];
  const context = `${fixture.id}/prefix-${snapshot.prefix}`;
  for (const [key, value] of Object.entries(snapshot.state)) {
    let expression;
    if (['processedCount', 'confirmedFractals', 'effectiveStart'].includes(key)) expression = `${state}.${key}`;
    else if (key === 'direction') expression = `${state}.direction`;
    else if (key === 'confirmedStrokes') expression = `${state}.strokeCount`;
    else if (key === 'strokeDirection') expression = `(na(${state}.strokeCandidate) ? 0 : ${state}.strokeCandidate.direction)`;
    else if (key.startsWith('strokeCandidate')) {
      const field = { strokeCandidateStartTime: 'startTime', strokeCandidateEndTime: 'endTime', strokeCandidateStartTicks: 'startTicks', strokeCandidateEndTicks: 'endTicks' }[key];
      assert(field, `unsupported stroke state: ${key}`);
      expression = `(na(${state}.strokeCandidate) ? na : ${state}.strokeCandidate.${field})`;
    }
    else if (key === 'candidateKind') expression = `(na(${state}.candidate) ? 0 : ${state}.candidate.kind)`;
    else {
      const field = { tailLowTicks: 'lowTicks', tailHighTicks: 'highTicks', tailLowTime: 'lowTime', tailHighTime: 'highTime' }[key];
      assert(field, `unsupported K/F assertion: ${key}`);
      expression = `${tail}.${field}`;
    }
    const expected = key === 'direction' ? { waiting: 0, up: 1, down: -1 }[value] : key === 'candidateKind' ? { none: 0, top: 1, bottom: -1 }[value] : key === 'strokeDirection' ? { none: 0, up: 1, down: -1 }[value] : value;
    result.push(assertion(expected === null ? `na(${expression})` : `${expression} == ${expected}`, `${context}/${key}`));
  }
  // Fixture structure IDs are human aliases; bind the observable object by status.
  for (const structure of snapshot.structures) {
    if (structure.type === 'stroke') {
      const locked = snapshot.structures.filter(s => s.type === 'stroke' && s.status === 'confirmed');
      const object = structure.status === 'confirmed' ? `observedStrokes.get(${locked.indexOf(structure)})` : `${state}.strokeCandidate`;
      result.push(assertion(`not na(${object})`, `${context}/${structure.id}/exists`));
      result.push(assertion(`${object}.id == ${q(structure.id)}`, `${context}/stroke-id`));
      result.push(assertion(`${object}.direction == ${structure.direction === 'up' ? 1 : -1}`, `${context}/stroke-direction`));
      for (const field of ['startTime', 'endTime', 'startTicks', 'endTicks']) result.push(assertion(`${object}.${field} == ${structure[field]}`, `${context}/stroke-${field}`));
      result.push(assertion(`${object}.confirmed == ${structure.status === 'confirmed'}`, `${context}/stroke-state`));
      result.push(assertion(structure.confirmedAt === null ? `na(${object}.confirmedAt)` : `${object}.confirmedAt == ${structure.confirmedAt}`, `${context}/stroke-confirmed-at`));
      result.push(assertion(`${object}.dependencies.size() == ${structure.dependencies.length}`, `${context}/stroke-dependencies`));
      structure.dependencies.forEach((id, i) => result.push(assertion(`${object}.dependencies.get(${i}) == ${q(id)}`, `${context}/stroke-dependency-${i}`)));
      continue;
    }
    assert(structure.type === 'fractal', 'unsupported non-fractal object');
    const locked = snapshot.structures.filter(s => s.type === 'fractal' && s.status === 'confirmed');
    const object = structure.status === 'confirmed' ? `observedFractals.get(${locked.indexOf(structure)})` : `${state}.candidate`;
    result.push(assertion(`not na(${object})`, `${context}/${structure.id}/exists`));
    result.push(assertion(`${object}.endpointTime == ${structure.endTime} and ${object}.priceTicks == ${structure.endTicks}`, `${context}/${structure.id}/endpoint`));
    result.push(assertion(`${object}.kind == ${structure.direction === 'top' ? 1 : -1}`, `${context}/${structure.id}/kind`));
    const aliases = new Map(fixture.input.items.map(item => [item.id, item.time]));
    assert.equal(structure.dependencies.length, 3, 'fractal needs three dependencies');
    for (const [i, field] of ['leftId', 'middleId', 'rightId'].entries()) {
      const sourceTime = aliases.get(structure.dependencies[i]);
      assert(sourceTime !== undefined, 'unbound fractal dependency');
      result.push(assertion(`${object}.${field} == ${state}.contextId + ${q('/K/' + sourceTime)}`, `${context}/${structure.id}/${field}`));
    }
    result.push(assertion(structure.confirmedAt === null ? `na(${object}.confirmedAt)` : `${object}.confirmedAt == ${structure.confirmedAt}`, `${context}/${structure.id}/confirmation`));
  }
  for (const type of ['fractal', 'stroke']) {
    const events = snapshot.events.filter(event => event.type === type);
    assert(events.length <= 1, 'one event per module per OHLC');
    const object = type === 'fractal' ? `${state}.event` : `${state}.strokeEvent`;
    const endpoint = type === 'fractal' ? 'endpointTime' : 'endTime';
    if (!events.length) result.push(assertion(`na(${object})`, `${context}/${type}-no-event`));
    else {
      const event = events[0];
      result.push(assertion(`not na(${object})`, `${context}/${type}-event-exists`));
      result.push(assertion(`${object}.${endpoint} == ${event.occurredAt} and ${object}.confirmedAt == ${event.confirmedAt}`, `${context}/event-time`));
    }
  }
  return result;
}
export function generateValidation(source, fixtures, {title="缠论 K/F/P 与特征序列共享内核验证",summary,splitOhlcPrefixes=false,loopOhlcReplay=false}={}) {
  const core = extractCore(source);
  assert(fixtures.length > 0, 'no reviewed supported fixtures');
  const hash = crypto.createHash('sha256').update(core).digest('hex');
  const lines = ['//@version=6', `indicator(${q(title)}, overlay = false)`, `// Extracted core SHA-256: ${hash}`, '// Generated from independent fixtures. Run in TradingView; generation is not a test pass.', core,
    'chan_assert(bool condition, string context) =>', '    if not condition', '        runtime.error("FAIL: " + context)', '    true'];
  for (const [caseIndex, fixture] of fixtures.entries()) {
    assert(fixture.expectationStatus === 'reviewed' && ['ohlc', 'fractal-pairs', 'confirmed-fractals', 'feature-strokes', 'completed-components'].includes(fixture.input.kind) && fixture.ruleIds.every(id => supportedRules.has(id)), `unsupported or draft fixture ${fixture.id}`);
    const functionName = `chan_case_${caseIndex}`;
    if (fixture.input.kind === 'completed-components') {
      assert(fixture.ruleIds.every(id => ['S-001','S-002','S-003','E-007'].includes(id)), 'component driver only supports S');
      lines.push(...generateSegmentCase(fixture, caseIndex, { assertion }));
      continue;
    }
    if (fixture.input.kind === 'feature-strokes') {
      lines.push(...generateFeatureCase(fixture, caseIndex, { assertion }));
      continue;
    }
    if (fixture.input.kind === 'confirmed-fractals') {
      lines.push(...generateStrokeCase(fixture, caseIndex, { fractal, assertion }));
      continue;
    }
    if (fixture.input.kind === 'fractal-pairs') {
      assert(fixture.ruleIds.every(id => id === 'P-001'), 'pair driver only validates P-001');
      lines.push(`${functionName}() =>`);
      fixture.input.items.forEach((pair, index) => {
        const snapshot = fixture.expected[index];
        assert.deepEqual(Object.keys(snapshot.state), ['strokeEligible'], 'unknown pair assertion');
        lines.push(`    ChanFractal first${index} = ${fractal(pair.first)}`, `    ChanFractal last${index} = ${fractal(pair.last)}`);
        lines.push(assertion(`chan_stroke_eligible(first${index}, last${index}) == ${snapshot.state.strokeEligible}`, `${fixture.id}/prefix-${index + 1}/strokeEligible`));
      });
      lines.push('    true');
      continue;
    }
    if(loopOhlcReplay){
      lines.push(`${functionName}_replay(int prefix) =>`, `    array<ChanRaw> inputs = array.from(${fixture.input.items.map(raw).join(', ')})`, `    ChanState state = chan_new(${q(fixture.id)})`, '    for i = 0 to prefix - 1', '        state := chan_step(state, inputs.get(i))', '    state');
    }
    const caseStart=lines.length;
    const prefixBoundaries=[];
    const initialization=[`${functionName}() =>`, `    ChanState online = chan_new(${q(fixture.id)})`, '    array<ChanFractal> observedFractals = array.new<ChanFractal>()', '    array<ChanStructure> observedStrokes = array.new<ChanStructure>()'];
    lines.push(...initialization);
    for (const [index, item] of fixture.input.items.entries()) {
      prefixBoundaries.push(lines.length);
      const prefix = index + 1, context = `${fixture.id}/prefix-${prefix}`;
      // Treat the next supplied OHLC as an unclosed tick in an isolated copy.
      // Compare its projection with the independent confirmed snapshot below.
      lines.push(`    string committedBefore${prefix} = chan_signature(online)`, `    ChanState intrabar${prefix} = chan_step(chan_clone(online), ${raw(item)})`, `    ChanState projected${prefix} = chan_stroke_preview(intrabar${prefix})`, `    ChanStructure pending${prefix} = chan_stroke_pending(projected${prefix}, online.strokeCount)`);
      lines.push(assertion(`chan_signature(online) == committedBefore${prefix}`, `${context}/intrabar-isolation`));
      const strokeEvent = fixture.expected[index].events.find(event => event.type === 'stroke');
      if (strokeEvent) {
        const expected = fixture.expected[index].structures.find(object => object.id === strokeEvent.objectId);
        lines.push(assertion(`not na(pending${prefix}) and not pending${prefix}.confirmed and na(pending${prefix}.confirmedAt)`, `${context}/pending-lock-state`));
        lines.push(assertion(`pending${prefix}.id == ${q(expected.id)} and pending${prefix}.endTime == ${expected.endTime} and pending${prefix}.endTicks == ${expected.endTicks}`, `${context}/pending-lock-retained`));
      }
      lines.push(`    online := chan_step(online, ${raw(item)})`, '    if not na(online.event)', '        observedFractals.push(online.event)', '    if not na(online.strokeEvent)', '        observedStrokes.push(online.strokeEvent)');
      if (Object.keys(fixture.expected[index].state).some(key => key.startsWith('tail'))) lines.push(`    ChanElement tail${prefix} = online.elements.last()`);
      lines.push(...stateChecks('online', fixture, fixture.expected[index], `tail${prefix}`));
      // Reconstruct exactly this prefix: no later fixture data enters this state.
      if(loopOhlcReplay)lines.push(`    ChanState replay${prefix} = ${functionName}_replay(${prefix})`);
      else{
        lines.push(`    ChanState replay${prefix} = chan_new(${q(fixture.id)})`);
        for (const prior of fixture.input.items.slice(0, prefix)) lines.push(`    replay${prefix} := chan_step(replay${prefix}, ${raw(prior)})`);
      }
      lines.push(assertion(`chan_signature(online) == chan_signature(replay${prefix})`, `${context}/prefix-reload`));
      // Duplicate input must not append; last transient event is intentionally cleared.
      lines.push(`    ChanState duplicate${prefix} = chan_clone(online)`, `    duplicate${prefix} := chan_step(duplicate${prefix}, ${raw(item)})`);
      lines.push(assertion(`duplicate${prefix}.inputCount == online.inputCount and duplicate${prefix}.confirmedFractals == online.confirmedFractals and na(duplicate${prefix}.event)`, `${context}/duplicate-input`));
      lines.push(`    string before${prefix} = chan_signature(online)`, `    ChanState preview${prefix} = chan_clone(online)`);
      const nextTime = item.closeTime;
      // An equal range forces the clone's tail record to mutate when initialized.
      lines.push(`    preview${prefix} := chan_step(preview${prefix}, ChanRaw.new(${nextTime}, ${nextTime + 60000}, ${item.lowTicks}, ${item.highTicks}, ${item.lowTicks}, ${item.highTicks}))`);
      lines.push(assertion(`chan_signature(online) == before${prefix}`, `${context}/deep-copy-isolation`));
    }
    if(splitOhlcPrefixes){
      // Preserve every generated statement, moving each prefix into its own
      // Pine function. State and retained event arrays flow in original order.
      const prefixEnd=lines.length;
      const bodies=prefixBoundaries.map((start,i)=>lines.slice(start,prefixBoundaries[i+1]??prefixEnd));
      lines.splice(caseStart);
      bodies.forEach((body,i)=>lines.push(`${functionName}_prefix_${i+1}(ChanState source, array<ChanFractal> observedFractals, array<ChanStructure> observedStrokes) =>`,'    ChanState online = source',...body,'    online'));
      lines.push(...initialization);
      bodies.forEach((_,i)=>lines.push(`    online := ${functionName}_prefix_${i+1}(online, observedFractals, observedStrokes)`));
    }
    lines.push('    true');
  }
  const segmentLimits = generateSegmentLimits(fixtures, {assertion});
  lines.push(...segmentLimits);
  lines.push('var table result = table.new(position.top_right, 1, 1)', 'if barstate.isfirst');
  fixtures.forEach((_, i) => lines.push(`    chan_case_${i}()`));
  if(segmentLimits.length) lines.push('    chan_segment_limits()');
  lines.push(`    table.cell(result, 0, 0, ${q(summary ?? `PASS: ${fixtures.length} K/F/P/S fixtures; recursion not covered`)}, text_color = color.green)`, 'plot(na)');
  return { source: lines.join('\n') + '\n', coreHash: hash, fixtureIds: fixtures.map(f => f.id) };
}
export function buildValidation(output = path.join(root, 'tmp/chanlun/kf-validation.pine')) {
  checkDirectory();
  const directory = path.join(root, 'tests/fixtures/chanlun');
  const fixtures = fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort().map(name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')));
  const selected = fixtures.filter(f => f.expectationStatus === 'reviewed' && ['ohlc', 'fractal-pairs', 'confirmed-fractals', 'feature-strokes', 'completed-components'].includes(f.input.kind) && f.ruleIds.every(id => supportedRules.has(id)));
  const result = generateValidation(fs.readFileSync(path.join(root, 'chanlun_original.pine'), 'utf8'), selected);
  const segmentFixtures=selected.filter(f=>f.input.kind==='completed-components');
  let segmentOutput;
  if(segmentFixtures.length) {
    const name=path.basename(output).toLowerCase()==='segment-validation.pine'?'segment-only-validation.pine':'segment-validation.pine';
    segmentOutput=path.join(path.dirname(output),name);
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, result.source);
  if(segmentOutput) fs.writeFileSync(segmentOutput,generateValidation(fs.readFileSync(path.join(root,'chanlun_original.pine'),'utf8'),segmentFixtures).source);
  const skipped = fixtures.filter(f => !selected.includes(f));
  return { output, segmentOutput, segmentFixtureIds:segmentFixtures.map(f=>f.id), coreHash: result.coreHash, fixtureIds: result.fixtureIds, skippedFixtureIds: skipped.map(f => f.id), skippedFixtures: skipped.map(f => ({ id: f.id, reason: f.expectationStatus === 'draft' ? 'draft expectations; not accepted' : `no implemented driver for ${f.input.kind}` })), execution: 'not run; compile and execute in TradingView' };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(buildValidation(process.argv[2]), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
