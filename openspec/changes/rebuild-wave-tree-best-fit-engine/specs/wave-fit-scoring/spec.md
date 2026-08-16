# wave-fit-scoring

## ADDED Requirements

### Requirement: 判据返回越界距离而非仅布尔
每条规则/指引的 `test()` SHALL 返回 `{ pass, overshoot }`，其中 `overshoot` 为违反时相对阈值归一化的越界距离、通过时为 `0`。比率规则 SHALL 以"超出区间的量 ÷ 区间宽度"度量，形态规则 SHALL 以"归一化价格距离 ÷ 参考浪幅"度量。

#### Scenario: 通过的规则越界为零
- **WHEN** 某比率落在规则允许区间内
- **THEN** 该规则 `pass=true` 且 `overshoot=0`

#### Scenario: 违反的规则报出越界程度
- **WHEN** 某比率超出规则允许区间
- **THEN** 该规则 `pass=false` 且 `overshoot` 为超出量相对区间宽度的归一化正值

### Requirement: 分层字典序拟合分
候选排序 SHALL 使用分层字典序键（全部升序）：tier1=违反硬规则条数；tier2=违反规则的越界距离之和；tier3=形态内指引未命中率；tier4=跨级别指引（交替 / 父子斐波比例 / 通道贴合 / 浪个性价格特征），仅作平局裁决。

#### Scenario: 违规更少者优先
- **WHEN** 两个候选一个违反 0 条硬规则、另一个违反 1 条
- **THEN** 违反 0 条者排在前，与指引命中数无关

#### Scenario: 跨级别指引仅在前三层持平时裁决
- **WHEN** 两个候选 tier1–tier3 完全相同
- **THEN** 由 tier4（交替/通道/父子斐波/浪个性）命中更多者胜出

### Requirement: 有条件优雅降级
引擎 SHALL 优先输出全过硬规则（tier1=0）的候选；当某节点无任何候选 tier1=0 时，MUST 回退到 tier1 最小者作为该节点临时主选，并打 `penalized`（违规）标记与 near-miss 说明。

#### Scenario: 无完美候选时给出最接近者
- **WHEN** 某节点所有候选都至少违反一条硬规则
- **THEN** 输出违规最少/最轻者，标 `penalized` 并说明"违反 N 条，最重的是 X 越界 Y%"

#### Scenario: 存在完美候选时不降级
- **WHEN** 某节点存在 tier1=0 的候选
- **THEN** 主选从 tier1=0 的候选中选出，不采用带 `penalized` 的候选

### Requirement: 书中知识按维度分层落位
拟合分与输出 SHALL 按知识维度分工：硬规则入 tier1–2；指引与斐波价格验证入 tier3；斐波时间共振/通道判别/交替/浪个性价格特征入 tier4；斐波价格目标与通道完成入投影层（驱动进行中浪预期、不参与评分）；量能仅作注记不参与排序；动量/背离排除在外。

#### Scenario: 量能只注记不排序
- **WHEN** 某候选的量能配合或不配合书中个性
- **THEN** 报告注记量能是否配合，但候选排序不因量能改变

#### Scenario: 斐波与通道目标只驱动预期
- **WHEN** 计算进行中浪的预期
- **THEN** 斐波价格目标与通道完成线用于给出目标区间（标注为推断），但不进入 tier1–tier4 评分
