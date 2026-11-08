# 六组固定TradingView行情基准

六组 TradingView 行情基准均已冻结，每组 1,008 根，共 6,048 根。2026-11-08 已复核原始导出、冻结范围和同核校验指标的实测参数，任务 2.4 完成。首次加载、回放和重载证据另由 8.2 记录。Coinbase 和交易所 API 缓存单列为其他数据源。

## 固定窗口

六组均为普通K线、UTC、右端不包含2026-11-01 00:00，每组1008根已收盘K线。窗口按不同周期分别覆盖相应数量，不能把不同周期的第1008根当作同一个结构级别。

| feed | 图表周期 | UTC起点（包含） | UTC终点（不包含） |
| --- | --- | --- | --- |
| BINANCE:BTCUSDT | 60／1小时 | 2026-09-20 00:00 | 2026-11-01 00:00 |
| BINANCE:BTCUSDT | 240／4小时 | 2026-05-17 00:00 | 同上 |
| BINANCE:BTCUSDT | D／日线 | 2024-01-28 00:00 | 同上 |
| BINANCE:ETHUSDT | 60／1小时 | 2026-09-20 00:00 | 同上 |
| BINANCE:ETHUSDT | 240／4小时 | 2026-05-17 00:00 | 同上 |
| BINANCE:ETHUSDT | D／日线 | 2024-01-28 00:00 | 同上 |

机读计划在tests/fixtures/chanlun/market/plan.json，实际六组清单在tmp/chanlun/market-baseline-manifest.json，各组基准目录保存原CSV、整数tick OHLC和receipt.json。计划和采集回执保留当时的拟用参数。后续实际导出的同核校验参数见下节，正式指标的人工图表配置另由实图记录。

## 同核校验的实测参数

六组首次加载、暂停回放和独立重载的 18 份 CSV 均从原始文件重新核对。每组记录普通 K 线、交易所、周期秒数、价格精度 0.01、固定起点及样本上限 1,008。初始窗口参数为 5,000，未完成笔依赖上限为 64，线段工作预算为 8,192，中枢来源预算为 64。规则版本为 `chanlun-research-0.1`，同核标记为 `f66e1055`。

| 组别 | 源标记 | 周期秒数 | 基准标记 | 校验脚本 SHA-256 前 12 位 |
| --- | --- | --- | --- | --- |
| BTCUSDT-60 | 1 | 3,600 | 1368176984 | `c99b89f11983` |
| BTCUSDT-240 | 1 | 14,400 | 4392541 | `f11f2f12c97e` |
| BTCUSDT-D | 1 | 86,400 | 3541226968 | `9cfe1913c0ba` |
| ETHUSDT-60 | 2 | 3,600 | 2340620034 | `7b3091c98ed5` |
| ETHUSDT-240 | 2 | 14,400 | 740194453 | `1b7ecc6d748c` |
| ETHUSDT-D | 2 | 86,400 | 2878541099 | `be36a6830405` |

