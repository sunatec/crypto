# Design

## Context

动机见 proposal.md 的 Why 一节。md 报告由 `renderMarkdownReport` 组装：开头是简报（`renderBrief`），之后在 `<details>` 内依次输出轴①（数法排名、备选表、`renderHigherDegree`、`renderTopLevelReadings`）、轴②（当前进行浪表、进行腿细化）、轴③（`renderBounceHypotheses`、通道、`renderPullbackTargets`、时间窗），最后是规则树。现有的“主题轴单一权威呈现”要求已经规定点位集中在轴③，但实现上轴①“当前在哪”、轴③“近端看”、轴③“回撤目标位”和进行中结构代码块各自重算并打印了同一组回撤位。

已知 bug：`bounceHypotheses` 在反弹越过末腿起点时把 `xx` 改为按整段 W 度量（`ref: 'whole'`），但 `aftermath` 仍沿用默认的“Z 浪…”。golden 测试里用 `bounceHyp.xx.aftermath = 'Y 浪下跌'` 手工打了补丁。

## Goals / Non-Goals

**Goals**
- 默认 md 大幅缩短（以 BTC-USD 1h 样例为准）。实测：243 → 140 行（非空 98 行），约 21K → 10K 字；初版估计的 80~100 行未达到，见 tasks 6.1。
- 每个价位在 md 中只有一处权威呈现。

**Non-Goals**
- 不改引擎派生、评分和排名（`aftermath` 浪名除外）。
- 不处理“现价越过摆动极值后进行中腿不更新”的问题，由 `track-live-swing-extreme` 另行处理。
- 不改 `structured-wave-report` 那份 7 节报告。

## Decisions

### D1 价位梯子：先收集，再排序去重

新增 `collectPriceLevels(meta, tree, hyps, pullback)`，从已有派生数据中收集 `{price, tags[], scenario}`：轴② 各情景下一腿投影、`bounceHypotheses` 的 targets/down、进行中腿 `fibTargets`、`meta.rangeHigh/rangeLow`、`meta.lastClose`、`invalidation`、通道边界、X 上限（`W.start`，即双锯齿 x < 100% W）。然后按价格降序排列，相邻价差 ≤0.03% 的合并 tags（初版 0.1% 在 7.8 万价位约 78 点，会把 77236.65 吞进 77307.2，实测后收紧），再由 `renderPriceLadder` 输出。

- 选择这种做法：数字来源不变，只是换了呈现方式，“`_tree.json` 不变”的约束天然满足。
- 放弃的做法：在每个渲染函数里各自删掉重复项。原因是去重逻辑会分散在多处，日后容易再次长出重复。

**“已到”的档位**：由 `sign(price - lastClose)` 决定它在现价之上还是之下，不再标“已到”。已越过的目标自然落到现价下方，变成支撑参考。

### D2 大级别背景的默认呈现（实施中修订）

最初按 `SHORT_TFS`（5m/15m/1h/4h）只压缩短周期报告，日线照常全文。实际阅读反馈是日线的这两节同样看不懂（§3.3、级别阶梯、自价格 0 的顶层读法），而对判断有用的只有级别 1 的一条结论。改为：任何主周期的默认 md 都只输出 `renderHigherDegreePlain` 生成的一段大白话，取 `background.ladder[0]` 的前段起止、途中最深回调、窗口幅度和 §3.3 结论，不再输出顶层读法摘要；父级表下的“，顶层：”佐证和 `backgroundSummary` 一句也只在 verbose 下输出。`SHORT_TFS`、`renderHigherDegreeBrief`、`renderTopLevelBrief` 随之删除。

### D3 `--verbose` 作为整体开关

在 `main()` 中解析 `--verbose`，作为 `opts.verbose` 传给 `renderMarkdownReport`。大级别背景与顶层读法按 `opts.verbose` 决定输出全文还是一段大白话。调试块只看 `opts.verbose`。
- 放弃多个细粒度开关（`--background-md`、`--debug-tree`……）：用户只有“平时读”和“排查问题”两种场景。

### D4 Y/Z 修正落在数据层

在 `bounceHypotheses` 的 `ref: 'whole'` 分支中把 `aftermath` 设为 `Y 浪${contCn}`；简报（目前写死的 `'Y'`）改为读取 `aftermath`，保证三处同源。golden 测试里的手工补丁随之删除。

### D5 书页出处移入 JSON

实现时核实：书页出处已随 `currentPullback.narrative.axis2Roles[].refs` 序列化，无需新增字段。md 渲染时 `renderAxis2Roles` 以 `refs` 开关不输出，`narrative.text`（JSON）保持原样。

## Risks / Trade-offs

- [已有测试断言旧 md 文本，改版后会大面积失败] → 每组任务同时更新本组相关的断言；断言改为按小节匹配关键语义，不做整串比对。
- [价位合并阈值 0.03% 可能把含义不同的档位合在一起] → 合并后 tags 全部保留并逐一列出，不丢信息；阈值做成常量，便于调整。
- [大白话丢掉了背景细节] → 全文仍在 JSON 中，`--verbose` 可恢复。

## Migration Plan

纯呈现层改动，无数据迁移。回滚只需 revert 本变更的提交。旧版式可以随时用 `--verbose` 取得。

## Open Questions

（无）
