const fs = require('node:fs');
const base = 1701000000000, t = n => base + n * 60000;
// Literal, hand-derived ranges and turn expectations. Helpers only serialize
// identities/timestamps; they never run containment or a market algorithm.
const e = (sources, low, high, lowAt, highAt, firstSide=0, lastSide=firstSide) => ({sources,low,high,lowAt,highAt,firstSide,lastSide});
const a = e([2],5,10,2,1), b=e([4],9,14,4,3), c=e([6],6,12,6,5);
function write(name, points, rows, context={}, seedValid=true) {
  const id = name.toUpperCase();
  const config={segmentDirection:'up',initialDirection:'waiting',postDirection:'waiting',boundaryTime:null,secondSequence:false,maxElements:128,maxSources:512,...context};
  const items=points.slice(1).map((price,i)=>({id:`p${i+1}`,startTime:t(i),endTime:t(i+1),completedAt:t(i+2),startTicks:points[i],endTicks:price,direction:price>points[i]?'up':'down',ordinal:i+1,dependencies:[`f${i}`,`f${i+1}`,`proof${i+1}`]}));
  const expected=rows.map((row,i)=> {
    const [features,selectedCount,mergeDirection,options={}] = row;
    return {prefix:i+1,state:{inputCount:options.inputCount??i+1,selectedCount,mergeDirection,boundaryCuts:options.boundaryCuts??0,waitingDirection:options.waitingDirection??false,blocked:options.blocked??false,heldId:options.heldId??null,turnKind:options.turnKind??'none',gap:options.gap??null,seedEligible:i>=2?seedValid:false,features:features.map((f,k)=>({id:`${id}/E/p${f.sources[0]}`,lowTicks:f.low,highTicks:f.high,lowTime:t(f.lowAt),highTime:t(f.highAt),firstTime:t(f.sources[0]-1),lastTime:t(f.sources.at(-1)),firstOrdinal:f.sources[0],lastOrdinal:f.sources.at(-1),firstSide:f.firstSide,lastSide:f.lastSide,availableAt:t(f.sources.at(-1)+1),sealed:k<features.length-1,sourceIds:f.sources.map(n=>`p${n}`)}))},structures:[],events:[],reason:options.reason??'手工给出本前缀标准元素、来源及极值；前三笔资格按人工预期单列，只有特征序列诊断，不产生线段确认。'};
  });
  const fixture={schemaVersion:1,id,ruleVersion:'chanlun-research-0.1',ruleIds:['S-001','S-002','S-003','E-002','E-006'],expectationStatus:'reviewed',construction:'synthetic',source:{category:'engineering',sourceIds:['C65-168','C67-172','C71-182','C78-198'],lesson:78,pdfPages:[168,172,182,199],figure:null,note:'正文特征序列与假设分界原则的合成数值样例，不是原图行情重建。初始／分界后方向是显式测试上下文，不视为行情自行推断的结果。'},tickSize:'1',input:{kind:'feature-strokes',context:config,items},expected};
  fs.writeFileSync(`tests/fixtures/chanlun/${name.toLowerCase()}.json`,JSON.stringify(fixture,null,2)+'\n');
}
write('s-feature-up',[0,10,5,14,9,12,6],[
  [[],0,'waiting'],[[a],1,'waiting'],[[a],1,'waiting'],[[a,b],2,'up'],[[a,b],2,'up'],[[a,b,c],3,'down',{turnKind:'top',gap:false}]
]);
const da=e([2],10,15,1,2), db=e([4],6,11,3,4), dc=e([6],8,14,5,6);
write('s-feature-down',[20,10,15,6,11,8,14],[
  [[],0,'waiting'],[[da],1,'waiting'],[[da],1,'waiting'],[[da,db],2,'down'],[[da,db],2,'down'],[[da,db,dc],3,'up',{turnKind:'bottom',gap:false}]
],{segmentDirection:'down'});
const ub=e([4],8,12,4,3), um=e([4,6],9,12,6,3), ud=e([8],10,15,8,7);
write('s-feature-up-inclusion',[0,10,5,12,8,11,9,15,10],[
  [[],0,'waiting'],[[a],1,'waiting'],[[a],1,'waiting'],[[a,ub],2,'up'],[[a,ub],2,'up'],[[a,um],3,'up'],[[a,um],3,'up'],[[a,um,ud],4,'up']
]);
const dmb=e([4],8,12,3,4), dmm=e([4,6],8,11,3,6), dmd=e([8],5,10,7,8);
write('s-feature-down-inclusion',[20,10,15,8,12,9,11,5,10],[
  [[],0,'waiting'],[[da],1,'waiting'],[[da],1,'waiting'],[[da,dmb],2,'down'],[[da,dmb],2,'down'],[[da,dmm],3,'down'],[[da,dmm],3,'down'],[[da,dmm,dmd],4,'down']
],{segmentDirection:'down'});
const after=e([4],3,12,4,3,1), afterMerged=e([4,6],3,11,4,5,1);
write('s-feature-first-boundary',[0,10,5,12,3,11,4],[
  [[],0,'up'],[[a],1,'up'],[[a],1,'up'],[[a,after],2,'down',{boundaryCuts:1}],[[a,after],2,'down',{boundaryCuts:1}],[[a,afterMerged],3,'down',{boundaryCuts:1}]
],{initialDirection:'up',postDirection:'down',boundaryTime:t(3)});
const across=e([2,4],5,12,2,3,0,1), post=e([6],4,11,6,5,1);
write('s-feature-second-boundary',[0,10,5,12,3,11,4],[
  [[],0,'up'],[[a],1,'up'],[[a],1,'up'],[[across],2,'up'],[[across],2,'up'],[[across,post],3,'down']
],{initialDirection:'up',postDirection:'down',boundaryTime:t(3),secondSequence:true});
write('s-feature-wait-direction',[0,10,5,9,6,11],[
  [[],0,'waiting'],[[a],1,'waiting'],[[a],1,'waiting'],[[a],2,'waiting',{waitingDirection:true,heldId:'p4'}],[[a],2,'waiting',{inputCount:4,waitingDirection:true,heldId:'p4'}]
]);
const blocked={inputCount:5,blocked:true,heldId:'p6'};
write('s-feature-element-limit',[0,10,5,14,9,12,6,11,4],[
  [[],0,'waiting'],[[a],1,'waiting'],[[a],1,'waiting'],[[a,b],2,'up'],[[a,b],2,'up'],[[a,b],2,'up',blocked],[[a,b],2,'up',blocked],[[a,b],2,'up',blocked]
],{maxElements:2});
write('s-feature-source-limit',[0,10,5,12,8,11,9],[
  [[],0,'waiting'],[[a],1,'waiting'],[[a],1,'waiting'],[[a,ub],2,'up'],[[a,ub],2,'up'],[[a,ub],2,'up',blocked]
],{maxSources:2});
write('s-feature-equal-origin',[0,10,5,12,8,12,9],[
  [[],0,'waiting'],[[a],1,'waiting'],[[a],1,'waiting'],[[a,ub],2,'up'],[[a,ub],2,'up'],[[a,um],3,'up']
]);
const gb=e([4],15,20,4,3), gc=e([6],12,18,6,5);
write('s-feature-gap',[0,10,5,20,15,18,12],[
  [[],0,'waiting'],[[a],1,'waiting'],[[a],1,'waiting'],[[a,gb],2,'up'],[[a,gb],2,'up'],[[a,gb,gc],3,'down',{turnKind:'top',gap:true}]
]);
const tb=e([4],10,15,4,3), tc=e([6],9,14,6,5);
write('s-feature-touch',[0,10,5,15,10,14,9],[
  [[],0,'waiting'],[[a],1,'waiting'],[[a],1,'waiting'],[[a,tb],2,'up'],[[a,tb],2,'up'],[[a,tb,tc],3,'down',{turnKind:'top',gap:false}]
]);
const na=e([2],-3,4,2,1), nb=e([4],-5,-1,4,3), nc=e([6],-2,1,6,5);
write('s-feature-no-start',[0,4,-3,-1,-5,1,-2],[
  [[],0,'waiting'],[[na],1,'waiting'],[[na],1,'waiting'],[[na,nb],2,'down'],[[na,nb],2,'down'],[[na,nb,nc],3,'up']
],{},false);
const ca=e([2],12,16,1,2), cb=e([4],10,15,3,4), cc=e([6],12,20,5,6), cm=e([2,4],10,16,3,2);
write('s-feature-81-lower',[18,12,16,10,15,12,20],[
  [[],0,'down'],[[ca],1,'down'],[[ca],1,'down'],[[ca,cb],2,'down'],[[ca,cb],2,'down'],[[ca,cb,cc],3,'up',{turnKind:'bottom',gap:false}]
],{segmentDirection:'down',initialDirection:'down'});
for (const [name,high] of [['equal',16],['higher',17]]) write(`s-feature-81-${name}`,[18,12,16,10,high,12,20],[
  [[],0,'down'],[[ca],1,'down'],[[ca],1,'down'],[[cm],2,'down'],[[cm],2,'down'],[[cm,cc],3,'up']
],{segmentDirection:'down',initialDirection:'down'});
for (const name of ['lower','equal','higher']) {
  const file=`tests/fixtures/chanlun/s-feature-81-${name}.json`;
  const fixture=JSON.parse(fs.readFileSync(file,'utf8'));
  fixture.source={category:'author-correction',sourceIds:['C81-209','C81-210','C78-198'],lesson:81,pdfPages:[199,209,210],figure:'第209页图一／图二的5、7关系；第210页更正',note:'只截取从原高点开始的反向候选B，图中5、7对应两次上行笔高点，本构造为16与15/16/17。数值为合成，非原图精确价格。第二序列必须处理包含：7低于5时出现底分型，相等／更高时先包含合并而不形成该底分型。本驱动只断言第二序列，不独自断言完整A/B/C段数。'};
  fs.writeFileSync(file,JSON.stringify(fixture,null,2)+'\n');
}

