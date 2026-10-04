'use strict';

const { getCandles } = require('./candle-cache');

// Overlap page boundaries because the API's end can be exclusive.
async function fetchSharedHourly(fetchPage, product, start, end, pageHours = 298, options = {}) {
  if (!(pageHours > 0 && pageHours < 299)) throw new Error('Hourly page must be below the API limit');
  if (!fetchPage) return getCandles(product, 3600, start, end, { ...options, pageBars: pageHours });
  // Explicitly injected fetchers retain the original offline, non-persistent path.
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

// 交易所断档（如 Coinbase 2025-10-25、2026-05-08 各缺 5 小时，5 分钟线同样缺失）会让跨过它的整条腿
// 无法验证。只补"藏不住新极值"的短缺口：≤MAX_GAP_HOURS，且缺口所在母级 K 线的最高/最低价都已出现在
// 现有小时线里——缺口内价格因此被夹在已观测区间内。补线按前收→后开线性插值、高低相同，标 filled；
// 端点定位只认真实 K 线，落在补线上的枢轴剔除。无母级 K 线、缺口过长或母级极值可能落在缺口里则不补。
const MAX_GAP_HOURS = 6;
function fillShortGaps(hours, parentCandles, parentWidth, tolerance) {
  const gaps = [];
  if (!hours.length) return { series: hours, gaps };
  const parents = new Map((parentCandles || []).map(c => [c.timestamp, c]));
  const bucketOf = ts => ts - ((ts % parentWidth) + parentWidth) % parentWidth;
  const observed = new Map(); // 母级桶 → 已观测小时线的最高/最低
  if (parentWidth) for (const c of hours) {
    const k = bucketOf(c.timestamp);
    const o = observed.get(k) || { hi: -Infinity, lo: Infinity };
    o.hi = Math.max(o.hi, c.high); o.lo = Math.min(o.lo, c.low); observed.set(k, o);
  }
  const bounded = (fromTs, toTs) => {
    if (!parents.size || !parentWidth) return false;
    for (let k = bucketOf(fromTs); k <= toTs; k += parentWidth) {
      const parent = parents.get(k), o = observed.get(k);
      if (!parent || !o || Math.abs(o.hi - parent.high) > tolerance || Math.abs(o.lo - parent.low) > tolerance) return false;
    }
    return true;
  };
  const series = [hours[0]];
  for (let i = 1; i < hours.length; i += 1) {
    const prev = hours[i - 1], next = hours[i];
    const missing = Math.round((next.timestamp - prev.timestamp) / 3600) - 1;
    if (missing > 0) {
      const gap = { fromTimestamp: prev.timestamp + 3600, toTimestamp: next.timestamp - 3600, hours: missing, filled: false };
      if (missing <= MAX_GAP_HOURS && bounded(gap.fromTimestamp, gap.toTimestamp)) {
        for (let k = 1; k <= missing; k += 1) {
          const v = prev.close + (next.open - prev.close) * k / (missing + 1);
          series.push({ timestamp: prev.timestamp + k * 3600, open: v, close: v, high: v, low: v, volume: 0, filled: true });
        }
        gap.filled = true;
      }
      gaps.push(gap);
    }
    series.push(next);
  }
  return { series, gaps };
}

function describeGaps(list) {
  return list.map(g => new Date(g.fromTimestamp*1000).toISOString().slice(0,13).replace('T',' ')+'Z 起 '+g.hours+' 小时').join('、');
}

// 补线上的枢轴不是观测到的转折：剔除后按同型取更极端者恢复高低交替。
function dropFilledPivots(pivots, candles) {
  const out = [];
  for (const p of pivots) {
    if (candles[p.index] && candles[p.index].filled) continue;
    const last = out[out.length - 1];
    if (last && last.type === p.type) {
      if (p.type === 'H' ? p.price >= last.price : p.price <= last.price) out[out.length - 1] = p;
    } else out.push(p);
  }
  return out;
}

// Intraday evidence uses its own candle indices. Parent points are never rewritten.
function createSubwaveVerifier(engine, { hourly, parentCandles = null, mainTf = '1d', finestTf = '1h', error = null, endTs = Infinity, pricePrecision = 2 } = {}) {
  const rawHours = [...new Map((hourly || []).map(c => [c.timestamp, c])).values()].sort((a,b) => a.timestamp-b.timestamp);
  const memo = new Map();
  // 同一窗口、同一周期按不同位置角色各验证一次（P1 细分角色后同一条腿常被 4–6 个角色查询）：
  // 共享聚合 K 线、枢轴与 decompose 缓存，子腿拆解跨角色复用。LRU 限量，防长区间常驻内存。
  const prepared = new Map();
  const PREPARED_MAX = 16;
  function prepare(window, tf, from, to) {
    const key = [tf, window[0].timestamp, window.at(-1).timestamp, from.type, from.price, to.type, to.price].join('|');
    if (prepared.has(key)) { const hit = prepared.get(key); prepared.delete(key); prepared.set(key, hit); stats.preparedHits = (stats.preparedHits || 0) + 1; return hit; }
    const candles = engine.transformCandles(window,engine.TIMEFRAMES[tf]).map((c,index) => ({...c,index}));
    // 聚合桶内全是补线时整根标 filled（如 4h 桶落在 ≤6 小时的缺口里）
    const step = engine.TIMEFRAMES[tf].fetchGranularity || 3600;
    const filledTs = new Set(window.filter(c => c.filled).map(c => c.timestamp));
    if (filledTs.size) candles.forEach(c => { let all = true; for (let t = c.timestamp; t < c.timestamp + step; t += 3600) if (!filledTs.has(t)) { all = false; break; } if (all) c.filled = true; });
    let fine = engine.anchorBoundaryExtremes(candles,dropFilledPivots(engine.detectPivots(candles,1,{}),candles));
    const start = {type:from.type,price:from.price,index:0,timestamp:candles[0].timestamp};
    const finish = {type:to.type,price:to.price,index:candles.length-1,timestamp:candles.at(-1).timestamp};
    // Crop by actual event hours before aggregation, then pin the supplied prices.
    fine = [start,...fine.filter(p => p.index>0 && p.index<finish.index),finish];
    const entry = { candles, fine, start, finish, cache: new Map() };
    prepared.set(key, entry);
    if (prepared.size > PREPARED_MAX) prepared.delete(prepared.keys().next().value);
    return entry;
  }
  const stats = { hourlyCandles: rawHours.length, failedPages:hourly && hourly.fetchErrors || [], windows: 0, cacheHits: 0 };
  const seconds = { '1d':86400, '4h':14400, '1h':3600, '1w':604800 };
  const tolerance = Math.max(1e-8, 10 ** -pricePrecision / 2);
  const { series: hours, gaps } = fillShortGaps(rawHours, parentCandles, seconds[mainTf], tolerance);
  stats.hourlyGaps = gaps;
  const position = new Map(hours.map((c, i) => [c.timestamp, i]));
  const span = (fromTs, toTs) => { // 按时间取连续小时线（序列已排序去重）
    let i = position.get(fromTs);
    if (i === undefined) { i = hours.findIndex(c => c.timestamp >= fromTs); if (i < 0) return []; }
    const out = [];
    for (; i < hours.length && hours[i].timestamp <= toTs; i += 1) out.push(hours[i]);
    return out;
  };
  function locate(point, sourceTf) {
    const width = seconds[sourceTf];
    if (!width || point.provisional) return null;
    const bucket=span(point.timestamp, point.timestamp+width-1);
    if (bucket.length!==width/3600 || bucket.some((c,i)=>c.timestamp!==point.timestamp+i*3600 || c.timestamp+3600>endTs || !Number.isFinite(c.high) || !Number.isFinite(c.low) || c.high<c.low)) return null;
    const field = point.type === 'H' ? 'high' : 'low';
    const real = bucket.filter(c=>!c.filled); // 端点只认真实成交的小时线
    const extreme=point.type==='H'?Math.max(...real.map(c=>c.high)):Math.min(...real.map(c=>c.low));
    if (Math.abs(extreme-point.price)>tolerance) return null;
    const matches = real.filter(c=>Math.abs(c[field]-point.price)<=tolerance);
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
    if (!a || !b || b.timestamp <= a.timestamp) {
      const width = seconds[sourceTf] || 0;
      const inBucket = pt => gaps.filter(g => !g.filled && g.toTimestamp >= pt.timestamp && g.fromTimestamp < pt.timestamp + width);
      const open = [...inBucket(from), ...inBucket(to)];
      if (open.length) return save('母级端点所在 K 线有小时数据断档（'+describeGaps(open)+'；缺口过长或母级极值可能落在缺口内，不插补），无法定位端点');
      return save('母级端点未能在完整桶内唯一定位（或端点尚未确认）');
    }
    evidence.located = { fromTimestamp:a.timestamp, toTimestamp:b.timestamp };
    const window = span(a.timestamp, Math.min(b.timestamp, endTs));
    const crossing = gaps.filter(g => g.fromTimestamp > a.timestamp && g.toTimestamp < b.timestamp);
    if (crossing.length) evidence.dataGaps = crossing.map(g => ({ ...g }));
    if (!window.length || window[0].timestamp !== a.timestamp || window.at(-1).timestamp !== b.timestamp || window.some((c,i) => i && c.timestamp-window[i-1].timestamp !== 3600)) {
      const detail = describeGaps(crossing.filter(g => !g.filled));
      return save('小时窗口缺失 K 线'+(detail ? '（'+detail+'；缺口过长或母级极值可能落在缺口内，不插补）' : '')+'，不能完成结构验证');
    }
    // A bar containing both endpoints has no observable intrabar event order.
    // 只在声明的最细周期上验证：非最细周期不是分辨率边界，子角色没有证据来源，结果必然是 pending；
    // 其 invalid 也不终止验证。中间周期（如最细为 1h 时的 4h）对结论没有贡献，只耗时（实测占 58%）。
    const lowerFrames = (sourceTf === '1d' || sourceTf === '1w' || (sourceTf === '4h' && finestTf === '1h')) && finestTf !== sourceTf ? [finestTf] : [];
    if (!lowerFrames.length) return save('已到配置的最细验证周期');
    for (const tf of lowerFrames) {
      const { candles, fine, start, finish, cache } = prepare(window, tf, from, to);
      if (start.index === finish.index) { evidence.attempts.push({timeframe:tf,status:'pending',reason:'端点位于同一根 K 线，事件顺序不明'}); continue; }
      // expandAllTop:false：验证窗口只按 beam 前沿展开，不像主图顶层那样全量展开（否则全年 1h 验证 OOM）。
      const node = engine.decompose(fine,candles,[role],0,{beamK:3,maxDepth:3,cache,evidenceMode:true,timeframe:tf,finestResolution:tf===finestTf?finestTf:null,expandAllTop:false});
      const best = node.primary;
      // 采用树会挂进母级候选、跨候选长期驻留：只留主选与 beam 内备选，避免上千个窗口各自保留整棵候选池。
      if(best) Object.defineProperty(evidence,'adoptedNode',{value:{...node,alternates:(node.alternates||[]).slice(0,2)},writable:true,enumerable:false,configurable:true});
      const searchLimited = fine.length > 8 || node.searchLimited;
      const status = !best ? 'pending' : best.score.tier1 === 0 ? best.score.verificationStatus : searchLimited ? 'pending' : 'invalid';
      evidence.provenRoles=best ? best.score.provenRoles || 0 : 0;
      evidence.requiredRoles=best ? best.score.requiredRoles || 1 : 1;
      evidence.verificationScope=best && best.verificationScope || null;
      const attempt = {timeframe:tf,status:status || 'pending',pivotCount:fine.length,searchLimited:!!searchLimited,provenRoles:evidence.provenRoles,requiredRoles:evidence.requiredRoles,patternId:best && best.patternId,violations:best ? engine.candidateViolations(best) : [],pendingRoles:best ? best.score.pendingRoles : 1,structure:engine.serializeTree(node)};
      evidence.attempts.push(attempt);
      if (status === 'verified') { evidence.status='verified'; const filledHours=(evidence.dataGaps||[]).filter(g=>g.filled).reduce((n,g)=>n+g.hours,0); return save('所需角色及直接子结构已在声明的最细分辨率范围验证；边界以下子角色未证明'+(filledHours?'；窗口内 '+filledHours+' 小时交易所断档按母级极值约束插补':'')); }
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
    try { hourly = options.fetchHourly ? await options.fetchHourly(options.product,3600,start,end) : await fetchSharedHourly(null,options.product,start,end,298,{refresh:options.refresh}); }
    catch (e) { error = options.fetchHourly ? e.message : 'Coinbase 小时行情请求失败'; }
    if (hourly && hourly.fetchErrors && hourly.fetchErrors.length) error=hourly.fetchErrors.length+' 个小时行情分页获取失败；保留已获取数据，缺口窗口待验证';
  }
  const verifier = createSubwaveVerifier(engine,{...options,hourly,parentCandles:candles,mainTf,error});
  const verificationOptions = {...options,timeframe:mainTf,evidenceMode:true,finestResolution:mainTf===(options.finestTf||'1h')?mainTf:null,verification:options.finestTf === 'off' ? null : verifier};
  const tree = engine.buildCountTree(fine,candles,verificationOptions);
  tree.verification = {mainTimeframe:mainTf,finestTimeframe:options.finestTf || '1h',...verifier.stats,error};
  return {tree,verifier,verificationOptions,hourly};
}
module.exports = {createSubwaveVerifier,buildVerifiedCountTree,fetchSharedHourly,fillShortGaps,dropFilledPivots,MAX_GAP_HOURS};
