'use strict';

const { binanceSymbol } = require('../binance-candle-transport');

class UsageError extends Error {}

const USAGE = [
  '用法：node advise.js <SYMBOL> [选项]',
  '  点位模式（不带 --cost）：输出值得参与的共振点位计划',
  '  持仓模式（带 --cost）：必须同时给 --side long|short',
  '选项：',
  '  --cost <价>     持仓成本价          --side long|short  持仓方向',
  '  --qty <数量>    持仓数量（币）       --equity <USDT>    相关风险池权益',
  '  --lev <倍数>    设置杠杆            --liq <价>         交易所强平价',
  '  --margin cross|isolated  保证金模式  --risk <比例>      单笔风险占权益（默认 0.01）',
  '  --snapshot <文件>  手册 §20.2 快照（yaml/json），可替代上面的持仓参数',
  '  --narrate [--model <id>]  用 Claude API 写叙述（需 ANTHROPIC_API_KEY）',
  '  --json          事实 JSON 输出到 stdout',
].join('\n');

const VALUE_FLAGS = {
  '--cost': 'cost', '--side': 'side', '--qty': 'qty', '--equity': 'equity', '--lev': 'lev',
  '--liq': 'liq', '--margin': 'margin', '--risk': 'risk', '--snapshot': 'snapshot', '--model': 'model',
};
const BOOL_FLAGS = { '--narrate': 'narrate', '--json': 'json', '--help': 'help', '-h': 'help' };
const NUMERIC = ['cost', 'qty', 'equity', 'lev', 'liq', 'risk'];

function resolveSymbol(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new UsageError('缺少交易对，例如 BTC-USD、BTCUSDT');
  const sym = binanceSymbol(raw);
  if (!/^[A-Z0-9]{2,}USDT$/.test(sym)) throw new UsageError(`无法识别交易对 ${raw}：仅支持 Binance USDT 交易对（如 BTC-USD、ETHUSDT）`);
  return sym;
}

function parseArgs(argv) {
  const out = { symbol: null, mode: 'points', narrate: false, json: false, help: false };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg in BOOL_FLAGS) { out[BOOL_FLAGS[arg]] = true; continue; }
    if (arg in VALUE_FLAGS) {
      const value = argv[i + 1];
      if (value === undefined || (value.startsWith('--') && !Number.isFinite(Number(value)))) throw new UsageError(`${arg} 缺少取值`);
      out[VALUE_FLAGS[arg]] = value;
      i += 1;
      continue;
    }
    if (arg.startsWith('-') && !Number.isFinite(Number(arg))) throw new UsageError(`未知选项 ${arg}`);
    rest.push(arg);
  }
  if (out.help) return out;
  if (rest.length !== 1) throw new UsageError(rest.length ? `多余的参数：${rest.slice(1).join(' ')}` : '缺少交易对，例如 BTC-USD、BTCUSDT');
  out.symbol = resolveSymbol(rest[0]);

  for (const key of NUMERIC) {
    if (out[key] === undefined) continue;
    const n = Number(out[key]);
    if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--${key} 须为正数，收到 ${out[key]}`);
    out[key] = n;
  }
  if (out.risk !== undefined && out.risk >= 1) throw new UsageError('--risk 是占权益的比例，须小于 1（如 0.01 表示 1%）');
  if (out.side !== undefined) {
    out.side = String(out.side).toLowerCase();
    if (!['long', 'short'].includes(out.side)) throw new UsageError('--side 须为 long 或 short');
  }
  if (out.margin !== undefined) {
    out.margin = String(out.margin).toLowerCase();
    if (!['cross', 'isolated'].includes(out.margin)) throw new UsageError('--margin 须为 cross 或 isolated');
  }
  if (out.model !== undefined && !out.narrate) throw new UsageError('--model 只能与 --narrate 一起使用');

  if (out.cost !== undefined) {
    if (!out.side) throw new UsageError('持仓模式需要 --side long|short（缺少 --side）');
    out.mode = 'position';
  } else if (out.snapshot === undefined) {
    const stray = ['side', 'qty', 'equity', 'lev', 'liq', 'margin'].filter((k) => out[k] !== undefined);
    if (stray.length) throw new UsageError(`${stray.map((k) => `--${k}`).join('、')} 属于持仓参数，需同时提供 --cost 与 --side（或用 --snapshot）`);
  }
  if (out.snapshot !== undefined) out.mode = 'position';
  return out;
}

module.exports = { parseArgs, resolveSymbol, UsageError, USAGE };
