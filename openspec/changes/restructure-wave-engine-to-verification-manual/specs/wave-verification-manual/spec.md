# wave-verification-manual

## ADDED Requirements

### Requirement: Rule / Guideline 数据模型
系统 SHALL 以统一形状表示每一条判据：`{ id, layer, basis?, desc, test(ctx) → bool }`，其中 `layer ∈ {pattern, ratio, time}`。规则（Rule）与指引（Guideline）复用同一形状，语义差异由其归属集合决定。

#### Scenario: 判据可独立测试
- **WHEN** 给定一个候选浪型的上下文 `ctx`
- **THEN** 每条判据的 `test(ctx)` 可独立求值并返回布尔结果，不依赖其他判据的执行顺序

### Requirement: 每种浪型有一份 6 层验证手册
每种被支持的浪型 SHALL 拥有一份验证手册 `{ patternType, direction, rules[], guidelines[] }`，其条款按书的重要性顺序组织：浪型规则 → 比率规则 → 时间规则（三者为 Rules）→ 浪型指引 → 比率指引 → 时间指引（三者为 Guidelines）。

#### Scenario: 手册条款可溯源
- **WHEN** 查看某浪型手册的任一条款
- **THEN** 该条款带有稳定 `id`，可对照《波浪理论详解》相应章节的规则/指引

### Requirement: 否定法评分（先淘汰后排名）
引擎 SHALL 按否定法评估候选：按 `pattern → ratio → time` 顺序逐条测试 Rules，任一 Rule 失败即判定候选**被淘汰**并记录首个失败的 `failedRule` 及其 `layer`；仅当全部 Rules 通过时，候选**幸存**并计算其命中的 Guideline 集合与得分。引擎 MUST NOT 用 Guideline 的通过来抵消任何 Rule 的失败。

#### Scenario: 破坏一条比率规则即淘汰
- **WHEN** 某候选被假设为单锯齿，但其 b 浪的 `gross` 超过 a 浪的 `gross`（违反比率规则）
- **THEN** 该候选被标记为淘汰，`failedRule` 指向该比率规则，且不进入排名，即使它命中了全部指引

#### Scenario: 幸存候选按指引排名
- **WHEN** 多个候选均通过其手册的全部 Rules
- **THEN** 引擎按 `(guidelineScore 降序, endIndex 降序)` 对幸存候选排序，取首位为主选

### Requirement: 淘汰理由可解释
对每个被淘汰的候选，引擎 SHALL 在输出中给出可读的淘汰理由（哪条规则、在哪一层、实际值 vs 阈值），用于解释"为什么这段不是某浪型"。

#### Scenario: 报告含淘汰理由
- **WHEN** 生成分析报告
- **THEN** 报告为落选的主要备选浪型列出其 `failedRule` 的人类可读说明

### Requirement: 不使用书外技术指标参与判定
引擎的 Rules 与 Guidelines SHALL 只依据波浪结构、斐波那契比率、时间与艾略特通道等波浪理论内生要素；MUST NOT 让 RSI、MACD、KDJ、均线等外部技术指标参与否定或排名。

#### Scenario: RSI 不参与评分
- **WHEN** 新分析器运行
- **THEN** 任何候选的存活与排名均不依赖 RSI 背离；若展示 RSI，仅作旁注
