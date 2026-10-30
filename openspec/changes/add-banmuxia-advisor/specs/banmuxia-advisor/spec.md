# Spec Delta

## Purpose

按《半木夏交易体系_长期参考手册》的多周期规则与风控协议，从 Binance K 线确定性地计算事实，给出值得参与的共振点位计划，或针对用户成本价的持仓建议，并可选由 LLM 在事实之上写叙述。

## ADDED Requirements

### Requirement: 命令行入口与两种模式
系统 SHALL 提供 `node advise.js <SYMBOL> [options]`。未提供 `--cost` 时进入点位模式；提供 `--cost` 时进入持仓模式，此时 `--side long|short` 为必填。`--snapshot <file>` 可替代命令行持仓参数。参数非法时 SHALL 以非零码退出并给出中文错误说明。

#### Scenario: 未给成本价进入点位模式
- **WHEN** 运行 `node advise.js BTC-USD`
- **THEN** 输出共振点位计划，报告 B 节写"未提供账户信息"

#### Scenario: 给成本价缺方向
- **WHEN** 运行 `node advise.js BTC-USD --cost 98000`
- **THEN** 以非零码退出，提示 `--side` 必填

#### Scenario: 交易对识别
- **WHEN** 传入 `BTC-USD`、`btcusdt` 或 `ETHUSDT`
- **THEN** 分别解析为 Binance 交易对 `BTCUSDT`、`BTCUSDT`、`ETHUSDT`

### Requirement: 多周期行情数据
系统 SHALL 从 Binance 现货获取 4H 与 1D K 线，周线 SHALL 由日线按 UTC 周一 00:00 切分合成；所有周期 SHALL 只使用已收盘 K 线，未走完的最后一根（含未走完的当周）MUST 剔除。数据不足以计算某指标时，该指标 MUST 为空并记录原因，不得估算或编造。

#### Scenario: 周线合成与 Binance 周线一致
- **WHEN** 用一段跨越多周的日线合成周线
- **THEN** 每根周线起点为周一 00:00 UTC，开盘取周一开盘、收盘取周日收盘、高低取周内极值

#### Scenario: 剔除未收盘 K 线
- **WHEN** 最后一根日线收盘时刻晚于当前时间
- **THEN** 该日线及其所在的未走完周线不参与任何计算

#### Scenario: 历史不足
- **WHEN** 交易对日线不足 256 根
- **THEN** 日线 MA256 为空，报告标"数据不足，未计算"并写明实际根数

### Requirement: 事实层指标
系统 SHALL 对周线、日线、4H 分别计算：MA5/10/30/90/120/256（简单收盘均价）及其与现价的偏离、5 根斜率方向（上行/走平/下行）、短期排列；14 周期 ATR；结构高低点及 HH/HL / LH/LL 判定；MACD(12/26/9)。日线 SHALL 额外判定 MA30/90/120 粘合与最近已收盘 K 是否为止跌/止涨 K。相同输入与参数 MUST 得到相同结果。

#### Scenario: 均线数值可复现
- **WHEN** 对同一 fixture 运行两次
- **THEN** 两次事实 JSON 完全相同

#### Scenario: 斜率走平
- **WHEN** MA90 近 5 根变化绝对值小于参数阈值
- **THEN** MA90 斜率方向为"走平"

### Requirement: MACD 三段背离判定
系统 SHALL 按手册 §8.1 判定三段顶/底背离：三个依次更高（顶）或更低（底）的价格极值，对应同向柱段峰/谷绝对值连续两次减弱，三段之间存在反向柱或接近零轴，第三极值后已收盘 K 的柱缩短为确认。结果 SHALL 为 `confirmed`、`forming` 或 `none`，并输出手册 §8.4 必填字段（周期、参数、三个极值及时间、三段柱值、反向柱是否出现、最后收盘时间、第三极值止损价、下一根 K 失效规则）。条件不全时 MUST 不得输出 `confirmed`。

#### Scenario: 三段底背离已确认
- **WHEN** 4H 出现三个依次更低的低点，负柱谷值依次变浅且段间有正柱，第三低点后最新收盘柱缩短
- **THEN** 输出 `confirmed`，止损价为第三低点

#### Scenario: 缺少反向柱分隔
- **WHEN** 三个低点之间柱值始终为负且未接近零轴
- **THEN** 不输出三段背离，最多标为普通背离

### Requirement: 市场状态分类
系统 SHALL 依据周线、日线、4H 事实将市场分类为 `TREND_LONG`、`PULLBACK_IN_UPTREND`、`RANGE`、`TREND_BROKEN_LONG`、`TREND_SHORT`、`RALLY_IN_DOWNTREND` 之一，并列出每条判定条件的命中情况。

#### Scenario: 上升趋势中回调
- **WHEN** 周线收于上行的 MA30 之上、日线 HL 未破，但日线收于 MA30 下方
- **THEN** 状态为 `PULLBACK_IN_UPTREND`

