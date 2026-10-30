'use strict';
// fix-book-audit-p1 实施后的回归：驱动腿起点闸门、正统终点扩展范围、父级角色结构证据。
const test=require('node:test');
const assert=require('node:assert/strict');
const E=require('../analyze-wave-tree');

const pat=id=>E.PATTERNS.find(p=>p.id===id);
const pv=(index,type,price)=>({index,type,price,timestamp:index*86400});

function goldenTree() {
  const c=require('./fixtures/btc-usd-1d-golden.json').map((v,index)=>({...v,index}));
  const f=E.anchorBoundaryExtremes(c,E.detectPivots(c,1,{}));
  return {tree:E.buildCountTree(f,c,{maxDepth:4,beamK:3,evidenceMode:true,timeframe:'1d'}),fine:f};
}

test('§1.5 驱动腿内部越过自身起点即淘汰：BTC 推动浪 4=76022.6 而 5 浪内藏 82814.23',()=>{
  const pts=[pv(0,'H',126296),pv(10,'L',103516.75),pv(20,'H',116410.06),pv(40,'L',60001),pv(50,'H',76022.6),pv(80,'L',57717.55)];
  const seg=[...pts.slice(0,5),pv(60,'L',64938.66),pv(65,'H',82814.23),pts[5]].sort((a,b)=>a.index-b.index);
  assert.equal(E.legsRespectOrigin(pts,seg,pat('impulse-strict')),false);
  assert.equal(E.legsRespectOrigin(pts,pts,pat('impulse-strict')),true,'无隐藏点时通过');
});

test('§3.15/§5 调整腿内的 b 可越过起点（扩散平台），驱动 c 腿不行',()=>{
  const pts=[pv(0,'H',100),pv(10,'L',60),pv(20,'H',105),pv(30,'L',55)];
  const dipInB=[pts[0],pts[1],pv(13,'H',70),pv(16,'L',58),pts[2],pts[3]];
  assert.equal(E.legsRespectOrigin(pts,dipInB,pat('flat-expanded')),true,'b 腿是调整腿，内部低于其起点 2 点（a′=10）允许');
  const deepDip=[pts[0],pts[1],pv(13,'H',70),pv(16,'L',49),pts[2],pts[3]];
  assert.equal(E.legsRespectOrigin(pts,deepDip,pat('flat-expanded')),false,'越过起点 11 点 ≥ 此前顺向 a′=10，即 b′≥2a′，淘汰');
  const spikeInC=[pts[0],pts[1],pts[2],pv(23,'L',90),pv(26,'H',108),pts[3]];
  assert.equal(E.legsRespectOrigin(pts,spikeInC,pat('flat-expanded')),false,'c 腿是驱动腿，越过起点 105 淘汰');
});

test('引导楔形有全调整子角色方案，腿内越过起点按调整腿 b′<2a′ 判',()=>{
  const pts=[pv(0,'H',100),pv(10,'L',70),pv(20,'H',90),pv(30,'L',50),pv(40,'H',75),pv(50,'L',40)];
  const seg=[pts[0],pv(3,'L',95),pv(6,'H',103),...pts.slice(1)];
  assert.equal(E.legsRespectOrigin(pts,seg,pat('diagonal-leading')),true);
  assert.equal(E.legsRespectOrigin(pts,seg,pat('impulse-strict')),false);
});

test('BTC 平台 b 腿 80524.65→82814.23 内部跌到 60001：越过起点 20523 ≥ 此前顺向 17439，淘汰',()=>{
  const pts=[pv(0,'H',126296),pv(10,'L',80524.65),pv(40,'H',82814.23),pv(60,'L',57717.55)];
  const seg=[pts[0],pts[1],pv(20,'H',97963.62),pv(30,'L',60001),pts[2],pts[3]];
  assert.equal(E.legsRespectOrigin(pts,seg,pat('flat')),false);
});

test('金标准：顶层候选的腿都不违反起点约束',()=>{
  const {tree,fine}=goldenTree();
  for (const c of [tree.primary,...(tree.alternates||[])]) {
    const seg=fine.filter(p=>p.index>=c.points[0].index && p.index<=c.points.at(-1).index);
    assert.ok(E.legsRespectOrigin(c.points,seg,pat(c.patternId)),c.patternId+' '+c.points.map(p=>p.price).join('→'));
  }
});

test('§4.7 正统终点扩展只给末浪可失败的形态，且全局极值须在结构内部',()=>{
  const {tree,fine}=goldenTree();
  const start=tree.primary.points[0];
  const extreme=fine.filter(p=>p.index>=start.index).reduce((m,p)=>(start.type==='H'?p.price<m.price:p.price>m.price)?p:m);
  const beyond=[tree.primary,...(tree.alternates||[])].filter(c=>c.points.at(-1).index>extreme.index);
  for (const c of beyond) {
    assert.ok(E.ORTHODOX_END_PATTERNS.includes(c.patternId),'越过全局极值的候选只能是末浪可失败形态：'+c.patternId);
    assert.ok(c.points.some(p=>p.index===extreme.index),'全局极值须是该候选的内部转折点');
  }
});

function parentTree(swingChar) {
  return {
    primary:{klass:'corrective',patternId:'zigzag',points:[{price:126296},{price:57717.55}],score:{verificationStatus:'pending'}},
    inProgressStruct:{swingExtreme:{price:87397},swingChar,upTree:null},
    assessment:null,
  };
}

test('父级角色：反弹已走成五浪时，新推动读法不被淘汰且排在 X/B 之前',()=>{
  const five=E.deriveParentDegree(parentTree('driving'));
  assert.equal(five.primary.key,'impulse');
  const x=five.survivors.find(c=>c.key==='combination');
  assert.ok(x,'X 连接浪读法仍保留（反弹可为 X 的第一段）');
  assert.match(x.basis,/第一段/);
  const three=E.deriveParentDegree(parentTree('corrective'));
  assert.equal(three.primary.key,'combination');
  assert.ok(three.eliminated.some(c=>c.key==='impulse'),'三波反弹不能是新推动');
});

// 逆势框架B"末浪未完"：极值后的逆势走势是末浪内部回撤，同样受末浪起点约束。
function counterTree(patternId,prices,after) {
  const pts=prices.map((price,i)=>pv(i*10,i%2===0?'H':'L',price));
  const cand={patternId,klass:'corrective',direction:'down',points:pts,manual:{label:patternId},children:[],score:{tier1:0,tier2:0,failed:[],verificationStatus:'pending'}};
  const tail=after.map((price,i)=>({...pv(pts.at(-1).index+5*(i+1),i%2===0?'H':'L',price),provisional:i===after.length-1}));
  return {tree:{primary:cand,alternates:[]},fine:[...pts,...tail]};
}

