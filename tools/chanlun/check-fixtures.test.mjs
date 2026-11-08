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
