import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {extractCore} from './build-validation.mjs';
import {checkDirectory, validateFixture} from './check-fixtures.mjs';
import {featureStroke} from './feature-validation.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const q=JSON.stringify;
const direction=value=>({waiting:0,up:1,down:-1}[value]);
const rules=new Set(['S-001','S-002','S-003','E-002','E-006']);
const sources=new Set(['C65-168','C67-172','C71-182','C78-198','C81-209','C81-210']);
const array=(type,values)=>values.length?`array.from(${values.join(', ')})`:`array.new<${type}>()`;
export const featureFields=['id','lowTicks','highTicks','lowTime','highTime','firstTime','lastTime','firstOrdinal','lastOrdinal','firstSide','lastSide','availableAt','sealed'];

// Encode the existing independent expectations, without computing containment,
// turns or expected endpoints in JavaScript. Pine runs the exact production CORE.
export function encodeFeatureFixture(fixture){
  assert(fixture.input.kind==='feature-strokes' && fixture.expectationStatus==='reviewed','expected reviewed feature fixture');
  validateFixture(fixture,rules,sources);
  const context=fixture.input.context;
  const initial=`chan_feature_new(${q(fixture.id)}, ${direction(context.segmentDirection)}, ${direction(context.initialDirection)}, ${direction(context.postDirection)}, ${context.boundaryTime??'na'}, ${context.secondSequence}, ${context.maxElements}, ${context.maxSources})`;
  const rows=fixture.expected.map(snapshot=>{
    const state=snapshot.state;
    const features=state.features.map(feature=>`ChanFeature.new(${featureFields.map(field=>q(feature[field])).join(', ')}, ${array('string',feature.sourceIds.map(q))})`);
    return `ChanFVExpected.new(${state.inputCount}, ${state.selectedCount}, ${direction(state.mergeDirection)}, ${state.boundaryCuts}, ${state.waitingDirection}, ${state.blocked}, ${q(state.heldId??'')}, ${{none:0,top:1,bottom:-1}[state.turnKind]}, ${state.gap??false}, ${state.seedEligible}, ${array('ChanFeature',features)})`;
  });
  return {id:fixture.id,fixtureHash:sha(JSON.stringify(fixture)),prefixes:rows.length,initial,inputs:array('ChanStructure',fixture.input.items.map(featureStroke)),rows};
}

const types=`
type ChanFVExpected
    int inputCount
    int selectedCount
    int mergeDirection
    int boundaryCuts
    bool waitingDirection
    bool blocked
    string heldId
    int turnKind
    bool gap
    bool seedEligible
    array<ChanFeature> features

type ChanFVFixture
    string id
    ChanFeatureSequence initial
    array<ChanStructure> inputs
    array<ChanFVExpected> expected

chan_fv_assert(bool condition, string context) =>
    if not condition
        runtime.error("FAIL: " + context)
    true
`;

const checks=`
chan_fv_feature(ChanFeature actual, ChanFeature expected, string context) =>
${featureFields.map(field=>`    chan_fv_assert(actual.${field} == expected.${field}, context + "/${field}")`).join('\n')}
    chan_fv_assert(actual.sourceIds.size() == expected.sourceIds.size(), context + "/source-count")
    for [i, sourceId] in expected.sourceIds
        chan_fv_assert(actual.sourceIds.get(i) == sourceId, context + "/source-" + str.tostring(i))
    true

chan_fv_prefix(ChanFeatureSequence online, ChanFVFixture fixture, int index) =>
    string context = fixture.id + "/prefix-" + str.tostring(index + 1)
    ChanStructure incoming = fixture.inputs.get(index)
    ChanFVExpected expected = fixture.expected.get(index)
    ChanFeatureSequence next = chan_feature_step(online, incoming)
    bool seedEligible = false
    if index >= 2
        seedEligible := chan_segment_seed(fixture.inputs.get(0), fixture.inputs.get(1), fixture.inputs.get(2))
    chan_fv_assert(seedEligible == expected.seedEligible, context + "/segment-seed-eligibility")
    chan_fv_assert(next.inputCount == expected.inputCount, context + "/inputCount")
    chan_fv_assert(next.selectedCount == expected.selectedCount, context + "/selectedCount")
    chan_fv_assert(next.mergeDirection == expected.mergeDirection, context + "/mergeDirection")
    chan_fv_assert(next.boundaryCuts == expected.boundaryCuts, context + "/boundaryCuts")
    chan_fv_assert(next.waitingDirection == expected.waitingDirection, context + "/waitingDirection")
    chan_fv_assert(next.blocked == expected.blocked, context + "/blocked")
    chan_fv_assert(expected.heldId == "" ? na(next.heldInput) : not na(next.heldInput) and next.heldInput.id == expected.heldId, context + "/held-input")
    chan_fv_assert(next.elements.size() == expected.features.size(), context + "/feature-count")
    for [i, feature] in expected.features
        chan_fv_feature(next.elements.get(i), feature, context + "/feature-" + str.tostring(i))
    ChanFeatureTurn turn = chan_feature_turn(next)
    if expected.turnKind == 0
        chan_fv_assert(na(turn), context + "/no-turn")
    else
        chan_fv_assert(not na(turn), context + "/turn-exists")
        chan_fv_assert(turn.kind == expected.turnKind and turn.gap == expected.gap, context + "/turn-kind-gap")
        ChanFeature middle = expected.features.get(expected.features.size() - 2)
        bool top = expected.turnKind == 1
        chan_fv_assert(turn.endpointTime == (top ? middle.highTime : middle.lowTime) and turn.priceTicks == (top ? middle.highTicks : middle.lowTicks), context + "/turn-endpoint")
        ChanFeature leftFeature = expected.features.get(expected.features.size() - 3)
        ChanFeature rightFeature = expected.features.last()
        chan_fv_assert(turn.leftId == leftFeature.id, context + "/turn-leftId")
        chan_fv_assert(turn.middleId == middle.id, context + "/turn-middleId")
        chan_fv_assert(turn.rightId == rightFeature.id, context + "/turn-rightId")
        chan_fv_assert(turn.rightSealed == rightFeature.sealed and turn.availableAt == math.max(leftFeature.availableAt, middle.availableAt, rightFeature.availableAt), context + "/turn-availability")
    ChanFeatureSequence replay = chan_feature_clone(fixture.initial)
    for i = 0 to index
        replay := chan_feature_step(replay, fixture.inputs.get(i))
    chan_fv_assert(chan_feature_signature(next) == chan_feature_signature(replay), context + "/prefix-reload")
    string before = chan_feature_signature(next)
    ChanFeatureSequence copied = chan_feature_clone(next)
    copied := chan_feature_step(copied, incoming)
    chan_fv_assert(chan_feature_signature(copied) == before, context + "/duplicate-input")
    if copied.elements.size() > 0
        ChanFeature tailFeature = copied.elements.last()
        tailFeature.sourceIds.push("copy-probe")
    if not na(copied.lastInput)
        ChanStructure lastStroke = copied.lastInput
        lastStroke.dependencies.push("copy-probe")
    if not na(copied.heldInput)
        ChanStructure heldStroke = copied.heldInput
        heldStroke.dependencies.push("copy-probe")
    chan_fv_assert(chan_feature_signature(next) == before, context + "/deep-copy-isolation")
    chan_fv_assert(fixture.initial.inputCount == 0 and fixture.initial.elements.size() == 0 and na(fixture.initial.lastInput), context + "/initial-isolation")
    next
`;

