# 任务：宏观腿端点须为跨度内真极值

> 仅改 `analyze-wave-tree.js`。

## 1. 实现

- [x] 1.1 新增 `legEndpointsSpanExtreme(pts, segFine)`：每个内部宏观点须为其
      `(pts[i-1].index, pts[i+1].index)` 窗口内所有 segFine 细枢轴的真极值（H 严格最高 / L 严格最低）。
- [x] 1.2 在 `decompose` 候选校验处，`macroAlternates` 之后加 `legEndpointsSpanExtreme` 硬淘汰。

## 2. 验证

- [x] 2.1 "现在走到哪了"上冲段 a 段端点落在真极值（取 66924 或更高，不再是 65705）。
- [x] 2.2 单测：端点非跨度极值（内部有更高高点）→ false；端点即极值 → true；收缩三角样例 → true。
- [x] 2.3 金标准 10 条不破；`node --test tests/` 全绿。
- [x] 2.4 1d/1h 两周期端到端无 undefined/NaN、性能正常；排名重排都来自"端点非极值退化骨架被淘汰"。
- [x] 2.5 更新脚本内注释。

## 实现说明
- `legEndpointsSpanExtreme(pts, segFine)` 与 `macroAlternates` 并列放在 `decompose` 候选校验处
  （`macroAlternates` 快筛先跑）；同函数已导出供单测。
- **金标准回归发现并修正**：本校验揭示 rank-competing-wave-counts 一度找到的"零违规单锯齿
  126296→84400→…"是几何伪清白（a 段内藏更低的 80524，84400 非真极值），被正确淘汰；金标准
  遂回到"无零违规、优雅降级 penalized"（与最初发现一致）。已更新该 golden 断言。
- 实测："现在走到哪了"上冲段首腿现取真极值 **66923.95**（原误取 65705）；结构读成双锯齿 w-x-y。
- 88/88 测试全绿（新增 legEndpointsSpanExtreme 单测 + 更新 golden）。1d/1h 端到端无异常。