#### Scenario: 日线结构破坏
- **WHEN** 日线收盘跌破最近确认的 HL 且 MA90 走平或下行
- **THEN** 状态为 `TREND_BROKEN_LONG`，且不输出多头计划卡

### Requirement: 共振点位计划
点位模式下，系统 SHALL 收集日线 MA30/90/120/256、4H MA30/90/120、周线 MA30、日线与 4H 最近确认高低点、最近主要波段斐波 0.382/0.5/0.618 回撤位，将相距不超过 0.5 倍日线 ATR 的价位合并为共振区，按来源数排序，现价上下方各输出至多 3 个区。每个区 SHALL 给出构成来源、左侧挂单带、右侧触发条件（手册 §11.2 三条）及当前满足情况、失效价、TP1、TP2、盈亏比。顺大级别方向的区输出完整计划；逆势方向只标"观察位"；盈亏比低于阈值（默认 1.5）标"性价比不足"但仍列出。

#### Scenario: 共振合并
- **WHEN** 日线 MA90 与斐波 0.5 回撤位相距小于 0.5 倍 ATR
- **THEN** 两者合并为一个区，来源数为 2，两项来源都列出

#### Scenario: 逆势方向只作观察
- **WHEN** 状态为 `TREND_SHORT` 且现价下方存在支撑区
- **THEN** 该支撑区标"观察位，不建议参与"，不给多头入场计划

#### Scenario: 盈亏比不足
- **WHEN** 某计划卡盈亏比为 1.2
- **THEN** 该卡标"性价比不足"并保留在输出中

### Requirement: 持仓建议
持仓模式下，系统 SHALL 输出成本价相对各 MA、共振区与结构失效价的位置，在失效价止损时相对成本的盈亏百分比，以及当前状态下持有、减仓、止损、加仓各自的触发条件与价位。提供 `--qty` 与 `--equity` 时 SHALL 追加手册 §14 计算：名义价值、实际杠杆、从现价与从成本到止损的亏损、占权益百分比、按风险预算（默认 1%）的仓位上限、-3%/-5%/-10% 理论亏损；超预算时 SHALL 输出逐步减仓表，每一步重算名义价值、实际杠杆与压力损失。提供 `--liq` 时 SHALL 判断强平价是否早于失效价；未提供的字段 MUST 标"待查"，不得估算为确定值。

#### Scenario: 只给成本与方向
- **WHEN** 运行 `--cost 98000 --side long`，现价下方失效价为 95000
- **THEN** 输出"失效价止损相对成本约 -3.06%"，风险金额与杠杆标"待查"

#### Scenario: 超出风险预算
- **WHEN** 给出数量与权益，且从成本到失效价的亏损超过权益的 1%
- **THEN** 输出逐步减仓表，直到剩余仓位的止损亏损不超过预算

#### Scenario: 强平早于止损
- **WHEN** 多单强平价高于失效价
- **THEN** 结论首行提示"强平先于止损"，优先动作为降低杠杆或减仓

#### Scenario: 快照输入
- **WHEN** 运行 `--snapshot position.yaml`，文件含手册 §20.2 字段
- **THEN** 按快照中的持仓逐个输出持仓建议

### Requirement: 合约公开数据
持仓模式下，系统 SHALL 读取 Binance 合约公开接口的标记价与资金费率，并与现货现价并列展示；获取失败时 MUST 不阻断，相应字段标"获取失败"。

#### Scenario: 合约接口不可用
- **WHEN** 合约标记价请求失败
- **THEN** 报告照常生成，标记价标"获取失败"，风控计算改用现货收盘价并注明

### Requirement: 报告输出与来源标注
系统 SHALL 在终端打印摘要，并在 `reports/advise/` 写入 Markdown 报告，章节顺序为手册 §19.2 的 A–H，附录列出本次参数及其来源级别（A/B/D）。报告首尾 MUST 含免责声明。`--json` 时 SHALL 将事实 JSON 输出到 stdout。报告中的每个价格 MUST 出自事实 JSON。

#### Scenario: 报告文件生成
- **WHEN** 运行一次点位模式
- **THEN** `reports/advise/` 下生成以交易对和时间命名的 Markdown 文件，含 A–H 章节与参数附录

### Requirement: 可选 LLM 叙述
`--narrate` 时系统 SHALL 调用 Anthropic Messages API（默认模型 `claude-sonnet-5-5`，可用 `--model` 覆盖，密钥取自 `ANTHROPIC_API_KEY`），只提供手册约束摘要与事实 JSON。系统 MUST 校验叙述中出现的价格类数字均出自事实 JSON，否则作废该叙述并回退模板文本。缺少密钥或请求失败时 MUST 回退模板，不阻断报告。

#### Scenario: 叙述引入新数字
- **WHEN** LLM 叙述中出现事实 JSON 里没有的价格 101234
- **THEN** 叙述被作废，报告注明"叙述含未验证数字，已回退模板"

#### Scenario: 无密钥
- **WHEN** 未设置 `ANTHROPIC_API_KEY` 却使用 `--narrate`
- **THEN** 报告正常生成，使用模板叙述并提示未调用 LLM
