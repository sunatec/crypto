# 任务：把"两可"分叉提示内联进"备选"表格

> 前置：`mark-extending-leg-character-fork` 已交付（`annotateExtendingLegForks`/`altCharacter` 已存在）。
> 仅改 `analyze-wave-tree.js` 渲染层，不改判定逻辑、不改 `altCharacter` 结构、不改 `_tree.json`。

## 1. 后缀拼接：定位到哪条腿、生成短标签

- [x] 1.1 实现 `shortLabel(label)` helper：剥掉标签括注部分（`"单锯齿（Zigzag 5-3-5）".replace(/（.*?）/, '')` → `"单锯齿"`）。
- [x] 1.2 在备选表格 `legsStr` 拼接处（[analyze-wave-tree.js:2806](../../../analyze-wave-tree.js#L2806)），若 `c.altCharacter` 存在，给 `l.status === '⏳ 进行中' || l.status === '⏳ 延伸中'` 的那条腿追加后缀 `两可:${shortLabel(shownLabel)}/${shortLabel(label)}`（拼在既有 `⏳` 之后）；其余腿不变。
- [x] 1.3 同一处理逻辑同步应用到主选之外的所有"备选"表格行（`alts.forEach` 循环内），不影响 `## 主选` 块自身的渲染路径。
      （实现为 `legsStrWithFork(c)` helper，替代原内联 map。）

## 2. 点位附注：从两行解释块精简为一行

- [x] 2.1 保留 `altForkLines` 中生成点位序列字符串的部分（沿用 `fmtTs`/`price` 惯例），拆出一个独立的小函数（如 `altPointsLine(alt)`），只产出点位序列这一行，不含解释句。
- [x] 2.2 在"备选"表格渲染完之后（原 [analyze-wave-tree.js:2824-2829](../../../analyze-wave-tree.js#L2824-L2829) 的 `alts.forEach` 循环），改为对每个带 `altCharacter` 的候选只 push 一行：`> 备选N 对侧点位：{altPointsLine(...)}`，移除原来的"两可：现取…也可读作…"解释句（该信息已内联进表格后缀）。
- [x] 2.3 `## 主选` 块（[analyze-wave-tree.js:2771-2774](../../../analyze-wave-tree.js#L2771-L2774)）维持调用原 `altForkLines`（完整两行：解释句 + 点位序列），不受本次改动影响。

## 3. 图例补充

- [x] 3.1 在既有术语图例块（[analyze-wave-tree.js:3502](../../../analyze-wave-tree.js#L3502) 附近）追加一行，解释表格内"两可:A/B"后缀的含义（现取A/也可读作B/改此性格翻向对侧族，详见表格下方对侧点位）。

## 4. 测试更新与校验

- [x] 4.1 更新 `tests/analyze-wave-tree.golden.test.js` 中对旧渲染格式的断言（原先断言表格后独立引用块含"两可：现取…也可读作…"完整句），改为断言：备选表格对应行的"腿"列含 `两可:{短标签}/{短标签}` 后缀，且表格下方存在一行精简的"对侧点位"附注。
- [x] 4.2 新增/调整单测：`⏳` 状态腿与 `altCharacter` 对应关系——多腿候选（如三锯齿 5 段）里，只有带 `⏳` 的那一条腿获得后缀，其余腿不受影响。
- [x] 4.3 新增单测：`## 主选` 块带 `altCharacter` 时渲染方式不变（完整解释句 + 独立点位行），验证与"备选"表格行为区分开。
- [x] 4.4 回归：非两可腿、非 `finalWaveInProgress` 候选，表格行渲染与改动前一致（无后缀、无附注行）。
- [x] 4.5 回归（金标准快照）：加改动前后，顶层选中计数、排名顺序、各候选 tier1/违规/待判**完全不变**；`_tree.json` 的 `altCharacter` 字段内容不变（`serializeRankedCounts`/JSON 写出路径未改动，既有金标准断言原样通过）。
- [x] 4.6 全量测试通过（5 个测试文件，119/119）。
- [x] 4.7 `openspec validate inline-extending-leg-fork-in-table --strict` 通过。
