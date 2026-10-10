# Proposal

## Why

子腿验证在 4h/1h 上拆不出合法楔形，是因为搜索把它漏掉了，而不是规则不允许。以用户数法 57717.55→66923.95→62209.81→82283→74887.5→87397 的浪 1（57717.55→66923.95）为例：4h 窗口有 38 个枢轴，交替排列的 6 点读法 4845 种，其中 39 种满足引导楔形全部价格规则（含「4 浪可切入 1 浪」）；但 `segmentations()` 只取最显著的 12 个枢轴、组合上限 60，这 39 种全不在其中，引擎只剩 `impulse-strict`，带一条「4 浪切入 1 浪」违规，整条数法被判 invalid。楔形的 3、4、5 浪是小幅收敛摆动，恰好被「显著性」筛掉。上一个变更（cascade-subwave-verification-timeframes）已把 4h 接入周期链，但其 design 明确不调整搜索参数，这个漏判只能另开变更解决。

## What Changes

- 新增楔形专用候选枚举：当某次 `decompose` 允许的形态含引导楔形或终结楔形，且启用该枚举时，除了现有的显著性短名单切分外，再按价格几何直接枚举 6 点楔形读法，先用便宜的价格条件预筛，再走原有基础打分，只保留价格规则全过（tier1 为 0）的读法，并设数量上限后并入候选前沿。
- 只在子周期验证器里启用，且只用于 4h 档；主图 `decompose` 与 `--count` 的主周期路径行为不变。
- 枢轴过多的窗口（如 1h 的 180 个）不枚举，沿用现有搜索并保持 `searchLimited`，防止组合爆炸。
- 证据 `attempts` 记录楔形枚举的考察数、保留数以及是否因枢轴过多跳过。
- 不改变角色判定、违规撤销口径（仍只认 verified）和排名规则。
- **BREAKING**（输出）：部分腿在 4h 由 `impulse-strict` 变为 `diagonal-leading`，状态可能从 pending 变为 verified；主计数与指定数法排名可能随之变化。

## Capabilities

### New Capabilities
- `diagonal-candidate-enumeration`: 子周期验证中楔形（引导/终结）候选的专用枚举、预筛条件、数量上限、枢轴过多时的跳过规则及证据记录。

### Modified Capabilities
（无。`openspec/specs/` 下没有子腿验证相关的主规格；相关约定位于未归档的 cascade-subwave-verification-timeframes、verify-subwaves-across-timeframes 变更中，本变更以新能力记录，并在 design.md 说明与上一变更「不调整搜索参数」非目标的关系。）

## Impact

- 代码：`analyze-wave-tree.js` 的 `decompose`（候选前沿合并处）与新增的楔形枚举函数；`wave-subwave-verification.js` 的 4h 档 `decompose` 调用传入开关。
- 测试：以本次 4h 窗口构造固定回归用例；`tests/wave-subwave-verification.test.js` 新增楔形读法用例；全量测试需重跑，golden 变化逐条核对。
- 文档：README `--verify-tf` 说明补充楔形枚举与枢轴数上限。
- 性能：默认 BTC 1d 命令基线 113.6s，上一变更后 132.6s；本变更完成后不得超过 170s，且不 OOM。
- 无新依赖、无新增网络请求。
