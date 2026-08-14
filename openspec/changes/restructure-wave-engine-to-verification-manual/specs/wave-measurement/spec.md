# wave-measurement

## ADDED Requirements

### Requirement: 三种一等浪型度量
系统 SHALL 对任意由有序拐点序列定义的浪型或子浪，计算三种度量：`价格(price)`、`运行总量(gross)`、`价格运动百分比(movePct)`，并以命名字段暴露，供比率判据引用。

- `price` = 浪型起点价到终点价的落差（方向敏感：上涨浪为终点−起点，下跌浪为起点−终点）。
- `gross` = 浪型内所有子浪的最高点与最低点之差。
- `movePct` = (最高点 − 最低点) / 最低点。

#### Scenario: 未衰竭推动浪 price 等于 gross
- **WHEN** 一段推动浪的终点即为其最高/最低点（无 5 浪衰竭）
- **THEN** 该浪型的 `price` 与 `gross` 相等

#### Scenario: 5 浪衰竭时 price 小于 gross
- **WHEN** 推动浪第 5 浪未超过第 3 浪终点（衰竭）
- **THEN** `gross` 以 1 浪起点到 3 浪终点计算，`price` 以 1 浪起点到 5 浪终点计算，二者不相等

### Requirement: 比率判据必须声明度量基准
每一条涉及长度比率的规则或指引 SHALL 显式声明其基准 `basis ∈ {price, gross, movePct}`；引擎在测试该判据时 MUST 使用声明的基准值，不得混用。

#### Scenario: 平台形 b 浪回撤以运行总量为基准
- **WHEN** 校验平台形 b 浪"回撤 a 浪 70%"这一比率规则
- **THEN** 引擎使用 a 浪与 b 浪的 `gross` 计算比值，而非 `price`

#### Scenario: 单锯齿 b 浪比率以价格为基准
- **WHEN** 校验单锯齿 `a ≥ b ≥ 0.2a` 这一比率规则
- **THEN** 引擎使用 a 浪与 b 浪的 `price` 计算比值

### Requirement: 复用既有取数与枢轴检测
新分析器 SHALL 使用与 `analyze-kline-wave.js` 等价的 K 线取数（Coinbase）、时间框聚合与 ATR 过滤的 ZigZag 枢轴检测逻辑，作为度量与浪型识别的输入；且 MUST NOT 修改 `analyze-kline-wave.js`。

#### Scenario: 老脚本零改动
- **WHEN** 新分析器交付
- **THEN** `analyze-kline-wave.js` 内容与提案前逐字节一致
