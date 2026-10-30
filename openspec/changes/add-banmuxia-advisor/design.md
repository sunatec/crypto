# Design

## Context

- 仓库已有 Binance K 线管道：`binance-candle-transport.js`（`fetchBinancePage`，返回 `[tsSec, low, high, open, close, volume]`）+ `candle-cache.js`（`getCandles(product, granularity, start, end, { source, transport, granularities })`，只缓存已收盘 K 线）。`analyze-wave-tree.js:5871` 是现成的调用样例。
- `candle-cache` 要求 `ts % granularity === 0`；Binance 周线从周一 00:00 UTC 开盘，`ts % 604800 = 345600`，直接缓存 `1w` 会抛"Unaligned"。
- `analyze-wave-manual.js` 已导出 `transformCandles`（`aggregate: 'week'` 按 `weekStartTs` 切周）、`computeATR`、`detectPivots(candles, lookback, { atrSeries, atrMultiplier })`，波浪引擎用的就是这套拐点逻辑。
- 测试用 `node:test` + `node:assert/strict`，离线 fixture 在 `tests/fixtures/`（如 `btcusdt-1d-20261025.json`，386 根日线对象数组）。
- 手册规则分 A（本人）/ B（转载）/ D（手册执行建议）；所有量化阈值都属于 D。

## Goals / Non-Goals

**Goals:**
- 事实层纯函数、可离线测试；同一组 K 线 + 参数输出完全一致。
- 报告中每个数字都能追溯到事实 JSON 的某个字段；LLM 叙述不得引入新数字。
- 阈值集中在一个参数对象里，报告列出本次所用参数与来源级别。

**Non-Goals:**
- 不改 `candle-cache`、`binance-candle-transport`、波浪引擎的行为。
- 不做回测、胜率统计、自动下单或账户读取。
- 不做币本位反向合约的非线性 PnL（快照里出现币本位仓位时标"不支持，待查"）。

## Decisions

### D1 模块拆分
```
advise.js                 CLI 入口：解析参数 → 拉数据 → 组装 → 输出
advisor/data.js           拉 4H/1D、合成 1W、去未收盘、读合约标记价/资金费率
advisor/indicators.js     SMA、EMA、MACD、斜率、排列、粘合、止跌 K 线
advisor/structure.js      拐点（复用 detectPivots + ATR 过滤）、HH/HL 判定、三段背离
advisor/state.js          §15.1 状态分类（6 态）
advisor/levels.js         候选价位收集 → 共振区合并 → 计划卡
advisor/position.js       持仓模式：成本定位、§14 风控公式、减仓分步表、压力测试
advisor/report.js         事实 JSON → Markdown（§19.2 A–H）/ 终端摘要
advisor/narrate.js        --narrate：拼 prompt、调 API、数字校验
advisor/params.js         全部阈值默认值与来源标注
```
理由：仓库现有大文件（`analyze-wave-tree.js` 近 6000 行）难测；新功能从一开始按职责拆开，每个模块都能单独喂 fixture。备选"单文件 advise.js"被否：点位、风控、报告三块测试面差异大。

### D2 周线由日线合成
用 `transformCandles(daily, TIMEFRAMES['1w'])` 合成，再丢弃当前未走完的一周（周起点 + 7 天 > 最后已收盘日线收盘时刻）。备选"直接拉 Binance `1w` 绕过缓存"被否：每次多一次请求，且和日线不同源时可能出现日界差异。实现时用测试核对 `weekStartTs` 以周一为起点，与 Binance `1w` 一致。

### D3 拉取范围
日线拉 `all`（MA256 需 ≥256 根，周线 MA30 需 ≥210 根日线）；4H 拉最近 400 根（覆盖 MA256 + 背离回看）。不足时对应指标置 `null` 并在 `dataGaps[]` 记录原因。

### D4 指标口径
- MA = SMA(close, N)，最后一根为已收盘 K 线。
- 斜率 = `(MA[t] - MA[t-5]) / MA[t-5]`；|斜率| < 0.1% 视为"走平"（D）。
- 排列：MA5>MA10>MA30 为多头排列，反之空头，其余为交错。
- MACD：EMA12 − EMA26，信号 EMA9，柱 = `DIF − DEA`（与 Binance 图表一致；国内软件常乘 2，不影响正负与比较），背离判定只用柱的正负与绝对值，与配色无关（手册 §8.1）。
- 粘合：`(max(MA30,MA90,MA120) − min(...)) / close < 3%`（日线，D）。
- 止跌 K：已收盘 K 下影 ≥ 振幅 50% 且收盘 ≥ 支撑价，或看涨吞没（D）；止涨对称。

