import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {extractCore} from './build-validation.mjs';
import {sha} from './import-market-csv.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const q=JSON.stringify;
const alphabet=Array.from({length:95},(_,i)=>String.fromCharCode(32+i)).join('');
export const marketTraceFields={
  audit_feed_code:'feedCode',audit_timeframe_seconds:'seconds',audit_tick_size:'tickSize',audit_standard:'1',
  audit_core_tag:'coreTag',audit_baseline_tag:'baselineTag',audit_requested_start:'start',audit_sample_limit:'bars',
  audit_initial_bars:'initialBars',audit_segment_pending_limit:'pendingLimit',audit_segment_work_limit:'workLimit',audit_center_sources:'centerSources',
  audit_prefix:'window.count',audit_close_time_ms:'time_close',audit_event_hash_a:'digest.a',audit_event_hash_b:'digest.b',audit_event_count:'digest.count',
  audit_fractals:'engine.morphology.confirmedFractals',audit_strokes:'engine.morphology.strokeCount',audit_segments:'na(engine.segments) ? 0 : engine.segments.segmentCount',
  audit_l0:'engine.normalized.count',audit_centers:'engine.centers.count',audit_effective_start:'engine.morphology.effectiveStart',
  audit_p_start_time:'na(pCandidate) ? na : pCandidate.startTime',audit_p_end_time:'na(pCandidate) ? na : pCandidate.endTime',
  audit_p_start_ticks:'na(pCandidate) ? na : pCandidate.startTicks',audit_p_end_ticks:'na(pCandidate) ? na : pCandidate.endTicks',
  audit_s_start_time:'na(sCandidate) ? na : sCandidate.startTime',audit_s_end_time:'na(sCandidate) ? na : sCandidate.endTime',
  audit_s_start_ticks:'na(sCandidate) ? na : sCandidate.startTicks',audit_s_end_ticks:'na(sCandidate) ? na : sCandidate.endTicks',
  audit_z_low:'na(center) ? na : center.coreLowTicks',audit_z_high:'na(center) ? na : center.coreHighTicks',
  audit_z_gg:'na(center) ? na : center.ggTicks',audit_z_g:'na(center) ? na : center.gTicks',audit_z_d:'na(center) ? na : center.dTicks',audit_z_dd:'na(center) ? na : center.ddTicks',
  audit_z_start:'na(center) ? na : center.startTime',audit_z_formed:'na(center) ? na : center.formedAt',audit_z_extent:'na(center) ? na : center.extentEndTime',
  audit_z_pending:'na(engine.centers.pendingLeave) ? 0 : engine.centers.pendingLeave.ordinal',
  audit_s_blocked:'na(engine.segments) ? 0 : (engine.segments.blocked ? 1 : 0)',
  audit_s_gap:'na(engine.segments) ? 0 : (engine.segments.gapPending ? 1 : 0)',audit_z_blocked:'engine.centers.blocked ? 1 : 0',
};
export const nullableMarketFields=Object.keys(marketTraceFields).filter(k=>k==='audit_effective_start'||/^audit_[ps]_(start|end)_/.test(k)||(/^audit_z_/.test(k)&&!['audit_z_pending','audit_z_blocked'].includes(k)));

export function encodeMarketRows(payload,chunkSize=128){
  assert(Number.isInteger(chunkSize)&&chunkSize>0&&chunkSize<=128,'invalid chunk size');
  const rows=payload.bars.map(bar=>['openTicks','highTicks','lowTicks','closeTicks'].map(k=>{assert(Number.isSafeInteger(bar[k])&&bar[k]>0,'invalid baseline ticks');return bar[k];}).join(','));
  const chunks=[];for(let i=0;i<rows.length;i+=chunkSize)chunks.push(rows.slice(i,i+chunkSize).join(';'));
  return chunks;
}

