import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parseCsv,parseTime,priceTicks,buildMarketBaseline,importMarketCsv,sha} from './import-market-csv.mjs';
const start=Date.parse('2026-09-20T00:00:00Z');
const headers='time,open,high,low,close,audit_feed_code,audit_timeframe_seconds,audit_tick_size,audit_standard,audit_closed,audit_close_time_ms,audit_capture_version,Other';
const row=(i=0)=>[(start+i*3600000)/1000,'10.01','10.03','9.99','10.02','1.00000000','3600.00000000','0.01000000','1.00000000','1.00000000',start+(i+1)*3600000,'1.00000000','ignored'];
const plan=()=>({schemaVersion:1,barsPerCase:2,endExclusiveUTC:'2026-09-20T02:00:00Z',indicatorParameters:{fixedStart:true,sampleLimit:2},cases:[{id:'BTCUSDT-60',feed:'BINANCE:BTCUSDT',feedCode:1,timeframe:'60',seconds:3600,startUTC:'2026-09-20T00:00:00Z'}]});
const csv=(rows=[row(),row(1)])=>headers+'\r\n'+rows.map(r=>r.join(',')).join('\r\n')+'\r\n';
test('CSV parser preserves quoted fields and rejects ambiguity',()=>{
  const parsed=parseCsv('\uFEFFtime,other\r\n"1","a,b"\r\n"2","a""b"\r\n');
  assert.deepEqual(parsed.rows,[['1','a,b'],['2','a"b']]);
  for(const input of ['x,x\n1,2','x,y\n1','x\n"abc','x\n"a"b'])assert.throws(()=>parseCsv(input));
});
test('UTC parsing and decimal tick conversion do not silently round prices or times',()=>{
  assert.equal(parseTime(String(start/1000)),start);assert.equal(parseTime(String(start)),start);
  assert.equal(parseTime('2026-09-20T08:00:00+08:00'),start);
  for(const input of ['2026-09-20','2026-09-20 00:00:00','2026-09-31T00:00:00Z','garbage'])assert.throws(()=>parseTime(input));
  assert.equal(priceTicks('10.01','0.0100'),1001);assert.equal(priceTicks('0.00000123','1e-8'),123);
  for(const args of [['10.011','0.01'],['NaN','0.01'],['10','0'],['-1','0.01'],['1e30','0.01']])assert.throws(()=>priceTicks(...args));
});
test('baseline binds actual OHLC, tick metadata and complete selected window',()=>{
  const data=plan(),before=JSON.stringify(data),raw=csv(),result=buildMarketBaseline(raw,data,'BTCUSDT-60');
  assert.equal(JSON.stringify(data),before);assert.equal(result.payload.tickSize,'0.01');assert.equal(result.payload.bars.length,2);
  assert.deepEqual(result.payload.bars[0],{time:start,closeTime:start+3600000,openTicks:1001,highTicks:1003,lowTicks:999,closeTicks:1002});
  assert.equal(result.receipt.canonicalSha256,sha(result.canonical));assert.equal(result.receipt.rawCsvSha256,sha(raw));
  const outside=row(2);outside[9]='0';
  assert.equal(buildMarketBaseline(csv([row(),row(1),outside]),data,'BTCUSDT-60').payload.bars.length,2);
});
test('wrong feed, timeframe, chart type, clock, unclosed bars and invalid prices fail',()=>{
  const mutations=[r=>r[5]='2',r=>r[6]='14400',r=>r[8]='0',r=>r[9]='0',r=>r[10]=start+1,r=>r[11]='2',r=>r[7]='0',r=>r[1]='10.011',r=>r[3]='11',r=>r[0]=(start+60000)/1000];
  for(const mutate of mutations){const r=row();mutate(r);assert.throws(()=>buildMarketBaseline(csv([r,row(1)]),plan(),'BTCUSDT-60'));}
  const r=row(1);r[7]='0.001';assert.throws(()=>buildMarketBaseline(csv([row(),r]),plan(),'BTCUSDT-60'),/tick size changed/);
});
test('missing metadata, duplicate/unordered/gapped data and unknown case cannot be frozen',()=>{
  for(const input of [csv().replace('audit_tick_size','missing_tick'),csv([row(),row()]),csv([row(1),row()]),csv([row()]),csv([row(),row(2)])])assert.throws(()=>buildMarketBaseline(input,plan(),'BTCUSDT-60'));
  assert.throws(()=>buildMarketBaseline(csv(),plan(),'../OTHER'));
});
test('six planned windows are aligned, feed-specific and exactly 1008 closed bars',()=>{
  const p=JSON.parse(fs.readFileSync(new URL('../../tests/fixtures/chanlun/market/plan.json',import.meta.url),'utf8'));
  assert.equal(p.cases.length,6);assert.equal(new Set(p.cases.map(c=>c.id)).size,6);
  for(const c of p.cases){assert.equal(Date.parse(p.endExclusiveUTC)-Date.parse(c.startUTC),1008*c.seconds*1000);assert.equal(Date.parse(c.startUTC)%(c.seconds*1000),0);}
});
const dailyPlan=()=>({...plan(),endExclusiveUTC:'2026-09-22T00:00:00Z',cases:[{...plan().cases[0],id:'BTCUSDT-D',timeframe:'D',seconds:86400}]});
const dailyRow=i=>{const r=row(i);r[0]=new Date(start+i*86400000).toISOString().slice(0,10);r[6]='86400';r[10]=start+(i+1)*86400000;return r;};
test('date-only daily CSV recovers UTC from exported close metadata without changing source or OHLC',()=>{
  const input=csv([dailyRow(0),dailyRow(1)]),before=input,result=buildMarketBaseline(input,dailyPlan(),'BTCUSDT-D');
  assert.equal(input,before);assert.equal(result.payload.bars[0].time,start);assert.equal(result.payload.bars[1].time,start+86400000);
  assert.equal(result.payload.bars[1].closeTime,start+2*86400000);assert.equal(result.receipt.dateOnlyRows,2);
  assert.equal(result.receipt.actualFirstOpenUTC,'2026-09-20T00:00:00.000Z');assert.equal(result.receipt.actualLastCloseUTC,'2026-09-22T00:00:00.000Z');
  assert.equal(result.receipt.rawCsvSha256,sha(before));assert.match(result.receipt.timeInterpretation,/audit_close_time_ms/);
  const explicit=[dailyRow(0),dailyRow(1)].map(r=>{r[0]+='T00:00:00Z';return r;});
  assert.equal(buildMarketBaseline(csv(explicit),dailyPlan(),'BTCUSDT-D').canonical,result.canonical);
});
test('daily date-only handling rejects unsupported periods, conflicting labels and unsafe metadata',()=>{
  const hourly=row();hourly[0]='2026-09-20';
  assert.throws(()=>buildMarketBaseline(csv([hourly,row(1)]),plan(),'BTCUSDT-60'),/daily plan/);
  for(const mutate of [r=>r[0]='2026-09-19',r=>r[0]='2026-09-31',r=>r[10]+=3600000,r=>r[10]='',r=>r[10]='NaN',r=>r[10]='99999999999999999999']){
    const rows=[dailyRow(0),dailyRow(1)];mutate(rows[0]);assert.throws(()=>buildMarketBaseline(csv(rows),dailyPlan(),'BTCUSDT-D'));
  }
});
test('import preserves original CSV, is idempotent, and rejects replacement or corruption',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chanlun-import-'));
  const market=path.join(dir,'tests/fixtures/chanlun/market');fs.mkdirSync(market,{recursive:true});
  fs.writeFileSync(path.join(market,'plan.json'),JSON.stringify(plan()));fs.mkdirSync(path.join(dir,'tools/chanlun'),{recursive:true});
  fs.copyFileSync(new URL('market-capture.pine',import.meta.url),path.join(dir,'tools/chanlun/market-capture.pine'));
  fs.copyFileSync(new URL('../../chanlun_original.pine',import.meta.url),path.join(dir,'chanlun_original.pine'));
  const input=path.join(dir,'source.csv');fs.writeFileSync(input,csv());
  const result=importMarketCsv(input,'BTCUSDT-60',dir);assert.equal(result.existing,false);
  assert.equal(fs.readFileSync(path.join(result.directory,'source.csv'),'utf8'),csv());
  assert.equal(importMarketCsv(input,'BTCUSDT-60',dir).existing,true);
  const changed=row();changed[1]='10.02';fs.writeFileSync(input,csv([changed,row(1)]));
  assert.throws(()=>importMarketCsv(input,'BTCUSDT-60',dir),/frozen baseline differs/);
  fs.writeFileSync(input,csv());fs.appendFileSync(path.join(result.directory,'source.csv'),'changed');
  assert.throws(()=>importMarketCsv(input,'BTCUSDT-60',dir),/original CSV corrupted/);
  // Each test file is explicitly named; no recursive deletion or computed tree removal.
  for(const name of ['source.csv','bars.json','receipt.json'])fs.unlinkSync(path.join(result.directory,name));
  fs.rmdirSync(result.directory);fs.rmdirSync(path.dirname(result.directory));fs.unlinkSync(path.join(market,'plan.json'));fs.rmdirSync(market);fs.rmdirSync(path.dirname(market));fs.rmdirSync(path.join(dir,'tests/fixtures'));fs.rmdirSync(path.join(dir,'tests'));
  fs.unlinkSync(path.join(dir,'tools/chanlun/market-capture.pine'));fs.rmdirSync(path.join(dir,'tools/chanlun'));fs.rmdirSync(path.join(dir,'tools'));
  fs.unlinkSync(path.join(dir,'chanlun_original.pine'));fs.unlinkSync(input);fs.rmdirSync(dir);
});
