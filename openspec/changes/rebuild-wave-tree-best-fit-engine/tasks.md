# Tasks：递归拆解 + 最佳拟合波浪计数引擎

## 1. 前置
- [x] 1.1 确认现有 36 单测通过、`analyze-wave-manual.js` 边界锚定已落地
- [x] 1.2 新建 `analyze-wave-tree.js`，`require` 复用 plumbing（fetch/transform/ATR/detectPivots/anchorBoundaryExtremes/computeMeasures/rangeExtreme/TIMEFRAMES）

## 2. M1 判据契约 + 拟合分
- [x] 2.1 新判据契约：`test() -> { pass, overshoot }`，overshoot = 相对阈值归一化越界距离（normRange/normGate）
- [~] 2.2 从 `build*Manual` 机械搬运规则表达式到新判据层 —— 已搬「标准推动浪」样板；其余形态随 M2 逐个搬运
- [x] 2.3 分层字典序拟合分：tier1 违规数 → tier2 越界和 → tier3 指引未命中率 → tier4 跨级别指引
- [x] 2.4 优雅降级：节点无人 tier1=0 时取最轻违规者 + `penalized` 标记（selectBest 内建）

## 3. M2 递归引擎
- [x] 3.1 入口全形态竞争：整段按各形态所需段数(k)切分（coarsenByPairs 逐级坍缩最小摆动；顶层 directionalTopSpan 方向裁剪）
- [x] 3.2 文法约束：父浪 childRoles 限定子浪可选假设集（driving/corrective）；结构规则从手册移除、由文法承担
- [x] 3.3 回溯 + beam：每节点保留 top-3；文法违规并入父级 tier1 而非直杀
- [x] 3.4 终止：点数不足以成形任一允许形态即停，标"末级/不可再分"（realizes Q7 意图）
- [~] 3.5 形态手册搬运（对照书 toc 核定）：
      - [x] 推动浪 / 楔形 / 单锯齿 / 平台(基础)（M2）
      - [x] 双锯齿 / 三锯齿（书07章，文法用具体形态 'zigzag' 约束 w/y/z）
      - [x] 双重/三重横向整理（联合形，书1.7，x/xx 回撤70%门槛）
      - [x] 收缩三角形（书06章，收敛规则；扩散三角形书6.1明说不存在→不做）
      - [x] 简约原则（多重调整=最后手段）：complexity 平局裁决 + 修正 tier3 命中计分
      - [ ] 平台形三子类（规则/扩散/顺势，书5.4）——细化现有 flat
      - [ ] ⚠️ 新搬的三角/联合形手册目前只转录了 1–2 条核心量化规则，书 06/07 章的完整
            规则/指引清单尚未逐条转录（Q10b 后审）；故这些形态「能竞争」但排名未完全可信
- [x] 3.6b 坍缩保护全局极值：coarsenByPairs 不删全段最高/最低枢轴（修「全局最低 57717 被坍缩吞掉」，
      与边界 126296 同类），兜底允许删以保证总能产出切分
- [x] 3.6c 顶层区间止于主趋势终点：directionalTopSpan 从「更早的全局极值」走到「另一全局极值」
      （BTC 126296高→57717低），极值之后的走势作为进行中反弹——修「把已走完大跌+反弹塞进一个
      形态导致第1浪长得离谱」；顶层由此从失衡楔形变为匀称的锯齿 a-b-c
- [x] 3.7 严重违规层（用户定「后者」）：越界>0.5 记为严重违规，排在违规条数之前——
      一条致命伤不再被"少违规一条"救回（scoreCandidate.severe + compareCandidates）
- [x] 3.8 子浪结构判定（legCharacter）：每条腿分别按驱动/调整各拆一次、比较拟合，得真实性格
      （五浪 vs 三波），「能干净走成五浪即驱动」防误判；文法改为「性格与所需相反才违规」，
      decompose 与 evaluateExplicitCount 一致。**结果推翻"第一段像推动"的肉眼判断：BTC 顶层
      变为三锯齿(w=126296→80524、x=→97963 即用户点)，用户 4 点 W-X-Y 成第1备选(双锯齿差1%)**
- [x] 3.6 切分变体：尝试过枚举变体让引擎自动发现用户切分——组合爆炸(>120s)且不能可靠命中用户
      精确点对，已回退为单一坍缩。改由 `--count "126296,80524,97963,57717"` 让用户直接喂自己的数法，
      报告新增「你指定的数法评分」节（pointsFromPrices + evaluateExplicitCount + renderExplicitVerdict）

## 4. M3 级别涌现 + 进行中 + 投影层
- [x] 4.1 只吃一套细枢轴(lookback=1) + 边界锚定；级别=拆解深度涌现（引擎已实现，CLI 挂载留 M4）
- [x] 4.2 进行中浪：主链末腿标 `进行中(第X/共Y浪)`；provisional 与起点同型被裁剪时挂顶层"当前进行中腿"
- [x] 4.3 投影层（不评分）：斐波价格目标 + 艾略特通道完成/边界投影（书02章）均已接入，标注推断
- [x] 4.4 知识归属落位：浪个性(3浪最强)+交替→tier4；量能→仅注记(volumeNote)；衰竭→truncated 状态；动量/背离→未引入(排除)

