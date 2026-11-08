# 当前研究预览的安装与复核

状态面板位于图表右上角，使用浅色文字和实色深底，计数分行显示“确认线段”“L0 标准部件”“L1 中枢”。面板字号至少14，可用“提示字号”继续放大。更新代码后重新添加／更新到图表才会应用新面板；例如确认线段54、L0 54表示每段均对应一个标准部件。

当前生产研究入口已接入包含处理、分型、蓝色笔、橙色线段、独立区间L0和连续L1中枢。基础5组、S12、N5及首个中枢Z7已有用户报告PASS；连续中枢V2的13组91前缀已由用户报告PASS，正式入口也已由用户报告正常。自然递归走势完成及升层未完成。以下步骤用于编译复核，不表示完整平台验收通过。

## 生产研究入口

1. 用文本编辑器打开仓库根目录`chanlun_original.pine`，复制完整内容，第一行保留`//@version=6`。
2. TradingView打开普通K线图，Pine编辑器中新建指标，将默认代码全部替换。
3. 保存后点击“添加到图表”。报错时记录第一条错误的行号与完整文字。
4. 编译成功后应显示“包含 / 分型 / 笔 / 段”状态面板；数据具备合规笔时显示蓝色实线和P#编号，笔和段的未锁定尾部为虚线；线段标注S#，确认数会独立显示。确认数不足时不会凭空补线。
5. 普通／研究模式中分别检查字号、颜色、标签间隔；研究模式额外检查近期合并范围和确认标记。

“笔”和“线段”分组分别控制显示、编号、颜色和线宽；线段依赖超限会提示并停止该层确认，不回退近似算法。“分型”分组可打开默认关闭的F标记。固定起点用于复现；默认近期窗口用于日常观察。请求起点不在已加载历史内会提示历史不足。编号P/S/F是结构身份，不是买卖点；K合并框不是中枢。图表时间周期与未来L1～L3结构层级不直接等同。

## 同一内核的验证入口

显示控制D4：tmp/chanlun/display-controls-validation.pine，图表至少21根历史K线以显示合成图例，预期PASS: D4, 4 cases。检查配额、编号筛选／关闭、退化边界与绘图隔离；可临时调节编号间隔、边框线宽和编号开关查看图例。D4已收到用户PASS；当前测试图例已改为独立窗格（新排版未平台复测），图例不是行情识别结果；显示控件正式入口已由用户报告正常，详见user-guide.md和display-validation.md。

资源状态B5：tmp/chanlun/budget-validation.pine，至少5根已收盘历史K线，预期PASS: B5, 5 cases。检查预算停止、上游继续、未来输入不重启、门控与状态优先级；B5及新正式入口均已由用户报告通过。固定起点100根人工截断复核也已由用户明确报告通过，详见resource-status.md。

增量保留G3：tmp/chanlun/retention-validation.pine，需要338根已收盘K线，预期PASS: G3, 338 prefixes。检查K/F尾部保留、S已归属笔回收、20个中枢裁剪到最近15个后继续计算。G3已由用户报告PASS；此次生产源码未改，不需因G3再次更新正式指标；窗口入口100根截断也已由用户明确报告通过，详见retention-validation.md。

当前窗口版新增W8：tmp/chanlun/window-validation.pine，至少44根已收盘K线，预期PASS: W8, 44 prefixes。该脚本已由用户报告PASS，接下来复核正式入口的请求／接收／有效起点及上限提示。旧T4与旧正式入口通过记录保留原版本，不自动覆盖新增窗口版，详见analysis-window.md。

2026-11-05新增共享调度验证：tmp/chanlun/runtime-validation.pine，需38根已收盘K线，预期PASS: T4, 38 prefixes。检查合成tick隔离、收盘去重、S→N→中枢同批顺序和双笔预览；它不是实际行情多tick验收。当前正式入口已接入新调度，用户已报告“调度入口正常”；旧Z13及连续中枢正式入口通过记录只绑定旧版本。T4及新正式入口均已由用户报告通过，详见runtime-validation.md。

2026-11-04连续中枢版：运行`node tools/chanlun/build-center-validation.mjs`后，将`tmp/chanlun/center-validation.pine`作为新指标添加到图表，需至少91根已收盘K线，预期`PASS: 13 Z cases, 91 prefixes`。它使用生产同一内核，覆盖离开／回试、第二及第三中枢、上下延续、波动范围重叠、关系变化和预算停止，不验证R完成。

