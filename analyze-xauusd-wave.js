'use strict';

const fs = require('fs/promises');
const path = require('path');

// Import core wave analysis engine from analyze-kline-wave.js
const {
    analyzeWave,
    buildReport,
    buildHtmlDashboard,
    formatToUtcOffset,
    REPORT_TZ_OFFSET_HOURS,
} = require('./analyze-kline-wave');

// ─────────────────────── CSV Parsing ───────────────────────

/**
 * Parse the OANDA XAUUSD CSV file into candle objects.
 *
 * Expected CSV columns (from TradingView export):
 *   0: time               (ISO 8601, e.g. 2026-02-12T09:00:00+08:00)
 *   1: open
 *   2: high
 *   3: low
 *   4: close
 *   5–10: various indicators (M15 Line, M25 Line, standardized candle fields)
 *   11: Volume
 *   12–16: MACD, Signal, K, D, etc.
 *
 * Returns an array of { timestamp, timeUtc, open, high, low, close, volume }
 */
function parseCsvFile(content) {
    const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);

    // Find header line (contains "time" and "open")
    let headerIndex = -1;
    for (let i = 0; i < Math.min(5, lines.length); i += 1) {
        if (lines[i].toLowerCase().includes('time') && lines[i].toLowerCase().includes('open')) {
            headerIndex = i;
            break;
        }
    }

    if (headerIndex < 0) {
        throw new Error('Cannot find CSV header row containing "time" and "open".');
    }

    const headers = splitCsvLine(lines[headerIndex]);

    // Locate column indices
    const timeIdx = headers.findIndex((h) => h.trim().toLowerCase() === 'time');
    const openIdx = headers.findIndex((h) => h.trim().toLowerCase() === 'open');
    const highIdx = headers.findIndex((h) => h.trim().toLowerCase() === 'high');
    const lowIdx = headers.findIndex((h) => h.trim().toLowerCase() === 'low');
    const closeIdx = headers.findIndex((h) => h.trim().toLowerCase() === 'close');
    const volumeIdx = headers.findIndex((h) => h.trim().toLowerCase() === 'volume');

    if (timeIdx < 0 || openIdx < 0 || highIdx < 0 || lowIdx < 0 || closeIdx < 0) {
        throw new Error(
            `Missing required columns. Found headers: ${headers.join(', ')}`,
        );
    }

    const candles = [];
    for (let i = headerIndex + 1; i < lines.length; i += 1) {
        const cols = splitCsvLine(lines[i]);
        if (cols.length <= closeIdx) continue;

        const timeStr = cols[timeIdx].trim();
        const dt = new Date(timeStr);
        if (Number.isNaN(dt.getTime())) continue;

        const open = parseFloat(cols[openIdx]);
        const high = parseFloat(cols[highIdx]);
        const low = parseFloat(cols[lowIdx]);
        const close = parseFloat(cols[closeIdx]);
        const volume = volumeIdx >= 0 && cols[volumeIdx] ? parseFloat(cols[volumeIdx]) || 0 : 0;

        if ([open, high, low, close].some((v) => !Number.isFinite(v))) continue;

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

    // Sort by timestamp ascending and deduplicate
    candles.sort((a, b) => a.timestamp - b.timestamp);
    const dedup = new Map();
    for (const c of candles) {
        dedup.set(c.timestamp, c);
    }

    return Array.from(dedup.values()).sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Simple CSV line splitter that handles quoted fields containing commas.
 */
function splitCsvLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (ch === '"') {
            inQuotes = !inQuotes;
        } else if (ch === ',' && !inQuotes) {
            result.push(current);
            current = '';
        } else {
            current += ch;
        }
    }
    result.push(current);
    return result;
}

// ─────────────────────── CLI Argument Parsing ───────────────────────

function parseArgs(argv) {
    const args = {
        input: null,
        out: null,
        report: null,
        html: null,
        lookback: 2,
        atrPeriod: 14,
        atrMultiplier: 1.5,
        rsiPeriod: 14,
        help: false,
    };

    for (let i = 0; i < argv.length; i += 1) {
        const item = argv[i];
        const next = argv[i + 1];

        if (item === '--input' && next) {
            args.input = next;
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
        } else if (!args.input && !item.startsWith('--')) {
            // Positional argument treated as input file
            args.input = item;
        }
    }

    return args;
}

