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
const STATE=['active','dir','trunc','members','first','centers','done','submitted','start','blocked','kind','held','event'];
const EVENT=['end','range','members','centers','type','truncated','confirmed','upper','startTicks'];
export function validateRecursionCases(data){
  assert.equal(data.schemaVersion,1);assert.deepEqual(data.sourceIds,['C18-39','C18-40','C88-223']);
  assert.deepEqual(data.ruleIds,['R-002','R-003','R-004','R-005','R-006']);assert(data.note && data.cases.length);
  const ids=new Set();
  for(const c of data.cases){
    keys(c,['id','maxMembers','inputs','expected']);assert(!ids.has(c.id),'duplicate R case');ids.add(c.id);
    assert.equal(c.inputs.length,c.expected.length,'every prefix needs expectation');assert(c.inputs.length>0);
    c.inputs.forEach((p,i)=>{
      assert(p.length===4 && p.every(Number.isSafeInteger));const [a,b,lo,hi]=p;
      assert(a!==b && lo<hi && lo===Math.min(a,b) && hi===Math.max(a,b),'R inputs use endpoint intervals');
      if(i)assert(c.inputs[i-1][1]===a && Math.sign(b-a)!==Math.sign(c.inputs[i-1][1]-c.inputs[i-1][0]),'component continuity');
    });
    let prior=null;
    c.expected.forEach((e,i)=>{
      keys(e,STATE);const n=i+1;
      for(const k of ['active','trunc','blocked'])assert.equal(typeof e[k],'boolean',k);
      for(const k of ['dir','members','first','centers','done','submitted','start','held'])assert(Number.isInteger(e[k]),k);
      assert(e.kind==='' || e.kind==='budget' || e.kind==='rule','block kind');
      assert(e.blocked===(e.kind!=='') && (e.held>0)===e.blocked,'block fields agree');
      assert(e.active?Math.abs(e.dir)===1:e.dir===0,'direction only when active');
      assert(!e.trunc || e.active,'truncated start needs an active movement');
      assert(e.members>=1 && e.first>=1 && e.first<=n && e.centers>=0,'member bookkeeping');
      assert(e.done>=(prior?.done??0) && e.done<=(prior?.done??0)+1,'completions only advance by one');
      assert.equal(Boolean(e.event),e.done===(prior?.done??0)+1,'a completion needs an event and vice versa');
      assert(e.submitted<=e.done && e.submitted>=(prior?.submitted??0),'submissions');
      if(e.event){
        const v=e.event;keys(v,EVENT);
        assert(v.end.length===2 && v.end.every(Number.isInteger) && v.end[0]>=1 && v.end[0]<=n,'endpoint ordinal');
        assert(v.range.length===2 && v.range[0]<=v.range[1] && v.range.every(Number.isInteger),'range');
        assert(v.members.length===2 && v.members[0]<=v.end[0] && v.end[0]===v.members[1],'endpoint belongs to the last member');
        assert(['consolidation','trend','expansion-evidence'].includes(v.type) && v.centers>=1);
        assert((v.type==='consolidation')===(v.centers===1),'consolidation means exactly one center');
        assert(v.confirmed===n,'confirmed on the closing input');assert.equal(e.submitted,(prior?.submitted??0)+(v.upper?1:0));
        assert(!(v.truncated&&v.upper),'a truncated start is never submitted');
        assert(e.first===v.end[0]+1,'carried members start after the endpoint');
        assert(Number.isInteger(v.startTicks));
      }
      prior=e;
    });
  }
  return data;
}
export function generateRecursionValidation(source,data){
  validateRecursionCases(data);const core=extractCore(source),coreHash=sha(core);
  const loader=[];const dispatcher=['chan_rv_case(int index) =>','    ChanRFixture result = ChanRFixture.new()'];
  let prefixes=0;
  data.cases.forEach((c,i)=>{
    prefixes+=c.inputs.length;
    const expected=c.expected.map(e=>{
      const v=e.event;
      const f=[e.active,e.dir,e.trunc,e.members,e.first,e.centers,e.done,e.submitted,e.start,e.blocked,q(e.kind),e.held,!!v,
        v?v.end[0]:0,v?v.end[1]:0,v?v.range[0]:0,v?v.range[1]:0,v?v.members[0]:0,v?v.members[1]:0,v?v.centers:0,q(v?v.type:''),v?v.truncated:false,v?v.confirmed:0,v?v.upper:false,v?v.startTicks:0];
      return `ChanRExpected.new(${f.join(', ')})`;
    });
    loader.push(`chan_rv_case_${i}() =>`,'    ChanRFixture result = ChanRFixture.new()',`    result.id := ${q(c.id)}`,`    result.limit := ${c.maxMembers??128}`,`    result.inputs := array.from(${c.inputs.map((p,j)=>component(c,p,j)).join(', ')})`,`    result.expected := array.from(${expected.join(', ')})`,'    result','');
    dispatcher.push(`    ${i?'else if':'if'} index == ${i}`,`        result := chan_rv_case_${i}()`);
  });dispatcher.push('    result');loader.push(...dispatcher);
  const harness=`
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
type ChanRFixture
    string id
    int limit
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
    result.centers := chan_center_new(fixture.id, 64)
    result.movements := chan_movement_new(fixture.id, fixture.limit)
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
    chan_rv_assert(m.id == fixture.id + "/L1/R/" + str.tostring(next.count) + "/" + str.tostring(firstMember.realStartTime) and m.level == 1 and m.ordinal == next.count and m.completed, context + "/identity")
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
    chan_rv_assert(next.active == expected.active and next.direction == expected.dir and next.truncated == expected.trunc, context + "/state active=" + str.tostring(next.active) + " dir=" + str.tostring(next.direction) + " trunc=" + str.tostring(next.truncated))
    chan_rv_assert(next.members.size() == expected.members and (next.members.size() > 0 ? next.members.first().ordinal : 0) == expected.first, context + "/members expected=" + str.tostring(expected.members) + "/" + str.tostring(expected.first) + " actual=" + str.tostring(next.members.size()) + "/" + str.tostring(next.members.size() > 0 ? next.members.first().ordinal : 0))
    chan_rv_assert(next.centers.size() == expected.centers, context + "/center-set expected=" + str.tostring(expected.centers) + " actual=" + str.tostring(next.centers.size()))
    chan_rv_assert(next.count == expected.done and next.submitted == expected.submitted, context + "/completed expected=" + str.tostring(expected.done) + " actual=" + str.tostring(next.count))
    chan_rv_assert(next.startTicks == expected.start, context + "/start-price expected=" + str.tostring(expected.start) + " actual=" + str.tostring(next.startTicks))
    chan_rv_assert(next.blocked == expected.blocked and next.blockKind == expected.kind and (na(next.heldInput) ? 0 : next.heldInput.ordinal) == expected.held, context + "/stop-kind")
    chan_rv_assert(next.inputCount == (expected.held > 0 ? expected.held - 1 : prefix + 1), context + "/atomic-consumption")
    chan_rv_assert(na(next.event) == (not expected.hasEvent), context + "/completion-event")
    if expected.hasEvent
        chan_rv_event(fixture, expected, next, context)
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
    chan_rv_assert(chan_movement_signature(next) == committed, context + "/copy-isolation")
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
table.cell(result, 0, 1, "合成L0输入 · L1走势完成（结构确立路径）· 需要${prefixes}根已收盘K线 · 不验证L2提交")
plot(na)
`;
  const output=['//@version=6','indicator("缠论 L1 走势完成共享验证", overlay=false)',`// CORE ${coreHash}; fixture ${sha(JSON.stringify(data))}`,core,harness,loader.join('\n'),schedule].join('\n')+'\n';
  return {source:output,coreHash,sha256:sha(output),bytes:Buffer.byteLength(output),cases:data.cases.length,prefixes,fixtureHash:sha(JSON.stringify(data)),execution:'not run in Pine'};
}
export function buildRecursionValidation(
  fixturePath=path.join(root,'tests/fixtures/chanlun/recursion/structure-completion.json'),
  output=path.join(root,'tmp/chanlun/recursion-validation.pine')
){
  const fixture=JSON.parse(fs.readFileSync(fixturePath,'utf8'));
  const production=fs.readFileSync(path.join(root,'chanlun_original.pine'),'utf8');
  const {source,...result}=generateRecursionValidation(production,fixture);
  fs.mkdirSync(path.dirname(output),{recursive:true});
  fs.writeFileSync(output,source);
  const manifest={output,productionSha256:sha(production),...result};
  fs.writeFileSync(output+'.json',JSON.stringify(manifest,null,2)+'\n');return manifest;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const args=process.argv.slice(2);
    assert(args.length===0 || args.length===2,'usage: node tools/chanlun/build-recursion-validation.mjs [FIXTURE OUTPUT]');
    console.log(JSON.stringify(buildRecursionValidation(...args.map(argument=>path.resolve(argument))),null,2));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