每组完整脚本哈希、固定窗口与运行参数保存在 `tmp/chanlun/market-validation/` 的脚本清单和 `platform-results.json`。原始采集 CSV 经原导入器重放后，冻结时价及导出范围与各组回执一致。实测参数仅绑定运行同核校验指标的六组图表；正式指标的 BTC1h 配置和显示证据见[实图验收](display-validation.md#正式指标实图验收)。

## BTC一小时采集步骤（已完成）

1. 图表品种切到BINANCE:BTCUSDT，周期1小时，普通K线。至少加载到2026-09-20 00:00 UTC之前；可以向左拖动补载。不要用BTCUSD、合约后缀或其他交易所替代。
2. 将tools/chanlun/market-capture.pine（副本tmp/chanlun/market-capture.pine）作为新指标添加。它只显示元数据表，数值plot只在数据窗口显示，没有价格曲线是正常的。可暂时隐藏其他指标以免表格重叠。
3. 图表菜单选择“导出图表数据”，保留辅助指标的数值列。时间可选Unix或带显式时区的ISO格式；无时区的本地时分秒会被拒绝。日线仅日期形式另受严格检查：用辅助收盘时间减86400000还原UTC开盘，要求UTC日对齐且日期标签完全一致，不按本机时区猜测。
4. CSV保存为D:\Workspace\crypto\tmp\chanlun\market-import\BTCUSDT-60.csv。导出可以包含目标窗口外的更多K线，工具只冻结表中指定窗口；窗口外的当前未收盘K线不会被纳入。
5. 告知本聊天保存路径，随后由工具导入核对。若缺少辅助列或历史不全，按具体报错修正导出，不补造数据。

TradingView官方说明CSV可包含时间、OHLC及脚本plot；数据窗口plot也可用于导出列名，见[官方指标FAQ](https://www.tradingview.com/pine-script-docs/faq/indicators/#is-it-possible-to-export-indicator-data-to-a-file)及[图表导出说明](https://www.tradingview.com/support/solutions/43000537255-how-to-export-chart-data/)。实际账号导出入口已由用户确认可见，BTC60导出文件中的预期辅助列也已实际观察并通过校验；精确上传辅助版本未独立核验。

辅助脚本修订（2026-11-06）：用户先回传旧版第4行两条`syminfo.tickerid`附加信息警告，当时未明确报告运行／导出成功。已按[官方图表信息说明](https://www.tradingview.com/pine-script-docs/concepts/chart-information/)先用`ticker.standard(syminfo.tickerid)`取得标准品种标识，再匹配BTC／ETH；普通图表检查仍保留。导出列名、feed代码、版本字段和窗口均未改变。后续已收到并校验BTC60的CSV，无需再为该组重编译／导出；其他组沿用辅助即可。版本历史见`tmp/chanlun/market-capture-status.json`。

## 导入与冻结

### 已采集：BTC一小时

用户回复“BTC1h已导出”。约定目录中的CSV通过全部导入条件，原始文件304023字节，实际导出范围为2026-09-02 05:00至2026-11-06 15:00 UTC（均为开盘时刻）。其中目标窗口2026-09-20 00:00至2026-11-01 00:00 UTC（右端不含）恰好1008根连续普通、已收盘K线，tick为0.01。源CSV带UTC+08:00时区，导入统一成UTC；额外Volume／MACD／K／D列忽略，窗口外未收盘末根不纳入。

基准目录：`tests/fixtures/chanlun/market/baselines/BTCUSDT-60/`。原CSV哈希为`91d0a8d75324d625c692953993d0bd8d2697109f4b9bb784817b661e9f39dc91`，整数tick数据哈希为`518cb958675ebe1dea5c34b9a18a8d808dbb9e029fad126d83c37945955d9bb9`。原始字节及冻结数据已回读校验；feed由辅助列代码1、用户导出上下文及原文件留存支持，不冒充第三方独立行情认证。辅助元数据已观察到成功导出，但精确上传辅助版本及正式指标参数仍未独立核验。详情见目录中的receipt.json；图表加载／回放／重载尚未执行。

### 已完成六组清单

用户回复“五组已导出，但是名字不和你给的一样”。已按CSV辅助列的feed代码和周期识别，不要求重命名。BTC一小时两份副本内容相同，只保留同一基准，不重复计数。六组每组均1008根，tick均0.01；目标窗口外数据和额外指标列不参与基准。

| 基准ID | 实际原文件名 | 导出最早开盘UTC | 导出最晚开盘UTC |
| --- | --- | --- | --- |
| BTCUSDT-60 | BTCUSDT-60.csv／BINANCE_BTCUSDT, 60_0d9c1.csv | 2026-09-02 05:00 | 2026-11-06 15:00 |
| BTCUSDT-240 | BINANCE_BTCUSDT, 240_8585a.csv | 2026-04-03 20:00 | 2026-11-06 12:00 |
| BTCUSDT-D | BINANCE_BTCUSDT, 1D_f2154.csv | 2023-06-25 00:00 | 2026-11-06 00:00 |
| ETHUSDT-60 | BINANCE_ETHUSDT, 60_daa7d.csv | 2026-08-18 17:00 | 2026-11-06 15:00 |
| ETHUSDT-240 | BINANCE_ETHUSDT, 240_cca8f.csv | 2026-04-05 00:00 | 2026-11-06 12:00 |
| ETHUSDT-D | BINANCE_ETHUSDT, 1D_d50b3.csv | 2023-01-04 00:00 | 2026-11-06 00:00 |

原文件位于`tmp/chanlun/market-import/`，每组原字节副本与冻结数据位于`tests/fixtures/chanlun/market/baselines/基准ID/`。各组原始／冻结哈希已回读核对，详见`tmp/chanlun/market-baseline-manifest.json`；无需重新导出或修改原文件名。

两份日线时间列为YYYY-MM-DD，旧工具按无显式时区拒绝。现仅对计划中的D／86400秒允许用`audit_close_time_ms`还原UTC开盘，并核对日期及整日对齐；日内日期标签、非法日期、与收盘元数据冲突的日期继续拒绝。通用`parseTime`不接受裸日期。原CSV未改，日线回执记录dateOnlyRows和timeInterpretation。新增2项针对检查与既有7项工具检查共9项通过；不是Pine算法结果。

### BTC1h 首次加载校验

生成入口为 `node tools/chanlun/build-market-validation.mjs`。脚本位于 `tmp/chanlun/market-validation/`，每组有自己的文件和清单。首轮运行 `btcusdt-60.pine`，窗口从 2026-09-20 00:00 UTC 起收录 1008 根已收盘 K 线。

1. 在 TradingView 退出回放，选择 BINANCE:BTCUSDT、1小时、普通 K 线。确保已加载固定起点或更早的历史。
2. 从图表移除“缠论行情基准采集辅助”，避免两份脚本的同名列同时进入 CSV。把 `btcusdt-60.pine` 作为新指标添加。
3. 独立窗格显示 `PASS: M-BTCUSDT-60, 1008 input bars` 后，用“导出图表数据”保留校验指标的数值列，保存为 `tmp/chanlun/market-validation/BTCUSDT-60-load.csv`。回传保存位置或首条完整错误。

脚本使用正式 CORE 和固定参数，核对每根开盘、收盘时间及四个价格。导出列记录计数、候选端点、当前中枢、资源状态和确认事件的两组滚动校验值。可打开“输出确认事件日志”读取对应的事件记录。数据窗口 plot 可导出为 CSV 列。 [TradingView 指标说明](https://www.tradingview.com/pine-script-docs/faq/indicators/#is-it-possible-to-export-indicator-data-to-a-file)

首次加载取得 CSV 后，用以下命令核对实际输出。后续记录回放和重载的操作条件，再比较各次导出中共同的已收盘前缀。回放期间能否在当前客户端导出数据待实测。

```powershell
node tools/chanlun/compare-market-traces.mjs BTCUSDT-60 'tmp/chanlun/market-validation/BTCUSDT-60-load.csv'
node tools/chanlun/compare-market-traces.mjs BTCUSDT-60 'tmp/chanlun/market-validation/BTCUSDT-60-load.csv' 'tmp/chanlun/market-validation/BTCUSDT-60-replay.csv'
```

比较报告标明共同前缀长度和两份文件各自的范围。两组滚动校验值用于定位确认事件差异，完整事件明细可用 Pine Logs 检查。

2026-11-07，BTC1h 首次加载的 1008 根已收盘输入和校验输出均通过 CSV 核对。留存 `tmp/chanlun/market-validation/BTCUSDT-60-load.csv`，结果为 359 个分型、78 笔、13 段、13 个 L0 和 1 个 L1 中枢，累计 465 个确认事件。

BTC1h 回放在北京时间 2026-10-11 10:00 收盘处暂停，用户报告面板为 `506/1008`。导出恰有 506 个有效前缀，所有校验列和确认事件校验值均与首次加载对应前缀一致。回放文件保存为 `tmp/chanlun/market-validation/BTCUSDT-60-replay.csv`，比较报告为 `tmp/chanlun/market-validation/btcusdt-60-75471630d8baef20.json`。

重载验证时退出回放，使用 TradingView 桌面端的 Ctrl+R 或 F5 重载同一图表标签页。等校验面板恢复 `PASS: M-BTCUSDT-60, 1008 input bars`，再导出一次。重载导出须包含 1008 根，由比较器对照首次加载的全部前缀。[TradingView 桌面快捷键](https://www.tradingview.com/support/solutions/43000623399-desktop-app-hotkeys/)

第一次重载导出包含第 867–1008 根。已核对其中 142 根的时间、OHLC 和全部 44 个校验字段，均与首次加载对应行一致。前 866 根待同一标签页补载后重新导出。部分覆盖的文件与报告分别保存在 `tmp/chanlun/market-validation/BTCUSDT-60-reload-tail-867-1008.csv` 和 `tmp/chanlun/market-validation/btcusdt-60-reload-tail-867-1008.json`。

同一标签页补载后，完整重载 CSV 的 1008 根和全部校验字段逐项匹配首次加载，两次输出的摘要一致。完整重载文件保存在 `tmp/chanlun/market-validation/BTCUSDT-60-reload.csv`，对照报告为 `tmp/chanlun/market-validation/btcusdt-60-1e2199f156917d25.json`。

### 其余五组首次加载

退出回放，使用表中对应的 BINANCE 现货普通 K 线和周期。加载到列出的北京时间或更早，再将对应脚本作为指标添加。图表上每次保留一个同源行情校验指标，避免导出时校验列重名。面板显示对应组的 `1008 input bars` PASS 后下载图表数据。CSV 可保留默认文件名，放在 Downloads。

| 组别 | 周期 | 加载至（北京时间） | 校验脚本 |
| --- | --- | --- | --- |
| BTCUSDT-240 | 4 小时 | 2026-05-17 08:00 | [btcusdt-240.pine](../../tmp/chanlun/market-validation/btcusdt-240.pine) |
| BTCUSDT-D | 日线 | 2024-01-28 08:00 | [btcusdt-d.pine](../../tmp/chanlun/market-validation/btcusdt-d.pine) |
| ETHUSDT-60 | 1 小时 | 2026-09-20 08:00 | [ethusdt-60.pine](../../tmp/chanlun/market-validation/ethusdt-60.pine) |
| ETHUSDT-240 | 4 小时 | 2026-05-17 08:00 | [ethusdt-240.pine](../../tmp/chanlun/market-validation/ethusdt-240.pine) |
| ETHUSDT-D | 日线 | 2024-01-28 08:00 | [ethusdt-d.pine](../../tmp/chanlun/market-validation/ethusdt-d.pine) |

首轮导出只需普通图表的首次加载。按品种和周期核对各组 1008 根后，再用独立的回放和重载导出做对照。

BTC4h 首次加载的 1008 根已通过核对，末行有 348 个分型、66 笔、13 段、13 个 L0、2 个 L1 中枢和 443 个确认事件。留存 `tmp/chanlun/market-validation/BTCUSDT-240-load.csv` 及 `tmp/chanlun/market-validation/btcusdt-240-eaea8a3aa3423898.json`。该组回放采样点为北京时间 2026-08-09 08:00 附近，单步推进三根后暂停并导出，以面板实际根数核对回放前缀。

BTC4h 回放补齐后，第 1–507 根与首次加载逐字段一致。独立重载的 1008 根也全部匹配，首次加载与重载的完整校验摘要一致。对照报告分别为 `tmp/chanlun/market-validation/btcusdt-240-fe5b40c71e2e04e0.json` 和 `tmp/chanlun/market-validation/btcusdt-240-08bfd344c8b38181.json`。

BTC 日线首次加载补齐后，完整 1008 根的时间、OHLC 和校验参数均通过核对。末行累计 332 个分型、65 笔、6 段、6 个 L0、2 个 L1 中枢和 412 个确认事件。首次加载报告为 `tmp/chanlun/market-validation/btcusdt-d-0501fa0b5b8f214a.json`。

BTC 日线回放以面板实际的 872/1008 为准，第 1–872 根逐项匹配首次加载。退出回放后独立重载的 1008 根也全部匹配，两份完整输出的校验摘要一致。回放与重载报告分别为 `tmp/chanlun/market-validation/btcusdt-d-e6bc7f9549068af9.json` 和 `tmp/chanlun/market-validation/btcusdt-d-450f19b02ede6a5c.json`。

ETH1h 首次加载覆盖 1008 根，末行累计 344 个分型、82 笔、15 段、15 个 L0、2 个 L1 中枢和 460 个确认事件。首次加载报告为 `tmp/chanlun/market-validation/ethusdt-60-12545158d88e3476.json`。

ETH1h 回放第 1–507 根与首次加载逐项匹配。独立重载的 1008 根也全部匹配，两份完整输出的校验摘要一致。回放与重载报告分别为 `tmp/chanlun/market-validation/ethusdt-60-3f0475b2905f42c2.json` 和 `tmp/chanlun/market-validation/ethusdt-60-cad6a5da8cec0385.json`。

ETH4h 重载先于完整的首次加载导出。首次加载补齐后，两份 CSV 各覆盖 1008 根，全部校验字段和确认事件校验值一致。末行累计 342 个分型、72 笔、9 段、9 个 L0、2 个 L1 中枢和 435 个确认事件。首次加载与重载对照报告为 `tmp/chanlun/market-validation/ethusdt-240-08d8fa49b9cdf8c2.json`。

ETH4h 回放 CSV 覆盖第 1–506 根，逐项匹配首次加载。回放报告为 `tmp/chanlun/market-validation/ethusdt-240-6327421927118142.json`。

ETH 日线首次加载覆盖 1008 根，末行累计 351 个分型、75 笔、8 段、8 个 L0、1 个 L1 中枢和 443 个确认事件。首次加载报告为 `tmp/chanlun/market-validation/ethusdt-d-82dee002e0634bea.json`。

ETH 日线回放第 1–871 根逐项匹配首次加载，重载的 1008 根也全部一致。回放与重载报告分别为 `tmp/chanlun/market-validation/ethusdt-d-e2a6d0fe90bd8e13.json` 和 `tmp/chanlun/market-validation/ethusdt-d-820a46ae0697ee98.json`。

六组各自首次加载与重载的 1008 根逐字段一致。BTC1h、BTC4h、BTC 日线、ETH1h、ETH4h、ETH 日线的回放分别核对前 506、507、872、507、506 和 871 根。六组对照均使用同一生产内核的校验指标。每根核对开收盘时间、OHLC、端点、层级、状态及确认事件校验值。平台证据见 `tmp/chanlun/market-validation/platform-results.json`。

### 工具命令

```powershell
node tools/chanlun/import-market-csv.mjs BTCUSDT-60 'D:\Workspace\crypto\tmp\chanlun\market-import\BTCUSDT-60.csv'
node --test tools/chanlun/import-market-csv.test.mjs
```

工具要求time/open/high/low/close，以及audit_feed_code、audit_timeframe_seconds、audit_tick_size、audit_standard、audit_closed、audit_close_time_ms、audit_capture_version。辅助列记录实际feed类别、周期秒数、tick、普通K线及收盘状态；它们不是第三方独立行情认证，原CSV仍须保留。

窗口内必须恰好1008根、按预期时间连续、无重复且已收盘。OHLC须合法，价格以十进制和BigInt精确换算为整数tick，不用浮点四舍五入掩盖偏差。tick若在窗口内改变会拒绝导入。原CSV的额外指标列不会进入计算基准。

首次成功后在tests/fixtures/chanlun/market/baselines/CASE_ID保存source.csv、bars.json、receipt.json。receipt记录原始／标准化哈希、feed证据边界、请求及实际／导出可用范围、tick、计划参数、工作区脚本与辅助版本；后者不冒充实际载入版本。已有基准与新数据不一致时拒绝覆盖，需要另建明确版本。相同数据重复导入会复用原基准并检查已有文件是否损坏。

测试数据只保存在临时目录，不能计入实际六组导出。成功冻结OHLC也不代表加载、回放、重载、真实多tick或资源压力验收通过；这些仍由8.2～8.4分别记录。完整递归与R完成门槛不因取得行情数据放宽。
