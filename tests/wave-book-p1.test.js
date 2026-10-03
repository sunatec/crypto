'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const E=require('../analyze-wave-tree');
const B=require('../wave-book-validation');
const {createSubwaveVerifier}=require('../wave-subwave-verification');
const base=Date.UTC(2025,9,5)/1000;
function points(prices,indices=prices.map((_,i)=>i*10),direction=prices.at(-1)>=prices[0]?'up':'down') {
 return prices.map((price,i)=>({price,index:indices[i],timestamp:base+indices[i]*3600,type:(direction==='up')===(i%2===0)?'L':'H'}));
}
function candles(p) {
 return Array.from({length:p.at(-1).index+1},(_,i)=>{
  let end=p.findIndex(x=>x.index>=i);if(end<0)end=p.length-1;
  const a=p[Math.max(0,end-1)],b=p[end],v=a.index===b.index?b.price:a.price+(b.price-a.price)*(i-a.index)/(b.index-a.index);
  return {index:i,timestamp:base+i*3600,high:v,low:v,open:v,close:v,volume:1};
 });
}
function ctx(prices,indices,direction) {const p=points(prices,indices,direction);return {points:p,candles:candles(p),direction:direction|| (prices.at(-1)>=prices[0]?'up':'down')};}
function rule(builder,id,c) {const r=builder(c.direction).rules.find(r=>r.id===id);assert.ok(r,id);return r.test(c);}
const opts={maxDepth:3,beamK:3,evidenceMode:true,timeframe:'1h'};
// Boundary assertions distinguish strict from inclusive; sources §4.1/§5.4/§6.2/§7.1.
for(const [name,builder,id,prices,expected] of [
 ['C=5B',E.buildZigzagManual,'zigzag.ratio.c-between-0.9b-and-5b',[100,80,90,40],false],
 ['C=.9B U02 handbook default',E.buildZigzagManual,'zigzag.ratio.c-between-0.9b-and-5b',[100,60,80,62],true],
 ['X=W',E.buildDoubleZigzagManual,'zigzag-double.ratio.x-retrace-20-100',[100,60,100,40],false],
 ['Y=X',E.buildDoubleZigzagManual,'zigzag-double.ratio.y-gt-x',[100,60,80,60],false],
 ['Y=5W',E.buildDoubleZigzagManual,'zigzag-double.ratio.y-lt-5w',[300,260,280,80],false],
 ['XX=Y',E.buildTripleZigzagManual,'zigzag-triple.ratio.xx-retrace-20-100',[200,160,180,140,180,120],false],
 ['Z=XX inclusive',E.buildTripleZigzagManual,'zigzag-triple.ratio.z-vs-xx-y-w',[200,160,180,140,160,140],true],
 ['expanded B=A',E.buildExpandedFlatManual,'flat-expanded.ratio.b-gt-a',[100,60,100,50],false],
 ['running B=A',E.buildRunningFlatManual,'flat-running.ratio.b-gt-a',[100,60,100,65],false],
 ['triangle B=2A',E.buildContractingTriangleManual,'triangle.ratio.b-vs-a',[100,80,120,90,110,95],false],
 ['triangle C=B',E.buildContractingTriangleManual,'triangle.ratio.c-vs-b',[100,60,90,60,85,75],false],
 ['triangle D=C inclusive',E.buildContractingTriangleManual,'triangle.ratio.d-vs-c',[100,60,90,70,90,75],true],
 ['triangle E=D',E.buildContractingTriangleManual,'triangle.ratio.e-vs-d',[100,60,90,70,85,70],false],
]) test('书籍开闭边界 '+name,()=>{const r=rule(builder,id,ctx(prices));assert.equal(r.pass,expected);if(!expected)assert.ok(r.overshoot>0);});
test('OV-001: Y=.879W only loses guideline, all own price/path rules can pass',()=>{
 const c=ctx([200,100,140,52.1]);const score=E.scoreCandidate(c,E.buildDoubleZigzagManual('down'));
 assert.equal(score.tier1,0);assert.ok(!score.hits.some(r=>r.id==='zigzag-double.guide.y-gt-0.9w'));
});
test('§1.5 wave 3 second longest remains permitted',()=>{
 const c=ctx([100,150,125,165,155,175]);assert.equal(E.scoreCandidate(c,E.buildImpulseStrictManual('up')).tier1,0);
});
test('§3.16 absolute length valid but percent wave 3 shortest fails',()=>{
 const c=ctx([10,110,60,180,111,351]);assert.equal(rule(E.buildImpulseStrictManual,'impulse.pattern.wave3-not-shortest',c).pass,true);
 assert.equal(rule(E.buildImpulseStrictManual,'impulse.pattern.wave3-percent-not-shortest',c).pass,false);
});
test('§3.8 truncated fifth 70% equality allowed; insufficient fifth fails',()=>{
 for(const [end,pass] of [[155,false],[158,true]])assert.equal(rule(E.buildImpulseStrictManual,'impulse.pattern.truncated-five-min-70-four',ctx([100,120,110,170,130,end])).pass,pass);
});
test('§1.5/§6.20 OHLC interior violations cannot be hidden by legal endpoints',()=>{
 const c=ctx([100,120,110,170,133,165]);c.candles[35].low=115;
 assert.equal(rule(E.buildImpulseStrictManual,'impulse.pattern.wave4-not-cross-wave1',c).pass,false);
 assert.equal(rule(E.buildImpulseStrictManual,'impulse.pattern.wave4-not-cross-wave1',c).overshoot,0.25,'ranking uses the actual OHLC breach');
 c.candles[15].low=99;assert.equal(rule(E.buildImpulseStrictManual,'impulse.pattern.wave2-not-retrace-100',c).pass,false);
 assert.equal(rule(E.buildImpulseStrictManual,'impulse.pattern.wave2-not-retrace-100',c).overshoot,0.05);
});
test('§6.4/§5.1/§4.5 role restrictions preserve permitted special cases',()=>{
 const roles=id=>E.PATTERNS.find(p=>p.id===id).childRoles;
 for(const id of ['impulse-strict','diagonal-leading','diagonal-ending','diagonal-ending-expanding'])assert.equal(E.roleAllows(roles(id)[1],'triangle'),false);
 for(const i of [0,1])assert.equal(E.roleAllows(roles('flat')[i],'triangle'),false);
 assert.equal(E.roleAllows(roles('triangle')[1],'flat'),false);assert.equal(E.roleAllows(roles('triangle')[1],'zigzag-double'),true);
 assert.equal(E.roleAllows(roles('triangle')[4],'flat'),false);assert.equal(E.roleAllows(roles('triangle')[4],'triangle'),true);
 assert.equal(E.roleAllows(roles('sideways-double')[0],'triangle'),false);assert.equal(E.roleAllows(roles('sideways-double')[2],'triangle'),true);
});
test('§6.6 actual AC/BD geometry: contracting passes, parallel/horizontal AC or early apex fail',()=>{
 const c=ctx([100,60,90,70,85,81]);assert.equal(E.scoreCandidate(c,E.buildContractingTriangleManual('down')).tier1,0);
 assert.equal(B.triangleGeometry(points([100,60,100,60,100,60])).pass,false);
 assert.equal(B.triangleGeometry(points([100,60,90,60,85,75])).pass,false);
 const p=points([100,60,90,70,85,81]);p[5].timestamp+=20*3600;assert.equal(B.triangleGeometry(p).pass,false);
});
test('§6.14 C/D excursion uses C gross; E uses D gross; A unrestricted',()=>{
 const c=ctx([100,60,90,70,85,81]);
 // At hour 25 the upper BD rail is 88.75. 10% C gross (20) permits 2.
 c.candles[25].high=90.75;assert.equal(rule(E.buildContractingTriangleManual,'triangle.pattern.path-c',c).pass,true);
 c.candles[25].high=90.84;assert.equal(rule(E.buildContractingTriangleManual,'triangle.pattern.path-c',c).pass,false);
 c.candles[25].high=80; // E at hour45: BD=83.75, allowed 1.5 (D gross=15).
 c.candles[45].high=85.25;assert.equal(rule(E.buildContractingTriangleManual,'triangle.pattern.path-e',c).pass,true);
 c.candles[45].high=85.26;assert.equal(rule(E.buildContractingTriangleManual,'triangle.pattern.path-e',c).pass,false);
});
function candidate(id,prices,direction='down') {return {patternId:id,direction,points:points(prices,undefined,direction),score:{tier1:0,verificationStatus:'pending'},children:[],manual:E.PATTERNS.find(p=>p.id===id).build(direction)};}
const node=c=>({primary:c,isLeaf:false,alternates:[]});
test('§4.1/§5.3 adopted A/C truncation and flat C5 constraints',()=>{
 const a=candidate('impulse-strict',[200,180,190,150,170,155]),c=candidate('impulse-strict',[160,140,150,110,130,115]);
 assert.ok(B.parentChildIssues('zigzag',[node(a),{},node(c)]).some(r=>r.id.includes('not-both-truncated')));
 assert.ok(B.parentChildIssues('flat',[{}, {},node(c)]).some(r=>r.id.includes('c5-not-truncated')));
 assert.equal(B.isTruncated(candidate('zigzag',[100,60,80,61])),false,'short C is not automatically a truncated fifth');
});
test('§7.1 W/Y C failure and §6.2 triangle 105% constraints',()=>{
 const w=candidate('zigzag',[100,60,80,61]);assert.ok(B.parentChildIssues('zigzag-double',[node(w),{},{}]).length);
 const a=candidate('flat',[60,70,59,75],'up');assert.ok(B.parentChildIssues('triangle',[node(a),{},{},{},{}]).some(r=>r.id.includes('second-lt-105')));
});
test('§6.8 EE cannot recursively be triangle and cache respects context',()=>{
 const c=ctx([100,60,90,70,85,81]);const options={...opts,cache:new Map()};
 const yes=E.decompose(c.points,c.candles,['triangle'],0,options);assert.ok(yes.primary);
 const no=E.decompose(c.points,c.candles,['triangle'],0,{...options,forbidTriangle:true});assert.equal(no.isLeaf,true);
 const ee=candidate('triangle',[81,78,80,78.5,79.5,79],'down'),e=candidate('triangle',[90,80,87,82,86,84],'down');e.children=[{},{},{},{},node(ee)];
 assert.ok(B.parentChildIssues('triangle',[{},{},{},{},node(e)]).some(r=>r.id.includes('ee-not-triangle')));
});
test('§7.1 triple Z versus X simultaneous price/time bound',()=>{
 const c=ctx([300,200,210,150,200,100],[0,10,11,12,13,24]);assert.equal(rule(E.buildTripleZigzagManual,'zigzag-triple.time.z-not-both-5x',c).pass,false);
});
test('§7.4 full Y path crossing 0-X invalidates despite passing endpoints',()=>{
 const c=ctx([200,100,140,52]);assert.equal(rule(E.buildDoubleZigzagManual,'zigzag-double.pattern.y-inside-0x',c).pass,true);
 c.candles[25].high=145;assert.equal(rule(E.buildDoubleZigzagManual,'zigzag-double.pattern.y-inside-0x',c).pass,false);
});
test('§4.6 expanding ending candidate retained but missing chapter cannot verify it',()=>{
 const c=ctx([200,150,180,120,160,90]);const t=E.decompose(c.points,c.candles,['impulse|ending'],0,{...opts,cache:new Map()});
 const expanded=[t.primary,...t.alternates].find(p=>p.patternId==='diagonal-ending-expanding');assert.ok(expanded);assert.equal(expanded.score.tier1,0);assert.equal(expanded.score.verificationStatus,'pending');assert.ok(expanded.sourceLimitations.length);
 assert.equal(E.roleAllows('impulse|leading','diagonal-ending-expanding'),false);
});
test('§7.2 wave degree and recursion depth are different for Y/Z',()=>{
 const c=ctx([200,160,180,140,160,120]);const t=E.decompose(c.points,c.candles,['zigzag-triple'],0,{...opts,cache:new Map()});const j=E.serializeTree(t);
 assert.deepEqual(j.children.map(c=>c.degree),[1,1,2,2,3]);assert.deepEqual(j.children.map(c=>c.recursionDepth),[1,1,1,1,1]);
});
test('F12 own clean rules and unknown children prove zero direct roles',()=>{
 const c=ctx([100,80,90,50,70,30]);const t=E.decompose(c.points,c.candles,['impulse'],0,{...opts,maxDepth:1,cache:new Map()});
 assert.equal(t.primary.score.provenRoles,0);assert.equal(t.primary.score.requiredRoles,5);assert.equal(t.primary.score.pendingRatio,1);assert.equal(t.primary.score.verificationStatus,'pending');
});
function resolvedHours(){
 const legs=[[100,94,97,84,88,80],[80,85,83,90],[90,78,84,57,66,50],[50,60,55,70],[70,58,64,37,46,30]];
 const prices=[...legs[0],...legs.slice(1).flatMap(a=>a.slice(1))];
 const p=points([95,...prices,40],[0,...prices.map((_,i)=>2+i*2),47],'down');return candles(p);
}
test('F10 real hourly route terminates with identified direct substructures and explicit scope',()=>{
 const hourly=resolvedHours(),v=createSubwaveVerifier(E,{hourly});
 const from={timestamp:base,index:0,type:'H',price:100},to={timestamp:base+86400,index:1,type:'L',price:30};
 const result=E.evaluateLegRole([from,to],'impulse',[],0,{...opts,timeframe:'1d',verification:v,cache:new Map()},'a');
 assert.equal(result.evidence.status,'verified');assert.equal(result.node.primary.patternId,'impulse-strict');assert.equal(result.node.primary.timeframe,'1h');
 assert.equal(result.node.primary.score.provenRoles,5);assert.equal(result.node.primary.score.requiredRoles,5);
 const j=E.serializeTree(result.node);assert.equal(j.verificationScope.kind,'bounded');assert.equal(j.completionStatus,'potentially_complete');
 assert.ok(j.children.every(c=>c.verificationStatus==='verified' && c.verificationScope.exemptedRoles.length));
 assert.ok(j.children.flatMap(c=>c.children).every(c=>c.verificationStatus==='pending' && c.resolutionBoundary));
 assert.equal(j.children[0].degree,1);assert.equal(from.index,0);assert.equal(to.index,1);
});
test('F10 gaps or exhaustion remain pending even with explicit resolution policy',()=>{
 const c=ctx([100,80,90,50,70,30]);c.candles[12].timestamp+=3600;
 const t=E.decompose(c.points,c.candles,['impulse'],0,{...opts,maxDepth:1,finestResolution:'1h',cache:new Map()});assert.equal(t.primary.score.verificationStatus,'pending');
 const bad=resolvedHours().filter(c=>c.index!==20);const v=createSubwaveVerifier(E,{hourly:bad});assert.equal(v.evaluate({timestamp:base,type:'H',price:100},{timestamp:base+86400,type:'L',price:30},'impulse').status,'pending');
});
test('F11 four states, no completion from Fibonacci or temporary endpoints',()=>{
 const c=candidate('zigzag',[100,60,80,40]);assert.equal(B.completion(c),'potentially_complete');
 c.points.at(-1).provisional=true;assert.equal(B.completion(c),'forming');delete c.points.at(-1).provisional;
 c.score.tier1=1;assert.equal(B.completion(c),'invalidated');c.score.tier1=0;c.score.verificationStatus='verified';
 assert.equal(B.completion(c),'potentially_complete');c.completionEvidence={confirmed:true,policy:'explicit-observation'};assert.equal(B.completion(c),'confirmed_complete');
});
test('F11 deferred score changes actual ranking; upper bounds and historic Y stay failed',()=>{
 const c=ctx([100,60,80,75]);c.points.at(-1).provisional=true;const m=E.buildZigzagManual('down'),score=E.scoreCandidate(c,m);
 const adjusted=E.applyInProgressRuleGate({...c,manual:m,score},c.candles);assert.equal(adjusted.tier1,0);assert.equal(adjusted.tier2,0);assert.equal(adjusted.verificationStatus,'pending');assert.ok(adjusted.deferred.length);assert.ok(E.compareCandidates(adjusted,score)<0);
 const t=E.decompose(c.points,c.candles,['zigzag'],0,{...opts,maxDepth:1,cache:new Map()});assert.equal(t.primary.score.tier1,0);assert.equal(E.serializeRankedCounts(t)[0].score.tier1,0);
 const z=ctx([100,60,90,70,80,75]);z.points.at(-1).provisional=true;const zm=E.buildTripleZigzagManual('down');
 const a=E.applyInProgressRuleGate({...z,manual:zm,score:E.scoreCandidate(z,zm)},z.candles);assert.ok(a.failed.some(r=>r.id==='zigzag-triple.ratio.y-gt-x'));assert.ok(a.deferred.some(r=>r.id==='zigzag-triple.ratio.z-vs-xx-y-w'));
});
test('F13 parent combination cannot rename current actual impulse labels as WXY',()=>{
 const current=candidate('impulse-strict',[30,40,35,60,45,70],'up');const tree={primary:candidate('zigzag',[100,60,80,30]),inProgressStruct:{upTree:node(current),swingExtreme:current.points.at(-1),structUp:true,invalidation:30,pullback:{to:{price:55}}}};
 const j=E.deriveCurrentInternal(tree,'X','1d');assert.deepEqual(j.legs.slice(0,5).map(l=>l.name),['1','2','3','4','5']);assert.equal(j.currentLegName,'未定回撤');
 const md=E.renderCurrentInternalNote(tree,'1d');assert.ok(!md.includes('这一层改用'));assert.ok(md.includes('未定回撤'));
 const parent=E.deriveParentDegree({...tree,primary:candidate('zigzag-double',[100,60,80,30])});assert.equal(parent.all.find(c=>c.key==='combination').hardOk,false);
});
test('§4.7 short C retained by default full pipeline (potential, not proved)',()=>{
 const c=ctx([100,60,80,61]);const tree=E.buildCountTree(c.points,c.candles,opts);
 assert.ok(tree.primary);assert.equal(tree.primary.patternId,'zigzag');assert.equal(tree.primary.points.at(-1).price,61);assert.equal(tree.primary.score.verificationStatus,'pending');
});
function checkedCandidate(id,prices,direction='down') {
 const c=ctx(prices,undefined,direction),m=E.PATTERNS.find(p=>p.id===id).build(direction),score=E.scoreCandidate(c,m);
 assert.equal(score.tier1,0,'test child has valid own book rules: '+id);
 const value={patternId:id,klass:E.PATTERNS.find(p=>p.id===id).klass,direction,points:c.points,manual:m,children:[],evidence:[],score:{...score,verificationStatus:'pending'}};
 Object.defineProperty(value,'validationCandles',{value:c.candles});return value;
}
test('F05 actual role evaluation adopts a compatible C instead of rejecting a greedy diagonal pair',()=>{
 const a=checkedCandidate('diagonal-leading',[200,150,180,140,160,135]);
 const c=checkedCandidate('diagonal-ending',[180,140,160,130,145,125]);
 const alternate=checkedCandidate('impulse-strict',[180,160,170,130,150,125]);
 const b=checkedCandidate('zigzag',[135,155,148,180],'up');
 const nodes=[node(a),node(b),{...node(c),alternates:[alternate]}];let i=0;
 const v={evaluate:()=>({status:'pending',attempts:[],adoptedNode:nodes[i++],reason:'identified own shape, finer roles pending'})};
 const pat=E.PATTERNS.find(p=>p.id==='zigzag');
 const ev=E.evaluateChildRoles(pat,nodes.map(n=>[n.primary.points[0],n.primary.points.at(-1)]),[],0,{...opts,maxDepth:1,verification:v});
 assert.equal(ev.violations,0);assert.equal(ev.children[2].primary.patternId,'impulse-strict');assert.equal(ev.evidence[2].adoptedPatternId,'impulse-strict');assert.equal(ev.provenRoles,0);
});
test('F05 actual flat role evaluation chooses non-truncated C from compatible alternatives',()=>{
 const a=checkedCandidate('zigzag',[200,180,190,160]),b=checkedCandidate('zigzag',[160,180,170,195],'up');
 const c=checkedCandidate('impulse-strict',[195,180,188,145,170,150]),alternate=checkedCandidate('impulse-strict',[195,180,188,152,170,150]);
 assert.equal(B.isTruncated(c),true);assert.equal(B.isTruncated(alternate),false);
 const nodes=[node(a),node(b),{...node(c),alternates:[alternate]}];let i=0;
 const ev=E.evaluateChildRoles(E.PATTERNS.find(p=>p.id==='flat'),nodes.map(n=>[n.primary.points[0],n.primary.points.at(-1)]),[],0,{...opts,maxDepth:1,verification:{evaluate:()=>({status:'pending',attempts:[],adoptedNode:nodes[i++]})}});
 assert.equal(ev.violations,0);assert.equal(B.isTruncated(ev.children[2].primary),false);assert.ok(ev.evidence[2].selection);assert.equal(ev.pendingRoles,3);
});
test('F10 unclosed endpoint hour is not accepted as verified evidence',()=>{
 const v=createSubwaveVerifier(E,{hourly:resolvedHours(),endTs:base+44*3600+60});
 assert.equal(v.evaluate({timestamp:base,type:'H',price:100},{timestamp:base+86400,type:'L',price:30},'impulse').status,'pending');
});
test('F12 bounded hourly scope survives adoption into a daily parent with unresolved siblings',()=>{
 const hours=resolvedHours().slice(0,45);
 const anchors=[[44,30],[48,45],[51,38],[54,60],[60,45],[66,52],[75,20],[83,30],[90,10],[95,22]];
 for(let i=45;i<96;i++) {
  const k=anchors.findIndex(([h])=>h>=i),[a,x]=anchors[k-1],[b,y]=anchors[k];
  const value=x+(y-x)*(i-a)/(b-a);hours.push({index:i,timestamp:base+i*3600,open:value,close:value,high:value,low:value,volume:1});
 }
 const cs=E.transformCandles(hours,E.TIMEFRAMES['1d']).map((c,index)=>({...c,index}));
 const p=[100,30,60,10].map((price,index)=>({price,index,timestamp:base+index*86400,type:index%2?'L':'H'}));
 const verifier=createSubwaveVerifier(E,{hourly:hours});
 const tree=E.decompose(p,cs,['zigzag'],0,{...opts,timeframe:'1d',verification:verifier,cache:new Map()});
 assert.equal(tree.primary.score.verificationStatus,'pending');assert.equal(tree.primary.evidence[0].status,'verified');
 assert.equal(tree.primary.children[0].primary.timeframe,'1h');assert.equal(tree.primary.verificationScope.kind,'bounded');assert.equal(tree.primary.verificationScope.finestTimeframe,'1h');
 assert.equal(E.serializeTree(tree).completionStatus,'potentially_complete');
 assert.match(E.renderRankedCounts(tree),/截至1小时线/);
});
test('F08 shared pivot candle wick order stays pending; later candle breach remains hard failure',()=>{
 const c=ctx([100,120,110,170,133,165]);c.candles[30].low=115;
 const result=rule(E.buildImpulseStrictManual,'impulse.pattern.wave4-not-cross-wave1',c);
 assert.equal(result.undetermined,true);
 const score=E.scoreCandidate(c,E.buildImpulseStrictManual('up'));assert.equal(score.tier1,0);assert.equal(score.pendingRules.length,2);
 assert.ok(score.pendingRules.some(r=>r.id==='impulse.pattern.truncated-five-min-70-four'));
 c.candles[31].low=119;assert.equal(rule(E.buildImpulseStrictManual,'impulse.pattern.wave4-not-cross-wave1',c).undetermined,undefined);
 const failed=E.scoreCandidate(c,E.buildImpulseStrictManual('up'));assert.equal(failed.tier1,2);
 assert.deepEqual(failed.failed.map(r=>r.id).sort(),['impulse.pattern.truncated-five-min-70-four','impulse.pattern.wave4-not-cross-wave1']);
});
test('F08 adopted lower-frame path resolves ambiguous daily wave-4 start candle independently of subrole proof',()=>{
 const p=[100,120,110,170,133,165].map((price,index)=>({price,index,timestamp:base+index*86400,type:index%2?'H':'L'}));
 const cs=p.map(point=>({index:point.index,timestamp:point.timestamp,high:point.price,low:point.price,close:point.price,open:point.price,volume:1}));cs[3].low=115;
 const cp=points([170,145,158,133],[74,84,94,100],'down'),cc=candles(cp),m=E.buildZigzagManual('down');
 const child={patternId:'zigzag',timeframe:'1h',direction:'down',points:cp,manual:m,children:[],evidence:[],score:{...E.scoreCandidate({points:cp,candles:cc,direction:'down'},m),verificationStatus:'pending'}};
 Object.defineProperty(child,'validationCandles',{value:cc});let count=0;
 const v={evaluate:()=>({status:'pending',attempts:[],adoptedNode:count++===3?node(child):undefined})};
 const tree=E.decompose(p,cs,['impulse'],0,{...opts,timeframe:'1d',maxDepth:1,verification:v,cache:new Map()});
 assert.equal(tree.primary.score.pendingRules.length,0);assert.equal(tree.primary.score.tier1,0);assert.equal(tree.primary.score.verificationStatus,'pending');assert.equal(tree.primary.children[3].primary.timeframe,'1h');
});

