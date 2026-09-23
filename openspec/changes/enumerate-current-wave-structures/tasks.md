# 任务：当前进行浪的竞争结构枚举

> 前置：`gate-extending-final-leg-rules` 已交付。取代 `mark-extending-leg-character-fork`。
> 仅改 `analyze-wave-tree.js`。首版原型，用户看输出后再调模板/投影/排名。

## 1. 当前进行浪段 + 模板拟合

- [x] 1.1 取当前段 `curFine` = finePivots 中 index≥spanLast.index；识别观测腿（顶层 spanLast→ext→now,
      同时保留内部细枢轴序列供 T4 使用）。（`post = finePivots.slice(iStart+1)` 本就是完整细枢轴
      序列，T1-T3 只取其首/末，T4 另取 `post[0..3]` 作 p1-p4，无需重复计算。）
- [x] 1.2 定义当前浪位模板目录：**T1 下跌推动③ / T2 X连接·B / T3 新上涨推动② /
      T4 上涨5浪推动·⑤进行中 /** （平台/三角等待迭代），每个模板：指派观测腿/子腿到浪位、
      声明未走浪、失效点规则。
- [x] 1.3 对每个模板：已走腿跑可判定规则（②回撤比、①性格等，复用 `legCharacter`）；
      未走浪只投影、不判定（v1 用模板自带的手工判据而非直接调用
      `applyInProgressRuleGate`——该函数面向 `decompose` 产出的候选形状，这里的模板是独立的
      手工对象；效果等价：未走腿从不进入 tier1 计算，天然满足"未走浪不误判违规"）；算
      tier1/deferred。
- [x] 1.4 **T4 触发门槛**：当前段内 finePivots ≥ 5 个可用枢轴（能形成 ①②③④ + 现价作 ⑤ 起步）；
      p4（④底）取"④ 段结束时的低点"锚定失效点，不随每根新 K 线漂移。（`post.length >= 5` 时才
      生成 T4；p4 固定取 `post[3]`，只要新增枢轴追加在其后，p4 本身不再变。）
- [x] 1.5 **T4 硬规则可判部分**（BTC 例, ①=57718→66923, ②=66923→62209, ③=62209→81479,
      ④=81479→76219, ⑤=76219→now⏳）：`②不入①起点` / `③不最短` / `④不入①领地`。
      交替性、指引等软信号后置。（金标准 fixture 的实际 p1-p4 与上例不同批数据，见 5.3 说明；
      三条硬规则判据均已实现并在该 fixture 上触发 ③最短 与 ④入①领地 两处违规，验证规则确实生效。）

## 2. 投影 + 失效点 + 排名

- [x] 2.1 每模板算下一浪投影（复用 `computeLegExpectation`/斐波目标），标推断。
      T4 的 ⑤ 目标口径：`0.618 × 净①→③` 或 `1.0 × ①`，基于 p4 上方投影。
- [x] 2.2 每模板算失效点（结构铁律：浪②不超浪①起点 / 跌破极值 等）。T4 的失效点用 p4（④底）；
      严格版加"跌破 p1 = ①顶"作为"④入①领地"边界（可选，标严格，已作为 reason 文案附注）。
- [x] 2.3 否定法排名 + **按 `label` 去重**（不再按 `tendency`，避免 T3/T4 同为"看多"被压掉一条）+
      `CUR_RANKED_MAX`(≈6)。
- [x] 2.4 **放开 `ips.swingChar` 独占**：若 `canDrive && canCorrect`，T4（driving 读法）与
      T1/T2（corrective 读法）SHALL 同时进入排名；swingChar 仅保留作叙述"主选"，不阻断 T4 生成。
      （`buildCurrentWaveStructures` 本就不读 `ips.swingChar`，T1-T4 各自独立生成，天然不受其
      独占影响；已加注释明确此不变量，避免日后误引入门槛。）

## 3. 落点 + 渲染 + JSON

- [x] 3.1 新增 `buildCurrentWaveStructures(spanLast, finePivots, candles, opts)`，`buildCountTree` 末尾调用，
      挂 `tree.currentWaveStructures`。
- [x] 3.2 报告新增节「当前进行浪：可能的具体结构（按吻合排序）」：表格列子计数腿/当前浪位/下一浪投影/
      失效点/评分/待判。
- [x] 3.3 `_tree.json` 平级挂 `currentWaveStructures`。
- [x] 3.4 已有"父级候选/进行中结构"节精简或指向新表，避免重复。（`renderMultiDegree` 的"现在走到哪了"
      节在有多条竞争结构时加一行指向新表的提示，原叙述内容保留不删，避免破坏既有金标准断言。）

## 4. 吸收 mark-extending-leg-character-fork

- [x] 4.1 确认"下跌推动③"与"X连接/锯齿"两模板并存 = 覆盖原"末腿5浪/3波两可"。
- [x] 4.2 归档/删除 `mark-extending-leg-character-fork` 提案（openspec archive 或删目录）。
      （已执行 `openspec archive mark-extending-leg-character-fork -y`，归档为
      `openspec/changes/archive/2026-09-11-mark-extending-leg-character-fork`，其 spec delta 已
      合并进 `openspec/specs/wave-count-tree/spec.md`。该提案代码此前已完整实现并有金标准测试
      覆盖，归档只是补齐流程记录，不影响已交付的 `annotateExtendingLegForks` 等代码。）

## 5. 校验

- [x] 5.1 单测（金标准）：当前进行浪结构表非空，至少含一条看跌(投影新低)+一条看多/中继(投影上方)，
      各带子计数、当前浪位、下一浪投影、失效点。
- [x] 5.2 单测：在建型读法（浪②/③进行中）出现，且未走浪的可翻转规则被暂缓（不计 tier1）。
- [x] 5.3 **单测（T4 金标准, BTC fixture）**：当前段 finePivots ≥ 5 时，输出中 SHALL 含 T4
      "上涨5浪推动·⑤进行中"，子计数腿完整含 ①②③④+⑤⏳，失效点=p4，
      投影 ⑤ 目标区在 p4 上方；且 T3 "浪②进行中" **不因倾向去重被压掉**（label 去重生效）。
      （金标准 fixture 的 post-spanLast 枢轴序列与 design.md 的示例数值来自不同批次的实时行情，
      实测 p1-p4 = 64669.42/61750.9/65559.5/62452.52，非示例中的 66923/62209/81479/76219——
      测试改用 fixture 实测值断言，不依赖 design.md 的示例数字；示例数字仅用于说明口径。）
- [x] 5.4 回归：历史段数法排名、框架A/B 顶层不变。（全量测试含既有金标准断言原样通过，未改动
      `decompose`/`buildRankedCounts`/`buildCounterTrendFrameworkB` 等历史段路径。）
- [x] 5.5 全量测试通过（5 个测试文件）+ `openspec validate enumerate-current-wave-structures --strict`。
      （123/123 测试通过；`openspec validate enumerate-current-wave-structures --strict` 通过。）
- [x] 5.6 人工核对金标准输出：结构合理、投影/失效点方向对，交用户验收再迭代。（已打印
      BTC 金标准 fixture 的实际渲染表格核对：T1 续跌③进行中(违规×1)、T2 中继、T3 转势②进行中、
      T4 末浪⑤进行中(违规×2，③最短+④入①领地被规则正确捕捉)，四条方向/失效点/投影均合理。）
