## MODIFIED Requirements

### Requirement: 交付独立Pine v6形态指标

系统 SHALL 提供 `chanlun_original.pine`，以 Pine v6 `indicator()` 在当前图表普通 K 线上独立运行，不依赖外部运行服务、发布的 Pine 库或其他周期请求。指标 MUST 覆盖包含、分型、笔、线段、自然递归和中枢。背驰、MACD 面积、买卖点与提醒 SHALL 按 `chanlun-signals` 实现，只读消费形态内核的已确认结构，MUST NOT 改变形态结构的确认结果。策略回测与下单 SHALL 不出现在指标功能和设置中。

#### Scenario: 用户粘贴脚本到TradingView
- **WHEN** 用户将正式文件粘贴到 Pine 编辑器并加载到支持的普通 K 线图表
- **THEN** 指标 SHALL 编译并运行，无需配置 Node 服务、API key 或其他 Pine 库

#### Scenario: 用户选择非普通图表
- **WHEN** 指标运行于 Heikin Ashi、Renko 等非标准图表
- **THEN** 系统 SHALL 明确提示该输入类型不在支持范围，并停止输出声称通过本规则验证的确认结构、信号与提醒

#### Scenario: 关闭全部信号显示
- **WHEN** 用户关闭背驰与买卖点的显示和提醒
- **THEN** 形态结构的计算结果与确认历史 SHALL 与开启时完全一致

### Requirement: 图表展示具有明确参考映射与验收

系统 SHALL 以用户指定的公开预览为视觉参考，记录线条层次、半透明中枢、类型文字、结构编号、买卖点标记和参数控制到本指标的映射。结构标签 MUST 标明层级或类型；走势类型 SHALL 来自计算内核，尚未确定时保持待定/进行中。结构 ID MUST 与买卖点信号编号区分；买卖点标记 SHALL 只来自已实现并确认的信号。普通视图与研究视图 SHALL 分别保存渲染证据，核对层次可辨、K 线可读、同层配色、标签密度及信号标记的可读性。

#### Scenario: 已确定的走势显示类型
- **WHEN** 内核按规则确定某层走势为盘整、上涨或下跌
- **THEN** 该层类型标签 SHALL 显示对应层级和类型；未确定的候选 SHALL 不仅按斜率标为已确认趋势

#### Scenario: 参考图具有交易信号或MACD数值
- **WHEN** 公开预览或发布说明包含圈号买卖点、MACD 面积或警报能力
- **THEN** 功能对照 SHALL 标明本指标对应的已实现信号、规则 ID 及差异；仍未实现的项目 SHALL 标为后续阶段，不使用假数值、信号占位或未实现的设置项

#### Scenario: 买卖点与结构编号同时显示
- **WHEN** 同一端点既有结构编号又有确认的买卖点
- **THEN** 两者 SHALL 使用可区分的样式与文字，买卖点标记 SHALL 标明层级与类型
