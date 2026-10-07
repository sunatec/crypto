# Kline Wave Analyzer

基于 Coinbase K 线数据做自动化 Elliott 波浪结构识别，输出：

- 原始/整理后的 K 线数据 JSON
- 波浪分析 Markdown 报告
- 可交互查看的 HTML 报告

## 快速使用

```bash
node analyze-kline-wave.js --product BTC-USD --tf 1h --start 2026-02-06T00:00:00+08:00 --end now
```

这条命令默认会生成 3 个文件：

- `<product>_<tf>_<start>_<end>.json`
- `<product>_<tf>_<start>_<end>.md`
- `<product>_<tf>_<start>_<end>.html`

## 命令格式

```bash
node analyze-kline-wave.js [options]
```

## 参数说明

- `--product` 交易对，默认 `BTC-USD`
- `--tf`, `--timeframe` 周期，支持：`5m | 1h | 4h | 1d | 1w | 1m | 1y`
- `--verify-tf 1h|4h|off`：加密货币默认验证至 1h。日线候选子腿按位置角色只在声明的最细周期上检查（默认 1h；选 4h 时用小时行情合成 4h）——非最细周期不是分辨率边界，结果必然待定，故不再检查。`off` 关闭额外取数：日线上拆出的角色违规照计，没有较小周期证据可以撤销。交易所断档（如 Coinbase 偶发的数小时无成交）：≤6 小时、且所在日线的最高/最低价都已出现在现有小时线里时，按前收→后开线性插补后验证，证据里记 `dataGaps` 并在理由中注明；更长的断档或日线极值可能落在断档里时不插补，保持待验证并写明断档时段。
- `--start` 开始时间，ISO 字符串；默认是 `end - 30d`
- `--end` 结束时间，ISO 字符串或 `now`；默认 `now`
- `--out` 输出 JSON 文件名；不填则自动命名
- `--report` 输出 Markdown 文件名；不填则自动命名
- `--html` 输出 HTML 文件名；不填则自动命名
- `--lookback` 枢轴点识别窗口，默认 `2`
- `--atr-period` ATR 周期，用于枢轴噪音过滤，默认 `14`
- `--atr-multiplier` 最小枢轴价差系数，规则是 `ATR * multiplier`，默认 `1.5`
- `--rsi-period` RSI 周期，用于动量/背离判断，默认 `14`
- `--brief` 只在控制台输出简短结果，不写文件
- `--full-report` 输出旧版完整 Markdown 报告
- `--help`, `-h` 显示帮助

## 默认输出命名

如果没有显式指定 `--out`、`--report`、`--html`，脚本会按 `UTC+8` 时间戳自动命名：

- JSON：`<product>_<tf>_<start>_<end>.json`
- Markdown：`<product>_<tf>_<start>_<end>.md`
- HTML：`<product>_<tf>_<start>_<end>.html`

例如：

- `BTC-USD_1h_202602060000_202603172253.json`
- `BTC-USD_1h_202602060000_202603172253.md`
- `BTC-USD_1h_202602060000_202603172253.html`

## 常用示例

生成默认精简版 Markdown、JSON、HTML：

```bash
node analyze-kline-wave.js --product BTC-USD --tf 1h --start 2026-02-06T00:00:00+08:00 --end now
```

指定输出文件名：

```bash
node analyze-kline-wave.js --product BTC-USD --tf 1h --start 2026-02-06T00:00:00+08:00 --end now --out btc_1h.json --report btc_1h.md --html btc_1h.html
```

输出旧版完整 Markdown 报告：

```bash
node analyze-kline-wave.js --product BTC-USD --tf 1h --start 2026-02-06T00:00:00+08:00 --end now --full-report
```

只看控制台简报，不生成文件：

```bash
node analyze-kline-wave.js --product BTC-USD --tf 1h --start 2026-02-06T00:00:00+08:00 --end now --brief
```

调整枢轴识别灵敏度：

```bash
node analyze-kline-wave.js --product BTC-USD --tf 1h --start 2026-02-06T00:00:00+08:00 --end now --lookback 3 --atr-period 14 --atr-multiplier 1.8 --rsi-period 14
```

## 当前 Markdown 输出说明

默认 Markdown 是精简版，重点输出：

