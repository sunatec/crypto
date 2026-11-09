# 缠论指标重建工作区

当前显示控制版新增笔／段编号间隔、中枢编号开关及边框线宽；计算CORE保持B5通过版本不变，D4及显示控件正式入口均已由用户报告通过。

当前资源状态版新增共享门控、停止原因分类和S→N→Z交付接口，B5及新正式入口均已由用户报告通过。固定起点100根截断也已由用户明确报告验证通过。

当前窗口版（2026-11-05）已冻结近期加载锚点并明确固定起点样本截断，W8及固定起点100根截断均已由用户报告通过；T4通过记录保留原版本范围。

2026-11-05当前工作区已接入新的共享收盘／预览调度，T4共享验证及新正式入口均已由用户报告通过；此前“连续中枢入口正常”绑定旧版本，不自动覆盖当前文件。

当前处于分模块建设阶段。`chanlun_original.pine`已接入K/F、蓝色笔、橙色段、独立区间L0，以及连续L1中枢的离开／回试、新生和关系证据。基础5组、S12、N5和旧Z7均有用户报告PASS，首个中枢入口收到“Z入口正常”。2026-11-04连续中枢Z13（13组91前缀）已由用户报告PASS，正式入口也由用户报告“连续中枢入口正常”。当前25/43，5.3、6.1～6.3及7.3完成、R完成规则仍待证据，不是完整首版。两份旧Pine继续原位保留，未归档。

- [来源与更正索引](sources.md)
- [看盘与研究使用说明](user-guide.md)
- [六组固定行情基准采集](market-baselines.md)：六组均已校验冻结，共6048根；实际图表参数及回放／重载仍待核验。
- [规则工作表](rules.md)：K/F/P/S及N价格区间已核对，N的工程映射由用户选择E-008；R/Z仍待证据。
- [特殊段与标准化映射](normalization-case.md)
- [连续L1中枢与关系证据](center-engine.md)
- [收盘提交与预览共享验证](runtime-validation.md)：新调度版T4及正式入口均已由用户报告通过，旧Z13及正式入口通过记录保留原版本。
- [分析起点与样本上限](analysis-window.md)
- [增量状态与历史保留验证](retention-validation.md)
- [资源停止与输入状态](resource-status.md)
- [R完成原文补查](r-completion-source-audit.md)
- [逐前缀证据](evidence-traces.md)
- [特征序列实现与样例](feature-sequences.md)
- [线段确认与待验边界](segment-engine.md)
- [实现阻塞与解除条件](implementation-blockers.md)
- [实际验证记录](validation.md)
- [S12编译超时与精简验证](compiler-timeout.md)
- [展示实现与验收](display-validation.md)
- [安装与复核步骤](installation.md)
- [公开竞品图例与功能对照](reference-comparison.md)
- [独立样例格式](../../tests/fixtures/chanlun/FORMAT.md)

从仓库根目录运行：

```powershell
node tools/chanlun/check-fixtures.mjs
node tools/chanlun/build-segment-compact.mjs
node tools/chanlun/build-normalization-validation.mjs
node tools/chanlun/build-center-validation.mjs
node tools/chanlun/build-validation-shards.mjs
node tools/chanlun/build-feature-compact.mjs
node tools/chanlun/build-validation.mjs
node tools/chanlun/build-render-validation.mjs
node --test tools/chanlun/check-fixtures.test.mjs tools/chanlun/build-validation.test.mjs tools/chanlun/build-render-validation.test.mjs tools/chanlun/feature-validation.test.mjs tools/chanlun/segment-validation.test.mjs tools/chanlun/segment-compact.test.mjs tools/chanlun/normalization-validation.test.mjs tools/chanlun/baseline-shards.test.mjs tools/chanlun/center-validation.test.mjs
```

检查工具仅核对来源ID、输入与逐前缀预期的契约，保持draft与reviewed分别计数。它不实现另一套缠论算法，也不代替共享Pine内核、TradingView编译、实时与回放验收。

## K/F/P/S共享内核验证

