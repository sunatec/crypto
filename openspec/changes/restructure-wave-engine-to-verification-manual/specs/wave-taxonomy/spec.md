# wave-taxonomy

## ADDED Requirements

### Requirement: 推动浪验证手册
系统 SHALL 提供推动浪（含引导楔形/终结楔形 diagonal 变体）的验证手册，其浪型规则至少包含：2 浪不折返 1 浪 100%、3 浪须超过 1 浪终点、3 浪不是 1/3/5 中最短、推动浪 4 浪不切入 1 浪（楔形变体允许 4 浪切入 1 浪）。

#### Scenario: 4 浪切入 1 浪淘汰标准推动浪
- **WHEN** 一段候选被假设为标准推动浪，但 4 浪低点切入了 1 浪高点
- **THEN** 该候选作为标准推动浪被淘汰，但仍可作为楔形（diagonal）变体候选继续评估

#### Scenario: 3 浪最短即淘汰
- **WHEN** 候选的 3 浪长度同时短于 1 浪与 5 浪
- **THEN** 该推动浪候选被淘汰

### Requirement: 单锯齿验证手册（5-3-5）
系统 SHALL 提供单锯齿手册，规则至少包含：a 浪为推动浪或引导楔形、c 浪为推动浪或终结楔形、`a ≥ b ≥ 0.2a`（basis=price）、b 浪 `gross ≤` a 浪 `gross`（b 任何子浪不超 a 起点）、`0.9b < c < 5b` 且 `c < 5a`（basis=price）、b/c 浪时间不超过 a/b 浪时间的 10 倍。

#### Scenario: b 浪超过 a 浪起点即淘汰
- **WHEN** 候选单锯齿的 b 浪任一部分超过 a 浪起点（`b.gross > a.gross`）
- **THEN** 该单锯齿候选被淘汰

#### Scenario: c 浪超 a 浪 1.618 倍降级为推动浪嫌疑
- **WHEN** 候选单锯齿的 c 浪 `price` 大于 a 浪 `price` 的 1.618 倍
- **THEN** 单锯齿指引给出"更可能为推动浪"的减分/提示（不直接淘汰，因仍在 `<5a` 规则内）

### Requirement: 平台形验证手册（基础版，3-3-5）
系统 SHALL 提供平台形基础手册，规则至少包含：a、b 浪均为非收缩三角形的调整浪、c 浪为推动浪或终结楔形、b 浪 `gross ≥ 0.7 × a.gross` 且 `< 2 × a.gross`、c 浪与 a 浪有价格重叠。三子类（规则/扩散/顺势）不在 P1 范围。

#### Scenario: b 浪回撤不足 a 浪运行总量 70% 即淘汰
- **WHEN** 候选平台形的 b 浪 `gross` 小于 a 浪 `gross` 的 0.7 倍
- **THEN** 该平台形候选被淘汰

#### Scenario: c 浪与 a 浪无重叠即淘汰
- **WHEN** 候选平台形的 c 浪终点未与 a 浪价格区间重叠
- **THEN** 该平台形候选被淘汰

### Requirement: 独立分析器脚本
系统 SHALL 交付一个独立的命令行分析器脚本（工作名 `analyze-wave-manual.js`），它加载 K 线、检测枢轴、对候选浪型套用上述手册并以否定法排名，输出控制台摘要与 Markdown 报告；其 CLI 参数命名 SHALL 尽量沿用 `analyze-kline-wave.js`（`--product/--tf/--start/--end/--out/--report` 等），且默认不启用 RSI。

#### Scenario: 与老脚本并存运行
- **WHEN** 对同一 `--product --tf --start --end` 分别运行新旧脚本
- **THEN** 两者各自产出报告，互不依赖、互不改写对方文件
