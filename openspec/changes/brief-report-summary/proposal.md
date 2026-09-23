## Why

consolidate-report-by-theme 去重后，Markdown 报告仍有约 240 行（TL;DR、轴①②③、大白话版并列），读者要找「大局 / 当前浪型 / 失效点 / 关键价位」仍需翻多节。需要一份像「ZRO/USD 日线波浪分析简报」那样的 4 条结论式简报，一眼读完。

## What Changes

- `_tree.md` 开头改为**波浪分析简报**：标题 `{品种} {周期}波浪分析简报`，固定 4 条：
  1. 大局研判（主选形态 + 至多一行备选/框架B看跌延伸）
  2. 当前浪型（当前反弹段 + 内部性格 + 主选身份 + 现处回调/延伸）
  3. 核心生死线（失效点）
  4. 关键目标与交易位置（下预警/支撑、上阻力/突破、反弹目标位）
- 简报后一行免责声明，再附元信息（品种/周期/时间范围/样本/区间高低/最新收盘/生成时间/数据来源）。
- 原轴①②③全文整体移入 `<details>` 折叠；**删除**独立的现状研判 TL;DR 与大白话版（职责由简报取代）。
- **BREAKING（仅呈现层）**：报告顶层节标题变化。
- **不改动**：引擎、排名、评分、`_tree.json` 字段。

## Capabilities

### Modified Capabilities
- `wave-count-tree`: 新增「报告以 4 条简报开头」要求；修改「大白话版为 TL;DR」为「由简报取代」。

## Impact

- 代码：`analyze-wave-tree.js` 新增 `renderBrief`，改 `renderMarkdownReport` 组织顺序；`renderAssessment` / `renderNarrative` 不再被报告调用。
- 测试：golden 测试断言改为简报结构。
