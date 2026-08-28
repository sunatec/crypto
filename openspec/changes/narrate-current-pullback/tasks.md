# 任务：当前高点回撤叙述

> 仅改 `analyze-wave-tree.js`。素材大量复用既有能力，见 design §Decisions。

## 1. 子级别下钻取数（拆段前置）

- [x] 1.1 `TF_LADDER` 降级映射（1d→4h→1h→…）与"降一级"工具；currentPullback 段在当前级别
      枢轴数 < `MIN_POINTS.corrective`(4) 时触发下钻
- [x] 1.2 `drillPullback(window, startTf)`：对回撤时间窗自适应步降取 K 线，用独立时间窗 + 独立
      cache（`new Map()`），返回满足枢轴 ≥4 的最粗子级别 `{tf, fine, candles}`；取不到则返回 null
- [x] 1.3 保证不污染主级别：下钻取数独立于主分析的 candles/fine，主计数树输出零改动

## 2. 回撤剥两截 + 竞争形态

- [x] 2.1 在子级别 fine 上剥两截：`高点→回撤真低点`（拆）与 `真低点→今`（不拆）；真低点 =
      高点之后离高点最远的反向极值
- [x] 2.2 对"高点→真低点"段跑 `decompose([CORRECTIVE])`，取 `primary + alternates`
- [x] 2.3 滤除 severe/文法违规候选，产出干净竞争形态列表（label + 拟合摘要），去重同族

## 3. 级别定级（历史分位）

- [x] 3.1 采集同段趋势历史高→低回撤深度样本（复用 finePivots 相邻 H→L）
- [x] 3.2 取中位数为界：当前回撤深度 ≤ 中位数 → "小级别"，否则中/大级别相对档位

## 4. 联合形浪位读法

- [x] 4.1 当子级别拆为联合形（w-x-y / w-x-y-xx-z）时逐腿映射 W/X/Y/XX/Z 起止
- [x] 4.2 计算 XX 对 Y 浪回撤百分比，复用既有 70% 门槛判据，标注是否满足连接浪门槛

## 5. Z 浪双路径投影（新函数）

- [x] 5.1 `zwaveProjection(xxLeg, yLeg, wLeg)`（架构同 `bounceHypotheses`）：
      跌破路径主目标 = Z=W=Y 等长带（含 Y低−0.236×腿幅破位档）；延伸 = XX高−1.272Y / Y低−0.618Y；
      极端 = Y低−1.0Y / XX高−1.618Y，输出完整目标阶梯（各档带依据）
- [x] 5.2 W≈Y 不成立时等长带退化为区间(min~max)，斐波档补充，不强给单点
- [x] 5.3 三角收缩路径：用既有收缩三角文法判成立性，给横向收敛区间描述
- [x] 5.4 两路径均附"Z 走完转向上涨"收官语；MUST NOT 给统计概率

## 6. 叙述渲染（现状研判块）

- [x] 6.1 拼四要素成句：级别 / 竞争形态(多选"或") / 续涨条件(结构线) / 联合形浪位 + Z 主目标&延伸
- [x] 6.2 正文只给主目标 + 延伸档；全阶梯不进正文（进 JSON）；统一"推断、非确定"措辞
- [x] 6.3 无 currentPullback / 未下钻成形 时优雅降级（不产该段，不报错）；无警戒线措辞

## 7. JSON 序列化扩展

- [x] 7.1 `serializeInProgress` 的 currentPullback 下新增 `subDegree{tf,rankedPatterns[]}`、
      `combinationReading{legs,xxRetracePct}`、`structureLine`、`zwaveTargets{breakPath[],trianglePath}`
- [x] 7.2 无法计算的子字段置 null，不报错；主树序列化字节级不变

## 8. 验证

- [x] 8.1 端到端 BTC-USD 1d：现状研判块含回撤叙述，四要素齐备、无 undefined/NaN、数字自洽
- [x] 8.2 金标准：无 4h/1h 离线 fixture，改以**确定性子件锁 + 实盘活跑**覆盖该主链——
      `zwaveProjection` 锁"Z 主目标等长带含 74758、破位档 0.236"；`readCombination` 锁 XX≥70%；
      `drillPullback`/`enrichCurrentPullback` 锁"拆不出→下钻子级别→标记 drilled"；BTC-USD 1d 实盘
      活跑复核（74757–74765 带含 74758、XX 76.5%）
- [x] 8.3 单测：下钻步降选级、剥两截真低点、竞争形态滤除、历史中位数定级、zwaveProjection 各档、
      JSON 子字段 null 降级
- [x] 8.4 回归：主计数树/既有报告/结构化报告输出不变；全套测试全绿