- `数据概览`
- `算法结构推演`

如果你需要旧版完整报告，使用：

```bash
node analyze-kline-wave.js ... --full-report
```

## 波浪计数引擎 analyze-wave-tree.js

以《波浪理论详解》为准绳，对整段行情递归拆解，产出「最大级别 → 当前浪」计数树。核心特性：

- **否定法排序（Negation Method）**：硬规则淘汰不合法数法、准则给存活者排序；若无零违规候选，退取「最轻违规者」并标注 `penalized`。
- **框架 A / 框架 B**：A＝大跌到全局极值即算完成；B＝末浪进行中（如 `126296→now` 的 y 浪未走完），并对最后一个转折点之后的反弹做身份研判（XX 连接浪 / 更大级别 B 浪 / 新推动浪第 1、3 浪）。
- **文法 + 几何双闸**：校验各腿角色能否履行，并要求连接浪方向交替、腿端点为该跨度真极值。子浪角色按书细化到具体形态、严格判定（该位置允许的形态里拆不出规则全过的读法即计违规）：
  - 双/三锯齿的 w、y、z 须为**单锯齿**（书 7.3）；联合形的 w、y、z 须为**简单调整浪**（单锯齿 / 平台形 / 收缩三角形，书 1.7）；x、xx 可为任意调整浪。
  - 单锯齿 a 浪＝推动浪或**引导楔形**，c 浪＝推动浪或**终结楔形**，a 为引导楔形时 c 不能是终结楔形（书 4.5）；平台形 c 浪＝推动浪或终结楔形（书 5.3）。
  - 推动浪 1 浪＝推动浪或引导楔形，3 浪＝推动浪，5 浪＝推动浪或终结楔形（书 1–7 章未明文，按 Frost & Prechter 补足，违规说明带「（EWP）」）。
  - 终结楔形内部 3-3-3-3-3；引导楔形内部 5-3-5-3-5 或 3-3-3-3-3。顶层无父级位置时两种楔形合并为一条「推动浪（楔形 Diagonal，位置待定）」。
- **JSON 注意**：`patternId` 中原 `diagonal` 已拆为 `diagonal-leading` / `diagonal-ending`；顶层位置待定的楔形为 `diagonal-leading` 并带 `positionPending: true`。
- **七节结构化报告**：范围 / 关键转折点 / 已完成浪型（逐腿起止+内部结构+价格·时间比例+排除理由）/ 当前主方案 / 备选方案 / 方案排序 / 最终话术。反弹方案强制点明修正对象（XX→上一子浪、B→整段），wave-3 用书内结构验证（不看动量、不因涨幅大直接判 3 浪）。
- 强弱用 **高/中/低** 分档，不给概率百分比；所有数字均由本次 K 线自动计算。

### 快速使用

```bash
node analyze-wave-tree.js --product BTC-USD --tf 1d --start 2025-10-05T00:00:00+08:00 --end now
```

每次运行按 `UTC+8` 时间戳自动生成 2 个文件：

- `<product>_<tf>_<start>_<end>_tree.json` — 计数树 + 进行中腿 + 排名 + 跨级别序列化
- `<product>_<tf>_<start>_<end>_tree.md` — 波浪分析报告（唯一 Markdown 输出）

「当前高点回撤研判」列明高点、结构低点、前段上涨及内部最大回撤的价格与日期，并比较本次回撤幅度。日线及以上按 UTC 日期展示；下钻得到的子级别点带时分与 UTC。结构低点是幅度的量度终点，可能与当前边缘价不同。

按书§3.3，升级线 = 高点 − 前段上涨内部最大回撤幅。未超过时，在「续涨条件」后单列升级线；已超过时在首段注明已跌破；无可比回撤时不显示。Z 目标低于此线的档位会标注「低于升级线」。Z 在升级线上方走完仍看转涨；跌破则按同源的轴③主选身份说明后续（X→Y 下跌、B→C 下跌、推动 3 浪→高一级调整后再涨），不同源或无主选时回退为重新研判。本节 W-X-Y-Z 为子浪级数法，升级后仅作参考。

