import fs from 'node:fs';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {extractCore,extractSection} from './build-validation.mjs';
const root=new URL('../../',import.meta.url),sha=s=>crypto.createHash('sha256').update(s).digest('hex');
export function generateDisplayControlsValidation(source){
  const core=extractCore(source),renderer=extractSection(source,'RENDERER');
  const driver=`
chan_dv_assert(bool value, string context) =>
    if not value
        runtime.error("DISPLAY FAIL: " + context)
    true
chan_dv_structure(string id, int ordinal, bool confirmed, int a, int b, int lowTicks, int highTicks) =>
    ChanStructure.new(id, "stroke", 0, highTicks > lowTicks ? 1 : -1, a, b, lowTicks, highTicks, confirmed, confirmed ? b : na, "SYNTHETIC-DISPLAY-ONLY", array.from("synthetic"), ordinal)
chan_dv_center(string id, int a, int b, int lowTicks, int highTicks) =>
    ChanCenter.new(id, 1, lowTicks, highTicks, highTicks, highTicks, lowTicks, lowTicks, a, b, b, b, lowTicks == highTicks, "extending", "SYNTHETIC-DISPLAY-ONLY", array.from("synthetic"), 1, 2)
chan_dv_clear(ChanDrawRegistry registry) =>
    while registry.records.size() > 0
        chan_draw_delete(registry, registry.records.size() - 1)
    true
chan_dv_quotas() =>
    ChanDrawRegistry registry = chan_draw_new(3)
    for i = 0 to 5
        chan_draw_put(registry, ChanDrawSpec.new("quota/" + str.tostring(i), "quota", "label", 1700000000000, 1700000000000, 1, 1, color.blue, 1, true, "synthetic", "", 12, 100, false, 10))
    chan_dv_assert(chan_draw_count(registry, "label", "") == 3 and chan_draw_index(registry, "quota/0") == -1, "D1/global-quota")
    for i = 0 to 1
        chan_draw_put(registry, ChanDrawSpec.new("group/" + str.tostring(i), "group", "line", 1700000000000, 1700000060000, 1, 2, color.blue, 1, true, "", "", 12, 100, false, 1))
    chan_dv_assert(chan_draw_index(registry, "group/0") == -1 and chan_draw_index(registry, "group/1") >= 0, "D1/group-quota")
    chan_dv_clear(registry)
chan_dv_degenerate() =>
    ChanDrawRegistry registry = chan_draw_new(10)
    ChanVisualStyle style = ChanVisualStyle.new()
    style.centerWidth := 4
    ChanCenter center = chan_dv_center("degenerate", 1700000000000, 1700000060000, 1, 2)
    string before = chan_center_record_signature(center)
    chan_draw_center(registry, center, 1, style, true)
    chan_dv_assert(chan_draw_count(registry, "box", "") == 1, "D2/box")
    chan_dv_assert(chan_center_record_signature(center) == before, "D2/source-immutable")
    center.coreHighTicks := 1
    center.degenerate := true
    chan_draw_center(registry, center, 1, style, false)
    chan_dv_assert(chan_draw_count(registry, "box", "") == 0 and chan_draw_count(registry, "line", "") == 1 and chan_draw_index(registry, "degenerate/caption") == -1, "D2/degenerate-and-hide-label")
    chan_dv_clear(registry)
chan_dv_caption() =>
    ChanDrawRegistry registry = chan_draw_new(10)
    ChanVisualStyle style = ChanVisualStyle.new()
    style.strokeLabelStride := 2
    ChanStructure stroke = chan_dv_structure("stride", 2, true, 1700000000000, 1700000060000, 1, 2)
    chan_draw_structure(registry, stroke, 1, style, true)
    chan_dv_assert(chan_draw_index(registry, "stride/caption") == -1 and chan_draw_index(registry, "stride/line") >= 0, "D3/stride-does-not-hide-line")
    stroke.ordinal := 3
    chan_draw_structure(registry, stroke, 1, style, true)
    chan_dv_assert(chan_draw_index(registry, "stride/caption") >= 0, "D3/selected-ordinal")
    stroke.ordinal := 2
    stroke.confirmed := false
    stroke.confirmedAt := na
    chan_draw_structure(registry, stroke, 1, style, true)
    chan_dv_assert(chan_draw_index(registry, "stride/caption") >= 0, "D3/candidate-always-labelled")
    chan_draw_begin(registry)
    chan_draw_sweep(registry)
    chan_dv_assert(chan_draw_count(registry, "", "") == 0, "D3/candidate-sweep")
    stroke.confirmed := true
    stroke.confirmedAt := stroke.endTime
    stroke.ordinal := 3
    chan_draw_structure(registry, stroke, 1, style, true)
    chan_draw_structure(registry, stroke, 1, style, false)
    chan_dv_assert(chan_draw_index(registry, "stride/caption") == -1 and chan_draw_index(registry, "stride/line") >= 0, "D3/remove-existing-caption")
    stroke.objectType := "segment"
    stroke.ordinal := 2
    style.segmentLabelStride := 3
    chan_draw_structure(registry, stroke, 1, style, true)
    chan_dv_assert(chan_draw_index(registry, "stride/caption") == -1, "D3/segment-stride")
    stroke.ordinal := 4
    chan_draw_structure(registry, stroke, 1, style, true)
    chan_dv_assert(chan_draw_index(registry, "stride/caption") >= 0, "D3/segment-selected")
    chan_dv_clear(registry)
chan_dv_movement(string id, int level, int direction, string morphology, bool completed, bool truncated, int ordinal, int startTicks, int endTicks) =>
    ChanMovement result = ChanMovement.new(id, level, direction, 1700000000000, 1700000060000, startTicks, endTicks, morphology, completed, completed ? 1700000060000 : na, completed ? "SYNTHETIC-DISPLAY-ONLY/close" : "", "SYNTHETIC-DISPLAY-ONLY", array.new<string>(), array.new<string>(), ordinal)
    result.truncated := truncated
    result
chan_dv_caption_text(ChanDrawRegistry registry, string id) =>
    int index = chan_draw_index(registry, id + "/caption")
    string found = "<missing>"
    if index >= 0
        found := label.get_text(registry.records.get(index).labelId)
    found
chan_dv_movement_types() =>
    ChanDrawRegistry registry = chan_draw_new(40)
    ChanVisualStyle style = ChanVisualStyle.new()
    chan_draw_movement(registry, chan_dv_movement("t1", 1, 1, "consolidation", true, false, 1, 1, 2), 1, style, true)
    chan_dv_assert(chan_dv_caption_text(registry, "t1") == "L1-M#1 · 盘整", "D5/movement-type-consolidation")
    chan_draw_movement(registry, chan_dv_movement("t2", 2, 1, "trend", true, false, 2, 1, 2), 1, style, true)
    chan_dv_assert(chan_dv_caption_text(registry, "t2") == "L2-M#2 · 上涨", "D5/movement-type-up")
    chan_draw_movement(registry, chan_dv_movement("t3", 3, -1, "trend", true, false, 3, 2, 1), 1, style, true)
    chan_dv_assert(chan_dv_caption_text(registry, "t3") == "L3-M#3 · 下跌", "D5/movement-type-down")
    chan_draw_movement(registry, chan_dv_movement("t4", 1, -1, "expansion-evidence", true, true, 4, 2, 1), 1, style, true)
    chan_dv_assert(chan_dv_caption_text(registry, "t4") == "L1-M#4 · 含扩展证据 · 起点截断", "D5/movement-type-expansion-truncated")
    chan_draw_movement(registry, chan_dv_movement("t5", 1, 1, "", false, false, 5, 1, 2), 1, style, true)
    chan_dv_assert(chan_dv_caption_text(registry, "t5") == "L1-M#5 · 待定 · 进行中", "D5/movement-type-open")
    chan_draw_movement(registry, chan_dv_movement("t6", 2, -1, "", false, true, 6, 2, 1), 1, style, true)
    chan_dv_assert(chan_dv_caption_text(registry, "t6") == "L2-M#6 · 待定 · 进行中 · 起点截断", "D5/movement-type-open-truncated")
    // The type comes from the kernel, never from the line slope: this "trend" is
    // labelled up although its drawn end price is below its start price.
    chan_draw_movement(registry, chan_dv_movement("t7", 1, 1, "trend", true, false, 7, 2, 1), 1, style, true)
    chan_dv_assert(chan_dv_caption_text(registry, "t7") == "L1-M#7 · 上涨", "D5/type-ignores-slope")
    chan_draw_movement(registry, chan_dv_movement("t8", 1, -1, "uptrend", true, false, 8, 2, 1), 1, style, true)
    chan_draw_movement(registry, chan_dv_movement("t9", 1, 1, "downtrend", true, false, 9, 1, 2), 1, style, true)
    chan_dv_assert(chan_dv_caption_text(registry, "t8") == "L1-M#8 · 上涨" and chan_dv_caption_text(registry, "t9") == "L1-M#9 · 下跌", "D5/legacy-synthetic-types")
    chan_dv_assert(chan_draw_count(registry, "line", "") == 9 and chan_draw_count(registry, "label", "") == 9, "D5/one-line-and-one-label-each")
    chan_dv_clear(registry)
    ChanMovementState layer = chan_movement_new_level("D5", 8, 1, true)
    layer.active := true
    layer.direction := 1
    layer.startTime := 1700000000000
    layer.startTicks := 1
    layer.members.push(ChanComponent.new("m1", "s1", 1700000000000, 1700000060000, 1, 2, 1, 2, 1700000000000, 1700000060000, 1700000000000, 1700000060000, 1, 2, 1, 1700000060000, "SYNTHETIC-DISPLAY-ONLY", array.from("synthetic"), 1))
    chan_draw_movement_layer(registry, layer, 1, style, true)
    chan_dv_assert(chan_draw_count(registry, "line", "") == 1 and chan_dv_caption_text(registry, "D5/L1/R/1/1700000000000") == "L1-M#1 · 待定 · 进行中", "D5/open-movement-layer")
    layer.history.push(chan_dv_movement("D5/L1/R/1/1700000000000", 1, 1, "consolidation", true, false, 1, 1, 2))
    layer.count := 1
    layer.active := false
    chan_draw_movement_layer(registry, layer, 1, style, true)
    chan_dv_assert(chan_draw_count(registry, "line", "") == 1 and chan_dv_caption_text(registry, "D5/L1/R/1/1700000000000") == "L1-M#1 · 盘整", "D5/completion-redraws-open-movement-in-place")
    chan_dv_clear(registry)
chan_dv_isolation() =>
    ChanState model = chan_new("D4")
    model := chan_step(model, ChanRaw.new(1700000000000, 1700000060000, 0, 5, 0, 5))
    model := chan_step(model, ChanRaw.new(1700000060000, 1700000120000, 3, 8, 3, 8))
    model := chan_step(model, ChanRaw.new(1700000120000, 1700000180000, 1, 6, 1, 6))
    model := chan_step(model, ChanRaw.new(1700000180000, 1700000240000, 0, 4, 0, 4))
    string before = chan_signature(model)
    ChanDrawRegistry registry = chan_draw_new(3)
    chan_draw_put(registry, chan_fractal_spec(model.lastConfirmed, 1, true, color.orange, color.blue, 12, true, false, 3))
    chan_dv_assert(chan_signature(model) == before and chan_draw_count(registry, "label", "") == 1, "D4/real-core-isolation")
    chan_dv_clear(registry)

int spacing = input.int(1, "笔编号间隔", minval=1, maxval=20)
int centerWidth = input.int(2, "中枢边框线宽", minval=1, maxval=5)
bool centerIds = input.bool(true, "显示中枢编号")
int fontSize = input.int(12, "提示字号", minval=8, maxval=24)
int fillAlpha = input.int(90, "中枢透明度", minval=75, maxval=100)
bool detailed = input.bool(false, "研究提示")
var bool passed = false
var ChanDrawRegistry gallery = chan_draw_new(120)
var table result = table.new(position.top_right, 1, 2)
if barstate.isfirst
    chan_dv_quotas()
    chan_dv_degenerate()
    chan_dv_caption()
    chan_dv_isolation()
    chan_dv_movement_types()
    passed := true
if barstate.islast and bar_index >= 20
    ChanVisualStyle style = ChanVisualStyle.new()
    style.strokeLabelStride := spacing
    style.centerWidth := centerWidth
    style.centerTransparency := fillAlpha
    style.fontSize := fontSize
    style.detailed := detailed
    style.l1Color := color.rgb(192, 132, 252)
    // A separate pane and fixed display units avoid suggesting market endpoints.
    int mid = 0
    int step = 10
    float sceneTick = 1.0
    chan_draw_begin(gallery)
    chan_draw_structure(gallery, chan_dv_structure("gallery/P1", 1, true, time[20], time[15], mid + 3 * step, mid + 4 * step), sceneTick, style, true)
    chan_draw_structure(gallery, chan_dv_structure("gallery/P3", 3, true, time[15], time[10], mid + 4 * step, mid + 6 * step), sceneTick, style, true)
    ChanStructure segment = chan_dv_structure("gallery/S1", 1, true, time[20], time[5], mid - step, mid + 2 * step)
    segment.objectType := "segment"
    chan_draw_structure(gallery, segment, sceneTick, style, true)
    chan_draw_structure(gallery, chan_dv_structure("gallery/candidate", 2, false, time[5], time, mid + 2 * step, mid - 2 * step), sceneTick, style, true)
    chan_draw_center(gallery, chan_dv_center("gallery/Z1", time[18], time[4], mid - step, mid + step), sceneTick, style, centerIds)
    ChanCenter degenerate = chan_dv_center("gallery/Z0", time[12], time[2], mid - 4 * step, mid - 4 * step)
    degenerate.ordinal := 2
    chan_draw_center(gallery, degenerate, sceneTick, style, centerIds)
    chan_draw_sweep(gallery)
table.cell(result, 0, 0, passed ? "PASS: D5, 5 cases" : "RUNNING", text_color=color.orange, text_size=fontSize)
table.cell(result, 0, 1, "合成展示 · 非行情识别 · 独立窗格数值无行情价格含义", text_color=color.white, bgcolor=color.rgb(22,27,34), text_size=fontSize)
plot(na)
`;
  const pine=['//@version=6','indicator("缠论显示控制验证（合成图例）",overlay=false,max_lines_count=500,max_boxes_count=500,max_labels_count=500,max_bars_back=30)',core,renderer,driver].join('\n')+'\n';
  return {source:pine,sha256:sha(pine),coreHash:sha(core),rendererHash:sha(renderer),bytes:Buffer.byteLength(pine),cases:5,execution:'not run in Pine'};
}
export function buildDisplayControlsValidation(){
  const source=fs.readFileSync(new URL('chanlun_original.pine',root),'utf8');
  const {source:pine,...result}=generateDisplayControlsValidation(source);
  const output=fileURLToPath(new URL('tmp/chanlun/display-controls-validation.pine',root));fs.writeFileSync(output,pine);
  const manifest={output,productionSha256:sha(source),...result};fs.writeFileSync(output+'.json',JSON.stringify(manifest,null,2)+'\n');return manifest;
}
if(process.argv[1]===fileURLToPath(import.meta.url))console.log(JSON.stringify(buildDisplayControlsValidation(),null,2));
