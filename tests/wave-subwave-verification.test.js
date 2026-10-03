'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const E=require('../analyze-wave-tree');
const {createSubwaveVerifier,buildVerifiedCountTree}=require('../wave-subwave-verification');
const day=86400, base=Date.UTC(2025,9,5)/1000;
function sampleHours(){
  const anchors=[[0,95],[2,100],[7,80],[10,90],[22,50],[28,70],[44,30],[47,40]];
  return Array.from({length:48},(_,i)=>{
    const j=anchors.findIndex(([h])=>h>=i);const [h1,v1]=anchors[Math.max(0,j-1)], [h2,v2]=anchors[j];
    const value=h1===h2?v2:v1+(v2-v1)*(i-h1)/(h2-h1);
    return {timestamp:base+i*3600,open:value,close:value,high:value,low:value,volume:1};
  });
}
const from={timestamp:base,index:0,type:'H',price:100};
const to={timestamp:base+day,index:1,type:'L',price:30};
test('daily endpoint buckets locate actual hours, fix prices, share role-window cache',()=>{
  const v=createSubwaveVerifier(E,{hourly:sampleHours()});
  const a=v.evaluate(from,to,'impulse|ending');
  assert.equal(a.located.fromTimestamp,base+2*3600);
  assert.equal(a.located.toTimestamp,base+44*3600);
  // 最细周期为 1h 时只验 1h：4h 不是分辨率边界，必然 pending、也不能终止验证。
  assert.deepEqual(a.attempts.map(x=>x.timeframe),['1h']);
  assert.equal(a.attempts[0].structure.points[0].price,100);
  assert.equal(a.attempts[0].structure.points.at(-1).price,30);
  assert.equal(a.attempts[0].structure.timeframe,'1h');
  const only4h=createSubwaveVerifier(E,{hourly:sampleHours(),finestTf:'4h'}).evaluate(from,to,'impulse|ending');
  assert.deepEqual(only4h.attempts.map(x=>x.timeframe),['4h'],'--verify-tf 4h 时验 4h');
  assert.equal(v.evaluate({...from,index:99},{...to,index:999},'impulse|ending'),a);
  assert.equal(v.stats.windows,1);assert.equal(v.stats.cacheHits,1);
});
test('missing bars, ambiguous endpoints and fetch failure remain pending',()=>{
  for (const hourly of [[],sampleHours().filter((_,i)=>i!==20),sampleHours().map((c,i)=>i===3?{...c,high:100}:c)]) {
    assert.equal(createSubwaveVerifier(E,{hourly}).evaluate(from,to,'impulse').status,'pending');
  }
  assert.match(createSubwaveVerifier(E,{error:'offline'}).evaluate(from,to,'impulse').reason,/offline/);
});
test('small daily pivots trigger intraday role verification in actual explicit-count path',()=>{
  const candles=E.transformCandles(sampleHours(),E.TIMEFRAMES['1d']).map((c,index)=>({...c,index}));
  const verifier=createSubwaveVerifier(E,{hourly:sampleHours()});
  const result=E.evaluateLegRole([from,to],'impulse',candles,0,{maxDepth:5,beamK:3,cache:new Map(),timeframe:'1d',evidenceMode:true,verification:verifier},'a');
  assert.equal(result.evidence.attempts.length,1);
  assert.equal(result.node.isLeaf,false);
  assert.equal(result.node.primary.timeframe,'1h');
  assert.equal(result.node.primary.patternId,result.evidence.attempts[0].structure.patternId);
  assert.equal(result.evidence.attempts[0].structure.patternId,'impulse-strict');
  assert.equal(result.violates,false);
  assert.equal(result.evidence.status,'pending','unresolved internal subroles must propagate');
});
test('depth/search limits and legacy zero violations never imply verified structure',()=>{
  const points=[100,80,90,50,70,30].map((price,index)=>({price,index,type:index%2?'L':'H',timestamp:base+index*3600}));
  const candles=points.map(p=>({index:p.index,timestamp:p.timestamp,open:p.price,close:p.price,high:p.price,low:p.price,volume:1}));
  const tree=E.decompose(points,candles,['impulse'],0,{beamK:3,maxDepth:1,cache:new Map(),evidenceMode:true,timeframe:'1h'});
  assert.equal(tree.primary.score.tier1,0);
  assert.equal(tree.primary.score.verificationStatus,'pending');
  assert.equal(tree.primary.score.pendingRoles,5);
  assert.equal(E.serializeTree(tree).children[0].verificationStatus,'pending');
});
test('async builder shares one hourly fetch and reports failures as pending',async()=>{
  const candles=E.transformCandles(sampleHours(),E.TIMEFRAMES['1d']).map((c,index)=>({...c,index}));
  const fine=E.anchorBoundaryExtremes(candles,E.detectPivots(candles,1,{}));
  let calls=0;
  const {tree,verifier}=await buildVerifiedCountTree(E,fine,candles,{mainTf:'1d',product:'TEST',endTs:base+2*day,maxDepth:2,fetchHourly:async(_,granularity,start,end)=>{calls++;assert.equal(granularity,3600);assert.equal(end.getTime()/1000,base+2*day);return sampleHours();}});
  assert.equal(calls,1);assert.equal(verifier.stats.hourlyCandles,48);
  assert.equal(tree.verification.finestTimeframe,'1h');
  const failed=await buildVerifiedCountTree(E,fine,candles,{mainTf:'1d',product:'TEST',fetchHourly:async()=>{throw Error('unavailable');}});
  assert.match(failed.tree.verification.error,/unavailable/);
});
test('BTC old diagonal shrinks wave lengths but diverges in real time',()=>{
  const c=require('./fixtures/btc-usd-1d-golden.json').map((v,index)=>({...v,index}));
  const pts=E.pointsFromPrices([126296,80524.65,97963.62,60001,82814.23,57717.55],c);
  const manual=E.buildDiagonalManual('down','leading');
  const rule=manual.rules.find(r=>r.id==='diagonal.pattern.boundaries-converge');
  assert.equal(rule.test({points:pts,candles:c}).pass,false);
  assert.equal(manual.rules.find(r=>r.id==='diagonal.ratio.converging').test({points:pts,candles:c}).pass,true);
});
// 日线 c 腿 116410→80524.65 有 8 个枢轴，任何 6 点读法的 4 浪都入 1 浪区域：本周期违规照计，
// 小周期缺数据（offline）不能把它降成 pending；小周期给出 verified 结构时才撤销。
test('specified W keeps own passing rules; daily C role violation stands until a lower timeframe proves it',()=>{
  const c=require('./fixtures/btc-usd-1d-golden.json').map((v,index)=>({...v,index}));
  const f=E.anchorBoundaryExtremes(c,E.detectPivots(c,1,{}));
  const pts=E.pointsFromPrices([126296,103516.75,116410.06,80524.65],c);
  const v=createSubwaveVerifier(E,{error:'offline'});
  const zigzag=E.evaluateExplicitCount(pts,f,c,{maxDepth:5,timeframe:'1d',evidenceMode:true,verification:v}).results.find(x=>x.patternId==='zigzag');
  assert.ok(zigzag.ruleResults.every(x=>x.pass));
  assert.equal(zigzag.grammarViolations,1);
  assert.equal(zigzag.verificationStatus,'invalid');
  assert.equal(zigzag.evidence[2].legLabel,'c');
  assert.equal(zigzag.evidence[2].status,'invalid');
  assert.match(zigzag.evidence[2].reason,/本周期拆不出.*较小周期：小时行情获取失败/);
  const proven={evaluate:(from,to,role,sourceTf)=>({status:'verified',role,sourceTimeframe:sourceTf,attempts:[],reason:'mock lower proof',provenRoles:1,requiredRoles:1})};
  const lifted=E.evaluateExplicitCount(pts,f,c,{maxDepth:5,timeframe:'1d',evidenceMode:true,verification:proven}).results.find(x=>x.patternId==='zigzag');
  assert.equal(lifted.grammarViolations,0,'较小周期证明合法后撤销本周期违规');
  assert.equal(lifted.evidence[2].status,'verified');
});

