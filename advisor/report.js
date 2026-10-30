'use strict';

const { fmtPrice: px, fmtPct: pct, fmtPctPlain: pctp, PENDING } = require('./format');

// 事实 JSON → Markdown（手册 §19.2 A–H）/ 终端摘要。这里只做格式化，不产生新数字：
// 报告里出现的每个数字都必须能在事实 JSON 里找到（见 numbers.js 与测试）。

const DISCLAIMER = '免责声明：本报告由脚本依据《半木夏交易体系》手册的规则，对 Binance 公开 K 线做确定性计算，所有内容都是条件性计划，不构成投资建议，不承诺盈利。规则里的量化阈值多为手册 D 级（执行建议），并非半木夏本人的固定数字；技术偏多也不等于可以容忍强平先于止损。';

const SLOPE = { up: '上行', flat: '走平', down: '下行' };
const ALIGN = { bull: '多头排列', bear: '空头排列', mixed: '交错' };
const SIDE = { long: '多', short: '空' };
const SRC_NOTE = { A: '本人公开', B: '转载', D: '手册执行建议' };
const MA_SETS = { weekly: [5, 10, 30], daily: [30, 90, 120, 256], h4: [30, 90, 120] };
const TF_TITLE = { weekly: '周线', daily: '日线', h4: '4H' };
const mark = (met) => (met === true ? '✓' : (met === false ? '✗' : '？数据不足'));
const cell = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const table = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');
const srcText = (z) => z.sources.map((s) => `${s.label} ${px(s.price)}`).join('、');
const tfName = (k) => TF_TITLE[k];

function maLine(tf, periods) {
  const parts = [];
  for (const p of periods) {
    const m = tf.ma[p];
    parts.push(m ? `MA${p} ${px(m.value)}（偏离 ${pct(m.devPct)}，${m.slope ? SLOPE[m.slope] : '斜率待查'}）` : `MA${p} 数据不足`);
  }
  return parts.join('；');
}

function divText(tf) {
  const out = [];
  const m = tf.macd;
  out.push(m ? `柱 ${px(m.hist)}（前一根 ${px(m.prevHist)}）` : 'MACD 数据不足');
  for (const side of ['bottom', 'top']) {
    const d = tf.structure.divergence[side];
    const name = side === 'bottom' ? '三段底背离' : '三段顶背离';
    if (d.status === 'confirmed') out.push(`${name}：已确认，止损 ${px(d.stopPrice)}`);
    else if (d.status === 'forming') out.push(`${name}：可能出现背离，但三段背离尚未被确认`);
    else if (d.ordinary) out.push(`${name}：仅普通背离（缺反向柱分隔）`);
  }
  return out.join('；');
}

function structureText(tf) {
  const s = tf.structure;
  const hi = s.lastHigh ? `最近高点 ${px(s.lastHigh.price)}` : '最近高点待查';
  const lo = s.lastLow ? `最近低点 ${px(s.lastLow.price)}` : '最近低点待查';
  return `${s.pattern || '结构数据不足'}；${hi}；${lo}`;
}

function templateNarrative(facts) {
  const st = facts.state;
  const sup = facts.levels.zones.support[0];
  const res = facts.levels.zones.resistance[0];
  const price = facts.meta.spotPrice;
  const parts = [`现价 ${px(price)}，盘面属于「${st.label}」——${st.rule}。`];
  if (sup) parts.push(`下方最近的共振支撑在 ${px(sup.low)}${sup.high > sup.low ? `–${px(sup.high)}` : ''}（${sup.count} 个来源叠在一起）。`);
  if (res) parts.push(`上方最近的压力在 ${px(res.low)}${res.high > res.low ? `–${px(res.high)}` : ''}。`);
  const p = facts.positions[0];
  if (p && !p.unsupported && p.invalidation) parts.push(`你的${SIDE[p.side]}单成本 ${px(p.cost)}，结构失效价 ${px(p.invalidation.price)}，守不住就按计划走，不要拿浮亏当持有的理由。`);
  else parts.push('没到右侧确认之前别急着动手，计划里的失效价就是认错线。');
  return parts.join('');
}