test('F08 percentage comparison cannot pass from an ambiguously inflated wave-3 start candle',()=>{
 const c=ctx([10,110,60,180,111,351]);c.candles[20].high=280;
 const r=rule(E.buildImpulseStrictManual,'impulse.pattern.wave3-percent-not-shortest',c);
 assert.equal(r.undetermined,true);assert.equal(r.pass,false);
 c.candles[21].high=280;
 const resolved=rule(E.buildImpulseStrictManual,'impulse.pattern.wave3-percent-not-shortest',c);
 assert.equal(resolved.undetermined,undefined);assert.equal(resolved.pass,true);
});

test('§6.20 wave 4 must avoid the full wave-1 territory, including an orthodox ending below its highest subwave',()=>{
 const c=ctx([100,120,110,170,133,175]);
 assert.equal(rule(E.buildImpulseStrictManual,'impulse.pattern.wave4-not-cross-wave1',c).pass,true);
 c.candles[5].high=135;
 const failed=rule(E.buildImpulseStrictManual,'impulse.pattern.wave4-not-cross-wave1',c);
 assert.equal(failed.pass,false);assert.equal(failed.overshoot,0.1);
 c.candles[5].high=110;c.candles[0].high=135;
 assert.equal(rule(E.buildImpulseStrictManual,'impulse.pattern.wave4-not-cross-wave1',c).undetermined,true);
});
