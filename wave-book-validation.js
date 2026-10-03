'use strict';

// Book rules used by the tree engine. Citations refer to the supplied chapters 1–7.
function extrema(ctx, from, to, { excludeStartBar = false } = {}) {
  const a = Math.min(from.index, to.index), b = Math.max(from.index, to.index);
  const bars = (ctx.candles || []).slice(a + (excludeStartBar ? 1 : 0), b + 1);
  const prices = (ctx.points || []).filter(p => p.index >= a && p.index <= b).map(p => p.price);
  return { hi: Math.max(from.price, to.price, ...prices, ...bars.map(c => c.high)),
    lo: Math.min(from.price, to.price, ...prices, ...bars.map(c => c.low)) };
}
// A pivot identifies an event inside a candle, not the order of the other wick.
// Keep all later bars; a violation confined to the shared start bar needs finer evidence.
function pathGate(ctx,from,to,threshold,above,reference) {
  const full=extrema(ctx,from,to),observed=extrema(ctx,from,to,{excludeStartBar:true});
  const value=r=>above?r.lo:r.hi,inside=r=>above?value(r)>threshold:value(r)<threshold;
  if(!inside(observed)) return {pass:false,overshoot:Math.abs(value(observed)-threshold)/(reference>0?reference:1)};
  if(!inside(full)) return {pass:false,overshoot:0,undetermined:true,reason:'起点所在K线的另一端极值先后不明，须用较小周期定位'};
  return {pass:true,overshoot:0};
}
// §6.20 compares every subwave of 4 with every subwave of 1.
function waveFourGate(ctx,points,isUp,firstSegment,fourthSegment) {
  const segment=(a,b)=>({ctx,from:points[a],to:points[b]});
  const one=firstSegment || segment(0,1),four=fourthSegment || segment(3,4);
  const bounds=(s,exclude)=>extrema(s.ctx,s.from,s.to,{excludeStartBar:exclude});
  const gap=(a,b)=>isUp ? b.lo-a.hi : a.lo-b.hi;
  const known=gap(bounds(one,true),bounds(four,true));
  const reference=Math.abs(points[1].price-points[0].price) || 1;
  if(known<=0) return {pass:false,overshoot:Math.abs(known)/reference};
  if(gap(bounds(one,false),bounds(four,false))<=0) return {pass:false,overshoot:0,undetermined:true,reason:'1/4浪的共享起点K线极值先后不明，须用较小周期定位'};
  return {pass:true,overshoot:0};
}
const time = p => Number.isFinite(p.timestamp) ? p.timestamp : p.index;
function line(a, b) {
  const delta = time(b) - time(a);
  if (!(delta > 0)) return null;
  const slope = (b.price - a.price) / delta;
  const intercept = a.price - slope * time(a);
  return { slope, intercept, at: x => intercept + slope * x };
}
function triangleGeometry(points) {
  const [,a,b,c,d,e] = points;
  const ac = line(a,c), bd = line(b,d);
  if (!ac || !bd || ac.slope === 0 || Math.abs(ac.slope-bd.slope) <= Number.EPSILON*Math.max(Math.abs(ac.slope),Math.abs(bd.slope))) return {pass:false};
  const apexTime = (bd.intercept-ac.intercept)/(ac.slope-bd.slope);
  const apexPrice = ac.at(apexTime);
  const widthB = Math.abs(ac.at(time(b))-bd.at(time(b)));
  const widthE = Math.abs(ac.at(time(e))-bd.at(time(e)));
  const aLength = Math.abs(points[1].price-points[0].price), bLength = Math.abs(points[2].price-points[1].price);
  const interval = aLength >= bLength ? [points[0].price,a.price] : [a.price,b.price];
  return { ac, bd, apexTime, apexPrice, pass:apexTime > time(e) && widthE < widthB
    && apexPrice >= Math.min(...interval) && apexPrice <= Math.max(...interval) };
}
// §6.14: A unrestricted; B inside, C/D <= 10% C gross, E <= 10% D gross.
function triangleExcursion(ctx, leg) {
  const geometry = triangleGeometry(ctx.points);
  if (!geometry.ac || !geometry.bd) return Infinity;
  const from = ctx.points[leg], to = ctx.points[leg+1];
  const bars = (ctx.candles || []).slice(from.index,to.index+1);
  const samples = bars.length ? bars.map(c => ({ timestamp:c.timestamp,hi:c.high,lo:c.low }))
    : ctx.points.filter(p=>p.index>=from.index && p.index<=to.index).map(p=>({timestamp:time(p),hi:p.price,lo:p.price}));
  return Math.max(0,...samples.map(s=>{
    const rails=[geometry.ac.at(s.timestamp),geometry.bd.at(s.timestamp)];
    return Math.max(s.hi-Math.max(...rails),Math.min(...rails)-s.lo);
  }));
}
function isTruncated(candidate) {
  if (!candidate || !candidate.patternId || !candidate.patternId.startsWith('impulse') && !candidate.patternId.startsWith('diagonal')) return false;
  const p=candidate.points;
  return !!(p && p.length===6 && !p[5].provisional && (candidate.direction==='up' ? p[5].price<p[3].price : p[5].price>p[3].price));
}
function failedC(candidate) {
  if (!candidate || candidate.patternId!=='zigzag' || candidate.points.at(-1).provisional) return false;
  const p=candidate.points;
  return candidate.direction==='up' ? p[3].price<p[1].price : p[3].price>p[1].price;
}
function parentChildIssues(id, children, accepts = () => true) {
  const child=i=>{ const c=children[i] && children[i].primary; return c && accepts(i,c) && !(c.score && c.score.failed && c.score.failed.length) ? c : null; };
  const issues=[];
  const add=(key,desc,basis)=>issues.push({id:key,kind:'grammar',desc,basis,overshoot:0.25});
  if(id==='zigzag') {
    const a=child(0), c=child(2);
    if(a && c && a.patternId==='diagonal-leading' && c.patternId.startsWith('diagonal-ending'))
      add('zigzag.children.diagonal-pair','a 为引导楔形时 c 不能是终结楔形','§4.1/§4.5');
    if(isTruncated(a) && isTruncated(c)) add('zigzag.children.not-both-truncated','a/c 不能同时出现第5浪衰竭','§4.1');
    if(a && c && c.patternId==='diagonal-ending-expanding' && !c.points.at(-1).provisional && (c.direction==='up' ? c.points.at(-1).price<=a.points.at(-1).price : c.points.at(-1).price>=a.points.at(-1).price))
      add('zigzag.children.expanding-c-not-failed','扩散终结楔形 c 须超过 a 终点','§4.6');
  }
  if(id.startsWith('flat') && isTruncated(child(2))) add('flat.children.c5-not-truncated','平台形 c 的第5浪不得衰竭','§5.3');
  if(id==='zigzag-double' || id==='zigzag-triple') for(const i of [0,2]) {
    if(failedC(child(i))) add(id+'.children.'+i+'-c-not-failed',(i===0?'w':'y')+' 的 c 浪不得失败','§7.1');
  }
  if(id==='triangle') {
    const e=child(4);
    if(e && e.patternId==='triangle' && e.children && e.children[4] && e.children[4].primary && e.children[4].primary.patternId==='triangle')
      add('triangle.children.ee-not-triangle','e 可为三角形，但其 ee 不得再为三角形','§6.8');
    for(const i of [0,2,3]) {
      const c=child(i);
      if(!c || !c.points || c.points.length<3) continue;
      const one=extrema({candles:c.validationCandles,points:c.points},c.points[0],c.points[1]);
      const two=extrema({candles:c.validationCandles,points:c.points},c.points[1],c.points[2]);
      if(two.hi-two.lo >= 1.05*(one.hi-one.lo)) add('triangle.children.'+i+'-second-lt-105','三角形 '+['a','b','c','d'][i]+' 内部第二子浪运行总量须小于第一子浪的105%','§6.2');
    }
  }
  return issues;
}
function completion(candidate) {
  if (!candidate) return 'forming';
  if(candidate.score && (candidate.score.tier1>0 || candidate.score.verificationStatus==='invalid')) return 'invalidated';
  if(candidate.finalWaveInProgress || candidate.points && candidate.points.at(-1).provisional) return 'forming';
  // Confirmation requires separately supplied observable evidence, not targets or a temporary pivot.
  if(candidate.score && candidate.score.verificationStatus==='verified' && candidate.completionEvidence && candidate.completionEvidence.confirmed===true) return 'confirmed_complete';
  return 'potentially_complete';
}
const COMPLETION_CN={forming:'进行中',potentially_complete:'潜在完成（待确认）',confirmed_complete:'确认完成',invalidated:'已失效'};
function childDegreeOffset(id,i) {
  if(['zigzag-double','zigzag-triple','sideways-double','sideways-triple'].includes(id)) return 1+Math.floor(i/2);
  return 1;
}
module.exports={extrema,pathGate,waveFourGate,line,time,triangleGeometry,triangleExcursion,isTruncated,failedC,parentChildIssues,completion,COMPLETION_CN,childDegreeOffset};
