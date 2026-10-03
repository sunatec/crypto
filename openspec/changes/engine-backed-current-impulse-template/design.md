## Context

`buildCurrentWaveStructures`（analyze-wave-tree.js ~L1935）给当前进行浪段（已确认极值 `spanLast` → 摆动极值 `ext` → 最新细枢轴 `now`）枚举一组模板：

```
T1 续行 ③进行中：  ①=prior→spanLast  ②=spanLast→ext  ③=ext→now
T2 X/B 中继：      a=spanLast→ext    b=ext→now       c=未走
T3 转势 ②进行中：  ①=spanLast→ext    ②=ext→now       ③=未走
T4 ⑤进行中：       ①②③④ = post[0..3]（spanLast 之后最先出现的 4 个细枢轴），⑤ = post[3]→now
```

T1–T3 都以整条 spanLast→ext 为一浪；只有 T4 深入到细枢轴，且实现有以下缺陷：

1. **选点**：固定取 `post[0..3]`，不按显著性挑转折点、不枚举组合。
2. **⑤ 状态**：⑤ 画到 now，把 ext 吞进 ⑤，无法区分「⑤ 仍在进行」与「⑤ 已在 ext 完成」。
3. **投影**：以细碎的 ① 为基准，BTC 案例投影 67298 / 69404 落在现价下方。
4. **规则**：`breach3` 写成「③ 比 ① 短即违规」，而规则是「③ 不是 ①③⑤ 中最短」，⑤ 未走完时应待判；①③ 内部是否五浪完全不查。
5. **软信号**：`soft: leg1Char === 'driving'` 描述的是整段 spanLast→ext，不是 T4 的 ①。
6. **口径冲突**：进行中结构树（`inProgressStruct.upTree`）对同一段由引擎严格数浪，T4 只看价格。

用户选择「方向 2」：T4 改由树引擎产出，与全引擎同一套严格标准。

## Goals / Non-Goals

**Goals:**
- T4 的五浪计数由 `decompose` 在 spanLast→ext 段上选出（显著性枚举 + 规则 + 严格文法）。
- ⑤ 明确定义为 ④终点 → ext、进行中；依赖 ⑤ 终点的规则走可判定性闸门标待判。
- 投影、失效点口径修正；删除错位的软信号。
- 「⑤ 已完成」状态不新增模板，由 T3 承载，并让 T3 显示 ① 的内部五浪计数。

**Non-Goals:**
- 放宽「2 浪回撤 ≤ 88.6%」「3 浪 ≤ 4.236 × 1 浪」比率规则（另议）。
- 对进行中腿做 4h 下钻（另议）。
- T1–T3 改为引擎驱动；T3 的评分口径（① 须五浪仍是软信号）本次不变。
- 轴② 与进行中结构树的呈现合并。

## Decisions

### D1 T4 的五浪来自 `decompose(spanLast→ext, [DRIVING])`

- 取 `finePivots` 中 spanLast 到 ext（含两端）这段细枢轴 `leg1Fine`，调用 `decompose(leg1Fine, candles, [DRIVING], 0, opts)`。
- 段内细枢轴少于 6 个（驱动形态最少点数）→ 不产出 T4。
- 取 primary 作为 T4 计数，允许为 penalized（优雅降级：没有零违规五浪时取最轻违规者，表中显示 ❌）。
- depth 0 属于无父级位置：楔形沿用 enforce-strict-wave-grammar D7，合并为「楔形（位置待定）」。T4 的标签随 primary 形态区分：推动浪→「上涨5浪推动·⑤进行中(末浪)」，楔形→「上涨楔形·⑤进行中(末浪)」（下跌镜像）。

*为什么只拆到 ext 而非 now：* now 在 ext 之后的回撤里，类型与五浪终点相反（上涨五浪须终于 H，now 是 L），`decompose` 到 now 会因首尾类型不匹配无解。ext 是 ⑤ 目前走到的极值，与框架 B「末腿锚全局极值、标延伸中」同构。

*备选：* 在模板内用 `significantShortlist` 枚举 ①②③④、只查价格规则（方向 1）。放弃——子浪不校验，与引擎口径冲突（缺陷 6）。

