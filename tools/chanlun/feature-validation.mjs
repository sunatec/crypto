import assert from 'node:assert/strict';

const q = JSON.stringify;
const direction = value => ({ waiting: 0, up: 1, down: -1 }[value]);
export const featureStroke = stroke => `ChanStructure.new(${q(stroke.id)}, "stroke", 0, ${direction(stroke.direction)}, ${stroke.startTime}, ${stroke.endTime}, ${stroke.startTicks}, ${stroke.endTicks}, true, ${stroke.completedAt}, "P-001/P-002", array.from(${stroke.dependencies.map(q).join(', ')}), ${stroke.ordinal})`;

export function generateFeatureCase(fixture, caseIndex, { assertion }) {
  const context = fixture.input.context;
  const fresh = () => `chan_feature_new(${q(fixture.id)}, ${direction(context.segmentDirection)}, ${direction(context.initialDirection)}, ${direction(context.postDirection)}, ${context.boundaryTime ?? 'na'}, ${context.secondSequence}, ${context.maxElements}, ${context.maxSources})`;
  const lines = [`chan_case_${caseIndex}() =>`, `    ChanFeatureSequence online = ${fresh()}`];
  fixture.input.items.forEach((stroke, index) => {
    const prefix = index + 1, snapshot = fixture.expected[index], state = snapshot.state, label = `${fixture.id}/prefix-${prefix}`;
    assert.deepEqual(Object.keys(state).sort(), ['inputCount', 'selectedCount', 'mergeDirection', 'boundaryCuts', 'waitingDirection', 'blocked', 'heldId', 'turnKind', 'gap', 'features', 'seedEligible'].sort(), 'unsupported feature state assertion');
    assert(!snapshot.structures.length && !snapshot.events.length, 'feature driver cannot assert segment confirmations');
    lines.push(`    online := chan_feature_step(online, ${featureStroke(stroke)})`);
    const seed = fixture.input.items.slice(0, 3);
    lines.push(assertion(prefix < 3 ? `${state.seedEligible} == false` : `chan_segment_seed(${seed.map(featureStroke).join(', ')}) == ${state.seedEligible}`, `${label}/segment-seed-eligibility`));
    for (const field of ['inputCount', 'selectedCount', 'boundaryCuts', 'waitingDirection', 'blocked']) lines.push(assertion(`online.${field} == ${state[field]}`, `${label}/${field}`));
    lines.push(assertion(`online.mergeDirection == ${direction(state.mergeDirection)}`, `${label}/mergeDirection`));
    lines.push(assertion(state.heldId === null ? 'na(online.heldInput)' : `not na(online.heldInput) and online.heldInput.id == ${q(state.heldId)}`, `${label}/held-input`));
    lines.push(assertion(`online.elements.size() == ${state.features.length}`, `${label}/feature-count`));
    state.features.forEach((feature, position) => {
      const actual = `feature${prefix}_${position}`;
      lines.push(`    ChanFeature ${actual} = online.elements.get(${position})`);
      for (const field of ['id', 'lowTicks', 'highTicks', 'lowTime', 'highTime', 'firstTime', 'lastTime', 'firstOrdinal', 'lastOrdinal', 'firstSide', 'lastSide', 'availableAt', 'sealed']) lines.push(assertion(`${actual}.${field} == ${q(feature[field])}`, `${label}/feature-${position}/${field}`));
      lines.push(assertion(`${actual}.sourceIds.size() == ${feature.sourceIds.length}`, `${label}/feature-${position}/source-count`));
      feature.sourceIds.forEach((id, i) => lines.push(assertion(`${actual}.sourceIds.get(${i}) == ${q(id)}`, `${label}/feature-${position}/source-${i}`)));
    });
    lines.push(`    ChanFeatureTurn turn${prefix} = chan_feature_turn(online)`);
    if (state.turnKind === 'none') lines.push(assertion(`na(turn${prefix})`, `${label}/no-turn`));
    else {
      const middle = state.features.at(-2), top = state.turnKind === 'top';
      lines.push(assertion(`not na(turn${prefix})`, `${label}/turn-exists`));
      lines.push(assertion(`turn${prefix}.kind == ${top ? 1 : -1} and turn${prefix}.gap == ${state.gap}`, `${label}/turn-kind-gap`));
      lines.push(assertion(`turn${prefix}.endpointTime == ${top ? middle.highTime : middle.lowTime} and turn${prefix}.priceTicks == ${top ? middle.highTicks : middle.lowTicks}`, `${label}/turn-endpoint`));
      const triple = state.features.slice(-3);
      ['leftId', 'middleId', 'rightId'].forEach((field, i) => lines.push(assertion(`turn${prefix}.${field} == ${q(triple[i].id)}`, `${label}/turn-${field}`)));
      lines.push(assertion(`turn${prefix}.rightSealed == ${triple[2].sealed} and turn${prefix}.availableAt == ${Math.max(...triple.map(f => f.availableAt))}`, `${label}/turn-availability`));
    }
    lines.push(`    ChanFeatureSequence replay${prefix} = ${fresh()}`);
    fixture.input.items.slice(0, prefix).forEach(prior => lines.push(`    replay${prefix} := chan_feature_step(replay${prefix}, ${featureStroke(prior)})`));
    lines.push(assertion(`chan_feature_signature(online) == chan_feature_signature(replay${prefix})`, `${label}/prefix-reload`));
    lines.push(`    string before${prefix} = chan_feature_signature(online)`, `    ChanFeatureSequence copy${prefix} = chan_feature_clone(online)`, `    copy${prefix} := chan_feature_step(copy${prefix}, ${featureStroke(stroke)})`);
    lines.push(assertion(`chan_feature_signature(copy${prefix}) == before${prefix}`, `${label}/duplicate-input`));
    lines.push(`    if copy${prefix}.elements.size() > 0`, `        copy${prefix}.elements.last().sourceIds.push("copy-probe")`, `    if not na(copy${prefix}.lastInput)`, `        copy${prefix}.lastInput.dependencies.push("copy-probe")`, `    if not na(copy${prefix}.heldInput)`, `        copy${prefix}.heldInput.dependencies.push("copy-probe")`);
    lines.push(assertion(`chan_feature_signature(online) == before${prefix}`, `${label}/deep-copy-isolation`));
  });
  lines.push('    true');
  return lines;
}
