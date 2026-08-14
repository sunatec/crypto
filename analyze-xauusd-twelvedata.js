'use strict';

const fs = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');

// Import core wave analysis engine from analyze-kline-wave.js
const {
    analyzeWave,
    buildReport,
    buildManualAlternateOnlyReport,
    buildMacroReport,
    buildHtmlDashboard,
    formatToUtcOffset,
    REPORT_TZ_OFFSET_HOURS,
} = require('./analyze-kline-wave');

// ─────────────────────── Twelve Data API ───────────────────────

const TWELVE_DATA_BASE = 'https://api.twelvedata.com/time_series';

/**
 * Supported intervals for Twelve Data.
 * Keys are the user-facing names, values are the API interval strings.
 */
const INTERVALS = {
    '1min': '1min',
    '5min': '5min',
    '15min': '15min',
    '30min': '30min',
    '45min': '45min',
    '1h': '1h',
    '2h': '2h',
    '4h': '4h',
    '1d': '1day',
    '1day': '1day',
    '1w': '1week',
    '1week': '1week',
    '1m': '1month',
    '1month': '1month',
};

// ─────────────────────── HTTP Fetch ───────────────────────

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function execFileAsync(file, args, options = {}) {
    return new Promise((resolve, reject) => {
        execFile(file, args, options, (err, stdout, stderr) => {
            if (err) {
                err.stdout = stdout;
                err.stderr = stderr;
                reject(err);
                return;
            }
            resolve({ stdout, stderr });
        });
    });
}

/**
 * Fetch JSON from URL with retry and Windows PowerShell fallback.
 */
async function fetchJson(url) {
    let lastErr = null;

    // Try native fetch first
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 25000);
            const res = await fetch(url, {
                signal: controller.signal,
                headers: {
                    'User-Agent': 'xauusd-wave-analyzer/1.0',
                    Accept: 'application/json',
                },
            });
            clearTimeout(timer);

            if (!res.ok) {
                const text = await res.text();
                throw new Error(`Twelve Data API error ${res.status}: ${text}`);
            }
            return await res.json();
        } catch (err) {
            lastErr = err;
            if (attempt < 3) await sleep(500 * attempt);
        }
    }

    // Windows PowerShell fallback
    if (process.platform !== 'win32') throw lastErr;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
            const escapedUrl = String(url).replace(/'/g, "''");
            const command = [
                "$ProgressPreference='SilentlyContinue'",
                `(Invoke-RestMethod -Uri '${escapedUrl}' -UseBasicParsing -TimeoutSec 30) | ConvertTo-Json -Depth 8 -Compress`,
            ].join('; ');
            const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', command], {
                encoding: 'utf8',
                maxBuffer: 1024 * 1024 * 50,
            });
            return JSON.parse(stdout);
        } catch (err) {
            lastErr = err;
            if (attempt < 3) await sleep(700 * attempt);
        }
    }

    const wrapped = new Error(`Failed to fetch data after retries: ${lastErr?.message || String(lastErr)}`);
    wrapped.cause = lastErr;
    throw wrapped;
}

// ─────────────────────── Data Fetching ───────────────────────

/**
 * Fetch candle data from Twelve Data API.
 *
 * @param {string} symbol    - e.g. "XAU/USD"
 * @param {string} interval  - API interval string, e.g. "1h", "4h", "1day"
 * @param {string} apiKey    - Twelve Data API key
 * @param {object} options   - { startDate, endDate, outputSize, timezone }
 */
