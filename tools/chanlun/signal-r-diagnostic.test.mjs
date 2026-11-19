import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const production = fs.readFileSync(new URL('../../chanlun_original.pine', import.meta.url), 'utf8');
const chart = production.slice(production.indexOf('// ==================== Chart scheduling'));
const diag = production.slice(production.indexOf('// R endpoint diagnostic (7.1)'), production.indexOf('// ==================== Chart scheduling'));
const code = text => text.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');

// A line-for-line JS model of the two Pine functions, so their meaning is pinned by cases rather than by prose.
// A signal links to a movement when it is a first-class signal whose first dependency is the movement's last centre
// and whose side is opposite to the movement direction (a top is a sell).
function linked(movement, signals) {
  const lastCenter = movement.centerIds.length ? movement.centerIds[movement.centerIds.length - 1] : '';
  if (lastCenter === '') return null;
  return signals.find(s => s.type === 'first' && s.dependencies.length > 0 && s.dependencies[0] === lastCenter && s.side === -movement.direction) ?? null;
}
function verdict(movement, link, dropped) {
  if (link) return link.occurredAt === movement.endTime && link.priceTicks === movement.endTicks ? 'matched' : 'offset';
  return dropped > 0 ? 'unknown' : 'none';
}
const movement = { direction: 1, endTime: 100, endTicks: 50, centerIds: ['Z1', 'Z2'] };
const first = (over = {}) => ({ type: 'first', side: -1, occurredAt: 100, priceTicks: 50, dependencies: ['Z2', 'Z1', 'c5', 'c9'], ...over });

test('the Pine functions say what the model says', () => {
  const fn = diag.slice(diag.indexOf('chan_r_linked_signal('), diag.indexOf('chan_r_verdict_index('));
  for (const part of ['candidate.type == "first"', 'candidate.dependencies.get(0) == lastCenter', 'candidate.side == -movement.direction', 'movement.centerIds.last()', 'linked.occurredAt == movement.endTime and linked.priceTicks == movement.endTicks ? "matched" : "offset"', 'else if owner.dropped > 0', 'verdict := "unknown"']) assert(fn.includes(part), part);
});

test('endpoint verdicts: matched, offset, none, unknown', () => {
  assert.equal(verdict(movement, linked(movement, [first()]), 0), 'matched');
  // Same centre and side but the signal sits on the departure end, not on the R endpoint: the structural offset R-003 describes.
  assert.equal(verdict(movement, linked(movement, [first({ occurredAt: 130, priceTicks: 58 })]), 0), 'offset');
  assert.equal(verdict(movement, linked(movement, [first({ priceTicks: 51 })]), 0), 'offset', 'a different price is not a coincidence');
  assert.equal(verdict(movement, linked(movement, []), 0), 'none');
  assert.equal(verdict(movement, linked(movement, []), 3), 'unknown', 'recycled signals cannot prove absence');
  assert.equal(verdict(movement, linked(movement, [first({ dependencies: ['Z1', 'Z2'] })]), 0), 'none', 'a signal on another centre does not count');
  assert.equal(verdict(movement, linked(movement, [first({ side: 1 })]), 0), 'none', 'a buy cannot confirm a top');
  assert.equal(verdict(movement, linked(movement, [first({ type: 'consolidation-divergence-point' }), first({ type: 'second' })]), 0), 'none', 'only the first class counts');
  assert.equal(verdict({ ...movement, direction: -1, endTicks: 50 }, linked({ ...movement, direction: -1 }, [first({ side: 1 })]), 0), 'matched', 'a bottom is a buy');
  assert.equal(verdict({ ...movement, centerIds: [] }, linked({ ...movement, centerIds: [] }, [first()]), 0), 'none');
});

test('the diagnostic only reads: it assigns neither the engine, the signal runtime nor the movement records', () => {
  const body = code(diag);
  // Field writes (x.y := ...) into the engine, the signal runtime or any movement/signal record are forbidden; plain locals are fine.
  assert(!/\b(engine|signals|completed|movement|owner|linked|candidate)(\.\w+)+\s*(:=|\+=|-=)/.test(body));
  const loop = chart.slice(chart.indexOf('for layerIndex = 1 to levelLimit'), chart.indexOf('// ==================== Last-bar research projection'));
  const writes = [...code(loop).matchAll(/^\s*(\w+(?:\.\w+)*)\s*(?::=|\+=)/gm)].map(match => match[1]);
  // Only locals of the loop; never engine.*, signals.* or a movement field.
  for (const name of writes) assert(!/^(engine|signals|macd|drawings)\b/.test(name), name);
  // The movement is read from the mirror stack of the signal runtime, one per layer, only when it just completed.
  assert(loop.includes('completed := signals.stack.movements.event') && loop.includes('signals.stack.levels.movements2.event') && loop.includes('signals.stack.levels.movements3.event'));
  assert(loop.includes('if not na(completed) and completed.completed'));
  assert(/chan_runtime_update\(engine, incoming, barstate\.isconfirmed\)/.test(chart));
  assert(!/\bengine\.(movements|levels)\.[\w.]*(:=|\.push|\.set)/.test(loop));
});

test('tallies and labels share one index scheme, and nothing is counted on an open bar', () => {
  assert(chart.includes('var array<int> diagCounts = array.new<int>(16, 0)'));
  assert(diag.includes('verdict == "matched" ? 0 : verdict == "offset" ? 1 : verdict == "none" ? 2 : 3'));
  assert(chart.includes('int tally = layerIndex * 4 + chan_r_verdict_index(verdict)'));
  // The status line reads L1 at 4..7, L2 at 8..11, L3 at 12..15.
  const status = chart.slice(chart.indexOf('"\\nR端点 确认/偏移/无/?'));
  for (const [layer, base] of [[1, 4], [2, 8], [3, 12]]) for (let kind = 0; kind < 4; kind += 1) assert(status.includes(`diagCounts.get(${base + kind})`), `L${layer} ${kind}`);
  // The loop sits in the confirmed-frame branch, behind the signal switch.
  const at = chart.indexOf('for layerIndex = 1 to levelLimit');
  assert(at > chart.indexOf('if frame.submitted') && at > chart.indexOf('if signalsOn\n'));
  assert(at < chart.indexOf('// ==================== Last-bar research projection'));
});

test('the label wording follows the spec and the cases are told apart', () => {
  assert(diag.includes('"matched" => "端点已背驰确认"'));
  assert(diag.includes('"offset" => "端点未经背驰确认·末中枢一类点偏移"'));
  assert(diag.includes('"none" => "端点未经背驰确认·末中枢无一类点"'));
  assert(diag.includes('=> "端点未经背驰确认·信号已回收，无法比对"'));
  // A top endpoint draws above the point, a bottom below it; the diagnostic is a research-view projection with its own switch.
  assert(production.includes('"D-diag-top" => label.style_label_down') && production.includes('"D-diag-bottom" => label.style_label_up'));
  assert(chart.includes('if research and showDiagnostic'));
  assert(/^bool showDiagnostic = input\.bool\(true, "研究：显示R端点诊断"/m.test(production));
  assert(diag.includes('不是买卖点；不改变走势完成记录'));
});