### D5 结构与三段背离
- 拐点：`detectPivots(candles, 2, { atrSeries: computeATR(candles,14), atrMultiplier: 1 })`，再交替化（相邻同型取更极端）。参数与波浪引擎同源，保证两边拐点一致。
- HH/HL：取最近两个已确认高点与两个低点比较。
- 三段底背离：最近三个低点价格依次更低，且各自所在的负柱段谷值绝对值连续两次减小，三段之间各有至少一根正柱（或柱值越过 0 的 10% 以内，D）；第三低点后已收盘 K 的柱绝对值较前一根缩小 → `confirmed`，否则 `forming`。输出 §8.4 全部必填字段，资料不齐输出"可能出现背离，尚未确认"。顶背离对称。

### D6 市场状态（6 态）
按优先级判定，先命中先返回：
1. `TREND_BROKEN_LONG`（多头破坏）：日线最近确认 HL 被收盘跌破且 MA90 斜率 ≤ 走平；或周线收在 MA30 下且 MA30 下行。
2. `RANGE`：日线粘合成立，或周线 MA5/10/30 交错且 MA30 走平。
3. `TREND_LONG`：周线收 > MA30 且 MA30 上行；日线 HL 未破；日线 MA90、MA120 均上行。
4. `PULLBACK_IN_UPTREND`：周线条件同 3，但日线收 < MA30 或 4H 结构为 LH/LL。
5. `TREND_SHORT` / `RALLY_IN_DOWNTREND`：3、4 的空头镜像。
无一命中 → `RANGE`。每个状态附命中/未命中的条件清单，便于报告解释。

### D7 共振区与计划卡
- 候选：日线 MA30/90/120/256、4H MA30/90/120、周线 MA30、日线与 4H 最近 3 个确认高低点、最近主要波段（日线最近一对相邻确认高低点）的斐波 0.382/0.5/0.618。
- 合并：按价格排序，相邻差 ≤ 0.5×日线 ATR 归同一区；区间 = [min, max]，来源计数去重。
- 排序：来源数降序，同数按距现价近者优先；现价上下方各取 3 个。
- 计划卡（以多头支撑区为例，空头镜像）：
  - 左侧挂单带 = 区间本身；
  - 右侧触发 = §11.2 三条，逐条输出满足/未满足；
  - 失效价 = 区下方最近确认低点 − 0.3×ATR（无则区下沿 − 0.3×ATR）；
  - TP1/TP2 = 现价上方第 1、2 个阻力区下沿；
  - 盈亏比 = (TP1 − 入场中值) / (入场中值 − 失效价)；< 1.5 标"性价比不足"。
- 方向过滤：状态为多头系（TREND_LONG / PULLBACK_IN_UPTREND）时下方支撑区出多头计划，上方阻力区只作 TP 与"观察位"；空头系镜像；RANGE 两侧均出但标"区间边缘·轻仓"；TREND_BROKEN_LONG 不出多头计划。

### D8 持仓模式与风控
- 必填 `--cost`、`--side`；可选 `--qty --equity --lev --liq --margin --risk`（默认 1%）。
- 结构失效价复用 D7 的失效价逻辑（以成本所在或下方最近支撑区为准）。
- 公式直接按手册 §14.1：`ΔLoss`、`TradeLoss`、`RiskBudget`、`Q_max`、实际杠杆 `N/E`、`-3/-5/-10%` 敏感度。
- 强平检查：给了 `--liq` 时比较强平价与失效价先后；没给标"待查"。
- 减仓分步表：当 `TradeLoss > RiskBudget` 或实际杠杆 > 3（D 参考线，A 源 2020 经验）时，按 25% 一步列出直到满足预算；每步重算名义、杠杆、压力损失。逐仓时额外列"保留/释放保证金"两种情形（§14.2）。
- 快照：`--snapshot file.yaml|json`，读取手册 §20.2 字段子集（`positions[].symbol/positionSide/positionAmt/entryPrice/markPrice/leverage_configured/marginType/isolatedWallet/liquidationPrice` 与账户 `totalMarginBalance`）。

