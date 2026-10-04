## 1. 缓存模块

- [x] 1.1 新建 `candle-cache.js`：读写 `.cache/candles/coinbase/<PRODUCT>/<granularity>.json`（版本号、bars、covered、listingTs），临时文件 + rename 原子写，读失败/版本不符视为空缓存并提示。
- [x] 1.2 实现覆盖段运算：请求区间减覆盖段求缺口、相邻/重叠段合并、页成功后按保守边界（不含 end 所在那根）并入覆盖段。
- [x] 1.3 实现 `getCandles(product, granularity, start, end, {transport, refresh, now})`：按 ≤300 根分页请求缺口，单页失败不记覆盖并收集到 `fetchErrors`，未收盘 K 线（start+granularity>now）返回但不写入，结果升序去重。
- [x] 1.4 实现日线上市首日发现：向前按 300 天翻页至整页为空，记录 `listingTs`；之后更早的请求截断到 `listingTs` 且不再发请求。
- [x] 1.5 实现 `--refresh` 语义：忽略覆盖段重拉请求区间，替换区间内旧 K 线，覆盖段取并集，保留 `listingTs`。

## 2. 接入取数路径

- [x] 2.1 把页级传输抽成可传入的函数：Node `fetch` 与 Windows PowerShell（由 `fetchCoinbaseHourPage` 推广到任意粒度）。
- [x] 2.2 `analyze-wave-tree.js` 主周期 Coinbase 取数改走缓存层；股票路径不变。
- [x] 2.3 `fetchSharedHourly` 改走缓存层，返回值仍带 `fetchErrors`；`options.fetchHourly` 注入时直接调用、不经缓存。
- [x] 2.4 `drillPullback` 默认取数改走缓存层；显式注入的 `fetchFn` 不经缓存。
- [x] 2.5 CLI 增加 `--refresh` 并传到各取数路径；`.gitignore` 加 `.cache/`。

## 3. 测试与验收

- [x] 3.1 单测（临时目录 + 注入传输与 now）：二次请求零网络、区间延伸只补拉尾部、零散窗口只补中间、覆盖段内断档不重拉、单页失败下次重拉、未收盘 K 线不落盘、上市首日发现与截断、`--refresh` 替换区间。
- [x] 3.2 确认注入桩的现有测试不读写 `.cache/`，全量测试通过。
- [x] 3.3 实网验收：同一 BTC-USD 日线区间连续运行两次，第二次无日线/小时线分页请求，两次 JSON 与 Markdown 输出一致。
- [x] 3.4 README 说明缓存位置、`--refresh`、删除 `.cache/` 即回到无缓存行为、上市首日假设；`openspec validate cache-candle-history` 通过。

## 4. 审查修正

- [x] 4.1 刚收盘 K 线加 5 分钟沉淀缓冲：缓冲内只临时返回、不写入、不计覆盖，避免未发布的 K 线被记成永久断档。
- [x] 4.2 分页请求失败按递增间隔重试（默认共 3 次），恢复旧 `fetchCandles` 的重试能力。
- [x] 4.3 补充单测：整点刚过的未发布 K 线之后会被补拉、缓冲内 K 线不落盘、瞬时错误重试成功、重试耗尽只报一次。
