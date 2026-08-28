# 任务：进行中末腿"两可"性格分叉的保留与标注（粒度2）

> 前置：`gate-extending-final-leg-rules` 已交付。仅改 `analyze-wave-tree.js`，只加标注、不改计数与排名。

## 1. 末端成形链定位 + 两可检测

- [ ] 1.1 实现"沿末端成形链下探"：从 `finalWaveInProgress` 候选的宏观末腿起，每层取"终结于全局
      极值一侧"的子节点，逐层下探；记录经过的腿及其 depth。
- [ ] 1.2 对链上 depth≥1 的每条腿，取其细枢轴段，调 `legCharacter`（复用，已返回 drivingNode/correctiveNode
      与 canDrive/canCorrect）；判定两可 = `canDrive && canCorrect`。

## 2. 保留对侧性格代表 + 标注

- [ ] 2.1 实现 `annotateExtendingLegForks(candidate, finePivots, candles, opts)`：post-hoc，仅
      `finalWaveInProgress` 候选；找到**最浅的两可腿**，取其对侧性格代表（未被采用的 drivingNode/
      correctiveNode 的 primary），挂 `node.altCharacter = { character, label, points }`；更深两可腿
      置一个"存在更深两可"的标志（不逐层展开）。
- [ ] 2.2 在 `buildCounterTrendFrameworkB` 建好候选后（或 `buildRankedCounts` 映射框架B 末浪候选时）
      调用一次；`altCharacter` 透传到排名条目。

## 3. 渲染（粒度2）

- [ ] 3.1 报告在该腿处（或框架B 末浪说明行附近）加一句"两可：现取 X，也可读作 Y（零违规）；
      改此性格则顶层换族。（更深子腿亦可能两可。）"。
- [ ] 3.2 `_tree.json` 对应节点加 `altCharacter` 字段（md/json 同源）。
- [ ] 3.3 不罗列同性格近似形态；不改选中计数、排名、违规/待判的任何渲染。

## 4. 校验

- [ ] 4.1 单测（金标准）：框架B 末浪候选的最浅两可末腿（82814→57718 一类）带 `altCharacter`，
      对侧性格=driving、形态=推动浪。
- [ ] 4.2 单测：非两可腿不带 `altCharacter`；depth 0 顶层腿不标。
- [ ] 4.3 回归单测（金标准快照）：加标注前后，顶层选中计数、排名顺序、各候选 tier1/违规/待判**完全不变**。
- [ ] 4.4 全量测试通过（5 个测试文件）。
- [ ] 4.5 `openspec validate mark-extending-leg-character-fork --strict` 通过。
