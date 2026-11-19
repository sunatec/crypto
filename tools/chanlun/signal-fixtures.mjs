import assert from 'node:assert/strict';

export const signalTypes = ['first', 'second', 'third', 'consolidation-divergence-point'];
export const suppressReasons = ['area-unavailable', 'area-not-smaller', 'not-new-extreme', 'no-same-direction-entry', 'no-entry-segment', 'breaks-first-class-price', 'touch-edge'];
const itemFields = ['id', 'startTime', 'endTime', 'completedAt', 'startTicks', 'endTicks', 'lowTicks', 'highTicks', 'direction', 'dependencies'];
const barFields = ['time', 'closeTime', 'hist', 'dif', 'dea'];
const centerFields = ['id', 'status', 'coreLowTicks', 'coreHighTicks', 'ggTicks', 'ddTicks', 'formationIds', 'closeDirection', 'departureId', 'returnId'];
const signalFields = ['id', 'type', 'layer', 'side', 'priceTicks', 'occurredAt', 'confirmedAt', 'dependencies', 'comparison'];
const suppressedFields = ['type', 'reason', 'comparison', 'dependencies'];
const comparisonFields = ['kind', 'aIds', 'cId', 'a', 'c'];
const segmentFields = ['startTime', 'endTime', 'direction', 'areaUnits', 'extremeTicks'];
const typeOrder = new Map([['first', 0], ['consolidation-divergence-point', 0], ['second', 1], ['third', 2]]);

// M-002: area over (ts, te], same-sign bars only. Returns null when the prefix sum at ts is not retained (window recycled or warm-up).
export function segmentArea(bars, warmupBars, ts, te, direction) {
  const usable = bars.slice(warmupBars);
  if (usable.length === 0 || usable[0].time > ts) return null;
  let area = 0;
  for (const bar of usable) {
    if (bar.time <= ts || bar.time > te) continue;
    if (direction === 'up' && bar.hist > 0) area += bar.hist;
    if (direction === 'down' && bar.hist < 0) area -= bar.hist;
  }
  return area;
}