### D9 LLM 叙述
- 直接 `fetch('https://api.anthropic.com/v1/messages')`，头 `x-api-key`、`anthropic-version: 2023-06-01`；模型 `--model` 默认 `claude-sonnet-5-5`。
- system prompt：手册硬约束摘要（一页摘要十条）+"只能引用 facts 中的数字"；user：事实 JSON。
- 校验：从叙述中抽取所有 ≥3 位有效数字的数，若有不在 facts 数值集合（按价格精度舍入后比较）里的，叙述作废，报告注明原因并回退模板。
- 无 key 或请求失败不阻断，回退模板。
- 备选"引入 @anthropic-ai/sdk"被否：只用一个端点，项目已用 fetch 调 Binance，少一个依赖。

### D10 输出
- 终端：状态一句话 + 关键价位表 + 动作清单。
- 报告：`reports/advise/<SYMBOL>-<YYYYMMDD-HHmm>.md`，章节 A 结论 / B 账户体检（点位模式写"未提供"）/ C 多周期表 / D 情景 / E 单笔风控 / F 分步表 / G 压力测试 / H 最终建议 + 参数与来源附录 + 免责声明。
- `--json` 输出事实 JSON 到 stdout，便于其他脚本复用。

### 实现期补充（与上文 D1–D10 的差异，均为落地时的澄清）
- 新增 `advisor/facts.js`（事实层装配）、`advisor/numbers.js`（数字对账：LLM 叙述校验与报告测试共用）、`advisor/format.js`（价格/百分比格式化）、`advisor/cli.js`（参数解析）、`advisor/run.js`（流程编排）。
- D6：`TREND_BROKEN_LONG` 的周线条款仅在日线结构**不是**完整 LH/LL 时才算多头破坏，否则按已确立的空头走 `TREND_SHORT` / `RALLY_IN_DOWNTREND`，避免空头趋势永远被判成"多头破坏"。`PULLBACK_IN_UPTREND` 严格按 D6 第 4 条：周线条件成立且（日线收 < MA30 或 4H 为 LH/LL）即可，不再额外要求 HL 未破（破坏已在第 1 条先行拦截）。
- "最近确认 HL / LH"取最近一个**比前一低点更高的低点**（更低的高点），而不是最后一个低点：回调中连续更低的低点不会被误当成 HL 被破（真实行情回归：BTC 2026-10 回调）。
- D6（审查后）：`TREND_BROKEN_LONG` 的周线条款同样排除日线 HH/HL：周线下行 + 日线 HH/HL 反抽属于 `RALLY_IN_DOWNTREND` 一类，而不是"多头破坏"（后者会让所有区都只剩观察位）。
- D9（审查后）：叙述数字校验的 ×100（百分比口径）只对 |v| < 10 的比例型事实数值生效，避免价格/ATR 的 100 倍被放行。
- D7：共振区新增总宽度上限 `maxZoneSpanAtr`（默认 1×日线 ATR，D 级），防止相邻价位链式并成一个跨度数千点的超宽区。
- 减仓触发的参考线取"现价另一侧最近的日线均线"，避免给出"跌破已经在下方的 MA30"这种已触发的条件。
- 运行环境有代理时，Node 的 `fetch` 默认不读 `HTTPS_PROXY`，需 `NODE_USE_ENV_PROXY=1`；`advise.js` 在 `fetch failed` 且检测到代理变量时给出该提示。

## Risks / Trade-offs

- [阈值（粘合 3%、止跌 50%、ATR 倍数）无本人依据] → 全部标 D，集中在 `params.js`，报告附录列出，后续可用 fixture 回看调整。
- [现货 K 线与合约标记价有基差，插针时差更大] → 持仓模式的现价用合约标记价，结构与指标用现货；报告并列两者并注明。
- [合成周线与 Binance 图表日界不一致] → 测试核对周一切分；报告注明"周线由 UTC 日线合成"。
- [拐点参数对小币种噪声大] → 沿用引擎同源参数；拐点不足 3 个时背离与 HH/HL 输出"数据不足"。
- [LLM 校验误杀（如百分比、日期）] → 只校验 ≥3 位有效数字且非日期格式的数；被作废时保留模板文本，不丢信息。
- [用户把输出当信号直接下单] → 报告首尾固定免责声明，计划卡标"条件性计划，需右侧确认"。

## Migration Plan

纯新增脚本，无迁移。回滚即删除 `advise.js`、`advisor/` 与对应测试。

## Open Questions

- 第二期接入波浪引擎时，波浪主计数失效价与 D7 失效价冲突如何取舍（取更近者还是并列）——不影响第一期规格。
