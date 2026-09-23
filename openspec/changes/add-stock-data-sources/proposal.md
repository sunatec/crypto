## Why

波浪引擎目前只能从 Coinbase 取加密货币 K 线。希望用同一套引擎与简报分析美股（个股/ETF）和 A 股，而不另起一套脚本。

## What Changes

- `analyze-wave-tree.js` 增加**数据源适配层**：按代码格式自动识别市场，`--source` 可手动覆盖。
  - `BTC-USD`（含 `-`）→ 加密货币 → Coinbase（现状不变）
  - 6 位数字 → A 股 → 东方财富 K 线（前复权 `fqt=1`）
  - 纯字母 → 美股 → Twelve Data `time_series`（`adjust=splits`）；key 取 `--apikey` 或 `TWELVE_DATA_API_KEY`，缺失即报错（不自动换源）
- 股票仅支持 `1d` / `1w`（周线由日线合成），不做回撤子级别下钻；只用已收盘 K 线（美股美东 16:00、A 股北京时间 15:00）。
- 报告：美股时间按美东显示，A 股按北京时间；价格小数位美股 2、A 股个股 2 / ETF 3；A 股标题带名称；元信息数据来源随之变化。
- 港股、指数、分钟级股票数据不在本次范围。
- **不改动**：引擎、评分、简报结构；`_tree.json` 仅 `meta` 增加 `market` / `name` / `displayTz` 字段。

## Capabilities

### Modified Capabilities
- `wave-count-tree`: 新增「多市场数据源」要求。

## Impact

- 新文件 `market-data.js`（市场识别、Twelve Data / 东方财富取数、已收盘过滤、精度）。
- `analyze-wave-tree.js`：`main` 按市场分派取数、`--source` / `--apikey` 参数、元信息与简报标题。
- 测试：新增离线测试（注入假 fetch）。