test('hourly pagination overlaps exclusive boundaries without holes or duplicate bars',async()=>{
  const {fetchSharedHourly}=require('../wave-subwave-verification');
  const all=sampleHours();const pages=[];
  const got=await fetchSharedHourly(async(_,g,a,b)=>{pages.push([a.getTime()/1000,b.getTime()/1000]);return all.filter(c=>c.timestamp>=a.getTime()/1000 && c.timestamp<b.getTime()/1000);},'TEST',new Date(base*1000),new Date((base+2*day)*1000),12);
  assert.equal(pages.length,4);assert.equal(pages[1][0],pages[0][1]);assert.deepEqual(Array.from(got),all);assert.deepEqual(got.fetchErrors,[]);
});
test('known parent price failures survive pending intraday evidence',()=>{
  const c=require('./fixtures/btc-usd-1d-golden.json').map((v,index)=>({...v,index}));
  const f=E.anchorBoundaryExtremes(c,E.detectPivots(c,1,{}));
  const pts=E.pointsFromPrices([126296,80524.65,97963.62,60001,82814.23,57717.55],c);
  const results=E.evaluateExplicitCount(pts,f,c,{evidenceMode:true,timeframe:'1d',verification:createSubwaveVerifier(E,{error:'offline'})}).results;
  const diagonal=results.find(r=>r.patternId==='diagonal-leading');
  assert.equal(diagonal.verificationStatus,'invalid');
  assert.ok(diagonal.ruleResults.some(r=>!r.pass && r.desc.includes('边界')));
  const impulse=results.find(r=>r.patternId==='impulse-strict');
  assert.equal(impulse.verificationStatus,'invalid');
});
test('equal hard constraints prefer more complete evidence and retain incompleteness',()=>{
  const baseline={severe:0,tier1:0,tier2:0,tier3:0,tier4:0,evidenceMode:true,complexity:1,incompleteness:0};
  assert.ok(E.compareCandidates({...baseline,pendingRatio:0},{...baseline,pendingRatio:0.5})<0);
  assert.ok(E.compareCandidates({...baseline,pendingRatio:0.5,incompleteness:0},{...baseline,pendingRatio:0.5,incompleteness:1})<0);
});
test('evidence mode propagates verified, pending and invalid role outcomes consistently',()=>{
  const points=[100,80,90,50,70,30].map((price,index)=>({price,index,type:index%2?'L':'H',timestamp:base+index*day}));
  const candles=points.map(p=>({timestamp:p.timestamp,index:p.index,open:p.price,close:p.price,high:p.price,low:p.price,volume:1}));
  for (const status of ['verified','pending','invalid']) {
    const tree=E.decompose(points,candles,['impulse'],0,{beamK:3,maxDepth:1,cache:new Map(),evidenceMode:true,timeframe:'1d',verification:{evaluate:()=>({status,reason:'test',attempts:[]})}});
    assert.equal(tree.primary.score.verificationStatus,status);
    assert.equal(tree.primary.score.tier1,status==='invalid'?5:0);
  }
});