// Checks the declared contract and the arithmetic that is independent of the algorithm under test
// (areas recomputed from the supplied bars, price/time relations). It never decides which signals should exist.
export function validateSignalFixture(fixture, { fields, time, integer, string, strings, list }) {
  const { input, expected } = fixture;
  fields(input, ['kind', 'macd', 'layer', 'bars', 'items']);
  fields(input.macd, ['fast', 'slow', 'signal', 'warmupBars']);
  Object.values(input.macd).forEach(integer);
  assert(input.macd.fast > 0 && input.macd.slow > input.macd.fast && input.macd.signal > 0 && input.macd.warmupBars >= 0, 'invalid MACD parameters');
  integer(input.layer); assert(input.layer >= 1 && input.layer <= 3, 'signal layer must be 1..3');
  const { bars, items } = input, warmup = input.macd.warmupBars;
  list(bars); list(items); assert(bars.length > warmup && items.length > 0, 'signal fixture needs bars after warm-up and items');
  let previousTime = -1;
  for (const bar of bars) {
    fields(bar, barFields); barFields.forEach(key => integer(bar[key]));
    time(bar.time); time(bar.closeTime);
    assert(bar.time > previousTime && bar.closeTime > bar.time, 'invalid bar ordering');
    previousTime = bar.time;
  }
  const barByEnd = new Map(bars.map(bar => [bar.time, bar]));
  const byId = new Map(), availability = [];
  let previousEnd = -1, availableAt = -1;
  for (const item of items) {
    fields(item, itemFields); string(item.id); assert(!byId.has(item.id), 'duplicate input ID');
    for (const key of ['startTime', 'endTime', 'completedAt']) time(item[key]);
    for (const key of ['startTicks', 'endTicks', 'lowTicks', 'highTicks']) integer(item[key]);
    assert(item.startTime >= previousEnd && item.endTime > item.startTime && item.completedAt >= item.endTime && item.completedAt >= availableAt, 'invalid component ordering');
    assert(item.lowTicks <= item.highTicks && item.startTicks >= item.lowTicks && item.startTicks <= item.highTicks && item.endTicks >= item.lowTicks && item.endTicks <= item.highTicks, 'component range');
    assert(['up', 'down'].includes(item.direction));
    assert(item.direction === 'up' ? item.endTicks > item.startTicks : item.endTicks < item.startTicks, 'direction mismatch');
    strings(item.dependencies);
    const endBar = barByEnd.get(item.endTime);
    assert(endBar && endBar.closeTime <= item.completedAt, 'component end needs a closed bar at its end time');
    if (previousEnd >= 0) assert(item.startTime === previousEnd, 'components must connect');
    byId.set(item.id, item); availability.push(item.completedAt);
    previousEnd = item.endTime; availableAt = item.completedAt;
  }
  const extreme = item => (item.direction === 'up' ? item.highTicks : item.lowTicks);
  const range = ids => {
    const members = ids.map(id => { assert(byId.has(id), `unknown component ${id}`); return byId.get(id); });
    for (let i = 1; i < members.length; i++) assert(members[i].startTime === members[i - 1].endTime, 'segment components must be contiguous');
    const direction = members[0].direction;
    const sameSide = members.filter(m => m.direction === direction);
    return { members, direction, ts: members[0].startTime, te: members.at(-1).endTime, extremeTicks: direction === 'up' ? Math.max(...sameSide.map(m => m.highTicks)) : Math.min(...sameSide.map(m => m.lowTicks)) };
  };
  const checkSegment = (record, ids, label) => {
    fields(record, segmentFields);
    const r = range(ids);
    assert.equal(record.startTime, r.ts, `${label} start`); assert.equal(record.endTime, r.te, `${label} end`);
    assert.equal(record.direction, r.direction, `${label} direction`);
    assert.equal(record.extremeTicks, r.extremeTicks, `${label} extreme`);
    const area = segmentArea(bars, warmup, r.ts, r.te, r.direction);
    assert.equal(record.areaUnits, area, `${label} area does not match the supplied bars`);
    return { ...r, area };
  };
  const checkComparison = comparison => {
    fields(comparison, comparisonFields);
    assert(['trend', 'consolidation'].includes(comparison.kind));
    strings(comparison.aIds); string(comparison.cId);
    const a = checkSegment(comparison.a, comparison.aIds, 'A'), c = checkSegment(comparison.c, [comparison.cId], 'C');
    assert.equal(a.direction, c.direction, 'compared segments must share a direction');
    return { a, c };
  };

  list(expected); assert.equal(expected.length, items.length, 'every prefix needs a snapshot');
  const lockedSignals = new Map(), signalEvents = new Set();
  const centerHistory = new Map();
  for (const [index, snapshot] of expected.entries()) {
    fields(snapshot, ['prefix', 'state', 'signals', 'suppressed', 'events', 'reason']);
    assert.equal(snapshot.prefix, index + 1, 'missing or unordered prefix'); string(snapshot.reason);
    fields(snapshot.state, ['processedCount', 'centers']);
    assert.equal(snapshot.state.processedCount, index + 1);
    list(snapshot.state.centers); list(snapshot.signals); list(snapshot.suppressed); list(snapshot.events);
    const centers = new Map();
    for (const center of snapshot.state.centers) {
      fields(center, centerFields); string(center.id);
      assert.equal(center.id, `${fixture.id}/Z/${centers.size + 1}`, 'center IDs are sequential');
      assert(['open', 'closed'].includes(center.status));
      for (const key of ['coreLowTicks', 'coreHighTicks', 'ggTicks', 'ddTicks']) integer(center[key]);
      assert(center.coreLowTicks <= center.coreHighTicks && center.ddTicks <= center.coreLowTicks && center.ggTicks >= center.coreHighTicks, 'center envelope');
      strings(center.formationIds); assert.equal(center.formationIds.length, 3);
      const formed = center.formationIds.map(id => { assert(byId.has(id) && items.indexOf(byId.get(id)) <= index, 'center uses a future component'); return byId.get(id); });
      assert.equal(center.coreLowTicks, Math.max(...formed.map(m => m.lowTicks)), 'core lower edge is the intersection of the three formation components');
      assert.equal(center.coreHighTicks, Math.min(...formed.map(m => m.highTicks)), 'core upper edge is the intersection of the three formation components');
      assert.equal(center.status === 'closed', center.closeDirection !== null);
      assert(center.closeDirection === null || ['up', 'down'].includes(center.closeDirection));
      for (const key of ['departureId', 'returnId']) assert(center[key] === null || (byId.has(center[key]) && items.indexOf(byId.get(center[key])) <= index), `${key} must be a known earlier component`);
      if (center.status === 'closed') assert(center.departureId !== null && center.returnId !== null, 'a closed center records its departure and return');
      if (centerHistory.has(center.id)) assert.deepEqual(center.formationIds, centerHistory.get(center.id).formationIds, 'center formation is fixed');
      centerHistory.set(center.id, center); centers.set(center.id, center);
    }
    for (const id of centerHistory.keys()) assert(centers.has(id), 'center disappeared');

    const current = new Map();
    for (const signal of snapshot.signals) {
      fields(signal, signalFields); string(signal.id); assert(!current.has(signal.id), 'duplicate signal ID');
      assert(signalTypes.includes(signal.type)); assert.equal(signal.layer, input.layer);
      assert(['buy', 'sell'].includes(signal.side));
      integer(signal.priceTicks); time(signal.occurredAt); time(signal.confirmedAt);
      assert(signal.occurredAt <= signal.confirmedAt && signal.confirmedAt <= availability[index], 'signal confirmed in the future');
      strings(signal.dependencies);
      const triggerId = signal.id.split('/').pop();
      const isNew = !lockedSignals.has(signal.id);
      if (isNew) {
      assert.equal(signal.id, `${fixture.id}/L${input.layer}/${signal.type}/${triggerId}`, 'signal ID convention');
      const trigger = byId.get(triggerId);
      if (signal.type === 'third') {
        const center = centers.get(signal.dependencies[0]);
        assert(center && center.status === 'closed' && center.returnId === triggerId && center.departureId === signal.dependencies[1], 'third class depends on a closed center, its departure and its return');
        assert.deepEqual(signal.dependencies, [center.id, center.departureId, center.returnId]);
        const strictlyAbove = trigger.lowTicks > center.coreHighTicks, strictlyBelow = trigger.highTicks < center.coreLowTicks;
        assert(center.closeDirection === 'up' ? strictlyAbove : strictlyBelow, 'a return that touches the core edge is not a third class point');
        assert.equal(signal.side, center.closeDirection === 'up' ? 'buy' : 'sell');
        assert.equal(signal.priceTicks, center.closeDirection === 'up' ? trigger.lowTicks : trigger.highTicks, 'third class price is the return end');
        assert.equal(signal.comparison, null);
      } else if (signal.type === 'second') {
        const first = lockedSignals.get(signal.dependencies[0]) ?? current.get(signal.dependencies[0]) ?? snapshot.signals.find(s => s.id === signal.dependencies[0]);
        assert(first && first.type === 'first', 'second class depends on a first class point');
        const firstTrigger = byId.get(first.id.split('/').pop()), at = items.indexOf(firstTrigger);
        assert.deepEqual(signal.dependencies, [first.id, items[at + 1].id, items[at + 2].id], 'second class uses the first two components after the first class point');
        assert.equal(triggerId, items[at + 2].id);
        assert.equal(signal.side, first.side);
        assert(first.side === 'sell' ? trigger.highTicks <= first.priceTicks : trigger.lowTicks >= first.priceTicks, 'second class may not pass the first class price');
        assert.equal(signal.priceTicks, extreme(trigger)); assert.equal(signal.comparison, null);
      } else {
        const { a, c } = checkComparison(signal.comparison);
        assert.equal(signal.comparison.kind, signal.type === 'first' ? 'trend' : 'consolidation');
        assert.equal(triggerId, signal.comparison.cId);
        assert(a.area !== null && c.area !== null && c.area < a.area, 'divergence needs a strictly smaller C area');
        assert(c.direction === 'up' ? c.extremeTicks > a.extremeTicks : c.extremeTicks < a.extremeTicks, 'divergence needs a new extreme');
        assert.equal(signal.side, c.direction === 'up' ? 'sell' : 'buy');
        assert.equal(signal.priceTicks, c.extremeTicks);
        assert.equal(signal.confirmedAt, trigger.completedAt, 'divergence confirms with the departure component');
        const center = [...centers.values()].find(z => z.departureId === triggerId);
        assert(center, 'divergence needs a center whose departure is C');
        const order = [...centers.keys()].indexOf(center.id);
        if (signal.type === 'first') {
          assert(order >= 1, 'a trend divergence needs a previous center');
          const previous = [...centers.values()][order - 1];
          assert(previous.status === 'closed' && previous.closeDirection === c.direction, 'the previous center closed in the trend direction');
          assert(c.direction === 'up' ? center.ddTicks > previous.ggTicks : center.ggTicks < previous.ddTicks, 'centers must be strictly separated in the trend direction');
          const start = items.indexOf(byId.get(previous.departureId)), stop = items.indexOf(byId.get(center.formationIds[0]));
          assert.deepEqual(signal.comparison.aIds, items.slice(start, stop).map(m => m.id), 'A runs from the previous departure to the first formation component of the last center');
          assert.deepEqual(signal.dependencies, [center.id, previous.id, ...signal.comparison.aIds, triggerId]);
        } else {
          assert.equal(centers.size, 1, 'consolidation divergence needs exactly one center');
          const entry = items[items.indexOf(byId.get(center.formationIds[0])) - 1];
          assert(entry && signal.comparison.aIds.length === 1 && signal.comparison.aIds[0] === entry.id && entry.direction === c.direction, 'A is the same-direction component right before the first formation component');
          assert.deepEqual(signal.dependencies, [center.id, entry.id, triggerId]);
        }
      }
      assert.equal(signal.occurredAt, trigger.endTime, 'a signal occurs at the end of its trigger component');
      assert.equal(signal.confirmedAt, trigger.completedAt, 'a signal is confirmed when its trigger component is completed');
      }
      if (lockedSignals.has(signal.id)) assert.deepEqual(signal, lockedSignals.get(signal.id), 'confirmed signal changed');
      current.set(signal.id, signal);
    }
    for (const [id, signal] of lockedSignals) {
      assert(current.has(id), 'confirmed signal disappeared'); assert.deepEqual(current.get(id), signal);
    }

    for (const entry of snapshot.suppressed) {
      fields(entry, suppressedFields); assert(signalTypes.includes(entry.type)); assert(suppressReasons.includes(entry.reason));
      strings(entry.dependencies);
      for (const id of entry.dependencies) assert(byId.has(id) || centers.has(id) || current.has(id), `unknown suppressed dependency ${id}`);
      if (entry.comparison !== null) {
        const { a, c } = checkComparison(entry.comparison);
        if (entry.reason === 'area-not-smaller') assert(a.area !== null && c.area !== null && c.area >= a.area, 'area-not-smaller needs C area ≥ A area');
        if (entry.reason === 'not-new-extreme') assert(c.direction === 'up' ? c.extremeTicks <= a.extremeTicks : c.extremeTicks >= a.extremeTicks, 'not-new-extreme needs C not beyond A');
        if (entry.reason === 'area-unavailable') assert(a.area === null || c.area === null, 'area-unavailable needs a missing area');
      } else assert(!['area-not-smaller', 'not-new-extreme', 'area-unavailable'].includes(entry.reason), 'this reason needs a comparison');
      if (entry.reason === 'touch-edge') {
        const [centerId, , returnId] = entry.dependencies, center = centers.get(centerId), ret = byId.get(returnId);
        assert(center && ret, 'touch-edge depends on a center and its return');
        assert(ret.lowTicks === center.coreHighTicks || ret.highTicks === center.coreLowTicks, 'touch-edge needs a return whose range ends exactly on a core edge');
      }
      if (entry.reason === 'breaks-first-class-price') {
        const first = current.get(entry.dependencies[0]); assert(first && first.type === 'first');
        const r2 = byId.get(entry.dependencies[2]);
        assert(first.side === 'sell' ? r2.highTicks > first.priceTicks : r2.lowTicks < first.priceTicks, 'breaks-first-class-price needs r2 beyond the first class price');
      }
    }

    // New signals are listed as events, in commit order, exactly on the prefix that completes their evidence.
    const newSignals = snapshot.signals.filter(s => !lockedSignals.has(s.id));
    assert.deepEqual(snapshot.events, newSignals.map(s => s.id), 'events list the new signals in commit order');
    for (const [position, signal] of newSignals.entries()) {
      assert(!signalEvents.has(signal.id), 'signal emitted twice'); signalEvents.add(signal.id);
      assert.equal(signal.confirmedAt, availability[index], 'a signal is confirmed on the prefix that completes its last evidence');
      if (position > 0) {
        const previous = newSignals[position - 1];
        const key = s => typeOrder.get(s.type);
        assert(key(previous) <= key(signal), 'same-batch signals follow first/divergence → second → third');
      }
    }
    for (const [id, signal] of current) lockedSignals.set(id, signal);
  }
}
