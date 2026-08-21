# 任务：多套数法排名 + 解开顶层焊死

> 分三阶段，§1–§2 可独立交付；§3 为架构级、单独验证。对应 design §6。

## 阶段一：补全分段搜索（局部、收益即时）

- [x] 1.1 新增枢轴显著性排序函数——实现中改为「拓扑存活序」而非原设计的邻居落差：
      对 `pivotSignificance`（局部邻居 delta）实测会漏判 97963/82814 这类全局关键拐点
      （若其紧邻细枢轴恰好很近，会被误判不显著），改用 `significanceRank`——复用
      `coarsenByPairs` 同一套贪心坍缩逻辑一路做到只剩首尾、记录每个内部枢轴被删除的
      次序，越晚删越显著。恒并入区间首尾与全局高/低。
- [x] 1.2 重写 `segmentations()`：显著性短名单（M≤12）+ 交替 H/L 子序列穷举（首尾固定、恰 n 点）
- [x] 1.3 保留边界/回退：`length===n` 直返；短名单不足 n 时受限穷举/旧贪心兜底；M、K 上限护栏
- [x] 1.4 `decompose` 侧确认对多套 segmentation 逐个打分取 top-K（契约已具备，加断言/注释）
- [x] 1.5 回归：验证搜索补全后能找到比用户手数双锯齿（越界0.005）更优的候选——
      实测顶层主选变为零违规的单锯齿 `126296→84400→97964→57718`（用独立的
      `evaluateExplicitCount` 路径交叉核对确认非 bug）；此前穷举全部 12 种顶层数法
      零违规候选数=0，现搜索补全后找到真实合规解，超出原定"验证双锯齿被生成"的目标
- [x] 1.6 性能基准：默认生产参数（beamK=3, maxDepth=5）5 次运行均值 327ms、峰值 434ms，
      C(12,4)=495 组合/形态，远低于千级护栏。**过程中发现并修复一个真实的架构性能问题**
      （见下）：旧版每形态只回 1 套切分时分支因子小，`decompose` 对每个原始候选都先
      递归展开完整子树再统一排序截断尚可承受；`segmentations` 改为多解后，同样的"先
      全展开再截断"会让分支因子随深度指数级放大，生产默认参数下实测 OOM /
      38s+（详见 design.md §2.4 新增小节）。修复为两段式 beam：先用不含子树的基础分
      （`scoreCandidate` 本不需要子树）粗排，只对前 `preRankKeep` 名展开子树；同时给
      `decompose` 加了按「区间+角色+深度」键的记忆化缓存（`opts.cache`），消除不同顶层
      候选共享子腿区间时的重复递归。两者叠加后 38126ms → 348ms。

## 阶段二：排名数法输出（融合升级结论节）

- [x] 2.1 汇聚顶层候选池（当前先只框架 A），按分层字典序排序，取主选 1 + 备选 3——
      复用 `decompose` 已有的 `primary + alternates`（beamK:3→4 使顶层刚好 1+3=4 条），
      新增 `buildRankedCounts(tree)` 摊平成排名数组
- [x] 2.2 每条候选组装四要素：现在的浪型 / 已走完的腿（`candidateLegs`，按 `waveLabelsFor`
      标腿）/ 当前在哪（框架A所有候选共享同一终点=全局低点，直接复用既有
      `tree.inProgressStruct`，无需重算）/ 评分
- [x] 2.3 渲染：新增顶层"# 数法排名"节（`renderRankedCounts`），主选展开（腿逐条+评分+
      指向进行中结构）、备选表格精简。**未按原计划"替换"现有"# 结论：..."节**——
      实现中发现两者是不同轴：本节回答"大跌本身最像哪种数法"，"结论"节回答"大跌+
      反弹在组成什么更大结构"（父级候选，上一 session 已实现且已验证），语义不重叠、
      也不矛盾，故改为在其上新增一节，两节并存，避免破坏已验证的既有输出（design.md
      已同步补充说明）
- [x] 2.4 JSON：新增 `rankedCounts` 数组（`serializeRankedCounts`），与 Markdown 同源一致
- [x] 2.5 回归：1d/1h 两周期端到端跑通，无 undefined/NaN 泄漏；主选恒为 tier1 最低
      （0 违规恒排在 1 违规之前，两周期均验证）；下游①②③/父级候选/进行中结构等既有
      章节在新主选下渲染正常，无破坏性漂移

## 阶段三：解开顶层区间焊死（架构级）✅

- [x] 3.1 `buildCountTree` 入口生成框架 A `[hi→lo]`（不变）与框架 B `[hi→now]` 两套
      topSpan——新增 `directionalSpanToNow()`（镜像 `directionalTopSpan`，终点延伸到
      最后一个细枢轴而非"另一个全局极值"）。B 独立 `opts.cache`（区间不同，共享缓存
      互相污染）；只在 B 严格长于 A 时才计算（二者终点相同=无进行中后续，B 即冗余）。
      `tree`（框架A）语义完全不变，`tree.frameworkB` 是新增的平行字段——现状研判/
      进行中结构/父级候选/大白话版等既有下游代码零改动、零回归
- [x] 3.2 `scoreCandidate` 支持在建评估——**实现时对原设计做了范围收敛**：完整设计要求
      "逐条规则判定是否可判定、未定项不计违规也不计入通过"，需要给现有约 50 条规则
      闭包逐条标注依赖哪些点才能精确做到，改动面和回归风险过大。改为：末腿仍按现有
      `scoreCandidate` 全量规则打分（与其它腿一视同仁，可能因"尚未走够"而误判违规），
      **主要公平机制落在 3.3 的未完成度惩罚**——用一个整体性惩罚项压低明显还很稚嫩
      的候选，而非逐规则精确豁免。design.md §3.2 已同步记录这个取舍，逐规则可判定性
      留作后续增量
