import assert from 'node:assert/strict';

// Emit assertions against the production Pine state; never calculate expected strokes.
export function generateStrokeCase(fixture, caseIndex, { fractal, assertion }) {
  const q = JSON.stringify;
  const lines = [`chan_case_${caseIndex}() =>`, `    ChanState online = chan_new(${q(fixture.id)})`, '    array<ChanStructure> observed = array.new<ChanStructure>()'];
  fixture.input.items.forEach((point, index) => {
    const prefix = index + 1, snapshot = fixture.expected[index], context = `${fixture.id}/prefix-${prefix}`;
    lines.push(`    online := chan_stroke_step(online, ${fractal(point)})`, '    if not na(online.strokeEvent)', '        observed.push(online.strokeEvent)');
    for (const [key, value] of Object.entries(snapshot.state)) {
      let actual;
      if (key === 'confirmedStrokes') actual = 'online.strokeCount';
      else if (key === 'strokeDirection') actual = '(na(online.strokeCandidate) ? 0 : online.strokeCandidate.direction)';
      else {
        const field = { strokeCandidateStartTime: 'startTime', strokeCandidateEndTime: 'endTime', strokeCandidateStartTicks: 'startTicks', strokeCandidateEndTicks: 'endTicks' }[key];
        assert(field, `unsupported stroke state: ${key}`);
        actual = `(na(online.strokeCandidate) ? na : online.strokeCandidate.${field})`;
      }
      const expected = key === 'strokeDirection' ? { none: 0, up: 1, down: -1 }[value] : value;
      lines.push(assertion(expected === null ? `na(${actual})` : `${actual} == ${expected}`, `${context}/${key}`));
    }
    const locked = snapshot.structures.filter(s => s.status === 'confirmed');
    const candidate = snapshot.structures.filter(s => s.status === 'candidate');
    assert(candidate.length <= 1 && snapshot.structures.every(s => s.type === 'stroke'));
    lines.push(assertion(`observed.size() == ${locked.length}`, `${context}/confirmed-prefix-count`));
    for (const [objectIndex, expected] of snapshot.structures.entries()) {
      const variable = `actual${prefix}_${objectIndex}`;
      const ordinal = expected.status === 'confirmed' ? locked.indexOf(expected) + 1 : locked.length + 1;
      lines.push(`    ChanStructure ${variable} = ${expected.status === 'confirmed' ? `observed.get(${ordinal - 1})` : 'online.strokeCandidate'}`);
      lines.push(assertion(`not na(${variable})`, `${context}/${expected.id}/exists`));
      lines.push(assertion(`${variable}.id == online.contextId + ${q(`/P/${ordinal}/${expected.startTime}`)}`, `${context}/${expected.id}/stable-id`));
      lines.push(assertion(`${variable}.ordinal == ${ordinal} and ${variable}.objectType == "stroke" and ${variable}.level == 0`, `${context}/${expected.id}/identity`));
      lines.push(assertion(`${variable}.direction == ${expected.direction === 'up' ? 1 : -1}`, `${context}/${expected.id}/direction`));
      for (const field of ['startTime', 'endTime', 'startTicks', 'endTicks']) lines.push(assertion(`${variable}.${field} == ${expected[field]}`, `${context}/${expected.id}/${field}`));
      lines.push(assertion(`${variable}.confirmed == ${expected.status === 'confirmed'}`, `${context}/${expected.id}/state`));
      lines.push(assertion(expected.confirmedAt === null ? `na(${variable}.confirmedAt)` : `${variable}.confirmedAt == ${expected.confirmedAt}`, `${context}/${expected.id}/confirmed-at`));
      lines.push(assertion(`${variable}.dependencies.size() == ${expected.dependencies.length}`, `${context}/${expected.id}/dependency-count`));
      expected.dependencies.forEach((id, i) => lines.push(assertion(`${variable}.dependencies.get(${i}) == ${q(id)}`, `${context}/${expected.id}/dependency-${i}`)));
    }
    if (!candidate.length) lines.push(assertion('na(online.strokeCandidate)', `${context}/no-candidate`));
    assert(snapshot.events.length <= 1 && snapshot.events.every(e => e.type === 'stroke'));
    if (!snapshot.events.length) lines.push(assertion('na(online.strokeEvent)', `${context}/no-event`));
    else {
      const event = snapshot.events[0], object = locked.find(s => s.id === event.objectId);
      assert(object, 'unbound stroke event');
      const ordinal = locked.indexOf(object) + 1;
      lines.push(assertion(`not na(online.strokeEvent) and online.strokeEvent.ordinal == ${ordinal} and online.strokeEvent.endTime == ${event.occurredAt} and online.strokeEvent.confirmedAt == ${event.confirmedAt}`, `${context}/event`));
    }
    lines.push(`    ChanState replay${prefix} = chan_new(${q(fixture.id)})`);
    fixture.input.items.slice(0, prefix).forEach(prior => lines.push(`    replay${prefix} := chan_stroke_step(replay${prefix}, ${fractal(prior)})`));
    lines.push(assertion(`chan_signature(online) == chan_signature(replay${prefix})`, `${context}/prefix-reload`));
    lines.push(`    ChanState duplicate${prefix} = chan_clone(online)`, `    duplicate${prefix} := chan_stroke_step(duplicate${prefix}, ${fractal(point)})`);
    lines.push(assertion(`na(duplicate${prefix}.strokeEvent) and duplicate${prefix}.strokeCount == online.strokeCount`, `${context}/duplicate-event`));
    lines.push(`    duplicate${prefix}.strokeEvent := online.strokeEvent`);
    lines.push(assertion(`chan_signature(online) == chan_signature(duplicate${prefix})`, `${context}/duplicate-state`));
    lines.push(`    string before${prefix} = chan_signature(online)`, `    ChanState preview${prefix} = chan_clone(online)`, `    if not na(preview${prefix}.strokeAnchor)`, `        preview${prefix}.strokeAnchor.priceTicks += 1`, `    if not na(preview${prefix}.strokeCandidate)`, `        preview${prefix}.strokeCandidate.dependencies.push("copy-isolation-probe")`, `    if not na(preview${prefix}.lastStroke)`, `        preview${prefix}.lastStroke.dependencies.push("copy-isolation-probe")`);
    lines.push(assertion(`chan_signature(online) == before${prefix}`, `${context}/deep-copy-isolation`));
  });
  lines.push('    true');
  return lines;
}
