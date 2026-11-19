import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { checkDirectory, validateFixture } from './check-fixtures.mjs';

const rules = new Set(['K-001', 'K-002', 'E-001', 'E-002', 'E-003', 'F-001', 'F-002']);
const sources = new Set(['C62-162', 'C65-168']);
const load = name => JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/chanlun/${name}.json`, import.meta.url), 'utf8'));
const validate = f => validateFixture(f, rules, sources);

test('all hand-authored fixtures satisfy the contract; drafts stay separate', () => {
  assert.deepEqual(checkDirectory(), { fixtures: 54, reviewed: 51, draft: 3, prefixes: 357, scope: 'contract-only; no Pine execution' });
});

test('conditional R clock separates the old extreme from proof and parent submission', () => {
  const { components, sharedPrefixes, scenarios } = load('recursion/completion-clock');
  const [withoutProof, withProof] = scenarios;
  const { proof, confirmedSnapshot: snapshot } = withProof;
  const componentById = new Map(components.map(([id, start, end, available, startTicks, endTicks]) => [
    id, { start, end, available, startTicks, endTicks },
  ]));
  const members = proof.certifiedMembers.map(id => componentById.get(id));
  const endpoint = componentById.get(proof.certifiedEndpointMember);

  assert.deepEqual(snapshot.members, components.slice(0, members.length).map(row => row[0]));
  assert.deepEqual(snapshot.members, proof.certifiedMembers);
  assert.equal(endpoint, members.at(-1));
  assert.equal(snapshot.startOffsetMs, members[0].start);
  assert.equal(snapshot.startTicks, members[0].startTicks);
  assert.equal(snapshot.endTicks, Math.max(...members.flatMap(member => [member.startTicks, member.endTicks])));
  assert.equal(snapshot.endTicks, endpoint.endTicks);
  assert.equal(snapshot.occurredOffsetMs, endpoint.end);
  assert.equal(snapshot.confirmedOffsetMs, proof.availableOffsetMs);
  assert.equal(snapshot.proofId, proof.id);
  assert(snapshot.occurredOffsetMs < snapshot.confirmedOffsetMs);
  for (const id of [...proof.certifiedMembers, ...proof.evidenceMembers]) {
    assert(componentById.get(id).available <= proof.availableOffsetMs, 'proof requires future input');
  }

  for (const step of [...sharedPrefixes, ...withoutProof.steps]) {
    assert.deepEqual(step.rEvents, []);
    assert.equal(step.parentInputTotal, 0);
  }
  assert.equal(withoutProof.steps[0].atOffsetMs, proof.availableOffsetMs);
  assert.equal(withProof.steps[0].atOffsetMs, proof.availableOffsetMs);
  assert.equal(withProof.steps[0].input, proof.id);
  assert.deepEqual(withProof.steps.flatMap(step => step.rEvents), [snapshot.id]);
  assert(withProof.steps.every(step => step.parentInputTotal === 1));
});

test('every input prefix must explicitly state expectations, including no-event prefixes', () => {
  const f = load('f-top-seal'); f.expected.splice(1, 1);
  assert.throws(() => validate(f), /every prefix/);
});
test('OHLC and times must describe possible inputs', () => {
  const f = load('k-up-chain'); f.input.items[0].closeTicks = 100;
  assert.throws(() => validate(f), /outside range/);
  const g = load('k-up-chain'); g.input.items[1].time = g.input.items[0].time;
  assert.throws(() => validate(g), /ordering/);
});
test('tick size is a positive decimal and prices use integer ticks', () => {
  const f = load('k-up-chain'); f.tickSize = '0.000';
  assert.throws(() => validate(f), /tick size/);
  const g = load('k-up-chain'); g.input.items[0].highTicks = 5.5;
  assert.throws(() => validate(g), /integer/);
});
test('events cannot become available before their evidence prefix', () => {
  const f = load('f-top-seal');
  f.expected[3].structures[0].confirmedAt += 60000;
  f.expected[3].events[0].confirmedAt += 60000;
  assert.throws(() => validate(f), /confirmation time/);
});
test('candidate objects cannot be referenced by confirmation events', () => {
  const f = load('f-top-seal');
  f.expected[3].structures[0].status = 'candidate';
  f.expected[3].structures[0].confirmedAt = null;
  assert.throws(() => validate(f), /confirmed object/);
});
function extraPrefix() {
  const f = load('f-top-seal');
  const lastInput = f.input.items.at(-1);
  f.input.items.push({ ...lastInput, id: 'raw-4', time: lastInput.closeTime, closeTime: lastInput.closeTime + 60000 });
  const snapshot = structuredClone(f.expected.at(-1));
  snapshot.prefix = 5; snapshot.events = [];
  f.expected.push(snapshot);
  return f;
}
test('confirmed object endpoints, dependencies and states remain immutable', () => {
  for (const change of [s => s.endTicks++, s => s.dependencies.push('future-member'), s => { s.status = 'candidate'; s.confirmedAt = null; }]) {
    const f = extraPrefix(); change(f.expected[4].structures[0]);
    assert.throws(() => validate(f), /confirmed object|dependency/);
  }
});
test('confirmed objects cannot disappear or reconfirm', () => {
  const f = extraPrefix(); f.expected[4].structures = [];
  assert.throws(() => validate(f), /disappeared/);
  const g = extraPrefix(); g.expected[4].events = structuredClone(g.expected[3].events);
  assert.throws(() => validate(g), /duplicate confirmation/);
});
test('rules and sources must resolve to known provenance', () => {
  const f = load('k-up-chain'); f.ruleIds.push('K-999');
  assert.throws(() => validate(f), /unknown rule/);
  const g = load('k-up-chain'); g.source.sourceIds.push('C999-999');
  assert.throws(() => validate(g), /unknown source/);
});

test('future or circular candidate dependencies cannot enter snapshots', () => {
  const f = load('f-top-seal'); f.expected[2].structures[0].dependencies.push('raw-3');
  assert.throws(() => validate(f), /future dependency/);
  const g = load('f-top-seal'); g.expected[2].structures[0].dependencies.push(g.expected[2].structures[0].id);
  assert.throws(() => validate(g), /cyclic/);
});

test('qualification pairs cannot fabricate confirmed strokes or corrupt membership identities', () => {
  const known = new Set([...rules, 'P-001']);
  const origins = new Set([...sources, 'C77-195']);
  const f = load('p-independent');
  f.expected[0].events = [{ id: 'fake-confirmation' }];
  assert.throws(() => validateFixture(f, known, origins), /confirmation event/);
  const g = load('p-shared-members');
  g.input.items[0].last.leftId = 'different-k2';
  assert.throws(() => validateFixture(g, known, origins), /identity mismatch/);
  const h = load('p-independent');
  h.input.items[0].last.priceTicks++;
  assert.throws(() => validateFixture(h, known, origins), /extreme/);
});

// ---- signal fixtures (kind signal-components): legal and illegal inputs ----
import { checkSignalDirectory } from './check-fixtures.mjs';
const signalRules = new Set(['M-002', 'M-003', 'D-001', 'D-002', 'D-003', 'B-001', 'B-002', 'B-003', 'B-004', 'Z-001', 'Z-002', 'E-010']);
const signalSources = new Set(['C37-96', 'C61-154', 'C24-52', 'C53-126', 'C27-66', 'C21-45', 'C20-43', 'C20-44', 'C18-40']);
const loadSignal = name => JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/chanlun/signals/${name}.json`, import.meta.url), 'utf8'));
const validateSignal = f => validateFixture(f, signalRules, signalSources);

