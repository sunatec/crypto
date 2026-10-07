# P1 修复验收记录

已实施历史审计 [review.md](D:/Workspace/crypto/reports/wave-book-audit/review.md) 的 F02–F13、F15。全量 **219/219 通过**，失败/取消/跳过均为0，退出码0；新增 [43项 P1 回归](D:/Workspace/crypto/tests/wave-book-p1.test.js)。原有审计报告、24项书籍案例记录及书籍规则基线保留；本文件记录修复后的实现。OpenSpec：[fix-book-audit-p1](D:/Workspace/crypto/openspec/changes/fix-book-audit-p1/tasks.md)。

依据顺序：用户提供的本地《波浪理论详解》及明确勘误 → 当前实现 → 补充理论。本次未以外部理论新增判错规则。唯一用户勘误 [OV-001](D:/Workspace/crypto/reports/wave-book-audit/book-rule-overrides.md) **Y＞90%W保持软指引**；测试Y=.879W仅减少指引命中，不因此invalid。EPUB没有固定页码，下面引用小节和稳定提取段落。已提供文件只有前言及第1–7章。

## 书籍规则、代码与结果

| 审计项 | 原问题类别 | 书籍依据 | 修复位置 | 修复后行为 |
| --- | --- | --- | --- | --- |
| F02 | A/B：开闭边界 | [§4.1 p0016](D:/Workspace/crypto/reports/wave-book-audit/book-extract/ch005.md:33)；[§7.1 p0022](D:/Workspace/crypto/reports/wave-book-audit/book-extract/ch008.md:45)、[§7.1 p0026](D:/Workspace/crypto/reports/wave-book-audit/book-extract/ch008.md:53)；[§6.2 p0033](D:/Workspace/crypto/reports/wave-book-audit/book-extract/ch007.md:68) | [normRange](D:/Workspace/crypto/analyze-wave-tree.js:162) | 分别指定严格/含等号边界；C=5B、X=W、Y=X、XX=Y、Y/Z=5倍不通过；Z=XX、D=C保留。U02/U04见下文。 |
| F03 | A：子角色过宽 | [§5.1 p0007](D:/Workspace/crypto/reports/wave-book-audit/book-extract/ch006.md:15)；[§6.4 p0070](D:/Workspace/crypto/reports/wave-book-audit/book-extract/ch007.md:147) | [PATTERNS/ROLE_MAP](D:/Workspace/crypto/analyze-wave-tree.js:1053) | 推动/楔形2排除三角；平台A/B非三角；三角A/B/C/D/E分别约束；联合W与非末位Y不得三角，X/XX非三角；末位Y/Z可三角。 |
| F04 | A：三角形约束缺失 | [§6.2 p0021](D:/Workspace/crypto/reports/wave-book-audit/book-extract/ch007.md:44)、[§6.14 p0025](D:/Workspace/crypto/reports/wave-book-audit/book-extract/ch007.md:52)、[§6.2 p0036](D:/Workspace/crypto/reports/wave-book-audit/book-extract/ch007.md:74) | [triangleGeometry](D:/Workspace/crypto/wave-book-validation.js:40)；[triangleExcursion](D:/Workspace/crypto/wave-book-validation.js:54)；[evaluateChildRoles](D:/Workspace/crypto/analyze-wave-tree.js:1649) | AC/BD收缩、交点在E后、AC不可水平、顶点价格区间；B不可越线，C/D按10% C gross、E按10% D gross；A/C/D第二子浪<105%；EE上下文及缓存禁止再三角。 |
| F05 | A：父子禁止组合缺失 | [§4.1 p0012](D:/Workspace/crypto/reports/wave-book-audit/book-extract/ch005.md:25)；[§5.3 p0053](D:/Workspace/crypto/reports/wave-book-audit/book-extract/ch006.md:112)；[§7.1 p0040](D:/Workspace/crypto/reports/wave-book-audit/book-extract/ch008.md:81)、[§7.4 p0082](D:/Workspace/crypto/reports/wave-book-audit/book-extract/ch008.md:172) | [parentChildIssues](D:/Workspace/crypto/wave-book-validation.js:76)；[evaluateChildRoles](D:/Workspace/crypto/analyze-wave-tree.js:1649) | 实际采用A/C不能同时衰竭或同时为引导/终结楔形；平台C-5不能衰竭；双/三锯齿W/Y的C不可失败；Y/Z完整路径查0-X；三锯齿Z不能同时price>5X且time>5X。优先寻找本层规则通过且父子兼容的实际子候选。 |
| F06 | A：3≥1过度限制 | [§1.5 p0084](D:/Workspace/crypto/reports/wave-book-audit/book-extract/ch002.md:186) | [buildImpulseStrictManual](D:/Workspace/crypto/analyze-wave-tree.js:361)；[buildCurrentWaveStructures](D:/Workspace/crypto/analyze-wave-tree.js:2223) | 删除3≥1的硬下限，保留3不能最短；在建5只使用已观察到的定向长度下界，不把第二长3先判错。4.236上限属于原有来源待补规则。 |
| F07 | A/U：扩散终结特例 | [§4.6 p0067](D:/Workspace/crypto/reports/wave-book-audit/book-extract/ch005.md:150) | [buildExpandingEndingManual](D:/Workspace/crypto/analyze-wave-tree.js:500) | 加入5/C可用的扩散终结候选，单列张开边界，不套收缩阈值；扩散C须越过A终点。第11章未提供，sourceIncomplete阻止完整verified。 |
| F08 | A/B/C：路径与度量 | [§6.20 p0230](D:/Workspace/crypto/reports/wave-book-audit/book-extract/ch007.md:516)；[§3.16 p0123](D:/Workspace/crypto/reports/wave-book-audit/book-extract/ch004.md:267)；[§3.8 p0070](D:/Workspace/crypto/reports/wave-book-audit/book-extract/ch004.md:152) | [waveFourGate](D:/Workspace/crypto/wave-book-validation.js:21)；[percentageThirdGate](D:/Workspace/crypto/analyze-wave-tree.js:334)；[truncatedFifthGate](D:/Workspace/crypto/analyze-wave-tree.js:349)；[resolveParentPathRules](D:/Workspace/crypto/analyze-wave-tree.js:1707) | 2/4检查完整OHLC；4必须避开1全部子浪区域，不能只用1终点。另查运动百分比3非最短及衰竭5≥70%4 gross。共享起点K线顺序影响结论时pendingRules，较小周期实际路径独立复核；已知后续违规继续硬失败。 |
| F09 | A：作者浪级 | [§7.2 p0066](D:/Workspace/crypto/reports/wave-book-audit/book-extract/ch008.md:135)；[§1.7 p0143](D:/Workspace/crypto/reports/wave-book-audit/book-extract/ch002.md:323) | [childDegreeOffset](D:/Workspace/crypto/wave-book-validation.js:115)；[serializeNode](D:/Workspace/crypto/analyze-wave-tree.js:3813) | Y比W低一级，Z再低一级；degree与recursionDepth、timeframe分开。连接段X/XX随其连接层级的写法是序列化约定。 |
| F10 | B/C：有限证据无法终止 | [§3.23 p0192](D:/Workspace/crypto/reports/wave-book-audit/book-extract/ch004.md:418) | [atResolutionBoundary](D:/Workspace/crypto/analyze-wave-tree.js:1700)；[scopedVerification](D:/Workspace/crypto/analyze-wave-tree.js:1746)；[createSubwaveVerifier](D:/Workspace/crypto/wave-subwave-verification.js:39) | 显式最细1h/4h且完整连续OHLC、本层已识别并无已知硬失败的下级结构，可声明分辨率边界；根仍要求直接子结构。未知叶子、缺行情、深度/预算耗尽、未收盘端点不能证明。 |
| F11 | B/C：完成/评分不一致 | [§2.5 p0021](D:/Workspace/crypto/reports/wave-book-audit/book-extract/ch003.md:45)；[§3.5 p0036](D:/Workspace/crypto/reports/wave-book-audit/book-extract/ch004.md:81) | [completion](D:/Workspace/crypto/wave-book-validation.js:106)；[applyInProgressRuleGate](D:/Workspace/crypto/analyze-wave-tree.js:3116) | 四态独立；固定末点不再直接写完成。仅本段在建的适用下界延后判定，实际排名/违规/严重度/显示同步；历史Y和上界不豁免。 |
| F12 | B/C：证据计数与采用不一致 | [§3.5 p0039](D:/Workspace/crypto/reports/wave-book-audit/book-extract/ch004.md:87) | [evaluateLegRole](D:/Workspace/crypto/analyze-wave-tree.js:1556)；[evaluateChildRoles](D:/Workspace/crypto/analyze-wave-tree.js:1649) | 只以直接角色为证明单位；本层规则通过或未知后代不累积为provenRoles。采用的小时树进入父树，保存其自身索引、timeframe、scope；改选候选同步evidence。 |
| F13 | B/C：标签强行改写 | [§4.5 p0050](D:/Workspace/crypto/reports/wave-book-audit/book-extract/ch005.md:104)；[§7.3 p0072](D:/Workspace/crypto/reports/wave-book-audit/book-extract/ch008.md:147) | [deriveCurrentInternal](D:/Workspace/crypto/analyze-wave-tree.js:2885)；[buildCurrentWaveStructures](D:/Workspace/crypto/analyze-wave-tree.js:2223) | 局部数字/ABC/WXY标签来自当前采用结构；父级联合不自动把内部ABC改成WXY。父级W限制简单调整；当前位置模板声明scenarioOnly、各腿证据与状态。 |
| F15 | B：短C候选被裁掉 | [§4.7 p0073](D:/Workspace/crypto/reports/wave-book-audit/book-extract/ch005.md:163)；[§3.15 p0107](D:/Workspace/crypto/reports/wave-book-audit/book-extract/ch004.md:233) | [directionalTopSpan](D:/Workspace/crypto/analyze-wave-tree.js:2036) | 根搜索保留正统末端与原极值区间两类候选；不再把全局极值锚应用于所有合法结构。默认路径100→60→80→61可保留单锯齿候选，子浪不足仍pending。 |