test('末浪为驱动腿（单锯齿 c）：反弹越过 c 起点即排除末浪延伸读法',()=>{
  const {tree,fine}=counterTree('zigzag',[100,60,80,50],[85,70]);
  const b=E.buildCounterTrendFrameworkB(tree,fine,[]);
  assert.equal(b.primary,null);
  assert.equal(b.excluded.length,1);assert.equal(b.excluded[0].counterExtreme,85);assert.equal(b.excluded[0].finalLegFrom,80);
  const ok=E.buildCounterTrendFrameworkB(counterTree('zigzag',[100,60,80,50],[75,70]).tree,counterTree('zigzag',[100,60,80,50],[75,70]).fine,[]);
  assert.ok(ok.primary && ok.primary.finalWaveInProgress,'反弹未过起点 80 时保留');
});

test('末浪可为平台/三角（联合形 y）：越过起点须 b′<2a′',()=>{
  const near=counterTree('sideways-double',[100,60,75,50],[78,70]); // 越过 3 < a′=25
  assert.ok(E.buildCounterTrendFrameworkB(near.tree,near.fine,[]).primary);
  const far=counterTree('sideways-double',[100,60,75,50],[101,90]); // 越过 26 ≥ 25
  assert.equal(E.buildCounterTrendFrameworkB(far.tree,far.fine,[]).primary,null);
  const dz=counterTree('zigzag-double',[100,60,75,50],[78,70]); // 双锯齿 y 为单锯齿：b<a，不得越过
  assert.equal(E.buildCounterTrendFrameworkB(dz.tree,dz.fine,[]).primary,null);
});

test('锯齿类调整腿与驱动腿一样不得越过起点',()=>{
  const pts=[pv(0,'H',100),pv(10,'L',60),pv(20,'H',80),pv(30,'L',40)];
  const seg=[pts[0],pv(3,'L',90),pv(6,'H',102),...pts.slice(1)];
  assert.equal(E.legOriginStrict(pat('zigzag-double'),0),true);
  assert.equal(E.legsRespectOrigin(pts,seg,pat('zigzag-double')),false,'w 为单锯齿，越过起点 100 淘汰');
  assert.equal(E.legsRespectOrigin(pts,seg,pat('sideways-double')),true,'联合形 w 可为平台：越过 2 < a′=10 允许');
});

test('末浪延伸投影按各候选自己的末腿：主选被排除后不得沿用主选末腿幅度',()=>{
  const {tree,fine}=counterTree('zigzag',[100,60,80,50],[85,70]); // 主选 c 从 80 起，被 85 否定
  const alt={...tree.primary,points:[pv(0,'H',100),pv(5,'L',70),pv(8,'H',95),pv(30,'L',50)]}; // c 从 95 起，幅 45
  const b=E.buildCounterTrendFrameworkB({primary:tree.primary,alternates:[alt]},fine,[]);
  assert.equal(b.excluded.length,1);
  assert.equal(b.primary.points[2].price,95);
  assert.deepEqual(b.primary.projection.map(t=>+t.price.toFixed(2)),[32.81,22.19,5],'50 − 45×0.382/0.618/1.0');
  assert.equal(b.primary.finalLegFrom.price,95);
});

test('简报形态简称保留具体楔形名',()=>{
  assert.equal(E.briefPatternName('驱动浪（楔形 Diagonal，位置待定）'),'楔形');
  assert.equal(E.briefPatternName('驱动浪（扩散终结楔形；专章待补）'),'扩散终结楔形');
  assert.equal(E.briefPatternName('推动浪（引导楔形 Leading Diagonal）'),'引导楔形');
  assert.equal(E.briefPatternName('单锯齿（Zigzag 5-3-5）'),'单锯齿');
});

test('反弹后的续跌浪目标从反弹终点起算：Z 比上一子浪、C 比整段 A',()=>{
  const pts=[pv(0,'H',126296),pv(5,'L',60001),pv(8,'H',82814.23),pv(10,'L',57717.55)];
  const h=E.bounceHypotheses(pts,'corrective',87397);
  assert.equal(h.anchor,87397);
  assert.equal(h.xx.ref,'whole','反弹 87397 越过末腿起点 82814.23，X 改按整段 W 度量');
  assert.deepEqual(h.xx.down.map(t=>+t.price.toFixed(2)),[45015.52,18818.55,-23562.93],'87397 − 68578.45×0.618/1/1.618（整段 W）');
  assert.deepEqual(h.b.down.map(t=>+t.price.toFixed(2)),[45015.52,18818.55,-23562.93],'87397 − 68578.45×0.618/1/1.618');
  assert.equal(E.bounceHypotheses(pts,'corrective',null).anchor,57717.55,'无反弹极值时退回结构终点');
  assert.equal(E.bounceHypotheses(pts,'corrective',50000).anchor,57717.55,'反弹极值没越过结构终点时不采用');
});

test('X 连接浪：反弹未越过末腿起点仍按上一子浪，越过则改按整段 W 并注明',()=>{
  const pts=[pv(0,'H',126296),pv(5,'L',60001),pv(8,'H',82814.23),pv(10,'L',57717.55)];
  const lo=E.bounceHypotheses(pts,'corrective',80000);
  assert.equal(lo.xx.ref,undefined);
  assert.equal(lo.xx.downRefCn,'上一子浪');
  assert.ok(Math.abs(lo.xx.targets[0].price-(57717.55+0.2*lo.lastSub))<1e-6,'目标按末腿 0.2');
  const mdLo=E.renderBounceHypotheses({...lo,lean:'xx',parentKey:'zigzag'},null,2);
  assert.match(mdLo,/对上一子浪（82814\.23→57717\.55/);
  assert.doesNotMatch(mdLo,/改按整段 W/);

  const hi=E.bounceHypotheses(pts,'corrective',87397);
  assert.equal(hi.xx.ref,'whole');
  assert.equal(hi.xx.refLastSubBroken,true);
  assert.ok(Math.abs(hi.xx.targets[0].price-(57717.55+0.2*68578.45))<1e-6,'目标按整段 W 0.2（≈71433）');
  assert.ok(Math.abs(hi.xx.targets[2].price-(57717.55+0.618*68578.45))<1e-6);
  const md=E.renderBounceHypotheses({...hi,lean:'three',parentKey:'impulse'},null,2);
  assert.match(md,/对W 浪整体（126296→57717\.55/);
  assert.match(md,/反弹已越过末腿起点 82814\.23/);
  assert.doesNotMatch(md,/涨过前高都行/);
  assert.match(md,/双锯齿的 x 须小于 W 的 100%.*联合形的 x.*1\.5 倍/);
});

