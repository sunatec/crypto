import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFeatureFixture } from './feature-fixtures.mjs';
import { validateNormalizationSnapshots } from './normalization-fixtures.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const categories = ['author-body', 'author-correction', 'editorial', 'unverified-annotation', 'engineering'];
const stateKeys = new Set(['processedCount', 'direction', 'tailLowTicks', 'tailHighTicks', 'tailLowTime', 'tailHighTime', 'effectiveStart', 'candidateKind', 'confirmedFractals', 'coreLowTicks', 'coreHighTicks', 'movementComplete', 'completionEvents', 'ruleBlocked', 'extentEndTime', 'ggTicks', 'gTicks', 'dTicks', 'ddTicks', 'confirmedStrokes', 'strokeCandidateStartTime', 'strokeCandidateEndTime', 'strokeCandidateStartTicks', 'strokeCandidateEndTicks', 'strokeDirection', 'confirmedSegments']);
const structureTypes = ['fractal', 'stroke', 'segment', 'normalized', 'center', 'movement'];
const own = (o, key) => Object.hasOwn(o, key);
const object = value => assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected object');
const string = value => assert(typeof value === 'string' && value.trim().length > 0, 'expected nonempty string');
const integer = value => assert(Number.isSafeInteger(value), 'expected safe integer');
const time = value => { integer(value); assert(value >= 0, 'negative UTC time'); };
const list = value => assert(Array.isArray(value), 'expected array');
function strings(value, nonempty = true) {
  list(value);
  if (nonempty) assert(value.length > 0, 'empty ID list');
  value.forEach(string);
  assert.equal(new Set(value).size, value.length, 'duplicate IDs');
}
function fields(value, names) {
  object(value);
  assert.deepEqual(Object.keys(value).sort(), [...names].sort(), 'unexpected or missing fields');
}
function range(value, start, end) {
  [value.lowTicks, value.highTicks, value[start], value[end]].forEach(integer);
  assert(value.lowTicks <= value.highTicks, 'inverted range');
  assert(value[start] >= value.lowTicks && value[start] <= value.highTicks, 'start/open outside range');
  assert(value[end] >= value.lowTicks && value[end] <= value.highTicks, 'end/close outside range');
}

function validateFractalPoint(point, ordinals, memberIds) {
  fields(point, ['id', 'kind', 'endpointTime', 'priceTicks', 'confirmedAt', 'leftId', 'middleId', 'rightId', 'leftOrdinal', 'middleOrdinal', 'rightOrdinal', 'middleHighTicks', 'middleLowTicks']);
  string(point.id); assert(['top', 'bottom'].includes(point.kind));
  time(point.endpointTime); time(point.confirmedAt);
  assert(point.confirmedAt >= point.endpointTime, 'fractal confirmed before endpoint');
  [point.priceTicks, point.middleHighTicks, point.middleLowTicks, point.leftOrdinal, point.middleOrdinal, point.rightOrdinal].forEach(integer);
  assert(point.leftOrdinal >= 0 && point.leftOrdinal + 1 === point.middleOrdinal && point.middleOrdinal + 1 === point.rightOrdinal, 'invalid member ordinals');
  assert(point.middleLowTicks <= point.middleHighTicks, 'invalid fractal range');
  assert.equal(point.priceTicks, point.kind === 'top' ? point.middleHighTicks : point.middleLowTicks, 'fractal price is not its extreme');
  for (const side of ['left', 'middle', 'right']) {
    const id = point[`${side}Id`], ordinal = point[`${side}Ordinal`];
    string(id);
    if (ordinals.has(ordinal)) assert.equal(ordinals.get(ordinal), id, 'member identity mismatch');
    if (memberIds.has(id)) assert.equal(memberIds.get(id), ordinal, 'member ordinal mismatch');
    ordinals.set(ordinal, id); memberIds.set(id, ordinal);
  }
}

