import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {extractCore} from './build-validation.mjs';
import {sha} from './import-market-csv.mjs';

const root = new URL('../../', import.meta.url);

function replaceOnce(source, marker, replacement) {
    assert.equal(source.split(marker).length, 2, 'Expected one occurrence of ' + marker);
    return source.replace(marker, replacement);
}

const recorder = String.raw`
type ChanPressureAudit
    int count = 0
    int firstOpen = na
    int lastClose = na
    int ohlc = 0
    int structures = 0
    int peakElements = 0
    int peakStrokes = 0
    int peakCenters = 0
    int peakSources = 0
    int fractals = 0
    int strokes = 0
    int segments = 0
    int components = 0
    int centers = 0
    string segmentStop = ""
    bool centerStopped = false

// Numeric checksums for comparing the same prefix across display settings.
chan_pressure_mix(int checksum, int value) =>
    (checksum * 65599 + nz(value, -1) % 1000000007 + 1000000007) % 1000000007

chan_pressure_structure(int checksum, int kind, ChanStructure structure) =>
    int result = chan_pressure_mix(checksum, kind)
    result := chan_pressure_mix(result, structure.startTime)
    result := chan_pressure_mix(result, structure.endTime)
    result := chan_pressure_mix(result, structure.startTicks)
    result := chan_pressure_mix(result, structure.endTicks)
    chan_pressure_mix(result, structure.confirmedAt)

chan_pressure_center(int checksum, int kind, ChanCenter center) =>
    int result = chan_pressure_mix(checksum, kind)
    if not na(center)
        result := chan_pressure_mix(result, center.ordinal)
        result := chan_pressure_mix(result, center.startTime)
        result := chan_pressure_mix(result, center.formedAt)
        result := chan_pressure_mix(result, center.extentEndTime)
        result := chan_pressure_mix(result, center.closedAt)
        result := chan_pressure_mix(result, center.coreLowTicks)
        result := chan_pressure_mix(result, center.coreHighTicks)
        result := chan_pressure_mix(result, center.ddTicks)
        result := chan_pressure_mix(result, center.ggTicks)
    result

chan_pressure_record(ChanPressureAudit audit, ChanRaw raw, ChanRuntimeFrame frame) =>
    ChanRuntime state = frame.committed
    ChanState morphology = state.morphology
    ChanSegmentState segments = state.segments
    ChanCenterState centers = state.centers
    int pendingStrokes = na(segments) ? 0 : segments.strokes.size()
    int centerSources = na(centers.center) ? 0 : centers.center.dependencies.size()
    if morphology.elements.size() > 4 or (not na(segments) and pendingStrokes > segments.maxPending) or centers.history.size() > 15 or centers.seed.size() > 2 or centerSources > centers.maxSources
        runtime.error("P5000: retained state exceeds its budget")
    if morphology.inputCount != audit.count + 1
        runtime.error("P5000: submitted input is not consecutive")
    audit.count += 1
    if audit.count == 1
        audit.firstOpen := raw.openTime
    audit.lastClose := raw.closeTime
    audit.peakElements := math.max(audit.peakElements, morphology.elements.size())
    audit.peakStrokes := math.max(audit.peakStrokes, pendingStrokes)
    audit.peakCenters := math.max(audit.peakCenters, centers.history.size())
    audit.peakSources := math.max(audit.peakSources, centerSources)
    audit.fractals := morphology.confirmedFractals
    audit.strokes := morphology.strokeCount
    audit.segments := na(segments) ? 0 : segments.segmentCount
    audit.components := state.normalized.count
    audit.centers := centers.count
    audit.segmentStop := na(segments) or not segments.blocked ? "" : segments.limitReason
    audit.centerStopped := centers.blocked
    int ohlcHash = chan_pressure_mix(audit.ohlc, raw.openTime)
    ohlcHash := chan_pressure_mix(ohlcHash, raw.closeTime)
    ohlcHash := chan_pressure_mix(ohlcHash, raw.openTicks)
    ohlcHash := chan_pressure_mix(ohlcHash, raw.highTicks)
    ohlcHash := chan_pressure_mix(ohlcHash, raw.lowTicks)
    audit.ohlc := chan_pressure_mix(ohlcHash, raw.closeTicks)
    int eventHash = audit.structures
    if not na(morphology.event)
        ChanFractal fractal = morphology.event
        eventHash := chan_pressure_mix(eventHash, fractal.kind)
        eventHash := chan_pressure_mix(eventHash, fractal.endpointTime)
        eventHash := chan_pressure_mix(eventHash, fractal.priceTicks)
        eventHash := chan_pressure_mix(eventHash, fractal.confirmedAt)
    if not na(morphology.strokeEvent)
        eventHash := chan_pressure_structure(eventHash, 2, morphology.strokeEvent)
    for [index, segment] in frame.segmentEvents
        eventHash := chan_pressure_structure(eventHash, 3, segment)
        ChanComponent component = frame.componentEvents.get(index)
        eventHash := chan_pressure_mix(eventHash, component.actualLowTime)
        eventHash := chan_pressure_mix(eventHash, component.actualLowTicks)
        eventHash := chan_pressure_mix(eventHash, component.actualHighTime)
        eventHash := chan_pressure_mix(eventHash, component.actualHighTicks)
    if frame.segmentEvents.size() > 0
        eventHash := chan_pressure_center(eventHash, 4, centers.previous)
        eventHash := chan_pressure_center(eventHash, 5, centers.center)
    audit.structures := eventHash
    true

var ChanPressureAudit pressure = ChanPressureAudit.new()
`;

