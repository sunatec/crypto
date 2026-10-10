'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const E=require('../analyze-wave-tree');
const {createSubwaveVerifier}=require('../wave-subwave-verification');
// BTC 2026-07-01 起的浪 1（57717.55→66923.95）：4h 窗口 38 个枢轴，含 39 种价格规则全过的引导楔形读法，
// 但都不在 segmentations 的显著性短名单内。夹具为这 20 天的小时线（含两端完整日线桶）。
const hours=require('./fixtures/btc-usd-1h-wave1-2026-07.json');
const wFrom={timestamp:1782864000,index:0,type:'L',price:57717.55};
const wTo={timestamp:1784592000,index:1,type:'H',price:66923.95};
const verify=(extra={})=>createSubwaveVerifier(E,{hourly:hours,finestTf:'4h',...extra}).evaluate(wFrom,wTo,'impulse|leading','1d');

test('baseline: without diagonal enumeration the wave-1 window only offers impulse-strict with a wave-4 overlap violation',()=>{
  const node=decomposeWave1(false);
  assert.equal(node.searchLimited,true);
  assert.equal(node.segFine.length,38);
  assert.equal(node.primary.patternId,'impulse-strict');
  assert.ok(E.candidateViolations(node.primary).some(v=>v.desc.includes('4浪不能切入1浪')));
  assert.ok([node.primary,...node.alternates].every(c=>c.patternId!=='diagonal-leading'),'楔形读法被显著性短名单漏掉');
});

// 与验证器 prepare 相同的 4h 窗口准备；去掉原始末枢轴上被钉死端点取代的 provisional 标记，只检验楔形候选本身。
function wave1Window(){
  const a=1782867600,b=1784642400;
  const w=hours.filter(c=>c.timestamp>=a&&c.timestamp<=b);
  const candles=E.transformCandles(w,E.TIMEFRAMES['4h']).map((c,index)=>({...c,index}));
  const raw=E.anchorBoundaryExtremes(candles,E.detectPivots(candles,1,{}));
  const start={type:'L',price:57717.55,index:0,timestamp:candles[0].timestamp},finish={type:'H',price:66923.95,index:candles.length-1,timestamp:candles.at(-1).timestamp};
  const fine=[start,...raw.filter(p=>p.index>0&&p.index<finish.index).map(({provisional,boundary,...p})=>p),finish];
  return {candles,fine};
}
const decomposeWave1=(flag)=>{
  const {candles,fine}=wave1Window();
  return E.decompose(fine,candles,['impulse|leading'],0,{beamK:3,maxDepth:3,cache:new Map(),evidenceMode:true,timeframe:'4h',finestResolution:'4h',expandAllTop:false,diagonalEnumeration:flag});
};

