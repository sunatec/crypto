# Kline Wave Analyzer

基于 Coinbase K 线数据做自动化 Elliott 波浪结构识别，并输出：

- K 线明细 JSON
- 波浪分析 Markdown 报告

## 快速使用

```bash
node analyze-kline-wave.js --product BTC-USD --tf 1h --start 2026-02-06T00:00:00+08:00 --end now
```

## 参数说明

- `--product` 交易对，默认 `BTC-USD`
- `--tf` 周期，支持：`1h | 4h | 1d | 1w | 1m | 1y`
- `--start` 开始时间（ISO 字符串），默认：`end - 30d`
- `--end` 结束时间（ISO 字符串或 `now`），默认：`now`
- `--out` 输出 JSON 文件名（可选）
- `--report` 输出报告文件名（可选）
- `--lookback` 枢轴检测窗口，默认 `2`

## 默认输出命名规则

未指定 `--out` / `--report` 时，自动按以下格式命名（时间按 `UTC+8` 生成）：

- JSON：`<product>_<tf>_<start>_<end>.json`
- 报告：`<product>_<tf>_<start>_<end>.md`

例如：

- `BTC-USD_1h_202602060000_202602282313.json`
- `BTC-USD_1h_202602060000_202602282313.md`

## 指定输出文件名（可覆盖默认命名）

```bash
node analyze-kline-wave.js --product BTC-USD --tf 1h --start 2026-02-06T00:00:00+08:00 --end now --out btc_1h_from_0206.json --report reslut.md
```

## 报告内容补充

生成的 Markdown 报告包含以下增强信息（时间统一为 `UTC+8`）：

- 主结构浪段（从哪里到哪里，属于哪一浪）
- 主结构枢轴（关键高低点）
- 可能浪型（按优先级）中每个阶段的起点/终点
- 每个阶段的价格变化与用时（K 线根数）
- 失效点、确认位、目标位

## 常用示例

```bash
node analyze-kline-wave.js --product BTC-USD --tf 4h --start 2026-02-06T00:00:00+08:00 --end now
```

## 数据源

Coinbase Exchange Candles API：  
`https://api.exchange.coinbase.com/products/<product>/candles`

对于analyze-kline-wave.js 我想执行一个脚本类似node analyze-kline-wave.js --product BTC-USD --tf 1h --start 2026-02-06T00:00:00+08:00 --end now  然后输出的内容：
60.000开始有可能是联合形wxy，
（1）一种是y浪大于x浪即超过72.233
（2）另一种是y浪是三角形。
监测点65.435，如果跌破它更可能是(2)
wxy以后或者继续发展到z浪，或者向下突破




