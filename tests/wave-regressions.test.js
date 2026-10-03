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