当前主目录54例357前缀中，51 reviewed、3 draft。5组N样例由独立`normalization-validation.pine`驱动，59前缀已由用户报告PASS。L0保留每段自身区间，来源与确认时刻独立；研究视图可开灰色N0#映射。基础18例68前缀已分为KF6／P5／P3A／P3B／I1五个脚本，见installation.md；逐组平台结果见validation.md。其余展开版及S精简生成命令继续保留供对照。

S12及F16精简全套均已有用户PASS记录，无需重跑。F16通过版本4518922b…，16例／101前缀，实际Pine结果及快照见[特征序列说明](feature-sequences.md)和验收记录；合成输入不代替真实行情验证。生产源码未因F16改变，无需重新粘贴正式指标。

展开版生成器仍支持46个reviewed样例：6个K/F、5个P-001资格、6个P-002生命周期、1个OHLC联动、16个特征／起始资格和12个完整S样例。全部47例282前缀中仅递归草稿跳过。输出`tmp/chanlun/kf-validation.pine`及`segment-validation.pine`保留用于对照；S12展开版编译超时后不再推荐作为首轮入口。未知断言字段、缺失／重复内核边界会报错。生命周期与联动检查包括笔的稳定ID、方向、端点、依赖、确认时间、历史前缀、重复输入及深复制隔离；联动还核对未收盘投影不能发布正式确认。

生产研究预览采用收盘提交和未收盘独立副本；最近处理元素保留4个，笔另保留端分型与最后确认摘要，累计计数与成员跨度不随显示预算重设。S模块保留有界未完成笔、独立候选上下文及确认摘要；超限停止本层，不滑动重设已确认前缀。递归依赖仍未实现。显示普通K线支持状态、有效起点、样本截断及未实现模块；没有背驰、买卖点或提醒。

## 当前展示与范围

普通视图默认显示蓝色笔、橙色线段及P#/S#编号，分型编号默认关闭，可单独打开。笔颜色、线宽和字号可调；研究视图附带规则与确认时间信息、可选灰色N0映射及近期合并范围。合并范围不是正式中枢。紫色框来自L1中枢计算，编号L1-Z#1、#2……；面板显示累计形成数，图形保留近期中枢。中枢关系证据不等于已完成L1走势；独立合成展示脚本不能当作实际行情验收。

`chan_stroke_step`消费已封口分型：严格更极端者延伸末笔、相等保留先出现者，合规下一笔成立后才锁定前笔。无效反向分型不会锁笔。未封口分型仅在`chan_stroke_preview`独立副本内影响虚线；不进入正式事件流。chan_segment_step接入两类终结与批量确认，研究视图可开启特征和缺口。走势完成与高层输入仍等待R规则闭合。

连续中枢V2独立验证：`tmp/chanlun/center-validation.pine`，13组91前缀，预期`PASS: 13 Z cases, 91 prefixes`。旧Z7结果保留原版本范围；V2已收到Z13全套PASS，正式入口已由用户报告正常。

## 历史原型的迁移与恢复

`ChanLun` 和 `ChanLun-Strict` 是重建前的两个 Pine 原型，前者是原始实现，后者是按第 62、65、67 课调整的版本。当前均从仓库根目录打开。下表记录本次核对的文件内容和待验收通过后的目标路径。

| 当前路径 | 归档目标 | 当前 SHA-256 |
| --- | --- | --- |
| [chanlun_czsc.pine](../../chanlun_czsc.pine) | `archive/chanlun/chanlun_czsc.pine` | `8be803bf2503a35e566850580982c5f5ff763c65c46df66533aedf61075fc115` |
| [chanlun_czsc_strict.pine](../../chanlun_czsc_strict.pine) | `archive/chanlun/chanlun_czsc_strict.pine` | `8135ee85271e74e1c86f4f0d3011e557a756354fef576782cd6ffe54235392ad` |

待必需验收通过后，迁移前重新读取源文件 SHA-256，迁移后逐一比对归档文件并更新入口链接。迁移后需要恢复时，将归档文件按同名原样复制回仓库根目录，核对哈希并标注其历史原型身份。