function headline(facts) {
  const st = facts.state;
  const sup = facts.levels.zones.support[0];
  const res = facts.levels.zones.resistance[0];
  const lines = [];
  const p = facts.positions[0];
  if (p && !p.unsupported) {
    lines.push(`**${p.headline}**`);
    lines.push(`方向：${SIDE[p.side]}；成本 ${px(p.cost)}；${p.invalidation ? `失效价 ${px(p.invalidation.price)}（相对成本 ${typeof p.stopPnlPct === 'number' ? pct(p.stopPnlPct) : PENDING}）` : `失效价${PENDING}`}。`);
    if (p.pending.length) lines.push(`最重要的未知项：${p.pending.join('、')}（标"待查"，未估算）。`);
  } else {
    lines.push(`**状态：${st.label}（${st.state}）**——${st.rule}。`);
    const where = [];
    if (sup) where.push(`下方最近支撑区 ${px(sup.low)}–${px(sup.high)}（${sup.count} 源）`);
    if (res) where.push(`上方最近阻力区 ${px(res.low)}–${px(res.high)}（${res.count} 源）`);
    lines.push(`现价 ${px(facts.meta.spotPrice)}；${where.join('；') || '未找到共振区'}。所有计划都是条件性的，需右侧确认。`);
  }
  if (facts.dataGaps.length) lines.push(`数据缺口 ${facts.dataGaps.length} 项（见 C 节与附录），涉及指标已标"数据不足"。`);
  return lines.join('\n\n');
}

function sectionA(facts, narrative) {
  const src = narrative.source === 'llm' ? 'Claude 生成，数字已逐一校验出自事实 JSON' : '模板生成';
  const out = ['## A. 一句话结论', '', headline(facts), '', `> 叙述（${src}）：${narrative.text}`];
  if (narrative.note) out.push('', `> ${narrative.note}`);
  return out.join('\n');
}

function sectionB(facts) {
  const out = ['## B. 账户体检', ''];
  if (!facts.positions.length) return [...out, '未提供账户信息（点位模式）。如需持仓建议，请加 `--cost --side`，或用 `--snapshot` 提供手册 §20.2 快照。'].join('\n');
  const rows = [];
  const notes = [];
  for (const p of facts.positions) {
    if (p.unsupported) { rows.push([p.symbol, SIDE[p.side] || PENDING, px(p.cost), '—', '—', '—', '—', '—', `不支持：${p.reason}`]); continue; }
    rows.push([p.symbol, SIDE[p.side], px(p.cost), typeof p.qty === 'number' ? px(p.qty) : p.qty, typeof p.equity === 'number' ? px(p.equity) : p.equity,
      typeof p.lev === 'number' ? px(p.lev) : p.lev, typeof p.liq === 'number' ? px(p.liq) : p.liq, `${px(p.price)}（${p.priceSource}）`, pct(p.floatPnlPct)]);
    for (const w of p.warnings) notes.push(`- ${w}`);
  }
  out.push(table(['合约', '方向', '成本', '数量', '相关风险池权益', '设置杠杆', '强平价', '现价（来源）', '浮盈亏'], rows));
  out.push('', '钱包余额、可用余额、维持保证金率、订单保护率、币种集中度：未提供，标"待查"。全仓与逐仓分开算，币本位不支持。');
  if (facts.meta.futures.status === 'ok') {
    const f = facts.meta.futures;
    out.push('', `合约标记价 ${px(f.markPrice)}，最近资金费率 ${f.fundingRate == null ? PENDING : pct(f.fundingRate, 4)}；现货日线收盘价 ${px(facts.meta.spotPrice)}，两者并列展示。`);
  } else {
    out.push('', `合约标记价：${facts.meta.futures.status}，风控改用现货日线收盘价 ${px(facts.meta.spotPrice)}。`);
  }
  if (notes.length) out.push('', ...[...new Set(notes)]);
  return out.join('\n');
}

