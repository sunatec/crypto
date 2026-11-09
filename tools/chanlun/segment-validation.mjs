import assert from 'node:assert/strict';
import { featureStroke } from './feature-validation.mjs';

const q = JSON.stringify;
export function generateSegmentCase(fixture, caseIndex, { assertion }) {
  const input = fixture.input.items.map((item, i) => ({...item, ordinal:i+1}));
  const fresh = () => `chan_segment_new(${q(fixture.id)}, 64, 8192)`;
  const lines = [`chan_case_${caseIndex}() =>`, `    ChanSegmentState online = ${fresh()}`, '    array<ChanStructure> observed = array.new<ChanStructure>()'];
  input.forEach((item, index) => {
    const prefix=index+1, snapshot=fixture.expected[index], label=`${fixture.id}/prefix-${prefix}`;
    assert.deepEqual(Object.keys(snapshot.state), ['confirmedSegments'], 'unsupported segment state assertion');
    assert(snapshot.structures.every(s=>s.type==='segment' && s.status==='confirmed'), 'unsupported segment structure assertion');
    lines.push(`    string prior${prefix} = chan_segment_signature(online)`, `    ChanSegmentState next${prefix} = chan_segment_step(online, ${featureStroke(item)})`, assertion(`chan_segment_signature(online) == prior${prefix}`, `${label}/source-state-immutable`), `    online := next${prefix}`, '    for event in online.events', '        observed.push(event)');
    lines.push(assertion(`online.segmentCount == ${snapshot.state.confirmedSegments} and observed.size() == ${snapshot.structures.length}`, `${label}/confirmed-count`));
    snapshot.structures.forEach((expected, position)=>{
      const actual=`segment${prefix}_${position}`;
      lines.push(`    ChanStructure ${actual} = observed.get(${position})`);
      lines.push(assertion(`${actual}.id == online.contextId + ${q(`/S/${position+1}/${expected.startTime}`)}`, `${label}/${expected.id}/stable-id`));
      lines.push(assertion(`${actual}.objectType == "segment" and ${actual}.level == 0 and ${actual}.ordinal == ${position+1} and ${actual}.confirmed`, `${label}/${expected.id}/identity`));
      for(const field of ['startTime','endTime','startTicks','endTicks','confirmedAt']) lines.push(assertion(`${actual}.${field} == ${expected[field]}`, `${label}/${expected.id}/${field}`));
      lines.push(assertion(`${actual}.direction == ${expected.direction==='up'?1:-1}`, `${label}/${expected.id}/direction`));
      lines.push(assertion(`${actual}.dependencies.size() == ${expected.dependencies.length}`, `${label}/${expected.id}/source-count`));
      expected.dependencies.forEach((id,i)=>{
        const parent=snapshot.structures.find(s=>s.id===id);
        const dependency=parent?`online.contextId + ${q(`/S/${snapshot.structures.indexOf(parent)+1}/${parent.startTime}`)}`:q(id);
        lines.push(assertion(`${actual}.dependencies.get(${i}) == ${dependency}`,`${label}/${expected.id}/source-${i}`));
      });
      // Bounds + a source witness prove extrema of the independently specified
      // ownership span, without computing a second segmentation algorithm.
      const owned=input.filter(p=>p.startTime>=expected.startTime && p.endTime<=expected.endTime);
      const points=[{time:owned[0].startTime,ticks:owned[0].startTicks},...owned.map(p=>({time:p.endTime,ticks:p.endTicks}))];
      for(const [i,point] of points.entries()) {
        lines.push(assertion(`${actual}.memberLowTicks <= ${point.ticks} and ${actual}.memberHighTicks >= ${point.ticks}`,`${label}/${expected.id}/member-bound-${i}`));
        lines.push(assertion(`(${actual}.memberLowTicks != ${point.ticks} or ${actual}.memberLowTime <= ${point.time}) and (${actual}.memberHighTicks != ${point.ticks} or ${actual}.memberHighTime <= ${point.time})`,`${label}/${expected.id}/member-earliest-${i}`));
      }
      for(const extreme of ['Low','High']) lines.push(assertion(points.map(p=>`(${actual}.member${extreme}Ticks == ${p.ticks} and ${actual}.member${extreme}Time == ${p.time})`).join(' or '),`${label}/${expected.id}/member-${extreme}-witness`));
    });
    lines.push(assertion(`online.events.size() == ${snapshot.events.length}`,`${label}/event-count`));
    snapshot.events.forEach((event,position)=>{
      const expected=snapshot.structures.find(s=>s.id===event.objectId);
      const ordinal=snapshot.structures.indexOf(expected)+1;
      lines.push(assertion(`online.events.get(${position}).ordinal == ${ordinal} and online.events.get(${position}).endTime == ${event.occurredAt} and online.events.get(${position}).confirmedAt == ${event.confirmedAt}`,`${label}/event-${position}`));
    });
    lines.push(`    ChanSegmentState replay${prefix} = ${fresh()}`);
    input.slice(0,prefix).forEach(prior=>lines.push(`    replay${prefix} := chan_segment_step(replay${prefix}, ${featureStroke(prior)})`));
    lines.push(assertion(`chan_segment_signature(online) == chan_segment_signature(replay${prefix})`,`${label}/prefix-reload`));
    lines.push(`    string before${prefix} = chan_segment_signature(online)`, `    ChanSegmentState copy${prefix} = chan_segment_clone(online)`, `    copy${prefix} := chan_segment_step(copy${prefix}, ${featureStroke(item)})`);
    lines.push(assertion(`copy${prefix}.events.size() == 0 and copy${prefix}.segmentCount == online.segmentCount`,`${label}/duplicate-event`));
    lines.push(`    copy${prefix}.events := online.events`,assertion(`chan_segment_signature(copy${prefix}) == before${prefix}`,`${label}/duplicate-state`));
    // Probe a new deep copy; sharing the transient event array above is intentional
    // only for signature equality, never for the mutation isolation test.
    lines.push(`    copy${prefix} := chan_segment_clone(online)`, `    if copy${prefix}.strokes.size() > 0`, `        copy${prefix}.strokes.last().dependencies.push("copy-probe")`, `    if copy${prefix}.events.size() > 0`, `        copy${prefix}.events.first().dependencies.push("copy-probe")`, `    if copy${prefix}.hypotheses.size() > 0`, `        ChanSegmentHypothesis hypothesisProbe${prefix} = copy${prefix}.hypotheses.first()`, `        hypothesisProbe${prefix}.priceTicks += 1`, `    if not na(copy${prefix}.candidate)`, `        copy${prefix}.candidate.dependencies.push("copy-probe")`, `    if not na(copy${prefix}.lastSegment)`, `        copy${prefix}.lastSegment.dependencies.push("copy-probe")`, `    if not na(copy${prefix}.firstContext)`, `        if copy${prefix}.firstContext.elements.size() > 0`, `            copy${prefix}.firstContext.elements.last().sourceIds.push("copy-probe")`, `    if not na(copy${prefix}.secondContext)`, `        if copy${prefix}.secondContext.elements.size() > 0`, `            copy${prefix}.secondContext.elements.last().sourceIds.push("copy-probe")`);
    lines.push(assertion(`chan_segment_signature(online) == before${prefix}`,`${label}/deep-copy-isolation`));
    lines.push(assertion('not online.blocked',`${label}/within-budgets`));
  });
  lines.push('    true');
  return lines;
}

