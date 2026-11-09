import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {extractCore} from './build-validation.mjs';
const root=new URL('../../',import.meta.url),sha=s=>crypto.createHash('sha256').update(s).digest('hex'),q=JSON.stringify;
export function validateWindowCases(data){
  assert.equal(data.schemaVersion,1);assert(data.note && data.cases.length);const ids=new Set();
  for(const c of data.cases){
    assert(!ids.has(c.id));ids.add(c.id);assert.equal(typeof c.missing,'boolean');assert.equal(c.config.length,6);
    assert.equal(typeof c.config[0],'boolean');assert(c.config.slice(1).every(Number.isSafeInteger));assert(c.config[2]>0 && c.config[5]>0);
    let count=0;
    for(const r of c.rows){assert.equal(r.length,9);assert(r.slice(0,2).every(Number.isSafeInteger));for(const i of [2,3,4,8])assert.equal(typeof r[i],'boolean');assert(Number.isInteger(r[5]) && r[5]>=count && r[5]<=count+1);if(r[5]>count)assert(r[2]&&r[4]);if(!r[2])assert.equal(r[5],count);for(const i of [6,7])assert(r[i]===null || Number.isSafeInteger(r[i]));assert.equal(r[6]===null,r[5]===0);assert.equal(r[7]===null,r[5]===0);count=r[5];}
  }return data;
}
export function generateWindowValidation(source,data,ohlc){
  validateWindowCases(data);assert.equal(ohlc.id,'P-OHLC-INTEGRATION');assert.equal(ohlc.expectationStatus,'reviewed');
  const core=extractCore(source),loader=[];
  for(const [i,c] of data.cases.entries())loader.push(`chan_wv_case_${i}() =>`,'    ChanWindowFixture f = ChanWindowFixture.new()',`    f.id := ${q(c.id)}`,`    f.initial := chan_window_new(${c.config.join(', ')})`,`    f.missing := ${c.missing}`,`    f.rows := array.from(${c.rows.map(r=>`ChanWindowRow.new(${r.map(v=>v??'na').join(', ')})`).join(', ')})`,'    f','');
  loader.push('chan_wv_case(int index) =>','    ChanWindowFixture result = na');
  data.cases.forEach((c,i)=>loader.push(`    ${i?'else if':'if'} index == ${i}`,`        result := chan_wv_case_${i}()`));loader.push('    result');
  const raws=ohlc.input.items.map(r=>`ChanRaw.new(${[r.time,r.closeTime,r.openTicks,r.highTicks,r.lowTicks,r.closeTicks].join(', ')})`);
  loader.push('chan_wv_raws() =>',`    array.from(${raws.join(', ')})`);
  const types=`
type ChanWindowRow
    int openTime
    int index
    bool closed
    bool eligible
    bool allowed
    int count
    int firstInput
    int lastInput
    bool truncated
type ChanWindowFixture
    string id
    ChanWindow initial
    bool missing
    array<ChanWindowRow> rows
`;
  const checks=`
chan_wv_assert(bool value, string context) =>
    if not value
        runtime.error("FAIL: " + context)
    true
chan_wv_prefix(ChanWindow source, ChanWindowFixture fixture, int prefix) =>
    ChanWindowRow row = fixture.rows.get(prefix)
    string context = fixture.id + "/prefix-" + str.tostring(prefix + 1)
    string before = chan_window_signature(source)
    ChanWindowFrame frame = chan_window_step(source, row.openTime, row.index, row.closed)
    ChanWindow next = frame.state
    chan_wv_assert(chan_window_signature(source) == before, context + "/source-immutable")
    chan_wv_assert(frame.eligible == row.eligible and frame.allowed == row.allowed, context + "/gate")
    chan_wv_assert(next.count == row.count, context + "/count expected=" + str.tostring(row.count) + " actual=" + str.tostring(next.count))
    chan_wv_assert(na(row.firstInput) ? na(next.firstInput) : row.firstInput == next.firstInput, context + "/actual-start")
    chan_wv_assert(na(row.lastInput) ? na(next.lastInput) : row.lastInput == next.lastInput, context + "/last-input")
    chan_wv_assert(next.truncated == row.truncated and next.startIndex == fixture.initial.startIndex, context + "/frozen-boundary")
    chan_wv_assert((next.fixed and next.requestedStart < next.firstAvailable) == fixture.missing, context + "/history-missing")
    if not row.closed
        chan_wv_assert(chan_window_signature(next) == before, context + "/preview-no-consumption")
    ChanWindow replay = fixture.initial.copy()
    for i = 0 to prefix
        ChanWindowRow prior = fixture.rows.get(i)
        ChanWindowFrame step = chan_window_step(replay, prior.openTime, prior.index, prior.closed)
        replay := step.state
    chan_wv_assert(chan_window_signature(next) == chan_window_signature(replay), context + "/prefix-reload")
    next
chan_wv_integration(ChanWindow source, ChanRuntime engine, int prefix) =>
    array<ChanRaw> inputs = chan_wv_raws()
    ChanRaw incoming = inputs.get(prefix)
    string before = chan_runtime_signature(engine)
    string windowBefore = chan_window_signature(source)
    ChanWindowFrame preview = chan_window_step(source, incoming.openTime, prefix, false)
    chan_wv_assert(chan_window_signature(preview.state) == windowBefore, "W-INTEGRATION/preview")
    ChanWindowFrame gate = chan_window_step(source, incoming.openTime, prefix, true)
    ChanRuntime next = engine
    if gate.allowed
        ChanRuntimeFrame frame = chan_runtime_update(engine, incoming, true)
        next := frame.committed
    else
        chan_wv_assert(chan_runtime_signature(next) == before, "W-INTEGRATION/stopped")
    int expectedCount = prefix < 4 ? 0 : prefix < 8 ? prefix - 3 : 4
    chan_wv_assert(gate.state.count == expectedCount and next.morphology.inputCount == expectedCount, "W-INTEGRATION/consumption")
    chan_wv_assert(gate.state.truncated == (prefix >= 8), "W-INTEGRATION/truncation")
    ChanWindow replayWindow = chan_window_new(true, inputs.get(4).openTime, 5, 11, inputs.first().openTime, 4)
    ChanRuntime replay = chan_runtime_new("W-INTEGRATION", 64, 8192, 64)
    for i = 0 to prefix
        ChanWindowFrame again = chan_window_step(replayWindow, inputs.get(i).openTime, i, true)
        replayWindow := again.state
        if again.allowed
            ChanRuntimeFrame frame = chan_runtime_update(replay, inputs.get(i), true)
            replay := frame.committed
    chan_wv_assert(chan_runtime_signature(replay) == chan_runtime_signature(next) and chan_window_signature(replayWindow) == chan_window_signature(gate.state), "W-INTEGRATION/reload")
    [gate.state, next]
`;
  const prefixes=data.cases.reduce((s,c)=>s+c.rows.length,0)+ohlc.input.items.length;
  const schedule=`
var int caseIndex = 0
var int prefix = 0
var ChanWindow online = na
var ChanRuntime engine = na
var table result = table.new(position.top_right, 1, 2)
if barstate.isconfirmed and caseIndex <= ${data.cases.length}
    if caseIndex < ${data.cases.length}
        ChanWindowFixture fixture = chan_wv_case(caseIndex)
        if prefix == 0
            online := fixture.initial.copy()
        online := chan_wv_prefix(online, fixture, prefix)
        prefix += 1
        if prefix == fixture.rows.size()
            caseIndex += 1
            prefix := 0
    else
        if prefix == 0
            array<ChanRaw> inputs = chan_wv_raws()
            online := chan_window_new(true, inputs.get(4).openTime, 5, 11, inputs.first().openTime, 4)
            engine := chan_runtime_new("W-INTEGRATION", 64, 8192, 64)
        [nextWindow, nextEngine] = chan_wv_integration(online, engine, prefix)
        online := nextWindow
        engine := nextEngine
        prefix += 1
        if prefix == ${ohlc.input.items.length}
            caseIndex += 1
table.cell(result, 0, 0, caseIndex > ${data.cases.length} ? "PASS: W8, ${prefixes} prefixes" : "RUNNING", text_color = caseIndex > ${data.cases.length} ? color.green : color.orange)
table.cell(result, 0, 1, "合成窗口策略／OHLC输入 · 非固定feed行情验收")
plot(na)
`;
  const pine=['//@version=6','indicator("缠论分析窗口共享验证", overlay=false)',core,types,loader.join('\n'),checks,schedule].join('\n')+'\n';
  return {source:pine,sha256:sha(pine),coreHash:sha(core),fixtureHash:sha(JSON.stringify(data)),bytes:Buffer.byteLength(pine),cases:data.cases.length+1,prefixes,execution:'not run in Pine'};
}
export function buildWindowValidation(){
  const source=fs.readFileSync(new URL('chanlun_original.pine',root),'utf8');
  const data=JSON.parse(fs.readFileSync(new URL('tests/fixtures/chanlun/windows/cases.json',root),'utf8'));
  const ohlc=JSON.parse(fs.readFileSync(new URL('tests/fixtures/chanlun/p-ohlc-integration.json',root),'utf8'));
  const {source:pine,...result}=generateWindowValidation(source,data,ohlc);
  const output=fileURLToPath(new URL('tmp/chanlun/window-validation.pine',root));fs.writeFileSync(output,pine);
  const manifest={output,productionSha256:sha(source),...result};fs.writeFileSync(output+'.json',JSON.stringify(manifest,null,2)+'\n');return manifest;
}
if(process.argv[1]===fileURLToPath(import.meta.url))console.log(JSON.stringify(buildWindowValidation(),null,2));