function sectionC(facts) {
  const tfs = facts.timeframes;
  const rows = ['weekly', 'daily', 'h4'].map((k) => {
    const tf = tfs[k];
    const s = tf.structure;
    const align = tf.alignment ? ALIGN[tf.alignment] : '排列待查';
    const m30 = tf.ma[30];
    const trend = m30 ? `收盘 ${px(tf.close)} ${tf.close >= m30.value ? '在' : '低于'} MA30 ${px(m30.value)}（${m30.slope ? SLOPE[m30.slope] : '斜率待查'}），${align}` : `${align}（MA30 数据不足）`;
    const fail = k === 'weekly'
      ? (m30 ? `周线收盘跌破 MA30 ${px(m30.value)}` : '待查')
      : `多头：跌破 ${s.lastLow ? px(s.lastLow.price) : '待查'}；空头：升破 ${s.lastHigh ? px(s.lastHigh.price) : '待查'}`;
    return [tfName(k), structureText(tf), maLine(tf, MA_SETS[k]), divText(tf), trend, fail];
  });
  const out = ['## C. 多周期图形', '', table(['周期', '价格结构', '关键 MA 与方向', 'MACD / 背离', '趋势结论', '失效点'], rows)];

  const d = tfs.daily;
  if (d.glue) out.push('', `日线 MA30/90/120 粘合：${d.glue.glued ? '是' : '否'}（带宽 ${pctp(d.glue.spreadPct)}，带 ${px(d.glue.bandLow)}–${px(d.glue.bandHigh)}）。`);
  if (d.glueBreakout && d.glueBreakout.dir) out.push(`粘合后${d.glueBreakout.dir === 'up' ? '向上突破' : '向下跌破'}，回踩${d.glueBreakout.retest ? '已出现' : '未出现'}。`);

  out.push('', `**市场状态判定：${facts.state.label}（${facts.state.state}）**——${facts.state.rule}`, '');
  for (const c of facts.state.conditions) out.push(`- ${mark(c.met)} ${c.text}`);

  for (const k of ['daily', 'h4']) {
    for (const side of ['bottom', 'top']) {
      const dv = tfs[k].structure.divergence[side];
      if (dv.status === 'none') continue;
      out.push('', `### ${tfName(k)} ${side === 'bottom' ? '三段底背离' : '三段顶背离'}：${dv.status === 'confirmed' ? '已确认' : '可能出现背离，但三段背离尚未被确认'}（手册 §8.4 字段）`, '',
        `- 周期 ${dv.timeframe}；MACD 参数 ${dv.macdParams}`,
        `- 三个${side === 'bottom' ? '低' : '高'}点：${dv.extremes.map((e) => `${px(e.price)}（${e.iso.slice(0, 10)}，柱${side === 'bottom' ? '谷' : '峰'} ${px(e.histExtreme)}）`).join(' → ')}`,
        `- 反向柱是否出现：${dv.oppositeBarSeen ? '是' : '否/仅接近零轴'}；最后收盘 ${dv.lastClosedIso}`,
        `- 第三${side === 'bottom' ? '低' : '高'}点止损价 ${px(dv.stopPrice)}`, `- 下一根 K 线失效规则：${dv.nextBarRule}`,
        `- 上级别方向、盈亏比、风险预算：见 D/E 节`);
    }
  }
  if (facts.dataGaps.length) out.push('', '**数据缺口**（不估算、不编造）：', ...facts.dataGaps.map((g) => `- ${g}`));
  return out.join('\n');
}

function planCard(c) {
  const z = c.zone;
  const head = `### ${c.side === 'support' ? '支撑区' : '阻力区'} ${px(z.low)}${z.high > z.low ? `–${px(z.high)}` : ''}（${z.count} 源共振，距现价 ${pct(c.distancePct)}）——${c.tag}`;
  const lines = [head, '', `- 构成：${srcText(z)}`];
  if (c.kind !== 'plan') return lines.join('\n');
  const dirText = c.direction === 'long' ? '多' : '空';
  lines.push(`- 左侧${dirText}单挂单带：${px(c.entry.low)}–${px(c.entry.high)}（小仓、分层，总风险按预算反推）`);
  lines.push('- 右侧触发（三选一，不必同时满足）：');
  for (const t of c.triggers) lines.push(`  - ${mark(t.met)} ${t.text}`);
  lines.push(`- 失效价：${c.invalidation ? `${px(c.invalidation.price)}（${c.invalidation.basis}）` : PENDING}`);
  lines.push(`- TP1：${c.tp1 == null ? PENDING : px(c.tp1)}；TP2：${c.tp2 == null ? PENDING : px(c.tp2)}`);
  lines.push(`- 盈亏比：${c.rr == null ? PENDING : px(c.rr)}${c.rrFlag ? `（⚠ ${c.rrFlag}，低于阈值仍保留以供参考）` : ''}`);
  for (const n of c.notes) lines.push(`- ${n}`);
  return lines.join('\n');
}

