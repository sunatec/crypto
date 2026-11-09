import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {extractCore} from './build-validation.mjs';
import {checkDirectory,validateFixture} from './check-fixtures.mjs';
import {featureStroke} from './feature-validation.mjs';
import {componentFields} from './normalization-fixtures.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const q=JSON.stringify;
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const array=(type,values)=>values.length?`array.from(${values.join(', ')})`:`array.new<${type}>()`;
const rules=new Set(['N-001','E-008','S-001','S-002','S-003','E-007']);
const component=record=>`ChanComponent.new(${componentFields.map(key=>key==='dependencies'?array('string',record[key].map(q)):key==='direction'?(record[key]==='up'?1:-1):q(record[key])).join(', ')})`;

const harness=`
type ChanNFixture
    string id
    array<ChanStructure> inputs
    array<ChanComponent> expected
    array<int> counts

chan_nv_assert(bool condition, string context) =>
    if not condition
        runtime.error("FAIL: " + context)
    true

chan_nv_record(ChanComponent actual, ChanComponent expected, string context) =>
${componentFields.filter(key=>key!=='dependencies').map(key=>`    chan_nv_assert(actual.${key} == expected.${key}, context + "/${key}")`).join('\n')}
    chan_nv_assert(actual.dependencies.size() == 1 and actual.dependencies.first() == expected.segmentId, context + "/dependencies")
    true

chan_nv_apply(ChanNormalizationState source, ChanStructure segment, string context) =>
    string before = chan_normalization_signature(source)
    string segmentBefore = chan_structure_signature(segment)
    ChanNormalizationState next = chan_normalization_step(source, segment)
    chan_nv_assert(chan_normalization_signature(source) == before, context + "/source-state-immutable")
    chan_nv_assert(chan_structure_signature(segment) == segmentBefore, context + "/source-segment-immutable")
    chan_nv_assert(not na(next.event), context + "/event-exists")
    ChanNormalizationState duplicate = chan_normalization_step(next, segment)
    chan_nv_assert(na(duplicate.event) and duplicate.count == next.count, context + "/duplicate-event")
    duplicate.event := next.event
    chan_nv_assert(chan_normalization_signature(duplicate) == chan_normalization_signature(next), context + "/duplicate-state")
    ChanStructure invalid = chan_structure_copy(segment)
    invalid.confirmed := false
    chan_nv_assert(not chan_normalization_valid(invalid), context + "/reject-candidate")
    invalid.confirmed := true
    invalid.memberHighTime := segment.endTime + 1
    chan_nv_assert(not chan_normalization_valid(invalid), context + "/reject-outside-source")
    invalid.memberHighTime := segment.memberHighTime
    invalid.memberLowTicks := na
    chan_nv_assert(not chan_normalization_valid(invalid), context + "/reject-missing-range")
    next

chan_nv_copy_probe(ChanNormalizationState source, string context) =>
    string before = chan_normalization_signature(source)
    ChanNormalizationState copy = chan_normalization_clone(source)
    if not na(copy.lastInput)
        copy.lastInput.dependencies.push("copy-probe")
        copy.lastInput.memberHighTicks += 1
    if not na(copy.lastComponent)
        copy.lastComponent.dependencies.push("copy-probe")
        copy.lastComponent.analysisStartTicks += 1
    if not na(copy.event)
        copy.event.dependencies.push("copy-probe")
    chan_nv_assert(chan_normalization_signature(source) == before, context + "/deep-copy-isolation")
    true

chan_nv_prefix(ChanSegmentState onlineS, ChanNormalizationState onlineN, array<ChanComponent> observed, ChanNFixture fixture, int prefix) =>
    string context = fixture.id + "/prefix-" + str.tostring(prefix + 1)
    string beforeS = chan_segment_signature(onlineS)
    ChanSegmentState nextS = chan_segment_step(onlineS, fixture.inputs.get(prefix))
    chan_nv_assert(chan_segment_signature(onlineS) == beforeS, context + "/segment-state-immutable")
    chan_nv_assert(not nextS.blocked, context + "/segment-within-budgets")
    ChanNormalizationState nextN = onlineN
    int newEvents = 0
    for segment in nextS.events
        nextN := chan_nv_apply(nextN, segment, context)
        observed.push(nextN.event)
        newEvents += 1
    int expectedCount = fixture.counts.get(prefix)
    chan_nv_assert(nextN.count == expectedCount and observed.size() == expectedCount, context + "/normalized-count expected=" + str.tostring(expectedCount) + " actual=" + str.tostring(nextN.count))
    int priorCount = prefix == 0 ? 0 : fixture.counts.get(prefix - 1)
    chan_nv_assert(newEvents == expectedCount - priorCount, context + "/event-count-and-batch-order")
    if expectedCount > 0
        for i = 0 to expectedCount - 1
            chan_nv_record(observed.get(i), fixture.expected.get(i), context + "/component-" + str.tostring(i + 1))
    ChanSegmentState replayS = chan_segment_new(fixture.id, 64, 8192)
    ChanNormalizationState replayN = chan_normalization_new(fixture.id)
    // Replay only the currently available prefix, never later fixture inputs.
    for i = 0 to prefix
        replayS := chan_segment_step(replayS, fixture.inputs.get(i))
        for segment in replayS.events
            replayN := chan_normalization_step(replayN, segment)
    chan_nv_assert(chan_segment_signature(nextS) == chan_segment_signature(replayS), context + "/segment-prefix-reload")
    chan_nv_assert(chan_normalization_signature(nextN) == chan_normalization_signature(replayN), context + "/normalization-prefix-reload")
    chan_nv_copy_probe(nextN, context)
    [nextS, nextN]
`;

