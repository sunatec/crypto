'use strict';

const WEEK = 604800;
const ORIGIN_NOTE = '数据起点为本交易所首根 K 线，并非品种诞生；之前的历史缺失，价格 0 至首根之间视为没有细节的一段';
const LIMITATIONS = '按 §3.12，自价格 0 起只列驱动浪，调整浪不列入。只枚举最大一级；未枚举嵌套级别、2 浪进行中、3 浪进行中及楔形的 4 浪进行中变体。候选搜索受既有引擎切分与递归上限限制，排除计数仅指本次枚举的读法。顶层读法只作证据，不改变排名或主选。';
const point = p => ({ price: p.price, timestamp: p.timestamp });

function range(points) {
  if (!points.length) return null;
  const sorted = points.slice().sort((a, b) => a.price - b.price || a.timestamp - b.timestamp);
  return { min: point(sorted[0]), max: point(sorted.at(-1)) };
}

function invalidationTiers(readings) {
  const prices = [...new Set(readings.map(r => r.points[1].price))].sort((a, b) => b - a);
  return prices.map(price => ({ price, operator: '<=', eliminated: readings.filter(r => r.points[1].price >= price).length,
    total: readings.length, wholeFamily: price === prices.at(-1) }));
}

// 可判定规则逐条执行，首条失败作为该读法唯一的排除原因。
function fourthWaveFailure(p1, p2, ath, postLow, now) {
  if (p2.price < 0) return '2 浪跌破价格 0（§1.5）';
  if (p1.price <= 0 || (p1.price - p2.price) / p1.price < 0.2) return '2 浪回撤不足 1 浪的 20%（§3.18.2）';
  if (ath.price <= p1.price) return '3 浪未超过 1 浪终点（§1.5）';
  if (postLow <= p1.price) return '4 浪进入 1 浪区域（§1.5、§3.17）';
  if (now - ath.timestamp > 2 * (ath.timestamp - p2.timestamp)) return '4 浪时间超过 3 浪时间的 2 倍（§3.21）';
  return null;
}

function meaning(key, readings, structure, ath, E) {
  const S = structure.points[0];
  const fourth = key === 'fourth-wave';
  const waveAt = (p, r) => {
    if (p.timestamp >= ath.timestamp) return fourth ? '4 浪' : '高一级调整';
    const boundaries = r.points.slice(1);
    const i = boundaries.findIndex(b => p.timestamp <= b.timestamp);
    return `${i < 0 ? boundaries.length : i + 1} 浪`;
  };
  const positions = [...new Set(readings.map(r => `${waveAt(S, r)} → ${waveAt(E, r)}`))];
  const p2 = range(readings.map(r => r.points[2]));
  const correction = fourth ? { wave: '3 浪', fromRange: p2, to: point(ath) }
    : { wave: '整个 0 → 历史最高的驱动浪', from: point(readings[0].points[0]), to: point(ath) };
  const first = S.timestamp === ath.timestamp && S.price === ath.price && E.timestamp > ath.timestamp;
  const contained = S.timestamp >= ath.timestamp && E.timestamp > ath.timestamp;
  const container = fourth ? '4 浪' : '高一级调整';
  const windowRole = { positions, correction, firstSegment: first,
    description: first ? `窗口下跌是顶层${container}的第一段`
      : contained ? `窗口结构是顶层${container}内部的一段，不能认定为第一段`
        : `窗口起点早于历史最高或终点尚未进入调整，跨越/位于顶层 ${positions.join('；')}，不能将整段窗口称为${container}的第一段` };
  const prefix = contained ? `${container}内部的` : `若历史最高之后的${container}包含当前反弹，则为其内部的`;
  const target = contained ? `针对窗口 ${S.price} → ${E.price}${first ? `（${container}第一段）` : ''}`
    : `针对${container}内相应下跌子段；窗口 ${S.price} → ${E.price} 跨浪，不能直接当作该子段`;
  return { windowRole, parentMapping: {
    combination: `${prefix} x / xx 连接浪，${target}`,
    flat: `${prefix} b 浪，${target}`,
    zigzag: `${prefix} b 浪，${target}`,
    impulse: fourth ? `5 浪起步，前提是 4 浪已在 E ${E.price} 完成${E.timestamp <= ath.timestamp ? '；E 尚未位于历史最高之后，该前提未满足' : ''}`
      : `新一轮驱动起步，前提是高一级调整已在 E ${E.price} 完成${E.timestamp <= ath.timestamp ? '；E 尚未位于历史最高之后，该前提未满足' : ''}`,
  } };
}

