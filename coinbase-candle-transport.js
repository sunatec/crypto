'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

// Page transport only: pagination and persistence belong to candle-cache.
async function fetchCoinbasePage(product, granularity, start, end) {
  const url = new URL(`https://api.exchange.coinbase.com/products/${encodeURIComponent(product)}/candles`);
  url.searchParams.set('granularity', String(granularity));
  url.searchParams.set('start', start.toISOString());
  url.searchParams.set('end', end.toISOString());
  let rows;
  if (process.platform === 'win32') {
    // Read the raw JSON body so empty/single-row arrays survive PowerShell's pipeline.
    const command = "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; (Invoke-WebRequest -Uri '"
      + url.toString().replace(/'/g, "''") + "' -Headers @{'User-Agent'='crypto-wave-analyzer'} -UseBasicParsing -TimeoutSec 30).Content";
    const { stdout } = await promisify(execFile)('powershell', ['-NoProfile', '-Command', command], {
      encoding: 'utf8', windowsHide: true, timeout: 35000, maxBuffer: 4 * 1024 * 1024,
    });
    rows = JSON.parse(stdout);
  } else {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'crypto-wave-analyzer', Accept: 'application/json' },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`Coinbase HTTP ${response.status}`);
    rows = await response.json();
  }
  if (!Array.isArray(rows)) throw new Error('Invalid Coinbase candle response');
  return rows;
}

module.exports = { fetchCoinbasePage };
