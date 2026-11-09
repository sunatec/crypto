import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {extractCore} from './build-validation.mjs';
import {featureStroke} from './feature-validation.mjs';
const root=new URL('../../',import.meta.url),sha=s=>crypto.createHash('sha256').update(s).digest('hex'),q=JSON.stringify;
export function generateBudgetValidation(source,first,plateau,own){
  assert.equal(first.id,'S-FIRST-END');assert.equal(plateau.id,'S-FIRST-EQUAL-THIRD');assert.equal(own.id,'N-OWN-RANGES');
  for(const f of [first,plateau,own])assert.equal(f.expectationStatus,'reviewed');
  const loaders=[];
  for(const [i,f] of [first,plateau].entries())loaders.push(`chan_bv_strokes_${i}() =>`,`    array.from(${f.input.items.map((s,j)=>featureStroke({...s,ordinal:j+1})).join(', ')})`);
  const records=own.expected.at(-1).structures;
  const segment=r=>`ChanStructure.new(${q(r.segmentId)}, "segment", 0, ${r.direction==='up'?1:-1}, ${r.realStartTime}, ${r.realEndTime}, ${r.realStartTicks}, ${r.realEndTicks}, true, ${r.confirmedAt}, "S-001/S-003/E-007", array.from("declared-locked-members"), ${r.ordinal}, ${r.actualLowTicks}, ${r.actualHighTicks}, ${r.actualLowTime}, ${r.actualHighTime})`;
  loaders.push('chan_bv_segments() =>',`    array.from(${records.map(segment).join(', ')})`);
  const core=extractCore(source);
  const harness=`
chan_bv_assert(bool value, string context) =>
    if not value
        runtime.error("FAIL: " + context)
    true
chan_bv_window() =>
    ChanWindow window = chan_window_new(false, 0, 5, 4, 0, 100)
    window.count := 1
    window
chan_bv_s_budget(bool pending) =>
    array<ChanStructure> inputs = pending ? chan_bv_strokes_1() : chan_bv_strokes_0()
    ChanRuntime engine = chan_runtime_new("B-S", pending ? 6 : 64, pending ? 8192 : 1, 64)
    for stroke in inputs
        ChanRuntimeFrame frame = chan_runtime_stroke(engine, stroke)
        engine := frame.committed
        chan_bv_assert(frame.componentEvents.size() == 0 and frame.segmentEvents.size() == 0, "B-S/no-partial-delivery")
    if pending
        chan_bv_assert(not engine.segments.blocked and engine.segments.inputCount == 6, "B-S/at-pending-cap")
        ChanStructure last = inputs.last()
        ChanStructure future = ChanStructure.new("future-7", "stroke", 0, 1, last.endTime, last.endTime + 60000, last.endTicks, last.endTicks + 1, true, last.confirmedAt + 60000, "P-001/P-002", array.from("declared"), 7)
        ChanRuntimeFrame frame = chan_runtime_stroke(engine, future)
        engine := frame.committed
    chan_bv_assert(engine.segments.blocked and engine.segments.segmentCount == 0 and engine.normalized.count == 0 and engine.centers.count == 0, "B-S/atomic-stop")
    chan_bv_assert(engine.segments.inputCount == (pending ? 6 : 5) and engine.segments.heldInput.ordinal == (pending ? 7 : 6), "B-S/held-input")
    ChanWindow window = chan_bv_window()
    chan_bv_assert(chan_status_code(engine, window, true) == (pending ? "S_PENDING_LIMIT" : "S_WORK_LIMIT"), "B-S/status-kind")
    string frozen = chan_segment_signature(engine.segments)
    for i = 0 to 2
        ChanRaw incoming = ChanRaw.new(1800000000000 + i * 60000, 1800000060000 + i * 60000, i, i + 2, i, i + 1)
        ChanRuntimeFrame frame = chan_runtime_update(engine, incoming, true)
        engine := frame.committed
        chan_bv_assert(engine.morphology.inputCount == i + 1 and chan_segment_signature(engine.segments) == frozen and engine.normalized.count == 0 and frame.segmentEvents.size() == 0, "B-S/upstream-continues")
    ChanStructure held = engine.segments.heldInput
    int direction = -held.direction
    ChanStructure later = ChanStructure.new("later-after-stop", "stroke", 0, direction, held.endTime, held.endTime + 60000, held.endTicks, held.endTicks + direction * 2, true, held.confirmedAt + 60000, "P-001/P-002", array.from("declared-later"), held.ordinal + 1)
    ChanRuntimeFrame future = chan_runtime_stroke(engine, later)
    chan_bv_assert(chan_segment_signature(future.committed.segments) == frozen and future.componentEvents.size() == 0, "B-S/future-does-not-restart")
    true
chan_bv_z_budget() =>
    // Declared locked-S interface, not a new OHLC reconstruction.
    ChanRuntime engine = chan_runtime_new("B-Z", 64, 8192, 3)
    for segment in chan_bv_segments()
        engine := chan_runtime_component(engine, segment)
    chan_bv_assert(engine.normalized.count == 3 and engine.centers.count == 1 and not engine.centers.blocked, "B-Z/formation")
    ChanStructure third = engine.normalized.lastInput
    int nextStart = third.endTime
    ChanStructure fourth = ChanStructure.new("B-Z/S/4", "segment", 0, -1, nextStart, nextStart + 60000, 15, 5, true, third.confirmedAt + 60000, "S-001/S-002/E-007", array.from("declared-fourth"), 4, 5, 15, nextStart + 60000, nextStart)
    engine := chan_runtime_component(engine, fourth)
    chan_bv_assert(engine.normalized.count == 4 and engine.centers.blocked and engine.centers.inputCount == 3 and engine.centers.heldInput.ordinal == 4 and engine.centers.center.dependencies.size() == 3 and na(engine.centers.event), "B-Z/atomic-stop-N-continues")
    chan_bv_assert(chan_status_code(engine, chan_bv_window(), true) == "Z_SOURCE_LIMIT", "B-Z/status-kind")
    string frozen = chan_center_signature(engine.centers)
    ChanStructure fifth = ChanStructure.new("B-Z/S/5", "segment", 0, 1, fourth.endTime, fourth.endTime + 60000, 5, 20, true, fourth.confirmedAt + 60000, "S-001/S-002/E-007", array.from("declared-fifth"), 5, 5, 20, fourth.endTime, fourth.endTime + 60000)
    engine := chan_runtime_component(engine, fifth)
    chan_bv_assert(engine.normalized.count == 5 and chan_center_signature(engine.centers) == frozen, "B-Z/blocked-future-keeps-first-held")
    ChanRaw incoming = ChanRaw.new(1800000000000, 1800000060000, 1, 2, 0, 1)
    ChanRuntimeFrame frame = chan_runtime_update(engine, incoming, true)
    chan_bv_assert(frame.committed.morphology.inputCount == 1 and chan_center_signature(frame.committed.centers) == frozen, "B-Z/KFP-continues")
    true
chan_bv_unsupported() =>
    ChanRuntime engine = chan_runtime_new("B-UNSUPPORTED", 64, 8192, 64)
    ChanWindow window = chan_bv_window()
    string before = chan_runtime_signature(engine)
    string windowBefore = chan_window_signature(window)
    // Both nonstandard chart and unavailable close time map to supported=false.
    for i = 0 to 1
        bool supported = false
        ChanWindowFrame gate = chan_window_step(window, 1000, 0, supported)
        chan_bv_assert(not chan_context_allows(supported, gate) and chan_window_signature(gate.state) == windowBefore and chan_runtime_signature(engine) == before, "B-UNSUPPORTED/no-consumption")
        chan_bv_assert(chan_status_code(engine, window, supported) == "UNSUPPORTED", "B-UNSUPPORTED/status")
    true
chan_bv_statuses() =>
    ChanRuntime engine = chan_runtime_new("B-STATUS", 64, 8192, 64)
    ChanWindow window = chan_bv_window()
    chan_bv_assert(chan_status_code(engine, window, true) == "INITIALIZING", "B-STATUS/initializing")
    engine.morphology.direction := 1
    chan_bv_assert(chan_status_code(engine, window, true) == "RUNNING", "B-STATUS/running")
    window.count := 0
    chan_bv_assert(chan_status_code(engine, window, true) == "WAIT_START", "B-STATUS/wait-start")
    window.fixed := true
    window.requestedStart := 0
    window.firstAvailable := 1000
    chan_bv_assert(chan_status_code(engine, window, true) == "HISTORY_SHORT", "B-STATUS/history-short")
    window.count := 100
    chan_bv_assert(chan_status_code(engine, window, true) == "SAMPLE_LIMIT", "B-STATUS/limit")
    window.truncated := true
    chan_bv_assert(chan_status_code(engine, window, true) == "TRUNCATED" and chan_status_code(engine, window, false) == "UNSUPPORTED", "B-STATUS/priority")
    window.fixed := false
    window.truncated := false
    engine.centers.relationKind := "new-center-pending"
    chan_bv_assert(chan_status_code(engine, window, true) == "Z_NEW_PENDING", "B-STATUS/new-center")
    engine.segments := chan_segment_new("B-STATUS", 64, 8192)
    engine.segments.gapPending := true
    chan_bv_assert(chan_status_code(engine, window, true) == "S_PROOF_PENDING", "B-STATUS/proof-pending")
    engine.centers.blocked := true
    chan_bv_assert(chan_status_code(engine, window, true) == "Z_SOURCE_LIMIT", "B-STATUS/resource-over-wait")
    engine.segments.blocked := true
    engine.segments.limitReason := "pending-strokes"
    chan_bv_assert(chan_status_code(engine, window, true) == "S_PENDING_LIMIT", "B-STATUS/lowest-blocked-layer")
    true
var int phase = 0
var table result = table.new(position.top_right, 1, 2)
if barstate.isconfirmed and phase < 5
    if phase == 0
        chan_bv_s_budget(true)
    else if phase == 1
        chan_bv_s_budget(false)
    else if phase == 2
        chan_bv_z_budget()
    else if phase == 3
        chan_bv_unsupported()
    else
        chan_bv_statuses()
    phase += 1
table.cell(result, 0, 0, phase == 5 ? "PASS: B5, 5 cases" : "RUNNING", text_color = phase == 5 ? color.green : color.orange)
table.cell(result, 0, 1, "合成预算与状态接口 · 不验证R或上层上限")
plot(na)
`;
  const pine=['//@version=6','indicator("缠论资源停止与状态共享验证", overlay=false)',core,...loaders,harness].join('\n')+'\n';
  return {source:pine,sha256:sha(pine),coreHash:sha(core),bytes:Buffer.byteLength(pine),cases:5,fixtureHashes:[first,plateau,own].map(f=>({id:f.id,sha256:sha(JSON.stringify(f))})),execution:'not run in Pine'};
}
export function buildBudgetValidation(){
  const source=fs.readFileSync(new URL('chanlun_original.pine',root),'utf8');
  const load=n=>JSON.parse(fs.readFileSync(new URL(`tests/fixtures/chanlun/${n}.json`,root),'utf8'));
  const {source:pine,...result}=generateBudgetValidation(source,load('s-first-end'),load('s-first-equal-third'),load('n-own-ranges'));
  const output=fileURLToPath(new URL('tmp/chanlun/budget-validation.pine',root));fs.writeFileSync(output,pine);
  const manifest={output,productionSha256:sha(source),...result};fs.writeFileSync(output+'.json',JSON.stringify(manifest,null,2)+'\n');return manifest;
}
if(process.argv[1]===fileURLToPath(import.meta.url))console.log(JSON.stringify(buildBudgetValidation(),null,2));
