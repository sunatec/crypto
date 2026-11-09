import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {extractCore} from './build-validation.mjs';

const root = new URL('../../', import.meta.url);
const digest = value => createHash('sha256').update(value).digest('hex');

function replaceOnce(source, marker, replacement) {
    assert.equal(source.split(marker).length, 2, 'Expected one occurrence of ' + marker);
    return source.replace(marker, replacement);
}

const beforeSchedule = `varip bool livePassed = false
varip string liveFailure = ""
bool liveReady = supported and timeframe.in_seconds() == 60 and not fixedStart and initialBars <= 300 and showFractals and showStrokes and showSegments
bool liveWatch = liveReady and barstate.isrealtime and barstate.islast and timenow >= time and timenow < time_close + 60000 and not livePassed and liveFailure == ""
string liveBefore = liveWatch ? chan_runtime_signature(engine) + "|" + chan_window_signature(analysisWindow) : ""
int liveBeforeCount = engine.morphology.inputCount
int liveBeforeWindow = analysisWindow.count
bool liveSubmitted = false
`;

const recorder = String.raw`
// Observe rendered coordinates after the production registry has swept stale objects.
chan_live_snapshot(ChanDrawRegistry registry) =>
    array<string> keys = array.new<string>()
    array<string> geometry = array.new<string>()
    int ownedLines = 0
    int ownedLabels = 0
    bool valid = true
    for record in registry.records
        ownedLines += not na(record.lineId) ? 1 : 0
        ownedLabels += not na(record.labelId) ? 1 : 0
        bool preview = record.ephemeral and (record.category == "F" or record.category == "P-line" or record.category == "S-line")
        if preview
            bool isLine = record.category != "F"
            bool exists = isLine ? array.includes(line.all, record.lineId) : array.includes(label.all, record.labelId)
            valid := valid and exists and not keys.includes(record.id) and record.touched == registry.frame
            if exists
                string point = isLine ? str.tostring(line.get_x1(record.lineId)) + "/" + str.tostring(line.get_y1(record.lineId), format.mintick) + ">" + str.tostring(line.get_x2(record.lineId)) + "/" + str.tostring(line.get_y2(record.lineId), format.mintick) : str.tostring(label.get_x(record.labelId)) + "/" + str.tostring(label.get_y(record.labelId), format.mintick)
                keys.push(record.id)
                geometry.push(point)
    [keys, geometry, valid and ownedLines == array.size(line.all) and ownedLabels == array.size(label.all)]

chan_live_changes(array<string> oldKeys, array<string> oldGeometry, array<string> keys, array<string> geometry, int updateNumber) =>
    string added = ""
    string removed = ""
    string moved = ""
    string tickTag = " tick=" + str.tostring(updateNumber)
    for [index, key] in keys
        int oldIndex = oldKeys.indexof(key)
        string point = geometry.get(index)
        if oldIndex < 0 and added == ""
            added := key + " at " + point + tickTag
        if oldIndex >= 0 and moved == ""
            string oldPoint = oldGeometry.get(oldIndex)
            if oldPoint != point
                moved := key + " " + oldPoint + " -> " + point + tickTag
    for key in oldKeys
        if removed == "" and not keys.includes(key)
            removed := key + tickTag
    [added, removed, moved]

varip int liveBarTime = na
varip int liveOpenTicks = 0
varip int liveSubmissions = 0
varip int liveCheckedBars = 0
varip string liveBaseline = ""
varip string liveLastClose = ""
varip int liveLastCloseTime = na
varip array<string> liveKeys = array.new<string>()
varip array<string> liveGeometry = array.new<string>()
varip string liveAdded = ""
varip string liveRemoved = ""
varip string liveMoved = ""
varip bool liveSawAdd = false
varip bool liveSawRemove = false
varip bool liveSawMove = false

if liveWatch
    bool newAuditBar = na(liveBarTime) or time != liveBarTime
    if newAuditBar
        liveBarTime := time
        liveOpenTicks := 0
        liveSubmissions := 0
        liveBaseline := liveBefore
        liveAdded := ""
        liveRemoved := ""
        liveMoved := ""
        liveKeys.clear()
        liveGeometry.clear()

    [currentKeys, currentGeometry, validDrawings] = chan_live_snapshot(drawings)
    string afterDraw = chan_runtime_signature(engine) + "|" + chan_window_signature(analysisWindow)
    if liveBefore != liveBaseline or (newAuditBar and time == liveLastCloseTime + 60000 and liveBefore != liveLastClose)
        liveFailure := "confirmed state changed between ticks"
    else if afterDraw != liveAfterSchedule or not validDrawings
        liveFailure := "drawing mutated state or left a stale object"
    else if not barstate.isconfirmed
        if liveSubmitted or afterDraw != liveBefore
            liveFailure := "open tick changed committed state"
        else
            liveOpenTicks += 1
            if liveOpenTicks > 1
                [added, removed, moved] = chan_live_changes(liveKeys, liveGeometry, currentKeys, currentGeometry, liveOpenTicks)
                if liveAdded == ""
                    liveAdded := added
                if liveRemoved == ""
                    liveRemoved := removed
                if liveMoved == ""
                    liveMoved := moved
            liveKeys := currentKeys
            liveGeometry := currentGeometry
            if newAuditBar and time == liveLastCloseTime + 60000 and liveSawAdd and liveSawRemove and liveSawMove
                livePassed := true
                log.info("RT8.3 PASS | closed bars=" + str.tostring(liveCheckedBars) + " | next open confirmed | CORE __CORE_TAG__")
    else
        liveSubmissions += liveSubmitted ? 1 : 0
        bool committedOnce = liveSubmissions == 1 and engine.morphology.inputCount == liveBeforeCount + 1 and analysisWindow.count == liveBeforeWindow + 1 and analysisWindow.lastInput == time
        if not committedOnce
            liveFailure := "close did not commit exactly once"
        else
            liveLastClose := afterDraw
            liveLastCloseTime := time
            if liveOpenTicks >= 2
                liveCheckedBars += 1
                bool newEvidence = (not liveSawAdd and liveAdded != "") or (not liveSawRemove and liveRemoved != "") or (not liveSawMove and liveMoved != "")
                liveSawAdd := liveSawAdd or liveAdded != ""
                liveSawRemove := liveSawRemove or liveRemoved != ""
                liveSawMove := liveSawMove or liveMoved != ""
                if newEvidence or liveCheckedBars == 1
                    string witness = "RT8.3 " + ticker.standard(syminfo.tickerid) + " time=" + str.tostring(time) + " openTicks=" + str.tostring(liveOpenTicks) + " submissions=" + str.tostring(liveSubmissions) + " input=" + str.tostring(liveBeforeCount) + "->" + str.tostring(engine.morphology.inputCount)
                    log.info(witness + "\nadd=" + liveAdded + "\nremove=" + liveRemoved + "\nmove=" + liveMoved)
    if liveFailure != ""
        log.error("RT8.3 FAIL | time=" + str.tostring(time) + " | " + liveFailure)

var table livePanel = table.new(position.bottom_right, 1, 2)
if barstate.islast
    string result = liveFailure != "" ? "RT8.3 FAIL | " + liveFailure : livePassed ? "RT8.3 PASS" : liveReady ? "RT8.3 等待实时证据" : "RT8.3 请使用 1 分钟普通K线及默认设置"
    string coverage = "盘中 " + str.tostring(liveOpenTicks) + " tick · 收盘 " + str.tostring(liveCheckedBars) + " · 出现 " + str.tostring(liveSawAdd) + " · 消失 " + str.tostring(liveSawRemove) + " · 移动 " + str.tostring(liveSawMove)
    table.cell(livePanel, 0, 0, result, text_color = color.white, bgcolor = liveFailure != "" ? color.maroon : livePassed ? color.green : color.rgb(22, 27, 34))
    table.cell(livePanel, 0, 1, coverage, text_color = color.white, bgcolor = color.rgb(22, 27, 34))
`;

