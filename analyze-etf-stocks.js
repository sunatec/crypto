'use strict';

const fs = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');

// Import core wave analysis engine
const {
    analyzeWave,
    buildReport,
    buildHtmlDashboard,
    formatToUtcOffset,
    REPORT_TZ_OFFSET_HOURS,
} = require('./analyze-kline-wave');

// ─────────────────────── Constants ───────────────────────

const EASTMONEY_FUND_HOLDINGS_API = 'https://fund.eastmoney.com/f10/F10DataApi.aspx';
const EASTMONEY_KLINE_API = 'https://push2his.eastmoney.com/api/qt/stock/kline/get';

const KLT_MAP = {
    '1d': 101,
    '1day': 101,
    '1w': 102,
    '1week': 102,
    '1m': 103,
    '1month': 103,
    '60min': 60,
    '1h': 60,
    '30min': 30,
    '15min': 15,
    '5min': 5,
};

// ─────────────────────── HTTP Helpers ───────────────────────

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
 * Fetch text content from URL, with PowerShell fallback on Windows.
 */
async function fetchText(url, retries = 3) {
    let lastErr = null;

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 20000);
            const res = await fetch(url, {
                signal: controller.signal,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    Accept: '*/*',
                    Referer: 'https://fund.eastmoney.com/',
                },
            });
            clearTimeout(timer);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.text();
        } catch (err) {
            lastErr = err;
            if (attempt < retries) await sleep(400 * attempt);
        }
    }

    // PowerShell fallback
    if (process.platform === 'win32') {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const escapedUrl = String(url).replace(/'/g, "''");
                const command = [
                    "$ProgressPreference='SilentlyContinue'",
                    `[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12`,
                    `$headers = @{ 'Referer' = 'https://fund.eastmoney.com/'; 'User-Agent' = 'Mozilla/5.0' }`,
                    `(Invoke-WebRequest -Uri '${escapedUrl}' -Headers $headers -UseBasicParsing -TimeoutSec 20).Content`,
                ].join('; ');
                const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', command], {
                    encoding: 'utf8',
                    maxBuffer: 1024 * 1024 * 20,
                });
                return stdout;
            } catch (err) {
                lastErr = err;
                if (attempt < retries) await sleep(500 * attempt);
            }
        }
    }

    throw new Error(`Failed to fetch ${url}: ${lastErr?.message || lastErr}`);
}

async function fetchJson(url, retries = 3) {
    const text = await fetchText(url, retries);
    return JSON.parse(text);
}

// ─────────────────────── Fund Holdings ───────────────────────

/**
 * Fetch ETF/Fund top holdings from East Money F10DataApi.
 * Returns array of { stockCode, stockName, weight, shares, marketValue }
 */
