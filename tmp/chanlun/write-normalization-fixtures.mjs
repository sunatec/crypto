import fs from 'node:fs';
const directory=new URL('../../tests/fixtures/chanlun/',import.meta.url);
const load=name=>JSON.parse(fs.readFileSync(new URL(name+'.json',directory),'utf8'));
const time=i=>1701000000000+i*60000;
// Literal, manually derived boundaries and ranges. No production output or
// segmentation implementation is used to calculate these expectations.
const special=[
  {at:6,start:0,end:3,startTicks:0,endTicks:10,low:0,lowAt:0,high:10,highAt:3,a:0,b:10,direction:'up'},
  {at:13,start:3,end:10,startTicks:10,endTicks:3,low:3,lowAt:10,high:12,highAt:7,a:12,b:3,direction:'down'},
  {at:16,start:10,end:13,startTicks:3,endTicks:15,low:3,lowAt:10,high:15,highAt:13,a:3,b:15,direction:'up'},
];
const cases=[
  {id:'N-OWN-RANGES',file:'n-own-ranges',source:'s-special-internal-extreme',values:special,note:'S12已核对的特殊段：A仍为[0,10]，B独立为[3,12]，C为[3,15]；B的证明价15不入其范围。分析时间用真实段边界，12的实际来源仍为t7。'},
  {id:'N-INTERNAL-LOW',file:'n-internal-low',source:'s-special-internal-extreme',mirror:true,values:[
    {at:6,start:0,end:3,startTicks:0,endTicks:-10,low:-10,lowAt:3,high:0,highAt:0,a:0,b:-10,direction:'down'},
    {at:13,start:3,end:10,startTicks:-10,endTicks:-3,low:-12,lowAt:7,high:-3,highAt:10,a:-12,b:-3,direction:'up'},
    {at:16,start:10,end:13,startTicks:-3,endTicks:-15,low:-15,lowAt:13,high:-3,highAt:10,a:-3,b:-15,direction:'down'},
  ],note:'对特殊段笔输入作价格镜像，独立列出上行内部低点预期；来源时间与几何时间不混同，负整数tick为合成数据。'},
  {id:'N-ORDINARY',file:'n-ordinary',source:'s-first-end',values:[
    {at:6,start:0,end:3,startTicks:0,endTicks:12,low:0,lowAt:0,high:12,highAt:3,a:0,b:12,direction:'up'},
  ],note:'普通段实际区间等于原几何端点区间，前缀6才产生一个L0。'},
  {id:'N-WAIT-NO-EVENT',file:'n-wait-no-event',source:'s-wait-direction-inside',values:[],note:'S仍在等待原0→10破坏笔方向时，所有12个前缀均无S确认，因而无N；窗口结束不补事件。'},
  {id:'N-SECOND-BATCH',file:'n-second-batch',source:'s81-lower',values:[
    {at:9,start:0,end:3,startTicks:0,endTicks:18,low:0,lowAt:0,high:18,highAt:3,a:0,b:18,direction:'up'},
    {at:9,start:3,end:6,startTicks:18,endTicks:10,low:10,lowAt:6,high:18,highAt:3,a:18,b:10,direction:'down'},
  ],note:'第二类同一输入先后锁定两个S，对应两个N按原顺序同批确认；外部证明20不得扩大任一部件。'},
];
for(const entry of cases){
  const fixture=load(entry.source);
  fixture.id=entry.id;
  fixture.ruleIds=['N-001','E-008','S-001','S-002','S-003','E-007'];
  fixture.source.sourceIds=[...new Set([...fixture.source.sourceIds,'C78-198'])];
  fixture.source.pdfPages=[...new Set([...fixture.source.pdfPages,198,199])].sort((a,b)=>a-b);
  fixture.source.lesson=78;fixture.source.figure=null;
  fixture.source.note=entry.note+' 输入为合成已锁定合法笔；标准化邻接与时间锚点采用用户选择的E-008工程约定。';
  fixture.input.kind='normalization-strokes';
  if(entry.mirror)fixture.input.items=fixture.input.items.map(p=>({...p,startTicks:-p.startTicks,endTicks:-p.endTicks,lowTicks:-p.highTicks,highTicks:-p.lowTicks,direction:p.direction==='up'?'down':'up'}));
  const components=entry.values.map((v,i)=>{
    const segmentId=`${entry.id}/S/${i+1}/${time(v.start)}`;
    return {id:`${entry.id}/N/${i+1}/${time(v.start)}`,segmentId,realStartTime:time(v.start),realEndTime:time(v.end),realStartTicks:v.startTicks,realEndTicks:v.endTicks,actualLowTicks:v.low,actualHighTicks:v.high,actualLowTime:time(v.lowAt),actualHighTime:time(v.highAt),analysisStartTime:time(v.start),analysisEndTime:time(v.end),analysisStartTicks:v.a,analysisEndTicks:v.b,direction:v.direction,confirmedAt:time(v.at+1),ruleId:'N-001/E-008',dependencies:[segmentId],ordinal:i+1};
  });
  fixture.expected=fixture.input.items.map((_,i)=>({prefix:i+1,state:{normalizedCount:entry.values.filter(v=>v.at<=i+1).length},structures:components.filter((_,j)=>entry.values[j].at<=i+1),events:components.filter((_,j)=>entry.values[j].at===i+1).map(c=>({id:'confirm/'+c.id,type:'normalized',objectId:c.id,occurredAt:c.analysisEndTime,confirmedAt:c.confirmedAt})),reason:entry.note}));
  fs.writeFileSync(new URL(entry.file+'.json',directory),JSON.stringify(fixture,null,2)+'\n');
}