// 轴②进行腿：摆动极值之后回撤了好几段（87395.67→79800→84898→79220.74→81033.69），终点与投影起点要锚在
// 回撤极值（对应 79220.74），不能锚在最后一个枢轴（对应 81033.69 那个小反抽高点）。
// BTCUSDT 日线 2025-10-05~2026-10-25（Binance）：57800.19→87395.67 五浪上冲，之后回撤至 79220.74、反抽 81033.69
let btcusdtCache=null;
function btcusdtTree() {
  if(!btcusdtCache) {
    const c=require('./fixtures/btcusdt-1d-20261025.json').map((v,index)=>({...v,index}));
    const f=E.anchorBoundaryExtremes(c,E.detectPivots(c,1,{}));
    btcusdtCache={tree:E.buildCountTree(f,c,{maxDepth:5,beamK:3}),fine:f,candles:c};
  }
  return btcusdtCache;
}

// 与真实报告同路径：日线树 + 小周期复核。浪(1) 57800.19→66956.15 在日线上有 07-06 外包线的 64700 / 61544.56，
// 拆出的第 3 浪终点 64692.83 差 7.17 没越过第 1 浪终点 64700，日线判不成五浪；须用小时线（聚合 4h）复核成引导楔形。
// 夹具只含浪(1) 这 22 天的小时线，其余腿缺数据照常按日线计。
let btcusdtVerifiedCache=null;
function btcusdtVerifiedTree() {
  if(!btcusdtVerifiedCache) {
    const {buildVerifiedCountTree}=require('../wave-subwave-verification');
    const hourly=require('./fixtures/btcusdt-1h-wave1-202607.json');
    const c=require('./fixtures/btcusdt-1d-20261025.json').map((v,index)=>({...v,index}));
    const f=E.anchorBoundaryExtremes(c,E.detectPivots(c,1,{}));
    btcusdtVerifiedCache=buildVerifiedCountTree(E,f,c,{maxDepth:5,beamK:3,product:'BTC-USD',mainTf:'1d',
      fetchHourly:async(_,g,a,b)=>hourly.filter(x=>x.timestamp>=a.getTime()/1000&&x.timestamp<=b.getTime()/1000)})
      .then(({tree})=>({tree,fine:f,candles:c}));
  }
  return btcusdtVerifiedCache;
}

function pullbackFixture(prices) {
  const fine=prices.map((price,i)=>pv(i*10,i%2===0?'L':'H',price));
  const candles=Array.from({length:(prices.length-1)*10+1},(_,i)=>{const k=Math.min(Math.floor(i/10),prices.length-2),f=(i-k*10)/10,v=prices[k]+(prices[k+1]-prices[k])*f;return {index:i,timestamp:i*86400,open:v,close:v,high:v,low:v,volume:1};});
  return {fine,candles};
}

test('轴②进行腿终点与下一浪投影起点取 ext 之后的回撤极值，而非最后一个枢轴',()=>{
  const {fine,candles}=pullbackFixture([100,140,120,130,115,122]);
  const cws=E.buildCurrentWaveStructures(fine,fine[0],candles,{pricePrecision:2});
  assert.equal(cws.now,122,'now 仍是最后一个枢轴（兼容旧字段）');
  assert.deepEqual(cws.pullbackExtreme,{price:115,type:'L',timestamp:40*86400});
  assert.deepEqual(cws.lastPivot,{price:122,type:'H',timestamp:50*86400});
  const t2=cws.structures.find(s=>s.id==='connector-bx');
  assert.deepEqual(t2.legs.map(l=>[l.name,l.from,l.to]),[['a',100,140],['b',140,115],['c',115,null]]);
  assert.deepEqual(t2.projection.map(p=>+p.price.toFixed(2)),[139.72,155],'c 腿从 115 起量 0.618/1.0×a');
  const t3=cws.structures.find(s=>s.id==='reverse-impulse-2');
  assert.deepEqual(t3.legs.slice(1).map(l=>[l.name,l.from,l.to]),[['②',140,115],['③',115,null]]);
  assert.deepEqual(t3.projection.map(p=>+p.price.toFixed(2)),[155,179.72],'③ 从 115 起量 1.0/1.618×①');

  const md=E.renderCurrentWaveStructures({currentWaveStructures:cws,pricePrecision:2},2,{lastClose:119.5});
  assert.match(md,/100 → 140（摆动极值）→ 115（回撤低点 @ [^）]+）\*\*；最近高点 122 @ [^；]+；现价 119\.5；/,'回撤极值、最近枢轴、现价三者分开标注');
  assert.match(md,/b:140→115⏳\(进行中\) c:115→\?…\(未走\)/);
  assert.match(md,/> ⏳\(进行中\)=还没走完的腿，…\(未走\)=尚未开始、只给投影/);
  assert.doesNotMatch(md,/(b|②):140→122/,'最后一个枢轴不应再当作 b/② 进行腿终点');
});

test('轴②最后一个枢轴本身就是回撤极值时，仍标「最近低点」且不重复另标',()=>{
  const {fine,candles}=pullbackFixture([100,140,120,130,115]);
  const cws=E.buildCurrentWaveStructures(fine,fine[0],candles,{pricePrecision:2});
  assert.equal(cws.pullbackExtreme.price,115);
  const md=E.renderCurrentWaveStructures({currentWaveStructures:cws,pricePrecision:2},2,{lastClose:116});
  assert.match(md,/→ 115（最近低点 @ [^）]+）\*\*；现价 116；/);
  assert.doesNotMatch(md,/最近高点/);
});

// 轴②软分 = 已验证腿数 + 上冲段性格契合度；已验证腿数不得覆盖性格信号（pullback-anchored-to-axis2 §1）
test('轴②上冲段五浪时转势排在中继之前，三波时中继在前，软分来源可追溯',async()=>{
  const order=(cws)=>{const ids=cws.structures.map(s=>s.id);return {i2:ids.indexOf('reverse-impulse-2'),ib:ids.indexOf('connector-bx')};};
  // 五浪：BTCUSDT 日线 57800.19→87395.67 上冲段，浪(1) 经小时线复核（合成折线判不出五浪，用真实 K 线）
  const {tree}=await btcusdtVerifiedTree();
  const five=tree.currentWaveStructures;
  assert.equal(five.leg1Char,'driving','BTC 上冲段应为五浪');
  assert.equal(tree.inProgressStruct.swingChar,five.leg1Char,'轴②与轴③性格同源（任务 1.3）');
  const t3=five.structures.find(s=>s.id==='reverse-impulse-2'),t2=five.structures.find(s=>s.id==='connector-bx');
  assert.equal(t3.tier1,t2.tier1,'两条情景硬约束违规数相同，比的是软分');
  assert.equal(t3.charFit,1);assert.equal(t2.charFit,0);
  const o5=order(five);
  assert.ok(o5.i2<o5.ib,'五浪→转势在前');
  assert.equal(five.structures[0].id,'reverse-impulse-2','BTC 轴②第 1 名为转势，与轴③主选一致');
  assert.equal(t3.softReasons.length,2);
  assert.match(t3.softReasons[0],/^已验证腿 \d+ 条$/);
  assert.match(t3.softReasons[1],/上冲段五浪，契合/);
  assert.deepEqual(five.rallyStart.price,57800.19);
  assert.deepEqual(five.swingExtreme.price,87395.67);

  const {fine,candles}=pullbackFixture([100,130,115,150,135,142]);
  const three={cws:E.buildCurrentWaveStructures(fine,fine[0],candles,{pricePrecision:2})};
  Object.assign(three,order(three.cws));
  assert.equal(three.cws.leg1Char,'corrective','夹具上冲段应为三波');
  const t3c=three.cws.structures.find(s=>s.id==='reverse-impulse-2'),t2c=three.cws.structures.find(s=>s.id==='connector-bx');
  if(t3c.tier1===t2c.tier1) assert.ok(three.ib<three.i2,'三波→中继在前');
  assert.match(t2c.softReasons[1],/上冲段三波，契合/);
});

