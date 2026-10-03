## Why

日线递归使用同一批枢轴，子腿拆不出驱动结构就被判违规，而点数不足的叶子被当作通过。主选缺少 4h/1h 证据，楔形还漏检了真实边界收敛。

## What Changes

- 主计数和指定数法按候选位置角色验证子腿，日线到 4h、1h 按需下钻，结果反馈排名。
- 区分已验证、待验证、已违规；数据不足、深度上限及取数失败不冒充通过。
- 小时数据共享缓存，定位母级 K 线内真实极值时间，固定父腿区间。
- 修正楔形边界收敛及反弹 B/X/XX 身份与目标一致性。
- 使用 BTC 指定 W 及注入行情的回归测试，不预设最终主选。

## Capabilities

### New Capabilities
- `cross-timeframe-wave-verification`: 跨周期子腿验证、证据状态及共享行情。

### Modified Capabilities
- `wave-count-tree`: 排名和报告反映证据状态，楔形几何与父级身份一致。

## Impact

修改 analyze-wave-tree.js、README 和波浪树测试。保留同步离线引擎，CLI 增加异步验证；复用 Coinbase 小时 candles，无新依赖。保留现有未提交修改。
