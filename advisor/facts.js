'use strict';

const { analyzeTimeframe, glueBreakout } = require('./indicators');
const { analyzeStructure } = require('./structure');
const { classifyState } = require('./state');
const { buildLevels } = require('./levels');
const { buildPositionAdvice } = require('./position');
const { resolveParams, describeParams } = require('./params');
const { PENDING } = require('./format');

const TF_NAMES = { weekly: '周线', daily: '日线', h4: '4H' };

function timeframeFacts(candles, key, params) {
  const label = TF_NAMES[key];
  const { facts, internals } = analyzeTimeframe(candles, label, params);
  const { facts: structure } = analyzeStructure(candles, internals, label, params);
  const tf = { ...facts, structure };
  if (key === 'daily') tf.glueBreakout = glueBreakout(candles, internals.glueSeries, params);
  tf.dataGaps = [...facts.dataGaps, ...structure.dataGaps];
  return tf;
}

// 事实层：确定性，同一组 K 线 + 参数 + 持仓输入必得同一份 JSON。
// positions：[{ symbol, side, cost, qty, equity, lev, liq, margin, markPrice, markSource, unsupported, reason }]
function buildFacts(market, { futures = null, futuresTried = false, positions = [], riskPct, overrides, notes = [] } = {}) {
  const params = resolveParams(overrides);
  const tfs = {
    weekly: timeframeFacts(market.weekly, 'weekly', params),
    daily: timeframeFacts(market.daily, 'daily', params),
    h4: timeframeFacts(market.h4, 'h4', params),
  };
  const state = classifyState(tfs);
  const levels = buildLevels(tfs, state, params);

  const risk = riskPct == null ? params.riskPct : riskPct;
  const advice = positions.map((p) => {
    if (p.unsupported) return { symbol: p.symbol, side: p.side, unsupported: true, reason: p.reason || '不支持', cost: p.cost == null ? PENDING : p.cost };
    const mark = futures ? futures.markPrice : (p.markPrice != null ? p.markPrice : null);
    const markSource = futures ? '合约标记价' : (p.markPrice != null ? '快照标记价（合约标记价获取失败）' : null);
    return buildPositionAdvice({ ...p, markPrice: mark, markSource, riskPct: risk }, tfs, levels, state, params);
  });

  const dropped = market.dropped || {};
  const badBars = (dropped.daily || 0) + (dropped.h4 || 0);
  const dataGaps = [...(badBars ? [`已丢弃 ${badBars} 根 OHLC 非有限数的坏 K 线（日线 ${dropped.daily || 0}、4H ${dropped.h4 || 0}）`] : []), ...tfs.weekly.dataGaps, ...tfs.daily.dataGaps, ...tfs.h4.dataGaps, ...levels.dataGaps];
  return {
    meta: {
      symbol: market.symbol,
      generatedAt: market.fetchedAt,
      mode: positions.length ? 'position' : 'points',
      spotPrice: tfs.daily.close,
      spotCloseIso: tfs.daily.lastCloseIso,
      futures: futures ? { ...futures, status: 'ok' } : { status: futuresTried ? '获取失败' : '未请求' },
      candleCounts: { weekly: market.weekly.length, daily: market.daily.length, h4: market.h4.length },
      notes: ['周线由 UTC 日线按周一 00:00 切分合成，只用已收盘 K 线', '结构与指标用现货 K 线；持仓风控的现价优先用合约标记价', ...notes],
    },
    timeframes: tfs,
    state,
    levels,
    positions: advice,
    dataGaps,
    params: describeParams(params),
  };
}

module.exports = { buildFacts, TF_NAMES };