A=违反书籍已明示规则；B=实现或证据传播错误；C=书未明确规定的工程处理；U=来源不足/书内冲突。混合类别已分开说明，不能把算法策略冒充书中硬规则。

## 可复核的关键反例

- C=5B、X=W、Y=X严格边界失败；D=C及Z=XX按允许等号保留。Y=.879W不因OV-001被判错。
- 推动1=50、3=40、5=20保留3第二长；绝对价格长度与运动百分比分别测试。
- 4端点合法、内部K线越过1区域时失败；1终点低于其最高子浪时，4仍须避开整个1区。只有共享起点K线极值可能属前一浪时标待验证；较小周期采用路径可以解除这个待定条件，不能顺带证明其余子角色。
- 平台C-5衰竭、A/C同时衰竭、W/Y失败C、三角105%/EE以及Z对X的价时组合约束均有反例。父子兼容候选选择测试中，结构本层由引擎评分，提供者标pending；没有伪造verified证明。
- 短C 100→60→80→61通过默认完整搜索路径进入单锯齿候选；这不代表其内部5-3-5已证明。
- 完整离线合成小时OHLC经过真实createSubwaveVerifier→detectPivots→decompose路线，可识别直接5个子结构并获得声明范围的verified；该用例没有mock注入verified。边界以下叶子仍pending且resolutionBoundary=true。缺K线、耗尽递归、未收盘小时和缺端点证据继续pending。
- 已采用小时树的索引/周期/验证范围进入日线父树；未决兄弟保留pending。当前内层数字浪不因父级联合名称改写为WXY；JSON与Markdown一致。