JSON `inProgressTree.currentPullback.narrative` 保存锚点（`level.extreme/rallyStart/maxInternal.fromTs/toTs`、`structureLow{price,timestamp,tf}`）、可用时的 `upgradeLine`、Z 各档 `belowUpgradeLine` 和跌破结局 `afterUpgrade{basis,lean,text}`。主目标带另记低端、高端及 0.236 破位档的升级线标记。既有 `currentPullback` 平级字段与 `maxInternal.from/to` 价格字段保留。

### 参数说明

- `--product` 代码，默认 `BTC-USD`。按格式自动识别市场：`BTC-USD`→加密货币（Coinbase）、6 位数字如 `600519`→A 股（东方财富，前复权）、纯字母如 `AAPL`→美股（Twelve Data，按拆股复权）
- `--source coinbase|twelvedata|eastmoney` 手动指定数据源（如美股改用东方财富）
- `--apikey` Twelve Data key（美股必需），也可设环境变量 `TWELVE_DATA_API_KEY`
- `--tf`, `--timeframe` 周期，支持：`5m | 1h | 4h | 1d | 1w | 1m | 1y`；股票仅 `1d | 1w`（只用已收盘 K 线，不做子级别下钻）
- `--start` 开始时间，ISO 字符串；默认 `end - 30d`
- `--end` 结束时间，ISO 字符串或 `now`；默认 `now`
- `--out` 输出 JSON 文件名；不填则自动命名
- `--report` 输出 Markdown 文件名；不填则自动命名
- `--count "p1,p2,p3,p4"` 喂入你自己的数法（一组转折价格），引擎逐条按规则打分并并入报告
- `--background on|off` 全部历史的周线/月线背景；加密货币默认 `on`，股票强制关闭。首次取全部日线，之后命中缓存；取数失败时附原因，主分析照常输出。
- `--ignore-thin-spikes` 把疑似乌龙针的极值截到参考价后再数浪，并同步截取小时线验证和回撤下钻数据。有量扎针保留。默认只检测、分类与披露，主分析 K 线不改。
- `--refresh` 重新请求本次分析所需的 Coinbase 区间（主周期、小时线验证、回撤下钻及开启时的全部历史背景），替换这些区间的缓存；其他区间及上市首日记录保留
- `--help`, `-h` 显示帮助

### Coinbase 行情缓存

报告开头与 JSON `scope` 声明本次数浪窗口、周期、结构起点及价格。当前未按书 §3.10/§3.12 从月线/价格 0 自上而下验证，父级身份仍为推断，即使窗口内部子浪已验证，父级首位也标为「⏳ 暂定主选（未经大级别数浪验证）」。

开启背景时，轴①「大级别背景（周线/月线）」与 JSON `background` 展示本交易所上市首日及开盘、历史最高/最低及日期、月线主要摆动，以及以前段结束于窗口结构起点 S 的级别阶梯。周线只用 S 所在周之前的数据：向前找逐级更深、尚未被窗口结构完全回撤的反向枢轴，内部最大回撤任一口径增大时才升级，同级取最深起点。下跌窗口追加上市前价格 0 级，上涨窗口镜像且不追加 0；最多展示 8 级并披露省略数。

阶梯并列前段幅度、窗口回撤比、内部最大回撤与 §3.3「可假设」结论的价差/百分比口径；百分比回撤比为 `ln(S/E) / ln(S/前段起点)`，前段幅度和内部回撤按各自起始价计算百分比。两种结论不同会注明「口径不一致，书未规定口径」。背景与主分析共用扎针检测和量能分类：背景只截取疑似乌龙针，保留有量扎针，两者逐条披露；背景处理不改窗口 K 线。背景**只作证据，不改变数法评分、主选或父级候选排序**。

可用 `node analyze-wave-tree.js --product BTC-USD --tf 1d --start 2025-10-05 --background off` 跳过全部历史请求。股票只声明数浪范围，并注明未生成大级别背景。

### 顶层读法（自价格 0，周线）

背景可用时，轴①在背景之后增加顶层读法，JSON 新增 `topLevel`。复用背景已截取疑似乌龙针的全部日线，保留并披露有量扎针，聚合周线后在首根之前加入价格 0 虚拟 K 线。数据起点为本交易所首根 K 线，并非品种诞生；之前的历史缺失，价格 0 至首根之间视为没有细节的一段。

