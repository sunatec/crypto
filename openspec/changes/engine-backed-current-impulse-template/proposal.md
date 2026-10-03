## Why

轴②「当前进行浪：可能的具体结构」表中的 T4 模板（上涨/下跌5浪推动·⑤进行中）直接取已确认极值之后的前 4 个细枢轴当 ①②③④，不做选点、不校验子浪结构。于是 BTC-USD 1d 报告给出 `①57717→64669 ②→61751 ③→65560 ④→62453 ⑤→83778` 这种细碎计数，投影 67298/69404 落在现价下方；而用户按显著转折点数出的 `57717→66924→62210→82283→74887，⑤进行中` 根本没有出场机会。同一段走势，进行中结构树由引擎严格数浪，T4 却只看价格，两处口径冲突。刚完成的 enforce-strict-wave-grammar 已把文法收严，T4 不应再是一个"只看价格"的口子。

## What Changes

- T4 改由树引擎产出：对「已确认极值 spanLast → 摆动极值 ext」这段细枢轴调用 `decompose` 做驱动类拆解，①②③④⑤ 取引擎按显著性枚举、打分后的最优五浪计数；子浪文法与引擎同一套严格校验（沿用 enforce-strict-wave-grammar）。不再固定取 `post[0..3]`。
- ⑤ 定义为 ④终点 → ext，标"⏳进行中"：ext 之后的回撤视为 ⑤ 内部回撤，失效点为 ④终点。依赖 ⑤ 终点、可被 ⑤ 延伸翻转的规则经 `applyInProgressRuleGate` 标为待判，不计入表中违规数（修正原 `breach3`「③ 比 ① 短即违规」的误判）。
- 「⑤ 已在 ext 完成、现为调整」这一状态由现有 T3（新推动·浪②进行中，① = spanLast→ext）承载；T3 的 ① 附上同一引擎五浪子计数作为内部结构说明，T3 的评分口径本次不变。
- ⑤ 投影以 ④终点为基准：⑤ = ①、⑤ = 0.618 ×（① 起点 → ③ 终点）；已被 ext 越过的目标标「已到」，不再出现以细碎 ① 为基准、落在现价逆势一侧的投影。
- 删除 T4 误用的软信号 `leg1Char === 'driving'`（它描述的是整段 spanLast→ext，而非 ①）。
- **BREAKING（结果层面）**：T4 的子计数、投影、失效点和评分全部变化；ext 段不足 6 个细枢轴时不再产出 T4。

**不在本次范围**：放宽「2 浪回撤 ≤ 88.6%」「3 浪 ≤ 4.236 × 1 浪」两条比率规则；对进行中腿做 4h 下钻；把 T1–T3 改为引擎驱动。

## Capabilities

### New Capabilities
<!-- 无 -->

### Modified Capabilities
- `wave-count-tree`：新增「当前进行浪的五浪末浪模板须由计数引擎产出」要求，规定 T4 的选点、⑤ 状态、待判、投影与失效点口径。

## Impact

- 代码：`analyze-wave-tree.js`
  - `buildCurrentWaveStructures`（~L1935）：T4 分支（~L2027）重写；T3 分支追加 ① 子计数；T4 的拆解复用已传入的主树 `options`（含 cache）。
  - `renderCurrentWaveStructures`（~L3154）：T3 行的子计数列显示 ① 内部计数；评分列支持「待判」提示。
- 测试：`tests/analyze-wave-tree.golden.test.js` 中 T4 用例（`reverse-impulse-5`）按新口径改写；`tests/analyze-wave-tree.test.js` 补 T4 选点 / 待判 / 投影单测。
- 报告：轴②表第 T4 行内容变化；其余模板不变。
- 依赖：建议在 enforce-strict-wave-grammar 归档后实施（同改 `wave-count-tree` 规格，且依赖其严格文法）。
