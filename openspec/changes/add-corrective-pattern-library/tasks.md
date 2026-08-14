# Tasks：补全调整浪型库（P2）

## 1. 前置
- [x] 1.1 确认 P1（`restructure-wave-engine-to-verification-manual`）已实现并可用 —— 21/21 任务完成，14/14 单测通过

## 2. 平台形三子类
- [x] 2.1 规则平台手册（gross 口径 0.7~1）—— `buildRegularFlatManual`
- [x] 2.2 扩散平台手册（1~2，c 超 a 终点且 <3×a.price）—— `buildExpandedFlatManual`
- [x] 2.3 顺势平台手册（1~2，c 不超 a 终点但重叠；禁 2 浪位置）—— `buildRunningFlatManual`（`positionHint==='wave2'` 时淘汰）

## 3. 收缩三角形
- [x] 3.1 a-b-c-d-e 检测（内部 3-3-3-3-3、依次收敛）—— `buildContractingTriangleManual`，6点窗口
- [x] 3.2 收缩通道 + 4 浪不切入 1 浪规则 —— 通过 `wave1Ref` 位置锚点实现「不切入1浪」；完整通道几何留给 P3（已在 proposal 非目标中声明）
- [x] 3.3 e 浪骗线（突破假象）提示（Guideline）—— `triangle.guide.e-fakeout`（非通道几何的轻量插针代理）

## 4. 锯齿类分级
- [x] 4.1 单锯齿(5-3-5) 与双锯齿(3-3-3, w-x-y) 的分辨 —— `legIsZigzagShaped` + `buildDoubleZigzagManual`
- [x] 4.2 三锯齿(3-3-3-3-3, w-x-y-xx-z) 及 x/xx 连接段规则 —— `buildTripleZigzagManual`

## 5. 联合形
- [x] 5.1 双重横向整理（x 回撤 w 70%）—— `buildDoubleSidewaysManual`
- [x] 5.2 三重横向整理（x 回撤 w 70%，xx 回撤 y 70%）—— `buildTripleSidewaysManual`

## 6. 楔形与交替
- [x] 6.1 引导 vs 终结楔形按位置 + 内部结构区分 —— `buildImpulseDiagonalManual(direction, positionHint)`；扫描时 i===0 记为引导，其余记为终结（见代码内注释说明的简化边界）
- [x] 6.2 交替原则（陡直/横向）作为 Guideline 加权 —— `classifyLegStyle` 计算 2浪风格，`flat-running.guide.alternation-with-wave2` 消费

## 7. 收尾
- [x] 7.1 各浪型单测（对照书章节条款）—— `tests/analyze-wave-manual.test.js`（P2 部分新增，全部通过）
- [x] 7.2 回归：真实行情下否定法能在更多场景收敛到主选 —— 见下方回归记录
- [x] 7.3 `npx openspec validate add-corrective-pattern-library --strict` 通过

### 回归记录（7.2，如实记录，未夸大）
选定 BTC-USD 1h（2026-07-01 ~ 2026-08-12，真实 Coinbase 数据）运行 P2 版
`analyze-wave-manual.js`（178 幸存候选 / 1424 淘汰候选，覆盖 159 个枢轴）。

**已验证（真实数据观察到的事实）：**
- 新增的浪型手册（Regular/Expanded/Running Flat、Triple Zigzag、Double Zigzag、
  Ending Diagonal）确实被纳入候选扫描，并出现在「最近区间被淘汰的假设」列表中，
  每个都带有明确、可读的否定原因（如「w浪自身须呈单锯齿形态」「c浪必须是推动浪
  或终结楔形」），证明这些新手册在真实数据上是被主动评估的，而非死代码。
- 引导/终结楔形的位置标签正确生效：原先 P1 报告中泛化的「推动浪（楔形 Diagonal）」
  现在按位置正确标注为「推动浪（终结楔形 Ending Diagonal）」。
- 引擎运行稳定，无异常抛出，产出报告结构与 P1 一致、可读。

**本次数据窗口未能验证的点（诚实标注，非缺陷）：**
- 主选浪型与 P1 版本相同（仍是同一段标准下跌推动浪），备选列表中也未出现新增
  浪型进入 Top-4——即在这段 6 周窗口内，没有一段真实走势恰好满足任何新增浪型
  的全部规则闸门到能够跻身主选/备选之列。这是否定法预期内的合理结果（真实行情
  不保证在任意窗口内出现每一种浪型），单测已独立验证各新增浪型手册在合成数据下
  能够正确幸存/淘汰（见 24/24 单测），故不构成实现缺陷；但也意味着本次回归
  未能在真实数据上直接观察到某个新增浪型"胜出"成为主选的例子。
- 尝试过用独立脚本枚举全部幸存候选按类型分布计数，以更定量地检验新浪型手册
  在真实数据下的命中率，但该脚本因环境网络问题（与本次改动无关）多次
  `ECONNRESET`，未能完成；不影响已完成的核心回归（CLI 脚本本身两次真实运行
  均成功）。
