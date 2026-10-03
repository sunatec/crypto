'use strict';


// Overlap page boundaries because the API's end can be exclusive.
async function fetchSharedHourly(fetchPage, product, start, end, pageHours = 298) {
  if (!(pageHours > 0 && pageHours < 299)) throw new Error('Hourly page must be below the API limit');
  const pages=[];
  for (let cursor=start.getTime();cursor<end.getTime();) {
    const stop=Math.min(cursor+pageHours*3600000,end.getTime());pages.push([cursor,stop]);cursor=stop;
  }
  const merged=new Map(),fetchErrors=[];
  // Fetch independent pages in small batches; merge in page order for deterministic overlaps.
  for (let i=0;i<pages.length;i+=3) {
    const batch=pages.slice(i,i+3);
    const results=await Promise.allSettled(batch.map(([from,to])=>fetchPage(product,3600,new Date(from),new Date(to))));
    results.forEach((r,j)=>{
      if(r.status==='fulfilled') for (const c of r.value) merged.set(c.timestamp,c);
      else fetchErrors.push({fromTimestamp:batch[j][0]/1000,toTimestamp:batch[j][1]/1000,reason:'小时行情分页请求失败'});
    });
  }
  const result=[...merged.values()].sort((a,b)=>a.timestamp-b.timestamp);
  result.fetchErrors=fetchErrors;
  return result;
}

async function fetchCoinbaseHourPage(product, granularity, start, end) {
  const {execFile}=require('node:child_process');
  const url=new URL('https://api.exchange.coinbase.com/products/'+encodeURIComponent(product)+'/candles');
  url.searchParams.set('granularity',String(granularity));url.searchParams.set('start',start.toISOString());url.searchParams.set('end',end.toISOString());
  // This is the existing Windows fallback transport, without waiting for three native-network timeouts per page.
  const command="$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; (Invoke-RestMethod -Uri '"+url.toString().replace(/'/g,"''")+"' -UseBasicParsing -TimeoutSec 30) | ConvertTo-Json -Depth 8 -Compress";
  const stdout=await new Promise((resolve,reject)=>execFile('powershell',['-NoProfile','-Command',command],{encoding:'utf8',windowsHide:true,timeout:35000,maxBuffer:4*1024*1024},(error,out)=>error?reject(error):resolve(out)));
  const rows=JSON.parse(stdout);
  if (!Array.isArray(rows)) throw new Error('Invalid hourly candle response');
  return rows.map(row=>Array.isArray(row)?row:row.value).map(r=>({timestamp:Number(r[0]),low:Number(r[1]),high:Number(r[2]),open:Number(r[3]),close:Number(r[4]),volume:Number(r[5])}));
}