async function fetchTwelveDataCandles(symbol, interval, apiKey, options = {}) {
    const url = new URL(TWELVE_DATA_BASE);
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', interval);
    url.searchParams.set('apikey', apiKey);
    url.searchParams.set('order', 'asc');
    url.searchParams.set('format', 'JSON');
    url.searchParams.set('timezone', options.timezone || 'UTC');

    if (options.outputSize) {
        url.searchParams.set('outputsize', String(options.outputSize));
    }
    if (options.startDate) {
        url.searchParams.set('start_date', options.startDate);
    }
    if (options.endDate) {
        url.searchParams.set('end_date', options.endDate);
    }

    console.log(`Fetching: ${symbol} ${interval} from Twelve Data...`);
    const data = await fetchJson(url.toString());

    if (data.status === 'error') {
        throw new Error(`Twelve Data API error: ${data.message || JSON.stringify(data)}`);
    }

    if (!data.values || !Array.isArray(data.values)) {
        throw new Error(`Unexpected response structure: ${JSON.stringify(data).slice(0, 200)}`);
    }

    const tz = options.timezone || 'UTC';
    const candles = [];

    for (const v of data.values) {
        const open = parseFloat(v.open);
        const high = parseFloat(v.high);
        const low = parseFloat(v.low);
        const close = parseFloat(v.close);
        const volume = parseFloat(v.volume) || 0;

        if ([open, high, low, close].some((n) => !Number.isFinite(n))) continue;

        // Parse datetime — Twelve Data returns "YYYY-MM-DD HH:MM:SS" in the specified timezone
        const dt = parseTwelveDataDatetime(v.datetime, tz);
        if (!dt || Number.isNaN(dt.getTime())) continue;

        candles.push({
            timestamp: Math.floor(dt.getTime() / 1000),
            timeUtc: dt.toISOString(),
            open,
            high,
            low,
            close,
            volume,
        });
    }

    // Sort ascending
    candles.sort((a, b) => a.timestamp - b.timestamp);

    // Deduplicate by timestamp
    const dedup = new Map();
    for (const c of candles) {
        dedup.set(c.timestamp, c);
    }

    const result = Array.from(dedup.values()).sort((a, b) => a.timestamp - b.timestamp);
    console.log(`  Received ${data.values.length} points, parsed ${result.length} valid candles.`);

    return {
        meta: data.meta || {},
        candles: result,
    };
}

/**
 * Parse Twelve Data datetime string.
 * Format: "2021-09-16 15:59:00" in the specified timezone.
 * When timezone is UTC, we can parse directly.
 */
function parseTwelveDataDatetime(datetimeStr, tz) {
    if (!datetimeStr) return null;

    // The API returns "YYYY-MM-DD" or "YYYY-MM-DD HH:mm:ss"
    const str = String(datetimeStr).trim();

    if (tz === 'UTC') {
        // Append Z to indicate UTC
        const isoStr = str.includes('T') ? str : str.replace(' ', 'T');
        return new Date(isoStr + (isoStr.includes('Z') || isoStr.includes('+') ? '' : 'Z'));
    }

    // For other timezones, we attempt to parse using Date constructor
    // with timezone context. This is imperfect but works for most cases.
    // First try direct ISO parse:
    try {
        const isoStr = str.replace(' ', 'T');
        const d = new Date(isoStr);
        if (!Number.isNaN(d.getTime())) return d;
    } catch { /* fallthrough */ }

    return new Date(str);
}

/**
 * For large time ranges that exceed the 5000 point limit,
 * split into multiple requests.
 */
async function fetchCandlesPaginated(symbol, interval, apiKey, options = {}) {
    const MAX_POINTS = 5000;
    const outputSize = options.outputSize || MAX_POINTS;

    // If a specific output size is requested and it's within limit, single request
    if (outputSize <= MAX_POINTS && !options.startDate) {
        return fetchTwelveDataCandles(symbol, interval, apiKey, {
            ...options,
            outputSize,
        });
    }

    // When start_date and end_date are specified, Twelve Data auto-limits
    // to 5000 points. If we need more, we'd have to paginate.
    // For most wave analysis use-cases, 5000 points is plenty.
    return fetchTwelveDataCandles(symbol, interval, apiKey, {
        ...options,
        outputSize: Math.min(outputSize, MAX_POINTS),
    });
}

// ─────────────────────── CLI Argument Parsing ───────────────────────

/**
 * Symbol shorthand aliases.
 * Allows typing "xau" instead of "--symbol XAU/USD".
 */
const SYMBOL_ALIASES = {
    'xau': 'XAU/USD',
    'xauusd': 'XAU/USD',
    'gold': 'XAU/USD',
    'xag': 'XAG/USD',
    'xagusd': 'XAG/USD',
    'silver': 'XAG/USD',
    'eur': 'EUR/USD',
    'eurusd': 'EUR/USD',
    'gbp': 'GBP/USD',
    'gbpusd': 'GBP/USD',
    'usdjpy': 'USD/JPY',
    'jpy': 'USD/JPY',
    'btc': 'BTC/USD',
    'btcusd': 'BTC/USD',
    'eth': 'ETH/USD',
    'ethusd': 'ETH/USD',
};

