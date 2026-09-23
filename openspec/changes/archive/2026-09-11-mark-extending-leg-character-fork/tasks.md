# 任务：进行中末腿"两可"性格分叉的保留与标注（粒度2）

> 前置：`gate-extending-final-leg-rules` 已交付。仅改 `analyze-wave-tree.js`，只加标注、不改计数与排名。

## 1. 末端成形链定位 + 两可检测

- [x] 1.1 实现"沿末端成形链下探"：从 `finalWaveInProgress` 候选的宏观末腿起，每层取"终结于全局
      极值一侧"的子节点，逐层下探；记录经过的腿及其 depth。（`annotateExtendingLegForks` 内的
      `while` 循环，简化为"每层取最后一条子腿"——W-X-Y/1-2-3-4-5 等顺序型态下末腿天然终结于
      候选自身的全局极值终点，等价于设计稿描述的"终结于全局极值一侧"判据。）
- [x] 1.2 对链上 depth≥1 的每条腿，取其细枢轴段，调 `legCharacter`（复用，已返回 drivingNode/correctiveNode
      与 canDrive/canCorrect）；判定两可 = `canDrive && canCorrect`。

## 2. 保留对侧性格代表 + 标注

- [x] 2.1 实现 `annotateExtendingLegForks(candidate, candles, opts)`：post-hoc，仅
      `finalWaveInProgress` 候选；找到**最浅的两可腿**，取其对侧性格代表（未被采用的 drivingNode/
      correctiveNode 的 primary），挂 `candidate.altCharacter = { character, label, points, ... }`
      （挂在候选顶层而非深层 node 上——`buildRankedCounts` 只读候选顶层，深层 node 无渲染路径读取，
      挂顶层才能"透传到排名条目"，见 2.2）；更深两可腿只在渲染文案里提一句"存在"，不逐层展开。
- [x] 2.2 在 `buildCountTree` 内 `buildCounterTrendFrameworkB` 建好候选后调用一次（对 primary 与
      每条 alternates）；`buildRankedCounts` 把 `altCharacter` 透传到排名条目。

## 3. 渲染（粒度2 + 对侧读法点位展开）

- [x] 3.1 报告在该腿处（或框架B 末浪说明行附近）加一句"两可：现取 X，也可读作 Y（零违规）；
      改此性格则顶层换族。（更深子腿亦可能两可。）"。
- [x] 3.2 紧接着加一行对侧读法自身的点位序列（价格+日期，`altCharacter.points`，逐点用 `→` 连接，
      沿用既有 `fmtTs`/`price` 渲染惯例），不新增计算，不递归下钻对侧读法内部找新分叉（粒度3）。
- [x] 3.3 `_tree.json` 对应节点加 `altCharacter` 字段（含 `points`，md/json 同源，经 `serializeRankedCounts`）。
- [x] 3.4 不罗列同性格近似形态；不改选中计数、排名、违规/待判的任何渲染。

## 4. 校验

- [x] 4.1 单测（金标准）：框架B 末浪候选的最浅两可末腿（82814→57718 一类）带 `altCharacter`，
      对侧性格=driving、形态=推动浪，且 `altCharacter.points` 与 `lc.drivingNode.primary.points` 一致。
      （`tests/analyze-wave-tree.golden.test.js`："备选1双锯齿的末端两可腿(82814→57718)带
      altCharacter..." + md 渲染含两可提示/点位序列两条）
- [x] 4.2 单测：非两可腿不带 `altCharacter`；depth 0 顶层腿不标。
      （`tests/analyze-wave-tree.test.js`：新增 3 条 `annotateExtendingLegForks` 单测——仅canCorrect
      不标、depth0两可也不标(与depth1对照)、非finalWaveInProgress原样返回）
- [x] 4.3 回归单测（金标准快照）：加标注前后，顶层选中计数、排名顺序、各候选 tier1/违规/待判**完全不变**。
      （复用既有金标准断言 + 新增"altCharacter 标注不改变选中的计数与排名"一条；全部原有107条金标准/端到端测试原样通过）
- [x] 4.4 全量测试通过（5 个测试文件，113/113）。
- [x] 4.5 `openspec validate mark-extending-leg-character-fork --strict` 通过。
