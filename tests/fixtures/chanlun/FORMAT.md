# 独立样例格式 v1

运行检查：`node tools/chanlun/check-fixtures.mjs`。检查器只验证数据契约与预期的内部一致性，不执行缠论算法，不代表 Pine 测试通过。

每个 `*.json` 文件是一例，使用 UTF-8。预期必须人工推导，禁止把待测实现的输出自动回填。

## 顶层字段

| 字段 | 类型／约束 |
| --- | --- |
| schemaVersion | 固定整数1 |
| id | 唯一非空字符串 |
| ruleVersion | 规则工作表版本 |
| ruleIds | 非空规则ID数组，均须在 rules.md 中存在 |
| expectationStatus | `reviewed`：预期已人工核对；`draft`：待核对，不可计入通过数 |
| construction | `synthetic`、`diagram-annotation` 或 `market`，说明数据性质 |
| source | `{category, sourceIds, lesson, pdfPages, figure, note}`；category为来源分类，页码1起算，figure可为null |
| tickSize | 正十进制字符串，例如 `"0.01"`；所有价格以整数tick表示 |
| input | 通常为`{kind, items}`；kind为`ohlc`、`completed-components`、`fractal-pairs`、`confirmed-fractals`；`feature-strokes`另带context |
| expected | 每个输入前缀恰好一个 `{prefix, state, structures, events, reason}` |

来源分类：`author-body`、`author-correction`、`editorial`、`unverified-annotation`、`engineering`。合成数据与来源分类独立；按正文构造的合成数据不等于原文行情。

## 输入

OHLC项：`{id,time,closeTime,openTicks,highTicks,lowTicks,closeTicks}`。时间均为UTC毫秒，严格递增、区间不能交叉，OHLC在高低区间内。输入时间戳不能用本地日期字符串替代。

已完成部件项：`{id,startTime,endTime,completedAt,startTicks,endTicks,lowTicks,highTicks,direction,dependencies}`。方向为 `up/down`；真实端点位于实际区间内，完成时间不早于端点时间；dependencies为低层输入ID。相邻部件允许共享边界；不强迫所有低层连接都映射为恰好次一级。

## 预期

`state` 是模块可观察字段的非空字典，目前允许：`processedCount`、`direction`、`tailLowTicks`、`tailHighTicks`、`tailLowTime`、`tailHighTime`、`effectiveStart`、`candidateKind`、`confirmedFractals`、`coreLowTicks`、`coreHighTicks`、`movementComplete`、`completionEvents`、`ruleBlocked`、`extentEndTime`、`ggTicks`、`gTicks`、`dTicks`、`ddTicks`，以及完整S预期的`confirmedSegments`、P模块的`confirmedStrokes`、`strokeCandidateStartTime`、`strokeCandidateEndTime`、`strokeCandidateStartTicks`、`strokeCandidateEndTicks`、`strokeDirection`。`strokeDirection`为`none/up/down`；无候选笔时四个候选端点字段为null。未来新增字段须同步检查器和格式文档。

`structures` 保存当前前缀可用的对象：`{id,type,level,status,direction,startTime,endTime,startTicks,endTicks,confirmedAt,dependencies}`。type为 `fractal/stroke/segment/normalized/center/movement`；status为 `candidate/confirmed`；direction对分型为 `top/bottom`、中枢为 `none`、其他结构为 `up/down`。候选的confirmedAt为null；确认对象的形成锚点、确认时间及依赖在未来前缀不可改变；中枢延伸的可增长时间范围放在state.extentEndTime，核心和Z波动统计分别放在state的对应字段，不移动形成锚点。分型可令start=end，其极值来源不等同确认时刻。

`events` 只保存该前缀新发生的确认，不重复列以前事件：`{id,type,objectId,occurredAt,confirmedAt}`。objectId必须指向该前缀一个confirmed结构。事件确认时间不超过该前缀最新输入的可用时间，且不早于发生时间；同一事件与对象确认均不得重复。