按 §3.12 只枚举两类驱动读法：0 → 历史最高为完整推动/楔形，以及历史最高为 3 浪终点、4 浪进行中。调整浪不列入。以价格 0 为起点的那一浪，§3.16 价格运动百分比按 +∞ 计算（从 0 涨到任何正价的极限），规则「3 浪不能同时小于 1、5 浪」随之化为「3 浪不得小于 5 浪」照常判定。类别表的合规数指硬规则未被否定的读法，待定数是其中子浪角色或未完成规则仍待验证的读法，不代表完整确认。4 浪进行中的「3 浪非最短」须待 5 浪完成，因此始终待定。表中同时保留排除数与首条原因计数、P1/P2 价格和日期范围、P1 最高的代表读法、窗口所在顶层浪、修正段、父级身份映射和失效价位分档（触及 P1 即排除）。窗口早于历史最高时如实说明跨浪，不直接称为 4 浪第一段。

这里只看最大一级，尚未枚举嵌套、2/3 浪进行中及楔形 4 浪进行中变体；切分与递归沿用引擎的搜索上限，排除仅针对本次枚举的候选。顶层结果**只作证据，不改变评分、主选或父级候选排序**。`--background off`、股票或背景失败时，`topLevel` 标为不可用并注明原因，不新增行情请求。

### 扎针检测（书 §3.15）

主周期影线同时超出前后两根 K 线，且超出量及影线长度都至少为 `2×ATR(14)`，或低点低于 `min(开,收,前一根低,后一根低)` 的 50% / 高点高于对应最大参考价的 2 倍，视为候选。首尾 K 线只按价格条件检测；ATR 未成形时也可命中价格条件。

加密货币粗于 1h 的候选经缓存定位极值所在小时，以该小时量能除以前后各 24 根（不含自身）中位数。量能倍数 ≥5 为「有量扎针」，否则为「疑似乌龙针」。1h/5m 直接用主周期前后各 24 根；股票或小时线不可用时降级为主周期前后各 20 根，明确标注「仅主周期量能，置信度较低」。基准成交量不足时分类待定并保留原价。阈值均为工程设定，书没有规定量化标准，三个历史样本不足以使分类成为定论。

JSON 顶层 `spikes` 保存时间跨度、方向、原价、参考价、命中条件、量能倍数、所用周期、降级原因和截取结果。报告元信息块披露候选，轴①点名依赖扎针原极值的主选腿，并提示疑似乌龙针可用 `--ignore-thin-spikes` 对照。按 §3.15，有量扎针是「真实的一浪，常作为 X 连接段」，这里只提示，不自动改为 X 浪或改变评分。

```bash
node analyze-wave-tree.js --product BTC-USD --tf 1d --start 2017-04-01 --end 2017-05-01 --ignore-thin-spikes
```

`analyze-wave-tree.js` 自动把已收盘 K 线存到脚本所在项目的 `.cache/candles/coinbase/<PRODUCT>/<granularity>.json`，与运行命令的当前目录无关。主周期、跨周期验证和回撤下钻共用缓存；股票数据源及旧 `analyze-wave-manual.js` CLI 保持原行为。

缓存记录成功取数的覆盖段，只补拉未覆盖区间；段内缺失的 K 线视为交易所真实断档。失败分页不新增覆盖段，成功分页仍落盘。当前未收盘 K 线可用于分析但不存入缓存，下次仍会请求。文件损坏或版本不符时会提示并重新取数。

怀疑交易所修订历史行情时，运行 `node analyze-wave-tree.js ... --refresh`。删除项目 `.cache/` 后，下次运行会从空缓存重新取数并创建缓存；此目录已被 Git 忽略。

缓存模块也提供日线上市首日发现能力：`getCandles(product, 86400, null, end)`（或 `start='all'`）向前按 300 天窗口取数到整窗为空，记录 `listingTs`；后续请求早于上市的区间会截断。对有界日线请求也可传 `{discoverListing: true}`，发现的数据会保存，但只返回请求区间。此能力假设上市后没有连续 300 天无成交的空档，否则可能把空档后的首根误判为上市首日；小时线不做此发现。CLI 的默认开始时间仍为 `end - 30d`。

### 常用示例

分析美股 / A 股：