// pullback-anchored-to-axis2 §2/§3：回撤身份、约束与去向取自轴②
test('角色约束常量与书页码一致',()=>{
  const R=E.AXIS2_ROLE_RULES;
  assert.deepEqual(Object.keys(R).sort(),['connector-bx','cont-impulse-3','reverse-impulse-2']);
  assert.equal(R['reverse-impulse-2'].touchAllowed,false,'② 不得触及①起点（p0083）');
  assert.equal(R['reverse-impulse-2'].timeMax,9,'② 时间 ≤ 9 倍①（p0094）');
  assert.deepEqual(R['reverse-impulse-2'].aRatioTypical,[0.31,0.5],'(a) 常为①的 0.31~0.5（p0154）');
  assert.ok(R['reverse-impulse-2'].refs.includes('ch007 p0200'),'② 不可为收缩三角形');
  assert.equal(R['connector-bx'].touchAllowed,true,'单锯齿 b 可到 a 起点（p0083/p0086）');
  assert.equal(R['connector-bx'].timeMax,10);
  assert.deepEqual(R['connector-bx'].timeTypical,[0.618,1.618]);
  assert.equal(R['cont-impulse-3'].mustDrive,true);
});

test('BTC 身份对照：两条存活情景按轴②排名，约束、时间窗与 (a) 测算按书；违规情景不列',async()=>{
  const {tree,candles}=await btcusdtVerifiedTree();
  const cws=tree.currentWaveStructures;
  const {roles,t4Alive}=E.buildAxis2Roles(cws,{candles,aEnd:{price:79220.74},internalForms:[{label:'单锯齿（Zigzag 5-3-5）'}]});
  assert.equal(t4Alive,false,'T4 有违规，不出备注');
  assert.deepEqual(roles.map(r=>[r.rank,r.id,r.legCn]),[[1,'reverse-impulse-2','浪②'],[2,'connector-bx','b 腿']],'cont-impulse-3 有违规不列');
  const [r2,rb]=roles;
  assert.deepEqual(r2.priceLimit,{price:57800.19,touchAllowed:false});
  assert.deepEqual(rb.priceLimit,{price:57800.19,touchAllowed:true});
  assert.equal(r2.time.refBars,82,'浪① 2026-07-01→09-21');
  assert.equal(r2.time.elapsedBars,34,'夹具末根 2026-10-25');
  assert.equal(r2.time.typical,null,'② 无常见时间窗');
  const day=ts=>new Date(ts*1000).toISOString().slice(0,10);
  assert.deepEqual([day(rb.time.typical.from),day(rb.time.typical.to)],['2026-11-11','2027-02-01'],'b 常见 0.618~1.618 倍 a');
  assert.equal(+r2.aRatio.value.toFixed(3),0.276);
  assert.deepEqual([r2.aRatio.from,r2.aRatio.to,r2.aRatio.refFrom,r2.aRatio.refTo],[87395.67,79220.74,57800.19,87395.67],'(a) 与浪①起止价');
  assert.deepEqual(r2.aRatio.typicalPrices.map(p=>+p.toFixed(2)),[78221.07,72597.93],'常见 0.31~0.5 倍对应的 (a) 终点价');
  assert.equal(rb.aRatio,null);
  assert.deepEqual(r2.next,{legName:'浪③',projection:[108816.22,127106.23].map(v=>r2.next.projection.find(p=>Math.abs(p-v)<0.01))});
  assert.equal(rb.next.legName,'c 腿');

  const allBad={...cws,structures:cws.structures.map(s=>({...s,tier1:1}))};
  assert.deepEqual(E.buildAxis2Roles(allBad,{candles}).roles,[],'无存活情景返回空数组');
});

// 合成轴②：spanLast L100(第0根) → ext H140(第10根) → 回撤，K 线时间戳可自定（测不等距）
function synthCws(structures,ts=(i)=>i*86400){
  const candles=Array.from({length:21},(_,i)=>({index:i,timestamp:ts(i)}));
  return {candles,cws:{spanLast:100,ext:140,leg1Char:'driving',rallyStart:{price:100,type:'L',timestamp:ts(0)},swingExtreme:{price:140,type:'H',timestamp:ts(10)},structures}};
}
const synthTpl=(id,tier1,legs,projection=[])=>({id,label:id,tendency:'',tier1,legs,projection:projection.map(price=>({price}))});

test('续行浪③存活时列身份并标出与回撤三波内部的冲突（只作证据）',()=>{
  const {cws,candles}=synthCws([synthTpl('cont-impulse-3',0,[{name:'①',from:90,to:100,status:'完成'},{name:'②',from:100,to:140,status:'完成'},{name:'③',from:140,to:120,status:'⏳进行中'}],[130,125])]);
  const {roles}=E.buildAxis2Roles(cws,{candles,internalForms:[{label:'单锯齿（Zigzag 5-3-5）'}]});
  assert.equal(roles.length,1);
  assert.equal(roles[0].legCn,'浪③');
  assert.equal(roles[0].priceLimit,null);
  assert.equal(roles[0].time,null);
  assert.equal(roles[0].forms.conflict,'回撤内部读成三波调整，与浪③须为五浪不符');
  assert.deepEqual(roles[0].next,{legName:'浪③目标',projection:[130,125]});
  assert.equal(E.buildAxis2Roles(cws,{candles,internalForms:[]}).roles[0].forms.conflict,null,'内部形态待明时不判冲突');
});