`reason` 必须说明人工推导理由。缺事件明确写 `[]`，不能省略未发生事件的前缀。每个曾经确认的对象在后续快照继续列出；候选可以变化或消失。结构依赖只能引用当前前缀输入或该快照中的结构，必须无环；确认对象不能依赖尚未确认或晚于自身确认的对象。

图形只有相对关系而无精确行情时，保留原图定位；为自动化构造的数值输入须标为synthetic，不能声称复原精确OHLC。尚未冻结的递归预期必须为draft，或只记录已核实的禁止确认约束，不能伪造完整走势完成预期。

## 已确认分型对：P-001资格样例

`fractal-pairs`的每项为`{id,first,last}`，first/last分别包含`{id,kind,endpointTime,priceTicks,confirmedAt,leftId,middleId,rightId,leftOrdinal,middleOrdinal,rightOrdinal,middleHighTicks,middleLowTicks}`。kind为top/bottom；成员序号连续、身份映射一致，价格对应分型极值，时间保持因果顺序。输入假定是合规已确认分型，不声称仅凭这些字段重建完整OHLC。

每项对应的预期state只能为`{strokeEligible:boolean}`，structures与events均为空。资格成立不产生已确认笔或完成事件；该驱动不验证P-002同类筛选和末笔锁定。逐项预期由人工给出，检查器不计算资格作为正确答案。

## 已确认分型流：P-002生命周期样例

`confirmed-fractals`的每项直接采用上面的first/last分型字段。全流的成员ID与处理元素序号保持一一映射；端点时间严格递增、确认时间不递减。每项是一条已封口分型输入，不能将未封口候选伪装成正式输入。

逐前缀state使用P模块字段，structures明确列出候选笔及所有历史确认笔，events只列本前缀新锁定的一笔。候选笔依赖两端分型，确认笔额外保留证明下一合法笔成立的第三分型；确认时间是该证据的确认时刻。共享Pine驱动持有事件原引用，以检查后续输入是否非法改写已锁定对象，并核对前缀重载、重复输入及深复制隔离。

## 特征序列输入与预期

`feature-strokes`输入为`{kind,context,items}`。context固定为`{segmentDirection,initialDirection,postDirection,boundaryTime,secondSequence,maxElements,maxSources}`。段方向为up/down，两种合并上下文方向为waiting/up/down；分界为UTC毫秒或null，不能落在任何输入笔内部；secondSequence为布尔，两个预算为正整数。方向参数是显式注入的已知上下文，不代表本驱动已经识别完整线段。

每个items项为`{id,startTime,endTime,completedAt,startTicks,endTicks,direction,ordinal,dependencies}`，假定已锁定合法笔；时价端点首尾连接、方向交替，序号连续，确认不早于端点。structures和events均为空，不能用特征序列诊断制造段确认。

每个state固定为`{inputCount,selectedCount,mergeDirection,boundaryCuts,waitingDirection,blocked,heldId,turnKind,gap,seedEligible,features}`。turnKind为none/top/bottom，gap在无特征分型时为null；seedEligible单独断言前三笔起始资格。heldId在方向未知或预算不足时指向保留的未决笔。相同上下文进入等待／受限后不能凭后续输入自动重启。

features项固定为`{id,lowTicks,highTicks,lowTime,highTime,firstTime,lastTime,firstOrdinal,lastOrdinal,firstSide,lastSide,availableAt,sealed,sourceIds}`。sourceIds为有序原笔ID，不可丢失、重复或引用未选中的方向；各极值必须能定位回原笔端点。firstSide/lastSide为假设分界前0／后1。第一序列单个标准元素不得跨两侧，第二序列允许合并来源跨标记。sealed标准元素在后续前缀保持不变；此字段不表示线段已经确认。

## 完整线段的独立预期

`S-FIRST-*`及`S81-*`复用`completed-components`格式，source.note明确每项为已锁定合法笔，state使用整数`confirmedSegments`，其值必须与快照内确认segment对象数一致。只断言不可改写的确认前缀及事件，不强制未锁定候选展示集合。当前S共享驱动已覆盖12例，另有独立S验证输出；reviewed及脚本生成均不表示Pine已执行。递归草稿继续显式跳过。

