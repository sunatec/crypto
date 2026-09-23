## 1. 数据源模块 market-data.js

- [x] 1.1 `detectMarket`、`priceDecimals`、`eastmoneySecId`
- [x] 1.2 `fetchTwelveData`（翻页、错误透传、adjust=splits）
- [x] 1.3 `fetchEastmoney`（fqt=1、名称）
- [x] 1.4 `dropUnclosedBar`（交易所时区收盘判断）

## 2. 接入 analyze-wave-tree.js

- [x] 2.1 `--source` / `--apikey` 参数；股票周期限制 1d/1w
- [x] 2.2 `main` 按市场分派取数；股票跳过子级别下钻；meta 增加 market/name/displayTz
- [x] 2.3 元信息时区显示、简报标题带名称

## 3. 测试与验证

- [x] 3.1 离线测试：识别、secid、精度、未收盘剔除、Twelve Data/东方财富解析与翻页、缺 key 报错
- [x] 3.2 全量测试通过
- [ ] 3.3 真实数据跑 AAPL（需 key）与 600519