```bash
node analyze-wave-tree.js --product AAPL --tf 1d --start 2022-01-01 --apikey YOUR_KEY
node analyze-wave-tree.js --product 600519 --tf 1d --start 2021-01-01
node analyze-wave-tree.js --product MU --tf 1d --start 2026-06-23 --apikey  013a950defb3431681f03ebbc1abe2fa
node analyze-wave-tree.js --product BTC-USD --tf 1d --start 2025-10-05T00:00:00+08:00 --end now
```

快速看一眼，不做小时线验证、不拉全部历史：

```bash
node analyze-wave-tree.js --product BTC-USD --tf 1d --start 2025-10-05 --verify-tf off --background off
```

给引擎评判自己的数法（例如作者的 W-X-Y 双锯齿读法）：

```bash
node analyze-wave-tree.js --product BTC-USD --tf 1d --start 2025-10-05T00:00:00+08:00 --end now --count "126296,80524.65,97963.62,57717.55"
```

报告提示"此数法依赖该扎针"时，加上 --ignore-thin-spikes 再跑一次做对照：

```bash
node analyze-wave-tree.js --product BTC-USD --tf 1d --start 2017-04-01 --end 2017-05-01 --ignore-thin-spikes
```

指定输出文件名：

```bash
node analyze-wave-tree.js --product BTC-USD --tf 1d --start 2025-10-05T00:00:00+08:00 --end now --out btc.json --report btc_tree.md
```

## 数据来源

Coinbase Exchange Candles API：

`https://api.exchange.coinbase.com/products/<product>/candles`

## Twelve Data 版用法

`analyze-xauusd-twelvedata.js` 用 Twelve Data API 拉取外汇、贵金属、加密货币数据，然后复用同一套波浪分析引擎输出：

- JSON 数据文件
- Markdown 分析报告
- HTML 交互报告

推荐先设置 API Key：

```bash
$env:TWELVE_DATA_API_KEY="your_key"
```

也可以直接通过参数传入：

```bash
node analyze-xauusd-twelvedata.js --apikey your_key
```

### 快速开始

默认分析 `XAU/USD` 的 `1h` 周期：

```bash
node analyze-xauusd-twelvedata.js
```

也支持把品种和周期作为位置参数直接写：

```bash
node analyze-xauusd-twelvedata.js xau 4h
node analyze-xauusd-twelvedata.js xag 1d
node analyze-xauusd-twelvedata.js eur 1h
```

### 命令格式

```bash
node analyze-xauusd-twelvedata.js [symbol] [interval] [options]
```

### 支持的品种写法

- 简写：`xau` / `gold` -> `XAU/USD`
- 简写：`xag` / `silver` -> `XAG/USD`
- 简写：`eur` / `eurusd` -> `EUR/USD`
- 简写：`gbp` / `gbpusd` -> `GBP/USD`
- 简写：`jpy` / `usdjpy` -> `USD/JPY`
- 简写：`btc` / `btcusd` -> `BTC/USD`
- 简写：`eth` / `ethusd` -> `ETH/USD`
- 完整写法：`--symbol XAU/USD`

### 主要参数

- `--symbol` 交易品种，默认 `XAU/USD`
- `--interval`, `--tf` 周期，支持 `1min | 5min | 15min | 30min | 45min | 1h | 2h | 4h | 1d | 1w | 1m`
- `--apikey`, `--api-key`, `--key` Twelve Data API Key
- `--start` 开始时间，支持 `YYYY-MM-DD`、ISO 时间、`now`
- `--end` 结束时间，格式同 `--start`
- `--outputsize`, `--size` 拉取点数，范围 `1-5000`
- `--out` 输出 JSON 文件名
- `--report` 输出 Markdown 文件名
- `--html` 输出 HTML 文件名
- `--mode` 报告模式：`start`、`full` 或 `macro`
- `--lookback` 枢轴识别窗口，默认 `2`
- `--atr-period` ATR 周期，默认 `14`
- `--atr-multiplier` ATR 过滤倍数，默认 `1.5`
- `--rsi-period` RSI 周期，默认 `14`

### 常用示例

指定黄金 1 小时，从某天开始拉取到现在：

```bash
node analyze-xauusd-twelvedata.js xau 1h --start 2026-02-01 --end now
```

使用完整品种名：

