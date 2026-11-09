import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {extractCore} from './build-validation.mjs';
import {featureStroke} from './feature-validation.mjs';
import {componentFields} from './normalization-fixtures.mjs';
const root=new URL('../../',import.meta.url),q=JSON.stringify;
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const read=n=>JSON.parse(fs.readFileSync(new URL(`tests/fixtures/chanlun/${n}.json`,root),'utf8'));
const raw=r=>`ChanRaw.new(${[r.time,r.closeTime,r.openTicks,r.highTicks,r.lowTicks,r.closeTicks].join(', ')})`;
export function generateRuntimeValidation(source,ohlc,own,batch){
  assert.equal(ohlc.id,'P-OHLC-INTEGRATION');assert.equal(own.id,'N-OWN-RANGES');assert.equal(batch.id,'N-SECOND-BATCH');
  for(const f of [ohlc,own,batch])assert.equal(f.expectationStatus,'reviewed');
  const core=extractCore(source),loaders=[];
  loaders.push('chan_tv_raws() =>',`    array.from(${ohlc.input.items.map(raw).join(', ')})`);
  loaders.push('chan_tv_expected() =>',`    array.from(${ohlc.expected.map(e=>{const s=e.state;return `ChanTickExpected.new(${[s.confirmedFractals,s.confirmedStrokes,...['strokeCandidateStartTime','strokeCandidateEndTime','strokeCandidateStartTicks','strokeCandidateEndTicks'].map(k=>s[k]??'na')].join(', ')})`;}).join(', ')})`);
  for(const [i,f] of [own,batch].entries()){
    const context='chanlun-research-0.1/'+f.id;
    const component=r=>`ChanComponent.new(${componentFields.map(k=>k==='dependencies'?`array.from(${r[k].map(v=>q(v.replace(f.id+'/',context+'/'))).join(', ')})`:k==='direction'?(r[k]==='up'?1:-1):typeof r[k]==='string'?q(r[k].replace(f.id+'/',context+'/')):r[k]).join(', ')})`;
    loaders.push(`chan_tv_stream_${i}() =>`,`    ChanTickStream f = ChanTickStream.new()`,`    f.id := ${q(f.id)}`,`    f.inputs := array.from(${f.input.items.map((r,j)=>featureStroke({...r,ordinal:j+1})).join(', ')})`,`    f.expected := array.from(${f.expected.at(-1).structures.map(component).join(', ')})`,`    f.counts := array.from(${f.expected.map(e=>e.state.normalizedCount).join(', ')})`,'    f');
  }
  const harness=`
type ChanTickExpected
    int fractals
    int strokes
    int startTime
    int endTime
    int startTicks
    int endTicks
type ChanTickStream
    string id
    array<ChanStructure> inputs
    array<ChanComponent> expected
    array<int> counts
chan_tv_assert(bool value, string context) =>
    if not value
        runtime.error("FAIL: " + context)
    true
chan_tv_ohlc(ChanRuntime source, int prefix) =>
    array<ChanRaw> inputs = chan_tv_raws()
    ChanRaw incoming = inputs.get(prefix)
    string context = "T-OHLC/prefix-" + str.tostring(prefix + 1)
    string before = chan_runtime_signature(source)
    ChanRaw early = ChanRaw.new(incoming.openTime, incoming.closeTime, incoming.openTicks, incoming.openTicks, incoming.openTicks, incoming.openTicks)
    ChanRuntimeFrame tickA = chan_runtime_update(source, early, false)
    ChanRuntimeFrame tickB = chan_runtime_update(source, incoming, false)
    chan_tv_assert(not tickA.submitted and not tickB.submitted and tickA.segmentEvents.size() == 0 and tickB.componentEvents.size() == 0, context + "/no-open-delivery")
    chan_tv_assert(chan_runtime_signature(tickA.committed) == before and chan_runtime_signature(tickB.committed) == before and chan_runtime_signature(source) == before, context + "/tick-rollback")
    ChanRuntimeFrame closed = chan_runtime_update(source, incoming, true)
    ChanRuntime next = closed.committed
    chan_tv_assert(closed.submitted and next.morphology.inputCount == prefix + 1, context + "/one-close")
    chan_tv_assert(chan_signature(closed.visible) == chan_signature(tickB.visible) and chan_runtime_signature(source) == before, context + "/close-equivalence")
    ChanTickExpected expected = chan_tv_expected().get(prefix)
    chan_tv_assert(next.morphology.confirmedFractals == expected.fractals and next.morphology.strokeCount == expected.strokes, context + "/independent-counts")
    ChanStructure candidate = next.morphology.strokeCandidate
    if na(expected.startTime)
        chan_tv_assert(na(candidate), context + "/no-candidate")
    else
        chan_tv_assert(not na(candidate) and candidate.startTime == expected.startTime and candidate.endTime == expected.endTime and candidate.startTicks == expected.startTicks and candidate.endTicks == expected.endTicks, context + "/independent-candidate")
    ChanRuntimeFrame duplicate = chan_runtime_update(next, incoming, true)
    chan_tv_assert(not duplicate.submitted and duplicate.segmentEvents.size() == 0 and duplicate.componentEvents.size() == 0 and duplicate.committed.morphology.inputCount == next.morphology.inputCount and na(duplicate.visible.strokeEvent), context + "/duplicate-close")
    ChanRuntime replay = chan_runtime_new("T-OHLC", 64, 8192, 64)
    for i = 0 to prefix
        ChanRuntimeFrame frame = chan_runtime_update(replay, inputs.get(i), true)
        replay := frame.committed
    chan_tv_assert(chan_runtime_signature(replay) == chan_runtime_signature(next), context + "/prefix-reload")
    next
chan_tv_stream(ChanRuntime source, ChanTickStream fixture, int prefix) =>
    string context = fixture.id + "/prefix-" + str.tostring(prefix + 1)
    string before = chan_runtime_signature(source)
    ChanRaw hypothetical = ChanRaw.new(1800000000000, 1800000060000, 1, 2, 0, 1)
    ChanRuntimeFrame tick = chan_runtime_update(source, hypothetical, false)
    chan_tv_assert(not tick.submitted and chan_runtime_signature(tick.committed) == before and tick.componentEvents.size() == 0, context + "/all-layers-open-isolation")
    ChanRuntimeFrame frame = chan_runtime_stroke(source, fixture.inputs.get(prefix))
    ChanRuntime next = frame.committed
    int expectedCount = fixture.counts.get(prefix)
    chan_tv_assert(chan_runtime_signature(source) == before, context + "/stream-source-immutable")
    chan_tv_assert(next.normalized.count == expectedCount and next.segments.segmentCount == expectedCount, context + "/independent-counts")
    int previousCount = prefix == 0 ? 0 : fixture.counts.get(prefix - 1)
    chan_tv_assert(frame.segmentEvents.size() == expectedCount - previousCount and frame.componentEvents.size() == frame.segmentEvents.size(), context + "/batch-size")
    if frame.componentEvents.size() > 0
        for i = 0 to frame.componentEvents.size() - 1
            ChanComponent actual = frame.componentEvents.get(i)
            ChanComponent expected = fixture.expected.get(previousCount + i)
            chan_tv_assert(chan_component_signature(actual) == chan_component_signature(expected) and actual.segmentId == frame.segmentEvents.get(i).id, context + "/batch-order-mapping")
    if expectedCount == 3
        chan_tv_assert(next.centers.count == 1 and next.centers.center.coreLowTicks == 3 and next.centers.center.coreHighTicks == 10, context + "/S-N-Z-delivery")
    else
        chan_tv_assert(next.centers.count == 0, context + "/no-early-center")
    ChanRuntime replay = chan_runtime_new(fixture.id, 64, 8192, 64)
    for i = 0 to prefix
        ChanRuntimeFrame again = chan_runtime_stroke(replay, fixture.inputs.get(i))
        replay := again.committed
    chan_tv_assert(chan_runtime_signature(replay) == chan_runtime_signature(next), context + "/stream-reload")
    ChanRuntimeFrame duplicate = chan_runtime_stroke(next, fixture.inputs.get(prefix))
    chan_tv_assert(duplicate.componentEvents.size() == 0 and duplicate.segmentEvents.size() == 0 and duplicate.committed.normalized.count == expectedCount, context + "/duplicate-stream")
    string committed = chan_runtime_signature(next)
    ChanRuntime copy = chan_runtime_clone(next)
    copy.morphology.inputCount += 1
    if not na(copy.normalized.lastComponent)
        copy.normalized.lastComponent.dependencies.push("copy-probe")
    if not na(copy.centers.center)
        copy.centers.center.dependencies.push("copy-probe")
    if not na(copy.segments.lastInput)
        copy.segments.lastInput.dependencies.push("copy-probe")
    chan_tv_assert(chan_runtime_signature(next) == committed, context + "/deep-copy")
    next
chan_tv_double_preview() =>
    ChanTickStream fixture = chan_tv_stream_1()
    ChanRuntime source = chan_runtime_new(fixture.id, 64, 8192, 64)
    for i = 0 to 6
        ChanRuntimeFrame frame = chan_runtime_stroke(source, fixture.inputs.get(i))
        source := frame.committed
    source.morphology.strokeCount := 7
    string before = chan_runtime_signature(source)
    ChanState visible = chan_clone(source.morphology)
    visible.strokeCount := 8
    visible.strokeEvent := chan_structure_copy(fixture.inputs.get(7))
    ChanState projected = chan_clone(visible)
    projected.strokeCount := 9
    projected.lastStroke := chan_structure_copy(fixture.inputs.get(8))
    ChanSegmentPreview preview = chan_runtime_segment_preview(source, visible, projected)
    chan_tv_assert(chan_runtime_signature(source) == before and source.normalized.count == 0, "T-DOUBLE/source-immutable")
    chan_tv_assert(preview.state.segmentCount == 2 and preview.events.size() == 2, "T-DOUBLE/sequential-two-strokes")
    ChanRuntimeFrame first = chan_runtime_stroke(source, fixture.inputs.get(7))
    ChanRuntimeFrame last = chan_runtime_stroke(first.committed, fixture.inputs.get(8))
    chan_tv_assert(chan_segment_signature(preview.state) == chan_segment_signature(last.committed.segments), "T-DOUBLE/close-equivalence")
    true
`;
  // Loader functions precede consumers, with their types declared first.
  const split=harness.indexOf('chan_tv_assert(');
  const prefixes=ohlc.input.items.length+own.input.items.length+batch.input.items.length+1;
  const schedule=`
var int phase = 0
var int prefix = 0
var int checked = 0
var ChanRuntime online = na
var table result = table.new(position.top_right, 1, 2)
if barstate.isconfirmed and phase < 4
    if phase == 0
        if prefix == 0
            online := chan_runtime_new("T-OHLC", 64, 8192, 64)
        online := chan_tv_ohlc(online, prefix)
        prefix += 1
        if prefix == ${ohlc.input.items.length}
            phase += 1
            prefix := 0
    else if phase < 3
        ChanTickStream fixture = phase == 1 ? chan_tv_stream_0() : chan_tv_stream_1()
        if prefix == 0
            online := chan_runtime_new(fixture.id, 64, 8192, 64)
        online := chan_tv_stream(online, fixture, prefix)
        prefix += 1
        if prefix == fixture.inputs.size()
            phase += 1
            prefix := 0
    else
        chan_tv_double_preview()
        phase += 1
    checked += 1
table.cell(result, 0, 0, phase == 4 ? "PASS: T4, ${prefixes} prefixes" : "RUNNING: " + str.tostring(checked), text_color = phase == 4 ? color.green : color.orange)
table.cell(result, 0, 1, "合成tick／锁定笔注入 · 非真实多tick行情验收")
plot(na)
`;
  const output=['//@version=6','indicator("缠论收盘与预览共享验证", overlay=false)',core,harness.slice(0,split),loaders.join('\n'),harness.slice(split),schedule].join('\n')+'\n';
  return {source:output,coreHash:sha(core),sha256:sha(output),bytes:Buffer.byteLength(output),prefixes,cases:4,fixtureHashes:[ohlc,own,batch].map(f=>({id:f.id,sha256:sha(JSON.stringify(f))})),execution:'not run in Pine'};
}
export function buildRuntimeValidation(){
  const source=fs.readFileSync(new URL('chanlun_original.pine',root),'utf8');
  const {source:pine,...result}=generateRuntimeValidation(source,read('p-ohlc-integration'),read('n-own-ranges'),read('n-second-batch'));
  const output=fileURLToPath(new URL('tmp/chanlun/runtime-validation.pine',root));fs.writeFileSync(output,pine);
  const manifest={output,productionSha256:sha(source),...result};fs.writeFileSync(output+'.json',JSON.stringify(manifest,null,2)+'\n');return manifest;
}
if(process.argv[1]===fileURLToPath(import.meta.url))console.log(JSON.stringify(buildRuntimeValidation(),null,2));
