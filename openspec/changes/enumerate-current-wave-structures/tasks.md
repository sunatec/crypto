# 任务：当前进行浪的竞争结构枚举

> 前置：`gate-extending-final-leg-rules` 已交付。取代 `mark-extending-leg-character-fork`。
> 仅改 `analyze-wave-tree.js`。首版原型，用户看输出后再调模板/投影/排名。

## 1. 当前进行浪段 + 模板拟合

- [ ] 1.1 取当前段 `curFine` = finePivots 中 index≥spanLast.index；识别观测腿（57718→81265→now）。
- [ ] 1.2 定义当前浪位模板目录（下跌推动③ / X连接·B / 新上涨推动② / 上涨锯齿 …），每个模板：
      指派观测腿到浪位、声明未走浪、失效点规则。
- [ ] 1.3 对每个模板：已走腿跑可判定规则（②回撤比、①性格等，复用 `legCharacter`）；
      未走浪用 `applyInProgressRuleGate` 暂缓不可判定规则；算 tier1/deferred。

## 2. 投影 + 失效点 + 排名

- [ ] 2.1 每模板算下一浪投影（复用 `computeLegExpectation`/斐波目标），标推断。
- [ ] 2.2 每模板算失效点（结构铁律：浪②不超浪①起点 / 跌破极值 等）。
- [ ] 2.3 否定法排名 + 按倾向/形态去重 + `CUR_RANKED_MAX`(≈6)。

## 3. 落点 + 渲染 + JSON

- [ ] 3.1 新增 `buildCurrentWaveStructures(spanLast, finePivots, candles, opts)`，`buildCountTree` 末尾调用，
      挂 `tree.currentWaveStructures`。
- [ ] 3.2 报告新增节「当前进行浪：可能的具体结构（按吻合排序）」：表格列子计数腿/当前浪位/下一浪投影/
      失效点/评分/待判。
- [ ] 3.3 `_tree.json` 平级挂 `currentWaveStructures`。
- [ ] 3.4 已有"父级候选/进行中结构"节精简或指向新表，避免重复。

## 4. 吸收 mark-extending-leg-character-fork

- [ ] 4.1 确认"下跌推动③"与"X连接/锯齿"两模板并存 = 覆盖原"末腿5浪/3波两可"。
- [ ] 4.2 归档/删除 `mark-extending-leg-character-fork` 提案（openspec archive 或删目录）。

## 5. 校验

- [ ] 5.1 单测（金标准）：当前进行浪结构表非空，至少含一条看跌(投影新低)+一条看多/中继(投影上方)，
      各带子计数、当前浪位、下一浪投影、失效点。
- [ ] 5.2 单测：在建型读法（浪②/③进行中）出现，且未走浪的可翻转规则被暂缓（不计 tier1）。
- [ ] 5.3 回归：历史段数法排名、框架A/B 顶层不变。
- [ ] 5.4 全量测试通过（5 个测试文件）+ `openspec validate enumerate-current-wave-structures --strict`。
- [ ] 5.5 人工核对金标准输出：结构合理、投影/失效点方向对，交用户验收再迭代。