function validateFractalPairs(fixture) {
  const { items } = fixture.input;
  list(fixture.expected);
  assert.equal(fixture.expected.length, items.length, 'every prefix needs a snapshot');
  const pairIds = new Set();
  for (const [index, pair] of items.entries()) {
    fields(pair, ['id', 'first', 'last']);
    string(pair.id); assert(!pairIds.has(pair.id), 'duplicate pair ID'); pairIds.add(pair.id);
    const ordinals = new Map(), memberIds = new Map();
    for (const point of [pair.first, pair.last]) {
      validateFractalPoint(point, ordinals, memberIds);
    }
    assert(pair.first.id !== pair.last.id && pair.first.endpointTime < pair.last.endpointTime && pair.first.confirmedAt <= pair.last.confirmedAt, 'invalid pair chronology');
    const expected = fixture.expected[index];
    fields(expected, ['prefix', 'state', 'structures', 'events', 'reason']);
    assert.equal(expected.prefix, index + 1);
    fields(expected.state, ['strokeEligible']);
    assert.equal(typeof expected.state.strokeEligible, 'boolean');
    list(expected.structures); list(expected.events);
    assert.equal(expected.structures.length, 0, 'qualification is not a stroke structure');
    assert.equal(expected.events.length, 0, 'qualification is not a confirmation event');
    string(expected.reason);
  }
}

