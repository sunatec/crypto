# Kline Wave Analyzer

基于 Coinbase K 线数据做自动化 Elliott 波浪结构识别，输出：

- 原始/整理后的 K 线数据 JSON
- 波浪分析 Markdown 报告
- 可交互查看的 HTML 报告

## 快速使用

```bash
node analyze-kline-wave.js --product BTC-USD --tf 1h --start 2026-02-06T00:00:00+08:00 --end now
```

这条命令默认会生成 3 个文件：

- `<product>_<tf>_<start>_<end>.json`
- `<product>_<tf>_<start>_<end>.md`
- `<product>_<tf>_<start>_<end>.html`

## 命令格式

```bash
node analyze-kline-wave.js [options]
```

## 参数说明

- `--product` 交易对，默认 `BTC-USD`
- `--tf`, `--timeframe` 周期，支持：`5m | 1h | 4h | 1d | 1w | 1m | 1y`
- `--start` 开始时间，ISO 字符串；默认是 `end - 30d`
- `--end` 结束时间，ISO 字符串或 `now`；默认 `now`
- `--out` 输出 JSON 文件名；不填则自动命名
- `--report` 输出 Markdown 文件名；不填则自动命名
- `--html` 输出 HTML 文件名；不填则自动命名
- `--lookback` 枢轴点识别窗口，默认 `2`
- `--atr-period` ATR 周期，用于枢轴噪音过滤，默认 `14`
- `--atr-multiplier` 最小枢轴价差系数，规则是 `ATR * multiplier`，默认 `1.5`
- `--rsi-period` RSI 周期，用于动量/背离判断，默认 `14`
- `--brief` 只在控制台输出简短结果，不写文件
- `--full-report` 输出旧版完整 Markdown 报告
- `--help`, `-h` 显示帮助

## 默认输出命名

如果没有显式指定 `--out`、`--report`、`--html`，脚本会按 `UTC+8` 时间戳自动命名：

- JSON：`<product>_<tf>_<start>_<end>.json`
- Markdown：`<product>_<tf>_<start>_<end>.md`
- HTML：`<product>_<tf>_<start>_<end>.html`

例如：

- `BTC-USD_1h_202602060000_202603172253.json`
- `BTC-USD_1h_202602060000_202603172253.md`
- `BTC-USD_1h_202602060000_202603172253.html`

## 常用示例

生成默认精简版 Markdown、JSON、HTML：

```bash
node analyze-kline-wave.js --product BTC-USD --tf 1h --start 2026-02-06T00:00:00+08:00 --end now
```

指定输出文件名：

```bash
node analyze-kline-wave.js --product BTC-USD --tf 1h --start 2026-02-06T00:00:00+08:00 --end now --out btc_1h.json --report btc_1h.md --html btc_1h.html
```

输出旧版完整 Markdown 报告：

```bash
node analyze-kline-wave.js --product BTC-USD --tf 1h --start 2026-02-06T00:00:00+08:00 --end now --full-report
```

只看控制台简报，不生成文件：

```bash
node analyze-kline-wave.js --product BTC-USD --tf 1h --start 2026-02-06T00:00:00+08:00 --end now --brief
```

调整枢轴识别灵敏度：

```bash
node analyze-kline-wave.js --product BTC-USD --tf 1h --start 2026-02-06T00:00:00+08:00 --end now --lookback 3 --atr-period 14 --atr-multiplier 1.8 --rsi-period 14
```

## 当前 Markdown 输出说明

默认 Markdown 是精简版，重点输出：

- `数据概览`
- `算法结构推演`

如果你需要旧版完整报告，使用：

```bash
node analyze-kline-wave.js ... --full-report
```

## 波浪计数引擎 analyze-wave-tree.js

以《波浪理论详解》为准绳，对整段行情递归拆解，产出「最大级别 → 当前浪」计数树。核心特性：

- **否定法排序（Negation Method）**：硬规则淘汰不合法数法、准则给存活者排序；若无零违规候选，退取「最轻违规者」并标注 `penalized`。
- **框架 A / 框架 B**：A＝大跌到全局极值即算完成；B＝末浪进行中（如 `126296→now` 的 y 浪未走完），并对最后一个转折点之后的反弹做身份研判（XX 连接浪 / 更大级别 B 浪 / 新推动浪第 1、3 浪）。
- **文法 + 几何双闸**：校验各腿角色能否履行（五浪 vs 三波），并要求连接浪方向交替、腿端点为该跨度真极值。
- **七节结构化报告**：范围 / 关键转折点 / 已完成浪型（逐腿起止+内部结构+价格·时间比例+排除理由）/ 当前主方案 / 备选方案 / 方案排序 / 最终话术。反弹方案强制点明修正对象（XX→上一子浪、B→整段），wave-3 用书内结构验证（不看动量、不因涨幅大直接判 3 浪）。
- 强弱用 **高/中/低** 分档，不给概率百分比；所有数字均由本次 K 线自动计算。

### 快速使用

```bash
node analyze-wave-tree.js --product BTC-USD --tf 1d --start 2025-10-05T00:00:00+08:00 --end now
```

每次运行按 `UTC+8` 时间戳自动生成 3 个文件：