function buildTopLevelReadings(engine, background, structure) {
  if (!background || !background.available) return { available: false, reason: background ? background.reason : '未提供大级别背景' };
  const daily = background.cleanedDaily;
  if (!daily || !daily.length) return { available: false, reason: '背景截取后的全部日线不可用' };
  if (!structure || !structure.points || structure.points.length < 2) return { available: false, reason: '窗口结构起终点不足' };
  const realWeekly = engine.transformCandles(daily, engine.TIMEFRAMES['1w']);
  const virtual = { timestamp: realWeekly[0].timestamp - WEEK, open: 0, high: 0, low: 0, close: 0, volume: 0 };
  const weekly = [virtual, ...realWeekly];
  const zero = { index: 0, timestamp: virtual.timestamp, price: 0, type: 'L', virtual: true };
  const high = background.extremes.high;
  const athIndex = weekly.findIndex((c, i) => i > 0 && c.timestamp <= high.timestamp && high.timestamp < c.timestamp + WEEK);
  const ath = { ...high, index: athIndex, type: 'H' };
  const pivots = engine.anchorBoundaryExtremes(weekly, engine.detectPivots(weekly, 1)).map(p => {
    const day = daily.find(c => c.timestamp >= weekly[p.index].timestamp && c.timestamp < weekly[p.index].timestamp + WEEK
      && (p.type === 'H' ? c.high : c.low) === p.price);
    return { ...p, timestamp: day ? day.timestamp : p.timestamp };
  });
  const fine = [zero, ...pivots.filter(p => p.index > 0 && p.index < athIndex), ath];
  const E = structure.points.at(-1);
  const now = daily.at(-1).timestamp;
  const after = daily.filter(c => c.timestamp > ath.timestamp);
  const postLow = after.length ? Math.min(...after.map(c => c.low)) : Infinity;
  const cache = new Map();
  const completed = engine.decompose(fine, weekly, ['driving'], 0, { maxDepth: 4, beamK: 6, cache, timeframe: '1w' });
  const families = [];
  function family(key, label, candidates, missingReason) {
    const survivors = candidates.filter(r => !r.failure);
    const reasons = {};
    for (const r of candidates.filter(r => r.failure)) reasons[r.failure] = (reasons[r.failure] || 0) + 1;
    if (!candidates.length && missingReason) reasons[missingReason] = 0;
    const representative = survivors.slice().sort((a, b) => b.points[1].price - a.points[1].price)[0];
    families.push({ key, label, legal: survivors.length,
      pending: survivors.filter(r => r.pending.length).length, excluded: candidates.length - survivors.length, excludedReasons: reasons,
      pendingReasons: [...new Set(survivors.flatMap(r => r.pending))],
      p1Range: range(survivors.map(r => r.points[1])), p2Range: range(survivors.map(r => r.points[2])),
      representative: representative ? { patternId: representative.patternId, points: representative.points.map(point), pending: representative.pending } : null,
      ...(survivors.length ? meaning(key, survivors, structure, ath, E) : { windowRole: null, parentMapping: null }),
      invalidationTiers: key === 'fourth-wave' ? invalidationTiers(survivors) : [],
      invalidation: key === 'fourth-wave' ? '4 浪最低价必须严格高于 P1；等于阈值即排除。时间也必须 ≤ 2×3 浪；5 浪完成后复核 3 浪非最短。'
        : '高一级调整不得跌破整个驱动浪的价格 0 起点；P1 为内部取点，不用作高一级调整的整体失效线。',
    });
  }
  const completePool = completed && !completed.isLeaf ? [completed.primary, ...(completed.alternates || [])].filter(Boolean) : [];
  family('complete-driving', '完整驱动浪', completePool.map(c => ({ patternId: c.patternId, points: c.points,
    failure: c.score.tier1 > 0 ? (c.score.failed?.[0]?.desc || c.score.grammarNotes?.[0]?.desc || '子浪角色违规') : null,
    pending: [...(c.score.verificationStatus === 'verified' ? [] : ['子浪角色或规则待验证']),
      ...(c.score.pendingRules || []).map(r => `${r.desc}：${r.reason}`)],
  })), '周线枢轴不足或引擎未枚举出完整驱动浪');
  const partial = [];
  for (const p1 of fine.filter(p => p.type === 'H' && p.index < athIndex)) {
    const between = weekly.slice(p1.index + 1, athIndex);
    if (!between.length) continue;
    const minBar = between.reduce((a, b) => b.low < a.low ? b : a);
    const p2Index = weekly.indexOf(minBar);
    const minDay = daily.find(c => c.timestamp >= minBar.timestamp && c.timestamp < minBar.timestamp + WEEK && c.low === minBar.low);
    const p2 = { index: p2Index, timestamp: minDay ? minDay.timestamp : minBar.timestamp, price: minBar.low, type: 'L' };
    const pts = [zero, p1, p2, ath];
    let failure = weekly.slice(0, p2Index).some(c => c.high > p1.price) ? 'P1 不是价格 0 至 P2 之前的最高价' : null;
    failure ||= fourthWaveFailure(p1, p2, ath, postLow, now);
    const pending = ['3 浪不是最短：须待 5 浪完成（§1.5）'];
    if (!after.length) pending.push('历史最高之后暂无日线，4 浪尚未可观察');
    if (!failure) {
      const opts = { maxDepth: 3, beamK: 6, cache, timeframe: '1w' };
      for (let i = 0; i < 3; i++) {
        const segment = [pts[i], ...fine.filter(p => p.index > pts[i].index && p.index < pts[i + 1].index), pts[i + 1]];
        const checked = engine.evaluateLegRole(segment, i === 1 ? 'corrective' : 'driving', weekly, 0, opts, `${i + 1} 浪`);
        if (checked.violates || checked.evidence.status === 'invalid') { failure = `${i + 1} 浪子浪角色违规：${checked.note || checked.evidence.reason}`; break; }
        if (checked.evidence.status === 'pending') pending.push(`${i + 1} 浪子浪角色待验证`);
      }
    }
    partial.push({ patternId: 'impulse-fourth-forming', points: pts, failure, pending });
  }
  family('fourth-wave', '3 浪终点、4 浪进行中', partial, '没有可枚举的 P1/P2');
  return { available: true, dataOrigin: { ...background.listing, note: ORIGIN_NOTE, virtualStart: point(zero) },
    historicalHigh: point(ath), weeklyCount: weekly.length, families,
    spikes: background.spikes.filter(s => s.classification === 'volume'), limitations: LIMITATIONS };
}