### D2 复用主树 `opts`（含 cache）

`buildCurrentWaveStructures` 已接收主树 `opts`（`buildCountTree` 传入，含 `maxDepth`、`beamK`、`cache`），T4 的 `decompose` 直接用它：深度、beam 与主树一致，子腿拆解可命中主树缓存（spanLast→ext 内部的子区间常与主树框架 B / 两可标注的拆解重合）。

`leg1Char` 目前用独立 opts（`beamK:3, maxDepth:4`、无缓存）调用 `legCharacter`，本次**不改**——改了会让 T1–T3 的软信号随之变化，超出范围。代价是 spanLast→ext 在不同参数下被拆两次，实施时记录耗时。

### D3 ⑤ 进行中：闸门待判、展示违规数

- ⑤ = ④终点 → ext，状态 `⏳进行中`；ext → now 的回撤视为 ⑤ 内部回撤。
- 对 primary 调用 `applyInProgressRuleGate(candidate, candles)`：末点向顺势方向微移后能改善或翻转的规则（如「3 浪不是最短」「5 浪相关比例」）标为 `deferred`。
- 表中 `tier1` = 引擎 tier1 − 被闸门暂缓的规则数（与排名表 `candidateViolations` 的展示口径一致）；文法违规不暂缓（① ③ 已走完，⑤ 内部结构待判由 `deferred` 文案说明）。
- `deferred` 列出被暂缓规则的描述，并保留「浪⑤内部形态与目标待走完再判」。
- 删除 `breach2/3/4` 手写判据——由引擎规则全覆盖（2 浪不破 1 浪起点、4 浪不入 1 浪、3 浪不最短等）。

### D4 失效点与投影

- 失效点：④终点（跌破 / 升破则 ⑤ 不可能仍在进行）。说明文案保留「严格版另需 ④ 不入 ① 领地」已由引擎规则校验，故改为「跌破④底 X 则⑤进行中读法失效」。
- 投影（上涨为例，下跌镜像）：`p4 + |①|`（⑤ = ①）、`p4 + 0.618 × |p3 − p0|`（⑤ = 0.618 × ①~③）。按价格升序；已被 ext 越过的目标标 `reached: true`，渲染为「（已到）」。

### D5 「⑤ 已完成」由 T3 承载

T3 的 ① = spanLast→ext、② = ext→now 进行中，正是「五浪在 ext 完成、现为调整」的高一级表述。不新增模板，避免同一状态两行。T3 结构增加 `leg1Subcount`：引擎五浪计数的点位序列、形态标签与 tier1；渲染在子计数列 `①:57717→87397（内含五浪 57717→…→87397，违规×N）`。T3 的 `tier1` / `soft` 计算不变（Non-Goal）。

### D6 删除 T4 软信号

T4 `soft` 固定为 0；排名仍按 tier1 升序、soft 降序、label 去重。

## Risks / Trade-offs

- [严格文法下 T4 常为 ❌（BTC 案例 ① 在日线上是三波）] → 符合方向 2 的定位；表中显示最重违规原因，读者知道差在哪。4h 下钻是后续解法。
- [primary 不一定是用户心中的计数] → T4 只显示引擎最优一条；用户自己的数法仍可用 `--count` 打分。
- [ext 段很长时 decompose 耗时] → 该段已被 `legCharacter`（leg1Char）和进行中结构树拆过，D2 共享缓存后近乎零增量；实施时记录耗时。
- [golden T4 用例依赖旧的 post[0..3] 行为] → 按新口径改写，保留「⑤ 进行中、失效点 = ④终点、投影在 ④终点顺势侧、T3/T4 label 不同都保留」等不变量。

## Migration Plan

纯本地 CLI。实施前先归档 enforce-strict-wave-grammar；改动后重跑 BTC / ZRO / MU 三个缓存样本，记录 T4 变化；回滚即回退提交。

## Open Questions

- T3 的「① 须为五浪」是否也改为硬约束（① 若拆不出干净五浪则 T3 计违规）？本次保持软信号，待本变更落地后看报告效果再议。