const production = fs.readFileSync(new URL('chanlun_original.pine', root), 'utf8');
const source = production.replaceAll('\r\n', '\n');
const coreHash = digest(extractCore(production));
let pine = replaceOnce(source, 'indicator("缠论原文 · 形态研究预览", "缠论原文·预览"', 'indicator("缠论实时验收 RT8.3", "RT8.3"');
pine = replaceOnce(pine, 'initialBars = input.int(5000,', 'initialBars = input.int(300,');
pine = replaceOnce(pine, 'showFractals = input.bool(false,', 'showFractals = input.bool(true,');
pine = replaceOnce(pine, 'ChanWindowFrame windowFrame = chan_window_step(analysisWindow,', beforeSchedule + 'ChanWindowFrame windowFrame = chan_window_step(analysisWindow,');
pine = replaceOnce(pine, '    engine := frame.committed\n', '    liveSubmitted := frame.submitted\n    engine := frame.committed\n');
const projection = '// ==================== Last-bar research projection ====================';
pine = replaceOnce(pine, projection, 'string liveAfterSchedule = liveWatch ? chan_runtime_signature(engine) + "|" + chan_window_signature(analysisWindow) : ""\n\n' + projection);
pine += recorder.replaceAll('__CORE_TAG__', coreHash.slice(0, 8));
if (production.includes('\r\n')) pine = pine.replaceAll('\n', '\r\n');
assert.equal(digest(extractCore(pine)), coreHash, 'Generated indicator changed the shared core');
const output = new URL('tmp/chanlun/live-validation.pine', root);
fs.mkdirSync(new URL('.', output), {recursive:true});
fs.writeFileSync(output, pine);
const manifest = {
    output:fileURLToPath(output), sha256:digest(pine), coreHash, productionSha256:digest(production),
    execution:'awaiting live TradingView run'
};
fs.writeFileSync(new URL(output.href + '.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
