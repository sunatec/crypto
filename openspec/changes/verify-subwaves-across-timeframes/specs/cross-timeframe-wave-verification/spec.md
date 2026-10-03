## ADDED Requirements

### Requirement: 竞争候选按位置角色跨周期验证
日线分析 SHALL 对竞争候选使用相同位置规则与缓存，从 4h 开始验证必要子浪，不足或歧义时继续到 1h。验证 SHALL 反馈主计数及指定数法排名，而不仅添加叙述。

#### Scenario: 指定 W 单锯齿候选
- **WHEN** W 以 126296、103516.75、116410.06、80524.65 分段，日线 c 不能合规驱动
- **THEN** 引擎 SHALL 检查 c 的 4h/1h 角色证据，不仅凭日线最佳调整读法判死该候选

### Requirement: 待验证必须独立于通过和违规
系统 MUST 标识 verified、pending、invalid。点数不足、缺失数据、深度/搜索上限或取数失败 SHALL 为 pending。未知 SHALL NOT 记为验证通过；未穷尽的搜索失败 SHALL NOT 作确定证伪。

#### Scenario: 小周期仍无足够证据
- **WHEN** 到 1h 仍不能证明必要子结构或接口失败
- **THEN** 父级 SHALL 保留待验原因与所用周期，不输出规则全过

### Requirement: 固定母级端点并共享小时行情
系统 MUST 读取完整端点桶，在小周期定位真实极值后裁剪；小时与四小时 SHALL 复用同一行情，不混用周期索引；重复窗口 SHALL 命中缓存。

#### Scenario: 低点在终点日午后
- **WHEN** 日线终点时间戳为桶起始，而真正低点在该日午后
- **THEN** 取数 SHALL 包含午后并定位低点，不提前截断验证区间