function sectionD(facts) {
  const d = facts.timeframes.daily;
  const w = facts.timeframes.weekly;
  const ma90 = d.ma[90];
  const ma120 = d.ma[120];
  const wMA30 = w.ma[30];
  const s = d.structure;
  const out = ['## D. 主情景 / 备选情景与共振点位', '',
    table(['情景', '触发条件', '反证 / 失效'], [
      ['继续上涨', s.lastHigh ? `日线收盘站上最近高点 ${px(s.lastHigh.price)}，4H 结构保持 HH/HL` : '日线最近高点待查', s.lastLow ? `日线收盘跌破最近低点 ${px(s.lastLow.price)}` : '待查'],
      ['深度回撤', ma90 ? `日线收盘跌破 MA90 ${px(ma90.value)}${ma120 ? `，向 MA120 ${px(ma120.value)} 靠拢` : ''}` : 'MA90 数据不足', ma120 ? `回踩出现止跌 K 并收回 MA90 ${px(ma90 ? ma90.value : 0)}` : '待查'],
      ['趋势破坏', `${wMA30 ? `周线收盘在 MA30 ${px(wMA30.value)} 之下且 MA30 下行` : '周线 MA30 数据不足'}；或日线收盘跌破最近确认 HL 且 MA90 走平/下行`, '重新站回并形成新的 HL，才算多头重新证明自己'],
    ]), ''];
  const plans = facts.levels.plans;
  if (!plans.length) out.push('未生成共振点位计划（见数据缺口）。');
  else {
    out.push('共振区按来源数排序、现价上下各取至多 3 个。顺大级别方向给完整计划，逆势方向只列观察位。', '');
    out.push(plans.map(planCard).join('\n\n'));
  }
  return out.join('\n');
}

