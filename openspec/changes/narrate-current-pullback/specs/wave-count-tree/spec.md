# wave-count-tree

## ADDED Requirements

### Requirement: currentPullback 序列化扩展（回撤叙述子字段）
`inProgressTree.currentPullback` 的 JSON 序列化 SHALL 在保留现有字段的前提下，新增以下子字段，
且这些字段 MUST 与主计数树平级隔离（不改写主树，级别卫生）：
- `subDegree`: `{ tf, rankedPatterns[] }`——下钻所用子级别及其滤除违规后的竞争形态列表；
- `combinationReading`: `{ legs, xxRetracePct }`——联合形逐腿（W/X/Y/XX/Z）与 XX 对 Y 的回撤百分比；
- `structureLine`: 回撤真低点（续涨条件/拆段收尾点）；
- `zwaveTargets`: `{ breakPath[], trianglePath }`——Z 浪跌破路径完整目标阶梯与三角收缩路径。
当某项无法计算（如回撤未拆出联合形、未下钻）时，对应字段 SHALL 为 null，MUST NOT 报错。

#### Scenario: 联合形回撤输出全部子字段
- **WHEN** currentPullback 在子级别拆为联合形且 Z 浪可投影
- **THEN** JSON 的 currentPullback 含 subDegree / combinationReading / structureLine / zwaveTargets 四子字段，数值均由本次 K 线计算

#### Scenario: 无联合形读法时子字段降级为 null
- **WHEN** currentPullback 未拆出联合形（如枢轴仍不足、下钻后也不成形）
- **THEN** combinationReading 与 zwaveTargets 为 null，structureLine 仍给出真低点，序列化不报错

#### Scenario: 子字段不影响主树序列化
- **WHEN** 序列化整棵树
- **THEN** 主计数树（tree）输出与新增子字段前完全一致，新增字段仅出现在 inProgressTree.currentPullback 下
