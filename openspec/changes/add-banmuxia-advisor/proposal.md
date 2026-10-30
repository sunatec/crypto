# Proposal

## Why

《半木夏交易体系_长期参考手册_v1.0》把交易拆成"周线定性 → 日线计划 → 4H 执行"和一套可计算的风控协议（§5 均线、§8 三段背离、§14 风控公式、§15 状态机、§19 输出顺序），但每次都要人手把最新 K 线、均线、结构高低点和仓位数字凑齐再去对照手册，容易漏项，也容易让 AI 凭图感编出 MA 数值（手册 §1.2、§19.3 明令禁止）。现有仓库已有 Binance K 线拉取与缓存管道，可以把手册里能确定计算的部分落成脚本：有成本价时给持仓建议，没有成本价时给值得参与的共振点位。

## What Changes

- 新增脚本 `advise.js`：输入 Binance 任意 USDT 交易对（如 `BTC-USD` / `ETHUSDT`），自动拉取 4H、1D K 线，周线由日线按周一切分合成；只用已收盘 K 线，本地计算全部指标。
- **事实层**（确定性计算，输出 JSON）：三周期 MA5/10/30/90/120/256 的位置、偏离、5 根斜率与排列；ATR；结构高低点与 HH/HL、LH/LL；MACD(12/26/9) 三段顶/底背离（手册 §8.1 定义）；止跌 K 线；均线粘合；按 §15.1 分类的市场状态（含空头对称，共 6 种）。历史不足的指标标"数据不足"，不编数。
- **点位模式**（未给成本价）：收集 MA、结构高低点、斐波 0.382/0.5/0.618 回撤位，按 ATR 合并成共振区并排序；每个区输出计划卡（左侧挂单带、右侧触发条件及当前满足项、失效价、TP1/TP2、盈亏比）；顺大级别方向给完整计划，逆势方向只列观察位；盈亏比 < 1.5 标"性价比不足"。
- **持仓模式**（给了成本价与方向）：成本在结构中的位置、结构失效止损相对成本的盈亏、当前状态下的持有/减仓/止损/加仓条件；若另给数量与权益，追加手册 §14/§19.2 E–G 节：单笔风险占权益、实际杠杆、强平是否早于止损、减仓分步表与 -3%/-5%/-10% 压力测试。缺失字段一律标"待查"。支持 `--snapshot` 读 yaml 快照（手册 §20.2 字段子集）。
- 有持仓时读取 Binance 合约公开接口的标记价与资金费率（无需 API key）。
- 输出：终端摘要 + `reports/advise/` 下完整 Markdown 报告（章节按手册 §19.2 A–H）；每条规则判定标注来源级别（A/B/D）。
- 可选 `--narrate`：调用 Claude API（默认 `claude-sonnet-5-5`）在事实 JSON 上写老手口吻的叙述，生成后校验叙述中的价格必须出自事实 JSON，否则整段作废；不开时用模板拼接。
- 不在本次范围：波浪引擎 `analyze-wave-tree.js` 接入（第二期）；股票；自动读取账户 / 下单；成交密集区（POC）。

## Capabilities

### New Capabilities
- `banmuxia-advisor`：按半木夏手册的多周期规则与风控协议，从 Binance K 线计算事实层，输出共振点位计划或持仓建议报告，可选 LLM 叙述。

### Modified Capabilities
<!-- 无：复用 candle-cache 现有行为，不改其规格 -->

## Impact

- 新增：`advise.js`（入口）及其拆出的指标 / 点位 / 风控 / 报告模块（见 design.md），`tests/advise-*.test.js`，`reports/advise/`。
- 复用：`binance-candle-transport.js`、`candle-cache.js`（`getCandles`）、`analyze-wave-manual.js` 的 `transformCandles` / `computeATR` / `detectPivots`；不改它们的行为。
- 外部接口：Binance 现货 `api/v3/klines`、合约 `fapi/v1/premiumIndex`（公开）；`--narrate` 时 Anthropic Messages API（需 `ANTHROPIC_API_KEY`）。
- 依赖：新增 `yaml`（零依赖解析库）用于读快照；`--narrate` 直接用内置 `fetch` 调 Messages API，不引入 SDK。