test('不等距 K 线（跨周末）时间窗按平均根距换算，不被最后一对间距放大',()=>{
  // 每 5 根交易日跳过 2 天周末；最后一对恰好跨周末（3 天）
  const ts=(i)=>(i+Math.floor(i/5)*2)*86400;
  const {cws,candles}=synthCws([synthTpl('connector-bx',0,[{name:'a',from:100,to:140,status:'完成'},{name:'b',from:140,to:120,status:'⏳进行中'},{name:'c',from:120,to:null,status:'未走'}])],ts);
  const r=E.buildAxis2Roles(cws,{candles}).roles[0];
  const avg=(ts(20)-ts(0))/20;
  assert.equal(r.time.typical.to,ts(10)+Math.round(1.618*10)*avg,'用平均根距');
  assert.ok(ts(20)-ts(19)>avg,'夹具最后一对间距大于平均');
});

test('轴③与轴②上冲段性格不一致时身份表加备注；两处摆动极值不一致时不硬套身份',async()=>{
  const nr={tf:'1d',level:{},structureLine:120,axis2Roles:[{rank:1,label:'X',legCn:'浪②',refCn:'浪①',priceLimit:null,time:null,aRatio:null,forms:{text:'',conflict:null},next:{legName:'浪③',projection:[]},refs:[]}],axis2CharMismatch:true};
  assert.match(E.renderPullbackLegDetail(nr,2),/轴③主选按另一口径判定上冲段性格，与本表排序可能不同/);
  assert.doesNotMatch(E.renderPullbackLegDetail({...nr,axis2CharMismatch:false},2),/另一口径/);

  const {tree,fine,candles}=await btcusdtVerifiedTree();
  const shifted={...tree,currentWaveStructures:{...tree.currentWaveStructures,ext:tree.currentWaveStructures.ext+1},inProgressStruct:{...tree.inProgressStruct,pullback:{...tree.inProgressStruct.pullback}}};
  const out=await E.enrichCurrentPullback(shifted,{product:'BTC-USD',mainTf:'1d',finePivots:fine,candles},async()=>{throw new Error('不应下钻');});
  assert.deepEqual(out.axis2Roles,[],'cws.ext 与回撤高点不一致时身份为空');
  assert.match(out.text,/轴②暂无存活情景/);
});

test('回撤位与 (z) 档位相距 ≤1% 标共振',()=>{
  const zt={breakPath:{main:{low:75356.43,high:76201.02},extension:[{price:73812.22}],extreme:[{price:73543.48},{price:71847.88}]}};
  const lv=E.retraceLevelsWithConfluence([{mult:0.382,price:76090.2},{mult:0.5,price:72597.93},{mult:0.618,price:69105.66}],zt);
  assert.deepEqual(lv[0].confluence.map(z=>z.label),['(z) 主带'],'0.382 落在主带内');
  assert.deepEqual(lv[1].confluence,[],'0.5 距极端档 71847.88 为 1.03%，超出 1% 不算共振');
  assert.deepEqual(lv[2].confluence,[]);
  assert.deepEqual(E.retraceLevelsWithConfluence([{mult:0.382,price:100}],null)[0].confluence,[]);
});

