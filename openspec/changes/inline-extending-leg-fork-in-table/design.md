# 设计：把"两可"分叉提示内联进"备选"表格

> 前置：`mark-extending-leg-character-fork`（已实现，`annotateExtendingLegForks` 产出 `candidate.altCharacter`；
> 该变更本身尚未归档，其 delta spec 暂只存在于 `openspec/changes/mark-extending-leg-character-fork/specs/`）。
> 硬约束：只改 `analyze-wave-tree.js` 渲染层，不改 `annotateExtendingLegForks` 判定逻辑与 `altCharacter` 结构。

## Context

现状（[analyze-wave-tree.js:2805-2829](../../../analyze-wave-tree.js#L2805-L2829)）：备选表格每行的"腿"列只有 `y:97964→57718⏳` 这样的纯点位；带 `altCharacter` 的候选，其"两可"提示被渲染成表格**结束之后**的独立引用块：

```
> 备选1（双锯齿（Double Zigzag w-x-y））：
> ⏳ 末端腿 82814→57718 两可：现取 单锯齿（Zigzag 5-3-5），也可读作 推动浪（标准 Impulse）（同样零违规）；...
> 对侧读法点位：82814(...)→...→57718(...)
```

当有多条备选都带 `altCharacter`（如本例的备选1、备选5）时，读者要在表格和表格后的多段引用块之间来回对照，才能确认"这段提示说的是哪一行"。

## Goals / Non-Goals

**Goals：**
- 备选表格"腿"列里，带 `altCharacter` 的那条腿直接带上紧凑的"两可"后缀（现取哪个/也可读作哪个）。
- 对侧读法的完整点位序列保留（不丢弃这个"不新增计算、只是把 decompose 算完即丢的数据透传出来"的核心价值），但改成表格下方更短的一行附注，不再重复已内联到表格里的解释文字。
- `_tree.json` 的 `altCharacter` 字段、`annotateExtendingLegForks` 判定逻辑、选中的计数与排名，一律不变。

**Non-Goals：**
- 不改变"两可"检测本身（`canDrive && canCorrect`）或"只标最浅一条"的取舍逻辑。
- 不给 `altCharacter` 为空的腿加任何标注。
- 不改 `## 主选`（非表格）块的渲染——它没有"挪进表格"的问题。
- 不新增表格列。
- 不递归下钻对侧读法内部找新分叉（`mark-extending-leg-character-fork` 已定的非目标，本次不重议）。

## Decisions

### 1. 后缀挂在哪条腿上：按"⏳ 状态"匹配，而非按端点价格匹配

`altCharacter.legFrom/legTo` 是**末端成形链下探后**的细分子腿端点（如 82814→57718），**不等于**候选宏观腿自己的端点（备选1的 y 腿是 97964→57718）——两者只共享同一个终点（57718），因为链路的构造方式就是"从宏观末腿起，每层取终结于同一全局极值的子腿"。所以不能用 `l.from === altCharacter.legFrom.price` 这种端点比对去找该挂在哪条腿上。

`annotateExtendingLegForks` 的前置条件是 `candidate.finalWaveInProgress`，而这类候选在 `c.legs` 里**有且只有一条**腿带 `⏳ 进行中`/`⏳ 延伸中` 状态（即当前正在写的宏观末腿——参见 [analyze-wave-tree.js:2806](../../../analyze-wave-tree.js#L2806) 已有的 `l.status === '⏳ 进行中' || l.status === '⏳ 延伸中'` 判断）。`altCharacter` 所在的链路必然是这条末腿向内下探出来的，因此**后缀直接挂在这条已经带 ⏳ 的腿上**——复用现有状态判断，不新增匹配逻辑。

（备选：给 `altCharacter` 补一个 `macroLegIndex` 字段由 `annotateExtendingLegForks` 直接写出该腿在 `candidate.legs` 里的下标，匹配更显式。但这需要改产出 `altCharacter` 的函数签名/返回结构，违反"不改数据层"的硬约束，故不采用。）

### 2. 后缀措辞：去掉长标签的括注部分

`altCharacter.shownLabel`/`label` 是完整标签（如"单锯齿（Zigzag 5-3-5）"、"推动浪（标准 Impulse）"），塞进表格会把"腿"列撑得很宽。渲染时用一个小helper剥掉括注：

```js
const shortLabel = (label) => label.replace(/（.*?）/, '');  // "单锯齿（Zigzag 5-3-5）" → "单锯齿"
```

后缀格式：`⏳两可:{shortLabel(shownLabel)}/{shortLabel(label)}`，拼在该腿原有的 `⏳` 之后，如：

```
y:97964→57718⏳两可:单锯齿/推动浪
```

### 3. 点位序列：从"两行解释块"精简为"一行附注"

原 `altForkLines` 产出两行（解释句 + 点位句）。拆分为两个独立的小函数：内联后缀取代原解释句；点位序列单独渲染成表格下方一行，且**只对带 `altCharacter` 的候选各出一行**，格式：

```
> 备选1 对侧点位：82814(2026-05-06) → 78700(2026-05-13) → 82066(2026-05-14) → 74197(2026-05-23) → 78015(2026-05-26) → 57718(2026-07-01)
```

不再重复"改此性格则该结构翻向对侧族"这类解释文字——这句话的信息已经被表格内联后缀"两可:A/B"覆盖（读者看到"两可"二字本身就知道会翻族，不需要每行重复讲一遍原理；原理性的说明保留在术语图例里讲一次，见下条）。

### 4. 图例补一条术语说明

现有术语图例块（[analyze-wave-tree.js:3502](../../../analyze-wave-tree.js#L3502) 附近，`> 术语：...`）补一行：

```
> `两可:A/B`＝该腿现取A读法，也可读作B读法（同样零违规）；改此性格则上层结构翻向对侧族，详见表格下方的对侧点位附注。
```

把原来在每条备选后重复的解释文字，收敛成图例里讲一次，符合"只标注、不啰嗦"的既有风格。

## Risks / Trade-offs

- **[风险] 既有金标准测试断言旧文案** → `tests/analyze-wave-tree.golden.test.js` 里对"两可：现取…也可读作…"这句完整解释文字、以及表格后独立引用块结构的断言会随渲染改变而失败。**缓解**：作为本变更 tasks 的一部分同步更新这些断言为新格式（内联后缀 + 精简附注行），不新增测试覆盖面之外的行为。
- **[风险] 后缀让"腿"列更长，多腿候选（如三锯齿 5 段）行宽进一步增加** → **缓解**：只有 `finalWaveInProgress` 候选、且只有其中一条腿（末腿）会带后缀，不是每条腿都加，行宽增幅可控。
- **[风险] `mark-extending-leg-character-fork` 尚未归档，其 delta spec 还在变更目录里而非 `openspec/specs/`** → 本变更的 spec delta 里 `MODIFIED Requirements` 引用的是该未归档变更里的需求文本。**缓解**：不影响代码实现（代码已存在于主干），仅需在归档顺序上留意——建议先归档 `mark-extending-leg-character-fork` 再归档本变更，避免 spec 归档顺序倒置；若来不及也不阻塞本变更的编码与测试。

## Open Questions

（无——测试更新、匹配规则、文案格式均已在上面拍板；如实现中发现某候选存在多条 `⏳` 腿导致"按状态匹配"失效，需回来重议匹配规则，但目前数据结构上 `finalWaveInProgress` 候选只有一条末腿会被标 `⏳`。）
