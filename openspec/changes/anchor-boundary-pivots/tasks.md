# Tasks：数浪范围锚定首尾

## 1. 前置
- [ ] 1.1 确认 P1–P4 已实现、36 单测通过

## 2. 实现
- [ ] 2.1 新增 `anchorBoundaryPivots(pivots, candles)`：起点前导极值前置 + 终点延续替换/反转追加，保持交替与幂等
- [ ] 2.2 在 `scanAtDegree` 的枢轴检测后调用 `anchorBoundaryPivots`
- [ ] 2.3 在 `analyze` 生成 `pivotsFine` 后调用 `anchorBoundaryPivots`
- [ ] 2.4 导出 `anchorBoundaryPivots` 供测试

## 3. 测试
- [ ] 3.1 起点：首枢轴为 L、前导有更高高点 → 前置 H 锚点（价格=前导max、index 更早）
- [ ] 3.2 终点延续：末枢轴 L、其后更低低点 → 替换为更低 L
- [ ] 3.3 终点反转：末枢轴 L、其后反弹 → 追加 H
- [ ] 3.4 幂等：极值恰在边界枢轴上 → 不重复
- [ ] 3.5 回归：既有 36 单测全绿

## 4. 真实回归与收尾
- [ ] 4.1 BTC-USD 1d 重跑：断言级别枢轴首元素 = H126296.00@2025-10-06、末元素锚到最近K线
- [ ] 4.2 记录锚定后各级别主选/枢轴数变化（诚实标注）
- [ ] 4.3 `npx openspec validate anchor-boundary-pivots --strict` 通过