// Intraday evidence uses its own candle indices. Parent points are never rewritten.
function createSubwaveVerifier(engine, { hourly, mainTf = '1d', finestTf = '1h', error = null, endTs = Infinity, pricePrecision = 2 } = {}) {
  const hours = [...new Map((hourly || []).map(c => [c.timestamp, c])).values()].sort((a,b) => a.timestamp-b.timestamp);
  const memo = new Map();
  const stats = { hourlyCandles: hours.length, failedPages:hourly && hourly.fetchErrors || [], windows: 0, cacheHits: 0 };
  const seconds = { '1d':86400, '4h':14400, '1h':3600, '1w':604800 };
  const tolerance = Math.max(1e-8, 10 ** -pricePrecision / 2);
  function locate(point, sourceTf) {
    const width = seconds[sourceTf];
    if (!width || point.provisional) return null;
    const bucket=hours.filter(c=>c.timestamp>=point.timestamp && c.timestamp<point.timestamp+width);
    if (bucket.length!==width/3600 || bucket.some((c,i)=>c.timestamp!==point.timestamp+i*3600 || c.timestamp+3600>endTs || !Number.isFinite(c.high) || !Number.isFinite(c.low) || c.high<c.low)) return null;
    const field = point.type === 'H' ? 'high' : 'low';
    const extreme=point.type==='H'?Math.max(...bucket.map(c=>c.high)):Math.min(...bucket.map(c=>c.low));
    if (Math.abs(extreme-point.price)>tolerance) return null;
    const matches = bucket.filter(c=>Math.abs(c[field]-point.price)<=tolerance);
    // Repeated equal extremes do not identify one unique event.
    return matches.length === 1 ? matches[0] : null;
  }
  function evaluate(from, to, role, sourceTf = mainTf) {
    const key = [sourceTf,from.timestamp,from.type,from.price,to.timestamp,to.type,to.price,role,finestTf].join('|');
    if (memo.has(key)) { stats.cacheHits++; return memo.get(key); }
    stats.windows++;
    const evidence = { status:'pending', role, sourceTimeframe:sourceTf, from:{...from}, to:{...to}, attempts:[], reason:null,provenRoles:0,requiredRoles:1 };
    const save = reason => { evidence.reason = reason; memo.set(key,evidence); return evidence; };
    if (error && !hours.length) return save(`小时行情获取失败：${error}`);
    if (!hours.length) return save('缺少小时行情');
    const a = locate(from,sourceTf), b = locate(to,sourceTf);
    if (!a || !b || b.timestamp <= a.timestamp) return save('母级端点未能在完整桶内唯一定位（或端点尚未确认）');
    evidence.located = { fromTimestamp:a.timestamp, toTimestamp:b.timestamp };
    const window = hours.filter(c => c.timestamp >= a.timestamp && c.timestamp <= b.timestamp && c.timestamp <= endTs);
    if (!window.length || window[0].timestamp !== a.timestamp || window.at(-1).timestamp !== b.timestamp || window.some((c,i) => i && c.timestamp-window[i-1].timestamp !== 3600)) return save('小时窗口缺失 K 线，不能完成结构验证');
    // A bar containing both endpoints has no observable intrabar event order.
    const lowerFrames = sourceTf === '1d' || sourceTf === '1w' ? (finestTf === '4h' ? ['4h'] : ['4h','1h']) : sourceTf === '4h' && finestTf === '1h' ? ['1h'] : [];
    if (!lowerFrames.length) return save('已到配置的最细验证周期');
    for (const tf of lowerFrames) {
      const candles = engine.transformCandles(window,engine.TIMEFRAMES[tf]).map((c,index) => ({...c,index}));
      let fine = engine.anchorBoundaryExtremes(candles,engine.detectPivots(candles,1,{}));
      const start = {type:from.type,price:from.price,index:0,timestamp:candles[0].timestamp};
      const finish = {type:to.type,price:to.price,index:candles.length-1,timestamp:candles.at(-1).timestamp};
      if (start.index === finish.index) { evidence.attempts.push({timeframe:tf,status:'pending',reason:'端点位于同一根 K 线，事件顺序不明'}); continue; }
      // Crop by actual event hours before aggregation, then pin the supplied prices.
      fine = [start,...fine.filter(p => p.index>0 && p.index<finish.index),finish];
      const node = engine.decompose(fine,candles,[role],0,{beamK:3,maxDepth:3,cache:new Map(),evidenceMode:true,timeframe:tf,finestResolution:tf===finestTf?finestTf:null});
      const best = node.primary;
      if(best) Object.defineProperty(evidence,'adoptedNode',{value:node,writable:true,enumerable:false,configurable:true});
      const searchLimited = fine.length > 8 || node.searchLimited;
      const status = !best ? 'pending' : best.score.tier1 === 0 ? best.score.verificationStatus : searchLimited ? 'pending' : 'invalid';
      evidence.provenRoles=best ? best.score.provenRoles || 0 : 0;
      evidence.requiredRoles=best ? best.score.requiredRoles || 1 : 1;
      evidence.verificationScope=best && best.verificationScope || null;
      const attempt = {timeframe:tf,status:status || 'pending',pivotCount:fine.length,searchLimited:!!searchLimited,provenRoles:evidence.provenRoles,requiredRoles:evidence.requiredRoles,patternId:best && best.patternId,violations:best ? engine.candidateViolations(best) : [],pendingRoles:best ? best.score.pendingRoles : 1,structure:engine.serializeTree(node)};
      evidence.attempts.push(attempt);
      if (status === 'verified') { evidence.status='verified'; return save('所需角色及直接子结构已在声明的最细分辨率范围验证；边界以下子角色未证明'); }
      if (tf === finestTf && status === 'invalid') { evidence.status='invalid'; return save('最细周期的完整候选搜索不满足位置角色'); }
    }
    return save('已检查较小周期，子角色或搜索覆盖仍待验证');
  }
  return { evaluate, stats, memo, locate };
}

async function buildVerifiedCountTree(engine, fine, candles, options = {}) {
  const mainTf = options.mainTf || '1d';
  let hourly = options.hourly || (mainTf === '1h' ? candles : null);
  let error = null;
  if (!hourly && options.finestTf !== 'off' && ['1d','4h','1w'].includes(mainTf)) {
    const seconds = mainTf === '1w' ? 604800 : mainTf === '1d' ? 86400 : 14400;
    // Include the entire endpoint bucket; a daily timestamp is the bucket start.
    const start = new Date(candles[0].timestamp*1000);
    const end = new Date(Math.min(candles.at(-1).timestamp+seconds,options.endTs || Infinity)*1000);
    try { hourly = options.fetchHourly ? await options.fetchHourly(options.product,3600,start,end) : await fetchSharedHourly(process.platform === 'win32' ? fetchCoinbaseHourPage : engine.fetchCandles,options.product,start,end); }
    catch (e) { error = options.fetchHourly ? e.message : 'Coinbase 小时行情请求失败'; }
    if (hourly && hourly.fetchErrors && hourly.fetchErrors.length) error=hourly.fetchErrors.length+' 个小时行情分页获取失败；保留已获取数据，缺口窗口待验证';
  }
  const verifier = createSubwaveVerifier(engine,{...options,hourly,mainTf,error});
  const verificationOptions = {...options,timeframe:mainTf,evidenceMode:true,finestResolution:mainTf===(options.finestTf||'1h')?mainTf:null,verification:options.finestTf === 'off' ? null : verifier};
  const tree = engine.buildCountTree(fine,candles,verificationOptions);
  tree.verification = {mainTimeframe:mainTf,finestTimeframe:options.finestTf || '1h',...verifier.stats,error};
  return {tree,verifier,verificationOptions,hourly};
}
module.exports = {createSubwaveVerifier,buildVerifiedCountTree,fetchSharedHourly};