export function generateFeatureCompact(source,fixtures){
  assert(fixtures.length>0,'no feature fixtures');
  const encoded=fixtures.map(encodeFeatureFixture);
  assert.equal(new Set(encoded.map(f=>f.id)).size,encoded.length,'duplicate feature fixture');
  const core=extractCore(source),loaders=[];
  for(const [index,fixture] of encoded.entries()){
    loaders.push(`chan_fv_case_${index}() =>`, '    array<ChanFVExpected> expected = array.new<ChanFVExpected>()');
    fixture.rows.forEach(row=>loaders.push(`    expected.push(${row})`));
    loaders.push(`    ChanFVFixture.new(${q(fixture.id)}, ${fixture.initial}, ${fixture.inputs}, expected)`);
  }
  loaders.push('chan_fv_load(int caseIndex) =>','    ChanFVFixture loaded = na','    switch caseIndex');
  encoded.forEach((_,i)=>loaders.push(`        ${i} => loaded := chan_fv_case_${i}()`));
  loaders.push('    if na(loaded)','        runtime.error("Unknown feature case")','    loaded');
  const prefixes=encoded.reduce((sum,f)=>sum+f.prefixes,0);
  const expectedDisplay=`PASS: F${encoded.length}, ${prefixes} prefixes`;
  const schedule=`
var int caseIndex = 0
var int prefix = 0
var ChanFVFixture fixture = na
var ChanFeatureSequence online = na
var table result = table.new(position.top_right, 1, 2)
if barstate.isconfirmed and caseIndex < ${encoded.length}
    if prefix == 0
        fixture := chan_fv_load(caseIndex)
        online := chan_feature_clone(fixture.initial)
    online := chan_fv_prefix(online, fixture, prefix)
    prefix += 1
    if prefix == fixture.inputs.size()
        caseIndex += 1
        prefix := 0
table.cell(result, 0, 0, caseIndex == ${encoded.length} ? ${q(expectedDisplay)} : "RUNNING " + str.tostring(caseIndex) + "/${encoded.length}", text_color = caseIndex == ${encoded.length} ? color.green : color.orange)
table.cell(result, 0, 1, "合成笔输入 · 特征序列检查 · 非实际行情划分")
plot(na)
`;
  const pine=['//@version=6','indicator("缠论特征序列精简共享验证", overlay=false)',`// CORE SHA-256: ${sha(core)}`,core,types,loaders.join('\n'),checks,schedule].join('\n')+'\n';
  return {source:pine,sha256:sha(pine),coreHash:sha(core),bytes:Buffer.byteLength(pine),cases:encoded.length,prefixes,expectedDisplay,fixtures:encoded.map(({id,fixtureHash,prefixes})=>({id,fixtureHash,prefixes})),execution:'not run in Pine'};
}

export function buildFeatureCompact(directory=path.join(root,'tmp/chanlun')){
  checkDirectory();
  const input=path.join(root,'tests/fixtures/chanlun');
  const fixtures=fs.readdirSync(input).filter(n=>n.endsWith('.json')).sort().map(n=>JSON.parse(fs.readFileSync(path.join(input,n),'utf8'))).filter(f=>f.input.kind==='feature-strokes');
  const production=fs.readFileSync(path.join(root,'chanlun_original.pine'),'utf8');
  const {source,...result}=generateFeatureCompact(production,fixtures);
  fs.mkdirSync(directory,{recursive:true});
  const output=path.join(directory,'feature-compact-validation.pine');
  fs.writeFileSync(output,source);
  const manifest={output,productionSha256:sha(production),...result};
  fs.writeFileSync(output+'.json',JSON.stringify(manifest,null,2)+'\n');
  return manifest;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(buildFeatureCompact(),null,2));
