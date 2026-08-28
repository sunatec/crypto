# 设计：延伸中末腿的终点约束 + 可判定性规则闸门

> 本设计来自一次 explore 会话（BTC 1d，现价 78301）。前置：`model-unfinished-final-wave`
> （已交付逆势框架B 与未完成度惩罚）。硬约束：仅改 `analyze-wave-tree.js`。

## 1. 缺陷定位

### 缺陷一：朴素框架B 抢占 → 末腿终点是反弹价而非真极值

```
finePivots 末段:  … 97964(H) → 57718(L) → 81265(H) → 78301(prov,当前)
                            └──────────── 真低点 ───┘         └ now, 反弹回撤中

框架B 分派（现状）:
  topSpanB = [126296 … 78301]
  naiveB = decompose(topSpanB)   → 拟合成 126296→80525→97964→78301  (非空!)
  tree.frameworkB = naiveB       → 末腿 y = 97964→78301 ⏳进行中

问题: 78301 位于近端摆动高 81265 之下 → 被当"临时低点" → 朴素B 拟合成功、
      抢在 buildCounterTrendFrameworkB 之前。末腿终点(78301) > 内部低点(57718)。
```

一条"下跌进行中"的末腿，终点高于它自己已达到的低点——这是矛盾的表征。逆势框架B 本
为此而写（[analyze-wave-tree.js:2363](analyze-wave-tree.js:2363)），但只在 `naiveB` 返回空时兜底，此处没触发。

### 缺陷二：延伸中末腿仍全查规则

备选2（框架B 双锯齿）挂 `❌违规×1：y须>90%w`。但 y 下跌延伸中，|y| 只增不减：

```
                 w幅度    y幅度    y/w      y须>90%w
现状(y→78301)    45771   19663   0.43     ❌ 越界0.115
锚真极值(y→57718) 45771   40246   0.879    ❌ 越界0.005
y 再延伸(→<56k)   45771    ↑      → >0.90  ✅ 会通过   ← 判决被延伸翻转
```

判决会被延伸翻转的规则，对进行中末腿不可判定，不应计为违规。

## 2. 判据（本次会话敲定）

### 2.1 末腿终点约束（缺陷一）

**约束**：框架B 的进行中末腿终点，MUST 是该末腿区间内的**顺势极值**——下跌腿取区间最低，
上涨腿取区间最高——不得是逆势回撤点。

**判据不能用 `now.type`（关键更正）**：BTC 实测中 `now`(78301) 的枢轴类型是 **L**（它是
81265 之后的回撤低点），与全局极值 57718(term) **同型**。所以 `now.type !== term.type` 恒假、
`buildCounterTrendFrameworkB` 的 `now.type === term.type → null` 守卫也会误伤——两者都基于
`now.type`，而 `now.type` 在"反弹后回撤中"这个最该改道的场景下恰好失灵。

**正确判据：逐候选的「末腿终点=其区间顺势极值」不变量。** 对每条 naiveB 候选，取其末腿
`[start..now]` 区间：下跌末腿的终点价须等于区间最低价，上涨末腿须等于区间最高价。

```
alt7 推动浪: 末腿 81265→78301, 区间最低=78301 → 满足不变量 → 合法"顺势延伸中", 保留
alt2 双锯齿: 末腿 97964→78301, 区间最低=57718 < 78301 → 违反(藏了更低点) → 剔除
```

**实现**：改 `buildCountTree` 框架B 分派——

```js
// 1) 过滤 naiveB: 剔除末腿"藏极值"的畸形拟合
const naiveKept = (naiveB && naiveB.primary)
    ? filterFinalLegAnchored(naiveB, finePivots)   // 末腿终点=区间顺势极值者留下
    : null;
// 2) 始终计算 counterTrendB(锚全局极值、末浪延伸中)——守卫改为价格判据:
//    now 未越过全局极值(下跌: now.price > term.price)即为逆势, 而非看 now.type
const counterB = buildCounterTrendFrameworkB(tree, finePivots);
// 3) 合并入框架B 池, 交给 buildRankedCounts 按 patternId 去重
tree.frameworkB = mergeFrameworkB(naiveKept, counterB);
```

效果：
- **alt7（推动浪）**：naiveB 版满足不变量 → 保留；末腿 81265→78301 的 78301 本就是该腿真低点，
  "5浪下跌进行中"是合法读法，不动。
- **alt2/alt6（双锯齿/联合形）**：naiveB 版违反不变量 → 剔除。若强行把它们的末腿终点改锚到
  57718，它们会退化成"y 已完成到 57718"，与框架A 主选完全同骨架 → 去重时被吸收 → 消失。
  因此这两个形态在框架B 里**只有 counterTrendB 那一种合法表达**：y=97964→57718、
  `finalWaveInProgress`、投影跌破 57718。走 `candidateLegs` 时末点非 provisional →
  `finalWaveInProgress && i===lastIdx` → 状态 `⏳延伸中`（[analyze-wave-tree.js:2323](analyze-wave-tree.js:2323)），终点回到 57718。

**同时要改 `buildCounterTrendFrameworkB` 的守卫**（[analyze-wave-tree.js:2370](analyze-wave-tree.js:2370)）：
把 `if (now.type === term.type) return null` 改为价格判据——净向下时 `now.price <= term.price`
（now 已是新低、顺势）才返回 null，否则（now 在极值上方=逆势回撤中）照常构造。

**tie-break：不需要额外阈值。** 不变量是精确判断（区间里有没有更极端的价），非模糊比较；
而"多小的摆动才算 pivot"由上游 ATR×1.5 过滤（[detectPivots](analyze-kline-wave.js:410)）统一把关——
57718/81265 既已是 pivot，不变量检查即确定。故删去原设想的 dispatch 层 ATR tie-break。

