# Tasks：验证手册内核（P1）

## 1. 脚手架与数据层（老脚本零改动）
- [x] 1.1 新建 `analyze-wave-manual.js`，从 `analyze-kline-wave.js` 复制并隔离取数/聚合/枢轴/ATR 逻辑（`fetchCandles`、`aggregate*`、`detectPivots`、`computeATR`）
- [x] 1.2 复用 CLI 参数命名（`--product/--tf/--start/--end/--out/--report/--lookback/--atr-*`），移除 `--rsi-*` 默认启用
- [x] 1.3 确认 `analyze-kline-wave.js` 未被改动 —— 本次会话全程仅 `Read` 该文件，未调用 `Edit`/`Write`；工作树中该文件的既有改动（ABC 目标锚点归因逻辑）在会话开始前已存在，与本变更无关，未受影响。

## 2. 度量层（wave-measurement）
- [x] 2.1 实现 `computeMeasures(points, direction, candles) → { price, gross, movePct }`，方向敏感
- [x] 2.2 处理 5 浪衰竭 / 失败 c 浪导致 `price ≠ gross` 的情形（gross 用区间内真实 K 线高低点计算）
- [x] 2.3 单测：未衰竭 price==gross、衰竭 price<gross、平台形 gross 口径（`tests/analyze-wave-manual.test.js`，14/14 通过）

## 3. 验证手册引擎（wave-verification-manual）
- [x] 3.1 定义 Rule/Guideline 形状 `{id, layer, basis?, weight, desc, test, detail}`
- [x] 3.2 定义 Manual `{patternType, direction, rules[], guidelines[]}`
- [x] 3.3 实现否定法评估器：按 pattern→ratio→time 逐条测试；首个失败记 `failedRule`；幸存者计 `guidelineScore`
- [x] 3.4 实现排名 `(guidelineScore desc, endIndex desc)` 与主选/备选选取
- [x] 3.5 保证 Guideline 不能抵消 Rule 失败（单测覆盖）

## 4. P1 浪型手册（wave-taxonomy）
- [x] 4.1 推动浪手册（含 diagonal 变体）：2浪<100%、3浪超1浪终点、3浪非最短、4浪切入规则
- [x] 4.2 单锯齿手册（5-3-5）：口径分清（price 用于 b/c 比率，gross 用于"b不破a起点"）
- [x] 4.3 平台形基础手册（3-3-5）：b.gross∈[0.7,2)×a.gross、c 与 a 重叠
- [x] 4.4 每条 Rule/Guideline 标注对照书章节的 `id`（见 analyze-wave-manual.js 第5节顶部对照表）

## 5. 输出与解释
- [x] 5.1 控制台摘要：主选浪型 + 通过的规则 + 命中的指引
- [x] 5.2 Markdown 报告：含被淘汰备选的 `failedRule` 人类可读理由
- [x] 5.3 报告注明每条比率判据用的是 price 还是 gross

## 6. 回归对照
- [x] 6.1 选定 BTC-USD 1h（2026-07-01 ~ 2026-08-12）新旧脚本各跑一遍（真实 Coinbase 数据，非模拟）
- [x] 6.2 记录差异点，确认差异可解释：
      - 新脚本（P1）主选 = 标准下跌推动浪 `[2026-08-10 06:00 ~ 2026-08-11 14:00]`，通过全部 6 条规则，命中 3/3 指引；
        并明确给出「最近区间被淘汰的假设」（上涨推动浪因4浪切入1浪被淘汰、上涨单锯齿/平台形因a/c浪非驱动浪形态被淘汰等）。
      - 老脚本（brief 模式）主选 = W-X-Y 联合修正（`57717.55 → 66923.95 → 62209.81 → 63685.04`，Y浪进行中）。
      - 差异原因：P1 手册范围仅含推动浪/单锯齿/平台形三类（按提案约定），联合形（W-X-Y）属于 P2
        （`add-corrective-pattern-library`）范围，P1 尚不具备识别能力。在 P1 词汇表内，新脚本落回
        「能通过全部规则闸门的最佳推动浪」是符合否定法设计的正确行为，而非缺陷——且其淘汰记录清楚
        说明了为什么最新几根K线的其他假设（上涨推动浪/单锯齿/平台形）不成立。
      - 结论：差异完全可由「P1 未实现联合形」解释，无需修正 P1 范围内的实现；已在设计文档中确认此为
        已知边界，后续由 P2 补齐。
- [x] 6.3 `npx openspec validate restructure-wave-engine-to-verification-manual --strict` 通过