const harness=`
type ChanMarketDigest
    int a = 0
    int b = 0
    int count = 0

chan_mv_assert(bool value, string context) =>
    if not value
        runtime.error("FAIL: " + context)
    true

// Two bounded integer rolling checksums, not cryptographic proof. Full event
// records can also be inspected in Pine Logs using the optional toggle.
chan_mv_event(ChanMarketDigest source, string kind, string record, bool eventLogs) =>
    ChanMarketDigest result = source.copy()
    string encodedEvent = kind + ":" + str.tostring(str.length(record)) + ":" + record + "|"
    string alphabet = __ALPHABET__
    if str.length(encodedEvent) > 0
        for i = 0 to str.length(encodedEvent) - 1
            int code = str.pos(alphabet, str.substring(encodedEvent, i, i + 1))
            chan_mv_assert(not na(code), "unsupported event audit character")
            result.a := (result.a * 257 + code + 1) % 1000000007
            result.b := (result.b * 263 + code + 1) % 1000000009
    result.count += 1
    if eventLogs
        log.info(kind + ":" + record)
    result

chan_mv_tick(float price, int expected, float tick, string context) =>
    float units = price / tick
    int actual = int(math.round(units))
    chan_mv_assert(not na(price) and math.abs(units - actual) <= 0.00001, context + "/off-tick")
    chan_mv_assert(actual == expected, context + "/OHLC expected=" + str.tostring(expected) + " actual=" + str.tostring(actual))
    actual

chan_mv_input(array<string> rows, int index, int start, int period, float tick) =>
    string context = "prefix-" + str.tostring(index + 1) + "/open=" + str.tostring(time)
    chan_mv_assert(time == start + index * period and time_close == time + period, context + "/clock-or-gap")
    array<string> values = str.split(rows.get(index), ",")
    chan_mv_assert(values.size() == 4, context + "/encoded-row")
    int o = chan_mv_tick(open, int(str.tonumber(values.get(0))), tick, context + "/open")
    int h = chan_mv_tick(high, int(str.tonumber(values.get(1))), tick, context + "/high")
    int l = chan_mv_tick(low, int(str.tonumber(values.get(2))), tick, context + "/low")
    int c = chan_mv_tick(close, int(str.tonumber(values.get(3))), tick, context + "/close")
    ChanRaw.new(time, time_close, o, h, l, c)

chan_mv_events(ChanMarketDigest source, ChanRuntime previous, ChanRuntimeFrame frame, bool eventLogs) =>
    ChanMarketDigest result = source
    if not na(frame.visible.event)
        result := chan_mv_event(result, "F", chan_fractal_signature(frame.visible.event) + "/" + frame.visible.event.ruleId, eventLogs)
    if not na(frame.visible.strokeEvent)
        result := chan_mv_event(result, "P", chan_structure_signature(frame.visible.strokeEvent), eventLogs)
    chan_mv_assert(frame.segmentEvents.size() == frame.componentEvents.size(), "S-N batch size")
    // Inspect every intermediate Z event in a multi-S batch. The final runtime
    // state alone only retains the final transient event of that batch.
    ChanCenterState centers = previous.centers
    for [i, segment] in frame.segmentEvents
        ChanComponent component = frame.componentEvents.get(i)
        result := chan_mv_event(result, "S", chan_structure_signature(segment), eventLogs)
        result := chan_mv_event(result, "N", chan_component_signature(component), eventLogs)
        centers := chan_center_step(centers, component)
        if not na(centers.closedEvent)
            result := chan_mv_event(result, "Z-close", chan_center_record_signature(centers.closedEvent), eventLogs)
        if not na(centers.event)
            result := chan_mv_event(result, "Z-form", chan_center_record_signature(centers.event), eventLogs)
    if frame.componentEvents.size() > 0
        chan_mv_assert(chan_center_signature(centers) == chan_center_signature(frame.committed.centers), "intermediate Z delivery")
    result
`.replace('__ALPHABET__',q(alphabet));