test('failed hourly page keeps other pages; covered windows still get intraday evidence',async()=>{
  const {fetchSharedHourly}=require('../wave-subwave-verification');const all=sampleHours();
  const got=await fetchSharedHourly(async(_,g,a,b)=>{if(a.getTime()/1000===base+36*3600)throw Error('offline');return all.filter(c=>c.timestamp>=a.getTime()/1000 && c.timestamp<b.getTime()/1000);},'TEST',new Date(base*1000),new Date((base+2*day)*1000),12);
  assert.equal(got.length,36);assert.equal(got.fetchErrors.length,1);
  const laterFailure=sampleHours();laterFailure.fetchErrors=[{fromTimestamp:base+3*day}];
  const evidence=createSubwaveVerifier(E,{hourly:laterFailure,error:'one later page failed'}).evaluate(from,to,'impulse');
  assert.equal(evidence.attempts.length,1);
});

test('limited noisy intraday search cannot conclusively reject a position role',()=>{
  const hours=sampleHours().map((c,i)=>i>=5 && i<=40?{...c,open:i%2?85:75,close:i%2?85:75,high:i%2?85:75,low:i%2?85:75}:c);
  const evidence=createSubwaveVerifier(E,{hourly:hours}).evaluate(from,to,'impulse');
  const finest=evidence.attempts.find(a=>a.timeframe==='1h');
  assert.ok(finest.pivotCount>8);assert.equal(finest.searchLimited,true);
  assert.equal(evidence.status,'pending');
});
test('B parent identity uses B targets and following C in every report section',()=>{
  const c=require('./fixtures/btc-usd-1d-golden.json').map((v,index)=>({...v,index}));
  c[c.length-1]={...c.at(-1),high:57717.55+0.65*(126296-57717.55),low:60000,close:100000};
  const fine=E.anchorBoundaryExtremes(c,E.detectPivots(c,1,{}));
  const tree=E.buildCountTree(fine,c,{maxDepth:4,beamK:3,evidenceMode:true,timeframe:'1d',verification:createSubwaveVerifier(E,{error:'offline'})});
  assert.equal(tree.assessment.bounceHyp.lean,'b');
  const brief=E.renderBrief({product:'TEST',timeframe:'1d'},tree);
  assert.ok(brief.includes('主选为 B 浪'));
  assert.ok(brief.includes('主选 B；'));
  assert.ok(brief.includes('C 浪下跌'));
  assert.ok(!brief.includes('主选 X；'));
  assert.equal(E.strengthTier(tree.primary.score),'中');
});

test('historical W followed by new lows does not invent a current bounce identity',()=>{
  const c=require('./fixtures/btc-usd-1d-golden.json').map((v,index)=>({...v,index}));const fine=E.anchorBoundaryExtremes(c,E.detectPivots(c,1,{}));
  const result=E.evaluateExplicitCount(E.pointsFromPrices([126296,103516.75,116410.06,80524.65],c),fine,c,{evidenceMode:true,maxDepth:5});
  assert.equal(result.bounceHyp,null);assert.equal(result.nearTerm,null);
});
test('pending Markdown never labels unverified templates as all rules passed',()=>{
  const c=require('./fixtures/btc-usd-1d-golden.json').map((v,index)=>({...v,index}));const fine=E.anchorBoundaryExtremes(c,E.detectPivots(c,1,{}));const tree=E.buildCountTree(fine,c,{maxDepth:4,beamK:3,evidenceMode:true});
  const text=E.renderMarkdownReport({product:'BTC-USD',timeframe:'1d',source:'fixture'},tree);
  assert.ok(!text.includes('✅ 规则全过'));assert.ok(!text.includes('✅ 主选'));assert.ok(text.includes('⏳ 暂定主选'));
});