const panel = String.raw`
var table pressurePanel = table.new(position.bottom_right, 1, 6, bgcolor=color.rgb(22, 27, 34))
if barstate.islast
    int visibleLines = array.size(line.all)
    int visibleBoxes = array.size(box.all)
    int visibleLabels = array.size(label.all)
    bool validDrawings = visibleLines <= drawings.maxLines and visibleBoxes <= drawings.maxBoxes and visibleLabels <= drawings.maxLabels and visibleLines + visibleBoxes + visibleLabels == drawings.records.size()
    if not validDrawings
        runtime.error("P5000: drawing registry or drawing budget mismatch")
    string state = not supported ? "普通 K 线才可验收" : pressure.count == 5000 ? "已记录 5000 根" : "接收 " + str.tostring(pressure.count) + "/5000"
    string sampleRange = na(pressure.firstOpen) ? "等待数据" : str.format_time(pressure.firstOpen, "yyyy-MM-dd HH:mm", "UTC") + " → " + str.format_time(pressure.lastClose, "yyyy-MM-dd HH:mm", "UTC") + " UTC"
    string stopText = pressure.segmentStop == "" ? "" : " · S " + pressure.segmentStop
    stopText += pressure.centerStopped ? " · Z 来源受限" : ""
    table.cell(pressurePanel, 0, 0, "P5000 " + state + " · " + viewMode + (fixedStart ? " · 固定" : " · 近期"), text_color=color.orange)
    table.cell(pressurePanel, 0, 1, sampleRange, text_color=color.white)
    table.cell(pressurePanel, 0, 2, "OHLC " + str.tostring(pressure.ohlc) + " · 结构 " + str.tostring(pressure.structures) + " · CORE __CORE_TAG__", text_color=color.white)
    table.cell(pressurePanel, 0, 3, "F " + str.tostring(pressure.fractals) + " / P " + str.tostring(pressure.strokes) + " / S " + str.tostring(pressure.segments) + " / L0 " + str.tostring(pressure.components) + " / Z " + str.tostring(pressure.centers), text_color=color.white)
    table.cell(pressurePanel, 0, 4, "峰值 K/S待定/Z历史/Z来源 " + str.tostring(pressure.peakElements) + "/" + str.tostring(pressure.peakStrokes) + "/" + str.tostring(pressure.peakCenters) + "/" + str.tostring(pressure.peakSources) + stopText, text_color=color.white)
    table.cell(pressurePanel, 0, 5, "图形 线/框/标签 " + str.tostring(visibleLines) + "/" + str.tostring(visibleBoxes) + "/" + str.tostring(visibleLabels) + " · 标签上限 " + str.tostring(drawings.maxLabels), text_color=color.white)
`;

const production = fs.readFileSync(new URL('chanlun_original.pine', root), 'utf8');
const coreHash = sha(extractCore(production));
let pine = production.replaceAll('\r\n', '\n');
pine = replaceOnce(pine, 'indicator("缠论原文 · 形态研究预览", "缠论原文·预览"', 'indicator("缠论资源验收 P5000", "P5000"');
const scheduler = '// ==================== Chart scheduling: no drawing decisions enter the core ====================';
pine = replaceOnce(pine, scheduler, recorder + '\n' + scheduler);
const submit = '    if frame.submitted\n';
pine = replaceOnce(pine, submit, submit + '        if pressure.count < 5000\n            chan_pressure_record(pressure, incoming, frame)\n');
pine += panel.replace('__CORE_TAG__', coreHash.slice(0, 8));
if (production.includes('\r\n')) pine = pine.replaceAll('\n', '\r\n');
assert.equal(extractCore(pine), extractCore(production));

const output = new URL('tmp/chanlun/pressure-validation.pine', root);
fs.mkdirSync(new URL('.', output), {recursive:true});
fs.writeFileSync(output, pine);
const manifest = {
    output:fileURLToPath(output), sha256:sha(pine), coreHash, productionSha256:sha(production),
    samples:5000, scope:'K/F/P/S, L0 and L1 centers', execution:'awaiting TradingView run'
};
fs.writeFileSync(new URL(output.href + '.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
