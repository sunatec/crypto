# 任务：延伸中末腿的终点约束 + 可判定性规则闸门

> 前置：`model-unfinished-final-wave` 已交付。仅改 `analyze-wave-tree.js`。
> 判据（explore 会话敲定）：单调性判据 · 标注待判 · 保留未完成度惩罚。

## 1. 末腿终点锚在真极值（方案A，修缺陷一）

> 判据更正：不用 `now.type`（BTC 实测 now=78301 类型为 L，与全局极值 57718 同型，
> 基于 type 的判据失灵），改用逐候选的「末腿终点=区间顺势极值」不变量。

- [x] 1.1 实现 `finalLegAnchored(candidate, finePivots)` + `filterFinalLegAnchored(naiveB, finePivots)`：
      取末腿 `[start..now]` 区间；下跌末腿终点须=区间最低价、上涨须=区间最高价，违反者（末腿藏了
      更极端点，如双锯齿 97964→78301 藏了 57718）从框架B 池剔除，满足者（如推动浪 81265→78301）保留。
      （注：已有 `legEndpointsSpanExtreme` 只校验内部宏观点、不含末点 now，本函数补末腿这一段。）
- [x] 1.2 改 `buildCounterTrendFrameworkB` 守卫（[analyze-wave-tree.js:2370](analyze-wave-tree.js:2370)）：
      `if (now.type === term.type) return null` → 价格判据 `if (down ? now.price <= term.price : now.price >= term.price) return null`
      （now 已是顺势新极值才不构造；now 在极值逆势侧=回撤中则照常）。
- [x] 1.3 改 `buildCountTree` 分派（[analyze-wave-tree.js:1595](analyze-wave-tree.js:1595)）：始终算 counterTrendB，
      与 `filterFinalLegAnchored` 后的 naiveB 经 `mergeFrameworkB` 合并入 `tree.frameworkB`，交
      `buildRankedCounts` 按 patternId 去重。**不需要 ATR tie-break**——不变量精确，噪声由上游 ATR×1.5 过滤。
- [x] 1.4 单测（金标准，now=63123 逆势回撤中）：框架B 双锯齿末腿终点为 57718、状态"⏳延伸中"，非回撤价。
- [x] 1.5 回归单测：末腿满足不变量的 naiveB 候选（终点=区间真极值、非 finalWaveInProgress）保留、与逆势末浪并存。
- [x] 1.6 回归单测：任一框架B 进行中下跌末腿终点 SHALL NOT 高于其区间内已达最低价（通用不变量断言）。

## 2. 可判定性闸门（单调性判据，修缺陷二）

> 实现更正（apply 期）：改用**梯度法**（微移末点重测越界），不做逐规则元数据标注；且闸门是
> **展示层重分类**，只往 `score` 追加 `deferred`，**不改 ranking 分数**（否则 B 会跃过同骨架 A 抢主选）。

- [x] 2.1 ~~规则元数据~~ → 无需。梯度法天然区分"末腿终点相关"规则（微移末点越界变化）与无关规则（越界不变）。
- [x] 2.2 实现 `applyInProgressRuleGate(candidate, candles)`：末点向趋势方向微移 2% 末腿幅度，逐条
      已失败规则重测——新判定通过或越界变小 → defer（待判）；否则照计。天然正确处理上/下界。
- [x] 2.3 在 `buildCounterTrendFrameworkB` 的 `reframe` 调 `applyInProgressRuleGate`，**只追加 `score.deferred`**，
      不动 `failed/tier1/tier2`（ranking 用完整 tier1，未完成度守住 B 在 A 之后）。
- [x] 2.4 `deferred` 透传到排名条目（`buildRankedCounts` 新增 `candidateDeferred`；条目 `score.tier1/tier2`
      展示时扣除 deferred）；`candidateViolations` 从违规列表排除 deferred 规则。
- [x] 2.5 单测（金标准）：延伸中双锯齿的 y须>90%w（越界 0.005）被 defer、展示 tier1=0、列为待判。
- [x] 2.6 单测（金标准）：三锯齿已完成的 y浪（非进行中末腿）其幅度规则仍照计违规——闸门不误伤。

## 3. 呈现（标注待判）

- [x] 3.1 新增 `candidateDeferred`；`candidateViolations` 排除 deferred 规则（[analyze-wave-tree.js:2293](analyze-wave-tree.js:2293)）。
- [x] 3.2 `fmtViolReason` 加 deferred 分支："⏳ <规则>：待末腿走完再判（当前差一丝，延伸可能翻转判定）"。
- [x] 3.3 排名表/主选块：违规区在前、"⏳待判"区在后；备选 why 列在无真违规时回落显示待判项；
      展示 tier1 扣除 deferred → tier1=0 时标签"✅规则全过"。
- [x] 3.4 `_tree.json` rankedCounts 增 `deferred` 字段（md/json 同源，`serializeRankedCounts` 复用同一构建）。

## 4. 未完成度惩罚并存校验

- [x] 4.1 单测（金标准）：框架B 双锯齿经闸门后展示 tier1=0、仍带 incompleteness>0，排在其同骨架的
      框架A 双锯齿完成候选（带 y须>90%w 越界 0.005）之后——不顶替主选。
- [x] 4.2 排名快照核对：主选仍为框架A 双锯齿；B 候选终点/状态/展示违规数按预期变化，其余顺序稳定。

## 5. 收尾

- [x] 5.1 金标准 fixture 端到端核对：框架B 双锯齿 `y:97964→57718 ⏳延伸中`、展示✅规则全过、
      违规区列"⏳ y须>90%w：待判"、incompleteness 保留。（现价 78301 的委托报告需联网重取数据、
      属生成物，机制已在离线 fixture 上等价验证。）
- [x] 5.2 全量测试通过：5 个测试文件 107 用例全绿（40+15+10+6+36）。
- [x] 5.3 `openspec validate gate-extending-final-leg-rules --strict` 通过。
