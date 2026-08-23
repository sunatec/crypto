# 任务：顶层末浪未走完的表达（框架B逆势修复 + 框架A完成度软化）

> 前置：`rank-competing-wave-counts` 已交付。仅改 `analyze-wave-tree.js`。

## 1. 框架B 终点处理（核心，探索选项②）✅

- [x] 1.1 `buildCountTree` 里判定：朴素框架B（`decompose` 到 now）返回空（`!primary`）即视为
      逆势触发；`buildCounterTrendFrameworkB` 内再校验 `now.type !== 末点type` 且 `now` 越过末点。
- [x] 1.2 逆势时复用框架A（`tree.primary` + 前几族 `alternates`），宏观骨架不变、末点仍是全局极值。
- [x] 1.3 对复用的候选打 `finalWaveInProgress` 标记 + `projection`（末浪延伸投影）。
      **实现取舍**：投影用「末腿幅度的 0.382/0.618/1.0 倍从全局极值继续」的简单口径，未接
      `inProgressStruct` 的 a/b/c 拆解——后者是"极值之后反弹"的拆解，与"末浪延伸投影"口径不同，
      强接反而绕；简单投影已够表达"跌破极值后看哪"。未完成度=当前逆势回撤占末腿的比例
      （回撤越深→"末浪还在延伸"越不可能→惩罚越大）。
- [x] 1.4 逆势框架B 结果作为 `tree.frameworkB`（同朴素B 结构），`buildRankedCounts` 原样消费；
      `finalWaveInProgress`/`projection`/`invalidation` 透传到排名条目。
      **实现取舍**：复用框架A 的 primary + 前3族 alternates（非只 primary），使 ⏳B末浪 能覆盖
      多种形态（单锯齿/推动/联合形…），但不整表复制。因 tier1 优先于 incompleteness，逆势B
      的零违规候选自然排在框架A 零违规族之后、违规族之前，RANKED_MAX=8 内可见。
- [x] 1.5 顺势新极值（now=L 且与末点同型）时不触发逆势路径，仍走朴素框架B——已加专门单测。

## 2. 框架A 完成度软化（探索选项①）✅

- [x] 2.1 框架A 排名条目由"✅已完成"改为"✅ 完成（待确认）：末浪终结于全局极值 X；若跌破/升破 X
      则末浪可能延伸、见框架B 读法"（`renderRankedCounts` 的 `framingLine`）。
- [x] 2.2 逆势框架B 的末浪延伸投影标注"（推断）"，并给失效点（重回极值另一侧则视为末浪完成）。
- [x] 2.3 在框架B 末浪投影行下补一句，明确它（顶层数法轴）与「结论」节的 XX/B 反弹身份
      （反弹在更大结构里是什么这一轴）是"同一看跌可能的两种框架表述，互为印证、非重复"。

## 3. 验证 ✅

- [x] 3.1 逆势反弹现场（BTC 1d，现价反弹到 79500 附近、now=H、净向下）：框架B 不再空，
      排名表出现 ⏳B末浪 行——单锯齿/推动浪的末腿标"⏳延伸中"、未完成度 54%、投影新低
      42344/32845/17471。直接兑现用户"现在是 Y 浪、还没走完"的诉求。
- [x] 3.2 顺势新极值现场（BTC 1h，now=L 顺势）：框架B 仍走朴素路径产"⏳B"顺势延伸读法（不回归）。
- [x] 3.3 单测：`node --test tests/` 84/84 全绿（金标准 10 条不破 + 新增 2 条逆势末浪测试：
      逆势反弹处框架B 非空且末点=全局极值、投影在极值下方、带未完成度；顺势新极值不误触发逆势）。
- [x] 3.4 1d/1h 两周期端到端无 undefined/NaN，用时约 5.3s（含网络）。
- [x] 3.5 脚本内注释：`buildCounterTrendFrameworkB`、`buildCountTree` 框架B 分支、`candidateLegs`
      三态末腿、`framingLine` 均已就地注明逆势末浪语义。
