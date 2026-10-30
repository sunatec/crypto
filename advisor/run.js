'use strict';

const fs = require('node:fs');
const path = require('node:path');

const data = require('./data');
const { buildFacts } = require('./facts');
const { renderReport, renderTerminal, templateNarrative } = require('./report');
const { narrate } = require('./narrate');
const { loadSnapshot } = require('./position');
const { UsageError } = require('./cli');

const REPORT_DIR = path.join(__dirname, '..', 'reports', 'advise');

// 报告文件名里的时间：UTC，YYYYMMDD-HHmm
function stamp(iso) {
  return iso.slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
}

// 把 CLI / 快照整理成统一的持仓输入列表
function collectPositions(args, notes) {
  if (args.snapshot) {
    let snap;
    try { snap = loadSnapshot(args.snapshot); } catch (error) { throw new UsageError(`读取快照失败：${error.message}`); }
    const mine = snap.positions.filter((p) => p.symbol === args.symbol);
    const others = snap.positions.filter((p) => p.symbol !== args.symbol);
    for (const o of others) notes.push(o.supported ? `快照中的 ${o.symbol} ${o.side === 'long' ? '多' : '空'}单不在本次分析范围（本次只分析 ${args.symbol}）` : `快照中的 ${o.symbol}：${o.reason}，已跳过`);
    if (!mine.length) notes.push(`快照中没有 ${args.symbol} 的持仓，按点位模式输出`);
    return mine.map((p) => ({ ...p, unsupported: !p.supported }));
  }
  if (args.cost !== undefined) {
    return [{ symbol: args.symbol, side: args.side, cost: args.cost, qty: args.qty ?? null, equity: args.equity ?? null, lev: args.lev ?? null, liq: args.liq ?? null, margin: args.margin || null }];
  }
  return [];
}

// deps 仅供测试注入：{ fetchMarketData, fetchFuturesPremium, narrate, now, outDir, io: { out, err }, env }
async function run(args, deps = {}) {
  const io = deps.io || { out: (s) => console.log(s), err: (s) => console.error(s) };
  const fetchMarketData = deps.fetchMarketData || data.fetchMarketData;
  const fetchFuturesPremium = deps.fetchFuturesPremium || data.fetchFuturesPremium;
  const narrateFn = deps.narrate || narrate;
  const outDir = deps.outDir || REPORT_DIR;

  const notes = [];
  const positions = collectPositions(args, notes);

  const market = await fetchMarketData(args.symbol, { now: deps.now });
  let futures = null;
  const futuresTried = positions.length > 0;
  if (futuresTried) futures = await fetchFuturesPremium(args.symbol);
  const facts = buildFacts(market, { futures, futuresTried, positions, riskPct: args.risk, notes });

  let narrative = { text: templateNarrative(facts), source: 'template', note: null };
  if (args.narrate) {
    narrative = await narrateFn(facts, { template: narrative.text, model: args.model, apiKey: deps.apiKey });
    if (narrative.note) io.err(`提示：${narrative.note}`);
  }

  const markdown = renderReport(facts, narrative);
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${args.symbol}-${stamp(facts.meta.generatedAt)}.md`);
  fs.writeFileSync(file, markdown, 'utf8');

  const summary = renderTerminal(facts);
  if (args.json) {
    io.out(JSON.stringify(facts, null, 2));
    io.err(`${summary}\n报告：${file}`);
  } else {
    io.out(`${summary}\n\n完整报告：${file}\n本输出为条件性计划，不构成投资建议。`);
  }
  return 0;
}

module.exports = { run, stamp, collectPositions, REPORT_DIR };
