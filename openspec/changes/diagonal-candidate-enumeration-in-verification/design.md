# Design

## Context

- `decompose` 对每个允许形态调用 `segmentations(segFine, pat.points)` 取切分。`segmentations` 只考虑 `significantShortlist` 选出的最显著 12 个内部枢轴（`SEG_SHORTLIST_M`），组合数再截到 60（`SEG_MAX_COMBOS`），外加一条贪心坍缩结果。结果再进入「基础分 → 前沿筛选（`preRankKeep`）→ 展开子树」。
- 实测：浪 1（57717.55→66923.95）的 4h 窗口 38 个枢轴，交替 6 点读法 4845 种，其中 39 种楔形价格规则全过，11 种的 5 条子腿都有 ≥4 个枢轴；而 `segmentations(…, 6)` 返回的 48 种读法里没有一种是合格楔形。
- 子周期验证器在 `wave-subwave-verification.js` 里对每档调用 `decompose(fine, candles, [role], 0, {…})`，depth 恒为 0；`atResolutionBoundary` 要求 depth≥1，因此 depth 0 的候选要想 verified，其直接子腿必须各自成形（点数不足的子腿为叶子，状态 pending）。
- 前一变更 cascade-subwave-verification-timeframes 已让 4h 成为周期链的一档，并在 design 里把「不调整搜索参数」列为非目标；本变更正是处理那个遗留的搜索覆盖问题，但只针对楔形，不改全局参数。
- `decompose` 的 `lite` 缓存键为 `lite|起点索引|终点索引|形态 id`，节点缓存键含 `opts` 的若干字段；新开关必须进入这两个键。

## Goals / Non-Goals

**Goals:**
- 4h 验证窗口内，价格规则全过的楔形读法不会因枢轴显著性被漏掉。
- 影响面限定在子周期验证器的 4h 档、depth 0、含楔形的角色。
- 耗时可控：默认 BTC 1d 命令不超过 170s，不 OOM。

**Non-Goals:**
- 不调整 `SEG_SHORTLIST_M`、`SEG_MAX_COMBOS`、`beamK` 等全局搜索参数。
- 不改主图 `decompose`、`--count` 主周期路径，不改违规撤销口径与排名规则。
- 不解决 1h 档的枢轴过多问题（1h 窗口超过上限即跳过）。
- 不对推动浪、调整浪做同类专用枚举（本次只证明楔形这一类漏判）。
- 不保证枚举后该腿一定 verified：选中读法的子腿点数不足时仍是 pending，这是现有 verified 口径，不改。

## Decisions

1. **新增 `diagonalSegmentations`，并入 `lite` 候选，而不是替换 `segmentations`**。仅当 `pat.id` 为 `diagonal-leading`、`diagonal-ending`、`diagonal-ending-expanding`，且 `depth===0 && opts.diagonalEnumeration`，且内部枢轴数 ≤ `DIAG_ENUM_MAX_PIVOTS`（暂定 60）时调用；其结果与原切分按点索引去重后合并。
   - 备选 A：全局放大 `SEG_SHORTLIST_M`。放弃：所有形态、所有调用都变慢，golden 全面漂移，且 38 个枢轴要取到 ≥30 才能覆盖，组合量级不可控。
   - 备选 B：按角色放大短名单。放弃：仍依赖显著性，楔形的小幅摆动在放大后依然可能被排在外面，没有对症。
   - 备选 C：只在验证器里放大短名单。放弃：同 B，且会连带推动浪、调整浪的组合数。

2. **枚举方式：深度优先，逐点预筛，再走既有打分**。按 `seqOf(direction, pat.points)` 逐个选 4 个内部枢轴，保持类型交替和索引递增，选择过程中用普适价格条件剪枝：2 浪终点不越过 0 点；3 浪终点越过 1 浪终点；4 浪终点不越过 3 浪起点（即回撤小于 3 浪的 100%）。不在预筛里写楔形专有判断（收敛、4 浪切入 1 浪与否等），这些由形态自己的规则集在 `scoreCandidate` 中判定，避免预筛与规则不一致。对通过预筛的读法沿用现有 `computeMeasures`/`scoreCandidate`/`applyInProgressRuleGate`/`legsRespectOrigin`/`macroAlternates` 路径得到基础分，只保留 `tier1===0`。
   - 备选：在预筛里加入收敛几何（边界收敛、3>5 等）。放弃：展开顺序依赖形态变体（引导/终结/扩散），重复实现规则，易与书中规则分叉。

