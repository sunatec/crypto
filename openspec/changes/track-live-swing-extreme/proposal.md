# Proposal

## Why

已有要求（`pullback-anchored-to-axis2` 中的“分级失效线与回撤结束的判断”）规定：价格越过摆动高点时，轴② 改以新高为摆动极值重新研判，视为上冲在延伸。但引擎的 `buildInProgressStructure` 只从已确认枢轴里挑摆动极值。最后一个确认枢轴之后、尚未确认的 K 线即使创了新高，也不会被纳入。

实例：BTC-USD 1h，生成于 2026-11-04 17:39，现价 78462，已越过摆动极值 78164。但 `inProgressTree.swingExtreme` 仍是 78164，`currentPullback` 仍是 78164→77748.09。于是轴② 写“b 腿 / 浪② 进行中”，轴③ 给出这条腿的回撤位，进行腿细化里还算出“已超出常见时间窗”。只有简报靠 `lastClose` 打补丁，写了一句“回调或已结束”，正文与简报因此自相矛盾。

## What Changes

- 进行中结构的摆动极值改为：已确认枢轴，加上最后一个确认枢轴之后的边界极值（provisional），两者取更极端的一个。越过时，摆动极值标为 provisional。
- 摆动极值改为 provisional 新高后：原先的回撤段（78164→77748.09）归入上冲段内部，作为它的子浪；`currentPullback` 在新极值之后没有回撤枢轴时为 null；回撤位（0.382/0.5/0.618）、轴② 各情景的下一腿投影、X 已回撤 W 的比例，都以新极值重新计算。
- 轴② 的当前腿改写为“a / 浪① 延伸中（⏳）”，不再出现“b 腿 / 浪② 进行中”。
- 失效位保持为反弹起点（75736.38）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `wave-count-tree`：进行中结构的摆动极值须纳入未确认的边界极值；越过后，轴② 当前腿和回撤派生随之更新。

## Impact

- 代码：`analyze-wave-tree.js` 的 `buildInProgressStructure`，以及在它之前过滤 provisional 边界枢轴的环节（具体位置待在任务 1.1 中查明：`anchorBoundaryExtremes` 会补上 `boundary: 'end'` 的 provisional 枢轴，但它没能传到 `buildInProgressStructure`）；依赖 `swingExtreme` 的派生函数（`enrichCurrentPullback`、`bounceHypotheses` 的 `swingExtremePrice`、`buildCurrentWaveStructures`）。
- 数据：`_tree.json` 中 `inProgressTree.swingExtreme` 新增 `provisional` 标记；越过时 `currentPullback` 可能为 null。这两项都会改变数值，属于预期内的变化。
- 依赖：与 `slim-wave-tree-report` 互不依赖，两者都改轴②/③ 的渲染，建议先合入 `slim-wave-tree-report`。
