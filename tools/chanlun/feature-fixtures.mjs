import assert from 'node:assert/strict';

// Contract/provenance checks only. No containment or fractal algorithm lives here.
export function validateFeatureFixture(fixture, { fields, integer, time, string, strings, list }) {
  const { context, items } = fixture.input;
  fields(context, ['segmentDirection', 'initialDirection', 'postDirection', 'boundaryTime', 'secondSequence', 'maxElements', 'maxSources']);
  assert(['up', 'down'].includes(context.segmentDirection));
  for (const key of ['initialDirection', 'postDirection']) assert(['waiting', 'up', 'down'].includes(context[key]));
  if (context.boundaryTime !== null) time(context.boundaryTime);
  assert.equal(typeof context.secondSequence, 'boolean');
  for (const key of ['maxElements', 'maxSources']) { integer(context[key]); assert(context[key] > 0); }
  const byId = new Map();
  let previous;
  for (const stroke of items) {
    fields(stroke, ['id', 'startTime', 'endTime', 'completedAt', 'startTicks', 'endTicks', 'direction', 'ordinal', 'dependencies']);
    string(stroke.id); assert(!byId.has(stroke.id), 'duplicate stroke ID');
    [stroke.startTime, stroke.endTime, stroke.completedAt].forEach(time);
    [stroke.startTicks, stroke.endTicks, stroke.ordinal].forEach(integer);
    assert(stroke.endTime > stroke.startTime && stroke.completedAt >= stroke.endTime && stroke.ordinal > 0, 'invalid stroke times/ordinal');
    assert(['up', 'down'].includes(stroke.direction));
    assert(stroke.direction === 'up' ? stroke.endTicks > stroke.startTicks : stroke.endTicks < stroke.startTicks, 'stroke direction mismatch');
    if (context.boundaryTime !== null) assert(context.boundaryTime <= stroke.startTime || context.boundaryTime >= stroke.endTime, 'boundary inside a stroke');
    strings(stroke.dependencies);
    if (previous) {
      assert(stroke.startTime === previous.endTime && stroke.startTicks === previous.endTicks, 'disconnected stroke input');
      assert(stroke.direction !== previous.direction && stroke.ordinal === previous.ordinal + 1 && stroke.completedAt >= previous.completedAt, 'invalid stroke ordering');
    }
    previous = stroke;
    byId.set(stroke.id, stroke);
  }
  list(fixture.expected); assert.equal(fixture.expected.length, items.length, 'every prefix needs a snapshot');
  const sealed = new Map();
  let previousState;
  fixture.expected.forEach((snapshot, index) => {
    fields(snapshot, ['prefix', 'state', 'structures', 'events', 'reason']);
    assert.equal(snapshot.prefix, index + 1); string(snapshot.reason);
    assert.deepEqual(snapshot.structures, [], 'features are not segment confirmations');
    assert.deepEqual(snapshot.events, [], 'features cannot emit segment events');
    const state = snapshot.state;
    fields(state, ['inputCount', 'selectedCount', 'mergeDirection', 'boundaryCuts', 'waitingDirection', 'blocked', 'heldId', 'turnKind', 'gap', 'features', 'seedEligible']);
    assert.equal(typeof state.seedEligible, 'boolean');
    if (snapshot.prefix < 3) assert.equal(state.seedEligible, false, 'seed needs three inputs');
    if (previousState?.waitingDirection || previousState?.blocked) assert.deepEqual({...state, seedEligible:previousState.seedEligible}, previousState, 'stopped context resumed without rebuild');
    for (const key of ['inputCount', 'selectedCount', 'boundaryCuts']) { integer(state[key]); assert(state[key] >= 0); }
    assert(state.inputCount <= snapshot.prefix && state.selectedCount <= state.inputCount, 'future input count');
    assert(['waiting', 'up', 'down'].includes(state.mergeDirection));
    assert(['none', 'top', 'bottom'].includes(state.turnKind));
    for (const key of ['waitingDirection', 'blocked']) assert.equal(typeof state[key], 'boolean');
    assert(state.gap === null || typeof state.gap === 'boolean');
    assert.equal(state.gap === null, state.turnKind === 'none', 'gap must belong to a feature turn');
    if (state.waitingDirection || state.blocked) assert.equal(state.turnKind, 'none', 'blocked feature turn');
    const consumed = items.slice(0, state.inputCount).filter(stroke => stroke.direction !== context.segmentDirection).map(stroke => stroke.id);
    assert.equal(consumed.length, state.selectedCount, 'selected count mismatch');
    const available = new Set(items.slice(0, snapshot.prefix).map(stroke => stroke.id));
    const covered = [], current = new Map();
    list(state.features); assert(state.features.length <= context.maxElements);
    for (const feature of state.features) {
      fields(feature, ['id', 'lowTicks', 'highTicks', 'lowTime', 'highTime', 'firstTime', 'lastTime', 'firstOrdinal', 'lastOrdinal', 'firstSide', 'lastSide', 'availableAt', 'sealed', 'sourceIds']);
      strings(feature.sourceIds); string(feature.id);
      [feature.lowTicks, feature.highTicks, feature.firstOrdinal, feature.lastOrdinal].forEach(integer);
      [feature.lowTime, feature.highTime, feature.firstTime, feature.lastTime, feature.availableAt].forEach(time);
      assert(feature.lowTicks < feature.highTicks, 'invalid feature range');
      assert.equal(typeof feature.sealed, 'boolean');
      for (const side of ['firstSide', 'lastSide']) assert([0, 1].includes(feature[side]));
      if (!context.secondSequence) assert.equal(feature.firstSide, feature.lastSide, 'first sequence merged across boundary');
      const sources = feature.sourceIds.map(id => {
        assert(available.has(id) && consumed.includes(id), 'future or unselected feature source');
        covered.push(id); return byId.get(id);
      });
      assert.equal(feature.id, `${fixture.id}/E/${sources[0].id}`, 'unstable feature identity');
      assert.equal(feature.firstTime, sources[0].startTime);
      assert.equal(feature.lastTime, sources.at(-1).endTime);
      assert.equal(feature.firstOrdinal, sources[0].ordinal);
      assert.equal(feature.lastOrdinal, sources.at(-1).ordinal);
      assert.equal(feature.availableAt, sources.at(-1).completedAt);
      for (const [side, source] of [['firstSide', sources[0]], ['lastSide', sources.at(-1)]]) assert.equal(feature[side], context.boundaryTime !== null && source.startTime >= context.boundaryTime ? 1 : 0, 'feature boundary provenance mismatch');
      for (const extreme of ['low', 'high']) assert(sources.some(s => (s.startTime === feature[`${extreme}Time`] && s.startTicks === feature[`${extreme}Ticks`]) || (s.endTime === feature[`${extreme}Time`] && s.endTicks === feature[`${extreme}Ticks`])), 'feature extreme lost provenance');
      assert(!current.has(feature.id), 'duplicate feature ID'); current.set(feature.id, feature);
      if (sealed.has(feature.id)) assert.deepEqual(feature, sealed.get(feature.id), 'sealed feature changed');
      if (feature.sealed) sealed.set(feature.id, feature);
    }
    if (state.heldId !== null) {
      assert(available.has(state.heldId) && (state.waitingDirection || state.blocked), 'invalid held input');
      if (state.waitingDirection) covered.push(state.heldId);
    } else assert(!state.waitingDirection && !state.blocked, 'missing held input');
    assert.deepEqual(covered, consumed, 'feature sources lost, repeated or reordered');
    for (const [id, value] of sealed) assert.deepEqual(current.get(id), value, 'sealed feature disappeared');
    assert(covered.length <= context.maxSources);
    previousState = state;
  });
}
