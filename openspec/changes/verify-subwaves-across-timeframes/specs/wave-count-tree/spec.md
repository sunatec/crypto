## ADDED Requirements

### Requirement: 楔形边界必须真实收敛
收缩楔形 MUST 验证 1–3 与 2–4 两条边界的正向间距缩小，不仅依赖 1/3/5 浪幅缩短。

#### Scenario: BTC 浪幅缩短但通道发散
- **WHEN** 楔形分点为 126296、80524.65、97963.62、60001、82814.23、57717.55
- **THEN** 边界发散 SHALL 被记录为价格硬违规

### Requirement: 排名与报告展示验证证据
候选 SHALL 保存所用周期、位置角色、状态及原因。待验子浪 SHALL 向父级传播；未知数法 SHALL NOT 标规则全过或确定完成。相同硬分时验证更完整者 SHALL 优先。

#### Scenario: 没有全部通过的候选
- **WHEN** 所有候选存在必要待验子腿
- **THEN** 报告 SHALL 明确暂定主选并列未决原因

### Requirement: 反弹身份和目标服从父级候选
简报、父级表和目标章节 MUST 使用同一派生身份；B 身份 SHALL 使用 B 的参考腿及后续 C，不得混用 XX/Z。仅突破摆动高点 SHALL NOT 独自确认推动三浪。

#### Scenario: 父级当前为 B
- **WHEN** 父级优先候选为 A–B–C 的 B
- **THEN** 简报与目标 SHALL 同样显示 B；未验证的父级 SHALL 保留假设语气
