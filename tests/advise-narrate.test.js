'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { narrate, SYSTEM_PROMPT, DEFAULT_MODEL } = require('../advisor/narrate');
const { buildFacts } = require('../advisor/facts');
const { templateNarrative } = require('../advisor/report');
const { fmtPrice } = require('../advisor/format');
const { run } = require('../advisor/run');
const { parseArgs } = require('../advisor/cli');
const { makeMarket, LAST_CLOSE, FUTURES } = require('./advise-helpers');

const facts = buildFacts(makeMarket(), { positions: [] });
const template = templateNarrative(facts);
const reply = (text) => async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text }] }) });

test('无密钥：回退模板并提示未调用 LLM，不发请求', async () => {
  let called = false;
  const r = await narrate(facts, { template, apiKey: '', fetchImpl: async () => { called = true; } });
  assert.equal(called, false);
  assert.equal(r.source, 'template');
  assert.equal(r.text, template);
  assert.match(r.note, /未设置 ANTHROPIC_API_KEY，未调用 LLM/);
});

test('叙述引入新数字（101234）→ 作废并回退模板', async () => {
  const r = await narrate(facts, { template, apiKey: 'k', fetchImpl: reply('目标看到 101234 附近，别犹豫。') });
  assert.equal(r.source, 'template');
  assert.equal(r.text, template);
  assert.match(r.note, /叙述含未验证数字（101234），已回退模板/);
});

test('叙述数字全部出自 facts → 采用 LLM 文本，并按约定的协议发请求', async () => {
  const price = fmtPrice(facts.meta.spotPrice);
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: `现价 ${price}，先别追，等右侧确认。` }] }) };
  };
  const r = await narrate(facts, { template, apiKey: 'sk-test', fetchImpl });
  assert.equal(r.source, 'llm');
  assert.equal(r.note, null);
  assert.match(r.text, new RegExp(price.replace('.', '\\.')));
  assert.equal(seen.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen.init.headers['x-api-key'], 'sk-test');
  assert.equal(seen.init.headers['anthropic-version'], '2023-06-01');
  const body = JSON.parse(seen.init.body);
  assert.equal(body.model, DEFAULT_MODEL);
  assert.equal(DEFAULT_MODEL, 'claude-sonnet-5-5');
  assert.equal(body.system, SYSTEM_PROMPT);
  assert.match(body.messages[0].content, /"state":"/);
  const custom = await narrate(facts, { template, apiKey: 'k', model: 'claude-opus-5-5', fetchImpl: async (u, i) => { seen = { u, i }; return reply('ok')(); } });
  assert.equal(JSON.parse(seen.i.body).model, 'claude-opus-5-5');
  assert.equal(custom.source, 'llm');
});

test('HTTP 错误 / 抛错 / 空叙述都回退模板，不阻断', async () => {
  const bad = await narrate(facts, { template, apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 529 }) });
  assert.equal(bad.source, 'template');
  assert.match(bad.note, /HTTP 529/);
  const thrown = await narrate(facts, { template, apiKey: 'k', fetchImpl: async () => { throw new Error('socket hang up'); } });
  assert.equal(thrown.source, 'template');
  assert.match(thrown.note, /socket hang up/);
  const empty = await narrate(facts, { template, apiKey: 'k', fetchImpl: reply('   ') });
  assert.equal(empty.source, 'template');
});

test('run 端到端（注入假数据）：写出报告文件、--json 输出事实 JSON、叙述被作废时报告注明', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'advise-run-'));
  try {
    const out = []; const err = [];
    const deps = {
      fetchMarketData: async () => makeMarket(),
      fetchFuturesPremium: async () => FUTURES,
      outDir, io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    };
    const code = await run(parseArgs(['BTC-USD']), deps);
    assert.equal(code, 0);
    const files = fs.readdirSync(outDir);
    assert.deepEqual(files, ['BTCUSDT-20261026-0000.md']);
    assert.match(fs.readFileSync(path.join(outDir, files[0]), 'utf8'), /## H\. 最终建议/);
    assert.match(out.join('\n'), /完整报告：.*BTCUSDT-20261026-0000\.md/);

    out.length = 0;
    await run(parseArgs(['BTC-USD', '--cost', String(LAST_CLOSE * 0.97), '--side', 'long', '--qty', '0.5', '--equity', '20000', '--json']), deps);
    const json = JSON.parse(out.join('\n'));
    assert.equal(json.meta.mode, 'position');
    assert.equal(json.positions[0].side, 'long');
    assert.equal(json.meta.futures.status, 'ok');
    assert.ok(err.join('\n').includes('完整报告') === false && err.join('\n').includes('报告：'));

    // --narrate 带坏数字 → 报告注明回退
    await run(parseArgs(['BTC-USD', '--narrate']), { ...deps, apiKey: 'k', narrate: (f, o) => narrate(f, { ...o, fetchImpl: reply('冲到 101234') }) });
    const md = fs.readFileSync(path.join(outDir, 'BTCUSDT-20261026-0000.md'), 'utf8');
    assert.match(md, /叙述含未验证数字（101234），已回退模板/);
    assert.match(md, /叙述（模板生成）/);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('run：快照里只取本次交易对的持仓，其余写入说明', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'advise-run-'));
  try {
    const snap = path.join(outDir, 'p.yaml');
    fs.writeFileSync(snap, [
      'totalMarginBalance: 20000', 'positions:',
      '  - {symbol: BTCUSDT, positionSide: LONG, positionAmt: 0.3, entryPrice: 78000, marginType: CROSSED}',
      '  - {symbol: ETHUSDT, positionSide: LONG, positionAmt: 5, entryPrice: 3000, marginType: CROSSED}',
      '  - {symbol: BTCUSD_PERP, positionAmt: 3, entryPrice: 78000}',
    ].join('\n'));
    const out = [];
    await run(parseArgs(['BTC-USD', '--snapshot', snap, '--json']), {
      fetchMarketData: async () => makeMarket(), fetchFuturesPremium: async () => null, outDir, io: { out: (s) => out.push(s), err: () => {} },
    });
    const json = JSON.parse(out.join('\n'));
    assert.equal(json.positions.length, 1);
    assert.equal(json.positions[0].qty, 0.3);
    assert.equal(json.positions[0].equity, 20000);
    assert.equal(json.meta.futures.status, '获取失败');
    assert.ok(json.meta.notes.some((n) => /ETHUSDT/.test(n)));
    assert.ok(json.meta.notes.some((n) => /币本位/.test(n)));
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
