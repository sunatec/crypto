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
  assert.deepEqual(h.xx.down.map(t=>+t.price.toFixed(2)),[71887.25,62300.32,46790.57],'87397 − 25096.68×0.618/1/1.618');
  assert.deepEqual(h.b.down.map(t=>+t.price.toFixed(2)),[45015.52,18818.55,-23562.93],'87397 − 68578.45×0.618/1/1.618');
  assert.equal(E.bounceHypotheses(pts,'corrective',null).anchor,57717.55,'无反弹极值时退回结构终点');
  assert.equal(E.bounceHypotheses(pts,'corrective',50000).anchor,57717.55,'反弹极值没越过结构终点时不采用');
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