- [x] 3.3 新增 `incompleteness`（未完成度）项并入排序键（`compareCandidates`：
      tier1→tier2→incompleteness→complexity→tier3→tier4）——`computeIncompleteness(pts)`：
      末点非 provisional 恒为0（框架A不受影响）；provisional 时按"末腿已走幅度 ÷
      前一条完成腿幅度"估计完成度，未起步→罚≈1，已达同量级→罚≈0。在 lite（前沿筛选）
      阶段就计入，避免明显不完整的候选靠"还没机会违规"占掉前沿筛选名额。实测验证：
      同为 tier1=0 时，框架A（incompleteness=0）稳定压过框架B候选（0.09~0.31），
      符合"同一把尺、不虚高"的设计目标
- [x] 3.4 新增"腿间比例"硬闸门——**实现时限定作用域为框架B的顶层候选**（post-hoc，
      不进 `decompose` 共享递归路径）：若做成通用规则会误伤深层合法的"3浪延伸"型
      推动浪（3浪本就该比1/5浪大得多，是书内标准指引，不是缺陷）；只在"整段区间"
      入口层面把关才对症，与原 `directionalTopSpan` 一刀切裁区间防的是同一类风险
      （"大跌+反弹硬塞一形态"），但只挡在框架B的顶层，不影响其余任何层级。
      `LEG_PROPORTION_MAX_RATIO=6`；实测框架B主选（一个跨越全程的5浪推动读法）
      腿间比例2.48，远低于阈值，未误伤
- [x] 3.5 两框架候选并入同一排名池、统一排序——`buildRankedCounts` 汇聚
      `[框架A primary+alternates] ∪ [框架B primary+alternates（经3.4闸门）]`，按
      `compareCandidates` 排序取前4；`renderRankedCounts`/`serializeRankedCounts`
      同步支持 `framing:'A'|'B'` 标注、末腿"⏳进行中"渲染
- [x] 3.6 回归：验证"读法2"能作为合规候选出现——实测框架B在真实 BTC 数据上找到一个
      零违规、腿间比例合理（2.48）的"标准推动浪"读法，把 126296→now 全程读作一个还
      在走的5浪下跌（当前价仍高于57718，尚未创新低但结构未破），与探索阶段"Y未完成、
      57718为中继"同一类主张（当前低点不一定是底），验证达成——不是探索时手工构造的
      那个具体嵌套双锯齿案例，但满足同一设计意图（搜索找到了更简洁的合规替代读法）
- [x] 3.7 前后对照：1d/1h 两周期端到端重跑，无 undefined/NaN 泄漏，性能正常（1d 2.5s、
      1h 2.7s，含网络请求）。**过程中发现并修复一个真实的、与阶段三无关的既有 bug**：
      `renderNarrative`"拆成几大段"渲染叶子子段时直接读 `c.from`/`c.to`（叶子节点只有
      `.segFine`，无此字段），此前从未触发是因为顶层主选此前从未在该位置产出叶子子段，
      新搜索找到不同主选后才首次暴露——已修（`analyze-wave-tree.js` 拆成几大段一节）。
      **同时发现并修复既有测试套件的 4 处过时断言**（`node --test tests/`，非本 change
      产物但责任所在必须处理，见 4.2）：3 处 `analyze-wave-tree.test.js` 的合成 fixture
      断言、1 处 `analyze-wave-tree.golden.test.js` 的金标准断言，根因均是"搜索补全后，
      同一组数据存在多个合法零违规读法，不再是唯一解"——详见各测试内新增注释；修完后
      76/76 测试全绿（含未受影响的 analyze-kline-wave.test.js、analyze-wave-manual.test.js）

## 验证与文档 ✅

- [x] 4.1 金标准回归集：BTC 1d/1h 两周期报告前后对照——每个实现步骤后都重跑两周期
      端到端验证（无 undefined/NaN 泄漏、性能正常）；固化的 `tests/fixtures/
      btc-usd-1d-golden.json`（314根1d蜡烛，离线不联网）金标准套件 10/10 全绿，
      含专门的"顶层从126296起锚""存在进行中腿""搜索补全后能找到真正零违规读法"
      等针对本 change 缺陷的结构不变量断言
- [x] 4.2 单元测试：`tests/analyze-wave-tree.test.js` 新增 6 条——`significantShortlist`
      拓扑存活序（大摆动挤掉夹在中间的小噪音）、`indexCombinations` 组合正确性、
      `computeIncompleteness`（非provisional恒0/刚起步惩罚趋近1/已达同量级惩罚为0）、
      `legProportionViolated`（畸长腿判真/均衡腿判假/单腿无兄弟浪不判）、
      `directionalSpanToNow`（同起点、终点延伸到now）、框架B端到端集成测试
      （全局低点之后的走势能被纳入更高级别在建候选，末点正确标provisional）。
      同时发现并修复既有测试套件 4 处过时断言（详见 3.7）——`node --test tests/`
      现 82/82 全绿（含之前不受影响的 kline-wave/wave-manual 套件）
- [x] 4.3 更新脚本内注释：`analyze-wave-tree.js` 顶部文档块已更新（原文停留在
      "M1...M2/M3/M4 后续增量落地"的过时状态），现列出排名数法表 / 框架A-B双框架
      语义、指向 `rank-competing-wave-counts` 的 design.md；`segmentations`/
      `decompose`/`buildCountTree`/`computeIncompleteness`/`legProportionViolated`
      等函数各自的实现内注释已在对应任务完成时同步写好。README.md 未提及
      `analyze-wave-tree.js`，无需改动