V2正式入口开启“显示L1中枢”后绘制紫色框和L1-Z#序号；零宽核心显示边界线。数量由实际确认L0结构决定，不保证每个窗口都有多个。面板“L1 中枢”为累计形成数，时间／价格指向最近形成中枢。图形预算保留近期中枢，累计数可大于可见框数；关闭显示仍继续计算。关系提示为当前证据，“走势完成规则仍待核对”仍是预期。共享验证通过后再复核正式入口。

面板L0计数应等于确认段数。研究视图打开“研究：显示L0标准化映射”可查看灰色N0#独立区间。提示列出真实／分析端点、高低来源及确认时间；分析时间使用原段边界锚点，不表示该价格在边界时刻成交。映射价格允许不接续；显示开关不参与计算。

新增入口：`node tools/chanlun/build-normalization-validation.mjs`生成`tmp/chanlun/normalization-validation.pine`，5组59前缀，需要59根已收盘图表K线，预期`PASS: 5 N cases, 59 prefixes`。本版已由用户报告通过。

`node tools/chanlun/build-validation-shards.mjs`生成`tmp/chanlun/baseline/`下5个基础新指标：kf.pine（KF6，6例24前缀）、p-qualification.pine（P5，5例5前缀）、p-lifecycle-a.pine（P3A，3例12前缀）、p-lifecycle-b.pine（P3B，3例15前缀）、ohlc-integration.pine（I1，1例12前缀）。共18例68前缀，单文件约58～161 KB；每组只报告本组PASS，在首根图表K线检查合成输入。manifest记录覆盖及哈希；实际运行进度见validation.md。

2026-11-03：基础五组均已由用户报告PASS。I1先报函数体过长CE10296，拆分后又触发编译token上限；使用共享重放循环的约157 KB修正版已通过。通过版本和快照见validation.md，生产指标无需因此重复编译。

```powershell
node tools/chanlun/build-segment-compact.mjs
```

旧的展开版S12脚本收到编译超时反馈，先使用精简入口：

1. 将`tmp/chanlun/segment-compact/smoke.pine`作为新指标粘贴并添加到图表。约59 KB，只检查S-FIRST-WAIT-INCLUSION的10个前缀，图表需至少10根已收盘K线；历史加载时自动推进，无需逐根等待实时收盘。
2. 预期面板为`PASS: 1 S case(s), 10 prefixes`。若报错，记录第一条完整错误；若仍为RUNNING，检查图表已加载的收盘K线数。图表OHLC不会进入合成样例内核。
3. 单例通过后，再运行`tmp/chanlun/segment-compact/all-cases.pine`。约83 KB，12例、110个前缀及资源停止检查，需111根已收盘图表K线，预期`PASS: 12 S case(s), 110 prefixes, budgets`。单例PASS不能代替这一步。
4. `cases/`下另有12个独立样例，供按失败样例定位；每个脚本只报告自身覆盖范围。`manifest.json`记录源文件、CORE、样例哈希、所需K线数与待执行状态。

精简脚本使用生产原文CORE与相同独立预期，以共享断言函数检查逐前缀状态、端点、事件、成员极值、重载、去重及隔离。仅脚本体积缩小，本地测试不能证明云端超时已修复。不要连续重试已超时的展开版；若平台显示限制，以编辑器提示为准。详见[超时记录](compiler-timeout.md)。

`node tools/chanlun/build-validation.mjs`仍生成展开版`tmp/chanlun/kf-validation.pine`（46个reviewed样例）及`tmp/chanlun/segment-validation.pine`（12例S），用于对照审计；当前不将这两个大文件作为首轮编译入口。K/F/P及特征序列尚未取得完整平台断言结果。

## 同一绘图区的合成展示入口

```powershell
node tools/chanlun/build-render-validation.mjs
```

将`tmp/chanlun/render-validation.pine`作为独立新指标运行。图表需至少20根历史K线，状态表明确写“合成展示样例 · 非行情分析”。笔与中枢图例仍有假定记录，橙色段则来自同一S内核对合成已锁定笔的实际计算；研究模式另显示真实特征处理结果，检查E元素、缺口候选与绘制隔离。两者均不是行情识别结果。逐项执行[展示清单](display-validation.md)，记录普通／研究模式、参数、脚本哈希和截图；未执行项保留未执行。

## 数据与权限记录

六组同源采集方案与CSV导入步骤见market-baselines.md；采集辅助脚本tools/chanlun/market-capture.pine不会修改正式指标。当前仅计划与导入工具已准备，实际CSV、脚本编译及图表参数尚待采集，不能把本地测试CSV当作真实数据基准。

正式验收仍须在选定的BTC/ETH六组合上固定feed、OHLC、起点与参数进行编译、回放、重载、实时多tick及资源检查。当前没有完成这些检查；其他数据源或合成展示不能替代。实际进展见[验证记录](validation.md)。
