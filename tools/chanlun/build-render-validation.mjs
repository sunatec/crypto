import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractCore, extractSection } from './build-validation.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const hash = source => crypto.createHash('sha256').update(source).digest('hex');
export function generateRenderValidation(production) {
  const core = extractCore(production);
  const renderer = extractSection(production, 'RENDERER');
  const driver = `
chan_render_assert(bool condition, string context) =>
    if not condition
        runtime.error("RENDER FAIL: " + context)
    true

chan_scene_structure(string id, string kind, int number, int x1, int x2, int y1, int y2, bool confirmed) =>
    ChanStructure source = ChanStructure.new()
    source.id := id
    source.objectType := kind
    source.ordinal := number
    source.level := 0
    source.direction := y2 > y1 ? 1 : -1
    source.startTime := x1
    source.endTime := x2
    source.startTicks := y1
    source.endTicks := y2
    source.confirmed := confirmed
    source.confirmedAt := confirmed ? x2 : na
    source.ruleId := "SYNTHETIC-DISPLAY-ONLY"
    source.dependencies := array.from("synthetic-source")
    source

chan_scene_center(string id, int level, int number, int x1, int x2, int lowTicks, int highTicks, bool confirmed) =>
    ChanCenter source = ChanCenter.new()
    source.id := id
    source.level := level
    source.ordinal := number
    source.startTime := x1
    source.formedAt := x1
    source.extentEndTime := x2
    source.coreLowTicks := lowTicks
    source.coreHighTicks := highTicks
    source.confirmedAt := confirmed ? x1 : na
    source.degenerate := lowTicks == highTicks
    source.ruleId := "SYNTHETIC-DISPLAY-ONLY"
    source.dependencies := array.from("synthetic-source")
    source

chan_scene_movement(string id, int level, int x1, int x2, int y1, int y2, string morphology, bool completed) =>
    ChanMovement source = ChanMovement.new()
    source.id := id
    source.ordinal := 1
    source.level := level
    source.direction := y2 > y1 ? 1 : -1
    source.startTime := x1
    source.endTime := x2
    source.startTicks := y1
    source.endTicks := y2
    source.morphology := morphology
    source.completed := completed
    source.confirmedAt := completed ? x2 : na
    source.completionProof := completed ? "SYNTHETIC-DISPLAY-ONLY" : ""
    source.ruleId := "SYNTHETIC-DISPLAY-ONLY"
    source

chan_scene_check_movement(ChanDrawRegistry gallery, string id, string expectedCaption, bool candidate) =>
    int lineIndex = chan_draw_index(gallery, id + "/line")
    int captionIndex = chan_draw_index(gallery, id + "/caption")
    chan_render_assert(lineIndex >= 0 and captionIndex >= 0, id + "/objects")
    ChanDrawing drawnLine = gallery.records.get(lineIndex)
    ChanDrawing caption = gallery.records.get(captionIndex)
    chan_render_assert(drawnLine.ephemeral == candidate and caption.ephemeral == candidate, id + "/candidate-lifecycle")
    chan_render_assert(label.get_text(caption.labelId) == expectedCaption, id + "/morphology-caption")

string mode = input.string("普通", "展示视图", options = ["普通", "研究"])
int fontSize = input.int(12, "提示字号", minval = 8, maxval = 24)
int fillAlpha = input.int(90, "中枢透明度", minval = 75, maxval = 100)
int strokeWidth = input.int(1, "笔线宽", minval = 1, maxval = 2)
color strokeColor = input.color(color.blue, "笔颜色")
color segmentColor = input.color(color.orange, "段颜色")
color l1Color = input.color(color.purple, "L1颜色")
color l2Color = input.color(color.teal, "L2颜色")
color l3Color = input.color(color.red, "L3颜色")
var ChanDrawRegistry gallery = chan_draw_new(120)
var table result = table.new(position.top_left, 1, 3)
if barstate.islast and bar_index >= 40
    ChanVisualStyle style = ChanVisualStyle.new()
    style.fontSize := fontSize
    style.centerTransparency := fillAlpha
    style.strokeWidth := strokeWidth
    style.segmentWidth := strokeWidth + 1
    style.movementWidth := strokeWidth + 2
    style.strokeColor := strokeColor
    style.segmentColor := segmentColor
    style.l1Color := l1Color
    style.l2Color := l2Color
    style.l3Color := l3Color
    style.detailed := mode == "研究"
    int a = time[40]
    int b = time[30]
    int c = time[20]
    int d = time[10]
    int e = time
    int mid = 10
    int step = 1
    float displayTick = 1.0
    // Small scratch quotas test eviction before allocation and primitive transitions.
    ChanDrawRegistry scratch = chan_draw_new(3)
    scratch.maxLines := 2
    scratch.maxBoxes := 2
    for i = 0 to 5
        chan_draw_put(scratch, ChanDrawSpec.new("stress/" + str.tostring(i), "stress", "label", a, a, mid, mid, color.gray, 1, true, "synthetic", "", fontSize, 100, false, 120))
    chan_render_assert(chan_draw_count(scratch, "label", "") == 3, "global-label-budget")
    chan_draw_put(scratch, ChanDrawSpec.new("group/1", "small-group", "line", a, b, mid, mid, color.gray, 1, true, "", "", fontSize, 100, false, 1))
    chan_draw_put(scratch, ChanDrawSpec.new("group/2", "small-group", "line", b, c, mid, mid, color.gray, 1, true, "", "", fontSize, 100, false, 1))
    chan_render_assert(chan_draw_index(scratch, "group/1") == -1 and chan_draw_index(scratch, "group/2") >= 0, "oldest-group-eviction")
    chan_draw_put(scratch, ChanDrawSpec.new("mutable", "mutable", "box", a, b, mid, mid + step, color.gray, 1, true, "", "", fontSize, 90, true, 2))
    chan_draw_put(scratch, ChanDrawSpec.new("mutable", "mutable", "box", a, b, mid, mid, color.gray, 1, true, "", "", fontSize, 90, true, 2))
    chan_render_assert(scratch.records.get(chan_draw_index(scratch, "mutable")).primitive == "line" and chan_draw_count(scratch, "box", "") == 0, "degenerate-box-shares-line-budget")
    chan_draw_begin(scratch)
    chan_draw_sweep(scratch)
    chan_render_assert(chan_draw_index(scratch, "mutable") == -1 and chan_draw_index(scratch, "group/2") >= 0, "candidate-sweep-preserves-confirmed")
    while scratch.records.size() > 0
        chan_draw_delete(scratch, scratch.records.size() - 1)
    chan_render_assert(chan_draw_count(scratch, "", "") == 0, "registry-cleanup")
    // Exercise the real K/F core and verify display adapters leave its state intact.
    ChanState model = chan_new("synthetic-render-check")
    model := chan_step(model, ChanRaw.new(a, b, mid, mid + 5 * step, mid, mid + 5 * step))
    model := chan_step(model, ChanRaw.new(b, c, mid + 3 * step, mid + 8 * step, mid + 3 * step, mid + 8 * step))
    model := chan_step(model, ChanRaw.new(c, d, mid + step, mid + 6 * step, mid + step, mid + 6 * step))
    model := chan_step(model, ChanRaw.new(d, e, mid, mid + 4 * step, mid, mid + 4 * step))
    string before = chan_signature(model)
    chan_draw_begin(gallery)
    chan_draw_put(gallery, chan_fractal_spec(model.lastConfirmed, displayTick, true, color.orange, color.blue, fontSize, style.detailed, false, 120))
    chan_draw_structure(gallery, chan_scene_structure("scene/P1", "stroke", 1, a, b, mid - 8 * step, mid, true), displayTick, style, true)
    chan_draw_structure(gallery, chan_scene_structure("scene/P2", "stroke", 2, c, e, mid + 6 * step, mid + 2 * step, false), displayTick, style, true)
    chan_draw_center(gallery, chan_scene_center("scene/Z1", 1, 1, b, d, 62, 67, true), displayTick, style, true)
    chan_draw_center(gallery, chan_scene_center("scene/Z2", 2, 1, b, d, 44, 48, false), displayTick, style, true)
    chan_draw_center(gallery, chan_scene_center("scene/Z3", 3, 1, a, b, 29, 29, true), displayTick, style, true)
    chan_draw_movement(gallery, chan_scene_movement("scene/M1", 1, a, d, 60, 70, "consolidation", true), displayTick, style, true)
    chan_draw_movement(gallery, chan_scene_movement("scene/M2", 2, a, d, 42, 50, "", false), displayTick, style, true)
    chan_draw_movement(gallery, chan_scene_movement("scene/M3", 3, a, d, 34, 25, "downtrend", true), displayTick, style, true)
    chan_scene_check_movement(gallery, "scene/M1", "L1-M#1 · 盘整", false)
    chan_scene_check_movement(gallery, "scene/M2", "L2-M#1 · 待定 · 进行中", true)
    chan_scene_check_movement(gallery, "scene/M3", "L3-M#1 · 下跌", false)
    // Exercise real feature extraction from a synthetic locked-stroke stream.
    ChanFeatureSequence features = chan_feature_new("scene/features", 1, 0, 0, na, false, 12, 32)
    ChanSegmentState segmentModel = chan_segment_new("scene/S-core", 64, 8192)
    array<int> points = array.from(0, 10, 5, 14, 9, 12, 6)
    for i = 0 to 5
        ChanStructure featureInput = chan_scene_structure("scene/feature-P" + str.tostring(i + 1), "stroke", i + 1, time[18 - i * 2], time[16 - i * 2], mid + (points.get(i) - 6) * step, mid + (points.get(i + 1) - 6) * step, true)
        featureInput.confirmedAt := time[14 - i * 2]
        features := chan_feature_step(features, featureInput)
        segmentModel := chan_segment_step(segmentModel, featureInput)
    chan_render_assert(features.selectedCount == 3 and features.elements.size() == 3, "real-feature-extraction")
    ChanFeatureTurn featureTurn = chan_feature_turn(features)
    chan_render_assert(not na(featureTurn) and featureTurn.kind == 1 and not featureTurn.gap, "real-feature-turn")
    string featureBefore = chan_feature_signature(features)
    if style.detailed
        chan_draw_features(gallery, features, displayTick, style)
    chan_render_assert(chan_feature_signature(features) == featureBefore, "feature-rendering-does-not-mutate-core")
    chan_render_assert(segmentModel.segmentCount == 1 and not na(segmentModel.lastSegment) and not na(segmentModel.candidate), "real-segment-extraction")
    chan_render_assert(segmentModel.lastSegment.endTime == time[12] and segmentModel.lastSegment.endTicks == mid + 8 * step and segmentModel.lastSegment.confirmedAt == time[4], "real-segment-endpoint-confirmation")
    string segmentBefore = chan_segment_signature(segmentModel)
    chan_draw_structure(gallery, segmentModel.lastSegment, displayTick, style, true)
    chan_draw_structure(gallery, segmentModel.candidate, displayTick, style, true)
    chan_render_assert(chan_segment_signature(segmentModel) == segmentBefore, "segment-rendering-does-not-mutate-core")
    chan_draw_sweep(gallery)
    chan_render_assert(chan_signature(model) == before, "rendering-does-not-mutate-core")
    chan_render_assert(chan_draw_count(gallery, "label", "") <= 120 and chan_draw_count(gallery, "line", "") <= 450 and chan_draw_count(gallery, "box", "") <= 450, "gallery-within-global-budgets")
    table.cell(result, 0, 0, "合成展示样例 · 非行情分析", text_color = color.orange, bgcolor = color.rgb(22,27,34), text_size = 14)
    table.cell(result, 0, 1, "MV3 PASS · " + mode + "视图", text_color = color.white, bgcolor = color.rgb(22,27,34), text_size = 14)
    table.cell(result, 0, 2, "显示单位为合成数值 · 核对层次、虚实线和填充", text_color = color.white, bgcolor = color.rgb(22,27,34), text_size = 12)
plot(na)
`;
  assert(!driver.includes('request.security'), 'display fixture must stay on current chart');
  return {
    source: `//@version=6\nindicator("缠论走势展示验证（合成图例）", "MV3", overlay = false, max_lines_count = 500, max_boxes_count = 500, max_labels_count = 500, max_bars_back = 100)\n// Core SHA-256: ${hash(core)}\n// Renderer SHA-256: ${hash(renderer)}\n${core}\n${renderer}\n${driver}`,
    coreHash: hash(core), rendererHash: hash(renderer),
  };
}
export function buildRenderValidation(output = path.join(root, 'tmp/chanlun/render-validation.pine')) {
  const production = fs.readFileSync(path.join(root, 'chanlun_original.pine'), 'utf8');
  const result = generateRenderValidation(production);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, result.source);
  const manifest = { output, sha256: hash(result.source), productionSha256: hash(production), coreHash: result.coreHash, rendererHash: result.rendererHash, data: 'synthetic display fixtures, not market structures', expected: 'MV3 PASS', execution: 'not run; compile and inspect both views in TradingView' };
  fs.writeFileSync(output + '.json', JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(buildRenderValidation(process.argv[2]), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