export function generateMarketValidation(production,payload,receipt,plan){
  const target=plan.cases.find(c=>c.id===payload.caseId);assert(target,'unplanned market case');
  assert.equal(receipt.caseId,target.id);assert.equal(receipt.canonicalSha256,sha(JSON.stringify(payload)+'\n'),'baseline receipt hash mismatch');
  assert.equal(receipt.planSha256,sha(JSON.stringify(plan)),'baseline plan hash mismatch');
  assert.equal(payload.feed,target.feed);assert.equal(payload.timeframe,target.timeframe);assert.equal(payload.bars.length,plan.barsPerCase);
  const start=Date.parse(target.startUTC),end=Date.parse(plan.endExclusiveUTC),period=target.seconds*1000;
  assert.equal(end-start,period*payload.bars.length);assert(Number(payload.tickSize)>0);
  payload.bars.forEach((bar,i)=>{assert.equal(bar.time,start+i*period);assert.equal(bar.closeTime,bar.time+period);assert(bar.lowTicks<=Math.min(bar.openTicks,bar.closeTicks)&&bar.highTicks>=Math.max(bar.openTicks,bar.closeTicks),'invalid baseline OHLC');});
  const params=plan.indicatorParameters;
  for(const key of ['sampleLimit','initialBars','segmentPendingLimit','segmentWorkLimit','centerSources'])assert(Number.isSafeInteger(params[key])&&params[key]>0,'invalid market parameter');
  assert.equal(params.fixedStart,true);assert.equal(params.sampleLimit,plan.barsPerCase);
  const core=extractCore(production),coreHash=sha(core),coreTag=parseInt(coreHash.slice(0,8),16),baselineTag=parseInt(receipt.canonicalSha256.slice(0,8),16);
  const values={feedCode:target.feedCode,seconds:target.seconds,tickSize:Number(payload.tickSize),coreTag,baselineTag,start,bars:payload.bars.length,initialBars:params.initialBars,pendingLimit:params.segmentPendingLimit,workLimit:params.segmentWorkLimit,centerSources:params.centerSources};
  const chunks=encodeMarketRows(payload);
  const loader=['chan_mv_rows() =>','    array<string> result = array.new<string>()','    array<string> chunks = array.new<string>()',
    ...chunks.map(chunk=>`    chunks.push(${q(chunk)})`),
    '    for chunk in chunks','        array<string> rows = str.split(chunk, ";")','        for row in rows','            result.push(row)','    result'].join('\n');
  const context='M-'+target.id,expectedDisplay=`PASS: ${context}, ${payload.bars.length} input bars`;
  const schedule=`
bool eventLogs = input.bool(false, "输出确认事件日志（Pine Logs）")
${Object.entries(values).map(([key,value])=>`${key==='tickSize'?'float':'int'} ${key} = ${value}`).join('\n')}
int period = ${period}
int endExclusive = ${end}
if barstate.isfirst
    chan_mv_assert(chart.is_standard, "use ordinary candles")
    chan_mv_assert(ticker.standard(syminfo.tickerid) == ${q(target.feed)}, "chart feed must be ${target.feed}")
    chan_mv_assert(timeframe.in_seconds() == seconds, "wrong chart timeframe")
    chan_mv_assert(math.abs(syminfo.mintick - tickSize) < tickSize * 0.000001, "wrong chart tick size")
    chan_mv_assert(time <= start, "load history at or before ${target.startUTC}")
var array<string> rows = chan_mv_rows()
var ChanWindow window = chan_window_new(true, start, initialBars, last_bar_index, time, bars)
var ChanRuntime engine = chan_runtime_new(${q(context)}, pendingLimit, workLimit, centerSources)
var ChanMarketDigest digest = ChanMarketDigest.new()
bool observed = false
if barstate.isconfirmed
    ChanWindowFrame gate = chan_window_step(window, time, bar_index, true)
    if chan_context_allows(chart.is_standard, gate)
        chan_mv_assert(window.count < rows.size() and time < endExclusive, "missing bars before fixed window end")
        ChanRaw incoming = chan_mv_input(rows, window.count, start, period, tickSize)
        ChanRuntimeFrame frame = chan_runtime_update(engine, incoming, true)
        chan_mv_assert(frame.submitted, "close not submitted")
        digest := chan_mv_events(digest, engine, frame, eventLogs)
        engine := frame.committed
        observed := true
    window := gate.state
    chan_mv_assert(window.count == engine.morphology.inputCount, "window/runtime count mismatch")
    chan_mv_assert(engine.normalized.count == (na(engine.segments) ? 0 : engine.segments.segmentCount), "S/N cumulative count mismatch")
    if time >= endExclusive
        chan_mv_assert(window.count == bars, "fixed window incomplete")
ChanStructure pCandidate = engine.morphology.strokeCandidate
ChanStructure sCandidate = na(engine.segments) ? na : engine.segments.candidate
ChanCenter center = engine.centers.center
var table result = table.new(position.top_right, 1, 4)
if barstate.islast
    table.cell(result, 0, 0, window.count == bars ? ${q(expectedDisplay)} : "WAIT/RUN: " + str.tostring(window.count) + "/" + str.tostring(bars), text_color = window.count == bars ? color.lime : color.orange, bgcolor=color.rgb(22,27,34))
    table.cell(result, 0, 1, "真实CSV逐根核对 · 固定起点／上限1008 · CORE ${coreHash.slice(0,8)}", text_color=color.white, bgcolor=color.rgb(22,27,34))
    table.cell(result, 0, 2, "P=" + str.tostring(engine.morphology.strokeCount) + " S=" + str.tostring(na(engine.segments) ? 0 : engine.segments.segmentCount) + " L0=" + str.tostring(engine.normalized.count) + " Z=" + str.tostring(engine.centers.count) + " · " + chan_status_text(chan_status_code(engine, window, chart.is_standard)), text_color=color.white, bgcolor=color.rgb(22,27,34))
    table.cell(result, 0, 3, "导出本指标数据供回放和重载对照", text_color=color.orange, bgcolor=color.rgb(22,27,34))
${Object.entries(marketTraceFields).map(([name,expression])=>`plot(observed ? (${expression}) : na, ${q(name)}, display=display.data_window)`).join('\n')}
`;
  const source=['//@version=6',`indicator(${q('缠论同源行情校验 '+target.id)}, overlay=false, precision=8)`,`// Frozen OHLC SHA-256: ${receipt.canonicalSha256}`,`// Shared CORE SHA-256: ${coreHash}`,'// Generated input verification and trace recorder, not independent structure expectations.',core,harness,loader,schedule].join('\n')+'\n';
  assert(Object.keys(marketTraceFields).length<64,'plot budget exceeded');
  return {source,sha256:sha(source),coreHash,productionSha256:sha(production),canonicalSha256:receipt.canonicalSha256,caseId:target.id,feed:target.feed,feedCode:target.feedCode,timeframe:target.timeframe,seconds:target.seconds,tickSize:payload.tickSize,startUTC:target.startUTC,endExclusiveUTC:plan.endExclusiveUTC,bars:payload.bars.length,parameters:{...params,requestedStart:start},coreTag,baselineTag,bytes:Buffer.byteLength(source),expectedDisplay,traceFields:Object.keys(marketTraceFields),nullableFields:nullableMarketFields,execution:'not compiled or run in Pine',scope:'Frozen OHLC/chart/window check and comparable trace; replay/reload and production entry not yet verified'};
}