上述是依据引证判据构造的离线规则/工程回归，不是将书中全部图例数字化为原始历史OHLC，更不是实盘识别准确率。已保存BTC fixture参与全量回归；本次没有重新执行BTC --end now联网分析。

## 状态与证据的工程约定

`verificationStatus`衡量声明范围内的结构证据；`completionStatus`衡量浪完成观察，两者独立。形成中=`forming`；固定末点但缺独立完成确认=`potentially_complete`；已知硬失败=`invalidated`。`confirmed_complete`预留给结构已验证且调用者提供明确completionEvidence的路径；当前引擎没有从比例、时间、暂时高低点自动生成确认。本书暂未提供统一机器确认公式，这里不能借通用理论擅定公式。

共享起点K线的high/low没有事件先后信息。2/4路径、衰竭70%及价格运动百分比使用包含/排除不明起点极值的可确定范围：能确定失败则失败，能确定通过则通过，其余记录pendingRules，并用实际采用的较小周期路径复核。这是数据证据处理，不是书籍新增例外。缺OHLC时只检查给定点路径，不能声称完整K线证据成立。

最细1h/4h是受§3.23启发的显式工程选择，书中没有规定日线必须下探到这个周期，也没有规定这些豁免项。终止边界不豁免已知本层硬反例，未知叶子不算证明；底层已识别结构的更细子角色以exemptedRoles/verificationScope公开。父级verified只表示这个有限范围，不表示无限细分或浪已完成。时间周期不作为作者degree。

## 来源限制与保留项

- 缺第8–11章：联合形/推动浪/楔形详章仍待补。扩散终结候选允许参与假设，但缺专章无法完整verified；不能据此宣称此前BTC扩散候选成立。
- U01楔形4必须切入1还是2的书内冲突保留原有默认；U02单锯齿c/b=.9采用§4.1手册的≥；U04平台b/gross(a)下限≥.7、上限<2；U08三锯齿X是否允许三角存在冲突，保留§7.1/7.3的允许解释；U11三角顶点价格采用§6.6较长A/B区间，详述/问答冲突继续登记。参见书籍规则基线歧义表。
- 连接浪X/XX的degree随连接层次写入属于序列化约定；书明确给出的是Y/Z递降。没有把递归深度或小时周期当作作者浪级。
- .236–.886、4.236等原有来源待补比例、严重阈值/复杂度惩罚及搜索预算属于历史审计P2范围，未重新宣称是书籍硬规则。OV-001已明确排除修复。
- P0合法候选池隔离仍为独立任务；本次修复P1不等于所有根主选都已具有完整合法证据。全历史前缀回放、repaint/hindsight量化审计和完整书例历史数据归档仍是原审计P3范围，未凭回归通过宣称解决。

## 验证与文件追溯

命令：`node --test --test-reporter=tap tests/*.test.js`（验收实际展开8个测试文件，完整参数见receipt）。3个实现文件通过node --check；OpenSpec严格校验与git diff --check通过。测试结果JSON、完整TAP日志与源文件SHA256见下方凭据。

[验收凭据](D:/Workspace/crypto/reports/wave-book-audit/p1-validation-receipt.json)；[完整TAP日志](D:/Workspace/crypto/openspec/changes/fix-book-audit-p1/validation-tests.log)；[相对P1开始前两份实现快照的差异](D:/Workspace/crypto/openspec/changes/fix-book-audit-p1/implementation.patch)。差异文件只包含两个原有实现文件；新增helper/测试可直接阅读，既有用户改动未重置。