test('diagonalSegmentations enumerates readings the significance shortlist misses',()=>{
  const {fine}=wave1Window();
  const shortlist=new Set(E.significantShortlist(fine,12));
  const segs=E.diagonalSegmentations(fine,'up');
  assert.ok(segs.length>0);
  for(const pts of segs){
    assert.equal(pts.length,6);
    assert.equal(pts[0],fine[0]);assert.equal(pts[5],fine[fine.length-1]);
    pts.forEach((p,i)=>assert.equal(p.type,i%2?'H':'L'));
    assert.ok(pts.every((p,i)=>!i||p.index>pts[i-1].index));
  }
  const known=segs.find(pts=>pts.slice(1,-1).map(p=>p.price).join('>')==='63940.79>61250>64669.42>63608.54');
  assert.ok(known,'已知合格读法在枚举结果里');
  assert.ok(!known.slice(1,-1).every(p=>shortlist.has(fine.indexOf(p))),'该读法不在显著性短名单内');
});
test('with diagonal enumeration the wave-1 window selects a leading diagonal without violations',()=>{
  const off=decomposeWave1(false),on=decomposeWave1(true);
  assert.equal(off.primary.patternId,'impulse-strict');
  assert.equal(off.diagonalEnumeration,undefined);
  assert.equal(on.primary.patternId,'diagonal-leading');
  assert.deepEqual(E.candidateViolations(on.primary),[]);
  const stat=on.diagonalEnumeration.find(x=>x.patternId==='diagonal-leading');
  assert.ok(stat.considered>0&&stat.kept>0&&stat.kept<=E.DIAG_ENUM_KEEP&&stat.skipped===false);
});
test('diagonal enumeration is deterministic and capped',()=>{
  const a=decomposeWave1(true),b=decomposeWave1(true);
  assert.deepEqual(a.primary.points.map(p=>p.index),b.primary.points.map(p=>p.index));
  assert.deepEqual(a.alternates.map(c=>c.points.map(p=>p.index)),b.alternates.map(c=>c.points.map(p=>p.index)));
  for(const s of a.diagonalEnumeration) assert.ok(s.kept<=E.DIAG_ENUM_KEEP);
});
function syntheticFine(prices){
  const points=prices.map((price,index)=>({price,index,type:index%2?'H':'L',timestamp:1700000000+index*14400}));
  const candles=points.map(p=>({timestamp:p.timestamp,index:p.index,open:p.price,close:p.price,high:p.price,low:p.price,volume:1}));
  return {points,candles};
}
test('choppy swings without wedge geometry produce no diagonal candidate and leave the result unchanged',()=>{
  // 上行腿但中间没有任何越过 1 浪终点的 3 浪：预筛后无读法
  const {points,candles}=syntheticFine([10,20,15,18,14,19,13,17,12,25]);
  assert.deepEqual(E.diagonalSegmentations(points,'up'),[]);
  const opts={beamK:3,maxDepth:3,evidenceMode:true,timeframe:'4h',finestResolution:'4h',expandAllTop:false};
  const off=E.decompose(points,candles,['impulse|leading'],0,{...opts,cache:new Map()});
  const on=E.decompose(points,candles,['impulse|leading'],0,{...opts,cache:new Map(),diagonalEnumeration:true});
  assert.equal(on.primary.patternId,off.primary.patternId);
  assert.deepEqual(on.primary.points.map(p=>p.index),off.primary.points.map(p=>p.index));
  assert.ok(on.diagonalEnumeration.every(s=>s.kept===0));
});
test('too many pivots skip the enumeration without error and stay search-limited',()=>{
  const prices=[];for(let i=0;i<72;i+=1)prices.push(i%2?100+i*2+3:100+i*2-3);
  prices[71]=prices[70]+10; // 终点为 H
  const {points,candles}=syntheticFine(prices);
  assert.ok(points.length-2>E.DIAG_ENUM_MAX_PIVOTS);
  assert.deepEqual(E.diagonalSegmentations(points,'up'),[]);
  const node=E.decompose(points,candles,['impulse|leading'],0,{beamK:3,maxDepth:2,cache:new Map(),evidenceMode:true,timeframe:'4h',finestResolution:'4h',expandAllTop:false,diagonalEnumeration:true});
  assert.equal(node.searchLimited,true);
  assert.ok(node.diagonalEnumeration.every(s=>s.skipped===true&&s.kept===0));
});
test('default decompose without the flag is unaffected',()=>{
  const {candles,fine}=wave1Window();
  const base=E.decompose(fine,candles,['impulse|leading'],0,{beamK:3,maxDepth:3,cache:new Map(),evidenceMode:true,timeframe:'4h',finestResolution:'4h',expandAllTop:false});
  assert.equal(base.primary.patternId,'impulse-strict');
  assert.equal(base.diagonalEnumeration,undefined);
});

test('4h verification of the wave-1 window cuts off at a verified leading diagonal',()=>{
  const r=verify();
  assert.deepEqual(r.attempts.map(a=>a.timeframe),['4h']);
  const a=r.attempts[0];
  assert.equal(a.patternId,'diagonal-leading');
  assert.deepEqual(a.violations,[]);
  assert.equal(a.status,'verified');
  assert.equal(r.status,'verified');
  assert.equal(r.verificationScope.finestTimeframe,'4h');
  assert.ok(a.diagonalEnumeration.considered>0&&a.diagonalEnumeration.kept>0&&a.diagonalEnumeration.skipped===false);
});

test('a wedge whose legs are too short to form sub-structures stays pending, so the daily violation is kept',()=>{
  const {points,candles}=syntheticFine([100,150,120,165,140,170]);
  const node=E.decompose(points,candles,['impulse|leading'],0,{beamK:3,maxDepth:3,cache:new Map(),evidenceMode:true,timeframe:'4h',finestResolution:'4h',expandAllTop:false,diagonalEnumeration:true});
  assert.equal(node.primary.patternId,'diagonal-leading');
  assert.deepEqual(E.candidateViolations(node.primary),[]);
  assert.ok(node.primary.children.every(c=>c.isLeaf));
  assert.equal(node.primary.score.verificationStatus,'pending');
});
