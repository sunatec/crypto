import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {extractCore} from './build-validation.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
export const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
export function parseCsv(text){
  const rows=[];let row=[],field='',quoted=false,ended=false;
  text=text.replace(/^\uFEFF/,'');
  const cell=()=>{row.push(field);field='';ended=false;};
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(quoted){if(ch==='"'){if(text[i+1]==='"'){field+='"';i++;}else{quoted=false;ended=true;}}else field+=ch;continue;}
    if(ch==='"'){assert(field===''&&!ended,'invalid CSV quote');quoted=true;}
    else if(ch===',')cell();
    else if(ch==='\n'||ch==='\r'){if(ch==='\r'&&text[i+1]==='\n')i++;cell();if(row.some(x=>x!==''))rows.push(row);row=[];}
    else{assert(!ended,'unexpected text after CSV quote');field+=ch;}
  }
  assert(!quoted,'unterminated CSV quote');if(field!==''||row.length){cell();if(row.some(x=>x!==''))rows.push(row);}
  assert(rows.length>=2,'CSV has no data');const headers=rows.shift().map(s=>s.trim().toLowerCase());
  assert.equal(new Set(headers).size,headers.length,'duplicate CSV header');for(const row of rows)assert.equal(row.length,headers.length,'CSV column count mismatch');
  return {headers,rows};
}
function decimal(text){
  const match=String(text).trim().match(/^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/);assert(match,'invalid decimal: '+text);
  const exp=Number(match[4]??0);assert(Math.abs(exp)<=30 && text.length<=100,'decimal precision out of bounds');
  let scale=(match[3]??'').length-exp,units=BigInt((match[1]==='-'?'-':'')+match[2]+(match[3]??''));
  if(scale<0){units*=10n**BigInt(-scale);scale=0;}while(scale>0 && units%10n===0n){units/=10n;scale--;}
  return {units,scale};
}
function decimalString(d){const sign=d.units<0n?'-':'';const s=(d.units<0n?-d.units:d.units).toString().padStart(d.scale+1,'0');return sign+(d.scale?s.slice(0,-d.scale)+'.'+s.slice(-d.scale):s);}
export function priceTicks(text,tickText){
  const p=decimal(text),t=decimal(tickText);assert(p.units>0n && t.units>0n,'prices/tick must be positive');
  const scale=Math.max(p.scale,t.scale),numerator=p.units*10n**BigInt(scale-p.scale),denominator=t.units*10n**BigInt(scale-t.scale);
  assert(numerator%denominator===0n,'price is off tick grid');const ticks=numerator/denominator;assert(ticks<=BigInt(Number.MAX_SAFE_INTEGER),'ticks exceed safe integer');return Number(ticks);
}
export function parseTime(text){
  if(/^\d{10}$/.test(text))return Number(text)*1000;
  if(/^\d{13}$/.test(text))return Number(text);
  assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(text),'time needs Unix seconds/ms or explicit timezone');
  const [year,month,day,hour,minute,second]=text.slice(0,19).split(/[-T:]/).map(Number);
  assert(month>=1 && month<=12 && day>=1 && day<=new Date(Date.UTC(year,month,0)).getUTCDate() && hour<=23 && minute<=59 && second<=59,'invalid calendar date');
  const value=Date.parse(text);assert(Number.isSafeInteger(value),'invalid timestamp');return value;
}
export function buildMarketBaseline(csv,plan,caseId){
  assert.equal(plan.schemaVersion,1);const target=plan.cases.find(c=>c.id===caseId);assert(target,'unknown case ID');
  const start=Date.parse(target.startUTC),end=Date.parse(plan.endExclusiveUTC),period=target.seconds*1000;
  assert.equal(end-start,period*plan.barsPerCase,'plan window/count mismatch');
  const {headers,rows}=parseCsv(csv);
  const required=['time','open','high','low','close','audit_feed_code','audit_timeframe_seconds','audit_tick_size','audit_standard','audit_closed','audit_close_time_ms','audit_capture_version'];
  const columns=Object.fromEntries(required.map(k=>{const i=headers.indexOf(k);assert(i>=0,'missing CSV column '+k+'; export with market-capture.pine');return [k,i];}));
  const parsed=rows.map((row,i)=>{
    const label=row[columns.time].trim(),dateOnly=/^\d{4}-\d{2}-\d{2}$/.test(label);
    let time;
    if(dateOnly){
      // TradingView daily CSVs may use date-only labels. Recover the absolute
      // UTC open from the exported close-time metadata, never the local zone.
      assert(target.timeframe==='D' && target.seconds===86400,'date-only time requires daily plan');
      const close=Number(row[columns.audit_close_time_ms].trim());
      assert(Number.isSafeInteger(close),'date-only time needs safe close-time metadata');
      time=close-period;
      assert(time>=0 && time%period===0,'daily close metadata is not UTC-day aligned');
      assert.equal(new Date(time).toISOString().slice(0,10),label,'daily date label disagrees with close-time metadata');
    }else time=parseTime(label);
    return {row,time,line:i+2,dateOnly};
  });
  for(let i=1;i<parsed.length;i++)assert(parsed[i].time>parsed[i-1].time,'duplicate or unordered bar times');
  const selected=parsed.filter(r=>r.time>=start&&r.time<end);assert.equal(selected.length,plan.barsPerCase,'missing or extra bars in fixed window');
  let tickSize;
  const bars=selected.map(({row,time},i)=>{
    const get=k=>row[columns[k]].trim();assert.equal(time,start+i*period,'gap or misaligned bar');
    assert.equal(Number(get('audit_feed_code')),target.feedCode,'wrong chart feed');assert.equal(Number(get('audit_timeframe_seconds')),target.seconds,'wrong chart timeframe');
    assert.equal(Number(get('audit_standard')),1,'nonstandard chart');assert.equal(Number(get('audit_closed')),1,'unclosed bar in fixed window');assert.equal(Number(get('audit_capture_version')),1,'unsupported capture version');
    assert.equal(Number(get('audit_close_time_ms')),time+period,'wrong bar close time');
    const currentTick=decimalString(decimal(get('audit_tick_size')));assert(decimal(currentTick).units>0n,'invalid tick size');
    if(tickSize===undefined)tickSize=currentTick;assert.equal(currentTick,tickSize,'tick size changed inside window');
    const result={time,closeTime:time+period};for(const field of ['open','high','low','close'])result[field+'Ticks']=priceTicks(get(field),tickSize);
    assert(result.lowTicks<=Math.min(result.openTicks,result.closeTicks) && result.highTicks>=Math.max(result.openTicks,result.closeTicks) && result.lowTicks<=result.highTicks,'invalid OHLC range');
    return result;
  });
  const payload={schemaVersion:1,caseId,feed:target.feed,timeframe:target.timeframe,tickSize,bars};
  const canonical=JSON.stringify(payload)+'\n';
  const dateOnlyRows=parsed.filter(r=>r.dateOnly).length;
  return {payload,canonical,receipt:{schemaVersion:1,caseId,feed:target.feed,feedEvidence:'audit_feed_code emitted by capture helper; original CSV retained, not independent broker verification',timeframe:target.timeframe,tickSize,requestedStartUTC:target.startUTC,endExclusiveUTC:plan.endExclusiveUTC,actualFirstOpenUTC:new Date(bars[0].time).toISOString(),actualLastCloseUTC:new Date(bars.at(-1).closeTime).toISOString(),exportedFirstOpenUTC:new Date(parsed[0].time).toISOString(),exportedLastOpenUTC:new Date(parsed.at(-1).time).toISOString(),...(dateOnlyRows?{dateOnlyRows,timeInterpretation:'Daily date labels checked against UTC open derived from audit_close_time_ms minus 86400000; UTC-day alignment required'}:{}),bars:bars.length,rawCsvSha256:sha(csv),canonicalSha256:sha(canonical),planSha256:sha(JSON.stringify(plan)),proposedIndicatorParameters:{...plan.indicatorParameters,requestedStart:start},actualIndicatorParameters:'not yet independently observed',status:'OHLC frozen; chart load/replay/reload not executed'}};
}
export function importMarketCsv(csvPath,caseId,workspace=root){
  const market=path.join(workspace,'tests/fixtures/chanlun/market');
  const plan=JSON.parse(fs.readFileSync(path.join(market,'plan.json'),'utf8'));
  const raw=fs.readFileSync(csvPath),csv=raw.toString('utf8'),built=buildMarketBaseline(csv,plan,caseId);
  const directory=path.join(market,'baselines',caseId),receiptPath=path.join(directory,'receipt.json');
  if(fs.existsSync(receiptPath)){
    const prior=JSON.parse(fs.readFileSync(receiptPath,'utf8'));assert.equal(prior.canonicalSha256,built.receipt.canonicalSha256,'frozen baseline differs; create an explicitly reviewed new plan/version');
    assert.equal(sha(fs.readFileSync(path.join(directory,'bars.json'))),prior.canonicalSha256,'frozen baseline corrupted');
    assert.equal(sha(fs.readFileSync(path.join(directory,'source.csv'))),prior.rawCsvSha256,'original CSV corrupted');
    return {existing:true,directory,receipt:prior};
  }
  const production=fs.readFileSync(path.join(workspace,'chanlun_original.pine'),'utf8');
  const capture=fs.readFileSync(path.join(workspace,'tools/chanlun/market-capture.pine'));
  const receipt={...built.receipt,rawCsvSha256:sha(raw),captureHelperSha256:sha(capture),productionSha256:sha(production),coreHash:sha(extractCore(production)),versionBinding:'Workspace hashes for planned replay; actual chart script versions/settings not yet verified'};
  assert(!fs.existsSync(directory),'incomplete baseline directory already exists; review it before retrying');
  fs.mkdirSync(path.dirname(directory),{recursive:true});
  const staging=fs.mkdtempSync(path.join(path.dirname(directory),`.${caseId}-staging-`));
  try{
    fs.writeFileSync(path.join(staging,'source.csv'),raw,{flag:'wx'});fs.writeFileSync(path.join(staging,'bars.json'),built.canonical,{flag:'wx'});fs.writeFileSync(path.join(staging,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
    fs.renameSync(staging,directory);
  }catch(error){
    for(const name of ['source.csv','bars.json','receipt.json']){const file=path.join(staging,name);if(fs.existsSync(file))fs.unlinkSync(file);}
    if(fs.existsSync(staging))fs.rmdirSync(staging);throw error;
  }
  return {existing:false,directory,receipt};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  try{assert.equal(process.argv.length,4,'usage: node tools/chanlun/import-market-csv.mjs CASE_ID CSV_PATH');console.log(JSON.stringify(importMarketCsv(process.argv[3],process.argv[2]),null,2));}catch(e){console.error(e.message);process.exitCode=1;}
}
