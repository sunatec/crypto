# wave-count-tree

## ADDED Requirements

### Requirement: 递归拆解产出从最大级别到当前浪的计数树
引擎 SHALL 通过自顶向下的递归拆解（全形态竞争 + 回溯 + beam）产出一棵计数树，其主链从最大级别贯穿到当前所处的最小级别浪。级别 MUST 是拆解深度的涌现结果，而非由过滤参数预设。引擎 SHALL 只消费一套细枢轴（`detectPivots(candles, 1)`）并复用边界锚定。

#### Scenario: 整段全形态竞争产出顶层主选
- **WHEN** 对一段行情（起点锚 → 进行中末端）运行引擎
- **THEN** 每类顶层形态（推动5 / 楔形5 / 锯齿3 / 平台3 / 三角5 / 联合形）各按其所需段数切分并评分，字典序最优者作为最大级别主选，其余作备选

#### Scenario: 主链逐级细分到当前浪
- **WHEN** 顶层主选的某一浪仍可继续拆解
- **THEN** 该浪递归拆到下一级别，主链缩进展示"大级别 → … → 当前浪"，每节点带形态名、方向、在父浪中的序号

#### Scenario: 数据驱动的终止
- **WHEN** 一条腿的内部细枢轴 ≤3 个、拆不出合法子结构
- **THEN** 停止继续拆解该腿，标记为"末级 / 不可再分"

### Requirement: 父浪约束子浪的可选假设集（文法约束）
拆解某一浪时，引擎 MUST 依据该浪在父结构中的角色限定其可选形态假设：驱动位（推动浪 1/3/5、锯齿 a/c、平台 c）SHALL 只允许驱动类假设；调整位（推动浪 2/4、锯齿 b、平台 a/b、三角各腿、联合形 w/y/z 与连接 x/xx）SHALL 只允许调整类假设。

#### Scenario: 驱动位排除调整类假设
- **WHEN** 拆解一个推动浪的第 3 浪
- **THEN** 只对其尝试驱动类假设（推动 / 引导楔形 / 终结楔形），不对其尝试锯齿/平台/三角/联合形

#### Scenario: 调整位排除驱动类假设
- **WHEN** 拆解一个推动浪的第 2 浪
- **THEN** 只对其尝试调整类假设，不将其判为推动浪

### Requirement: 进行中浪的完成度与预期
每一级别的最后一浪 SHALL 标注完成状态；未完成时 MUST 给出"第 X 浪 / 共需 Y 浪"、已满足与未满足的规则、以及下一浪的方向与斐波/通道目标区间。预期部分 MUST 明确标注为推断、非确定。

#### Scenario: 末浪标注进行中与预期
- **WHEN** 当前价位于某形态的最后一浪、该浪尚未走完
- **THEN** 该节点 `status = 进行中(第X浪/共需Y浪)`，并附下一浪方向与斐波/通道目标区间，且标注为推断

#### Scenario: 已完成兄弟浪正常定稿
- **WHEN** 某形态中除末浪外的浪均已走完
- **THEN** 这些浪按完成状态定稿，不带进行中标记

### Requirement: 计数树输出 schema 与三件套渲染
引擎 SHALL 输出嵌套计数树 JSON，节点含 `degree/label/direction/points/waveIndexInParent/fitScore/status/expectation/children/alternates`，并渲染 console 摘要与 Markdown 报告；Markdown SHALL 将主链自顶向下缩进为"大级别 → 当前浪"。

#### Scenario: JSON 与 Markdown 一致表达主链
- **WHEN** 引擎完成分析并写出报告
- **THEN** JSON 的树结构与 Markdown 缩进主链表达同一条"最大级别 → 当前浪"计数链，每节点附拟合分与备选
