import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {generateValidation} from './build-validation.mjs';
import {checkDirectory} from './check-fixtures.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');

// Reuse existing assertions; partition by input seam rather than concatenate
// the entire rule suite into a large compiler request. No market logic here.
export function generateBaselineShards(source,fixtures){
  const baseline=fixtures.filter(f=>f.expectationStatus==='reviewed' && ['ohlc','fractal-pairs','confirmed-fractals'].includes(f.input.kind));
  const lifecycle=baseline.filter(f=>f.input.kind==='confirmed-fractals');
  const groups=[
    {id:'KF6',file:'kf.pine',fixtures:baseline.filter(f=>f.input.kind==='ohlc' && !f.ruleIds.includes('P-002'))},
    {id:'P5',file:'p-qualification.pine',fixtures:baseline.filter(f=>f.input.kind==='fractal-pairs')},
    {id:'P3A',file:'p-lifecycle-a.pine',fixtures:lifecycle.slice(0,3)},
    {id:'P3B',file:'p-lifecycle-b.pine',fixtures:lifecycle.slice(3)},
    {id:'I1',file:'ohlc-integration.pine',fixtures:baseline.filter(f=>f.input.kind==='ohlc' && f.ruleIds.includes('P-002'))},
  ];
  const covered=groups.flatMap(g=>g.fixtures.map(f=>f.id));
  assert.equal(covered.length,baseline.length,'incomplete baseline partition');
  assert.equal(new Set(covered).size,covered.length,'duplicate baseline fixture');
  return groups.map(group=>{
    assert(group.fixtures.length>0,'missing baseline group');
    const expectedDisplay=`PASS: ${group.id}, ${group.fixtures.length} cases`;
    const generated=generateValidation(source,group.fixtures,{title:`缠论基础共享验证 ${group.id}`,summary:expectedDisplay,splitOhlcPrefixes:group.id==='I1',loopOhlcReplay:group.id==='I1'});
    return {id:group.id,file:group.file,source:generated.source,coreHash:generated.coreHash,sha256:sha(generated.source),bytes:Buffer.byteLength(generated.source),expectedDisplay,fixtureIds:generated.fixtureIds,prefixes:group.fixtures.reduce((sum,f)=>sum+f.expected.length,0),execution:'not run; compile and execute in TradingView'};
  });
}

export function buildBaselineShards(directory=path.join(root,'tmp/chanlun/baseline')){
  checkDirectory();
  const fixtureDirectory=path.join(root,'tests/fixtures/chanlun');
  const fixtures=fs.readdirSync(fixtureDirectory).filter(n=>n.endsWith('.json')).sort().map(n=>JSON.parse(fs.readFileSync(path.join(fixtureDirectory,n),'utf8')));
  const source=fs.readFileSync(path.join(root,'chanlun_original.pine'),'utf8');
  const groups=generateBaselineShards(source,fixtures),files=[];
  fs.mkdirSync(directory,{recursive:true});
  for(const {source:pine,...metadata} of groups){fs.writeFileSync(path.join(directory,metadata.file),pine);files.push(metadata);}
  const result={directory,productionSha256:sha(source),coreHash:files[0].coreHash,fixtureCount:files.reduce((sum,f)=>sum+f.fixtureIds.length,0),files,status:'awaiting-platform-results'};
  fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify(result,null,2)+'\n');
  return result;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{console.log(JSON.stringify(buildBaselineShards(process.argv[2]),null,2));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
