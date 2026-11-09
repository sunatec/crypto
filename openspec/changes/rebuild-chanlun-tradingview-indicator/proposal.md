## Why

现有 `chanlun_czsc.pine` 和 `chanlun_czsc_strict.pine` 以《缠中说禅·教你炒股票108课》为名义依据，但成笔主要依赖原始 K 线间距，分段、中枢和信号使用简化条件，缺少可追溯的规则、完整递归和实时确认验证。需要建立一份以原文及后续澄清为依据、能解释结构形成原因并在 TradingView 上逐 K 运行的指标，作为长期看盘和后续信号研究的基础。

## What Changes

- 新增独立、可直接粘贴到 TradingView 的 Pine Script v6 指标 `chanlun_original.pine`；首版包含 K 线包含处理、分型、笔、特征序列线段、走势自然递归，以及中枢形成、延伸、新生和扩展。
- 建立原文规则表，区分作者正文、后续更正、编者注及工程约定。采用一套确定的规则，不沿用缺少出处的 `OLD/STRICT/LOOSE` 阈值模式。
- 以确认后的线段标准化部件作为 L0，构造 L1～L3 走势与中枢；更高层只消费已完成的下层走势。层级表示结构关系，不直接命名为某分钟级别。
- 采用已确认实线、候选虚线的显示方式，记录转折发生与确认时间；通过实时更新、固定数据逐 K 回放和重载对照验证确认状态。
- 首版仅分析当前图表的普通 K 线，默认最近 5,000 根、最多三层；默认服务日常看盘，研究开关显示分型、包含处理、特征序列及确认依据。
- 以用户指定的 one-quant [公开页及示例图](https://jp.tradingview.com/script/L0Xy7qaL/) 为展示与功能参考，建立线条层次、同层配色、半透明中枢、走势文字、编号和字号的明确映射及展示验收项；原文及选定规则作为正确性依据。参考图中的信号编号与本指标结构 ID 分开解释。
- 首批验证 BTC、ETH 的 1 小时、4 小时、日线，建立原文图例、边界样例和固定行情回放验收材料。
- 保留两份旧 `.pine` 作对照；新版完成验收后原样迁入 `archive/chanlun/`，README 指向新版。`chanlun_rules_extract.txt` 继续保留为检索索引，规则回到 PDF 核实。
- 功能参考表逐项标明首版、后续阶段和仅作参考的项目。后续独立变更再实现 MACD 面积、背驰、买卖点与提醒，最后实现策略回测；本次交付形态分析指标，多规则模式仍不纳入首版。

## Capabilities

### New Capabilities

- `chanlun-rule-provenance`：规则来源、解释口径、工程约定、原文图例及独立预期样例的可追溯契约。
- `chanlun-morphology`：包含处理、分型、笔、标准特征序列线段及其候选与确认状态。
- `chanlun-recursion`：线段标准化、自然递归、中枢演化、走势完成和层级边界。
- `chanlun-tradingview`：Pine v6 入口、实时与历史一致性、绘图及资源预算、平台验收和旧版迁移。

### Modified Capabilities

无。现有 Elliott 波浪、行情缓存、顾问脚本等能力的需求保持不变。

## Impact

- 新增 `chanlun_original.pine`、`docs/chanlun/` 的规则与使用文档、`tests/fixtures/chanlun/` 的固定样例、`tools/chanlun/` 的 Pine 验证脚本生成与结果核对工具。
- 验收通过后迁移两份旧 Pine 文件至 `archive/chanlun/`，补充根 README 的正式入口和旧版去向；不修改旧版算法。
- 正式指标独立运行，不依赖 Node、外部服务、发布的 Pine 库或低周期数据请求；本地工具仅用于准备与验证。
- 开发验收依赖 TradingView Pine 编辑器与图表环境。离线样例检查不代替平台编译、实时和回放验收。
- 资料来源包括仓库内《108课》PDF 与摘录、用户指定的[竞品日文公开页](https://jp.tradingview.com/script/L0Xy7qaL/)及[同脚本英文页](https://www.tradingview.com/script/L0Xy7qaL/)、TradingView 官方 [执行模型](https://www.tradingview.com/pine-script-docs/language/execution-model/) 与 [资源限制](https://www.tradingview.com/pine-script-docs/writing/limitations/)。公开预览与观察边界见 `docs/chanlun/reference-comparison.md`。
