## 1. 简报渲染

- [x] 1.1 新增 `renderBrief(meta, tree)`：标题 + 4 条 + 免责声明 + 元信息（D2/D3/D4）。
- [x] 1.2 `renderMarkdownReport` 改为：简报 → `<details>`（轴①②③、用户数法评分、规则树）；不再调用 `renderAssessment` / `renderNarrative`。
- [x] 1.3 数据不足（无主选/无进行中结构）时简报降级为「数据不足」提示，不抛错。

## 2. 测试

- [x] 2.1 golden 测试：断言简报标题与 4 条编号、失效点数字、三轴位于 `<details>` 内、TL;DR/大白话标题消失。
- [x] 2.2 全量跑测试，确认 `_tree.json` 不变、无引擎回归。
- [x] 2.3 用真实数据生成 BTC 报告目测简报。
