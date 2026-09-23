## Decisions

### D1 市场识别
`detectMarket(product, source)`：`source` 显式给出优先；否则 `/-/`→crypto、`/^\d{6}$/`→cn、`/^[A-Za-z.]+$/`→us，其余报错。

### D2 K 线时间戳约定
股票日线的 `timestamp` = 该**交易日**的 UTC 零点（日期即交易所本地日期）。这样沿用现有按 UTC 的周线合成（周一起算）即正确，显示时直接取 UTC 日期即交易日，不受时区换算影响。

### D3 取数
- Twelve Data：`/time_series?symbol&interval=1day&start_date&end_date&outputsize=5000&adjust=splits&order=ASC`；`status:"error"` 抛出其 message；返回满 5000 根则以最早日期前一天为 end_date 继续向前翻页。
- 东方财富：`/api/qt/stock/kline/get?secid&klt=101&fqt=1&beg&end`；secid 沪市（5/6/9 开头）`1.`，其余 `0.`；字段顺序 `date,open,close,high,low,volume`；名称取 `data.name`。
- 均可注入 `fetchImpl` 便于离线测试。

### D4 已收盘过滤
取交易所时区当前日期与时刻（`Intl.DateTimeFormat`）；若最后一根 K 线日期=交易所今天且未到收盘（美股 16:00 ET、A 股 15:00 CST），剔除该根。

### D5 精度
美股 2；A 股 ETF/LOF（`5`、`15`~`18` 开头）3，其余 2。

### D6 呈现
- 美股时间范围 / 最新收盘按 `America/New_York` 显示并标「美东」；A 股按北京时间。生成时间一律北京时间。
- 简报标题：`{代码}[ {名称}] {周期}波浪分析简报`。
- 数据来源：`Twelve Data time_series API` / `东方财富 K线 API`。
- 股票跳过 `enrichCurrentPullback`（子级别下钻）。
