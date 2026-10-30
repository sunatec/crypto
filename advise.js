#!/usr/bin/env node
'use strict';

// 半木夏交易体系顾问：点位模式 / 持仓模式。入口只做参数解析与流程编排，逻辑都在 advisor/ 下。
const { parseArgs, UsageError, USAGE } = require('./advisor/cli');

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) { console.log(USAGE); return 0; }
  const { run } = require('./advisor/run');
  return run(args);
}

// fetch failed 的真实原因藏在 error.cause 里；这里单独探测一次 Binance，给出具体原因和对应办法。
async function explainNetworkFailure() {
  const proxyVar = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'].find((k) => process.env[k]);
  const lines = [];
  try {
    const res = await fetch('https://api.binance.com/api/v3/ping', { signal: AbortSignal.timeout(10000) });
    lines.push(`诊断：直接探测 api.binance.com 返回 HTTP ${res.status}，网络本身是通的，可能是偶发抖动，请重试。`);
    return lines.join('\n');
  } catch (e) {
    const code = (e.cause && (e.cause.code || e.cause.message)) || e.message;
    lines.push(`诊断：直接连接 api.binance.com 失败（${code}）。ECONNRESET / ETIMEDOUT / ENOTFOUND 通常表示当前网络到不了 Binance（地区限制或需要代理）。`);
  }
  if (proxyVar && !process.env.NODE_USE_ENV_PROXY) {
    lines.push(`检测到代理环境变量 ${proxyVar}，但 Node 的 fetch 默认不走代理。请加 NODE_USE_ENV_PROXY=1 重试，例如：\n  NODE_USE_ENV_PROXY=1 node advise.js ${process.argv.slice(2).join(' ')}`);
  } else if (!proxyVar) {
    lines.push('当前终端没有代理环境变量。如果你平时靠代理/VPN 访问 Binance，请在这个终端里设置后重试（端口换成你代理软件的 HTTP 端口）：\n  export HTTPS_PROXY=http://127.0.0.1:7890 NODE_USE_ENV_PROXY=1\n（只开"系统代理"而没开 TUN/增强模式时，命令行程序默认不会走代理。）');
  } else {
    lines.push('已设置 NODE_USE_ENV_PROXY，但仍连不上：请检查代理软件是否在运行、端口是否正确，并用 curl -I https://api.binance.com/api/v3/ping 验证。');
  }
  return lines.join('\n');
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code || 0; }).catch(async (error) => {
    if (error instanceof UsageError) {
      console.error(`参数错误：${error.message}\n\n${USAGE}`);
      process.exitCode = 2;
    } else {
      console.error(`运行失败：${error.message}`);
      if (/fetch failed/.test(error.message)) console.error(await explainNetworkFailure());
      process.exitCode = 1;
    }
  });
}

module.exports = { main };