// Full S confirmation expectations use the generic completed-component input
// contract with locked strokes as leaves. There is deliberately no S driver yet.
function segmentCase(name, points, confirmations, source) {
  const items=points.slice(1).map((price,i)=>({id:`p${i+1}`,startTime:t(i),endTime:t(i+1),completedAt:t(i+2),startTicks:points[i],endTicks:price,lowTicks:Math.min(points[i],price),highTicks:Math.max(points[i],price),direction:price>points[i]?'up':'down',dependencies:[`f${i}`,`f${i+1}`,`proof${i+1}`]}));
  const expected=items.map((_,i)=>{
    const prefix=i+1, available=confirmations.filter(s=>s.at<=prefix);
    const structures=available.map((s,n)=>({id:`segment-${n+1}`,type:'segment',level:0,status:'confirmed',direction:points[s.end]>points[s.start]?'up':'down',startTime:t(s.start),endTime:t(s.end),startTicks:points[s.start],endTicks:points[s.end],confirmedAt:t(s.at+1),dependencies:[...items.slice(s.proofStart,s.proofEnd??s.at).map(p=>p.id),...(s.parent?[s.parent]:[])]}));
    const events=structures.filter((_,n)=>available[n].at===prefix).map(s=>({id:`confirm/${s.id}`,type:'segment',objectId:s.id,occurredAt:s.endTime,confirmedAt:s.confirmedAt}));
    return {prefix,state:{confirmedSegments:structures.length},structures,events,reason:source.prefixReasons?.[prefix]??source.note};
  });
  const fixture={schemaVersion:1,id:name.toUpperCase(),ruleVersion:'chanlun-research-0.1',ruleIds:['S-001','S-002','S-003','E-007'],expectationStatus:'reviewed',construction:'synthetic',source:{category:source.category??'author-body',sourceIds:source.ids,lesson:source.lesson,pdfPages:source.pages,figure:source.figure??null,note:source.note+' 输入明确假定每项为已锁定合法笔；初始化及同刻提交约定单列于E-007。只断言确认前缀，不强制未锁定候选的展示集合。'},tickSize:'1',input:{kind:'completed-components',items},expected};
  fs.writeFileSync(`tests/fixtures/chanlun/${name.toLowerCase()}.json`,JSON.stringify(fixture,null,2)+'\n');
}
segmentCase('s-first-end',[0,10,5,12,3,9,2],[{start:0,end:3,at:6,proofStart:0}],{ids:['C71-182','C71-183','C77-195'],lesson:71,pages:[181,182,183,196],figure:'第183页上半部左上（合成价格）',note:'第一破坏笔12→3已经跌破旧段末个向下特征笔10→5的低点；第三笔9→2先破第一破坏笔结束位置3。前三笔公共区间及方向合规，前缀6锁定0→12；仅有第一破坏笔时不确认。'});
segmentCase('s-first-continue',[0,10,5,12,3,13,4],[],{ids:['C71-182','C71-183','C77-195'],lesson:71,pages:[181,182,183,196],figure:'第183页上半部右上（合成价格）',note:'第一破坏笔12→3之后先回到13，突破第一破坏笔起点12，旧段继续；不能在先前0→12候选处提交确认。'});
segmentCase('s-first-wait-end',[0,10,5,12,3,11,4,10,2],[{start:0,end:3,at:8,proofStart:0}],{ids:['C71-182','C77-195'],lesson:71,pages:[181,182,196],note:'12→3的第三笔11→4仍在第一破坏笔范围内，前缀6不能确认；后续先破结束位置3而没有先破起点12，到前缀8的10→2才锁定旧段0→12。'});
segmentCase('s-first-equal-third',[0,10,5,12,3,9,3],[],{ids:['C71-182','C77-195'],lesson:71,pages:[181,182,196],note:'第三笔9→3仅到达第一破坏笔12→3的结束价，未严格突破；不能据相等价格锁定旧段。'});
segmentCase('s-first-locked-prefix',[0,10,5,12,3,9,2,10,4,11,5,10,4],[{start:0,end:3,at:6,proofStart:0},{start:3,end:6,at:9,proofStart:3},{start:6,end:9,at:12,proofStart:6}],{ids:['C67-172','C71-182','C77-195'],lesson:71,pages:[172,181,182,196],note:'逐笔在前缀6、9、12锁定上涨0→12、下跌12→2、上涨2→11；后续方向变化与末端延伸不得改写之前的端点、来源和确认时刻。'});
segmentCase('s-start-after-invalid',[0,4,-3,-1,-5,1,-2,2],[{start:1,end:4,at:7,proofStart:1}],{ids:['C65-168','C71-182','C77-195'],lesson:77,pages:[169,181,182,196],note:'最初0→4→-3→-1无公共重叠，不能作为段起始。下一组三笔从4开始向下且有重叠；前缀7锁定4→-5，初始化无效输入不进入其依赖。'});
segmentCase('s-first-wait-inclusion',[0,20,10,28,18,26,20,27,19,25,17],[{start:0,end:3,at:10,proofStart:0}],{ids:['C65-168','C71-182','C77-195'],lesson:71,pages:[169,181,182,196],note:'28→18是第一破坏笔。第三笔26→20仍在它内部；包含会把特征元素抬为[20,28]，随后27→19可制造看似无缺口特征顶，但19仍高于原破坏笔结束位置18，前缀8禁止锁定。到前缀10的25→17先破18才锁定0→28。'});
segmentCase('s-wait-direction-inside',[20,6,12,0,10,5,8,4,7,3,9,5,10],[],{ids:['C65-168','C71-182','C77-195'],lesson:71,pages:[169,181,182,196],note:'从0开始的第一反向笔0→10已经笔破坏旧下降段，但之后始终未严格先破0或10；到前缀12也仅相等触及10。第三笔及后续包含产生的几何分型不能绕过方向待定守卫，不提交假设20→0或0→8为已完成段。'});
segmentCase('s-special-internal-extreme',[0,6,2,10,6,9,4,12,5,11,3,8,4,15,5,12,4],[{start:0,end:3,at:6,proofStart:0},{start:3,end:10,at:13,proofStart:3},{start:10,end:13,at:16,proofStart:10}],{ids:['C65-168','C71-182','C77-195','C78-198'],lesson:78,pages:[169,181,182,196,198,199],note:'按第78课前提构造：A上涨0→10已于前缀6被B证明破坏。B下降从10开始，第一反向破坏笔4→12虽创新高12，但第三反向笔5→11仍在4→12内部，随后11→3先破起点4，B继续。B最终几何端点10→3，成员最高12发生于前缀7、最低3于前缀10，前缀13才确认。C上涨3→15于前缀16确认；证明笔中的15不得并入B实际成员最高12。真实几何端点、内部极值和后续证明分别保留；该例不把未定三笔当作合法已完成特殊段。'});
for (const [name,high] of [['lower',15],['equal',16],['higher',17]]) {
  segmentCase(`s81-${name}`,[0,6,2,18,12,16,10,high,12,20],name==='lower'?[{start:0,end:3,at:9,proofStart:0},{start:3,end:6,at:9,proofStart:3}]:[],{ids:['C67-172','C77-195','C78-198','C81-209','C81-210'],category:'author-correction',lesson:81,pages:[172,196,199,209,210],figure:'第209页图一／图二及第210页更正（合成价格）',note:`图中5、7对应16与${high}。原段第一特征分型存在缺口[6,12]，前缀6只能保留第二类候选。${name==='lower'?'前缀9形成第二序列底分型，A(0→18)与B(18→10)同时锁定；原缺口仍未完全回补，不额外要求补缺或递归区分第二序列类型。该前缀同时出现原方向新高20，不能抢在第二序列证明之前一律撤销全部候选。':'第二序列前两元素必须包含合并，没有所需底分型；原方向继续新高20时仍是一段，不提交假设A/B的完成。'}`});
}
