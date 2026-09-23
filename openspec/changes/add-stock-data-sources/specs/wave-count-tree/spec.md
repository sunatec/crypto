## ADDED Requirements

### Requirement: 多市场数据源

分析器 MUST 按代码格式识别市场并选用对应数据源：含连字符的交易对走 Coinbase，6 位数字走东方财富（A 股，前复权），纯字母代码走 Twelve Data（美股，按拆股复权）；`--source` MUST 可覆盖自动识别。股票市场 MUST 仅接受 `1d`/`1w` 周期，MUST 剔除交易所当日尚未收盘的 K 线。美股缺少 API key 时 MUST 报错并提示设置方式，MUST NOT 自动改用其它数据源。

#### Scenario: 自动识别市场

- **WHEN** 代码分别为 `BTC-USD`、`600519`、`AAPL` 且未指定 `--source`
- **THEN** 分别选用 Coinbase、东方财富、Twelve Data

#### Scenario: 剔除未收盘 K 线

- **WHEN** 美股在美东 10:00 取数，返回数据含当天日线
- **THEN** 当天日线被剔除，最后一根为上一交易日

#### Scenario: 美股缺 key

- **WHEN** 分析 `AAPL` 而未提供 `--apikey` 且未设 `TWELVE_DATA_API_KEY`
- **THEN** 进程报错并提示设置方式，不发起东方财富请求

#### Scenario: 股票报告呈现

- **WHEN** 分析 A 股 `600519`
- **THEN** 简报标题含代码与名称，价格保留 2 位小数，数据来源为「东方财富 K线 API」