test('signal fixtures: the whole directory satisfies the contract', () => {
  const result = checkSignalDirectory();
  assert.equal(result.fixtures, 19);
  assert.equal(result.prefixes, 154);
  assert.equal(result.reviewed + result.draft, 19);
});

test('signal fixtures: every sample is accepted when untouched', () => {
  for (const name of fs.readdirSync(new URL('../../tests/fixtures/chanlun/signals/', import.meta.url)).filter(n => n.endsWith('.json'))) {
    assert.doesNotThrow(() => validateSignal(JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/chanlun/signals/${name}`, import.meta.url), 'utf8'))), name);
  }
});

test('signal fixtures: stated areas must equal the bar sums (M-002), same-sign bars only', () => {
  const f = loadSignal('sig-trend-div');
  f.expected[8].signals.find(x => x.type === 'first').comparison.a.areaUnits = 11;
  assert.throws(() => validateSignal(f), /area does not match/);
  const g = loadSignal('sig-trend-div');
  assert.equal(g.input.bars[15].hist, -1); // the negative bar inside A (c5)
  g.input.bars[15].hist = 1; // flipping it to a positive bar changes the area
  assert.throws(() => validateSignal(g), /area does not match/);
});

test('signal fixtures: a divergence needs a strictly smaller area and a new extreme', () => {
  const f = loadSignal('sig-trend-area-equal');
  const entry = f.expected[8].suppressed[0];
  f.expected[8].suppressed = []; f.expected[8].signals = [...f.expected[8].signals, { id: `${f.id}/L1/first/c9`, type: 'first', layer: 1, side: 'sell', priceTicks: 24, occurredAt: f.input.items[8].endTime, confirmedAt: f.input.items[8].completedAt, dependencies: entry.dependencies, comparison: entry.comparison }];
  f.expected[8].events = [f.expected[8].signals.at(-1).id];
  assert.throws(() => validateSignal(f), /strictly smaller C area/);
  const g = loadSignal('sig-trend-no-new-high');
  const e = g.expected[8].suppressed[0];
  e.reason = 'area-not-smaller';
  assert.throws(() => validateSignal(g), /area-not-smaller needs/);
});

test('signal fixtures: suppression reasons are an enumerated, checked set', () => {
  const f = loadSignal('sig-trend-area-unavailable');
  assert.equal(f.expected[8].suppressed[0].comparison.a.areaUnits, null);
  f.expected[8].suppressed[0].reason = 'because';
  assert.throws(() => validateSignal(f));
  const g = loadSignal('sig-trend-area-unavailable');
  g.input.macd.warmupBars = 0; // bars are retained again, so "unavailable" is no longer true
  assert.throws(() => validateSignal(g), /area does not match/);
});

test('signal fixtures: confirmed signals are append-only and emitted once on the completing prefix', () => {
  const f = loadSignal('sig-trend-div');
  f.expected[9].signals = f.expected[9].signals.filter(s => s.type !== 'first');
  assert.throws(() => validateSignal(f), /disappeared/);
  const g = loadSignal('sig-trend-div');
  g.expected[8].signals.find(x => x.type === 'first').confirmedAt += 60000;
  assert.throws(() => validateSignal(g));
  const h = loadSignal('sig-trend-div');
  h.expected[8].events = [];
  assert.throws(() => validateSignal(h), /events list the new signals/);
  const i = loadSignal('sig-trend-div');
  i.expected.splice(3, 1);
  assert.throws(() => validateSignal(i), /every prefix/);
});

test('signal fixtures: third class requires a return strictly outside the core (E-010 touch rule)', () => {
  const f = loadSignal('sig-third-buy');
  const c6 = f.input.items[5];
  c6.endTicks = 10; c6.lowTicks = 10;
  assert.throws(() => validateSignal(f), /touches the core edge/);
  const g = loadSignal('sig-third-touch-equal');
  g.input.items[5].endTicks = 11; g.input.items[5].lowTicks = 11;
  assert.throws(() => validateSignal(g), /touch-edge needs a return whose range ends exactly/);
});

test('signal fixtures: second class may not pass the first class price; same-batch order is second then third', () => {
  const f = loadSignal('sig-second');
  const c11 = f.input.items[10];
  c11.endTicks = 26; c11.highTicks = 26;
  assert.throws(() => validateSignal(f), /may not pass the first class price/);
  const g = loadSignal('sig-second-third-coincide');
  const last = g.expected[10];
  last.signals.reverse().length; // swap the two same-endpoint signals
  last.events.reverse();
  assert.throws(() => validateSignal(g), /second → third|follow first/);
});

test('signal fixtures: consolidation divergence needs exactly one center and a same-direction entry before it', () => {
  const f = loadSignal('sig-cons-div');
  f.expected[4].signals[0].comparison.aIds = ['X1'];
  assert.throws(() => validateSignal(f));
  const g = loadSignal('sig-cons-div');
  g.expected[4].signals[0].type = 'first';
  g.expected[4].signals[0].id = g.expected[4].signals[0].id.replace('consolidation-divergence-point', 'first');
  assert.throws(() => validateSignal(g));
});