// This checks the independent contract, never calculates expected market structures.
export function validateFixture(fixture, knownRules, knownSources) {
  fields(fixture, ['schemaVersion', 'id', 'ruleVersion', 'ruleIds', 'expectationStatus', 'construction', 'source', 'tickSize', 'input', 'expected']);
  assert.equal(fixture.schemaVersion, 1);
  string(fixture.id); string(fixture.ruleVersion); strings(fixture.ruleIds);
  fixture.ruleIds.forEach(id => assert(knownRules.has(id), `unknown rule ${id}`));
  assert(['reviewed', 'draft'].includes(fixture.expectationStatus));
  assert(['synthetic', 'diagram-annotation', 'market'].includes(fixture.construction));
  assert(typeof fixture.tickSize === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(fixture.tickSize) && /[1-9]/.test(fixture.tickSize), 'invalid tick size');
  const source = fixture.source;
  fields(source, ['category', 'sourceIds', 'lesson', 'pdfPages', 'figure', 'note']);
  assert(categories.includes(source.category)); strings(source.sourceIds);
  source.sourceIds.forEach(id => assert(knownSources.has(id), `unknown source ${id}`));
  integer(source.lesson); assert(source.lesson >= 1 && source.lesson <= 108);
  list(source.pdfPages); assert(source.pdfPages.length > 0);
  source.pdfPages.forEach(p => { integer(p); assert(p >= 1 && p <= 267); });
  assert.equal(new Set(source.pdfPages).size, source.pdfPages.length);
  if (source.figure !== null) string(source.figure);
  string(source.note);
  fields(fixture.input, fixture.input.kind === 'feature-strokes' ? ['kind', 'context', 'items'] : ['kind', 'items']);
  const { kind, items } = fixture.input;
  assert(['ohlc', 'completed-components', 'fractal-pairs', 'confirmed-fractals', 'feature-strokes', 'normalization-strokes'].includes(kind));
  list(items); assert(items.length > 0);
  if (kind === 'feature-strokes') {
    validateFeatureFixture(fixture, { fields, integer, time, string, strings, list });
    return fixture;
  }
  if (kind === 'fractal-pairs') {
    validateFractalPairs(fixture);
    return fixture;
  }
  const inputIds = new Set();
  let previousStart = -1, previousEnd = -1, availableAt = -1;
  const availability = [];
  const memberOrdinals = new Map(), memberIds = new Map();
  for (const item of items) {
    if (kind === 'confirmed-fractals') {
      validateFractalPoint(item, memberOrdinals, memberIds);
    } else fields(item, kind === 'ohlc'
      ? ['id', 'time', 'closeTime', 'openTicks', 'highTicks', 'lowTicks', 'closeTicks']
      : ['id', 'startTime', 'endTime', 'completedAt', 'startTicks', 'endTicks', 'lowTicks', 'highTicks', 'direction', 'dependencies']);
    string(item.id); assert(!inputIds.has(item.id), 'duplicate input ID'); inputIds.add(item.id);
    if (kind === 'ohlc') {
      time(item.time); time(item.closeTime);
      assert(item.time > previousStart && item.time >= previousEnd && item.closeTime > item.time, 'invalid OHLC ordering');
      range(item, 'openTicks', 'closeTicks');
      previousStart = item.time; previousEnd = item.closeTime; availableAt = item.closeTime;
    } else if (kind === 'confirmed-fractals') {
      assert(item.endpointTime > previousStart && item.confirmedAt >= availableAt, 'invalid fractal ordering');
      previousStart = item.endpointTime; availableAt = item.confirmedAt;
    } else {
      time(item.startTime); time(item.endTime); time(item.completedAt);
      assert(item.startTime >= previousEnd && item.endTime > item.startTime && item.completedAt >= item.endTime && item.completedAt >= availableAt, 'invalid component ordering');
      range(item, 'startTicks', 'endTicks');
      assert(['up', 'down'].includes(item.direction));
      assert(item.direction === 'up' ? item.endTicks > item.startTicks : item.endTicks < item.startTicks, 'direction mismatch');
      strings(item.dependencies);
      previousEnd = item.endTime; availableAt = item.completedAt;
    }
    availability.push(availableAt);
  }
  if(kind==='normalization-strokes'){
    validateNormalizationSnapshots(fixture,{fields,time,integer,string,strings,list});
    return fixture;
  }
  list(fixture.expected); assert.equal(fixture.expected.length, items.length, 'every prefix needs a snapshot');
  const events = new Set(), eventObjects = new Set(), locked = new Map();
  for (let index = 0; index < fixture.expected.length; index++) {
    const snapshot = fixture.expected[index];
    fields(snapshot, ['prefix', 'state', 'structures', 'events', 'reason']);
    assert.equal(snapshot.prefix, index + 1, 'missing or unordered prefix'); string(snapshot.reason);
    object(snapshot.state); assert(Object.keys(snapshot.state).length > 0);
    for (const [key, value] of Object.entries(snapshot.state)) {
      assert(stateKeys.has(key), `unknown state field ${key}`);
      if (['movementComplete', 'ruleBlocked'].includes(key)) assert.equal(typeof value, 'boolean');
      else if (key === 'direction') assert(['waiting', 'up', 'down'].includes(value));
      else if (key === 'strokeDirection') assert(['none', 'up', 'down'].includes(value));
      else if (key === 'candidateKind') assert(['none', 'top', 'bottom'].includes(value));
      else if (value === null) assert(['effectiveStart', 'tailLowTime', 'tailHighTime', 'strokeCandidateStartTime', 'strokeCandidateEndTime', 'strokeCandidateStartTicks', 'strokeCandidateEndTicks'].includes(key));
      else { integer(value); if (!['tailLowTicks', 'tailHighTicks', 'coreLowTicks', 'coreHighTicks', 'ggTicks', 'gTicks', 'dTicks', 'ddTicks', 'strokeCandidateStartTicks', 'strokeCandidateEndTicks'].includes(key)) assert(value >= 0); }
      if (key.endsWith('Time') || key === 'effectiveStart') assert(value === null || value <= availability[index], 'future state time');
    }
    list(snapshot.structures); list(snapshot.events);
    const current = new Map();
    for (const structure of snapshot.structures) {
      fields(structure, ['id', 'type', 'level', 'status', 'startTime', 'endTime', 'startTicks', 'endTicks', 'confirmedAt', 'dependencies', 'direction']);
      string(structure.id); assert(!current.has(structure.id), 'duplicate structure ID');
      assert(structureTypes.includes(structure.type));
      assert((structure.type === 'fractal' ? ['top', 'bottom'] : structure.type === 'center' ? ['none'] : ['up', 'down']).includes(structure.direction), 'invalid structure direction');
      integer(structure.level); assert(structure.level >= 0 && structure.level <= 3);
      assert(['candidate', 'confirmed'].includes(structure.status));
      time(structure.startTime); time(structure.endTime); integer(structure.startTicks); integer(structure.endTicks);
      assert(structure.startTime <= structure.endTime && structure.endTime <= availability[index], 'invalid structure endpoint time');
      strings(structure.dependencies);
      if (structure.status === 'confirmed') {
        time(structure.confirmedAt);
        assert(structure.confirmedAt >= structure.endTime && structure.confirmedAt <= availability[index], 'invalid confirmation time');
        if (locked.has(structure.id)) assert.deepEqual(structure, locked.get(structure.id), 'confirmed object changed');
        else locked.set(structure.id, structure);
      } else assert.equal(structure.confirmedAt, null, 'candidate cannot be confirmed');
      current.set(structure.id, structure);
    }
    if (own(snapshot.state, 'confirmedSegments')) assert.equal(snapshot.state.confirmedSegments, snapshot.structures.filter(s => s.type === 'segment' && s.status === 'confirmed').length, 'confirmed segment count mismatch');
    const availableInputs = new Map(items.slice(0, index + 1).map((item, i) => [item.id, availability[i]]));
    const visiting = new Set(), visited = new Set();
    function checkDependencies(structure) {
      if (visited.has(structure.id)) return;
      assert(!visiting.has(structure.id), 'cyclic structure dependencies');
      visiting.add(structure.id);
      for (const id of structure.dependencies) {
        const child = current.get(id);
        assert(availableInputs.has(id) || child, 'unknown or future dependency');
        if (structure.status === 'confirmed') {
          if (child) assert(child.status === 'confirmed' && child.confirmedAt <= structure.confirmedAt, 'unavailable confirmed dependency');
          else assert(availableInputs.get(id) <= structure.confirmedAt, 'input dependency confirmed in future');
        }
        if (child) checkDependencies(child);
      }
      visiting.delete(structure.id); visited.add(structure.id);
    }
    for (const structure of current.values()) checkDependencies(structure);
    for (const [id, structure] of locked) {
      assert(current.has(id), 'confirmed object disappeared');
      assert.deepEqual(current.get(id), structure, 'confirmed object changed or became candidate');
    }

    for (const event of snapshot.events) {
      fields(event, ['id', 'type', 'objectId', 'occurredAt', 'confirmedAt']);
      string(event.id); string(event.objectId);
      assert(!events.has(event.id) && !eventObjects.has(event.objectId), 'duplicate confirmation event');
      const structure = current.get(event.objectId);
      assert(structure?.status === 'confirmed', 'event must reference confirmed object');
      assert.equal(event.type, structure.type);
      time(event.occurredAt); time(event.confirmedAt);
      assert.equal(event.occurredAt, structure.endTime);
      assert.equal(event.confirmedAt, structure.confirmedAt);
      assert(event.confirmedAt <= availability[index] && (index === 0 || event.confirmedAt > availability[index - 1]), 'event emitted at wrong prefix');
      events.add(event.id); eventObjects.add(event.objectId);
    }
    for (const id of locked.keys()) assert(eventObjects.has(id), 'confirmed object needs one event');
    if (snapshot.state.coreLowTicks !== undefined && snapshot.state.coreHighTicks !== undefined) assert(snapshot.state.coreLowTicks <= snapshot.state.coreHighTicks, 'inverted expected core');
  }
  return fixture;
}

export function checkDirectory(directory = path.join(root, 'tests/fixtures/chanlun')) {
  const rules = new Set(fs.readFileSync(path.join(root, 'docs/chanlun/rules.md'), 'utf8').match(/\b[KFPSNRZE]-\d{3}\b/g));
  const sources = new Set(fs.readFileSync(path.join(root, 'docs/chanlun/sources.md'), 'utf8').match(/\b(?:C|A)\d+-\d+\b/g));
  const files = fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort();
  assert(files.length > 0, 'no fixtures');
  const ids = new Set();
  let reviewed = 0, draft = 0, prefixes = 0;
  for (const file of files) {
    try {
      const fixture = validateFixture(JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')), rules, sources);
      assert(!ids.has(fixture.id), 'duplicate fixture ID'); ids.add(fixture.id);
      if (fixture.expectationStatus === 'reviewed') reviewed++; else draft++;
      prefixes += fixture.expected.length;
    } catch (error) { throw new Error(`${file}: ${error.message}`, { cause: error }); }
  }
  return { fixtures: files.length, reviewed, draft, prefixes, scope: 'contract-only; no Pine execution' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(checkDirectory(process.argv[2]), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
