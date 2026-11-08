# Design

## Context

问题背景见 proposal.md 的 Why 一节。相关事实如下：

- `main()` 中的 `fine = anchorBoundaryExtremes(candles, detectPivots(candles, 1))` 会在右端补一个 `{ provisional: true, boundary: 'end' }` 的反向极值。
- 任务 1.1 核实（BTC 1h 夹具 `btcusdt-1h-live-extreme-20261104.json`）：边界枢轴并没有在下游被丢弃，而是从未生成。`anchorBoundaryExtremes` 在右端只补“与末确认枢轴**反向**”的极值：末确认枢轴是 H 78164 @11-04 13:00(+08)，于是补上 L 77748.09（provisional）；此后 K 线再创的新高 78556.01 与 78164 同型，不在补点范围内。传入 `buildInProgressStructure` 的末两个枢轴因此是 H 78164 → L 77748.09(prov)。这是边界锚定的既定口径（主树按它数浪），不是 bug，不在主流程修。
- `buildInProgressStructure` 从 `post`（spanLast 之后的枢轴）中挑选 `ext`，并且只在 `iExt < finePivots.length - 1` 时才生成 `pullback`。

## Goals / Non-Goals

**Goals**
- 现价越过摆动极值时，进行中结构及其派生内容（回撤、轴② 投影、轴③ 回撤位、X 占 W 比例）立即按新极值计算。

**Non-Goals**
- 不改变主计数树（历史段）对 provisional 枢轴的处理，因为主树和子浪验证会刻意排除未确认的点。
- 不新增“读法三”（b/② 已在真低点走完、c/③ 已开始）作为默认分支。既有要求“越过摆动高点以轴②为准……不另立分支”已经规定以上冲延伸为准；读法三仍按其原有条件（未跌破 (a) 终点、有整体读法）在进行腿细化中输出。
- 不收紧失效位。在上冲延伸的读法下，X/B 与新推动浪① 的失效位都仍是反弹起点。“跌破真低点”按既有要求只否定“在此走完”。

## Decisions

### D1 只在进行中结构这一层补边界极值

新增 `appendLiveExtreme(finePivots, spanLast, candles)`：扫末枢轴之后的 K 线，若比 spanLast 之后的摆动极值更极端，返回补上 `{ type, provisional: true, boundary: 'end', live: true }` 的枢轴副本（末枢轴与它反向则追加，并去掉原末枢轴的 provisional 标记——它已成为摆动段内部的子浪端点；同型则替换）；否则原样返回同一数组。`buildCountTree` 用这个副本调用 `buildInProgressStructure`、`buildCurrentWaveStructures` 与 `situationAssessment`（后者的 `nearTerm` 也要看到新极值），主树、验证、排名仍用原枢轴。
- 选择这种做法：影响范围只限于进行中层；未越过时返回同一数组，下游逐字节不变（6 个夹具快照比对确认）。
- 原计划在 `buildInProgressStructure` 内部补点；实现时发现轴②（`buildCurrentWaveStructures`）和 `nearTermTrigger` 也各自从枢轴求极值，改为在调用处统一补一次。
- 放弃的做法：在主流程补回边界枢轴。会改变主树的末腿和子浪验证。

### D2 provisional 极值之后不生成 pullback

新极值是末端 K 线的最高价，它之后没有确认的反向枢轴，所以 `pullback = null`。这与现有的 `iExt === finePivots.length - 1` 分支一致，`annotateInProgress` 会把末腿标为进行中。

### D3 下游取值与延伸中分支

实现时核对：`bounceHypotheses` 本来就读 `ips.swingExtreme`；`enrichCurrentPullback` 在 `pullback === null` 时直接返回，无需改；`buildCurrentWaveStructures` 原先在“极值即末枢轴”时返回 null（轴② 整表消失），现对 `live` 极值增加延伸中分支：T2 写 “a 腿（延伸中），之后 b 腿”，T3 写“浪①（延伸中），之后 浪②”，T1 写“浪②（延伸中）”，下一腿投影取首腿的回撤位；结果带 `extending: true`、`pullbackExtreme: null`。`inProgressStruct.retraceTargets` 给出按新极值重算的 0.382/0.5/0.618，供轴③ 价位梯子使用；轴③ 的“近端：站上 … 才算好转”在近端腿就是摆动段时不再输出。

### D3（原稿）下游一律读取 `ips.swingExtreme`

`enrichCurrentPullback`、`bounceHypotheses(…, swingExtremePrice)` 和 `buildCurrentWaveStructures` 都改为从 `ips.swingExtreme` 取值，不再各自从 `finePivots` 求极值。实现时逐个核对。`buildCurrentWaveStructures` 如果直接使用 `finePivots`，就传入 D1 拼接后的副本。

## Risks / Trade-offs

- [末根 K 线尚未收盘，其最高价是盘中值，下一次运行可能回落] → 以 `provisional` 标明这是暂定极值；每次运行按当下数据重新计算，这与 `anchorBoundaryExtremes` 的口径相同。
- [新极值让 `upTree` 多出一段，可能改变上冲段性格（5 浪 / 3 波），进而改变轴② 的排名] → 这正是预期中的“重新研判”。golden 测试和 regression 测试用来确认历史段不变。
- [极值只略微越过（例如 1 tick）就翻转整段叙述] → 越过即翻转，不另设阈值，与“越过摆动高点以轴②为准”的字面要求一致。如果后续出现抖动，再考虑引入 tick 级容差。

## Migration Plan

无数据迁移。回滚只需 revert 本变更的提交。

## Open Questions

（无）
