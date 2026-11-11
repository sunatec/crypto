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
    int l1 = 0
    int l2 = 0
    int l3 = 0
    int z2 = 0
    int z3 = 0
    int peakMembers = 0
    int peakUpperHistory = 0
    int peakUpperSources = 0
    int levelHash = 0
    int capped = 0

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

// Upper layers: counts, retained-array peaks and a checksum over the movement and
// center events each layer emitted, so display settings can be compared by value.
chan_pressure_movement(int checksum, int kind, ChanMovement movement) =>
    int result = chan_pressure_mix(checksum, kind)
    if not na(movement)
        result := chan_pressure_mix(result, movement.level)
        result := chan_pressure_mix(result, movement.direction)
        result := chan_pressure_mix(result, movement.startTime)
        result := chan_pressure_mix(result, movement.endTime)
        result := chan_pressure_mix(result, movement.startTicks)
        result := chan_pressure_mix(result, movement.endTicks)
        result := chan_pressure_mix(result, movement.confirmedAt)
        result := chan_pressure_mix(result, movement.ordinal)
        result := chan_pressure_mix(result, movement.truncated ? 1 : 0)
    result

chan_pressure_levels(ChanPressureAudit audit, ChanRuntime state) =>
    ChanLevels upper = state.levels
    ChanMovementState m1 = state.movements
    ChanMovementState m2 = upper.movements2
    ChanMovementState m3 = upper.movements3
    ChanCenterState c2 = upper.centers2
    ChanCenterState c3 = upper.centers3
    if m1.members.size() > m1.maxMembers or m2.members.size() > m2.maxMembers or m3.members.size() > m3.maxMembers
        runtime.error("P5000: movement members exceed their budget")
    if c2.history.size() > 15 or c3.history.size() > 15 or c2.seed.size() > 2 or c3.seed.size() > 2
        runtime.error("P5000: upper center state exceeds its budget")
    int sources2 = na(c2.center) ? 0 : c2.center.dependencies.size()
    int sources3 = na(c3.center) ? 0 : c3.center.dependencies.size()
    if sources2 > c2.maxSources or sources3 > c3.maxSources
        runtime.error("P5000: upper center sources exceed their budget")
    audit.l1 := m1.count
    audit.l2 := m2.count
    audit.l3 := m3.count
    audit.z2 := c2.count
    audit.z3 := c3.count
    audit.capped := (m1.capped ? 1 : 0) + (m2.capped ? 1 : 0) + (m3.capped ? 1 : 0)
    audit.peakMembers := math.max(audit.peakMembers, math.max(m1.members.size(), math.max(m2.members.size(), m3.members.size())))
    audit.peakUpperHistory := math.max(audit.peakUpperHistory, math.max(c2.history.size(), c3.history.size()))
    audit.peakUpperSources := math.max(audit.peakUpperSources, math.max(sources2, sources3))
    int hash = audit.levelHash
    hash := chan_pressure_movement(hash, 11, m1.event)
    hash := chan_pressure_movement(hash, 12, m2.event)
    hash := chan_pressure_movement(hash, 13, m3.event)
    hash := chan_pressure_center(hash, 14, c2.event)
    hash := chan_pressure_center(hash, 15, c2.closedEvent)
    hash := chan_pressure_center(hash, 16, c3.event)
    hash := chan_pressure_center(hash, 17, c3.closedEvent)
    audit.levelHash := hash
    true

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
    chan_pressure_levels(audit, state)
    true