## S→N标准化联动

`normalization-strokes`复用已锁定合法笔输入字段，实际先调用生产S内核，再把确认S事件交给生产N。state仅为`{normalizedCount}`；structures是该前缀全部确认L0的丰富映射，字段为`id,segmentId,realStartTime,realEndTime,realStartTicks,realEndTicks,actualLowTicks,actualHighTicks,actualLowTime,actualHighTime,analysisStartTime,analysisEndTime,analysisStartTicks,analysisEndTicks,direction,confirmedAt,ruleId,dependencies,ordinal`。

ID绑定为`fixture.id/N/ordinal/realStartTime`，segmentId对应`fixture.id/S/ordinal/realStartTime`，dependencies仅含该S。analysis时间等于real几何时间；分析价格按N-001使用自身归属笔区间，来源时间单列。检查器用声明的归属跨度检查范围及最早来源见证，不推断线段划分。新确认事件使用通用events格式，type为normalized，occurredAt为analysisEndTime。原对象在后续前缀保持只读；同一输入可以顺序确认多个N。

## 独立中枢V2样例

`centers/cases.json`使用单独schemaVersion=2，与主目录52例的计数和驱动分开。sourceIds为C18-39／C20-43；E-010工程归属规则见rules.md。输入假定为已确认合法L0，四元组为`[真实起价,真实终价,实际低价,实际高价]`，价格均为整数tick；真实端点首尾连接、方向交替。工具仅构造对应时间与身份，不根据生产实现生成答案。

每个输入前缀一项expected；尚无中枢为null。非空包含`core:[ZD,ZG]`、`stats:[GG,G,D,DD]`、`extent`最后归属输入序号、`waves`同向Z数量。`event`为新形成事件，`count`累计形成数默认1；`start`只需在形成时给出，之后沿用该中枢起点。固定核心在相同count内不变，切换count必须有唯一新形成事件。

`pending`为待定离开输入序号，默认0；`closed`为最近中枢已关闭，`closedEvent`只在本前缀关闭时为true；`leave/returned/closedAt`为离开、回试及确认时钟所对应的输入序号。关闭证明独立于成员来源。`held`及`blocked`检查预算不足时整输入未消费与状态回滚。`waiting`保留旧结构字段，V2均为false，不代表R完成。

`relation`为none、new-center-pending、up-continuation、down-continuation、range-overlap或core-overlap；关闭且未形成新中枢时默认new-center-pending，其他默认none。它是可变化的当前证据，不是不可撤销走势确认。验证器还独立观察形成／关闭事件原引用、重载、重复输入及深复制隔离。13例91前缀的本地生成与格式检查不代替Pine执行；旧Z7文件及独立预期快照保留历史范围。

## 窗口策略独立预期

windows/cases.json使用单独schemaVersion=1，不计入主目录52例。config为[固定模式,请求起点,近期初始数量,加载末根索引,首可用开盘时间,固定模式上限]；missing是人工预期的历史不足标记。rows每项为[输入开盘时间,索引,是否收盘,符合起点,允许送入内核,累计接收数,首接收时间,末接收时间,已拒绝后续收盘数据]。null表示没有接收时间。所有窗口预期人工列出；工具不运行一套JS窗口算法计算答案。OHLC联动另复用I1输入，实际调用生产窗口与调度函数；逐前缀重载不得读取未来输入。

## 保留量工程预期

retention/cases.json是独立工程schemaVersion=1，记录长输入构造及人工终态约束，不计入主目录52例。monotonic给出OHLC数量与最终处理／保留数；centers给出连接端点、平移步长、重复轮数及裁剪后历史序号与下一中枢核心；strokes引用已有独立锁定笔样例和最大后缀保留量。生成器只将预期编码为Pine断言，不运行JS形态算法生成答案。生产CORE与预期哈希分别绑定，平台执行单独记录。

## 信号样例（signals/，kind=signal-components）