function parentEvidence(topLevel, key) {
  if (!topLevel.available) return `不可用（${topLevel.reason}），父级身份无顶层依据。`;
  const alive = topLevel.families.filter(f => f.legal > 0);
  if (!alive.length) return '顶层读法全部被排除，父级身份无顶层依据。';
  return alive.map(f => `${f.label}下为${f.parentMapping[key]}`).join('；') + '。';
}

function renderTopLevelReadings(engine, topLevel, precision) {
  const L = ['## 顶层读法（自价格 0，周线）', ''];
  if (!topLevel.available) return [...L, `顶层读法不可用：${topLevel.reason}。`, ''].join('\n');
  const px = n => engine.formatPrice(n, precision);
  const date = ts => new Date((ts + 8 * 3600) * 1000).toISOString().slice(0, 10);
  const pt = p => `${px(p.price)} @ ${date(p.timestamp)}`;
  const span = r => r ? `${pt(r.min)} ～ ${pt(r.max)}` : '—';
  L.push(`> ${topLevel.dataOrigin.note}。首根 ${pt(topLevel.dataOrigin)}。`, '',
    '| 类别 | 合规（含待定） | 其中待定 | 排除 | P1 范围（日期） | P2 范围（日期） | 排除原因（首条计数） |',
    '|---|---|---|---|---|---|---|');
  for (const f of topLevel.families) L.push(`| ${f.label} | ${f.legal} | ${f.pending} | ${f.excluded} | ${span(f.p1Range)} | ${span(f.p2Range)} | ${Object.entries(f.excludedReasons).map(([r, n]) => `${r}：${n}`).join('；') || '—'} |`);
  for (const f of topLevel.families.filter(f => f.legal > 0)) {
    const c = f.windowRole.correction;
    L.push('', `### ${f.label}`, '', `${f.windowRole.description}；修正的是${c.wave}（${c.fromRange ? span(c.fromRange) : pt(c.from)} → ${pt(c.to)}）。`,
      `代表读法（P1 最高）：${f.representative.patternId}，${f.representative.points.map(pt).join(' → ')}。`,
      `待定事项：${f.pendingReasons.join('；') || '无'}。`,
      '', `- XX / X：${f.parentMapping.combination}。`, `- B：${f.parentMapping.flat}。`, `- 新推动：${f.parentMapping.impulse}。`, '', `失效条件：${f.invalidation}`);
    for (const t of f.invalidationTiers) L.push(`- 跌破或触及 ${px(t.price)}，累计淘汰 ${t.eliminated}/${t.total} 个读法${t.wholeFamily ? '，类别整体失效' : ''}。`);
  }
  if (topLevel.spikes.length) {
    L.push('', '参与计算的有量扎针（§3.15 保留）：');
    for (const s of topLevel.spikes) L.push(`- ${require('./spike-detection').formatSpike(s, px)}`);
  } else L.push('', '参与计算的有量扎针：无。');
  L.push('', topLevel.limitations, '');
  return L.join('\n');
}

module.exports = { buildTopLevelReadings, renderTopLevelReadings, parentEvidence, invalidationTiers, fourthWaveFailure };
