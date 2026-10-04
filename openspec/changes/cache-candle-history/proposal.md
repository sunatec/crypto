## Why

每次运行都从 Coinbase 重新拉取主周期 K 线和跨周期验证所需的小时线，已收盘的 K 线不会再变，却被反复下载。后续要按书 §3.10/§3.12 从上市首日起看全部历史（BTC 日线约 4100 根、每次请求上限 300 根），不缓存就意味着每次运行都多出十几次分页请求。

## What Changes

- 新增项目内持久化 K 线缓存 `.cache/`（加入 `.gitignore`），只缓存 Coinbase 加密货币行情；股票数据源（Twelve Data、东方财富）本次不缓存。
- 缓存按 产品 × 粒度 存储已收盘 K 线，并记录「已拉取过的时间段」，段内缺失的 K 线视为交易所真实断档，不重复请求。
- 取数时只请求缓存未覆盖的时间段，再与缓存合并返回；未收盘的最后一根 K 线不写入缓存。
- 支持向前翻页直到接口返回空，找到上市首日，并在缓存中记录，供后续「全部历史」分析使用。
- CLI 新增 `--refresh`：忽略已有缓存、重新拉取所请求的区间并覆盖写回。
- 主周期取数、跨周期小时线验证（含 Windows PowerShell 传输）、回撤下钻均经由同一缓存层；测试注入的取数桩不经过缓存。

## Capabilities

### New Capabilities
- `candle-cache`: Coinbase K 线的本地持久化缓存——覆盖段记录、增量补拉、未收盘 K 线排除、上市首日发现与强制刷新。

### Modified Capabilities
<!-- 无：分析结果与报告的需求不变，缓存只改变数据从哪里来。 -->

## Impact

- 新增缓存模块；`analyze-wave-tree.js` 主取数、`wave-subwave-verification.js` 小时线取数、`drillPullback` 改为经由缓存层。
- `.gitignore` 增加 `.cache/`；README 说明缓存位置与 `--refresh`。
- 不新增依赖；股票取数路径与旧 `analyze-wave-manual.js` CLI 行为不变。
