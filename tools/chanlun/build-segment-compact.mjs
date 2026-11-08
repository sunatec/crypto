import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {extractCore} from './build-validation.mjs';
import {checkDirectory} from './check-fixtures.mjs';
import {featureStroke} from './feature-validation.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const q=JSON.stringify;
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const array=(type,values)=>values.length?`array.from(${values.join(', ')})`:`array.new<${type}>()`;
const stats=source=>({bytes:Buffer.byteLength(source),lines:source.split('\n').length,segmentCallSites:(source.match(/\bchan_segment_step\(/g)||[]).length});
const fields=(value,keys,context)=>assert.deepEqual(Object.keys(value).sort(),keys.toSorted(),`unsupported ${context} assertion`);

// Only encode independent fixture expectations. No segmentation algorithm is
// implemented in JavaScript; the driver always calls the verbatim Pine CORE.
export function encodeSegmentFixture(fixture){
  assert(fixture.expectationStatus==='reviewed' && fixture.input.kind==='completed-components','unsupported or draft segment fixture');
  assert(fixture.ruleIds.every(id=>['S-001','S-002','S-003','E-007'].includes(id)),'unsupported segment rule');
  const items=fixture.input.items.map((item,i)=>({...item,ordinal:i+1}));
  assert.equal(fixture.expected.length,items.length,'every prefix must have expectations');
  const records=fixture.expected.at(-1).structures;
  const ids=records.map(record=>record.id);
  const actualId=(record,index)=>`${fixture.id}/S/${index+1}/${record.startTime}`;
  assert.equal(new Set(ids).size,ids.length,'duplicate expected segment');
  const counts=[],offsets=[0],events=[],eventIds=new Set(),eventObjects=new Set();
  let priorCount=0;
  for(const [index,snapshot] of fixture.expected.entries()){
    fields(snapshot,['prefix','state','structures','events','reason'],'segment snapshot');
    assert.equal(snapshot.prefix,index+1,'unordered prefix');
    fields(snapshot.state,['confirmedSegments'],'segment state');
    assert.equal(snapshot.state.confirmedSegments,snapshot.structures.length,'segment count mismatch');
    assert(snapshot.structures.length>=priorCount,'confirmed history removed');
    assert.deepEqual(snapshot.structures,records.slice(0,snapshot.structures.length),'confirmed prefix changed or reordered');
    counts.push(snapshot.state.confirmedSegments);
    for(const event of snapshot.events){
      fields(event,['id','type','objectId','occurredAt','confirmedAt'],'segment event');
      assert(typeof event.id==='string' && event.id.length>0 && !eventIds.has(event.id) && !eventObjects.has(event.objectId),'duplicate or invalid segment event');
      const position=ids.indexOf(event.objectId);
      assert(position>=priorCount && position<snapshot.structures.length && event.type==='segment','unbound segment event');
      assert.equal(event.occurredAt,records[position].endTime);
      assert.equal(event.confirmedAt,records[position].confirmedAt);
      assert.equal(event.confirmedAt,items[index].completedAt,'event is not available at this prefix');
      eventIds.add(event.id);eventObjects.add(event.objectId);
      events.push(position+1);
    }
    assert.equal(snapshot.events.length,snapshot.structures.length-priorCount,'each new segment needs one event');
    priorCount=snapshot.structures.length;
    offsets.push(events.length);
  }
  const expected=records.map((record,index)=>{
    fields(record,['id','type','level','status','direction','startTime','endTime','startTicks','endTicks','confirmedAt','dependencies'],'segment structure');
    assert(record.type==='segment' && record.status==='confirmed' && record.level===0,'unsupported segment structure assertion');
    assert(['up','down'].includes(record.direction),'unsupported segment direction');
    const deps=record.dependencies.map(id=>{
      const parent=ids.indexOf(id);
      return q(parent>=0?actualId(records[parent],parent):id);
    });
    return `ChanStructure.new(${q(actualId(record,index))}, "segment", 0, ${record.direction==='up'?1:-1}, ${record.startTime}, ${record.endTime}, ${record.startTicks}, ${record.endTicks}, true, ${record.confirmedAt}, "INDEPENDENT-FIXTURE", ${array('string',deps)}, ${index+1})`;
  });
  return {id:fixture.id,fixtureHash:sha(JSON.stringify(fixture)),prefixes:items.length,events:events.length,
    input:array('ChanStructure',items.map(featureStroke)),expected:array('ChanStructure',expected),
    counts:array('int',counts),offsets:array('int',offsets),ordinals:array('int',events)};
}

const harness=`
type ChanCompactFixture
    string id
    array<ChanStructure> inputs
    array<ChanStructure> expected
    array<int> counts
    array<int> offsets
    array<int> eventOrdinals

chan_cv_assert(bool condition, string context) =>
    if not condition
        runtime.error("FAIL: " + context)
    true

chan_cv_record(ChanStructure actual, ChanStructure expected, ChanCompactFixture fixture, int prefix, string context) =>
    chan_cv_assert(actual.id == expected.id and actual.objectType == "segment" and actual.level == 0 and actual.ordinal == expected.ordinal and actual.confirmed, context + "/identity")
    chan_cv_assert(actual.startTime == expected.startTime and actual.endTime == expected.endTime and actual.startTicks == expected.startTicks and actual.endTicks == expected.endTicks and actual.direction == expected.direction and actual.confirmedAt == expected.confirmedAt, context + "/endpoints-direction-confirmation")
    chan_cv_assert(actual.dependencies.size() == expected.dependencies.size(), context + "/source-count")
    if expected.dependencies.size() > 0
        for i = 0 to expected.dependencies.size() - 1
            chan_cv_assert(actual.dependencies.get(i) == expected.dependencies.get(i), context + "/source-" + str.tostring(i))
    bool lowWitness = false
    bool highWitness = false
    int members = 0
    // Only this prefix enters the checks; future fixture input is never read.
    for i = 0 to prefix
        ChanStructure member = fixture.inputs.get(i)
        if member.startTime >= expected.startTime and member.endTime <= expected.endTime
            members += 1
            for endpoint = 0 to 1
                int value = endpoint == 0 ? member.startTicks : member.endTicks
                int occurredAt = endpoint == 0 ? member.startTime : member.endTime
                chan_cv_assert(actual.memberLowTicks <= value and actual.memberHighTicks >= value, context + "/member-bounds")
                if actual.memberLowTicks == value
                    chan_cv_assert(actual.memberLowTime <= occurredAt, context + "/member-low-earliest")
                    lowWitness := lowWitness or actual.memberLowTime == occurredAt
                if actual.memberHighTicks == value
                    chan_cv_assert(actual.memberHighTime <= occurredAt, context + "/member-high-earliest")
                    highWitness := highWitness or actual.memberHighTime == occurredAt
    chan_cv_assert(members > 0 and lowWitness and highWitness, context + "/member-extreme-witness")
    true

chan_cv_copy_probe(ChanSegmentState online, string context) =>
    string before = chan_segment_signature(online)
    ChanSegmentState copy = chan_segment_clone(online)
    if copy.strokes.size() > 0
        ChanStructure strokeProbe = copy.strokes.last()
        strokeProbe.dependencies.push("copy-probe")
    if copy.events.size() > 0
        ChanStructure eventProbe = copy.events.first()
        eventProbe.dependencies.push("copy-probe")
    if copy.hypotheses.size() > 0
        ChanSegmentHypothesis hypothesisProbe = copy.hypotheses.first()
        hypothesisProbe.priceTicks += 1
    if not na(copy.candidate)
        copy.candidate.dependencies.push("copy-probe")
    if not na(copy.lastSegment)
        copy.lastSegment.dependencies.push("copy-probe")
    if not na(copy.firstContext)
        if copy.firstContext.elements.size() > 0
            ChanFeature featureProbe = copy.firstContext.elements.last()
            featureProbe.sourceIds.push("copy-probe")
    if not na(copy.secondContext)
        if copy.secondContext.elements.size() > 0
            ChanFeature reverseProbe = copy.secondContext.elements.last()
            reverseProbe.sourceIds.push("copy-probe")
    chan_cv_assert(chan_segment_signature(online) == before, context + "/deep-copy-isolation")
    true

chan_cv_prefix(ChanSegmentState online, array<ChanStructure> observed, ChanCompactFixture fixture, int prefix) =>
    string context = fixture.id + "/prefix-" + str.tostring(prefix + 1)
    string prior = chan_segment_signature(online)
    ChanStructure inputStroke = fixture.inputs.get(prefix)
    ChanSegmentState next = chan_segment_step(online, inputStroke)
    chan_cv_assert(chan_segment_signature(online) == prior, context + "/source-state-immutable")
    for event in next.events
        observed.push(event)
    int count = fixture.counts.get(prefix)
    if next.segmentCount != count or observed.size() != count
        string detail = "/confirmed-count expected=" + str.tostring(count) + " actual=" + str.tostring(next.segmentCount) + " observed=" + str.tostring(observed.size())
        for record in observed
            detail += " [" + record.ruleId + " " + str.tostring(record.startTicks) + "->" + str.tostring(record.endTicks) + " end=" + str.tostring(record.endTime) + " confirmed=" + str.tostring(record.confirmedAt) + "]"
        chan_cv_assert(false, context + detail)
    if count > 0
        for i = 0 to count - 1
            chan_cv_record(observed.get(i), fixture.expected.get(i), fixture, prefix, context + "/segment-" + str.tostring(i + 1))
    int eventOffset = fixture.offsets.get(prefix)
    int eventCount = fixture.offsets.get(prefix + 1) - eventOffset
    chan_cv_assert(next.events.size() == eventCount, context + "/event-count")
    if eventCount > 0
        for i = 0 to eventCount - 1
            ChanStructure event = next.events.get(i)
            int ordinal = fixture.eventOrdinals.get(eventOffset + i)
            ChanStructure expected = fixture.expected.get(ordinal - 1)
            chan_cv_assert(event.ordinal == ordinal and event.id == expected.id and event.endTime == expected.endTime and event.confirmedAt == expected.confirmedAt, context + "/event-" + str.tostring(i))
    ChanSegmentState replay = chan_segment_new(fixture.id, 64, 8192)
    for i = 0 to prefix
        replay := chan_segment_step(replay, fixture.inputs.get(i))
    chan_cv_assert(chan_segment_signature(next) == chan_segment_signature(replay), context + "/prefix-reload")
    string committed = chan_segment_signature(next)
    ChanSegmentState duplicate = chan_segment_step(next, inputStroke)
    chan_cv_assert(duplicate.events.size() == 0 and duplicate.segmentCount == next.segmentCount, context + "/duplicate-event")
    duplicate.events := next.events
    chan_cv_assert(chan_segment_signature(duplicate) == committed, context + "/duplicate-state")
    chan_cv_copy_probe(next, context)
    chan_cv_assert(not next.blocked, context + "/within-budgets")
    next
`;

const budgetHarness=`
chan_cv_limits(ChanCompactFixture firstFixture, ChanCompactFixture equalFixture) =>
    ChanSegmentState work = chan_segment_new("work-limit", 64, 1)
    for stroke in firstFixture.inputs
        work := chan_segment_step(work, stroke)
    chan_cv_assert(work.blocked and work.limitReason == "probe-work" and work.segmentCount == 0 and work.events.size() == 0 and work.inputCount == 5 and work.strokes.size() == 5, "S-LIMIT/atomic-work-stop")
    chan_cv_assert(not na(work.heldInput) and work.heldInput.id == "p6" and work.lastInput.id == "p5", "S-LIMIT/preserve-unconsumed-input")
    ChanStructure last = equalFixture.inputs.last()
    ChanStructure future = ChanStructure.new("future-7", "stroke", 0, 1, last.endTime, last.endTime + 60000, last.endTicks, last.endTicks + 1, true, last.endTime + 120000, "FIXTURE-P", array.from("f6", "f7", "proof7"), 7)
    work := chan_segment_step(work, future)
    chan_cv_assert(work.blocked and work.segmentCount == 0 and work.events.size() == 0 and work.heldInput.id == "p6", "S-LIMIT/blocked-future-does-not-restart")
    ChanSegmentState pending = chan_segment_new("pending-limit", 6, 8192)
    for stroke in equalFixture.inputs
        pending := chan_segment_step(pending, stroke)
    chan_cv_assert(not pending.blocked and pending.segmentCount == 0 and pending.strokes.size() == 6, "S-LIMIT/pending-before-cap")
    pending := chan_segment_step(pending, future)
    chan_cv_assert(pending.blocked and pending.limitReason == "pending-strokes" and pending.strokes.size() == 6 and pending.inputCount == 6 and pending.events.size() == 0, "S-LIMIT/pending-cap-preserves-prefix")
    true
`;

export function generateCompactValidation(source,fixtures){
  assert(fixtures.length>0,'no segment fixtures');
  const core=extractCore(source),coreHash=sha(core);
  const data=fixtures.map(encodeSegmentFixture);
  assert.equal(new Set(data.map(f=>f.id)).size,data.length,'duplicate fixture ID');
  const first=data.findIndex(f=>f.id==='S-FIRST-END');
  const equal=data.findIndex(f=>f.id==='S-FIRST-EQUAL-THIRD');
  const resources=first>=0 && equal>=0;
  const prefixes=data.reduce((sum,f)=>sum+f.prefixes,0);
  const loader=['chan_cv_fixture(int index) =>','    ChanCompactFixture result = ChanCompactFixture.new()'];
  data.forEach((f,i)=>{
    loader.push(`    ${i?'else if':'if'} index == ${i}`,`        result.id := ${q(f.id)}`,
      `        result.inputs := ${f.input}`,`        result.expected := ${f.expected}`,
      `        result.counts := ${f.counts}`,`        result.offsets := ${f.offsets}`,`        result.eventOrdinals := ${f.ordinals}`);
  });
  loader.push('    else','        runtime.error("unknown compact fixture")','    result');
  const schedule=`
var table result = table.new(position.top_right, 1, 3)
var int caseIndex = 0
var int prefix = 0
var int checkedPrefixes = 0
var int lastProcessedBar = na
var bool budgetsDone = ${!resources}
var ChanSegmentState online = na
var array<ChanStructure> observed = array.new<ChanStructure>()
if barstate.isconfirmed and (na(lastProcessedBar) or bar_index != lastProcessedBar)
    if caseIndex < ${data.length}
        ChanCompactFixture fixture = chan_cv_fixture(caseIndex)
        if prefix == 0
            online := chan_segment_new(fixture.id, 64, 8192)
            observed := array.new<ChanStructure>()
        online := chan_cv_prefix(online, observed, fixture, prefix)
        checkedPrefixes += 1
        prefix += 1
        if prefix == fixture.inputs.size()
            caseIndex += 1
            prefix := 0
    ${resources?`else if not budgetsDone
        chan_cv_limits(chan_cv_fixture(${first}), chan_cv_fixture(${equal}))
        budgetsDone := true`:''}
    lastProcessedBar := bar_index
bool passed = caseIndex == ${data.length} and budgetsDone
table.cell(result, 0, 0, passed ? "PASS: ${data.length} S case(s), ${prefixes} prefixes${resources?', budgets':''}" : "RUNNING: " + str.tostring(checkedPrefixes) + "/${prefixes} prefixes", text_color = passed ? color.green : color.orange)
table.cell(result, 0, 1, "合成验证 · 非行情分析 · 需要${prefixes+(resources?1:0)}根已收盘图表K线")
table.cell(result, 0, 2, "CORE ${coreHash.slice(0,12)}")
plot(na)
`;
  const output=['//@version=6','indicator("缠论 S 精简共享验证", overlay = false)',
    `// Extracted core SHA-256: ${coreHash}`,'// One closed chart bar advances one fixture prefix; chart OHLC is not input.',
    ...data.map(f=>`// Fixture ${f.id} SHA-256: ${f.fixtureHash}`),core,harness,loader.join('\n'),resources?budgetHarness:'',schedule].join('\n')+'\n';
  return {source:output,coreHash,fixtures:data.map(({id,fixtureHash,prefixes,events})=>({id,fixtureHash,prefixes,events})),prefixes,requiredClosedBars:prefixes+(resources?1:0),resourceChecks:resources,...stats(output),execution:'not run; compile and execute in TradingView'};
}

export function buildCompactValidation(directory=path.join(root,'tmp/chanlun/segment-compact')){
  checkDirectory();
  const fixtures=fs.readdirSync(path.join(root,'tests/fixtures/chanlun')).filter(n=>n.endsWith('.json')).sort()
    .map(name=>JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/chanlun',name),'utf8')))
    .filter(f=>f.expectationStatus==='reviewed' && f.input.kind==='completed-components' && f.ruleIds.every(id=>['S-001','S-002','S-003','E-007'].includes(id)));
  const source=fs.readFileSync(path.join(root,'chanlun_original.pine'),'utf8');
  const files=[];
  fs.mkdirSync(path.join(directory,'cases'),{recursive:true});
  const write=(relative,group)=>{
    const result=generateCompactValidation(source,group),file=path.join(directory,relative);
    fs.writeFileSync(file,result.source);
    const {source:_,...metadata}=result;
    files.push({file:relative,sha256:sha(result.source),...metadata});
  };
  write('all-cases.pine',fixtures);
  for(const fixture of fixtures){
    assert(/^[A-Z0-9-]+$/.test(fixture.id),'unsafe fixture filename');
    write(path.join('cases',fixture.id.toLowerCase()+'.pine'),[fixture]);
  }
  const smoke=fixtures.find(f=>f.id==='S-FIRST-WAIT-INCLUSION');
  assert(smoke,'missing first-break smoke fixture');
  write('smoke.pine',[smoke]);
  const manifest={schemaVersion:1,productionSha256:sha(source),coreHash:files[0].coreHash,smoke:'smoke.pine',suite:'all-cases.pine',status:'awaiting-cloud-compilation',files};
  fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  return {directory,...manifest};
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const result=buildCompactValidation(process.argv[2]);
    console.log(JSON.stringify({directory:result.directory,core:result.coreHash,smoke:result.files.find(f=>f.file===result.smoke),suite:result.files[0],execution:result.status},null,2));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