- `<product>_<tf>_<start>_<end>_tree.json` — 计数树 + 进行中腿 + 排名 + 跨级别序列化
- `<product>_<tf>_<start>_<end>_tree.md` — 大白话版分析报告
- `<product>_<tf>_<start>_<end>_structured.md` — 七节结构化报告

### 参数说明

- `--product` 交易对，默认 `BTC-USD`
- `--tf`, `--timeframe` 周期，支持：`5m | 1h | 4h | 1d | 1w | 1m | 1y`
- `--start` 开始时间，ISO 字符串；默认 `end - 30d`
- `--end` 结束时间，ISO 字符串或 `now`；默认 `now`
- `--out` 输出 JSON 文件名；不填则自动命名
- `--report` 输出大白话 Markdown 文件名；不填则自动命名
- `--structured` 输出七节结构化 Markdown 文件名；不填则自动命名
- `--count "p1,p2,p3,p4"` 喂入你自己的数法（一组转折价格），引擎逐条按规则打分并并入报告
- `--help`, `-h` 显示帮助

### 常用示例

给引擎评判自己的数法（例如作者的 W-X-Y 双锯齿读法）：

```bash
node analyze-wave-tree.js --product BTC-USD --tf 1d --start 2025-10-05T00:00:00+08:00 --end now --count "126296,80524.65,97963.62,57717.55"
```

指定输出文件名：

```bash
node analyze-wave-tree.js --product BTC-USD --tf 1d --start 2025-10-05T00:00:00+08:00 --end now --out btc.json --report btc_tree.md --structured btc_structured.md
```

## 数据来源

Coinbase Exchange Candles API：

`https://api.exchange.coinbase.com/products/<product>/candles`

## Twelve Data 版用法

`analyze-xauusd-twelvedata.js` 用 Twelve Data API 拉取外汇、贵金属、加密货币数据，然后复用同一套波浪分析引擎输出：

- JSON 数据文件
- Markdown 分析报告
- HTML 交互报告

推荐先设置 API Key：

```bash
$env:TWELVE_DATA_API_KEY="your_key"
```

也可以直接通过参数传入：

```bash
node analyze-xauusd-twelvedata.js --apikey your_key
```

### 快速开始

默认分析 `XAU/USD` 的 `1h` 周期：

```bash
node analyze-xauusd-twelvedata.js
```

也支持把品种和周期作为位置参数直接写：

```bash
node analyze-xauusd-twelvedata.js xau 4h
node analyze-xauusd-twelvedata.js xag 1d
node analyze-xauusd-twelvedata.js eur 1h
```

### 命令格式

```bash
node analyze-xauusd-twelvedata.js [symbol] [interval] [options]
```

### 支持的品种写法

- 简写：`xau` / `gold` -> `XAU/USD`
- 简写：`xag` / `silver` -> `XAG/USD`
- 简写：`eur` / `eurusd` -> `EUR/USD`
- 简写：`gbp` / `gbpusd` -> `GBP/USD`
- 简写：`jpy` / `usdjpy` -> `USD/JPY`
- 简写：`btc` / `btcusd` -> `BTC/USD`
- 简写：`eth` / `ethusd` -> `ETH/USD`
- 完整写法：`--symbol XAU/USD`

### 主要参数

- `--symbol` 交易品种，默认 `XAU/USD`
- `--interval`, `--tf` 周期，支持 `1min | 5min | 15min | 30min | 45min | 1h | 2h | 4h | 1d | 1w | 1m`
- `--apikey`, `--api-key`, `--key` Twelve Data API Key
- `--start` 开始时间，支持 `YYYY-MM-DD`、ISO 时间、`now`
- `--end` 结束时间，格式同 `--start`
- `--outputsize`, `--size` 拉取点数，范围 `1-5000`
- `--out` 输出 JSON 文件名
- `--report` 输出 Markdown 文件名
- `--html` 输出 HTML 文件名
- `--mode` 报告模式：`start`、`full` 或 `macro`
- `--lookback` 枢轴识别窗口，默认 `2`
- `--atr-period` ATR 周期，默认 `14`
- `--atr-multiplier` ATR 过滤倍数，默认 `1.5`
- `--rsi-period` RSI 周期，默认 `14`

### 常用示例

指定黄金 1 小时，从某天开始拉取到现在：

```bash
node analyze-xauusd-twelvedata.js xau 1h --start 2026-02-01 --end now
```

使用完整品种名：

```bash
node analyze-xauusd-twelvedata.js --symbol XAU/USD --interval 4h --start 2026-01-01 --end now
```

输出大周期报告：

```bash
node analyze-xauusd-twelvedata.js xau 1d --mode macro
```

只输出从开始时间出发的大周期可能性：

```bash
node analyze-xauusd-twelvedata.js xau 4h --start 2026-03-01 --end now
```

输出旧版完整报告：

```bash
node analyze-xauusd-twelvedata.js xau 4h --mode full
```

指定输出文件名：

```bash
node analyze-xauusd-twelvedata.js xau 4h --report xau_4h.md --out xau_4h.json --html xau_4h.html
```

默认会生成 3 个文件：

- `<symbol>_<interval>_<start>_<end>.json`
- `<symbol>_<interval>_<start>_<end>.md`
- `<symbol>_<interval>_<start>_<end>.html`

其中 `symbol` 会自动去掉 `/`，例如 `XAU/USD` 会变成 `XAUUSD`。