export function buildMarketValidation(outputDirectory=path.join(root,'tmp/chanlun/market-validation')){
  const market=path.join(root,'tests/fixtures/chanlun/market'),plan=JSON.parse(fs.readFileSync(path.join(market,'plan.json'),'utf8'));
  const production=fs.readFileSync(path.join(root,'chanlun_original.pine'),'utf8');
  fs.mkdirSync(outputDirectory,{recursive:true});
  const cases=plan.cases.map(target=>{
    const directory=path.join(market,'baselines',target.id),raw=fs.readFileSync(path.join(directory,'bars.json')),receipt=JSON.parse(fs.readFileSync(path.join(directory,'receipt.json'),'utf8'));
    assert.equal(sha(raw),receipt.canonicalSha256,'frozen baseline corrupted');assert.equal(sha(fs.readFileSync(path.join(directory,'source.csv'))),receipt.rawCsvSha256,'source CSV corrupted');
    const {source,...metadata}=generateMarketValidation(production,JSON.parse(raw),receipt,plan),output=path.join(outputDirectory,target.id.toLowerCase()+'.pine');
    fs.writeFileSync(output,source);fs.writeFileSync(output+'.json',JSON.stringify({...metadata,output},null,2)+'\n');return {...metadata,output};
  });
  const manifest={schemaVersion:1,productionSha256:sha(production),cases,status:'generated only; awaiting first BTC1h platform result'};
  fs.writeFileSync(path.join(outputDirectory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');return manifest;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(buildMarketValidation(),null,2));
