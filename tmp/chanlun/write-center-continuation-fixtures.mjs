import fs from 'node:fs';
const file='tests/fixtures/chanlun/centers/cases.json';
const data=JSON.parse(fs.readFileSync('tmp/chanlun/compiled/center-Z7-fixtures-v1.json','utf8'));
data.schemaVersion=2;
data.note='人工构造的已确认L0输入；每项为[真实起价,真实终价,实际低价,实际高价]，不是行情重建。stats按GG,G,D,DD；extent为最后归属部件序号，held为未消费输入。V2采用E-010：离开部件归属暂存，回试触及核心才纳入；未返回则作为连接证据。各前缀预期均人工列出，不读取生产输出。关系标签为当前证据，不是R完成。';
const old=[8,10], oldStats=[11,10,8,5];
const s=(core,stats,extent,waves,extra={})=>({core,stats,extent,waves,...extra});
const base=[null,null,s(old,oldStats,3,2,{event:true,pending:3}),s(old,oldStats,3,2,{pending:4})];
const waiting=data.cases.find(c=>c.id==='Z-RELATION-WAIT');waiting.id='Z-DEPARTURE-PENDING';
waiting.expected=[...base,s(old,oldStats,4,2,{pending:5}),s(old,oldStats,4,2,{closed:true,closedEvent:true,leave:5,returned:6,closedAt:6}),s(old,oldStats,4,2,{closed:true,leave:5,returned:6,closedAt:6})];
// Mark pending terminal components of the original independent examples.
for(const id of ['Z-UP-EXTEND','Z-DOWN-EXTEND']){
  const c=data.cases.find(c=>c.id===id);c.expected[2].pending=3;c.expected[3].pending=4;
}
for(const id of ['Z-ROLLING-SEED','Z-MIDDLE-NOT-WAVE']){const c=data.cases.find(c=>c.id===id);c.expected.at(-1).pending=c.inputs.length;}
const budget=data.cases.find(c=>c.id==='Z-SOURCE-LIMIT');budget.expected[2].pending=3;budget.expected[3].pending=4;budget.expected[4].pending=4;
const inputs=[[5,10,5,10],[10,8,8,10],[8,11,8,11],[11,7,7,11],[7,20,7,20],[20,14,14,20],[14,22,14,22],[22,15,15,22],[15,18,15,18],[18,16,16,18]];
const closed=s(old,oldStats,4,2,{closed:true,leave:5,returned:6,closedAt:6});
const expected=[...base,s(old,oldStats,4,2,{pending:5}),{...closed,closedEvent:true},{...closed},s([15,20],[22,20,15,14],8,2,{count:2,start:6,event:true,relation:'up-continuation'}),s([15,20],[22,20,15,14],9,2,{count:2,relation:'up-continuation'}),s([15,20],[22,18,16,14],10,3,{count:2,relation:'up-continuation'})];
data.cases.push({id:'Z-UP-CONTINUATION',inputs:[...inputs,[16,28,16,28],[28,24,24,28],[24,32,24,32],[32,25,25,32]],expected:[...expected,s([15,20],[22,18,16,14],10,3,{count:2,pending:11,relation:'up-continuation'}),s([15,20],[22,18,16,14],10,3,{count:2,closed:true,closedEvent:true,leave:11,returned:12,closedAt:12}),s([15,20],[22,18,16,14],10,3,{count:2,closed:true,leave:11,returned:12,closedAt:12}),s([25,28],[32,28,25,24],14,2,{count:3,start:12,event:true,relation:'up-continuation'})]});
data.cases.push({id:'Z-DOWN-CONTINUATION',inputs:inputs.map(([a,b,l,h])=>[-a,-b,-h,-l]),expected:[null,null,s([-10,-8],[-5,-8,-10,-11],3,2,{event:true,pending:3}),s([-10,-8],[-5,-8,-10,-11],3,2,{pending:4}),s([-10,-8],[-5,-8,-10,-11],4,2,{pending:5}),s([-10,-8],[-5,-8,-10,-11],4,2,{closed:true,closedEvent:true,leave:5,returned:6,closedAt:6}),s([-10,-8],[-5,-8,-10,-11],4,2,{closed:true,leave:5,returned:6,closedAt:6}),s([-20,-15],[-14,-15,-20,-22],8,2,{count:2,start:6,event:true,relation:'down-continuation'}),s([-20,-15],[-14,-15,-20,-22],9,2,{count:2,relation:'down-continuation'}),s([-20,-15],[-14,-16,-18,-22],10,3,{count:2,relation:'down-continuation'})]});
const merged=[20,10,8,5];
data.cases.push({id:'Z-RETURN-MERGES',inputs:[...inputs.slice(0,5),[20,9,9,20]],expected:[...base,s(old,oldStats,4,2,{pending:5}),s(old,merged,6,3)]});
data.cases.push({id:'Z-RANGE-EXPANSION',inputs:[...inputs.slice(0,5),[20,9,9,20],[9,24,9,24],[24,18,18,24],[18,26,18,26],[26,19,19,26]],expected:[...base,s(old,oldStats,4,2,{pending:5}),s(old,merged,6,3),s(old,merged,6,3,{pending:7}),s(old,merged,6,3,{closed:true,closedEvent:true,leave:7,returned:8,closedAt:8}),s(old,merged,6,3,{closed:true,leave:7,returned:8,closedAt:8}),s([19,24],[26,24,19,18],10,2,{count:2,start:8,event:true,relation:'range-overlap'})]});
data.cases.push({id:'Z-EQUAL-ENVELOPE',inputs:[...inputs.slice(0,5),[20,11,11,20],[11,22,11,22],[22,12,12,22]],expected:[...base,s(old,oldStats,4,2,{pending:5}),{...closed,closedEvent:true},{...closed},s([12,20],[22,20,12,11],8,2,{count:2,start:6,event:true,relation:'range-overlap'})]});
data.cases.push({id:'Z-RELATION-EVOLVES',inputs:[...inputs.slice(0,8),[15,21,15,21],[21,10,10,21],[10,16,10,16]],expected:[...expected.slice(0,8),s([15,20],[22,20,15,14],8,2,{count:2,relation:'up-continuation',pending:9}),s([15,20],[22,20,15,14],9,2,{count:2,relation:'up-continuation',pending:10}),s([15,20],[22,20,15,10],11,3,{count:2,relation:'range-overlap'})]});
fs.writeFileSync(file,JSON.stringify(data,null,2)+'\n');
