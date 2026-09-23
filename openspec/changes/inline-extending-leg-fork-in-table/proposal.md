# 提案：把"两可"分叉提示从表格下方脚注挪进"备选"表格本身

## Why

`mark-extending-leg-character-fork` 给"进行中末腿两可"（如 82814→57718 既可读单锯齿也可读推动浪）加了标注，但渲染在"备选"排名表格**下方**的独立引用块（`> 备选N（...）：` + 两行文字，见 [analyze-wave-tree.js:2824-2829](../../../analyze-wave-tree.js#L2824-L2829)）。

问题：读者看"备选"表格时，某一行的"腿"列写的是 `y:97964→57718⏳`，看不出这条腿内部还悬着一个"两可"分叉——要往下翻到表格结束后的引用块才能发现。两可提示离它描述的那条腿太远，容易被忽略，尤其当有多条备选都带脚注时（如本例的备选1、备选5）容易混淆是哪条腿的分叉。

## What Changes

对 `analyze-wave-tree.js`（仅渲染层，不改判定逻辑）：

1. **表格内联**：备选表格"腿"列拼接时，若某条腿对应候选的 `altCharacter` 存在，直接在该腿后加一个紧凑后缀（如 `y:97964→57718⏳(两可:单锯齿/推动浪)`），取代原来"现取…也可读作…（同样零违规）"那句完整解释文字。
2. **点位序列改为精简附注**：`altCharacter.points`（对侧读法自身的点位序列）塞不进表格单元格，改为在表格**下方**保留一行精简附注（只列点位序列，不再重复已经内联到表格里的那句解释文字）。
3. **主选不变**：`## 主选` 块（非表格形式）如果带 `altCharacter`，渲染方式不变——它不是表格行，没有"挪进表格"这个问题。
4. **数据层不变**：`annotateExtendingLegForks` 的判定逻辑、`altCharacter` 字段结构、`_tree.json` 里的 `altCharacter` 透传，均不改动。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `wave-count-tree`：备选排名表格中，带 `altCharacter` 的腿在表格"腿"列内联显示"两可"提示（现取/也可读作），对侧读法点位序列改为表格下方的精简附注；不改变判定、计数、排名。

## Impact

- 改动文件：`analyze-wave-tree.js`（`altForkLines` 的调用方式与拆分、备选表格 `legsStr` 的拼接逻辑）。
- 涉及能力：`wave-count-tree`（两可提示的展示位置与格式）。
- 产出变化：`_tree.md` 里"备选"表格的"腿"列多出内联后缀；原先表格下方的 `> 备选N（...）：` 大段引用块被替换为更短的点位附注行。`_tree.json` 不变。
- 不改：数据源、CLI、规则集、排名去重、`annotateExtendingLegForks` 判定逻辑、`gate-extending-final-leg-rules` 的规则闸门。

## 非目标

- **不改判定逻辑**——两可检测、最浅一条腿的选取、对侧读法的计算，完全复用 `mark-extending-leg-character-fork` 现有实现。
- **不改 JSON schema**——`_tree.json` 里的 `altCharacter` 字段原样保留。
- **不给未两可的腿加任何标注**——只处理 `altCharacter` 存在的候选。
- **不改主选（`## 主选`）的渲染**——只动"备选"排名表格及其下方附注。
- **不引入书外指标。**