function parseArgs(argv) {
    const args = {
        symbol: 'XAU/USD',
        interval: '1h',
        apiKey: 'b480d262b51e428e8523e3e2ee8ad1c7',
        start: null,
        end: null,
        outputSize: null,
        out: null,
        report: null,
        html: null,
        mode: 'start',
        lookback: 2,
        atrPeriod: 14,
        atrMultiplier: 1.5,
        rsiPeriod: 14,
        help: false,
    };

    for (let i = 0; i < argv.length; i += 1) {
        const item = argv[i];
        const next = argv[i + 1];

        if (item === '--symbol' && next) {
            args.symbol = next.includes('/') ? next : (SYMBOL_ALIASES[next.toLowerCase()] || next);
            i += 1;
        } else if ((item === '--interval' || item === '--tf') && next) {
            args.interval = next.toLowerCase();
            i += 1;
        } else if ((item === '--apikey' || item === '--api-key' || item === '--key') && next) {
            args.apiKey = next;
            i += 1;
        } else if (item === '--start' && next) {
            args.start = next;
            i += 1;
        } else if (item === '--end' && next) {
            args.end = next;
            i += 1;
        } else if ((item === '--outputsize' || item === '--size') && next) {
            args.outputSize = Number(next);
            i += 1;
        } else if (item === '--out' && next) {
            args.out = next;
            i += 1;
        } else if (item === '--report' && next) {
            args.report = next;
            i += 1;
        } else if (item === '--html' && next) {
            args.html = next;
            i += 1;
        } else if (item === '--mode' && next) {
            args.mode = next.toLowerCase();
            i += 1;
        } else if (item === '--lookback' && next) {
            args.lookback = Number(next);
            i += 1;
        } else if (item === '--atr-period' && next) {
            args.atrPeriod = Number(next);
            i += 1;
        } else if (item === '--atr-multiplier' && next) {
            args.atrMultiplier = Number(next);
            i += 1;
        } else if (item === '--rsi-period' && next) {
            args.rsiPeriod = Number(next);
            i += 1;
        } else if (item === '--help' || item === '-h') {
            args.help = true;
        } else if (!item.startsWith('--')) {
            const lower = item.toLowerCase();
            if (INTERVALS[lower]) {
                // Positional: interval (e.g. "1h", "4h", "1d")
                args.interval = lower;
            } else if (SYMBOL_ALIASES[lower]) {
                // Positional: symbol shorthand (e.g. "xau", "xag", "eur")
                args.symbol = SYMBOL_ALIASES[lower];
            } else if (item.includes('/')) {
                // Positional: full symbol (e.g. "XAU/USD")
                args.symbol = item;
            }
        }
    }

    return args;
}

function printHelp() {
    console.log(`
╔══════════════════════════════════════════════════════════════════╗
║        Forex/Commodity Wave Analyzer — Twelve Data Edition       ║
╠══════════════════════════════════════════════════════════════════╣
║  Fetch market data from Twelve Data API, run Elliott wave        ║
║  analysis, and output JSON + Markdown + HTML dashboard.          ║
╚══════════════════════════════════════════════════════════════════╝

Usage:
  node analyze-xauusd-twelvedata.js [symbol] [interval] [options]

  Symbol & Interval can be passed directly as positional arguments:
    node analyze-xauusd-twelvedata.js xau 4h
    node analyze-xauusd-twelvedata.js xag 1d
    node analyze-xauusd-twelvedata.js eur 1h

  Symbol shortcuts:
    xau / gold    → XAU/USD (黄金)  ✅免费    xag / silver  → XAG/USD (白银)  💰付费
    eur / eurusd  → EUR/USD         ✅免费    gbp / gbpusd  → GBP/USD         ✅免费
    jpy / usdjpy  → USD/JPY         ✅免费    btc / btcusd  → BTC/USD         ✅免费
    eth / ethusd  → ETH/USD         ✅免费
    Or use full pair: --symbol XAU/USD

Options:
  --symbol      Trading pair (or use shorthand above), default: XAU/USD
  --interval    1min|5min|15min|30min|45min|1h|2h|4h|1d|1w|1m, default: 1h
  --start       Start date: YYYY-MM-DD, YYYY-MM-DDTHH:MM:SS+08:00, or "now"
  --end         End date:   same format as --start, or "now"
  --outputsize  Number of data points (1-5000), default: 300
  --out         Output JSON file path
  --report      Output markdown file path
  --mode        Report mode: start (default, only major-cycle possibilities from start time) | full | macro
  --html        Output interactive dashboard HTML path
  --lookback    Pivot lookback window, default: 2
  --atr-period       ATR period, default: 14
  --atr-multiplier   ATR multiplier for pivot filter, default: 1.5
  --rsi-period       RSI period, default: 14

Examples:
  node analyze-xauusd-twelvedata.js              # 黄金 1h (默认)
  node analyze-xauusd-twelvedata.js xau 4h       # 黄金 4小时线
  node analyze-xauusd-twelvedata.js xag 1d       # 白银 日线
  node analyze-xauusd-twelvedata.js eur 1h       # 欧元 1小时线
  node analyze-xauusd-twelvedata.js gold 1w      # 黄金 周线
  node analyze-xauusd-twelvedata.js xau 1h --start 2026-02-01 --end now
`);
}

