## Context

Coinbase Exchange `/candles` 只支持 60/300/900/3600/21600/86400 秒粒度，单次最多 300 根；4h、周线、月线都由本地聚合得到（聚合对高低价无损）。现有三条取数路径都不落盘：

- 主周期：`analyze-wave-tree.js` 的 `main()` 调 `fetchCandles`（来自 `analyze-wave-manual.js`，自行分页，任何一页失败即整体抛错）。
- 跨周期验证：`wave-subwave-verification.js` 的 `fetchSharedHourly` 按 298 小时分页，Windows 上用 PowerShell 传输 `fetchCoinbaseHourPage`，单页失败记入 `fetchErrors` 并保留其余页。
- 回撤下钻：`drillPullback` 默认调 `fetchCandles`，可注入。

股票走 `market-data.js`，前复权/拆股调整会改写历史价格，本次不缓存。

## Goals / Non-Goals

**Goals:**
- 已收盘的 Coinbase K 线只拉一次；覆盖段内的真实断档不重复请求。
- 单页失败只影响该页，不污染缓存。
- 为「全部历史 + 周/月线背景」提供上市首日发现能力。
- 不改变分析结果：同样的行情数据进入引擎，输出逐字节一致。

**Non-Goals:**
- 股票数据缓存与复权失效检测。
- 「全部历史 + 周/月线背景」分析本身（另立变更）。
- 缓存容量上限、淘汰策略、多进程并发写协调。
- 换用 Binance 等提供原生周线的交易所（跨交易所极值对不上，破坏跨周期端点定位）。

## Decisions

### 1. 缓存层自己分页，按页记录覆盖段

缓存层对外提供 `getCandles(product, granularity, start, end, {refresh, now})`，内部计算「请求区间 − 覆盖段」得到缺口，再按 ≤300 根一页请求缺口，每页成功即并入 K 线与覆盖段。

- 备选：包住现有整段取数函数（`fetchCandles`）。否决——它任何一页失败就整体抛错，缓存无法知道哪些页已成功；且 `fetchSharedHourly` 与 `fetchCandles` 分页逻辑不同，包两层会重复。
- 页级传输复用现有实现：Node 环境用 `fetch`，Windows 上沿用 PowerShell 传输（`fetchCoinbaseHourPage` 推广到任意粒度）。传输函数作为参数传入，便于测试。
- `fetchSharedHourly` 改为调用缓存层；对外仍返回带 `fetchErrors` 的数组，验证器的待验证逻辑不变。

### 2. 覆盖段以「K 线开始时间」闭区间表示，取保守边界

覆盖段存 `[firstBarStart, lastBarStart]`（秒）。一页请求 `[s, e]` 成功后，覆盖 `[ceilToBar(s), lastClosedBarStart ≤ e − granularity]`；Coinbase 的 `end` 可能不含端点，因此不把 `e` 所在那根算作已覆盖，下次重叠请求一根即可。相邻或重叠的覆盖段合并。

### 3. 未收盘 K 线判定：`start + granularity > now`

这样的 K 线返回给调用方但不写入，覆盖段截止到最后一根已收盘 K 线。`now` 可注入，测试可控。

### 4. 存储格式：每个 产品×粒度 一个 JSON 文件

路径 `.cache/candles/coinbase/<PRODUCT>/<granularity>.json`，相对脚本所在目录（`__dirname`），而不是当前工作目录，避免在别处运行时散落缓存。内容：

```
{ "version": 1, "product": "BTC-USD", "granularity": 86400,
  "bars": [[ts, low, high, open, close, volume], ...],   // 与 Coinbase 原始行同序
  "covered": [[fromTs, toTs], ...],
  "listingTs": 1437350400 | null }
```

- 备选：SQLite（需新依赖）、按年分片（小时线全历史约 9.7 万根时才需要）。当前小时线只缓存验证窗口，单文件足够；版本号留出日后分片的迁移口。
- 写入：先写同目录临时文件再 `rename` 覆盖（Windows 上 Node 的 rename 会替换已存在文件）。
- 读取失败或版本不符：视为空缓存并在 stderr 提示，不中断分析。

### 5. 上市首日只在日线粒度发现

从缓存最早 K 线（或请求起点）向前按 300 天一页翻，遇到整页为空即停，最早一根记为 `listingTs`。之后请求更早区间直接截断到 `listingTs`。小时线不做发现，避免长时间停机的空页被误判为上市前。

### 6. `--refresh` 只重拉本次请求的区间

忽略覆盖段，对请求区间整段重拉；该区间内的旧 K 线删除后替换，覆盖段取并集。不清空其他区间，也不清除 `listingTs`。

### 7. 注入即绕过

`options.fetchHourly`、`drillPullback(…, fetchFn)` 等调用方显式注入的取数函数直接调用，不经缓存——现有测试全部依赖注入，行为保持不变。缓存层自身用注入的页传输与临时目录单测。

## Risks / Trade-offs

- [Coinbase 事后修正已收盘 K 线] → 极少见；提供 `--refresh` 手动纠正。
- [两个进程同时写同一文件] → 后写者覆盖，最坏只丢失部分覆盖段记录，下次多拉几页，不会产生错数据。
- [小时线长期使用后文件变大] → 只缓存实际验证过的窗口；如增长明显，按版本号迁移到按年分片。
- [上市前若存在超过 300 天的停牌空档] → 会把空档后的首根误记为上市首日；Coinbase 现货未见此情况，接受该假设并在 README 注明。
- [缓存命中后分析结果改变] → 目标是逐字节一致；以「同一区间缓存前后两次运行输出相同」作为验收。

## Migration Plan

首次运行时 `.cache/` 不存在则自动创建；删除 `.cache/` 即完全回到无缓存行为。无需迁移旧数据。

## Open Questions

- 是否需要 `--no-cache`（完全不读不写）。当前判断 `--refresh` 加删除目录已够用，暂不提供。