export function generateNormalizationValidation(source,fixtures){
  assert(fixtures.length>0,'no normalization fixtures');
  const core=extractCore(source),coreHash=sha(core);
  const loader=['chan_nv_fixture(int index) =>','    ChanNFixture result = ChanNFixture.new()'];
  const metadata=[];
  for(const [index,fixture] of fixtures.entries()){
    assert(fixture.expectationStatus==='reviewed' && fixture.input.kind==='normalization-strokes' && fixture.ruleIds.every(id=>rules.has(id)),'unsupported or draft normalization fixture');
    validateFixture(fixture,rules,new Set(fixture.source.sourceIds));
    const inputs=fixture.input.items.map((item,i)=>featureStroke({...item,ordinal:i+1}));
    loader.push(`    ${index?'else if':'if'} index == ${index}`,`        result.id := ${q(fixture.id)}`,`        result.inputs := ${array('ChanStructure',inputs)}`,`        result.expected := ${array('ChanComponent',fixture.expected.at(-1).structures.map(component))}`,`        result.counts := ${array('int',fixture.expected.map(s=>s.state.normalizedCount))}`);
    metadata.push({id:fixture.id,sha256:sha(JSON.stringify(fixture)),prefixes:fixture.input.items.length,events:fixture.expected.reduce((sum,s)=>sum+s.events.length,0)});
  }
  assert.equal(new Set(metadata.map(f=>f.id)).size,metadata.length,'duplicate fixture');
  loader.push('    else','        runtime.error("unknown normalization fixture")','    result');
  const prefixes=metadata.reduce((sum,f)=>sum+f.prefixes,0);
  const schedule=`
var int caseIndex = 0
var int prefix = 0
var int checked = 0
var int lastProcessedBar = na
var ChanSegmentState onlineS = na
var ChanNormalizationState onlineN = na
var array<ChanComponent> observed = array.new<ChanComponent>()
var table result = table.new(position.top_right, 1, 3)
if barstate.isconfirmed and (na(lastProcessedBar) or lastProcessedBar != bar_index)
    if caseIndex < ${fixtures.length}
        ChanNFixture fixture = chan_nv_fixture(caseIndex)
        if prefix == 0
            onlineS := chan_segment_new(fixture.id, 64, 8192)
            onlineN := chan_normalization_new(fixture.id)
            observed := array.new<ChanComponent>()
        [steppedS, steppedN] = chan_nv_prefix(onlineS, onlineN, observed, fixture, prefix)
        onlineS := steppedS
        onlineN := steppedN
        checked += 1
        prefix += 1
        if prefix == fixture.inputs.size()
            caseIndex += 1
            prefix := 0
    lastProcessedBar := bar_index
bool passed = caseIndex == ${fixtures.length}
table.cell(result, 0, 0, passed ? "PASS: ${fixtures.length} N cases, ${prefixes} prefixes" : "RUNNING: " + str.tostring(checked) + "/${prefixes}", text_color = passed ? color.green : color.orange)
table.cell(result, 0, 1, "合成S→N验证 · 非行情分析 · 需要${prefixes}根已收盘K线")
table.cell(result, 0, 2, "CORE ${coreHash.slice(0,12)}")
plot(na)
`;
  const output=['//@version=6','indicator("缠论 L0 独立区间共享验证", overlay = false)',`// CORE SHA-256: ${coreHash}`,...metadata.map(f=>`// Fixture ${f.id} SHA-256: ${f.sha256}`),core,harness,loader.join('\n'),schedule].join('\n')+'\n';
  return {source:output,coreHash,fixtures:metadata,prefixes,requiredClosedBars:prefixes,bytes:Buffer.byteLength(output),sha256:sha(output),execution:'not run; compile and execute in TradingView'};
}

export function buildNormalizationValidation(output=path.join(root,'tmp/chanlun/normalization-validation.pine')){
  checkDirectory();
  const directory=path.join(root,'tests/fixtures/chanlun');
  const fixtures=fs.readdirSync(directory).filter(n=>n.endsWith('.json')).sort().map(n=>JSON.parse(fs.readFileSync(path.join(directory,n),'utf8'))).filter(f=>f.expectationStatus==='reviewed' && f.input.kind==='normalization-strokes');
  const source=fs.readFileSync(path.join(root,'chanlun_original.pine'),'utf8');
  const {source:pine,...result}=generateNormalizationValidation(source,fixtures);
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,pine);
  const manifest={output,productionSha256:sha(source),...result};
  fs.writeFileSync(output.replace(/\.pine$/i,'')+'.json',JSON.stringify(manifest,null,2)+'\n');
  return manifest;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{console.log(JSON.stringify(buildNormalizationValidation(process.argv[2]),null,2));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
