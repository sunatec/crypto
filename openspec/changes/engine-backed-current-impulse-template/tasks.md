## 1. 前置与基线

- [ ] 1.1 确认 enforce-strict-wave-grammar 已归档（同改 `wave-count-tree` 规格，且依赖其严格文法）
- [ ] 1.2 记录基线：BTC-USD / ZRO-USD / MU 三个缓存样本的 T3、T4 行（子计数、投影、失效点、评分）与 buildCountTree 耗时

## 2. 测试先行

- [ ] 2.1 单测：合成一段 spanLast→ext，使前 4 个细枢轴为细碎摆动、显著五浪另有其点 → T4 ①②③④ 等于引擎 primary 点位（先失败）
- [ ] 2.2 单测：五浪违反「3 浪不最短」且 ⑤ 延伸可改善 → 列入 deferred、不计入 T4 tier1；① 只能读成单锯齿 → 文法违规照计
- [ ] 2.3 单测：投影均在 ④终点顺势侧；≤ ext 的投影标 reached；段内细枢轴 < 6 不产出 T4
- [ ] 2.4 单测：T3 带 `leg1Subcount`，且不存在「5 浪已完成」独立模板

## 3. 实现

- [ ] 3.1 T4 分支重写：对 spanLast→ext 细枢轴 `decompose(…, [DRIVING], 0, options)`，取 primary；< 6 点不产出；按形态定标签（推动浪 / 楔形）
- [ ] 3.2 ⑤ = ④终点→ext 进行中；`applyInProgressRuleGate` 标待判，T4 `tier1` = 引擎 tier1 − 暂缓数，`deferred` 合并暂缓规则描述；删除 `breach2/3/4` 与 `leg1Char` 软信号
- [ ] 3.3 失效点 = ④终点；投影 ⑤=①、⑤=0.618×(①起→③终)，以 ④终点为基准，标 `reached`
- [ ] 3.4 T3 附 `leg1Subcount`（点位、形态标签、违规数），评分不变
- [ ] 3.5 `renderCurrentWaveStructures`：T3 子计数列显示 ① 内部五浪；投影列对 reached 标「（已到）」；评分列在有待判时附「待判×N」

## 4. 验证

- [ ] 4.1 全量测试通过；golden T4 用例按新口径改写（保留「⑤进行中、失效点=④终点、投影在 ④终点顺势侧、T3/T4 label 不同都保留」不变量）
- [ ] 4.2 重跑三个样本，对比 1.2 基线：记录 T4 子计数与评分变化、耗时；BTC 的 T4 不再出现 62453→… 细碎计数与低于现价的投影
- [ ] 4.3 生成 BTC 报告人工检查轴② 表，把结果写进本文件末尾的验收记录