function sectionE(facts) {
  const out = ['## E. 单笔风控', ''];
  const ps = facts.positions.filter((p) => !p.unsupported);
  if (!ps.length) {
    const plans = facts.levels.plans.filter((c) => c.kind === 'plan');
    if (!plans.length) return [...out, '点位模式：没有可执行的计划卡。'].join('\n');
    out.push('点位模式未提供仓位，下表是各计划卡的价位风控；仓位上限按 `Q_max = 权益 × 风险比例 ÷ (入场价 − 失效价)` 反推，提供 `--qty --equity` 后给出具体数字。', '');
    out.push(table(['计划', '方向', '入场中值', '失效价', 'TP1', '盈亏比', '备注'], plans.map((c) => [
      `${c.side === 'support' ? '支撑' : '阻力'}区 ${px(c.zone.low)}–${px(c.zone.high)}`, c.direction === 'long' ? '多' : '空', px(c.entry.mid),
      c.invalidation ? px(c.invalidation.price) : PENDING, c.tp1 == null ? PENDING : px(c.tp1), c.rr == null ? PENDING : px(c.rr), c.rrFlag || '',
    ])));
    return out.join('\n');
  }
  for (const p of ps) {
    const r = p.risk;
    out.push(`### ${p.symbol} ${SIDE[p.side]}单`, '');
    const rows = [
      ['持有量', typeof p.qty === 'number' ? px(p.qty) : PENDING],
      ['现价（' + p.priceSource + '）', px(p.price)],
      ['结构失效价', p.invalidation ? `${px(p.invalidation.price)}（${p.invalidation.basis}）` : PENDING],
      ['止损距离', r.available && typeof r.stopDistance === 'number' ? `${px(r.stopDistance)}（${pctp(r.stopDistancePct)}）` : PENDING],
      ['失效价止损相对成本', typeof p.stopPnlPct === 'number' ? pct(p.stopPnlPct) : PENDING],
      ['预期新增损失 ΔLoss（从现价到止损）', r.available && typeof r.deltaLoss === 'number' ? `${px(r.deltaLoss)}（占权益 ${pctp(r.deltaLossPctEquity)}）` : PENDING],
      ['累计损失 TradeLoss（从成本到止损）', r.available && typeof r.tradeLoss === 'number' ? `${px(r.tradeLoss)}（占权益 ${pctp(r.tradeLossPctEquity)}）` : PENDING],
      [`风险预算（权益 × ${pctp(p.riskPct)}）`, r.available ? px(r.riskBudget) : PENDING],
      ['仓位上限 Q_max', r.available && typeof r.qMax === 'number' ? px(r.qMax) : PENDING],
      ['名义价值', r.available ? px(r.notional) : PENDING],
      ['实际杠杆（名义 ÷ 权益）', r.available ? px(r.leverage) : PENDING],
      ['强平价与缓冲', r.liquidation.checked || r.liquidation.liq != null ? `${px(r.liquidation.liq)}（距现价 ${pctp(r.liquidation.bufferPct)}；${r.liquidation.note}）` : PENDING],
    ];
    const plan = facts.levels.plans.find((c) => c.kind === 'plan' && c.direction === p.side && c.tp1 != null);
    rows.push(['止盈区', plan ? `TP1 ${px(plan.tp1)}${plan.tp2 != null ? `；TP2 ${px(plan.tp2)}` : ''}（最小盈亏比 ${plan.rr == null ? PENDING : px(plan.rr)}）` : PENDING]);
    out.push(table(['项目', '数值'], rows), '');
  }
  return out.join('\n');
}

function sectionF(facts) {
  const out = ['## F. 分步操作表', ''];
  const ps = facts.positions.filter((p) => !p.unsupported);
  if (!ps.length) return [...out, '点位模式没有持仓，不适用。入场后按风险预算重新计算每一步（手册 §14.2）。'].join('\n');
  for (const p of ps) {
    const r = p.risk;
    out.push(`### ${p.symbol} ${SIDE[p.side]}单`, '');
    if (!r.available) { out.push(`缺少数量或权益，减仓分步表${PENDING}。`, ''); continue; }
    if (!r.reduction.length) { out.push('风险在预算内且实际杠杆不高于参考线，无需减仓。', ''); continue; }
    const iso = p.margin === 'isolated';
    const head = ['步骤', '操作', '该步减少名义价值', '剩余名义价值', '权益', iso ? '实际杠杆（保留保证金）' : '实际杠杆', ...(iso ? ['实际杠杆（释放保证金）'] : []), '累计止损亏损（占权益）', '统一 -5% 损失', '是否达标'];
    out.push(table(head, r.reduction.map((x) => {
      const five = x.stress.find((s) => s.pct === 5);
      return [x.step, x.action, px(x.reduceNotional), px(x.remainNotional), px(x.equity), px(x.leverage), ...(iso ? [x.leverageReleaseMargin == null ? PENDING : px(x.leverageReleaseMargin)] : []),
        x.tradeLoss == null ? PENDING : `${px(x.tradeLoss)}（${pctp(x.tradeLossPctEquity)}）`, five ? px(five.loss) : PENDING,
        `${x.withinBudget === true ? '预算内' : (x.withinBudget === false ? '超预算' : PENDING)}；杠杆${x.withinLevRef ? '≤' : '>'}参考线`];
    })), '');
    if (r.reduction[r.reduction.length - 1].remainQty === 0) out.push('⚠ 即使每步按 25% 减到最后，也只有整仓平掉才能使止损亏损落入预算：这笔仓位相对权益过大，或成本离失效价太远。', '');
    out.push('静态模拟：市场价不变时权益大体不变，减少的是敞口；手续费、滑点、资金费、保证金转出会让权益变化。维持保证金率与可用余额：待查（需交易所快照）。', '');
  }
  return out.join('\n');
}

