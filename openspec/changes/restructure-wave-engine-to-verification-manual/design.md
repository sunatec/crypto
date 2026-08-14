# 设计：验证手册内核（P1）

## 背景与约束

- 参考实现：`analyze-kline-wave.js`（5494 行）已有枢轴检测、推动浪/单锯齿/平台的检测与校验、通道/交替/量能评分、斐波共振簇、多剧本报告。**P1 复用其数据层与几何检测思路，但不改动该文件。**
- 理论依据：《波浪理论详解》第 3 章（数浪方法论）、第 4 章（单锯齿验证手册）、第 5 章（平台形验证手册）。
- 硬约束：新脚本独立成文件；老脚本零改动；两者可对同一段行情各自出结论以便对照。

## 决策 1：评分模型 —— 否定法（hard-gate）取代加权混合

老脚本（软打分）：
```
score = w1·结构 + w2·交替 + w3·量能 + w4·背离 + …   // 破铁律只扣分
```
新脚本（否定法）：
```
evaluate(candidate, manual):
  for rule in manual.rules (按 浪型→比率→时间 顺序):
     if !rule.test(candidate):  return { survived:false, failedRule:rule, layer:rule.layer }
  guidelineHits = [g for g in manual.guidelines if g.test(candidate)]
  return { survived:true, guidelineScore: Σ g.weight, hits:guidelineHits }
```
- **只有 `survived:true` 的候选进入排名**；被淘汰的候选保留其 `failedRule` 以便报告解释"为什么这不是 X 浪型"。
- 排名键：`(guidelineScore desc, endIndex desc)`，与老脚本的"越晚结束越优先"保持一致的 tie-break。
- 好处：输出天然可解释——"这段=单锯齿，因为通过全部铁律，且命中 4/6 条指引；不是推动浪，因为 c 浪未超 a 浪 1.618 且只有 3 子浪"。

## 决策 2：三种度量为一等公民

对任意"点序列"定义的浪型，提供：

| 度量 | 定义 | 典型用途 |
|---|---|---|
| `price` 价格 | 起点→终点的正统落差（方向敏感） | 斐波回撤/扩展基准；驱动浪比率 |
| `gross` 运行总量 | 所有子浪 max − min | 平台形/三角形比率基准 |
| `movePct` 价格运动百分比 | (max − min) / min | "3浪价格运动%不能同时<1、5浪" |

每条比率 Rule/Guideline **显式声明** `basis: 'price' | 'gross' | 'movePct'`，杜绝老脚本用枢轴价直接算、口径含混的问题。

> 关键差异点（书 5.6）：平台形 b 浪"回撤 a 浪 70%"量的是 **gross**；单锯齿 b 浪比率量的是 **price**。P1 必须把这两条口径分清，作为引擎正确性的试金石。

## 决策 3：数据模型

```js
// Rule / Guideline 统一形状
{ id, layer:'pattern'|'ratio'|'time', basis?, desc, test(ctx) -> bool }

// 验证手册
Manual = { patternType, direction, rules:[Rule], guidelines:[Guideline] }

// 候选点上下文（喂给 test）
ctx = { points:[{type,price,timestamp,index}], candles, measures:{price,gross,movePct,...} }
```
手册即数据/纯函数集合，便于逐条单测（对照书的条款编号）。

## 决策 4：P1 手册范围与"否定项"落地

- **推动浪**：2浪不折返1浪100%、3浪超1浪终点、3浪非最短、（推动浪）4浪不切入1浪 / （楔形）允许切入 —— 全部作为**浪型规则**闸门（书 1.5）。
- **单锯齿（5-3-5）**：a=推动浪或引导楔形、c=推动浪或终结楔形、`a≥b≥0.2a`(price)、`b.gross≤a.gross`、`0.9b<c<5b 且 c<5a`、b/c 时间≤10×——对照书 4.1 手册（老脚本 `evaluateSingleZigzag` 已有雏形，迁移并补齐口径）。
- **平台形（基础版）**：a、b 均为非三角调整浪、c=推动浪或终结楔形、`b.gross ≥ 0.7 a.gross 且 < 2 a.gross`、c 与 a 有重叠——对照书 5.1 手册。三子类（规则/扩散/顺势）留给 P2。

## 决策 5：新旧脚本边界

- 新脚本名**定为 `analyze-wave-manual.js`**。
- 取数逻辑**定为「复制进新脚本」**：把老脚本的 `fetchCandles/aggregate*/detectPivots/computeATR` 复制到新脚本内，彻底隔离，`analyze-kline-wave.js` 不被 require、不被改动。不抽共享 `lib/` 模块（留待 P2/P3 也新建脚本时再评估）。
- 输出：先做**控制台 + Markdown**；HTML dashboard 不在 P1。
- 回归基准：对同一 `--product/--tf/--start/--end`，新脚本对 P1 三类浪型的判定应与老脚本"大方向一致"，差异点（尤其平台形 gross 口径）需在报告里可解释。

## 已决决策（本轮确认）

1. **取数逻辑**：复制进新脚本，彻底隔离，老脚本零改动（见决策 5）。
2. **新脚本名**：`analyze-wave-manual.js`（见决策 5）。

## 待解问题（P1 实现时确认）

1. 时间规则里的"10倍"等硬上限，K 线级别不同（5m vs 1w）是否需要级别自适应？（P1 先按书原文常量，级别自适应归 P3。）
