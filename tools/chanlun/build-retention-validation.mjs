import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {extractCore} from './build-validation.mjs';
import {featureStroke} from './feature-validation.mjs';
const root=new URL('../../',import.meta.url),sha=s=>crypto.createHash('sha256').update(s).digest('hex');
export function generateRetentionValidation(source,data,fixture){
  assert.equal(data.schemaVersion,1);assert.equal(fixture.id,data.strokes.fixtureId);assert.equal(fixture.expectationStatus,'reviewed');
  assert.equal(fixture.input.items.length,data.strokes.prefixes);assert.equal(fixture.expected.at(-1).state.normalizedCount,data.strokes.expectedSegments);
  const m=data.monotonic,c=data.centers,s=data.strokes;
  assert(m.bars>4 && c.cycles>15 && c.archiveSize===15 && c.points.length===7 && c.points.at(-1)===c.points[0]+c.translation);
  const core=extractCore(source),prefixes=m.bars+s.prefixes+c.cycles*6+c.continuationInputs;
  const harness=`
chan_rv_assert(bool value, string context) =>
    if not value
        runtime.error("FAIL: " + context)
    true
chan_rv_strokes() =>
    array.from(${fixture.input.items.map((p,i)=>featureStroke({...p,ordinal:i+1})).join(', ')})
chan_rv_counts() =>
    array.from(${fixture.expected.map(p=>p.state.normalizedCount).join(', ')})
chan_rv_raw(int index) =>
    ChanRaw.new(1700000000000 + index * 60000, 1700000060000 + index * 60000, index, index + 2, index, index + 1)
chan_rv_monotonic(ChanRuntime source, int index) =>
    string before = chan_runtime_signature(source)
    ChanRuntimeFrame frame = chan_runtime_update(source, chan_rv_raw(index), true)
    ChanRuntime next = frame.committed
    chan_rv_assert(chan_runtime_signature(source) == before, "M/source-immutable")
    chan_rv_assert(next.morphology.inputCount == index + 1 and next.morphology.processedCount == (index == 0 ? 0 : index + 1), "M/cumulative-counts")
    chan_rv_assert(next.morphology.elements.size() <= ${m.retainedElements} and next.morphology.confirmedFractals == 0 and next.morphology.strokeCount == 0 and na(next.segments), "M/bounded-tail")
    if index == ${m.bars-1}
        chan_rv_assert(next.morphology.inputCount == ${m.expectedInputs} and next.morphology.processedCount == ${m.expectedProcessed} and next.morphology.elements.size() == ${m.retainedElements}, "M/independent-final")
        chan_rv_assert(next.morphology.elements.first().ordinal == ${m.expectedProcessed-m.retainedElements}, "M/retained-ordinals")
        ChanRuntime replay = chan_runtime_new("M", 64, 8192, 64)
        for i = 0 to index
            ChanRuntimeFrame again = chan_runtime_update(replay, chan_rv_raw(i), true)
            replay := again.committed
        chan_rv_assert(chan_runtime_signature(replay) == chan_runtime_signature(next), "M/reload-after-reclaim")
    next
chan_rv_segment(ChanRuntime source, int index) =>
    array<ChanStructure> inputs = chan_rv_strokes()
    string before = chan_runtime_signature(source)
    ChanRuntimeFrame frame = chan_runtime_stroke(source, inputs.get(index))
    ChanRuntime next = frame.committed
    chan_rv_assert(chan_runtime_signature(source) == before, "S/source-immutable")
    chan_rv_assert(next.segments.inputCount == index + 1 and next.segments.segmentCount == chan_rv_counts().get(index) and next.normalized.count == next.segments.segmentCount, "S/independent-counts")
    chan_rv_assert(not next.segments.blocked and next.segments.strokes.size() <= ${s.maxRetained}, "S/bounded-dependency-tail")
    if next.segments.segmentCount > 0
        chan_rv_assert(next.segments.strokes.first().startTime == next.segments.lastSegment.endTime, "S/reclaimed-prefix-boundary")
    if index == ${s.prefixes-1}
        chan_rv_assert(next.segments.segmentCount == ${s.expectedSegments} and next.segments.strokes.size() < inputs.size(), "S/final-reclaimed")
    next
chan_rv_component(int index) =>
    array<int> points = array.from(${c.points.join(', ')})
    int cycle = int(math.floor(index / 6))
    int offset = index % 6
    int startTicks = points.get(offset) + cycle * ${c.translation}
    int endTicks = points.get(offset + 1) + cycle * ${c.translation}
    int startTime = 1701000000000 + index * 60000
    int endTime = startTime + 60000
    int direction = startTicks < endTicks ? 1 : -1
    string id = "C/N/" + str.tostring(index + 1)
    string segmentId = "C/S/" + str.tostring(index + 1)
    ChanComponent.new(id, segmentId, startTime, endTime, startTicks, endTicks, math.min(startTicks, endTicks), math.max(startTicks, endTicks), direction == 1 ? startTime : endTime, direction == 1 ? endTime : startTime, startTime, endTime, startTicks, endTicks, direction, endTime + 60000, "N-001/E-008", array.from(segmentId), index + 1)
chan_rv_centers(ChanCenterState source, int index, array<ChanCenter> observed, array<string> originals) =>
    string before = chan_center_signature(source)
    ChanCenterState next = chan_center_step(source, chan_rv_component(index))
    chan_rv_assert(chan_center_signature(source) == before, "C/source-immutable")
    chan_rv_assert(not next.blocked and next.inputCount == index + 1 and next.seed.size() <= 2 and next.history.size() <= ${c.archiveSize}, "C/bounded-live-state")
    if not na(next.center)
        chan_rv_assert(next.center.dependencies.size() <= 5, "C/bounded-center-sources")
    if not na(next.closedEvent)
        observed.push(next.closedEvent)
        originals.push(chan_center_record_signature(next.closedEvent))
    if observed.size() > 0
        for i = 0 to observed.size() - 1
            chan_rv_assert(chan_center_record_signature(observed.get(i)) == originals.get(i), "C/closed-record-survives-reclaim")
        chan_rv_assert(next.previous.ordinal == observed.size(), "C/previous-independent-of-archive")
    if index == ${c.cycles*6-1}
        chan_rv_assert(next.count == ${c.expectedCount} and next.history.size() == ${c.archiveSize} and next.history.first().ordinal == ${c.oldestOrdinal} and next.history.last().ordinal == ${c.latestOrdinal}, "C/independent-clipped-archive")
        chan_rv_assert(next.center.coreLowTicks == ${c.lastCore[0]} and next.center.coreHighTicks == ${c.lastCore[1]} and next.center.ggTicks == ${c.lastStats[0]} and next.center.gTicks == ${c.lastStats[1]} and next.center.dTicks == ${c.lastStats[2]} and next.center.ddTicks == ${c.lastStats[3]}, "C/independent-last-center")
    if index == ${c.cycles*6+c.continuationInputs-1}
        chan_rv_assert(next.count == ${c.nextCount} and next.history.size() == ${c.archiveSize} and next.center.coreLowTicks == ${c.nextCore[0]} and next.center.coreHighTicks == ${c.nextCore[1]} and next.relationKind == ${JSON.stringify(c.nextRelation)}, "C/continued-after-reclaim")
        ChanCenterState replay = chan_center_new("C", 64)
        for i = 0 to index
            replay := chan_center_step(replay, chan_rv_component(i))
        chan_rv_assert(chan_center_signature(replay) == chan_center_signature(next), "C/reload-after-reclaim")
    next

var int phase = 0
var int prefix = 0
var ChanRuntime live = na
var ChanCenterState centers = na
var array<ChanCenter> observed = array.new<ChanCenter>()
var array<string> originals = array.new<string>()
var table result = table.new(position.top_right, 1, 2)
if barstate.isconfirmed and phase < 3
    if phase < 2
        if prefix == 0
            live := chan_runtime_new(phase == 0 ? "M" : "${fixture.id}", 64, 8192, 64)
        live := phase == 0 ? chan_rv_monotonic(live, prefix) : chan_rv_segment(live, prefix)
        prefix += 1
        if prefix == (phase == 0 ? ${m.bars} : ${s.prefixes})
            phase += 1
            prefix := 0
    else
        if prefix == 0
            centers := chan_center_new("C", 64)
        centers := chan_rv_centers(centers, prefix, observed, originals)
        prefix += 1
        if prefix == ${c.cycles*6+c.continuationInputs}
            phase += 1
table.cell(result, 0, 0, phase == 3 ? "PASS: G3, ${prefixes} prefixes" : "RUNNING", text_color = phase == 3 ? color.green : color.orange)
table.cell(result, 0, 1, "合成长输入与回收 · 非行情性能／绘图压力验收")
plot(na)
`;
  const pine=['//@version=6','indicator("缠论增量保留共享验证", overlay=false)',core,harness].join('\n')+'\n';
  return {source:pine,sha256:sha(pine),coreHash:sha(core),fixtureHash:sha(JSON.stringify(data)),strokeFixtureHash:sha(JSON.stringify(fixture)),cases:3,prefixes,bytes:Buffer.byteLength(pine),execution:'not run in Pine'};
}
export function buildRetentionValidation(){
  const source=fs.readFileSync(new URL('chanlun_original.pine',root),'utf8');
  const load=p=>JSON.parse(fs.readFileSync(new URL('tests/fixtures/chanlun/'+p,root),'utf8'));
  const {source:pine,...result}=generateRetentionValidation(source,load('retention/cases.json'),load('n-own-ranges.json'));
  const output=fileURLToPath(new URL('tmp/chanlun/retention-validation.pine',root));fs.writeFileSync(output,pine);
  const manifest={output,productionSha256:sha(source),...result};fs.writeFileSync(output+'.json',JSON.stringify(manifest,null,2)+'\n');return manifest;
}
if(process.argv[1]===fileURLToPath(import.meta.url))console.log(JSON.stringify(buildRetentionValidation(),null,2));
