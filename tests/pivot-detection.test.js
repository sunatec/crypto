'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const E=require('../analyze-wave-tree');

const load=(name)=>require(`./fixtures/${name}`).map((v,index)=>({...v,index}));
const pivotsOf=(c)=>E.anchorBoundaryExtremes(c,E.detectPivots(c,1,{}));
const bar=(o,h,l,cl,i)=>({index:i,timestamp:i*86400,open:o,high:h,low:l,close:cl,volume:1});

// 相邻两个拐点之间不得有 K 线比两端更极端：否则就是漏掉了一段摆动
function swingViolations(c,f){
  const out=[];
  for(let k=0;k+1<f.length;k+=1){
    const a=f[k],b=f[k+1],H=a.type==='H'?a:b,L=a.type==='L'?a:b;
    if(a.type===b.type) out.push(`同型相邻 ${a.price}→${b.price}`);
    if(H.price<L.price) out.push(`方向颠倒 ${a.price}→${b.price}`);
    for(let i=a.index+1;i<b.index;i+=1){
      if(c[i].high>H.price) out.push(`${a.price}→${b.price} 中间高 ${c[i].high}`);
      if(c[i].low<L.price) out.push(`${a.price}→${b.price} 中间低 ${c[i].low}`);
    }
  }
  return out;
}

test('拐点不变式：高低交替、无方向颠倒、相邻拐点之间没有更极端的 K 线（日线与小时线夹具）',()=>{
  for(const name of ['btcusdt-1d-20261025.json','btc-usd-1d-golden.json','btc-usdt-1h-leg5-202609.json','btc-usd-1h-wave1-2026-07.json','btcusdt-1h-wave1-202607.json']){
    const c=load(name);
    assert.deepEqual(swingViolations(c,pivotsOf(c)),[],name);
  }
});

test('外包线两侧都出拐点：阴线先高后低，阳线先低后高，平盘按离开盘近的一端先到',()=>{
  const mk=(o,cl)=>[bar(10,10,8,9,0),bar(9,12,9,11,1),bar(o,15,5,cl,2),bar(9,11,7,10,3),bar(10,13,8,12,4)];
  const types=(c)=>E.detectPivots(c,1,{}).filter(p=>p.index===2).map(p=>`${p.type}${p.price}`);
  assert.deepEqual(types(mk(14,6)),['H15','L5'],'阴线');
  assert.deepEqual(types(mk(6,14)),['L5','H15'],'阳线');
  assert.deepEqual(types(mk(13,13)),['H15','L5'],'平盘离高点近');
  assert.ok(E.detectPivots(mk(14,6),1,{}).filter(p=>p.index===2).every(p=>p.outsideBar));
});

test('BTCUSDT 日线：外包线另一侧、合并时丢掉的反向摆动和方向颠倒段都已修正',()=>{
  const c=load('btcusdt-1d-20261025.json');
  const f=pivotsOf(c);
  const at=(price)=>f.find(p=>p.price===price);
  assert.ok(at(74937.52),'04-29 外包线的低点 74937.52（原只取高点，随同型合并整段下跌丢失）');
  assert.ok(at(76046.58)&&at(79890),'09-11 外包线两侧都在');
  assert.equal(at(76046.58).index,at(79890).index);
  assert.ok(at(64700),'07-06 外包线高点 64700 高于 07-10 的 64692.83');
  assert.ok(!at(94012.45)||!at(93160),'11-14 低点 94012.45 → 11-20 高点 93160 的颠倒段已去掉');
  const i=f.findIndex(p=>p.price===87395.67);
  assert.deepEqual(f.slice(i,i+11).map(p=>p.price),[87395.67,82874.93,85255,82563,87220,80393.56,84352,79800,82940.81,80684.36,84898],'87395.67 之后的回撤拐点不变');
});

test('同型合并：其间反弹没越过所在段另一端时照旧合并，越过时保留这段摆动',()=>{
  // H110 之后逐级下跌：L100 →（小反弹）→ L98。反弹 104 没越过前一个高点 110：合并成 H110→L98
  const mk=(bounce)=>[bar(104,106,103,105,0),bar(105,110,105,106,1),bar(106,107,100,101,2),bar(101,bounce,101,103,3),bar(103,103.5,98,99,4),bar(99,103,99,102,5),bar(102,108,101,107,6)];
  const seq=(c)=>E.detectPivots(c,1,{}).map(p=>`${p.type}${p.price}`);
  assert.deepEqual(seq(mk(104)),['H110','L98']);
  // 反弹 112 越过 110：它本身就是局部高点，L100 / H112 / L98 都保留
  assert.deepEqual(seq(mk(112)),['H110','L100','H112','L98']);
  for(const b of [104,112]){const c=mk(b);assert.deepEqual(swingViolations(c,E.anchorBoundaryExtremes(c,E.detectPivots(c,1,{}))),[]);}
});