### 2.2 可判定性闸门（缺陷二）——单调性判据

对 `finalWaveInProgress` 候选的**末腿**涉及的每条已失败规则，问一句：

> **末腿沿其合法方向延伸，能否翻转这条规则的判决？**

- **不能翻转**（判决对延伸不变）→ **可判定**，照计违规。
- **能翻转**，且当前**尚未违反**、延伸可能触发 → **暂缓**，不计违规，标「⏳待判」。
- **能翻转**，且当前**已违反**、延伸只会加剧 → **可判定**，照计违规。

即：只有"已违反且延伸单调恶化"才判违规；"尚未违反但延伸可能触发/解除"一律暂缓。上下界统一：

| 规则 | 末腿(下跌)延伸方向 | 对判决影响 | 当前状态 | 裁决 |
|---|---|---|---|---|
| y须>90%w（下界） | |y|↑ | 向通过靠 | 差一丝未过 | ⏳暂缓（延伸可解除）|
| y须<5倍w（上界） | |y|↑ | 向违反靠 | 未违反 | ⏳暂缓（延伸可触发）|
| y须<5倍w（上界） | |y|↑ | 向违反靠 | **已越5倍** | ❌照计（延伸只更糟）|
| 内部子浪数/方向/形态类型 | — | 与末腿终点无关 | — | ✅照查 |

**实现更正（apply 期落定）：用「梯度法」计算单调性，不做逐规则手工标注。** 原设想给规则族加
`dependsOnFinalLegEndpoint`/`monotonic` 元数据；实测发现更简单且更稳妥的做法是：把末点向趋势方向
微移 2% 末腿幅度，对每条已失败规则重测——**新判定通过、或越界变小 → 可被延伸翻转 → 暂缓**；否则照计。
好处：① 无需给约 50 条规则闭包逐条标注单调方向；② 天然正确处理上/下界（越界变小才暂缓，故"已越上界、
延伸更糟"的越界变大→照计）；③ 与末腿终点无关的规则微移末点越界不变→自然照计，无需显式作用面白名单。
`applyInProgressRuleGate(candidate, candles)` 实现之。

**关键更正（排序 vs 展示分离，apply 期落定）：闸门是「展示层重分类」，不改 ranking 分数。**
原设想"把 deferred 从 `failed`(tier1) 移出、tier1 减少"。但 `compareCandidates` 里 incompleteness 排在
tier1 **之后**，一旦 deferred 让框架B 末浪候选的 tier1 掉到 0，它会**跃过其同骨架的框架A 完成候选**
（后者带那条真违规 tier1=1）抢占**主选**——与 §2.4「未完成度守住 B 在 A 之后」相悖（实测：B双锯齿
tier1=0 直接顶掉 A双锯齿成为 primary）。故改为：
- `applyInProgressRuleGate` **只往 score 追加 `deferred` 标记，不动 `failed/tier1/tier2`**。排序仍用
  完整 tier1 → B双锯齿(tier1=1) 与 A双锯齿(tier1=1) 平 tier1/tier2 → 由 incompleteness 裁决 → A 保持主选。
- **展示层**（`candidateViolations` 扣除 deferred 的规则、排名条目 `score.tier1/tier2` 减去 deferred）
  才让备选显示"✅规则全过 + ⏳待判"。用户所见与排名位置两者兼得。

**落点**：`buildCounterTrendFrameworkB` 的 `reframe` 里调 `applyInProgressRuleGate`（追加 `score.deferred`）；
`buildRankedCounts` 映射条目时对 `score.tier1/tier2` 扣除 deferred（仅影响标签，不影响已定排名）。

### 2.3 呈现（标注待判）

`candidateViolations` / `fmtViolReason`（[analyze-wave-tree.js:2290](analyze-wave-tree.js:2290)）增加 `deferred` 分支：

```
⏳ y浪价格须>w浪90%且<w浪5倍：待末腿走完再判（当前 y/w=0.879，延伸可能通过）
```

排名表"违规原因"列：先列真违规（tier1），再列 ⏳待判项；`❌违规×N` 的 N 只数 tier1。

### 2.4 未完成度惩罚：保留

`incompleteness`（末腿完成度反比的整体惩罚）与闸门**职责不同**：
- 闸门解决"**不该判违规**"（正确性）。
- incompleteness 解决"**半成品别虚高抢主选**"（排序公平）。

二者并存。备选2 经闸门后即便 tier1=0（规则全过），仍带 incompleteness≈0.51，排在框架A
零违规族之后——不会因"规则全过"直接顶到主选。

## 3. 影响面与回归护栏

- **只影响 `finalWaveInProgress` 候选**：框架A（已完成）与"顺势延伸中"的 naiveB 候选（末腿满足不变量，如 alt7 推动浪）完全不变。
- **满足不变量的 naiveB 不被剔除**：末腿终点本就是区间顺势极值时（真·顺势创新低/新高，或单调末腿），保留 naiveB 原读法。加单测钉住 alt7 类候选不受影响。
- **闸门不误伤深层浪**：闸门只作用于**顶层进行中末腿**，不进 `decompose` 的共享递归路径，
  深层合法的"3浪延伸大于1/5浪"等不受影响（沿用 `legProportionViolated` 的 post-hoc 思路）。
- **排序回归**：因闸门可能让备选2 从"违规族"升到"零违规族"，需验证不会挤掉框架A 主选——
  由 incompleteness 保证其排在框架A 零违规之后；加对比单测（改动前后排名快照）。

## 4. 非目标

- 不做全规则闭包的单调性标注，只标"末腿终点相关"这一族。
- 不重构 incompleteness、不改形态集、不引入书外指标。