export function generateSegmentLimits(fixtures, {assertion}) {
  const first=fixtures.find(f=>f.id==='S-FIRST-END');
  const equal=fixtures.find(f=>f.id==='S-FIRST-EQUAL-THIRD');
  if(!first || !equal) return [];
  const input=first.input.items.map((s,i)=>({...s,ordinal:i+1}));
  const plateau=equal.input.items.map((s,i)=>({...s,ordinal:i+1}));
  const lines=['chan_segment_limits() =>','    ChanSegmentState work = chan_segment_new("work-limit", 64, 1)'];
  input.forEach(s=>lines.push(`    work := chan_segment_step(work, ${featureStroke(s)})`));
  lines.push(assertion('work.blocked and work.limitReason == "probe-work" and work.segmentCount == 0 and work.events.size() == 0 and work.inputCount == 5 and work.strokes.size() == 5', 'S-LIMIT/atomic-work-stop'));
  lines.push(assertion('not na(work.heldInput) and work.heldInput.id == "p6" and work.lastInput.id == "p5"','S-LIMIT/preserve-unconsumed-input'));
  const last=plateau.at(-1);
  const future={id:'future-7',ordinal:7,startTime:last.endTime,endTime:last.endTime+60000,completedAt:last.endTime+120000,startTicks:last.endTicks,endTicks:last.endTicks+1,direction:'up',dependencies:['f6','f7','proof7']};
  lines.push(`    work := chan_segment_step(work, ${featureStroke(future)})`,assertion('work.blocked and work.segmentCount == 0 and work.events.size() == 0 and work.heldInput.id == "p6"','S-LIMIT/blocked-future-does-not-restart'));
  lines.push('    ChanSegmentState pending = chan_segment_new("pending-limit", 6, 8192)');
  plateau.forEach(s=>lines.push(`    pending := chan_segment_step(pending, ${featureStroke(s)})`));
  lines.push(assertion('not pending.blocked and pending.segmentCount == 0 and pending.strokes.size() == 6', 'S-LIMIT/pending-before-cap'));
  lines.push(`    pending := chan_segment_step(pending, ${featureStroke(future)})`,assertion('pending.blocked and pending.limitReason == "pending-strokes" and pending.strokes.size() == 6 and pending.inputCount == 6 and pending.events.size() == 0', 'S-LIMIT/pending-cap-preserves-prefix'));
  lines.push('    true');
  return lines;
}
