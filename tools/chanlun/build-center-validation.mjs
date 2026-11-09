import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {extractCore} from './build-validation.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const q=JSON.stringify,sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const t=i=>1701000000000+i*60000;
const keys=(o,allowed)=>assert(Object.keys(o).every(k=>allowed.includes(k)),'unknown center expectation field');
export function validateCenterCases(data){
  assert.equal(data.schemaVersion,2);assert.deepEqual(data.sourceIds,['C18-39','C20-43']);
  assert(data.note && data.cases.length);const ids=new Set();
  for(const c of data.cases){
    keys(c,['id','maxSources','inputs','expected']);assert(!ids.has(c.id),'duplicate center case');ids.add(c.id);
    assert.equal(c.inputs.length,c.expected.length,'every prefix needs expectation');assert(c.inputs.length>0);
    let prior=null,events=0;
    c.inputs.forEach((p,i)=>{
      assert(p.length===4 && p.every(Number.isSafeInteger));const [a,b,lo,hi]=p;
      assert(a!==b && lo<hi && lo<=Math.min(a,b) && hi>=Math.max(a,b),'invalid component');
      if(i)assert(c.inputs[i-1][1]===a && Math.sign(b-a)!==Math.sign(c.inputs[i-1][1]-c.inputs[i-1][0]),'component continuity');
      const e=c.expected[i];
      if(!e){assert(!prior,'confirmed center disappeared');return;}
      keys(e,['core','stats','extent','waves','event','blocked','waiting','held','start','count','pending','closed','closedEvent','leave','returned','closedAt','relation']);
      assert(e.core.length===2 && e.core[0]<=e.core[1] && e.core.every(Number.isSafeInteger));
      assert(e.stats.length===4 && e.stats.every(Number.isSafeInteger));
      assert(Number.isInteger(e.extent) && e.extent<=i+1 && e.extent>=3);
      assert(Number.isInteger(e.waves) && e.waves>=2);
      const count=e.count??1,priorCount=prior?.count??(prior?1:0);
      assert(Number.isInteger(count) && count>=1);
      if(e.event){events++;assert.equal(count,priorCount+1,'reconfirmed center');}
      assert.equal(events,count,'missing formation event');
      if(prior && count===priorCount)assert.deepEqual(e.core,prior.core,'fixed core changed');
      for(const field of ['pending','leave','returned','closedAt'])if(e[field])assert(Number.isInteger(e[field]) && e[field]<=i+1 && e[field]>0,'invalid evidence ordinal');
      if(e.closed)assert(e.leave && e.returned && e.closedAt && !e.pending,'closed center needs proof');
      if(e.closedEvent)assert(e.closed && !prior?.closed,'duplicate closure');
      if(e.relation)assert(['none','new-center-pending','up-continuation','down-continuation','range-overlap','core-overlap'].includes(e.relation),'invalid relation');
      if(e.held)assert(e.held<=i+1 && (e.blocked || e.waiting),'invalid held input');
      prior=e;
    });
  }
  return data;
}
function component(c,p,i){
  const [a,b,lo,hi]=p,d=a<b?1:-1,start=t(i),end=t(i+1),sid=`${c.id}/S/${i+1}/${start}`;
  const lowTime=lo===a?start:lo===b?end:start+30000,highTime=hi===a?start:hi===b?end:start+30000;
  return `ChanComponent.new(${q(c.id+'/N/'+(i+1)+'/'+start)}, ${q(sid)}, ${start}, ${end}, ${a}, ${b}, ${lo}, ${hi}, ${lowTime}, ${highTime}, ${start}, ${end}, ${d===1?lo:hi}, ${d===1?hi:lo}, ${d}, ${t(i+2)}, "N-001/E-008", array.from(${q(sid)}), ${i+1})`;
}
export function generateCenterValidation(source,data){
  validateCenterCases(data);const core=extractCore(source),coreHash=sha(core);
  // Expanded constructors belong in separate functions, outside the dispatcher
  // conditional. Keeping them in one if/else chain triggered Pine CE10205.
  const loader=[];
  const dispatcher=['chan_zv_case(int index) =>','    ChanZFixture result = ChanZFixture.new()'];
  let prefixes=0;
  data.cases.forEach((c,i)=>{
    prefixes+=c.inputs.length;let start=1,formed=0;
    const expected=c.expected.map((e,p)=>{
      if(!e)return 'ChanZExpected.new(false)';
      if(e.event){start=e.start??1;formed=p+1;}
      return `ChanZExpected.new(true, ${[...e.core,...e.stats,e.extent,e.waves,!!e.event,!!e.blocked,!!e.waiting,e.held??0,start,formed,e.count??1,e.pending??0,!!e.closed,!!e.closedEvent,e.leave??0,e.returned??0,e.closedAt??0,q(e.relation??(e.closed?'new-center-pending':'none'))].join(', ')})`;
    });
    loader.push(`chan_zv_case_${i}() =>`,'    ChanZFixture result = ChanZFixture.new()',`    result.id := ${q(c.id)}`,`    result.limit := ${c.maxSources??64}`,`    result.inputs := array.from(${c.inputs.map((p,j)=>component(c,p,j)).join(', ')})`,`    result.expected := array.from(${expected.join(', ')})`,'    result','');
    dispatcher.push(`    ${i?'else if':'if'} index == ${i}`,`        result := chan_zv_case_${i}()`);
  });dispatcher.push('    result');loader.push(...dispatcher);
  const harness=`
type ChanZExpected
    bool exists
    int low = na
    int high = na
    int gg = na
    int g = na
    int d = na
    int dd = na
    int extent = 0
    int waves = 0
    bool event = false
    bool blocked = false
    bool waiting = false
    int held = 0
    int start = 0
    int formed = 0
    int count = 0
    int pending = 0
    bool closed = false
    bool closedEvent = false
    int leave = 0
    int returned = 0
    int closedAt = 0
    string relation = "none"
type ChanZFixture
    string id
    int limit
    array<ChanComponent> inputs
    array<ChanZExpected> expected
chan_zv_assert(bool condition, string context) =>
    if not condition
        runtime.error("FAIL: " + context)
    true
chan_zv_step(ChanCenterState online, ChanZFixture fixture, int prefix, array<ChanCenter> observed, array<string> originals, array<ChanCenter> closedObserved, array<string> closedOriginals) =>
    string context = fixture.id + "/prefix-" + str.tostring(prefix + 1)
    string before = chan_center_signature(online)
    ChanComponent inputComponent = fixture.inputs.get(prefix)
    string inputBefore = chan_component_signature(inputComponent)
    ChanCenterState next = chan_center_step(online, inputComponent)
    chan_zv_assert(chan_center_signature(online) == before and chan_component_signature(inputComponent) == inputBefore, context + "/source-immutable")
    ChanZExpected expected = fixture.expected.get(prefix)
    chan_zv_assert(na(next.center) == (not expected.exists), context + "/exists")
    chan_zv_assert(na(next.event) == (not expected.event), context + "/formation-event")
    chan_zv_assert(na(next.closedEvent) == (not expected.closedEvent), context + "/closure-event")
    chan_zv_assert(next.count == expected.count, context + "/center-count expected=" + str.tostring(expected.count) + " actual=" + str.tostring(next.count))
    chan_zv_assert(next.relationKind == expected.relation, context + "/relation-evidence expected=" + expected.relation + " actual=" + next.relationKind)
    int pendingOrdinal = na(next.pendingLeave) ? 0 : next.pendingLeave.ordinal
    chan_zv_assert(pendingOrdinal == expected.pending, context + "/pending-ownership expected=" + str.tostring(expected.pending) + " actual=" + str.tostring(pendingOrdinal))
    chan_zv_assert(next.blocked == expected.blocked and next.waitingRelation == expected.waiting, context + "/stop-kind")
    chan_zv_assert(next.waves == expected.waves, context + "/Z-waves expected=" + str.tostring(expected.waves) + " actual=" + str.tostring(next.waves))
    chan_zv_assert((na(next.heldInput) ? 0 : next.heldInput.ordinal) == expected.held, context + "/held-input")
    chan_zv_assert(next.inputCount == (expected.held > 0 ? expected.held - 1 : prefix + 1), context + "/atomic-consumption")
    chan_zv_assert(next.seed.size() <= 2, context + "/bounded-seed")
    if expected.exists
        ChanCenter center = next.center
        ChanComponent first = fixture.inputs.get(expected.start - 1)
        chan_zv_assert(center.id == fixture.id + "/L1/Z/" + str.tostring(expected.count) + "/" + str.tostring(first.realStartTime) and center.level == 1 and center.ordinal == expected.count, context + "/identity")
        chan_zv_assert(center.coreLowTicks == expected.low and center.coreHighTicks == expected.high and center.degenerate == (expected.low == expected.high), context + "/fixed-core")
        chan_zv_assert(center.ggTicks == expected.gg and center.gTicks == expected.g and center.dTicks == expected.d and center.ddTicks == expected.dd, context + "/Z-statistics")
        if next.relationKind != "none" and next.relationKind != "new-center-pending"
            chan_zv_assert(next.relationAt == inputComponent.confirmedAt, context + "/relation-clock")
        chan_zv_assert(center.startTime == first.realStartTime and center.formedAt == fixture.inputs.get(expected.formed - 1).confirmedAt and center.confirmedAt == center.formedAt, context + "/formation-time")
        chan_zv_assert(center.extentEndTime == fixture.inputs.get(expected.extent - 1).realEndTime, context + "/extent")
        chan_zv_assert(center.zWaves == expected.waves and (center.lifecycle == "closed") == expected.closed, context + "/lifecycle")
        if expected.closed
            chan_zv_assert(center.closedAt == fixture.inputs.get(expected.closedAt - 1).confirmedAt and center.leaveId == fixture.inputs.get(expected.leave - 1).id and center.returnId == fixture.inputs.get(expected.returned - 1).id, context + "/closure-proof")
        else
            chan_zv_assert(na(center.closedAt) and center.leaveId == "" and center.returnId == "", context + "/no-premature-closure")
        chan_zv_assert(center.dependencies.size() == expected.extent - expected.start + 1, context + "/source-count")
        for i = 0 to center.dependencies.size() - 1
            chan_zv_assert(center.dependencies.get(i) == fixture.inputs.get(expected.start - 1 + i).id, context + "/source-order")
    if not na(next.event)
        observed.push(next.event)
        originals.push(chan_center_record_signature(next.event))
    chan_zv_assert(observed.size() == expected.count, context + "/unique-formation")
    if observed.size() > 0
        for i = 0 to observed.size() - 1
            chan_zv_assert(chan_center_record_signature(observed.get(i)) == originals.get(i), context + "/confirmed-event-immutable")
    if not na(next.closedEvent)
        closedObserved.push(next.closedEvent)
        closedOriginals.push(chan_center_record_signature(next.closedEvent))
    chan_zv_assert(next.history.size() == math.min(15, closedObserved.size()), context + "/bounded-archive")
    if closedObserved.size() > 0
        chan_zv_assert(chan_center_record_signature(next.previous) == closedOriginals.last(), context + "/previous-closed")
        for i = 0 to closedObserved.size() - 1
            chan_zv_assert(chan_center_record_signature(closedObserved.get(i)) == closedOriginals.get(i), context + "/closed-event-immutable")
        for i = 0 to next.history.size() - 1
            chan_zv_assert(chan_center_record_signature(next.history.get(i)) == closedOriginals.get(closedOriginals.size() - next.history.size() + i), context + "/archive-order")
    ChanCenterState replay = chan_center_new(fixture.id, fixture.limit)
    for i = 0 to prefix
        replay := chan_center_step(replay, fixture.inputs.get(i))
    chan_zv_assert(chan_center_signature(next) == chan_center_signature(replay), context + "/prefix-reload")
    ChanCenterState duplicate = chan_center_step(next, inputComponent)
    chan_zv_assert(na(duplicate.event) and na(duplicate.closedEvent), context + "/duplicate-event")
    duplicate.event := next.event
    duplicate.closedEvent := next.closedEvent
    chan_zv_assert(chan_center_signature(duplicate) == chan_center_signature(next), context + "/duplicate-state")
    string committed = chan_center_signature(next)
    ChanCenterState copy = chan_center_clone(next)
    if not na(copy.center)
        copy.center.dependencies.push("copy-probe")
        copy.center.coreLowTicks += 1
    if copy.seed.size() > 0
        ChanComponent probe = copy.seed.first()
        probe.dependencies.push("copy-probe")
    if not na(copy.lastInput)
        copy.lastInput.dependencies.push("copy-probe")
    if not na(copy.pendingLeave)
        copy.pendingLeave.dependencies.push("copy-probe")
    if not na(copy.previous)
        copy.previous.dependencies.push("copy-probe")
    if copy.history.size() > 0
        ChanCenter archivedProbe = copy.history.first()
        archivedProbe.dependencies.push("copy-probe")
    chan_zv_assert(chan_center_signature(next) == committed, context + "/copy-isolation")
    next
`;
  const schedule=`
var int caseIndex = 0
var int prefix = 0
var int checked = 0
var ChanCenterState online = na
var array<ChanCenter> observed = array.new<ChanCenter>()
var array<string> originals = array.new<string>()
var array<ChanCenter> closedObserved = array.new<ChanCenter>()
var array<string> closedOriginals = array.new<string>()
var table result = table.new(position.top_right, 1, 2)
if barstate.isconfirmed and caseIndex < ${data.cases.length}
    ChanZFixture fixture = chan_zv_case(caseIndex)
    if prefix == 0
        online := chan_center_new(fixture.id, fixture.limit)
        observed := array.new<ChanCenter>()
        originals := array.new<string>()
        closedObserved := array.new<ChanCenter>()
        closedOriginals := array.new<string>()
    online := chan_zv_step(online, fixture, prefix, observed, originals, closedObserved, closedOriginals)
    prefix += 1
    checked += 1
    if prefix == fixture.inputs.size()
        prefix := 0
        caseIndex += 1
bool passed = caseIndex == ${data.cases.length}
table.cell(result, 0, 0, passed ? "PASS: ${data.cases.length} Z cases, ${prefixes} prefixes" : "RUNNING: " + str.tostring(checked), text_color = passed ? color.green : color.orange)
table.cell(result, 0, 1, "合成L0输入 · 连续L1中枢 · 需要${prefixes}根已收盘K线 · 不验证R完成")
plot(na)
`;
  const output=['//@version=6','indicator("缠论 L1 中枢共享验证", overlay=false)',`// CORE ${coreHash}; fixture ${sha(JSON.stringify(data))}`,core,harness,loader.join('\n'),schedule].join('\n')+'\n';
  return {source:output,coreHash,sha256:sha(output),bytes:Buffer.byteLength(output),cases:data.cases.length,prefixes,fixtureHash:sha(JSON.stringify(data)),execution:'not run in Pine'};
}
export function buildCenterValidation(
  fixturePath=path.join(root,'tests/fixtures/chanlun/centers/cases.json'),
  output=path.join(root,'tmp/chanlun/center-validation.pine')
){
  const fixture=JSON.parse(fs.readFileSync(fixturePath,'utf8'));
  const production=fs.readFileSync(path.join(root,'chanlun_original.pine'),'utf8');
  const {source,...result}=generateCenterValidation(production,fixture);
  fs.mkdirSync(path.dirname(output),{recursive:true});
  fs.writeFileSync(output,source);
  const manifest={output,productionSha256:sha(production),...result};
  fs.writeFileSync(output+'.json',JSON.stringify(manifest,null,2)+'\n');return manifest;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const args=process.argv.slice(2);
    assert(args.length===0 || args.length===2,'usage: node tools/chanlun/build-center-validation.mjs [FIXTURE OUTPUT]');
    console.log(JSON.stringify(buildCenterValidation(...args.map(argument=>path.resolve(argument))),null,2));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