test('BTC 全流程：进行腿细化归轴②、回撤目标位归轴③，去向取自轴②，JSON 新增字段',async()=>{
  const {tree,fine,candles}=await btcusdtVerifiedTree();
  tree.pricePrecision=2; // 真实流程由取数精度设置
  const nr=await E.enrichCurrentPullback(tree,{product:'BTC-USD',mainTf:'1d',finePivots:fine,candles},async()=>{throw new Error('日线足够，不应下钻');});
  assert.equal(nr.axis2Roles.length,2);
  assert.equal(nr.afterUpgrade.basis,'axis2');
  assert.equal(nr.retraceLevels[0].confluence[0].label,'(z) 主带');
  const md=E.renderMarkdownReport({product:'BTC-USD',timeframe:'1d',startUtc:new Date().toISOString(),endUtc:new Date().toISOString(),generatedAtUtc:new Date().toISOString(),source:'fixture',sampleCount:candles.length,lastClose:80154.09},tree);
  const i2=md.indexOf('# 轴②'),i3=md.indexOf('# 轴③'),iLeg=md.indexOf('## 进行腿细化'),iTgt=md.indexOf('## 回撤目标位');
  assert.ok(i2<iLeg&&iLeg<i3,'进行腿细化在轴②内');
  assert.ok(iTgt>i3,'回撤目标位在轴③内');
  assert.ok(!md.includes('当前高点回撤研判'));
  assert.match(md,/\| 1 \| 新上涨推动·浪②进行中\(转势\) \| 浪② \| 不得触及 57800\.19 \|/);
  assert.match(md,/读法一若为单锯齿：\(a\) 87395\.67→79220\.74 跌 8174\.93，是浪①（57800\.19→87395\.67，涨 29595\.48）的 0\.276 倍；常见 0\.31～0\.5 倍，对应 \(a\) 终点 78221\.07～72597\.93，现在跌得偏浅（指引）/);
  assert.match(md,/0\.382 → \*\*76090\.2\*\*（共振：\(z\) 主带 75356\.43–76201\.02）/);
  assert.match(md,/已跌破升级线 [0-9.]+：前段上涨视为已走完（轴②各情景把它当作完整的首腿）；本回撤走完后：#1 新上涨推动·浪②进行中\(转势\) → 浪③/);
  assert.doesNotMatch(md,/按轴③主选（/);
  const seg=md.slice(iLeg,i3);
  assert.doesNotMatch(seg,/(?<![(（/#|])\b[abcwxyz] 浪|\b[WXYZ] 浪|XX/,'腿内部浪名不出现裸字母');
  const json=E.serializeInProgress?E.serializeInProgress(tree):null;
  if(json) assert.ok(json.currentPullback.narrative.axis2Roles.length===2);
});

test('T4 ⑤进行中：⑤ 终点取 ④ 之后的极值；已越过的常用倍数记已到，全到则注明延长浪',()=>{
  const prices=[100,110,105,112,107,140,130],fine=prices.map((price,i)=>({...pv(i*10,i%2===0?'L':'H',price),provisional:i===prices.length-1}));
  const candles=Array.from({length:61},(_,i)=>{const k=Math.min(Math.floor(i/10),prices.length-2),f=(i-k*10)/10,v=prices[k]+(prices[k+1]-prices[k])*f;return {index:i,timestamp:i*86400,open:v,close:v,high:v,low:v,volume:1};});
  const cws=E.buildCurrentWaveStructures(fine,fine[0],candles,{pricePrecision:2});
  const t4=cws.structures.find(s=>s.id==='reverse-impulse-5');
  assert.equal(t4.legs[4].to,140,'⑤ 已走到 140，不是现价 130');
  assert.match(t4.currentWave,/已至 140，现回撤中/);
  assert.equal(t4.projection.length,0,'常用倍数 114.4/117/119/123.2 都已被 140 越过');
  assert.equal(t4.projectionReached.length,4);
  const md=E.renderCurrentWaveStructures({currentWaveStructures:{...cws,structures:[t4]},pricePrecision:2},2);
  assert.match(md,/常用倍数均已到（114\.42 \/ 117 \/ 119 \/ 123\.18），⑤为延长浪/);
});

test('已走完段内部：单锯齿首段取真低点 79800（引导楔形 3 浪长于 1 浪只违指引），各段终点均为跨度极值',()=>{
  const {fine,candles}=btcusdtTree();
  const i=fine.findIndex(p=>p.price===87395.67);
  const sp=E.splitPullbackAtLow(fine.slice(i),true);
  const {patterns}=E.analyzePullbackCompleted(sp.completed,candles);
  const zz=patterns.find(p=>/单锯齿/.test(p.label));
  assert.deepEqual(zz.points.map(p=>p.price),[87395.67,79800,84898,79220.74]);
  assert.deepEqual(zz.beyondEnds,[],'不再需要失败第五浪注释');
  const flat=patterns.find(p=>/平台形/.test(p.label));
  assert.deepEqual(flat.beyondEnds,[],'各段终点都是跨度极值时为空');
});

test('引导楔形：3 浪长于 1 浪只是指引，边界收敛仍是硬规则（BTC 87395.67→79800：1 浪 4832.67、3 浪 6826.44）',()=>{
  const {candles}=btcusdtTree();
  const pts=E.pointsFromPrices([87395.67,82563,87220,80393.56,84352,79800],candles);
  const manual=E.buildDiagonalManual('down','leading');
  const failed=manual.rules.filter(r=>!r.test({points:pts,candles}).pass).map(r=>r.id);
  assert.deepEqual(failed,[],'含 boundaries-converge 在内的硬规则全过');
  const g=manual.guidelines.find(x=>x.id==='diagonal.ratio.converging');
  assert.equal(g.kind,'guideline');
  assert.equal(g.test({points:pts,candles}).pass,false,'长度不递减只是没命中指引');
  const exp=E.buildDiagonalManual('down','ending');
  assert.ok(!exp.rules.some(r=>r.id==='diagonal.ratio.converging'));
});

test('legBeyondEnds：上行腿同样识别；末腿不查（末腿终点即真低点）',()=>{
  const pts=[pv(0,'L',100),pv(10,'H',120),pv(20,'L',105),pv(30,'H',130)];
  const fine=[pts[0],pv(4,'H',125),pv(7,'L',112),pts[1],pts[2],pv(25,'H',140),pts[3]];
  assert.deepEqual(E.legBeyondEnds(pts,fine).map(b=>[b.leg,b.beyond.price]),[[0,125]]);
});

test('读法三数据：未跌破 (a) 终点才给；跌破、无读法一或只有三角形时为 null',()=>{
  const hd={state:'below',aEnd:{price:79220.74,timestamp:1},extreme:{price:87395.67,timestamp:0},bounce:{price:81033.69,timestamp:2},line70:84943.19,regularCap:87395.67};
  const pats=[{label:'单锯齿（Zigzag 5-3-5）',points:[{price:87395.67},{price:80684.36},{price:84898},{price:79220.74}]}];
  const roles=[{rank:1,label:'转势',legCn:'浪②',refCn:'浪①',next:{legName:'浪③',projection:[108816.22]},aRatio:{refAmp:29595.48,typical:[0.31,0.5],typicalPrices:[78221.07,72597.93]}}];
  const cr=E.buildCompletedReading({hd,patterns:pats,roles});
  assert.equal(cr.invalidation,79220.74);
  assert.equal(cr.nextLegs[0].nextLeg,'浪③');
  assert.equal(+cr.zigzagA.value.toFixed(3),0.227,'浪②的 (a) 取单锯齿首段 87395.67→80684.36');
  assert.equal(E.buildCompletedReading({hd:{...hd,state:'broken'},patterns:pats,roles}),null);
  assert.equal(E.buildCompletedReading({hd:null,patterns:pats,roles}),null);
  assert.equal(E.buildCompletedReading({hd,patterns:[{label:'收缩三角形（a-b-c-d-e）'}],roles}),null);
  const generic=E.buildCompletedReading({hd,patterns:pats,roles:[]});
  assert.equal(generic.zigzagA,null);
  const txt=E.renderCompletedReading(generic,v=>v.toFixed(2),p=>p.price.toFixed(2)).join('\n');
  assert.match(txt,/整段看作已走完的进行中腿/);
  assert.match(txt,/就是下一腿的开头/);
  assert.doesNotMatch(txt,/浪③|c 腿/,'无轴②身份时不写具体下一腿');
});

test('BTC 全流程：读法三（⏳ 腿已在 79220.74 走完）与读法一 / 读法二并列，轴③补否定线与去向',async()=>{
  const {tree,fine,candles}=await btcusdtVerifiedTree();
  tree.pricePrecision=2;
  const nr=await E.enrichCurrentPullback(tree,{product:'BTC-USD',mainTf:'1d',finePivots:fine,candles},async()=>{throw new Error('日线足够，不应下钻');});
  const cr=nr.completedReading;
  assert.equal(cr.legEnd.price,79220.74);
  assert.equal(cr.invalidation,79220.74);
  assert.deepEqual(cr.nextLegs.map(x=>x.nextLeg),['浪③','c 腿']);
  assert.deepEqual([cr.zigzagA.from,cr.zigzagA.to],[87395.67,79800]);
  const txt=nr.text;
  assert.match(txt,/\*\*87395\.67→79220\.74 这段的内部\*\*：/);
  assert.match(txt,/\*\*单锯齿（Zigzag 5-3-5） \/ 双锯齿（Double Zigzag w-x-y）\*\*（87395\.67 @2026-09-21 → 79800 @2026-10-15 → 84898 @2026-10-21 → 79220\.74 @2026-10-24）/);
  assert.match(txt,/单锯齿与双锯齿是同一组拐点，区别在首段内部：单锯齿要求首段为五浪（推动浪或引导楔形），双锯齿要求 \(w\) 为三波。/);
  assert.doesNotMatch(txt,/失败第五浪/);
  assert.match(txt,/读法三把这段看作整条 ⏳\(进行中\)腿（已走完），读法一把它看作 \(a\)\/\(w\)，读法二另把它拆成 \(w\)\(x\)\(y\)/);
  assert.match(txt,/是否到头见下方「读法一」与「读法三」/);
  assert.match(txt,/\*\*读法三（⏳\(进行中\)腿已在 79220\.74 走完）\*\*：把 87395\.67（2026-09-21）→79220\.74（2026-10-24）整段看作已走完的 浪② \/ b 腿/);
  assert.match(txt,/79220\.74 之后的反弹（最高 81033\.69）就是 浪③ \/ c 腿 的开头/);
  assert.match(txt,/若浪②为单锯齿，其 \(a\) 是单锯齿首段 87395\.67→79800，跌 7595\.67，是浪①的 0\.257 倍（常见 0\.31～0\.5 倍，对应 \(a\) 终点 78221\.07～72597\.93，指引）/);
  assert.match(txt,/跌破 \*\*79220\.74\*\* 只否定"⏳\(进行中\)腿在 79220\.74 走完"，不否定形态本身：腿未完，可能是同一形态末段继续走（见下方「末段延伸」），也可能回到读法一 \/ 读法二/);
  assert.doesNotMatch(txt,/即否定本读法/);
  assert.match(txt,/浪③ \/ c 腿须为五浪驱动，而读法一的 \(b\)\/\(x\) 须为三波：冲过 84943\.19 后两种读法都相容/);
  assert.match(txt,/越过 87395\.67 则单锯齿 \/ 双锯齿 \/ 规则平台形读法被排除、本读法得到支持（浪③ 须长于浪②，即须越过浪① 终点；c 腿通常越过 a 终点）/);
  assert.doesNotMatch(txt,/守住.{0,12}(即|就是)回撤(已)?结束/);
  const leg=E.renderPullbackLegDetail(nr,2),tgt=E.renderPullbackTargets(nr,2);
  assert.ok(leg.indexOf('**读法三（')>leg.indexOf('**读法二（'),'读法三列在读法二之后');
  assert.match(tgt,/\*\*若读法三成立\*\*（⏳\(进行中\)腿已在 79220\.74 走完）：下方不再有回撤目标，跌破 \*\*79220\.74\*\* 即否定"在此走完"（形态本身未必作废，见下方末段延伸）；上方按轴②——#1 新上涨推动·浪②进行中\(转势\) → 浪③ 108816\.22/);
  assert.doesNotMatch(leg.slice(leg.indexOf('**读法三（')),/(?<![(（/#|])\b[abcwxyz] 浪|\b[WXYZ] 浪|XX/,'读法三不出现裸字母浪名');
});

test('末段延伸数据：BTC 三种形态的常见目标、指引线、规则失效价与时间上限由引擎规则算出，并标共振',async()=>{
  const {tree,fine,candles}=await btcusdtVerifiedTree();
  tree.pricePrecision=2;
  const nr=await E.enrichCurrentPullback(tree,{product:'BTC-USD',mainTf:'1d',finePivots:fine,candles},async()=>{throw new Error('日线足够，不应下钻');});
  const ext=nr.extensionReading;
  const r2=v=>+v.toFixed(2);
  assert.equal(ext.trigger,79220.74);
  assert.equal(ext.state,'below');
  assert.deepEqual(ext.forms.map(f=>f.kind),['zigzag','zigzag-double','flat','sideways']);
  const [zz,dz,flat,sw]=ext.forms;
  assert.deepEqual(dz.points.map(p=>p.price),[87395.67,79800,84898,79220.74]);
  assert.equal(r2(dz.ratioNow),0.75);
  assert.deepEqual(dz.commons.map(t=>[t.mult,r2(t.price),t.reached]),[[1,77302.33,false],[1.618,72608.21,false]],'(y) 按 (w)=7595.67 自 84898 量');
  assert.deepEqual([r2(dz.usualMin.price),dz.usualMin.reached],[78061.9,false]);
  assert.equal(r2(dz.guide.price),71089.07);
  assert.equal(r2(dz.limit.price),46919.65,'(y) < 5×(w)');
  assert.equal(dz.limit.ruleId,'zigzag-double.ratio.y-lt-5w');
  assert.deepEqual([dz.time.maxBars,dz.time.elapsedBars],[120,4],'(y) ≤ 5×(w) 的 24 根');
  assert.deepEqual(dz.commons[1].confluence.map(z=>z.label),['回撤位 0.5']);
  assert.deepEqual(zz.points.map(p=>p.price),[87395.67,79800,84898,79220.74]);
  assert.deepEqual(zz.commons.map(t=>[t.mult,r2(t.price),t.reached]),[[0.618,80203.88,true],[1,77302.33,false],[1.618,72608.21,false]]);
  assert.equal(r2(zz.guide.price),72608.21);
  assert.equal(r2(zz.limit.price),59408,'(c) < 5×(b)：84898−5×5098');
  assert.equal(zz.limit.ruleId,'zigzag.ratio.c-between-0.9b-and-5b');
  assert.deepEqual([zz.time.maxBars,zz.time.elapsedBars],[60,4],'(c) ≤ 10×(b) 的 6 根');
  assert.deepEqual(zz.commons[1].confluence.map(z=>z.label),['(z) 破位档']);
  assert.deepEqual(flat.commons.map(t=>t.reached),[true,true],'平台形常见倍数均已到');
  assert.equal(r2(flat.ratioNow),1.66);
  assert.equal(r2(flat.guide.price),78434.21);
  assert.equal(r2(flat.limit.price),74129.1,'(c) 运行总量 ≤ 2×max((a),(b)) = 2×6545.45，自 87220 量净幅度');
  assert.equal(flat.limit.basis,'gross-latest');
  assert.deepEqual([flat.time.maxBars,flat.time.elapsedBars],[40,23]);
  assert.equal(sw.limit,null);
  assert.equal(sw.time.maxBars,35,'(y) ≤ 5×(w) 的 7 根');
  assert.equal(new Date(sw.time.until*1000).toISOString().slice(0,10),'2026-11-25');
  assert.equal(new Date(flat.time.until*1000).toISOString().slice(0,10),'2026-11-11');
});

test('末段延伸渲染：轴②说明否定只针对"在此走完"，轴③逐形态列目标与失效，并给最早到期的时间上限',async()=>{
  const {tree,fine,candles}=await btcusdtVerifiedTree();
  tree.pricePrecision=2;
  const nr=await E.enrichCurrentPullback(tree,{product:'BTC-USD',mainTf:'1d',finePivots:fine,candles},async()=>{throw new Error('日线足够，不应下钻');});
  const leg=E.renderPullbackLegDetail(nr,2),tgt=E.renderPullbackTargets(nr,2);
  assert.match(leg,/\*\*末段延伸（若跌破 79220\.74）\*\*：⏳\(进行中\)腿仍可是同一个单锯齿 \/ 双锯齿 \/ 平台形 \/ 双重横向整理，末段 \(c\)\/\(y\) 越过 79220\.74 继续走、新低为终点/);
  assert.ok(leg.indexOf('**末段延伸（')>leg.indexOf('**读法三的否定与区分**'));
  assert.doesNotMatch(leg,/77302\.33|59408|74129\.1|2026-11-2[05]|2026-12-20/,'目标位与时间上限只进轴③');
  assert.match(tgt,/- \*\*单锯齿\*\*（87395\.67→79800→84898→…）：\(c\) 现为 \(a\) 的 0\.747 倍；常见目标 1 倍 \*\*77302\.33\*\*（共振：\(z\) 破位档 77880\.91）、1\.618 倍 \*\*72608\.21\*\*（共振：回撤位 0\.5 72597\.93）（0\.618 倍 80203\.88 已过）；指引线即 1\.618 倍处 72608\.21（越过则 \(c\) 远超 \(a\) 的 1\.618 倍，更像推动浪）；规则失效 \*\*59408\*\*/);
  assert.match(tgt,/时间上限 \*\*2026-12-20\*\*（\(c\) 时间 ≤ \(a\)、\(b\) 时间的 10 倍；已走 4 根 \/ 上限 60 根）/);
  assert.match(tgt,/- \*\*平台形\*\*（87395\.67→82563→87220→…）：\(c\) 现为 \(a\) 的 1\.655 倍；常见倍数均已到（1 倍 82387\.33、1\.618 倍 79400\.74 已过）；指引线 78434\.21（共振：\(z\) 破位档 77880\.91）/);
  assert.match(tgt,/规则失效最晚 \*\*74129\.1\*\*.*运行总量含内部来回，实际可能更早失效/);
  assert.match(tgt,/- \*\*双重横向整理\*\*（87395\.67→82563→84898→…）：书中 \(y\) 无价格下限（第 8 章未收录）；时间上限 \*\*2026-11-25\*\*/);
  assert.match(tgt,/轴②底线：浪②不得触及 57800\.19；b 腿不得越过 57800\.19。时间上限最早到期的是平台形（2026-11-11）/);
  assert.doesNotMatch(tgt.slice(tgt.indexOf('**末段延伸')),/(?<![(（/#|])\b[abcwxyz] 浪|\b[WXYZ] 浪|XX/,'不出现裸字母浪名');
});

test('末段延伸：已跌破 (a) 终点时保留并改称"已跌破"；无读法一时不给',()=>{
  const prices=[100,60,90,70,85,55,62,50];
  const fine=prices.map((price,i)=>pv(i*5,i%2===0?'H':'L',price));
  const candles=Array.from({length:36},(_,i)=>({index:i,timestamp:i*86400}));
  const pats=[{label:'单锯齿（Zigzag 5-3-5）',points:[fine[0],fine[5],fine[6],fine[7]].map(p=>({...p}))}];
  const ext=E.buildExtensionReading(pats,candles,{trigger:50,state:'broken'});
  assert.equal(ext.state,'broken');
  const nr={tf:'1d',level:{},structureLine:50,subDegree:{tf:'1d',rankedPatterns:pats},
    higherDegree:{state:'broken',aEnd:{price:55,timestamp:0},newLow:{price:50,timestamp:0},bounce:{price:62,timestamp:0},extreme:{price:100,timestamp:0},gross:45,line70:86.5,regularCap:100,comboCap:122.5,flatCap:145,touched70:false,xPct:0.15,cTargets:[],invalid:false},
    extensionReading:ext};
  assert.match(E.renderPullbackLegDetail(nr,2),/\*\*末段延伸（已跌破 55）\*\*：.*与读法一的 \(c\)\/\(y\) 进行中并列/);
  assert.match(E.renderPullbackTargets(nr,2),/末段延伸的目标与失效\*\*（已跌破，末段终点暂取 50/);
  assert.doesNotMatch(E.renderPullbackLegDetail({...nr,higherDegree:null},2),/末段延伸/);
});

test('双锯齿单独成族：取端点为跨度极值、分段不与平台形重复的 87395.67→79800→84898→79220.74（与单锯齿同链不算重复），排在单锯齿之后',()=>{
  const {fine,candles}=btcusdtTree();
  const i=fine.findIndex(p=>p.price===87395.67);
  const sp=E.splitPullbackAtLow(fine.slice(i),true);
  const {patterns}=E.analyzePullbackCompleted(sp.completed,candles);
  assert.deepEqual(patterns.map(p=>p.patternType),['zigzag','zigzag-double','flat','sideways']);
  const dz=patterns[1];
  assert.deepEqual(dz.points.map(p=>p.price),[87395.67,79800,84898,79220.74]);
  assert.deepEqual(dz.beyondEnds,[]);
  assert.equal(dz.score.tier1,0);
  assert.notDeepEqual(dz.points.map(p=>p.price),patterns[2].points.map(p=>p.price),'不取与平台形同链的双锯齿');
  assert.deepEqual(dz.points.map(p=>p.price),patterns[0].points.map(p=>p.price),'与单锯齿同链：区别只在首段内部');
});

test('双锯齿渲染：这段的内部列出价链；轴③给 (y) 对 (w) 的目标、常见下沿与失效价，失效价越过轴②底线时写明以底线为准',async()=>{
  const {tree,fine,candles}=await btcusdtVerifiedTree();
  tree.pricePrecision=2;
  const nr=await E.enrichCurrentPullback(tree,{product:'BTC-USD',mainTf:'1d',finePivots:fine,candles},async()=>{throw new Error('日线足够，不应下钻');});
  const leg=E.renderPullbackLegDetail(nr,2),tgt=E.renderPullbackTargets(nr,2);
  assert.match(leg,/\*\*单锯齿（Zigzag 5-3-5） \/ 双锯齿（Double Zigzag w-x-y）\*\*（87395\.67 @2026-09-21 → 79800 @2026-10-15 → 84898 @2026-10-21 → 79220\.74 @2026-10-24）；或 \*\*平台形/);
  assert.match(leg,/较符合 \*\*单锯齿（Zigzag 5-3-5） 或 双锯齿（Double Zigzag w-x-y） 或 平台形（Flat 3-3-5，基础版） 或 双重横向整理（联合形 w-x-y）\*\*/);
  assert.match(tgt,/- \*\*双锯齿\*\*（87395\.67→79800→84898→…）：\(y\) 现为 \(w\) 的 0\.747 倍；\(y\) 通常大于 \(w\) 的 0\.9 倍（78061\.9，未到；共振：\(z\) 破位档 77880\.91）；常见目标 1 倍 \*\*77302\.33\*\*（共振：\(z\) 破位档 77880\.91）、1\.618 倍 \*\*72608\.21\*\*（共振：回撤位 0\.5 72597\.93）；指引线 71089\.07/);
  assert.match(tgt,/规则失效 \*\*46919\.65\*\*（\(y\) 价格须小于 \(w\) 的 5 倍；已在轴②底线 57800\.19 之外，实际以底线为准）；时间上限 \*\*2027-02-18\*\*（\(y\) 时间 ≤ \(w\) 时间的 5 倍；已走 4 根 \/ 上限 120 根）/);
  assert.doesNotMatch(tgt,/59408（[^）]*以底线为准/,'单锯齿失效价在底线之上，不加注');
});