async function fetchFundHoldings(fundCode, topline = 100) {
    console.log(`Fetching holdings for fund ${fundCode}...`);

    const url = `${EASTMONEY_FUND_HOLDINGS_API}?type=jjcc&code=${fundCode}&page=1&topline=${topline}`;
    const rawText = await fetchText(url);

    // Response format: var apidata={ content:"<html>...", records:N, pages:M, curpage:1 };
    // Extract the content HTML
    const contentMatch = rawText.match(/content:"([\s\S]*?)",\s*records:/);
    if (!contentMatch) {
        throw new Error(`Cannot parse fund holdings response for ${fundCode}. Raw: ${rawText.slice(0, 200)}`);
    }

    const html = contentMatch[1].replace(/\\"/g, '"').replace(/\\\//g, '/');

    // Parse stock holdings from HTML table rows
    // Pattern: stock code and name from <a> tags, then weight from <td>
    const holdings = [];

    // Match each table row that contains holding data
    // Typical pattern: <td><a ...>STOCK_CODE</a></td><td><a ...>STOCK_NAME</a></td>...<td>WEIGHT%</td>...
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch;

    while ((rowMatch = rowRegex.exec(html)) !== null) {
        const row = rowMatch[1];

        // Extract stock code (6 digits) from links
        const codeMatch = row.match(/href[^>]*>(\d{6})<\/a>/);
        if (!codeMatch) continue;

        const stockCode = codeMatch[1];

        // Extract stock name from the second link
        const nameMatch = row.match(/href[^>]*>\d{6}<\/a>[\s\S]*?href[^>]*>([^<]+)<\/a>/);
        const stockName = nameMatch ? nameMatch[1].trim() : stockCode;

        // Extract weight percentage and other data from <td> cells
        const cells = [];
        const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
        let tdMatch;
        while ((tdMatch = tdRegex.exec(row)) !== null) {
            cells.push(tdMatch[1].replace(/<[^>]*>/g, '').trim());
        }

        // cells typically: [index, code, name, related, weight, shares, marketValue, netAssetRatio]
        let weight = 0;
        let shares = 0;
        let marketValue = 0;

        for (const cell of cells) {
            const num = parseFloat(cell.replace(/,/g, ''));
            if (!Number.isFinite(num)) continue;
            // Weight is usually a small percentage like 5.23
            if (num > 0 && num < 100 && weight === 0) {
                weight = num;
            } else if (num > 100 && shares === 0) {
                shares = num;
            } else if (num > 100 && marketValue === 0) {
                marketValue = num;
            }
        }

        holdings.push({ stockCode, stockName, weight, shares, marketValue });
    }

    if (holdings.length === 0) {
        throw new Error(`No holdings found for fund ${fundCode}. The API response might have changed.`);
    }

    console.log(`  Found ${holdings.length} holdings.`);
    return holdings;
}

// ─────────────────────── Stock K-line Data ───────────────────────

/**
 * Get East Money secid for a stock code.
 * Shanghai (6xxxxx) → "1.CODE", Shenzhen/Beijing → "0.CODE"
 */
function getSecId(stockCode) {
    const code = String(stockCode).padStart(6, '0');
    return code.startsWith('6') ? `1.${code}` : `0.${code}`;
}

/**
 * Fetch K-line data for a stock from East Money.
 * Returns candle array in the format expected by analyzeWave.
 */
async function fetchStockKlines(stockCode, klt = 101, limit = 300) {
    const secid = getSecId(stockCode);
    const url = `${EASTMONEY_KLINE_API}?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=${klt}&fqt=1&beg=0&end=20500101&lmt=${limit}`;

    const data = await fetchJson(url);

    if (!data.data || !data.data.klines || !Array.isArray(data.data.klines)) {
        throw new Error(`No kline data for ${stockCode}`);
    }

    const candles = [];

    for (const line of data.data.klines) {
        // Format: date,open,close,high,low,volume,amount,amplitude,change_pct,change_amount,turnover
        const parts = line.split(',');
        if (parts.length < 6) continue;

        const dateStr = parts[0];
        const open = parseFloat(parts[1]);
        const close = parseFloat(parts[2]); // Note: close is 3rd field in East Money!
        const high = parseFloat(parts[3]);
        const low = parseFloat(parts[4]);
        const volume = parseFloat(parts[5]) || 0;

        if ([open, high, low, close].some((n) => !Number.isFinite(n))) continue;

        // Parse date
        const dt = new Date(dateStr + 'T00:00:00Z');
        if (Number.isNaN(dt.getTime())) continue;

        // Skip weekends
        const day = dt.getUTCDay();
        if (day === 0 || day === 6) continue;

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

    return {
        name: data.data.name || stockCode,
        code: data.data.code || stockCode,
        candles: candles.sort((a, b) => a.timestamp - b.timestamp),
    };
}

// ─────────────────────── Entry Scoring ───────────────────────

/**
 * Score a stock for entry suitability based on wave analysis.
 * Returns { score: 0-100, rating: string, reasons: string[] }
 */
function scoreStockForEntry(analysis) {
    let score = 50; // Start at neutral
    const reasons = [];

    if (!analysis || !analysis.primaryScenario) {
        return { score: 0, rating: '⚠️ 数据不足', reasons: ['无法识别有效浪型'] };
    }

    const primary = analysis.primaryScenario;
    const outlook = analysis.trendOutlook || {};
    const upPct = outlook.upPct || 0;
    const downPct = outlook.downPct || 0;

    // 1. Trend direction weight (+/- 15)
    if (upPct > 65) {
        score += 15;
        reasons.push(`强多头格局(${upPct.toFixed(0)}%)`);
    } else if (upPct > 55) {
        score += 8;
        reasons.push(`偏多(${upPct.toFixed(0)}%)`);
    } else if (downPct > 65) {
        score -= 15;
        reasons.push(`强空头格局(${downPct.toFixed(0)}%)`);
    } else if (downPct > 55) {
        score -= 8;
        reasons.push(`偏空(${downPct.toFixed(0)}%)`);
    }

    // 2. Wave position scoring (+/- 20)
    const wave = primary.currentWave || '';
    const stage = primary.stage || '';
    const direction = primary.direction || '';

    if (direction === 'up') {
        // Bullish patterns
        if (wave.includes('2浪') && (wave.includes('末端') || wave.includes('回调'))) {
            score += 20;
            reasons.push('2浪回调末端（最佳入场）');
        } else if (wave.includes('4浪') && (wave.includes('末端') || wave.includes('回调'))) {
            score += 18;
            reasons.push('4浪回调末端（优质入场）');
        } else if (wave.includes('3浪') && wave.includes('上涨')) {
            score += 12;
            reasons.push('3浪主升段');
        } else if (wave.includes('1浪') || (wave.includes('A') && wave.includes('上涨'))) {
            score += 10;
            reasons.push('上涨初期');
        } else if (wave.includes('C浪') && wave.includes('上涨')) {
            score += 10;
            reasons.push('C浪上涨中');
        } else if (wave.includes('Y浪') && wave.includes('上涨')) {
            score += 8;
            reasons.push('Y浪上涨中');
        } else if (wave.includes('5浪') && wave.includes('上涨')) {
            score += 3;
            reasons.push('5浪末段（注意风险）');
        } else if (wave.includes('结束') && wave.includes('回撤')) {
            score += 5;
            reasons.push('浪型结束后回撤');
        }
    } else {
        // Bearish patterns
        if (wave.includes('C浪结束') || wave.includes('5浪结束') || wave.includes('反弹')) {
            score += 5;
            reasons.push('下跌浪型可能结束');
        } else if (wave.includes('3浪') && wave.includes('下跌')) {
            score -= 15;
            reasons.push('3浪下跌段（回避）');
        } else if (wave.includes('下跌')) {
            score -= 10;
            reasons.push('下跌趋势中');
        }
    }

    // 3. Confidence score (+/- 10)
    const confidence = primary.confidenceScore || 0;
    if (confidence >= 80) {
        score += 10;
        reasons.push(`高置信度(${confidence.toFixed(0)})`);
    } else if (confidence >= 60) {
        score += 5;
    } else if (confidence < 40) {
        score -= 5;
        reasons.push(`低置信度(${confidence.toFixed(0)})`);
    }

    // 4. Position in range (+/- 10)
    const positionInRange = analysis.positionInRange || 50;
    if (positionInRange < 25) {
        score += 10;
        reasons.push('接近区间底部');
    } else if (positionInRange < 40) {
        score += 5;
        reasons.push('中低位');
    } else if (positionInRange > 85) {
        score -= 8;
        reasons.push('接近区间顶部');
    } else if (positionInRange > 70) {
        score -= 3;
    }

    // 5. Risk/Reward from invalidation/confirmation (+/- 5)
    if (primary.invalidation && primary.confirmation && analysis.lastClose) {
        const inv = primary.invalidation.value;
        const conf = primary.confirmation.value;
        const close = analysis.lastClose;

        if (Number.isFinite(inv) && Number.isFinite(conf) && Number.isFinite(close)) {
            const riskDist = Math.abs(close - inv);
            const rewardDist = Math.abs(conf - close);

            if (rewardDist > 0 && riskDist > 0) {
                const rr = rewardDist / riskDist;
                if (rr >= 2) {
                    score += 5;
                    reasons.push(`风险收益比佳(${rr.toFixed(1)}:1)`);
                } else if (rr < 0.5) {
                    score -= 5;
                    reasons.push(`风险收益比差(${rr.toFixed(1)}:1)`);
                }
            }
        }
    }

    // Clamp score
    score = Math.max(0, Math.min(100, score));

    // Determine rating
    let rating;
    if (score >= 75) rating = '⭐⭐⭐ 推荐布局';
    else if (score >= 60) rating = '⭐⭐ 可关注';
    else if (score >= 45) rating = '⭐ 观望';
    else if (score >= 30) rating = '⚠️ 谨慎';
    else rating = '❌ 回避';

    return { score, rating, reasons };
}

// ─────────────────────── Summary Report ───────────────────────

function fmt(n) {
    return Number.isFinite(n) ? n.toFixed(2) : 'n/a';
}

function buildSummaryReport(fundCode, holdings, results, interval) {
    const now = new Date();
    const timeStr = formatToUtcOffset(now.toISOString(), REPORT_TZ_OFFSET_HOURS);

    const lines = [];
    lines.push(`# ETF成分股波浪分析（${fundCode}）`);
    lines.push('');
    lines.push(`- 生成时间：${timeStr} (UTC+8)`);
    lines.push(`- 分析周期：${interval}`);
    lines.push(`- 成分股数量：${holdings.length}`);
    lines.push(`- 成功分析：${results.filter((r) => r.success).length}`);
    lines.push(`- 分析失败：${results.filter((r) => !r.success).length}`);
    lines.push('');

    // Sort by entry score descending
    const sorted = results
        .filter((r) => r.success)
        .sort((a, b) => b.entryScore.score - a.entryScore.score);

    // === Top picks ===
    const topPicks = sorted.filter((r) => r.entryScore.score >= 60);
    const watchList = sorted.filter((r) => r.entryScore.score >= 45 && r.entryScore.score < 60);
    const cautionList = sorted.filter((r) => r.entryScore.score >= 30 && r.entryScore.score < 45);
    const avoidList = sorted.filter((r) => r.entryScore.score < 30);

    lines.push('---');
    lines.push('');

    // Summary table of all stocks
    lines.push('## 综合评分排名');
    lines.push('');
    lines.push('| 排名 | 代码 | 名称 | 最新价 | 区间位置 | 主浪型 | 当前浪位 | 方向 | 评分 | 入场评级 |');
    lines.push('|------|------|------|--------|---------|--------|---------|------|------|---------|');

    sorted.forEach((r, i) => {
        const a = r.analysis;
        const p = a.primaryScenario || {};
        const dir = (p.direction === 'up' ? '📈多' : p.direction === 'down' ? '📉空' : '➖');
        const pos = a.positionInRange !== undefined ? `${a.positionInRange.toFixed(0)}%` : 'n/a';
        const waveStr = (p.currentWave || '-').slice(0, 12);
        const titleStr = (p.title || '-').slice(0, 14);

        lines.push(
            `| ${i + 1} | ${r.stockCode} | ${r.stockName} | ${fmt(a.lastClose)} | ${pos} | ${titleStr} | ${waveStr} | ${dir} | ${r.entryScore.score} | ${r.entryScore.rating} |`,
        );
    });
    lines.push('');

    // === Detailed sections ===
    if (topPicks.length > 0) {
        lines.push('---');
        lines.push('');
        lines.push('## ⭐ 推荐关注（评分 ≥ 60）');
        lines.push('');
        for (const r of topPicks) {
            appendStockDetail(lines, r);
        }
    }

    if (watchList.length > 0) {
        lines.push('---');
        lines.push('');
        lines.push('## 👀 观望列表（评分 45-59）');
        lines.push('');
        for (const r of watchList) {
            appendStockDetail(lines, r);
        }
    }

    if (cautionList.length > 0) {
        lines.push('---');
        lines.push('');
        lines.push('## ⚠️ 谨慎列表（评分 30-44）');
        lines.push('');
        for (const r of cautionList) {
            appendStockBrief(lines, r);
        }
    }

    if (avoidList.length > 0) {
        lines.push('---');
        lines.push('');
        lines.push('## ❌ 回避列表（评分 < 30）');
        lines.push('');
        for (const r of avoidList) {
            appendStockBrief(lines, r);
        }
    }

    // Failed stocks
    const failed = results.filter((r) => !r.success);
    if (failed.length > 0) {
        lines.push('---');
        lines.push('');
        lines.push('## ⛔ 分析失败');
        lines.push('');
        for (const r of failed) {
            lines.push(`- ${r.stockCode} ${r.stockName}：${r.error}`);
        }
        lines.push('');
    }

    lines.push('---');
    lines.push('');
    lines.push('> **免责声明**：以上分析基于算法自动识别的波浪结构，仅供参考，不构成投资建议。入场前请结合基本面、资金面及个人风险承受能力综合判断。');
    lines.push('');

    return lines.join('\n');
}

function appendStockDetail(lines, r) {
    const a = r.analysis;
    const p = a.primaryScenario || {};
    const score = r.entryScore;

    lines.push(`### ${r.stockCode} ${r.stockName} — ${score.rating}（${score.score}分）`);
    lines.push('');
    lines.push(`- 最新价：${fmt(a.lastClose)} | 区间：${fmt(a.low)} ~ ${fmt(a.high)} | 位置：${(a.positionInRange || 0).toFixed(0)}%`);
    lines.push(`- 趋势权重：偏多 ${(a.trendOutlook?.upPct || 0).toFixed(1)}% / 偏空 ${(a.trendOutlook?.downPct || 0).toFixed(1)}%`);
    lines.push(`- 主浪型：${p.title || '-'}（评分 ${(p.confidenceScore || 0).toFixed(1)}）`);
    lines.push(`- 当前浪位：${p.currentWave || '-'}`);
    lines.push(`- 阶段：${p.stage || '-'}`);

    if (p.invalidation && Number.isFinite(p.invalidation.value)) {
        lines.push(`- 失效点：${fmt(p.invalidation.value)}（${p.invalidation.note || ''}）`);
    }
    if (p.confirmation && Number.isFinite(p.confirmation.value)) {
        lines.push(`- 确认位：${fmt(p.confirmation.value)}（${p.confirmation.note || ''}）`);
    }

    // Wave legs
    if (p.waveLegs && p.waveLegs.length > 0) {
        lines.push('- 浪段：');
        for (const leg of p.waveLegs) {
            const startPt = `${leg.startType || ''}@${fmt(leg.startPrice)} (${formatToUtcOffset(leg.startTime, REPORT_TZ_OFFSET_HOURS)})`;
            const endPt = `${leg.endType || ''}@${fmt(leg.endPrice)} (${formatToUtcOffset(leg.endTime, REPORT_TZ_OFFSET_HOURS)})`;
            const change = leg.endPrice - leg.startPrice;
            lines.push(`  - ${leg.label}：${startPt} → ${endPt} | ${change >= 0 ? '+' : ''}${fmt(change)}`);
        }
    }

    // Targets
    if (p.targets && p.targets.length > 0) {
        const targetStrs = p.targets.slice(0, 3).map((t) => `${t.label}=${fmt(t.value)}`);
        lines.push(`- 目标位：${targetStrs.join('；')}`);
    }

    lines.push(`- 入场理由：${score.reasons.join('、')}`);
    lines.push('');
}

function appendStockBrief(lines, r) {
    const a = r.analysis;
    const p = a.primaryScenario || {};
    const score = r.entryScore;

    lines.push(`- **${r.stockCode} ${r.stockName}** — ${score.score}分 ${score.rating}`);
    lines.push(`  - 最新价 ${fmt(a.lastClose)} | 主浪型：${(p.title || '-').slice(0, 20)} | ${(p.currentWave || '-').slice(0, 15)}`);
    lines.push(`  - 理由：${score.reasons.join('、')}`);
}

// ─────────────────────── CLI ───────────────────────

function parseArgs(argv) {
    const args = {
        fundCode: '159320',
        interval: '1d',
        limit: 300,
        lookback: 2,
        out: null,
        help: false,
        concurrent: 3,      // Max concurrent requests
        delayMs: 300,        // Delay between requests (ms)
        topN: 0,             // 0 = all holdings
        detailDir: null,     // Directory for individual stock reports
    };

    for (let i = 0; i < argv.length; i++) {
        const item = argv[i];
        const next = argv[i + 1];

        if (item === '--help' || item === '-h') {
            args.help = true;
        } else if (item === '--interval' && next) {
            args.interval = next.toLowerCase();
            i++;
        } else if (item === '--limit' && next) {
            args.limit = Number(next);
            i++;
        } else if (item === '--lookback' && next) {
            args.lookback = Number(next);
            i++;
        } else if (item === '--out' && next) {
            args.out = next;
            i++;
        } else if (item === '--concurrent' && next) {
            args.concurrent = Number(next);
            i++;
        } else if (item === '--delay' && next) {
            args.delayMs = Number(next);
            i++;
        } else if (item === '--top' && next) {
            args.topN = Number(next);
            i++;
        } else if (item === '--detail-dir' && next) {
            args.detailDir = next;
            i++;
        } else if (!item.startsWith('--')) {
            // Positional: fund code or interval
            if (/^\d{6}$/.test(item)) {
                args.fundCode = item;
            } else if (KLT_MAP[item.toLowerCase()]) {
                args.interval = item.toLowerCase();
            }
        }
    }

    return args;
}

function printHelp() {
    console.log(`
╔══════════════════════════════════════════════════════════════════╗
║        ETF 成分股波浪分析筛选器（东方财富数据源）                ║
╠══════════════════════════════════════════════════════════════════╣
║  获取ETF成分股，批量波浪分析，按入场适合度排名                   ║
╚══════════════════════════════════════════════════════════════════╝

Usage:
  node analyze-etf-stocks.js [fundCode] [interval] [options]

Arguments:
  fundCode    ETF/基金代码，默认: 159320 (电力设备ETF)
  interval    K线周期: 1d(日线), 1w(周线), 1h(60分钟), 默认: 1d

Options:
  --limit N       每只股票获取K线数量，默认: 300
  --top N         只分析前N大持仓，默认: 全部
  --concurrent N  并发请求数，默认: 3
  --delay N       请求间隔(ms)，默认: 300
  --lookback N    枢轴回看窗口，默认: 2
  --out FILE      输出报告文件名
  --detail-dir DIR  为每只股票单独生成报告的目录

Examples:
  node analyze-etf-stocks.js 159320 1d              # 电力设备ETF 日线分析
  node analyze-etf-stocks.js 159320 1w              # 周线分析
  node analyze-etf-stocks.js 510300 1d              # 沪深300ETF 日线分析
  node analyze-etf-stocks.js 159320 1d --top 20     # 只分析前20大持仓
  node analyze-etf-stocks.js 159320 1d --detail-dir ./etf_reports
`);
}

// ─────────────────────── Main ───────────────────────

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        return;
    }

    const klt = KLT_MAP[args.interval];
    if (!klt) {
        throw new Error(`Unsupported interval: ${args.interval}. Use: ${Object.keys(KLT_MAP).join(', ')}`);
    }

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  ETF成分股波浪分析 — ${args.fundCode} ${args.interval}`);
    console.log(`${'═'.repeat(60)}\n`);

    // 1. Fetch fund holdings
    let holdings = await fetchFundHoldings(args.fundCode);

    if (args.topN > 0 && args.topN < holdings.length) {
        holdings = holdings.slice(0, args.topN);
        console.log(`  Analyzing top ${args.topN} holdings.`);
    }

    console.log(`\nStarting analysis of ${holdings.length} stocks...\n`);

    // 2. Analyze each stock
    const results = [];
    let completed = 0;

    for (let i = 0; i < holdings.length; i++) {
        const h = holdings[i];
        const progress = `[${i + 1}/${holdings.length}]`;

        try {
            process.stdout.write(`${progress} ${h.stockCode} ${h.stockName}... `);

            // Fetch k-line data
            const { candles, name } = await fetchStockKlines(h.stockCode, klt, args.limit);

            if (candles.length < 20) {
                console.log(`⚠ 数据不足(${candles.length}根)`);
                results.push({
                    stockCode: h.stockCode,
                    stockName: name || h.stockName,
                    weight: h.weight,
                    success: false,
                    error: `K线数据不足(${candles.length}根)`,
                });
                await sleep(args.delayMs);
                continue;
            }

            // Add UTC+8 time
            const candlesWithTz = candles.map((c) => ({
                ...c,
                timeUtc8: formatToUtcOffset(c.timeUtc, REPORT_TZ_OFFSET_HOURS),
            }));

            // Run wave analysis
            const analysis = analyzeWave(candlesWithTz, Math.max(1, args.lookback), {
                atrPeriod: 14,
                atrMultiplier: 1.5,
                rsiPeriod: 14,
            });

            // Score for entry
            const entryScore = scoreStockForEntry(analysis);

            results.push({
                stockCode: h.stockCode,
                stockName: name || h.stockName,
                weight: h.weight,
                success: true,
                analysis,
                entryScore,
                candles: candlesWithTz,
            });

            console.log(`✅ ${entryScore.score}分 ${entryScore.rating}`);

            // Save individual reports if detail-dir specified
            if (args.detailDir) {
                await saveStockDetail(args.detailDir, h.stockCode, name || h.stockName, args.interval, candlesWithTz, analysis);
            }

            completed++;
        } catch (err) {
            console.log(`❌ ${err.message}`);
            results.push({
                stockCode: h.stockCode,
                stockName: h.stockName,
                weight: h.weight,
                success: false,
                error: err.message,
            });
        }

        // Rate limiting
        if (i < holdings.length - 1) {
            await sleep(args.delayMs);
        }
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Analysis complete: ${completed}/${holdings.length} stocks`);
    console.log(`${'─'.repeat(60)}\n`);

    // 3. Generate summary report
    const reportContent = buildSummaryReport(args.fundCode, holdings, results, args.interval);

    const outFile = args.out || `ETF_${args.fundCode}_${args.interval}_analysis.md`;
    const outPath = path.resolve(process.cwd(), outFile);
    await fs.writeFile(outPath, reportContent + '\n', 'utf8');
    console.log(`✅ 综合报告：${outPath}`);

    // 4. Save JSON data
    const jsonFile = outFile.replace(/\.md$/, '.json');
    const jsonPath = path.resolve(process.cwd(), jsonFile);
    const jsonData = {
        meta: {
            fundCode: args.fundCode,
            interval: args.interval,
            generatedAt: new Date().toISOString(),
            totalHoldings: holdings.length,
            analyzedCount: completed,
        },
        results: results.map((r) => ({
            stockCode: r.stockCode,
            stockName: r.stockName,
            weight: r.weight,
            success: r.success,
            error: r.error || null,
            entryScore: r.entryScore || null,
            summary: r.success
                ? {
                    lastClose: r.analysis.lastClose,
                    high: r.analysis.high,
                    low: r.analysis.low,
                    positionInRange: r.analysis.positionInRange,
                    primaryScenario: r.analysis.primaryScenario?.title || null,
                    currentWave: r.analysis.primaryScenario?.currentWave || null,
                    direction: r.analysis.primaryScenario?.direction || null,
                    confidenceScore: r.analysis.primaryScenario?.confidenceScore || null,
                    upPct: r.analysis.trendOutlook?.upPct || null,
                    downPct: r.analysis.trendOutlook?.downPct || null,
                }
                : null,
        })),
    };
    await fs.writeFile(jsonPath, JSON.stringify(jsonData, null, 2) + '\n', 'utf8');
    console.log(`✅ JSON 数据：${jsonPath}`);

    // Print top picks
    const topPicks = results
        .filter((r) => r.success && r.entryScore.score >= 60)
        .sort((a, b) => b.entryScore.score - a.entryScore.score);

    if (topPicks.length > 0) {
        console.log(`\n${'═'.repeat(60)}`);
        console.log('  📊 推荐关注（评分 ≥ 60）');
        console.log(`${'═'.repeat(60)}`);
        for (const r of topPicks.slice(0, 10)) {
            const p = r.analysis.primaryScenario || {};
            console.log(`  ${r.entryScore.score} | ${r.stockCode} ${r.stockName.padEnd(8)} | ${(p.currentWave || '-').slice(0, 15)} | ${r.entryScore.reasons.slice(0, 2).join('、')}`);
        }
        console.log(`${'═'.repeat(60)}\n`);
    }
}

async function saveStockDetail(dir, code, name, interval, candles, analysis) {
    try {
        await fs.mkdir(dir, { recursive: true });
        const meta = {
            product: `${code} ${name}`,
            timeframe: interval,
            startUtc: candles[0]?.timeUtc || '',
            endUtc: candles[candles.length - 1]?.timeUtc || '',
            generatedAtUtc: new Date().toISOString(),
            source: 'East Money',
        };
        const reportContent = buildReport(meta, analysis);
        const filePath = path.join(dir, `${code}_${name}_${interval}.md`);
        await fs.writeFile(filePath, reportContent + '\n', 'utf8');
    } catch { /* ignore individual file save errors */ }
}

main().catch((err) => {
    console.error(`\n❌ Error: ${err.message || err}`);
    if (err.cause) console.error(`  Cause: ${err.cause.message || err.cause}`);
    process.exit(1);
});
