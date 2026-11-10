import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {extractCore} from './build-validation.mjs';
import {component} from './build-center-validation.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const q=JSON.stringify,sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const keys=(o,allowed)=>assert(Object.keys(o).every(k=>allowed.includes(k)),'unknown R expectation field');
const STATE=['active','dir','trunc','members','first','centers','done','submitted','start','blocked','kind','held','capped','event'];
const EVENT=['end','range','members','centers','type','truncated','confirmed','upper','startTicks'];
const SOURCES=['C18-39','C18-40','C88-223'],RULES=['R-002','R-003','R-004','R-005','R-006'];
function validateInputs(c,level){
  assert(c.inputs.length>0);
  c.inputs.forEach((p,i)=>{
    assert(p.length===4 && p.every(Number.isSafeInteger));const [a,b,lo,hi]=p;
    assert(a!==b && lo<hi && lo===Math.min(a,b) && hi===Math.max(a,b),'R inputs use endpoint intervals');
    if(i){
      const [pa,pb]=c.inputs[i-1];
      assert(Math.sign(b-a)!==Math.sign(pb-pa),'component alternation');
      // L0 parts share real endpoints; a part submitted from below only has to meet in time.
      if(level===1)assert(pb===a,'component continuity');
    }
  });
}
function validateStates(c,expected,{submit}){
  let prior=null;
  expected.forEach((e,i)=>{
    keys(e,STATE);const n=i+1;
    for(const k of ['active','trunc','blocked','capped'])assert.equal(typeof e[k],'boolean',k);
    for(const k of ['dir','members','first','centers','done','submitted','start','held'])assert(Number.isInteger(e[k]),k);
    assert(e.kind==='' || e.kind==='budget' || e.kind==='rule','block kind');
    assert(e.blocked===(e.kind!=='') && (e.held>0)===e.blocked,'block fields agree');
    assert(e.active?Math.abs(e.dir)===1:e.dir===0,'direction only when active');
    assert(!e.trunc || e.active,'truncated start needs an active movement');
    assert(e.members>=1 && e.first>=1 && e.first<=n && e.centers>=0,'member bookkeeping');
    assert(e.done>=(prior?.done??0) && e.done<=(prior?.done??0)+1,'completions only advance by one');
    assert.equal(Boolean(e.event),e.done===(prior?.done??0)+1,'a completion needs an event and vice versa');
    assert(e.submitted<=e.done && e.submitted>=(prior?.submitted??0),'submissions');
    assert(!(prior?.capped)||e.capped,'capped is sticky');
    if(submit)assert(!e.capped,'only the top layer is capped');
    if(e.event){
      const v=e.event;keys(v,EVENT);
      assert(v.end.length===2 && v.end.every(Number.isInteger) && v.end[0]>=1 && v.end[0]<=n,'endpoint ordinal');
      assert(v.range.length===2 && v.range[0]<=v.range[1] && v.range.every(Number.isInteger),'range');
      assert(v.members.length===2 && v.members[0]<=v.end[0] && v.end[0]===v.members[1],'endpoint belongs to the last member');
      assert(['consolidation','trend','expansion-evidence'].includes(v.type) && v.centers>=1);
      assert((v.type==='consolidation')===(v.centers===1),'consolidation means exactly one center');
      assert(v.confirmed===n,'confirmed on the closing input');assert.equal(e.submitted,(prior?.submitted??0)+(v.upper?1:0));
      assert(!(v.truncated&&v.upper),'a truncated start is never submitted');
      assert(!(v.upper&&!submit),'the top layer submits nothing');
      assert(v.truncated||v.upper===submit,'a complete movement is submitted unless the layer is capped');
      assert(!submit && !v.truncated ? e.capped : true,'a capped completion marks the layer');
      assert(e.first===v.end[0]+1,'carried members start after the endpoint');
      assert(Number.isInteger(v.startTicks));
    }
    prior=e;
  });
}
export function validateRecursionCases(data){
  assert.equal(data.schemaVersion,1);assert.deepEqual(data.sourceIds,SOURCES);assert.deepEqual(data.ruleIds,RULES);
  assert(data.note && data.cases.length);const ids=new Set();
  for(const c of data.cases){
    keys(c,['id','maxMembers','level','submit','inputs','expected']);assert(!ids.has(c.id),'duplicate R case');ids.add(c.id);
    const level=c.level??1;assert([1,2,3].includes(level));
    assert.equal(c.inputs.length,c.expected.length,'every prefix needs expectation');
    validateInputs(c,level);validateStates(c,c.expected,{submit:c.submit??true});
  }
  return data;
}
export function validateChainCases(data){
  assert.equal(data.schemaVersion,1);assert.deepEqual(data.sourceIds,SOURCES);assert.deepEqual(data.ruleIds,RULES);
  assert(data.note && data.cases.length);const ids=new Set();
  for(const c of data.cases){
    keys(c,['id','levelLimit','inputs','expected']);assert(!ids.has(c.id),'duplicate chain case');ids.add(c.id);
    assert([1,2,3].includes(c.levelLimit));assert.equal(c.inputs.length,c.expected.length,'every prefix needs expectation');
    validateInputs(c,1);validateStates(c,c.expected.map(x=>x.l1),{submit:c.levelLimit>=2});
    let priorIn=0,formed=0;
    c.expected.forEach((x,i)=>{
      keys(x,['l1','l2in','l2centers','l3in','l2']);
      assert(Number.isInteger(x.l2in) && x.l2in>=priorIn && x.l2in<=priorIn+1,'L2 inputs advance by one');
      assert.equal(x.l2in,c.levelLimit>=2?x.l1.submitted:0,'L2 receives exactly what L1 submitted');
      assert(Number.isInteger(x.l2centers) && x.l2centers>=formed && x.l2centers<=formed+1);
      assert.equal(x.l3in,0);
      if(x.l2){
        keys(x.l2,['core','stats','from']);
        assert.equal(x.l2centers,formed+1,'a formation event adds one center');
        assert(x.l2.core.length===2 && x.l2.core[0]<=x.l2.core[1] && x.l2.stats.length===4 && x.l2.stats.every(Number.isInteger));
        assert(Number.isInteger(x.l2.from) && x.l2.from>=1 && x.l2.from+2<=x.l2in,'center sources are submitted parts');
      }else assert.equal(x.l2centers,formed,'no center without a formation event');
      priorIn=x.l2in;formed=x.l2centers;
    });
  }
  return data;
}
const expectedCtor=e=>{
  const v=e.event;
  const f=[e.active,e.dir,e.trunc,e.members,e.first,e.centers,e.done,e.submitted,e.start,e.blocked,q(e.kind),e.held,!!v,
    v?v.end[0]:0,v?v.end[1]:0,v?v.range[0]:0,v?v.range[1]:0,v?v.members[0]:0,v?v.members[1]:0,v?v.centers:0,q(v?v.type:''),v?v.truncated:false,v?v.confirmed:0,v?v.upper:false,v?v.startTicks:0,e.capped];
  return `ChanRExpected.new(${f.join(', ')})`;
};
const fixtureLoader=(c,i,prefix,extra)=>[`chan_${prefix}_case_${i}() =>`,'    ChanRFixture result = ChanRFixture.new()',`    result.id := ${q(c.id)}`,`    result.limit := ${c.maxMembers??128}`,`    result.level := ${c.level??1}`,`    result.submit := ${c.submit??true}`,`    result.inputs := array.from(${c.inputs.map((p,j)=>component(c,p,j)).join(', ')})`,`    result.expected := array.from(${c.expected.map(extra?x=>expectedCtor(x.l1):expectedCtor).join(', ')})`,'    result',''];
const SHARED=`
type ChanRExpected
    bool active
    int dir
    bool trunc
    int members
    int first
    int centers
    int done
    int submitted
    int start
    bool blocked
    string kind
    int held
    bool hasEvent
    int endOrdinal
    int endTicks
    int low
    int high
    int memberFirst
    int memberLast
    int eventCenters
    string morphology
    bool eventTruncated
    int confirmedOrdinal
    bool hasUpper
    int eventStart
    bool capped
type ChanRFixture
    string id
    int limit
    int level
    bool submit
    array<ChanComponent> inputs
    array<ChanRExpected> expected
type ChanRPair
    ChanCenterState centers
    ChanMovementState movements
chan_rv_assert(bool condition, string context) =>
    if not condition
        runtime.error("FAIL: " + context)
    true
chan_rv_pair(ChanRFixture fixture) =>
    ChanRPair result = ChanRPair.new()
    result.centers := chan_center_new_level(fixture.id, 64, fixture.level)
    result.movements := chan_movement_new_level(fixture.id, fixture.limit, fixture.level, fixture.submit)
    result
chan_rv_advance(ChanRPair source, ChanComponent step) =>
    ChanRPair result = ChanRPair.new()
    result.centers := chan_center_step(source.centers, step)
    result.movements := chan_movement_step(source.movements, step, result.centers)
    result
chan_rv_event(ChanRFixture fixture, ChanRExpected expected, ChanMovementState next, string context) =>
    ChanMovement m = next.event
    ChanComponent endInput = fixture.inputs.get(expected.endOrdinal - 1)
    ChanComponent firstMember = fixture.inputs.get(expected.memberFirst - 1)
    chan_rv_assert(m.id == fixture.id + "/L" + str.tostring(fixture.level) + "/R/" + str.tostring(next.count) + "/" + str.tostring(firstMember.realStartTime) and m.level == fixture.level and m.ordinal == next.count and m.completed, context + "/identity")
    chan_rv_assert(m.direction == (expected.endTicks > expected.eventStart ? 1 : -1), context + "/direction")
    chan_rv_assert(m.startTime == firstMember.realStartTime and m.startTicks == expected.eventStart, context + "/start")
    chan_rv_assert(m.endTime == endInput.realEndTime and m.occurredAt == endInput.realEndTime and m.endTicks == expected.endTicks, context + "/endpoint expected=" + str.tostring(expected.endTicks) + " actual=" + str.tostring(m.endTicks))
    chan_rv_assert(m.lowTicks == expected.low and m.highTicks == expected.high, context + "/range expected=" + str.tostring(expected.low) + ".." + str.tostring(expected.high) + " actual=" + str.tostring(m.lowTicks) + ".." + str.tostring(m.highTicks))
    chan_rv_assert(m.childIds.size() == expected.memberLast - expected.memberFirst + 1 and m.childIds.first() == firstMember.id and m.childIds.last() == endInput.id, context + "/members")
    chan_rv_assert(m.centerIds.size() == expected.eventCenters and m.morphology == expected.morphology and m.truncated == expected.eventTruncated, context + "/type expected=" + expected.morphology + " actual=" + m.morphology)
    chan_rv_assert(m.confirmedAt == fixture.inputs.get(expected.confirmedOrdinal - 1).confirmedAt and m.occurredAt <= m.confirmedAt, context + "/clock")
    chan_rv_assert(na(m.upper) == (not expected.hasUpper), context + "/upper-presence")
    if expected.hasUpper
        ChanComponent upper = m.upper
        chan_rv_assert(chan_center_valid(upper) and upper.id == m.id and upper.direction == m.direction and upper.confirmedAt == m.confirmedAt and upper.ordinal == next.submitted, context + "/upper-component")
        chan_rv_assert(upper.realStartTime == m.startTime and upper.realEndTime == m.endTime and upper.realStartTicks == m.startTicks and upper.realEndTicks == m.endTicks and upper.actualLowTicks == m.lowTicks and upper.actualHighTicks == m.highTicks, context + "/upper-geometry")
    true
chan_rv_check(ChanRFixture fixture, ChanRExpected expected, ChanMovementState next, int prefix, string context) =>
    chan_rv_assert(next.active == expected.active and next.direction == expected.dir and next.truncated == expected.trunc, context + "/state active=" + str.tostring(next.active) + " dir=" + str.tostring(next.direction) + " trunc=" + str.tostring(next.truncated))
    chan_rv_assert(next.members.size() == expected.members and (next.members.size() > 0 ? next.members.first().ordinal : 0) == expected.first, context + "/members expected=" + str.tostring(expected.members) + "/" + str.tostring(expected.first) + " actual=" + str.tostring(next.members.size()) + "/" + str.tostring(next.members.size() > 0 ? next.members.first().ordinal : 0))
    chan_rv_assert(next.centers.size() == expected.centers, context + "/center-set expected=" + str.tostring(expected.centers) + " actual=" + str.tostring(next.centers.size()))
    chan_rv_assert(next.count == expected.done and next.submitted == expected.submitted, context + "/completed expected=" + str.tostring(expected.done) + "/" + str.tostring(expected.submitted) + " actual=" + str.tostring(next.count) + "/" + str.tostring(next.submitted))
    chan_rv_assert(next.capped == expected.capped, context + "/capped expected=" + str.tostring(expected.capped) + " actual=" + str.tostring(next.capped))
    chan_rv_assert(next.startTicks == expected.start, context + "/start-price expected=" + str.tostring(expected.start) + " actual=" + str.tostring(next.startTicks))
    chan_rv_assert(next.blocked == expected.blocked and next.blockKind == expected.kind and (na(next.heldInput) ? 0 : next.heldInput.ordinal) == expected.held, context + "/stop-kind")
    chan_rv_assert(next.inputCount == (expected.held > 0 ? expected.held - 1 : prefix + 1), context + "/atomic-consumption")
    chan_rv_assert(na(next.event) == (not expected.hasEvent), context + "/completion-event")
    if expected.hasEvent
        chan_rv_event(fixture, expected, next, context)
    true
chan_rv_probe(ChanMovementState next) =>
    string committed = chan_movement_signature(next)
    ChanMovementState copy = chan_movement_clone(next)
    if copy.members.size() > 0
        ChanComponent memberProbe = copy.members.first()
        memberProbe.dependencies.push("copy-probe")
        copy.members.push(memberProbe)
    if copy.centers.size() > 0
        ChanCenter centerProbe = copy.centers.first()
        centerProbe.dependencies.push("copy-probe")
        centerProbe.coreLowTicks += 1
    if not na(copy.event)
        copy.event.childIds.push("copy-probe")
        copy.event.lowTicks += 1
        if not na(copy.event.upper)
            copy.event.upper.dependencies.push("copy-probe")
    if copy.history.size() > 0
        ChanMovement historyProbe = copy.history.first()
        historyProbe.centerIds.push("copy-probe")
    if not na(copy.heldInput)
        copy.heldInput.dependencies.push("copy-probe")
    chan_movement_signature(next) == committed
`;
function dispatcher(name,type,count){
  const lines=[`${name}(int index) =>`,`    ${type} result = ${type}.new()`];
  for(let i=0;i<count;i++)lines.push(`    ${i?'else if':'if'} index == ${i}`,`        result := ${name}_${i}()`);
  lines.push('    result');return lines;
}
export function generateRecursionValidation(source,data){
  validateRecursionCases(data);const core=extractCore(source),coreHash=sha(core);
  const loader=[];let prefixes=0;
  data.cases.forEach((c,i)=>{prefixes+=c.inputs.length;loader.push(...fixtureLoader(c,i,'rv',false));});
  loader.push(...dispatcher('chan_rv_case','ChanRFixture',data.cases.length));
  const harness=`${SHARED}
chan_rv_step(ChanRPair online, ChanRFixture fixture, int prefix, array<ChanMovement> observed, array<string> originals) =>
    string context = fixture.id + "/prefix-" + str.tostring(prefix + 1)
    string centerBefore = chan_center_signature(online.centers)
    string before = chan_movement_signature(online.movements)
    ChanComponent step = fixture.inputs.get(prefix)
    string inputBefore = chan_component_signature(step)
    ChanRPair pair = chan_rv_advance(online, step)
    ChanMovementState next = pair.movements
    chan_rv_assert(chan_movement_signature(online.movements) == before and chan_center_signature(online.centers) == centerBefore and chan_component_signature(step) == inputBefore, context + "/source-immutable")
    ChanRExpected expected = fixture.expected.get(prefix)
    chan_rv_check(fixture, expected, next, prefix, context)
    if expected.hasEvent
        observed.push(next.event)
        originals.push(chan_movement_record_signature(next.event))
    chan_rv_assert(observed.size() == expected.done, context + "/unique-completion")
    if observed.size() > 0
        for i = 0 to observed.size() - 1
            chan_rv_assert(chan_movement_record_signature(observed.get(i)) == originals.get(i), context + "/completion-immutable")
    chan_rv_assert(next.history.size() == math.min(15, observed.size()), context + "/bounded-archive")
    ChanRPair replay = chan_rv_pair(fixture)
    for i = 0 to prefix
        replay := chan_rv_advance(replay, fixture.inputs.get(i))
    chan_rv_assert(chan_movement_signature(next) == chan_movement_signature(replay.movements), context + "/prefix-reload")
    ChanMovementState duplicate = chan_movement_step(next, step, pair.centers)
    chan_rv_assert(na(duplicate.event), context + "/duplicate-event")
    duplicate.event := next.event
    chan_rv_assert(chan_movement_signature(duplicate) == chan_movement_signature(next), context + "/duplicate-state")
    chan_rv_assert(chan_rv_probe(next), context + "/copy-isolation")
    pair
`;
  const schedule=`
var int caseIndex = 0
var int prefix = 0
var int checked = 0
var ChanRPair online = na
var array<ChanMovement> observed = array.new<ChanMovement>()
var array<string> originals = array.new<string>()
var table result = table.new(position.top_right, 1, 2)
if barstate.isconfirmed and caseIndex < ${data.cases.length}
    ChanRFixture fixture = chan_rv_case(caseIndex)
    if prefix == 0
        online := chan_rv_pair(fixture)
        observed := array.new<ChanMovement>()
        originals := array.new<string>()
    online := chan_rv_step(online, fixture, prefix, observed, originals)
    prefix += 1
    checked += 1
    if prefix == fixture.inputs.size()
        prefix := 0
        caseIndex += 1
bool passed = caseIndex == ${data.cases.length}
table.cell(result, 0, 0, passed ? "PASS: ${data.cases.length} R cases, ${prefixes} prefixes" : "RUNNING: " + str.tostring(checked), text_color = passed ? color.green : color.orange)
table.cell(result, 0, 1, "合成L0／上层部件输入 · 走势完成（结构确立路径）· 需要${prefixes}根已收盘K线")
plot(na)
`;
  const output=['//@version=6','indicator("缠论 走势完成共享验证", overlay=false)',`// CORE ${coreHash}; fixture ${sha(JSON.stringify(data))}`,core,harness,loader.join('\n'),schedule].join('\n')+'\n';
  return {source:output,coreHash,sha256:sha(output),bytes:Buffer.byteLength(output),cases:data.cases.length,prefixes,fixtureHash:sha(JSON.stringify(data)),execution:'not run in Pine'};
}
export function generateChainValidation(source,data){
  validateChainCases(data);const core=extractCore(source),coreHash=sha(core);
  const loader=[];let prefixes=0;
  data.cases.forEach((c,i)=>{
    prefixes+=c.inputs.length;
    const base={...c,level:1,submit:c.levelLimit>=2};
    loader.push(...fixtureLoader(base,i,'rc_base',true));
    const extras=c.expected.map(x=>{const l=x.l2;return `ChanRChainExpected.new(${x.l2in}, ${x.l2centers}, ${x.l3in}, ${!!l}, ${l?l.core[0]:0}, ${l?l.core[1]:0}, ${l?l.stats.join(', '):'0, 0, 0, 0'}, ${l?l.from:0})`;});
    loader.push(`chan_rc_extra_${i}() =>`,`    array.from(${extras.join(', ')})`,'',`chan_rc_case_${i}() =>`,'    ChanRChainFixture result = ChanRChainFixture.new()',`    result.base := chan_rc_base_case_${i}()`,`    result.levelLimit := ${c.levelLimit}`,`    result.extras := chan_rc_extra_${i}()`,'    result','');
  });
  loader.push(...dispatcher('chan_rc_case','ChanRChainFixture',data.cases.length));
  const harness=`${SHARED}
type ChanRChainExpected
    int l2in
    int l2centers
    int l3in
    bool l2event
    int coreLow
    int coreHigh
    int gg
    int g
    int d
    int dd
    int from
type ChanRChainFixture
    ChanRFixture base
    int levelLimit
    array<ChanRChainExpected> extras
chan_rc_stack(ChanRChainFixture fixture) =>
    ChanStack result = ChanStack.new()
    result.centers := chan_center_new(fixture.base.id, 64)
    result.movements := chan_movement_new_level(fixture.base.id, 128, 1, fixture.levelLimit >= 2)
    result.levels := chan_levels_new(fixture.base.id, 64, fixture.levelLimit)
    result
chan_rc_signature(ChanStack source) =>
    chan_center_signature(source.centers) + "/R/" + chan_movement_signature(source.movements) + "/levels/" + chan_levels_signature(source.levels)
chan_rc_step(ChanStack online, ChanRChainFixture fixture, int prefix, array<ChanMovement> observed, array<string> originals, array<string> submittedIds, array<ChanCenter> observed2, array<string> originals2) =>
    ChanRFixture base = fixture.base
    string context = base.id + "/prefix-" + str.tostring(prefix + 1)
    string before = chan_rc_signature(online)
    ChanComponent step = base.inputs.get(prefix)
    ChanStack next = chan_stack_step(online, step)
    chan_rv_assert(chan_rc_signature(online) == before, context + "/source-immutable")
    chan_rv_check(base, base.expected.get(prefix), next.movements, prefix, context)
    if not na(next.movements.event)
        observed.push(next.movements.event)
        originals.push(chan_movement_record_signature(next.movements.event))
        if not na(next.movements.event.upper)
            submittedIds.push(next.movements.event.id)
    chan_rv_assert(submittedIds.size() == next.movements.submitted, context + "/submitted-parts")
    ChanRChainExpected x = fixture.extras.get(prefix)
    ChanLevels levels = next.levels
    chan_rv_assert(levels.centers2.inputCount == x.l2in and levels.movements2.inputCount == x.l2in, context + "/L2-inputs expected=" + str.tostring(x.l2in) + " actual=" + str.tostring(levels.centers2.inputCount))
    chan_rv_assert(levels.centers3.inputCount == x.l3in and levels.movements3.inputCount == x.l3in, context + "/L3-inputs expected=" + str.tostring(x.l3in) + " actual=" + str.tostring(levels.centers3.inputCount))
    chan_rv_assert(levels.centers2.count == x.l2centers, context + "/L2-centers expected=" + str.tostring(x.l2centers) + " actual=" + str.tostring(levels.centers2.count))
    chan_rv_assert(na(levels.centers2.event) == (not x.l2event) and na(levels.movements2.event) and na(levels.centers3.event), context + "/L2-events")
    if x.l2event
        ChanCenter z = levels.centers2.event
        int firstStart = na
        for m in observed
            if m.id == submittedIds.get(x.from - 1)
                firstStart := m.startTime
        chan_rv_assert(z.level == 2 and z.ordinal == levels.centers2.count and z.coreLowTicks == x.coreLow and z.coreHighTicks == x.coreHigh, context + "/L2-core expected=" + str.tostring(x.coreLow) + ".." + str.tostring(x.coreHigh) + " actual=" + str.tostring(z.coreLowTicks) + ".." + str.tostring(z.coreHighTicks))
        chan_rv_assert(z.ggTicks == x.gg and z.gTicks == x.g and z.dTicks == x.d and z.ddTicks == x.dd, context + "/L2-statistics")
        chan_rv_assert(z.dependencies.size() == 3, context + "/L2-source-count")
        for i = 0 to 2
            chan_rv_assert(z.dependencies.get(i) == submittedIds.get(x.from - 1 + i), context + "/L2-source-provenance")
        chan_rv_assert(z.id == base.id + "/L2/Z/" + str.tostring(levels.centers2.count) + "/" + str.tostring(firstStart) and z.startTime == firstStart, context + "/L2-identity")
        observed2.push(z)
        originals2.push(chan_center_record_signature(z))
    chan_rv_assert(observed2.size() == levels.centers2.count, context + "/L2-unique-formation")
    if observed2.size() > 0
        for i = 0 to observed2.size() - 1
            chan_rv_assert(chan_center_record_signature(observed2.get(i)) == originals2.get(i), context + "/L2-formation-immutable")
    if observed.size() > 0
        for i = 0 to observed.size() - 1
            chan_rv_assert(chan_movement_record_signature(observed.get(i)) == originals.get(i), context + "/L1-completion-immutable")
    ChanRPair lower = chan_rv_pair(base)
    ChanStack replay = chan_rc_stack(fixture)
    for i = 0 to prefix
        lower := chan_rv_advance(lower, base.inputs.get(i))
        replay := chan_stack_step(replay, base.inputs.get(i))
    chan_rv_assert(chan_movement_signature(next.movements) == chan_movement_signature(lower.movements) and chan_center_signature(next.centers) == chan_center_signature(lower.centers), context + "/upper-layers-do-not-rewrite-L1")
    chan_rv_assert(chan_rc_signature(next) == chan_rc_signature(replay), context + "/prefix-reload")
    ChanStack duplicate = chan_stack_step(next, step)
    chan_rv_assert(na(duplicate.movements.event) and na(duplicate.levels.centers2.event) and na(duplicate.levels.movements2.event) and duplicate.levels.centers2.inputCount == levels.centers2.inputCount and duplicate.movements.submitted == next.movements.submitted, context + "/duplicate-event")
    string committed = chan_levels_signature(next.levels)
    ChanLevels copy = chan_levels_clone(next.levels)
    if copy.centers2.seed.size() > 0
        ChanComponent seedProbe = copy.centers2.seed.first()
        seedProbe.dependencies.push("copy-probe")
    if not na(copy.centers2.center)
        copy.centers2.center.dependencies.push("copy-probe")
        copy.centers2.center.coreLowTicks += 1
    if not na(copy.centers2.lastInput)
        copy.centers2.lastInput.dependencies.push("copy-probe")
    if copy.movements2.members.size() > 0
        ChanComponent memberProbe = copy.movements2.members.first()
        memberProbe.dependencies.push("copy-probe")
    chan_rv_assert(chan_levels_signature(next.levels) == committed, context + "/copy-isolation")
    next
`;
  const schedule=`
var int caseIndex = 0
var int prefix = 0
var int checked = 0
var ChanStack online = na
var array<ChanMovement> observed = array.new<ChanMovement>()
var array<string> originals = array.new<string>()
var array<string> submittedIds = array.new<string>()
var array<ChanCenter> observed2 = array.new<ChanCenter>()
var array<string> originals2 = array.new<string>()
var table result = table.new(position.top_right, 1, 2)
if barstate.isconfirmed and caseIndex < ${data.cases.length}
    ChanRChainFixture fixture = chan_rc_case(caseIndex)
    if prefix == 0
        online := chan_rc_stack(fixture)
        observed := array.new<ChanMovement>()
        originals := array.new<string>()
        submittedIds := array.new<string>()
        observed2 := array.new<ChanCenter>()
        originals2 := array.new<string>()
    online := chan_rc_step(online, fixture, prefix, observed, originals, submittedIds, observed2, originals2)
    prefix += 1
    checked += 1
    if prefix == fixture.base.inputs.size()
        prefix := 0
        caseIndex += 1
bool passed = caseIndex == ${data.cases.length}
table.cell(result, 0, 0, passed ? "PASS: ${data.cases.length} chain cases, ${prefixes} prefixes" : "RUNNING: " + str.tostring(checked), text_color = passed ? color.green : color.orange)
table.cell(result, 0, 1, "合成L0输入 · L1→L2 层级链与层数上限 · 需要${prefixes}根已收盘K线")
plot(na)
`;
  const output=['//@version=6','indicator("缠论 层级链共享验证", overlay=false)',`// CORE ${coreHash}; fixture ${sha(JSON.stringify(data))}`,core,harness,loader.join('\n'),schedule].join('\n')+'\n';
  return {source:output,coreHash,sha256:sha(output),bytes:Buffer.byteLength(output),cases:data.cases.length,prefixes,fixtureHash:sha(JSON.stringify(data)),execution:'not run in Pine'};
}
function write(output,generated,production,fixturePath){
  const {source,...result}=generated;
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,source);
  const manifest={output,productionSha256:sha(production),fixture:path.relative(root,fixturePath),...result};
  fs.writeFileSync(output+'.json',JSON.stringify(manifest,null,2)+'\n');return manifest;
}
export function buildRecursionValidation(
  fixturePath=path.join(root,'tests/fixtures/chanlun/recursion/structure-completion.json'),
  output=path.join(root,'tmp/chanlun/recursion-validation.pine')
){
  const fixture=JSON.parse(fs.readFileSync(fixturePath,'utf8'));
  const production=fs.readFileSync(path.join(root,'chanlun_original.pine'),'utf8');
  return write(output,generateRecursionValidation(production,fixture),production,fixturePath);
}
export function buildChainValidation(
  fixturePath=path.join(root,'tests/fixtures/chanlun/recursion/level-chain.json'),
  output=path.join(root,'tmp/chanlun/recursion-chain-validation.pine')
){
  const fixture=JSON.parse(fs.readFileSync(fixturePath,'utf8'));
  const production=fs.readFileSync(path.join(root,'chanlun_original.pine'),'utf8');
  return write(output,generateChainValidation(production,fixture),production,fixturePath);
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const args=process.argv.slice(2);
    assert(args.length===0 || args.length===2 || (args.length===3 && args[0]==='--chain'),'usage: node tools/chanlun/build-recursion-validation.mjs [FIXTURE OUTPUT] | --chain [FIXTURE OUTPUT]');
    if(args[0]==='--chain')console.log(JSON.stringify(buildChainValidation(...args.slice(1).map(a=>path.resolve(a))),null,2));
    else console.log(JSON.stringify(buildRecursionValidation(...args.map(argument=>path.resolve(argument))),null,2));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