function sectionG(facts) {
  const out = ['## G. 组合压力测试', ''];
  const ps = facts.positions.filter((p) => !p.unsupported && p.risk.available);
  if (!ps.length) return [...out, facts.positions.length ? `缺少数量或权益，压力测试${PENDING}。` : '点位模式没有持仓，不适用。'].join('\n');
  for (const p of ps) {
    const r = p.risk;
    const finalRow = r.reduction.length ? r.reduction[r.reduction.length - 1] : null;
    out.push(`### ${p.symbol} ${SIDE[p.side]}单（同向统一${p.side === 'long' ? '下跌' : '上涨'}）`, '');
    out.push(table(['情景', '动作前新增理论亏损（占权益）', ...(finalRow ? ['减仓到位后新增理论亏损（占权益）'] : [])],
      r.stress.map((s, i) => [`${p.side === 'long' ? '-' : '+'}${s.pct}%`, `${px(s.loss)}（${pctp(s.pctEquity)}）`,
        ...(finalRow ? [`${px(finalRow.stress[i].loss)}（${pctp(finalRow.stress[i].pctEquity)}）`] : [])])), '');
  }
  out.push('这是一阶线性估算：不得把"跌到某个百分比静态净权益为负"说成"刚好在那里强平"，实际强平可能更早（阶梯维持保证金、标记价、费用、风险限额）。BTC/山寨差异化压力、停机与流动性枯竭、反向套保的净敞口：待查。');
  return out.join('\n');
}

function sectionH(facts) {
  const out = ['## H. 最终建议', ''];
  const ps = facts.positions.filter((p) => !p.unsupported);
  if (ps.length) {
    for (const p of ps) {
      out.push(`### ${p.symbol} ${SIDE[p.side]}单`, '');
      const groups = [['止损', 'stop'], ['减仓', 'reduce'], ['持有', 'hold'], ['加仓', 'add']];
      if (p.warnings.some((w) => w.startsWith('强平先于止损'))) groups.unshift(['优先', null]);
      let n = 1;
      for (const [name, key] of groups) {
        if (key === null) { out.push(`${n}. **优先**：${p.warnings.find((w) => w.startsWith('强平先于止损'))}`); n += 1; continue; }
        for (const a of p.actions[key]) { out.push(`${n}. **${name}**：${a}`); n += 1; }
      }
      out.push('');
    }
  } else {
    const plans = facts.levels.plans.filter((c) => c.kind === 'plan');
    let n = 1;
    out.push(`${n}. **总原则**：${facts.state.label}——${facts.state.rule}。周线定方向、日线选位置、4H 等确认；单一信号不覆盖风险约束。`); n += 1;
    const good = plans.filter((c) => !c.rrFlag);
    if (good.length) {
      for (const c of good) { out.push(`${n}. **可参与**：${c.side === 'support' ? '支撑' : '阻力'}区 ${px(c.zone.low)}–${px(c.zone.high)}（${c.zone.count} 源），${c.triggerMet ? '右侧触发已有满足项' : '右侧触发尚未满足，只能小仓左侧或继续等'}；失效 ${c.invalidation ? px(c.invalidation.price) : PENDING}，盈亏比 ${c.rr == null ? PENDING : px(c.rr)}。`); n += 1; }
    } else out.push(`${n}. **可参与**：当前没有盈亏比达标的计划卡，等价格走到更好的位置。`), n += 1;
    for (const c of plans.filter((x) => x.rrFlag)) { out.push(`${n}. **不建议**：区 ${px(c.zone.low)}–${px(c.zone.high)} ${c.rrFlag}（盈亏比 ${px(c.rr)}）。`); n += 1; }
    const watch = facts.levels.plans.filter((c) => c.kind === 'watch');
    if (watch.length) { out.push(`${n}. **观察位**：${watch.map((c) => `${px(c.zone.low)}–${px(c.zone.high)}`).join('、')}，不给入场计划。`); n += 1; }
    out.push(`${n}. **失败怎么办**：触及失效价即按计划退出，不摊低成本；不加仓条件 = 右侧三条触发均未满足。`);
  }
  out.push('', `数据缺口及影响：${facts.dataGaps.length ? `${facts.dataGaps.length} 项指标因历史不足未计算（见 C 节），相关判定不参与结论。` : '无。'}`);
  return out.join('\n');
}