var ChanPressureAudit pressure = ChanPressureAudit.new()
`;

const panel = String.raw`
var table pressurePanel = table.new(position.bottom_right, 1, 11, bgcolor=color.rgb(22, 27, 34))
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
    // Direct count of the movement captions actually drawn on the chart, by displayed type.
    int capAll = 0
    int capConsolidation = 0
    int capUp = 0
    int capDown = 0
    int capExpansion = 0
    int capPending = 0
    for drawn in label.all
        string captionText = label.get_text(drawn)
        if str.contains(captionText, "-M#")
            capAll += 1
            capConsolidation += str.contains(captionText, "盘整") ? 1 : 0
            capUp += str.contains(captionText, "上涨") ? 1 : 0
            capDown += str.contains(captionText, "下跌") ? 1 : 0
            capExpansion += str.contains(captionText, "含扩展证据") ? 1 : 0
            capPending += str.contains(captionText, "待定") ? 1 : 0
    table.cell(pressurePanel, 0, 10, "已画走势标签 " + str.tostring(capAll) + " · 盘整/上涨/下跌/含扩展证据/待定 " + str.tostring(capConsolidation) + "/" + str.tostring(capUp) + "/" + str.tostring(capDown) + "/" + str.tostring(capExpansion) + "/" + str.tostring(capPending), text_color=color.white)
    string levelStatus = chan_status_text(chan_status_code(engine, analysisWindow, supported))
    table.cell(pressurePanel, 0, 6, "走势 L1/L2/L3 " + str.tostring(pressure.l1) + "/" + str.tostring(pressure.l2) + "/" + str.tostring(pressure.l3) + " · 上层中枢 Z2/Z3 " + str.tostring(pressure.z2) + "/" + str.tostring(pressure.z3) + " · 层数上限 " + str.tostring(levelLimit) + " · capped " + str.tostring(pressure.capped), text_color=color.white)
    table.cell(pressurePanel, 0, 9, "层校验 " + str.tostring(pressure.levelHash), text_color=color.white)
    table.cell(pressurePanel, 0, 7, "层峰值 走势成员/上层中枢历史/上层来源 " + str.tostring(pressure.peakMembers) + "/" + str.tostring(pressure.peakUpperHistory) + "/" + str.tostring(pressure.peakUpperSources), text_color=color.white)
    table.cell(pressurePanel, 0, 8, "状态 " + levelStatus, text_color=color.white)
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

// The fixed-start variants pin the window to the default run's effective start
// (2024-07-30 00:00 UTC on BTCUSDT 4h) so display and limit variants are compared
// on the same first 5,000 bars even after a new bar opens.
const fixedWindow = [
    ['bool fixedStart = input.bool(false,', 'bool fixedStart = input.bool(true,'],
    ['int requestedStart = input.time(1700000000000,', 'int requestedStart = input.time(1722297600000,']
];
const researchEdits = [
    ['input.string("普通", "视图"', 'input.string("研究", "视图"'],
    ['showFractals = input.bool(false,', 'showFractals = input.bool(true,'],
    ['showFeatures = input.bool(false,', 'showFeatures = input.bool(true,'],
    ['showNormalized = input.bool(false,', 'showNormalized = input.bool(true,'],
    ['labelBudget = input.int(120,', 'labelBudget = input.int(12,']
];
const variants = {
    '': [],
    '-fixed': fixedWindow,
    '-fixed-research': [...fixedWindow, ...researchEdits],
    '-fixed-level1': [...fixedWindow, ['levelLimit = input.int(3,', 'levelLimit = input.int(1,']],
    '-fixed-pending16': [...fixedWindow, ['segmentPendingLimit = input.int(64,', 'segmentPendingLimit = input.int(16,']]
};
// Whole-history variant: lifts the 5,000-bar recording cap so higher layers can form on real data.
const deepEdits = [
    ['bool fixedStart = input.bool(false,', 'bool fixedStart = input.bool(true,'],
    ['int requestedStart = input.time(1700000000000,', 'int requestedStart = input.time(1500000000000,'],
    ['int sampleLimit = input.int(20000,', 'int sampleLimit = input.int(100000,'],
    ['if pressure.count < 5000', 'if pressure.count < 100000'],
    ['pressure.count == 5000 ? "已记录 5000 根" : "接收 " + str.tostring(pressure.count) + "/5000"', '"接收 " + str.tostring(pressure.count) + " 根"']
];
variants['-deep'] = deepEdits;
const manifest = {coreHash, productionSha256:sha(production), samples:5000, scope:'K/F/P/S, L0, L1 centers, L1-L3 movements and L2/L3 centers', execution:'awaiting TradingView run', variants:{}};
for (const [suffix, edits] of Object.entries(variants)) {
    let variant = pine;
    for (const [from, to] of edits) variant = replaceOnce(variant, from, to);
    assert.equal(extractCore(variant), extractCore(production));
    const output = new URL('tmp/chanlun/pressure-validation' + suffix + '.pine', root);
    fs.mkdirSync(new URL('.', output), {recursive:true});
    fs.writeFileSync(output, variant);
    manifest.variants[suffix || '-default'] = {output:fileURLToPath(output), sha256:sha(variant), bytes:Buffer.byteLength(variant)};
    if (suffix === '') {manifest.output = fileURLToPath(output); manifest.sha256 = sha(variant);}
}
fs.writeFileSync(new URL('tmp/chanlun/pressure-validation.pine.json', root), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
