# 设计：进行中末腿"两可"性格分叉的保留与标注

> 来自 explore 会话（BTC 备选1，y=97964→57718⏳，其末端腿 82814→57718）。前置：
> `gate-extending-final-leg-rules`（已交付终点锚定 + 规则闸门，明确把本议题列为非目标）。
> 硬约束：仅改 `analyze-wave-tree.js`，且只加标注、不改选中的计数与排名。

## 1. 缺陷定位：被角色压掉的性格，算完即丢

`legCharacter`（[analyze-wave-tree.js:1208](analyze-wave-tree.js:1208)）**同时算出并返回** `drivingNode` 与 `correctiveNode`；
丢弃发生在**调用点**（[analyze-wave-tree.js:1339](analyze-wave-tree.js:1339)）：

```js
const childNode = (childRole === DRIVING ? (lc.drivingNode || lc.correctiveNode)
                                         : lc.correctiveNode)   // ← corrective 角色只留 correctiveNode
                  || leafNode(childFine, childRole);
```

即：一条腿被塞进某角色时，只有该角色所需性格的读法被挂进树，**对侧性格读法被丢**。对
`82814→57718`（占内层双锯齿的 y 位=corrective）：`correctiveNode`=单锯齿被采用、`drivingNode`=推动浪(5浪)被丢。

```
                              两读法都 tier1=0(合规)
   82814→57718 ─┬─ drivingNode:    推动浪(5浪)   ✗ 丢(角色=corrective)
                └─ correctiveNode: 单锯齿(3波)   ✓ 采用、显示
```

**注意：这里没有硬规则/文法被违反**——歧义腿（`canDrive && canCorrect`）放任何角色都不违规
（`grammarViolatesRole` 对两可腿返回 false）。所以这是**"选择性显示"缺口**，不是 `gate-extending-final-leg-rules`
的"误判违规"问题，规则闸门不适用。

## 2. 判据：只标"进行中末腿链上、两可、被角色压掉对侧性格"的腿

不是所有歧义腿都标（那会遍地是）。只标满足全部三条的腿：

1. **在进行中末腿链上**：该腿位于 `finalWaveInProgress` 候选的"末端成形链"——从宏观末腿起、
   沿每层的**终结于全局极值那一侧的子腿**逐层下探所经过的腿。
2. **两可**：`legCharacter` 给出 `canDrive && canCorrect`（两读法均 tier1=0）。
3. **被角色压掉了对侧**：当前显示的性格 ≠ 其对侧合规性格（即确有一个 clean 的对侧读法被丢）。

**取哪一层（设计决策）**：末端链上可能有多条两可腿。默认只标**最浅的那一条**——因为它的性格翻转
牵动最上层的族变化，杠杆最大；更深的是它的后果。渲染时提一句"（更深子腿亦可能两可）"兜底，
不逐层罗列。（BTC 例：最浅两可腿正是 `82814→57718`，与用户所指一致。）

**与顶层备选的关系**：顶层若某腿两可，其"另一族"读法通常已作为独立顶层备选出现（如备选7 推动浪族），
无需再标；本标注专补**内层**（如 82814→57718）——这些内层分叉当前在任何地方都看不到。故判据可加：
只标**非顶层**（depth≥1）的两可末腿，避免与顶层备选重复。

## 3. 实现：post-hoc 标注，不进 decompose 共享递归

沿用 `gate-extending-final-leg-rules` / `legProportionViolated` 的 post-hoc 思路——**不改 decompose**
（改了会污染所有位置的性格选择），只在框架B 逆势候选建好后加一遍标注：

```
annotateExtendingLegForks(candidate, finePivots, candles, opts):
  仅当 candidate.finalWaveInProgress
  沿末端链下探(每层取"终结于全局极值一侧"的子节点)，depth≥1：
    seg = 该腿的细枢轴段
    lc = legCharacter(seg, candles, depth, opts)     // 复用，已返回双性格节点
    if lc.canDrive && lc.canCorrect:
        shown = 该腿当前显示性格(node.klass/character)
        alt   = 对侧性格的代表(lc.drivingNode / lc.correctiveNode 中未被采用那个).primary
        node.altCharacter = { character: 对侧, label: alt.manual.label, points: alt.points }
        记录"最浅一条" → 标注，break（更深仅提示存在）
```

落点：`buildCounterTrendFrameworkB` 建好候选后，对其 primary 调用一次；或在 `buildRankedCounts`
映射框架B 末浪候选时触发。`altCharacter` 透传到排名条目。

## 4. 渲染（粒度2：只标跨性格分叉）

在报告里该腿处（或框架B 末浪的说明行附近）加一句：

```
⏳ 末端腿 82814→57718 两可：现取 3波（单锯齿），也可读作 5浪（推动浪，同样零违规）；
   改此性格则该结构不再是双锯齿、翻向推动族。（更深子腿亦可能两可。）
```

`_tree.json` 对应节点加 `altCharacter` 字段（md/json 同源）。**不罗列同性格近似形态**（联合形/三锯齿
等，粒度1 噪音，仍按现有去重压掉），**不改选中计数与排名**。

## 5. 影响面与护栏

- **只加标注**：选中的顶层计数、排名顺序、违规/待判一字不改。
- **不进共享递归**：post-hoc，只作用于框架B `finalWaveInProgress` 候选的末端链；框架A、顺势框架B、
  深层其它位置的性格选择完全不变。
- **单测**：BTC fixture 下，框架B 末浪候选的末端两可腿带 `altCharacter`（对侧=driving/推动），
  且选中计数不变、排名不变。
- **回归**：非两可腿（只 canCorrect 或只 canDrive）不加 `altCharacter`；顶层腿（depth 0）不标（避免与顶层备选重复）。

## 6. 非目标

- 不罗列所有 tier1=0 形态（粒度1）；不改选中计数/排名；不重构进行中结构下钻深度（粒度3）；
  不碰规则闸门；不引入书外指标。