function appendix(facts) {
  const v = (x) => (Array.isArray(x) ? x.join('、') : String(x));
  const rows = facts.params.map((p) => [p.name, v(p.value), `${p.source}（${SRC_NOTE[p.source]}）`, p.note]);
  return ['## 附录：本次参数与来源级别', '', '来源：A 本人公开 / B 转载 / D 手册执行建议。所有量化阈值均集中在 `advisor/params.js`。', '', table(['参数', '取值', '来源', '说明'], rows)].join('\n');
}

function renderReport(facts, narrative = { text: templateNarrative(facts), source: 'template' }) {
  const m = facts.meta;
  const f = m.futures;
  const head = [
    `> ${DISCLAIMER}`, '',
    `# ${m.symbol} 半木夏体系${m.mode === 'position' ? '持仓建议' : '共振点位'}报告`, '',
    `- 数据采集时间：${m.generatedAt}（UTC）；交易所：Binance 现货 K 线；日界：UTC`,
    `- 现货日线收盘价 ${px(m.spotPrice)}（${m.spotCloseIso ? m.spotCloseIso.slice(0, 10) : PENDING} 收盘）`,
    `- 合约标记价：${f.status === 'ok' ? `${px(f.markPrice)}；资金费率 ${f.fundingRate == null ? PENDING : pct(f.fundingRate, 4)}` : f.status}`,
    `- K 线根数：周 ${m.candleCounts.weekly} / 日 ${m.candleCounts.daily} / 4H ${m.candleCounts.h4}`,
    ...m.notes.map((n) => `- ${n}`),
  ];
  return [head.join('\n'), sectionA(facts, narrative), sectionB(facts), sectionC(facts), sectionD(facts), sectionE(facts), sectionF(facts), sectionG(facts), sectionH(facts), appendix(facts), `> ${DISCLAIMER}`].join('\n\n') + '\n';
}

function renderTerminal(facts) {
  const m = facts.meta;
  const lines = [`【${m.symbol}】${m.mode === 'position' ? '持仓模式' : '点位模式'}  现货收盘 ${px(m.spotPrice)}`, `状态：${facts.state.label}（${facts.state.state}）— ${facts.state.rule}`];
  const zoneLine = (z) => `  ${px(z.low)}${z.high > z.low ? `–${px(z.high)}` : ''}  ${z.count} 源  ${pct(z.distancePct)}  ${z.sources.map((s) => s.label).join(' + ')}`;
  const res = facts.levels.zones.resistance;
  const sup = facts.levels.zones.support;
  if (res.length) lines.push('上方阻力区：', ...[...res].reverse().map(zoneLine));
  if (sup.length) lines.push('下方支撑区：', ...sup.map(zoneLine));
  for (const p of facts.positions) {
    if (p.unsupported) { lines.push(`${p.symbol}：不支持（${p.reason}）`); continue; }
    lines.push(`${p.symbol} ${SIDE[p.side]}单：${p.headline}`);
    for (const key of ['stop', 'reduce', 'hold', 'add']) lines.push(`  ${{ stop: '止损', reduce: '减仓', hold: '持有', add: '加仓' }[key]}：${p.actions[key][0]}`);
  }
  if (!facts.positions.length) {
    for (const c of facts.levels.plans.filter((x) => x.kind === 'plan').slice(0, 3)) {
      lines.push(`计划：${px(c.zone.low)}–${px(c.zone.high)}  失效 ${c.invalidation ? px(c.invalidation.price) : PENDING}  TP1 ${c.tp1 == null ? PENDING : px(c.tp1)}  盈亏比 ${c.rr == null ? PENDING : px(c.rr)}${c.rrFlag ? `（${c.rrFlag}）` : ''}`);
    }
  }
  if (facts.dataGaps.length) lines.push(`数据缺口 ${facts.dataGaps.length} 项（详见报告）`);
  return lines.join('\n');
}

module.exports = { renderReport, renderTerminal, templateNarrative, DISCLAIMER };