```bash
node analyze-xauusd-twelvedata.js --symbol XAU/USD --interval 4h --start 2026-01-01 --end now
```

输出大周期报告：

```bash
node analyze-xauusd-twelvedata.js xau 1d --mode macro
```

只输出从开始时间出发的大周期可能性：

```bash
node analyze-xauusd-twelvedata.js xau 4h --start 2026-03-01 --end now
```

输出旧版完整报告：

```bash
node analyze-xauusd-twelvedata.js xau 4h --mode full
```

指定输出文件名：

```bash
node analyze-xauusd-twelvedata.js xau 4h --report xau_4h.md --out xau_4h.json --html xau_4h.html
```

默认会生成 3 个文件：

- `<symbol>_<interval>_<start>_<end>.json`
- `<symbol>_<interval>_<start>_<end>.md`
- `<symbol>_<interval>_<start>_<end>.html`

其中 `symbol` 会自动去掉 `/`，例如 `XAU/USD` 会变成 `XAUUSD`。

### 子浪验证证据

日线的 K 线周期不等于波浪级别。主计数和 `--count` 指定数法共用角色验证器；母级高低价固定，先在端点整根 K 线内定位实际小时极值，再按固定窗口验证。不同角色复用小时行情及验证缓存，下级结构保存自己的周期和索引。

JSON 的 `verificationStatus` 和各腿 `evidence` 区分 `verified`（声明范围内的结构验证）、`pending`（证据不足）和 `invalid`（明确规则失败）。缺失行情、端点无法唯一定位、递归或搜索上限不会证明角色，也不会抹掉本周期已拆出的角色违规——日线违规只有在较小周期给出 verified 结构时才撤销。`--verify-tf 1h`（加密货币默认）或 `4h` 声明最细验证分辨率：必要的直接子角色必须有实际识别出的结构；这些最细结构以下的细分按书 §3.23 的酌情忽略原则使用工程豁免，写入 `verificationScope` 和 `resolutionBoundary`，仍保持未证叶子。通过本层价格规则或到达递归上限均不触发这个出口。`--verify-tf off` 关闭下探，不启用分辨率豁免。Markdown 显示检查周期、未决原因和暂定主选。默认证据模式先比较硬约束，再比较未证实角色占比；同步 API 保留原有拟合评分口径，并新增证据状态，调用者可传 `evidenceMode: true` 启用证据评分。

收缩楔形检查浪幅缩短及 1–3/2–4 边界收敛；书 §4.6 允许的扩散终结楔形另列候选，因已提供书籍缺少详细专章，保持待验证，不套用收缩阈值。主选只是候选排名；子浪待验证时不代表完整数法已确认。父级若为 W–X–Y，X 的目标参考整个 W，后续为 Y；父级若为 A–B–C，B 使用整段 A，后续为 C。

可用以下命令复核指定 W：

```powershell
node analyze-wave-tree.js --product BTC-USD --tf 1d --start 2025-10-05T00:00:00+08:00 --end now --count "126296,103516.75,116410.06,80524.65"
```

P1 书籍校正后，严格不等号、OHLC 完整路径、三角形角色/几何、衰竭与父子约束参与验证。Y＞90%W 按用户勘误 OV-001 保持软指引。`provenRoles/requiredRoles` 只统计直接角色；跨周期验证采用的小时树直接进入输出，保留独立索引。组合 Y/Z 的 `degree` 按本书逐级降低，`recursionDepth` 单独记录遍历深度。

`completionStatus` 独立区分 `forming`、`potentially_complete`、`confirmed_complete`、`invalidated`。非 provisional 的末点只能给出潜在完成；确认完成还需单独的观察证据。本书未提供通用机器确认公式，因此本次不会自动把斐波目标、暂时高低点或通道提示升级为确认。当前情景模板标 `scenarioOnly`；局部 ABC/12345/WXY 标签由所选局部结构决定，不随父级名称改写。

共享转折K线的另一端极值先后不明时，相关路径/比例条件记录为 `pendingRules`，实际采用的较小周期路径可继续复核；明确出现在后续K线的违规仍判失败。P1修复范围、逐项书籍引用、证据策略与离线验证记录见 [P1验收报告](reports/wave-book-audit/p1-validation.md)。
