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
- `手动备选结构推演`

如果你需要旧版完整报告，使用：

```bash
node analyze-kline-wave.js ... --full-report
```

## 数据来源

Coinbase Exchange Candles API：

`https://api.exchange.coinbase.com/products/<product>/candles`