// ─────────────────────── Helpers ───────────────────────

function toFileTimeTag(date, offsetHours = 8) {
    const shifted = new Date(date.getTime() + offsetHours * 3600 * 1000);
    const y = shifted.getUTCFullYear();
    const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
    const d = String(shifted.getUTCDate()).padStart(2, '0');
    const hh = String(shifted.getUTCHours()).padStart(2, '0');
    const mm = String(shifted.getUTCMinutes()).padStart(2, '0');
    return `${y}${m}${d}${hh}${mm}`;
}

// ─────────────────────── Main ───────────────────────

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        return;
    }

    // Resolve API key from args or environment variable
    const apiKey = args.apiKey || process.env.TWELVE_DATA_API_KEY;
    if (!apiKey) {
        console.error('Error: API key is required.');
        console.error('  Use --apikey YOUR_KEY or set env var TWELVE_DATA_API_KEY');
        console.error('  Get a free key at: https://twelvedata.com/pricing');
        console.error('  Run with --help for full usage info.');
        process.exit(1);
    }

    // Validate interval
    const apiInterval = INTERVALS[args.interval];
    if (!apiInterval) {
        throw new Error(`Unsupported interval: ${args.interval}. Use: ${Object.keys(INTERVALS).join(', ')}`);
    }

    // Default outputSize (when no date range specified, use 300; with date range, use max)
    const outputSize = args.outputSize || (args.start ? 5000 : 300);

    // Parse start/end dates — support "now", ISO strings, plain dates
    const parseDateArg = (value) => {
        if (!value) return null;
        const v = String(value).trim().toLowerCase();
        if (v === 'now') return new Date();
        const dt = new Date(value);
        if (Number.isNaN(dt.getTime())) {
            throw new Error(`Invalid date: "${value}". Use format: YYYY-MM-DD, YYYY-MM-DDTHH:MM:SS+08:00, or "now"`);
        }
        return dt;
    };

    const startDt = parseDateArg(args.start);
    const endDt = parseDateArg(args.end);

    // Convert to UTC string for Twelve Data API (format: YYYY-MM-DD HH:mm:ss)
    const toApiDate = (dt) => {
        const y = dt.getUTCFullYear();
        const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
        const d = String(dt.getUTCDate()).padStart(2, '0');
        const hh = String(dt.getUTCHours()).padStart(2, '0');
        const mm = String(dt.getUTCMinutes()).padStart(2, '0');
        const ss = String(dt.getUTCSeconds()).padStart(2, '0');
        return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
    };

    // Fetch data
    const fetchOptions = {
        timezone: 'UTC',
        outputSize,
    };
    if (startDt) fetchOptions.startDate = toApiDate(startDt);
    if (endDt) fetchOptions.endDate = toApiDate(endDt);

    const { meta: apiMeta, candles: rawCandles } = await fetchCandlesPaginated(
        args.symbol,
        apiInterval,
        apiKey,
        fetchOptions,
    );

    if (rawCandles.length === 0) {
        throw new Error('No valid candle data received from Twelve Data API.');
    }

    // Filter out weekend candles (forex markets closed Sat & Sun)
    const weekdayCandles = rawCandles.filter((c) => {
        const day = new Date(c.timestamp * 1000).getUTCDay();
        return day !== 0 && day !== 6; // 0=Sunday, 6=Saturday
    });

    if (weekdayCandles.length < rawCandles.length) {
        console.log(`  Filtered out ${rawCandles.length - weekdayCandles.length} weekend candles.`);
    }

    // Add UTC+8 time tag
    const candles = weekdayCandles.map((c) => ({
        ...c,
        timeUtc8: formatToUtcOffset(c.timeUtc, REPORT_TZ_OFFSET_HOURS),
    }));

    // Derive product name and timeframe
    const productName = args.symbol.replace('/', '');
    const timeframe = args.interval;

    // Time range
    const firstCandle = candles[0];
    const lastCandle = candles[candles.length - 1];
    const startDate = new Date(firstCandle.timestamp * 1000);
    const endDate = new Date(lastCandle.timestamp * 1000);

    // Output file names
    const startTag = toFileTimeTag(startDate, REPORT_TZ_OFFSET_HOURS);
    const endTag = toFileTimeTag(endDate, REPORT_TZ_OFFSET_HOURS);
    const baseName = `${productName}_${timeframe}_${startTag}_${endTag}`;
    const outName = args.out || `${baseName}.json`;
    const reportName = args.report || `${baseName}.md`;
    const htmlName = args.html || `${baseName}.html`;

    // Minimum candles check
    const minCandlesRequired = Math.max(10, Math.floor(args.lookback) * 4 + 2);
    if (candles.length < minCandlesRequired) {
        throw new Error(
            `Not enough candles (${candles.length}). Need at least ${minCandlesRequired} bars for wave analysis.`,
        );
    }

    console.log(`Symbol: ${args.symbol} (${apiMeta.exchange || apiMeta.type || 'forex'})`);
    console.log(`Interval: ${timeframe}`);
    console.log(`Candles: ${candles.length}`);
    console.log(`Time range: ${firstCandle.timeUtc8} ~ ${lastCandle.timeUtc8} (UTC+8)`);
    console.log('Running wave analysis...');

    // Run wave analysis
    const analysis = analyzeWave(candles, Math.max(1, Math.floor(args.lookback)), {
        atrPeriod: Math.max(2, Math.floor(args.atrPeriod)),
        atrMultiplier: Number(args.atrMultiplier),
        rsiPeriod: Math.max(2, Math.floor(args.rsiPeriod)),
    });

    // Build output payload
    const meta = {
        product: args.symbol,
        timeframe,
        startUtc: startDate.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        endUtc: endDate.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        generatedAtUtc: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        source: `Twelve Data API (${apiMeta.exchange || 'forex'})`,
        apiMeta,
    };

    const payload = {
        meta,
        candles,
        analysis,
    };

    // Write outputs
    const jsonPath = path.resolve(process.cwd(), outName);
    const reportPath = path.resolve(process.cwd(), reportName);
    const htmlPath = path.resolve(process.cwd(), htmlName);

    await fs.writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    console.log(`\n✅ Saved candles JSON:  ${jsonPath}`);

    const reportContent = args.mode === 'macro'
        ? buildMacroReport(meta, analysis)
        : args.mode === 'full'
            ? buildReport(meta, analysis)
            : buildManualAlternateOnlyReport(meta, analysis);
    await fs.writeFile(reportPath, `${reportContent}\n`, 'utf8');
    console.log(`✅ Saved analysis MD:  ${reportPath} (mode: ${args.mode})`);

    await fs.writeFile(htmlPath, `${buildHtmlDashboard(payload)}\n`, 'utf8');
    console.log(`✅ Saved dashboard:    ${htmlPath}`);

    // Print summary
    console.log('\n┌─────────────────────────────────────────────────────────┐');
    console.log('│                    Quick Summary                        │');
    console.log('├─────────────────────────────────────────────────────────┤');
    console.log(`│  Candles:     ${String(analysis.candleCount).padEnd(42)}│`);
    console.log(`│  Range:       ${(analysis.low.toFixed(2) + ' ~ ' + analysis.high.toFixed(2)).padEnd(42)}│`);
    console.log(`│  Last Close:  ${String(analysis.lastClose.toFixed(2)).padEnd(42)}│`);
    console.log(`│  Stage:       ${String(analysis.stage || '-').slice(0, 42).padEnd(42)}│`);
    console.log(`│  Primary:     ${String(analysis.primaryScenario?.title || 'none').slice(0, 42).padEnd(42)}│`);
    console.log(`│  Trend:       ${String(analysis.trendOutlook?.likely || 'n/a').slice(0, 42).padEnd(42)}│`);
    console.log(`│  Patterns:    ${String(analysis.allPatternCandidates.length).padEnd(42)}│`);
    console.log('└─────────────────────────────────────────────────────────┘');
}

main().catch((err) => {
    console.error(`\n❌ Error: ${err.message || err}`);
    process.exit(1);
});