test('左边界：首根 K 线比首个确认拐点更极端时，从首根起锚，再补其间的反向极值',()=>{
  // BTC 5m 2026-11-02 06:20 起：首根即区间最低 77620，首个确认低点是 77820.56，其间高点 77892.84。
  // 旧逻辑只补反向极值，起点锚在 77892.84，77620→77892.84 这段被丢掉。
  const rows=[[77712.27,77712.28,77620,77684.1],[77684.1,77689.71,77660,77689.7],[77689.71,77778.01,77689.7,77778],[77778.01,77792.88,77749.93,77776],
    [77776,77818.8,77776,77817.98],[77817.99,77835.28,77812,77835.27],[77835.28,77870.85,77835.27,77870.85],[77870.85,77892.84,77823.87,77823.88],
    [77823.88,77963.61,77820.56,77937.35],[77937.34,78062.55,77914,78047.93],[78047.92,78222.74,78034.96,78138.11],[78138.11,78180.01,78084.02,78092]];
  const c=rows.map(([o,h,l,cl],i)=>bar(o,h,l,cl,i));
  const f=pivotsOf(c);
  assert.deepEqual(f.slice(0,4).map(p=>`${p.type}${p.price}`),['L77620','H77892.84','L77820.56','H78222.74']);
  assert.equal(f[0].index,0);assert.equal(f[0].boundary,'start');
  assert.deepEqual(swingViolations(c,f),[]);
  // 首根同时是区间最高与最低：按外包线惯例定先后。阴线先高后低 → H10、L4；阳线先低后高 → L4、H10，再补其后的低点
  const rest=[bar(5,6,4.5,5.5,1),bar(5.5,9,5.4,8.8,2),bar(8.8,9.5,7,7.2,3),bar(7.2,7.4,6,6.5,4)];
  const seq=(c)=>pivotsOf(c).map(p=>`${p.type}${p.price}`);
  const bear=[bar(10,10,4,5,0),...rest],bull=[bar(5,10,4,9,0),...rest];
  assert.deepEqual(seq(bear).slice(0,3),['H10','L4','H9.5']);
  assert.deepEqual(seq(bull).slice(0,4),['L4','H10','L4.5','H9.5']);
  for(const c of [bear,bull]) assert.deepEqual(swingViolations(c,pivotsOf(c)),[]);
  // 首根不比首个确认拐点更极端时照旧只补反向极值
  const plain=[bar(10,12,9,11,0),bar(11,13,10,12,1),bar(12,12.5,8,8.5,2),bar(8.5,11,8.4,10.5,3),bar(10.5,10.8,9,9.5,4)];
  assert.deepEqual(pivotsOf(plain).slice(0,3).map(p=>`${p.type}${p.price}`),['L9','H13','L8']);
});

test('sliceFine：外包线同一根上的高低枢轴按身份切片，子腿首尾与父级端点一致', () => {
  const { sliceFine } = require('../analyze-wave-tree.js');
  // index 5 是外包线：先 L(40) 后 H(55)
  const fine = [
    { type: 'H', price: 60, index: 0 }, { type: 'L', price: 45, index: 2 }, { type: 'H', price: 58, index: 4 },
    { type: 'L', price: 40, index: 5 }, { type: 'H', price: 55, index: 5 }, { type: 'L', price: 38, index: 8 },
  ];
  const ends = (seg) => [seg[0].price, seg.at(-1).price];
  assert.deepEqual(ends(sliceFine(fine, fine[2], fine[3])), [58, 40], '3 浪止于 L40，不带同根的 H55');
  assert.deepEqual(ends(sliceFine(fine, fine[3], fine[4])), [40, 55]);
  assert.deepEqual(ends(sliceFine(fine, fine[4], fine[5])), [55, 38], '5 浪起于 H55，不从同根的 L40 起');
  // 端点不在列表里：退回按 index 区间
  assert.deepEqual(sliceFine(fine, { index: 2 }, { index: 4 }).map((p) => p.price), [45, 58]);
});