3. **数量上限与确定性**。保留数 `DIAG_ENUM_KEEP`（暂定 12），按 `compareCandidates`（沿用 `lite` 排序所用口径）排序，平票用点索引串字典序打破，保证结果可复现。
   - 备选：不设上限。放弃：楔形读法可能有数百种，会把 `preRankKeep` 前沿挤满，拖慢子树展开。

4. **枢轴过多时跳过并保持受限**。内部枢轴超过 60 时不枚举，`attempt` 记录 `diagonalEnumeration.skipped=true`，`searchLimited` 沿用现有口径（枢轴>8 即受限）。因此 1h 窗口（如 180 个枢轴）行为不变。
   - 备选：对大窗口先按枢轴显著性或时间切块再枚举。放弃：块边界会切断楔形，且复杂度上升，留待后续。

5. **开关只由验证器在 4h 档、depth 0 传入**：`diagonalEnumeration: tf === '4h'`。开关纳入 `lite` 缓存键与节点缓存键。子腿递归（depth≥1）不枚举。
   - 备选：所有档、所有深度。放弃：1h 会爆炸；深层楔形（如推动浪的 3 浪里的楔形）收益不明，成本不可控。

6. **证据记录**：4h 的 `attempt` 新增 `diagonalEnumeration:{considered,kept,skipped}`；不新增状态，不改 `verificationScope` 口径（4h 截止仍标 4h）。

7. **清除端点钉死后残留的 `provisional` 标记（实施中发现）**。验证器 `prepare` 先对 4h 序列做 `anchorBoundaryExtremes`，其末位原始枢轴被标为 `provisional`/`boundary:'end'`（序列末端尚未确认），随后用手工 `finish` 钉死窗口终点，但并没有清掉那个原始末枢轴的标记。`atResolutionBoundary` 遇到含 `provisional` 点的腿就返回 false，所以窗口最后一条腿永远过不了分辨率边界，depth 0 候选的 `pendingRoles` 恒 ≥1，无法 verified。实测：wave-1 夹具里 `L65006.94@119` 就是这样的残留；枚举出 `diagonal-leading`（0 违规）后仍是 pending，清除标记后同一候选变为 verified。该问题对 4h 与 1h 档、所有角色都存在，不限于楔形，因此本变更把它作为必要前置修复，并在集成验证里单独核对影响。
   - 备选：只对楔形角色放宽 `atResolutionBoundary`。放弃：标记本身已过期，在边界判断里打补丁会掩盖真正原因。

## Risks / Trade-offs

- [误放行：楔形比推动浪宽松] → 保留条件是价格规则全过，且由形态自带规则集判定；预筛只用普适条件；用「无收敛几何的小幅震荡」作反例测试，必须不产出楔形候选。
- [耗时上升] → 仅 4h、depth 0、枢轴≤60；每个窗口 DFS 受预筛剪枝；实施后对比基线（113.6s）与上一变更后（132.6s），上限 170s，超标则下调 `DIAG_ENUM_MAX_PIVOTS` 或 `DIAG_ENUM_KEEP`。
- [排名漂移：更多日线违规被 4h 的楔形 verified 撤销，主选可能换人] → 预期行为；每个 golden 变化逐条核对原因，不能直接改期望值。
- [决策 7 的前置修复会让所有窗口的末腿都能到达分辨率边界，更多腿从 pending 变 verified，影响面大于楔形枚举本身] → 作为单独任务（3.1/3.2）落地并逐条核对既有测试与默认命令的变化；若主选或违规数出现意外变化，先回退决策 7 对照。
- [找到楔形但仍 pending：子腿点数不足以成形（实测 39 种合格读法中 11 种所有子腿 ≥4 点）] → 排序已偏好证据更完整者（pendingRatio），但不保证；验收只要求选中楔形且 0 违规，状态按实际记录，不人为拔高。
- [证据变浅：楔形在 4h 截止，不再检查 1h 内部] → `verificationScope` 与理由标明 4h；父级范围取最粗档（前一变更已实现）。
- [枢轴上限 60 是工程取值，不是书中标准] → 写入 README 与证据 `skipped` 标记，需要时再调。

## Migration Plan

纯本地 CLI 改动，无数据迁移。回滚：去掉验证器传入的 `diagonalEnumeration` 开关即恢复现有行为（`decompose` 默认不启用）。

## Open Questions

- `DIAG_ENUM_MAX_PIVOTS=60` 与 `DIAG_ENUM_KEEP=12` 的最终取值，待实施后按 4h 窗口枢轴数分布和耗时数据确认，不影响规格。