function printHelp() {
    console.log(`Usage:
  node analyze-xauusd-wave.js [options] [input-csv]

Description:
  Read OANDA XAUUSD (or any similar TradingView-exported CSV),
  analyse Elliott wave structures, and output JSON + Markdown report.

Options:
  --input       CSV file path (default: assets/OANDA_XAUUSD, 60_dd98a.csv)
  --out         Output JSON file (default: <derived from input>.json)
  --report      Output markdown file (default: <derived from input>.md)
  --html        Output interactive dashboard HTML (default: <derived from input>.html)
  --lookback    Pivot lookback window, default: 2
  --atr-period      ATR period for pivot noise filter, default: 14
  --atr-multiplier  Min pivot distance = ATR * multiplier, default: 1.5
  --rsi-period      RSI period for momentum-divergence checks, default: 14
`);
}

// ─────────────────────── Main ───────────────────────

function toIsoNoMs(date) {
    return date.toISOString().replace(/\.\\d{3}Z$/, 'Z');
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        return;
    }

    // Default input path
    const inputPath = args.input
        ? path.resolve(process.cwd(), args.input)
        : path.resolve(__dirname, 'assets', 'OANDA_XAUUSD, 60_dd98a.csv');

    console.log(`Reading CSV: ${inputPath}`);

    const csvContent = await fs.readFile(inputPath, 'utf8');
    const rawCandles = parseCsvFile(csvContent);

    if (rawCandles.length === 0) {
        throw new Error('No valid candle data found in CSV file.');
    }

    console.log(`Parsed ${rawCandles.length} candles from CSV.`);

    // Add UTC+8 time tag
    const candles = rawCandles.map((c) => ({
        ...c,
        timeUtc8: formatToUtcOffset(c.timeUtc, REPORT_TZ_OFFSET_HOURS),
    }));

    // Derive product name and timeframe from filename
    const inputBasename = path.basename(inputPath, path.extname(inputPath));
    const productName = 'XAUUSD';
    const timeframe = '1h'; // 60 min = 1h

    // Derive time range from data
    const firstCandle = candles[0];
    const lastCandle = candles[candles.length - 1];
    const startDate = new Date(firstCandle.timestamp * 1000);
    const endDate = new Date(lastCandle.timestamp * 1000);

    // Output file names
    const safeBasename = inputBasename.replace(/[^A-Za-z0-9_-]/g, '_');
    const outName = args.out || `${safeBasename}_wave.json`;
    const reportName = args.report || `${safeBasename}_wave.md`;
    const htmlName = args.html || `${safeBasename}_wave.html`;

    // Minimum candles check
    const minCandlesRequired = Math.max(10, Math.floor(args.lookback) * 4 + 2);
    if (candles.length < minCandlesRequired) {
        throw new Error(
            `Not enough candles (${candles.length}). Need at least ${minCandlesRequired} bars for partial-wave inference.`,
        );
    }

    console.log(`Time range: ${firstCandle.timeUtc} ~ ${lastCandle.timeUtc}`);
    console.log('Running wave analysis...');

    // Run wave analysis
    const analysis = analyzeWave(candles, Math.max(1, Math.floor(args.lookback)), {
        atrPeriod: Math.max(2, Math.floor(args.atrPeriod)),
        atrMultiplier: Number(args.atrMultiplier),
        rsiPeriod: Math.max(2, Math.floor(args.rsiPeriod)),
    });

    // Build output payload
    const meta = {
        product: productName,
        timeframe,
        startUtc: startDate.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        endUtc: endDate.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        generatedAtUtc: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        source: `CSV file: ${path.basename(inputPath)}`,
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
    console.log(`Saved candles JSON: ${jsonPath}`);

    await fs.writeFile(reportPath, `${buildReport(meta, analysis)}\n`, 'utf8');
    console.log(`Saved analysis report: ${reportPath}`);

    await fs.writeFile(htmlPath, `${buildHtmlDashboard(payload)}\n`, 'utf8');
    console.log(`Saved interactive dashboard: ${htmlPath}`);

    // Print a brief summary
    console.log('\n--- Quick Summary ---');
    console.log(`  Candles: ${analysis.candleCount}`);
    console.log(`  Range: ${analysis.low.toFixed(2)} ~ ${analysis.high.toFixed(2)}`);
    console.log(`  Last Close: ${analysis.lastClose.toFixed(2)}`);
    console.log(`  Stage: ${analysis.stage}`);
    console.log(`  Primary: ${analysis.primaryScenario?.title || 'none'}`);
    console.log(`  Trend: ${analysis.trendOutlook?.likely || 'n/a'}`);
    console.log(`  Patterns found: ${analysis.allPatternCandidates.length}`);
}

main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
});
