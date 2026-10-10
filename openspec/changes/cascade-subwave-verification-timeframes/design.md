# Design

## Context

- `wave-subwave-verification.js` 的 `evaluate()` 当前用 `lowerFrames = [finestTf]`：日线/周线腿直接在最细周期验证，4h 不跑。这是 commit 94d98c3（fix-book-audit-p1 任务 4.4）为解决全年 1h 验证 OOM 做的取舍，理由是非最细周期不是分辨率边界，结果必然 pending、invalid 也不终止，所以 4h 对结论没有贡献。
- 分辨率边界由 `atResolutionBoundary()` 判定，只在 `opts.timeframe === opts.finestResolution` 时成立。验证器给每档 `decompose` 传 `finestResolution: tf===finestTf ? finestTf : null`，所以非最细档永远给不出 verified。
- 验证器内部 `decompose` 不带 `verification`：某档上的子腿只在该档判定，不会再嵌套下钻。
- `evaluateLegRole()` 只要本周期证据不是 verified 就调用验证器，违规腿和 pending 腿都会调用；只有 `lowerProof === 'verified'` 才撤销本周期违规（book-p1 规格，保持不变）。
- 4h K 线由同一份小时行情经 `transformCandles(window, TIMEFRAMES['4h'])` 聚合；Coinbase 接口粒度只有 60/300/900/3600/21600/86400。
- 父候选的 `verificationScope.finestTimeframe` 取子证据中第一个 bounded 范围（`.find`），报告据此写「验证范围截至X」。

## Goals / Non-Goals

**Goals:**
- 周期链逐档验证，首个拆得出的档截止（规则见 specs/subwave-verification-cascade）。
- 截止档成为该腿的分辨率边界，可以产出 verified。
- 证据和报告能区分截至 4h 与截至 1h。

**Non-Goals:**
- 不做逐子腿嵌套下钻（某档内一条子腿不胜任时，不把这条子腿单独送到更细档）。
- 不引入原生 6h 或其他周期，不新增网络请求。
- 不改变 book-p1 的违规撤销口径（仍只认 verified）。
- 不调整 beamK、maxDepth 等搜索参数（性能超标时另议）。

## Decisions

1. **周期链**：固定顺序 `['4h','1h']`，取比 `sourceTf` 细、且不细于 `finestTf` 的部分。1d/1w → `['4h','1h']`（`finestTf=4h` 时为 `['4h']`），4h → `['1h']`，1h → `[]`。1w 不插 1d：日线是独立主周期，而验证器只持有小时行情。
   - 备选：1w → 1d → 4h → 1h。放弃，原因是需要从小时行情合成日线，长窗口开销大，收益不明。

2. **每档都当作临时分辨率边界**：该档的 `decompose` 传 `finestResolution: tf`。这样该档拆出规则全过、子腿胜任的结构时，`scopedVerification` 会返回 verified，即截止。
   - 备选：保持只有最细档是边界、4h 只做筛选（4h 干净就记 pending 并撤销违规）。放弃，原因是用户选择 4h 截止即 verified（访谈 Q1-A）；而且撤销违规需要 verified，pending 无法撤销。

3. **各档结论与流转**：沿用现有状态计算（`!best → pending`；干净时取 `best.score.verificationStatus`；不干净时搜索受限为 pending、完整搜索为 invalid）。
   - verified：截止，记录 `verificationScope`（`finestTimeframe` 为该档）与理由「所需角色及直接子结构已在 {档} 验证（逐级截止）；更细周期未检查」。
   - 其他结论：记入 `attempts`，继续下一档。
   - 最细档 invalid 时整体为 invalid；最细档其他结论时整体为 pending（理由不变）。

4. **采用节点**：`adoptedNode` 取截止档的拆解；没有档截止时，取最后一个实际尝试档的拆解（与现状一致）。

5. **父级验证范围取最粗档**：父候选汇总子证据的 bounded 范围时，`finestTimeframe` 取所有子范围中最粗的一档，不再取第一个找到的。这样只要有一条腿只证到 4h，报告就写「验证范围截至4小时线」，不会夸大成 1h。逐腿截止档在证据 `attempts` 和理由中可见。
   - 备选：报告列出各腿各自的截止档。放弃，原因是父级汇总只需一个保守结论，逐腿细节已经在「子浪验证证据」里。

6. **缓存**：`memo` 键已含 `finestTf` 和 role，`prepared` 键已含 tf，无需改动。4h 的 `prepared` 条目会被同窗口的多个角色查询复用。

## Risks / Trade-offs

- [证据变浅：4h 截止的腿不再检查 1h 内部] → 截止档写进 `verificationScope` 与理由，父级范围取最粗档，报告不会表述成验证至 1h。
- [耗时上升：4h 现在每次都跑] → 1h 只在 4h 未截止时跑，可能抵消部分开销。实施后对比默认 BTC 1d 命令计时，上限为现状的 1.5 倍且不 OOM；超标时先查 4h 截止率和 prepared 命中率，再考虑放宽 `PREPARED_MAX` 或调整 beam，届时另开变更。
- [排名变化：更多日线违规被 4h verified 撤销，主选可能换人] → 这是预期行为。golden/回归测试中受影响的断言需逐条核对原因，不能直接改期望值。
- [4h 窗口过短，端点在同一根 4h K 线内] → 沿用现有处理：该档记 pending（事件顺序不明）后继续 1h。

## Migration Plan

纯本地 CLI 改动，无数据迁移。回滚方式是还原 `wave-subwave-verification.js` 的周期链和边界设置；`--verify-tf 4h` 现有行为不变，可作为临时对照。

## Open Questions

- 截止档的分布（多少腿在 4h 截止、多少落到 1h）实施后再统计，只用于性能分析，不影响规格。