`tests/fixtures/chanlun/signals/` 存放背驰与买卖点的独立预期（规则见 rules.md 的 M／D／B 组，规则版本 `chanlun-signals-0.1`），由 `check-fixtures.mjs` 的 `checkSignalDirectory` 单独计数，不计入主目录的 54 例。`ruleVersion` 固定为 `chanlun-signals-0.1`，`source` 等顶层字段同上。

### 输入

`input` 固定为 `{kind, macd, layer, bars, items}`：

- `macd`：`{fast, slow, signal, warmupBars}`，只记录参数，**不参与计算**——样例与 MACD 计算解耦。前 `warmupBars` 根 `bars` 视为预热（或已回收的前缀），涉及这些柱的段面积不可用（M-002）。
- `layer`：1～3，信号所属层级。
- `bars`：逐根已收盘 K 线的柱值 `{time, closeTime, hist, dif, dea}`，均为整数，时间严格递增。`hist` 是 M-001 的柱值（样例直接给出，不由 `dif－dea` 校验）。
- `items`：本层已完成部件（同 completed-components 的字段，首尾相连）。每个部件的终点时间必须有一根对应的 K 线，且该 K 线在 `completedAt` 前已收盘。

### 预期

每个输入前缀恰好一项 `{prefix, state, signals, suppressed, events, reason}`：

- `state`：`{processedCount, centers}`。`centers` 是该前缀全部 Z 的快照 `{id, status, coreLowTicks, coreHighTicks, ggTicks, ddTicks, formationIds, closeDirection, departureId, returnId}`，ID 为 `<fixture.id>/Z/<序号>`；`status` 为 open／closed；`departureId` 在 open 时是待定离开部件，在 closed 时是已确认离开部件。核心必须等于三个形成部件区间的交集，由检查器重算。Z 的归属与关闭是人工按 Z-001／Z-002／E-010 推导的中间事实，检查器只核对算术与引用，不判断推导是否正确。
- `signals`：该前缀全部已确认信号（累计）。每个信号 `{id, type, layer, side, priceTicks, occurredAt, confirmedAt, dependencies, comparison}`；`type` 为 `first`（第一类）、`second`、`third`、`consolidation-divergence-point`；`id` 为 `<fixture.id>/L<层>/<type>/<触发部件ID>`。触发部件：第一类与盘整背驰点是离开部件，第二类是第一类之后的第二个部件，第三类是回试部件。`occurredAt` 等于触发部件终点时间，`confirmedAt` 等于其 `completedAt`，且必须在恰好那一个前缀首次出现。已确认信号在后续前缀必须逐字段不变。
- `comparison`：第一类与盘整背驰点为 `{kind, aIds, cId, a, c}`，`a`／`c` 为 `{startTime, endTime, direction, areaUnits, extremeTicks}`；其余类型为 null。`areaUnits` 由检查器按 M-002 用 `bars` 重算并比对（左开右闭 `(ts,te]`，只计同号柱，不可用时为 null）。检查器断言已确认信号满足 C 面积严格小于 A、C 极值严格越过 A、A 的取法（第一类：自前一中枢离开部件到最后中枢首个形成部件之前；盘整背驰点：紧邻首个形成部件之前的同向部件）、依赖列表及类型与买卖侧。
- `suppressed`：该前缀被评估后**未**产生的信号及原因 `{type, reason, comparison, dependencies}`，不累计。`reason` 为 `area-unavailable`、`area-not-smaller`、`not-new-extreme`、`no-same-direction-entry`、`no-entry-segment`、`breaks-first-class-price`、`touch-edge`（第三类的回试低点／高点恰等于核心边界）。需要面积或价格比较的原因必须带 `comparison`，检查器用重算值核对原因成立。
- `events`：该前缀新提交的信号 ID，按提交顺序，同批顺序为第一类／盘整背驰点 → 第二类 → 第三类（B-005）。
- `reason`：人工推导理由。

检查器**不判断某个信号是否应该出现**，只核对数据契约、重算算术和不变量；预期必须人工推导，禁止由待测实现回填。样例是合成的，部件区间等于两端点；价格以 30 为轴翻转的镜像样例（名称带 `-down`）覆盖买入侧。