## 5. M4 输出 + 测试
- [x] 5.1 计数树 JSON schema（serializeTree：degree/label/points/waveIndexInParent/fitScore/status/expectation/children/alternates + 顶层 inProgress）
- [x] 5.2 Markdown 报告 + console（renderMarkdownReport / renderTreeText）+ CLI 入口 `node analyze-wave-tree.js`
- [x] 5.3 单元测：overshoot 正确性 + 各形态 pass/margin（M1，12 项）
- [x] 5.4 结构测：合成已知计数 → 正确树（含进行中、文法约束、beam、终止）（M2/M3，11 项）
- [x] 5.5 金标准回归：BTC-USD 1d 固化 fixture（tests/fixtures/btc-usd-1d-golden.json）+ 结构不变量断言（7 项）

## 5b. M5 全形态入库 + 完整规则转录 + 给我的数法打分
- [x] 5b.1 补齐调整浪家族入新引擎：双/三锯齿、双/三重横向整理、收缩三角形（对照书 toc）
- [x] 5b.2 简约原则（complexity 平局裁决）+ 修正 tier3 命中计分
- [x] 5b.3 「给我的数法打分」evaluateExplicitCount + renderExplicitVerdict + 金标准测试
- [ ] 5b.4 逐章转录**完整**验证手册（覆盖所有形态，Q10b 后审）：
      - [x] 书04章 单锯齿：比率/时间规则本已搬全（§4.1 核对无误），补齐 3 条指引
            （b不接近a起点、c未远超1.618a、b时间窗）；结构类"a引导楔形则c非终结楔形、
            a/c不同时5浪衰竭"需子浪类型细节，标 TODO
      - [x] 书05章 平台形 + 三子类：§5.1 基础规则补齐（新增 c 运行总量≤2×max(a,b)且≤3×a价格）；
            §5.4 三子类入库（规则:b≤a；扩散:b>a且c超a终点；顺势:b>a且c不到a终点）
      - [x] 书06章 收缩三角形：§6.2 完整转录（b/c/d/e 逐浪比率、d/e时间≤4×c、最长子浪只能a/b、
            e须回a区域、618/70%指引）；修复顶层不再被"规则稀少的三角形"无脑套走；
            通道线几何、子浪的子浪105%需子结构，标 TODO
      - [x] 书07章 双/三锯齿：完整规则/指引已转录（§7.1 全套比率+时间规则+指引；
            结构类"w的c浪不能失败/相邻子浪不同时5浪衰竭"需子浪细节，标 TODO 待接）
- [ ] 5b.4b 前3章（地基/工具，非浪型）——已核对 + 待接：
      - [x] 书03章 3.6 验证顺序（浪型→比率→时间；规则>指引）——已核对，引擎 LAYER_ORDER 与之一致
      - [x] 书03章 3.16 价格/运行总量/价格运动百分比——已核对，computeMeasures 一致
      - [x] 书03章 3.16 特例：收缩三角形运行总量=最长子浪高低差——triangleGross 已实现，
            decompose 中纠正三角形节点 gross；父浪直接对三角子腿算 gross 的场景待 decompose-first 后接
      - [x] 书02章 艾略特通道——接进投影层：channelProjection 复用老模块 buildChannel/channelExitHint，
            按浪型分派3种通道(2.3)，作用一(完成提示)+作用二(下一拐点边界投影，含负价/天量价 sanitize)
      - [x] 书03章 3.22 斐波时间共振——接进投影层：fibTimeWindows 面向未来推算多枢轴斐波时间
            重合的「转折时间窗」，报告新增该段；3.19 斐波扩展与现有斐波价格目标重叠，暂缓
      - [ ] 书01章 1.5 驱动浪规则 + 3子类——逐条对齐（引导/终结楔形位置区分待细化）
- [ ] 5b.5 完整转录后重跑金标准，确认顶层排名更可信（三角形不再无脑套强趋势）

## 6. 收尾
- [x] 6.1 三脚本并存互不依赖验证：kline/manual/tree 各自 require 加载均 OK，旧两脚本零改动
- [x] 6.2 `openspec validate rebuild-wave-tree-best-fit-engine --strict` 通过
- [x] 6.3 诚实记录：真实 BTC-USD 1d 顶层为「调整族 · down 126296→62468（违规×3，优雅降级）」+ 当前进行中腿 62468→now(up)，
      预期 64296/65426/67254。顶层带违规说明现有 4 形态套整段不干净——补三角/联合形（Q5 非目标，后续增量）后有望降违规。

## 7. M6 现状研判（把历史浪型收敛成四问：当前浪/趋势/目标/依据）
- [x] 7.1 situationAssessment：大级别趋势由顶层 motive/corrective 推断；当前浪角色由 legCharacter；
      失效点=顶层完成结构终点极值；双情景（回撤=逆结构/看涨、扩展=顺结构/看跌），主选=与大趋势一致者
- [x] 7.2 renderAssessment 大白话四问 + 每条目标附依据 + 斐波时间窗；放报告最前（Q9=a）
- [x] 7.3 金标准锁定：顶层调整浪→偏多、失效点=57717、双情景目标各3条且分居失效点两侧、每条带依据
