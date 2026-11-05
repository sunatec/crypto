## ADDED Requirements

### Requirement: 进行中结构的摆动极值纳入未确认的边界极值

进行中结构（反弹起点 → 现在）的摆动极值 MUST 取以下两者中更极端的一个：已确认枢轴中的极值；最后一个确认枢轴之后、窗口末端各 K 线的极值（上冲段取最高价，下跌段取最低价）。取后者时，摆动极值 MUST 标记为 `provisional: true`。

摆动极值变为 provisional 新极值后：
- 原摆动极值与其后回撤低点之间的那段 MUST 视为上冲（或下跌）段内部的子浪，MUST NOT 再作为轴② 的进行中回撤腿呈现；
- 新极值之后没有反向确认枢轴时，`currentPullback` MUST 为 null，回撤叙述 MUST NOT 输出；
- 回撤位、轴② 各情景的下一腿投影、X/B 反弹占 W 的比例，MUST 以新极值重新计算；
- 失效位 MUST 保持为反弹起点，不随新极值移动。

#### Scenario: 现价越过 78164

- **WHEN** 最后一个确认枢轴为 L 77748.09 @ 2026-11-04 14:00，其后 K 线最高价为 H ≥ 78462，而已确认枢轴中的摆动极值为 78164
- **THEN** `inProgressTree.swingExtreme.price` 等于那个更高的 H，且 `provisional` 为 true
- **AND** `inProgressTree.currentPullback` 为 null
- **AND** 轴② 中不出现“b 腿（进行中）”或“浪②（进行中）”，当前腿写作 a / 浪① 延伸中
- **AND** 失效位仍为 75736.38

#### Scenario: 现价未越过摆动极值

- **WHEN** 最后一个确认枢轴之后的 K 线最高价没有越过已确认的摆动极值
- **THEN** 摆动极值、`currentPullback`、回撤位与改动前完全一致

#### Scenario: 简报与正文一致

- **WHEN** 摆动极值为 provisional 新极值
- **THEN** 简报第 2 条写“仍在延伸中”，与轴② 一致，不再出现“回调或已结束”
