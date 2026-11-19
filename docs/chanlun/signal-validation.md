# 信号阶段验证（变更 add-chanlun-divergence-signals）

本页随各任务组增补。规则文字见 [rules.md](rules.md#md／b：macd-面积背驰与买卖点)，来源见 [sources.md](sources.md)。

## 第 3 组：MACD 前缀和与段面积（任务 3.1、3.2）

**状态（2026-11-12）**：同核验证脚本已在 TradingView（BTCUSDT 1 小时，25112 根）PASS，任务 3.1、3.2 已勾选。该结果由助手在 Claude 应用内置浏览器中、用用户自己的 TradingView 账号读取，不是用户回传；证据见 `tmp/chanlun/macd-platform-results.json` 与 `tmp/chanlun/macd-btcusdt-60-pass.jpg`（截图里开头的 `PASS: MACD,` 被指标标题盖住，PASS 由绿色文字判断）。**`chanlun_original.pine` 本身尚未在平台加载**：SIGNALS 区段随验证脚本编译通过，但新增的输入、`chan_macd_push` 调用和研究视图状态行还没在正式指标里验证。

### 代码位置

- `chanlun_original.pine` 新增 `// BEGIN CHANLUN SIGNALS` … `// END CHANLUN SIGNALS` 区段（CORE 之后、RENDERER 之前）。CORE 的 SHA-256 与本变更前一致：`7bea4f3a789c862e6beaa3ea2f21e60843f21b52c13cc4e7f9a7db61ba5479d0`。
- 区段内容：`ChanMacd`（EMA 状态与五个前缀数组）、`chan_macd_peek`（预览，不改状态）、`chan_macd_push`（只收更晚的已收盘 K 线）、`chan_macd_area`（二分查找 + 前缀差）。没有用 `bar_index` 偏移。
- 正式入口：输入组“MACD（信号阶段）”（12／26／9），与分析窗口同一道门，只在 `barstate.isconfirmed` 追加；目前只在研究视图的状态栏显示“MACD前缀 已存/容量”，尚无任何信号读取它。

### 预算

| 项 | 上限 |
| --- | --- |
| 每个数组 | 容量 ≤ 100,000（固定起点取样本上限，最大 100,000；默认窗口 2×初始根数，最大 10,000） |
| 数组个数 | 5（time、cumPos、cumNeg、dif、dea） |
| 回收 | 满后每进一根丢最旧一根；被丢弃的区间面积不可用 |

### 验证

```bash
node tools/chanlun/build-macd-validation.mjs
node --test tools/chanlun/macd-validation.test.mjs
```

生成 `tmp/chanlun/macd-validation.pine` 及清单。在 TradingView 新建指标粘贴该脚本，加载到至少 150 根已收盘 K 线的图表，预期右上显示 `PASS: MACD, …`。内容：

1. 手算用例（`tests/fixtures/chanlun/macd/cases.json`）：EMA 递推（按平台 `ta.ema`：前 length−1 个为 na、第 length 个取简单平均作种子）、重复／更早时间被拒、预览不改状态；带符号面积、预热、仅预热、回收四组共 22 个查询。
2. 19 个独立信号样例的全部 A／C 段（26 个不同区间）：在终点所在 K 线收盘时和全部写入后各查一次，结果必须一致，且与样例记录的 `areaUnits`（含 null＝不可用）一致。
3. 实盘部分：12/26/9 与 5/35/5 两套参数逐根对照内置 `ta.macd`（dif、dea、hist 容差 1e-9，且 na 的位置必须相同）；120 个确定性随机区间（五分之四落在保留窗口内、含落在两根 K 线之间的端点，五分之一伸向已回收的历史）与对内置柱值的朴素累加比较，要求至少 60 个可用、5 个不可用，并核对回收计数。

本地测试用一份逐行对应的 JS 模型（只用来提前发现逻辑错误，不代替平台）核对了 1、2，并与随机数据的朴素扫描对照；`node --test tools/chanlun/*.test.mjs` 共 115 项通过。

### 平台结果与过程

- 第一次运行 FAIL（`LIVE/builtin-na bar=0`）：我最初让 EMA 首值取源值，而 `ta.macd` 在第 slow−1 根之前是 na。探针实测 macd 自第 25 根、signal 与 hist 自第 33 根有值，据此改为 SMA 种子起算。
- 第二次 PASS 但探测全部落在已回收区域（0 可用 / 120 不可用），面积数值没有真正比对；改为大部分探测落在保留窗口内并要求至少 60 个可用后，结果为 `25112 bars vs ta.macd, 120 probes (96 available / 24 unavailable), recycled 24077, worst gap 0.0000000001019`。
- 平台上粘贴的是生成文件去掉注释和空行的版本（421 行、字符和与本地一致），代码与生成文件相同。

证据登记到 [validation.md](validation.md) 的验收矩阵留待第 3 组确认后一并处理。

## 第 4 组：背驰判定（任务 4.1、4.2）

**状态（2026-11-12）**：同核验证脚本 `tmp/chanlun/divergence-validation.pine` 在 TradingView 一次 PASS：19 个样例、154 个前缀、7 个信号 / 22 条未成立记录逐前缀一致。读取方式同第 3 组（助手在内置浏览器里、用用户自己的账号），证据见 `tmp/chanlun/divergence-platform-results.json` 与 `tmp/chanlun/divergence-btcusdt-60-pass.jpg`。**`chanlun_original.pine` 本身仍未在平台加载**（新增的信号运行时变量、逐部件调用、研究视图状态行未经平台编译）。

### 4.1 只读接入

- 形态 CORE **逐字节不变**（SHA-256 仍为 `7bea4f3a…`），所以此前登记的 K/F/P/S、N、Z、T4、W8、G3、B5、D4 等共享内核平台 PASS 的 CORE 部分仍然对应同一份源码；这次**没有**重跑那些脚本，本地 `tools/chanlun/*.test.mjs` 121 项通过。
- 新区段 `// BEGIN CHANLUN DIVERGENCE`（在 SIGNALS 之后、RENDERER 之前）。它在自己的镜像栈上调用 CORE 的 `chan_stack_step`（与引擎用的是同一个函数），逐部件读取 Z／R 状态，不向任何 CORE 状态赋值；测试检查了这一点。
- 同批顺序：L0 → Z1 → R1 → D1 → Z2 → R2 → D2 → Z3 → R3 → D3，由 `chan_signal_part` 一个函数定义。
- 正式入口：每个确认部件之后、MACD 已追加当根柱之后调用 `chan_signal_part`；研究视图状态栏显示 D1/D2/D3 信号数。目前只有趋势背驰（第一类点）与盘整背驰点两种类型，第二、三类点在第 5 组。
- 代价：镜像栈让中枢／走势状态多保存一份（有界，与引擎同预算）。

### 4.2 判定

- 触发：某层某个部件成为本层中枢的待定离开部件（E-010 的 `pendingLeave`）时判一次。中枢集取 R 已跟踪的中枢，加上尚未被 R 跟踪的活动中枢。
- 趋势背驰（D-002）：中枢集至少 2 个，前一中枢同向关闭且新旧中枢严格分离，C 与走势同向；A 取前一中枢离开部件到新中枢首个形成部件之前的部件链。
- 盘整背驰（D-003）：中枢集恰为 1 个；进入段是首个形成部件之前的那个部件，在中枢形成时记下。
- 硬条件按固定顺序判：C 终点严格越过 A 的范围极值 → 两段面积都可用 → C 面积严格小于 A；不成立时记录原因（`not-new-extreme`、`area-unavailable`、`area-not-smaller`），无进入段记 `no-entry-segment`，方向相反记 `no-same-direction-entry`。每个中枢至多一个背驰类信号。
- 样例范围：只比对 `first` 与 `consolidation-divergence-point` 两类；样例里的第二、三类点要到第 5 组才有实现。

## 第 5 组：买卖点与预览（任务 5.1、5.2）

**状态（2026-11-13）**：任务 5.1 已勾选：同核验证脚本在 TradingView（BTCUSDT 1 小时）PASS，19 个样例、154 个前缀、25 个信号 / 28 条未成立记录逐前缀一致，含预览、重复、重载、预览部件转换检查。读取方式同前（用户把脚本粘进 Pine 编辑器，助手点击更新并读图），证据见 `tmp/chanlun/divergence-platform-results.json` 与 `tmp/chanlun/divergence-btcusdt-60-pass.jpg`（开头的 `PASS: D5,` 被指标标题盖住，由绿色文字和其余各行判断）。**任务 5.2 未勾选**：`chanlun_original.pine` 本身仍未在平台加载，BTC 1 分钟实盘观测未做。本地 `tools/chanlun/*.test.mjs` 共 121 项通过。

首次粘贴平台报编译错误 `Could not find function … 'chan_normalization_new'`：生成器算 CORE 依赖时没把验证代码自身算进去。已修生成器并加测试（脚本里用到的每个 `chan_*` 函数和 `Chan*` 类型都必须在脚本中定义），重新生成后一次通过。

### 5.1 第二、三类买卖点

- 第三类（B-003）：取 Z 关闭事件，回抽部件完全在核心上方为买点、下方为卖点，价格为回抽部件终点，依赖为中枢、离开部件、回抽部件。回抽部件的低点（高点）恰等于核心边界时记一条 `touch-edge` 未成立记录，不出信号。
- 第二类（B-002）：第一类提交后，取其后第二个同向部件 r2，终点价不越过第一类价格（相等不算越过）才出信号，依赖为第一类信号 ID、r1、r2；越过则记 `breaks-first-class-price`，此后不再找。
- 同批顺序（B-005）：同一部件上先第一类／盘整背驰点，再第二类，最后第三类；`sig-second-third-coincide` 检查了第二类在第三类之前。
- 同核验证脚本改为比对全部四类信号：19 个样例、154 个前缀、25 个信号、28 条未成立记录（原因含 `breaks-first-class-price`、`touch-edge`）。

### 5.2 预览与重载一致性

- `chan_signal_candidates` 与 `chan_macd_preview` 是纯函数：在副本上走一遍判定，已提交的信号运行时和 MACD 序列只读。`chan_signal_preview_parts` 把开盘 K 线上的假设线段在标准化状态的副本上转成部件，假设线段本身也先复制。
- 样例驱动对每个前缀检查：预览结果等于之后确认的结果；预览后引擎的输入计数、信号数不变（隔离）；同一部件再次收盘不产生第二次提交（重复）；整段重放得到与逐前缀在线完全相同的信号与记录（重载）；另用两个合成假设线段检查转换函数。
- 正式入口：输入项“研究：显示候选信号（实时预览，未收盘K线）”，**默认关闭**，打开后在最后一根未收盘 K 线上画空心候选标记，收盘不成立即消失。实盘路径（假设线段取自引擎预览）只在打开该项时执行，目前未经平台运行。
- **还缺的实盘观测**（5.2 的验收条件）：BTC 1 分钟图上实时看到候选出现与消失、收盘只提交一次；固定起点重载与在线结果逐字段一致。

### 需要在平台做的两件事

1. 运行 `tmp/chanlun/divergence-validation.pine`（用 `node tools/chanlun/build-divergence-validation.mjs` 生成）。预期右上显示 `PASS: D5, 19 fixtures, …`，出错会显示 `FAIL: <样例>/prefix-N/…`。
2. 加载 `chanlun_original.pine`（整份，约 2800 行），确认编译通过、右上面板正常；研究视图的状态栏应有“MACD前缀”和“背驰信号 D1/D2/D3”两行。再在 BTC 1 分钟图上打开候选信号开关观察。

## 第 6 组：显示与提醒（任务 6.1～6.3）

**状态（2026-11-13）**：代码、本地检查和文档完成；**正式指标已在平台编译并出图，实图已归档，标记数与信号数核对一致；任务 6.1、6.3 已勾选；提醒的实时验证未做，6.2 未勾选**。本地 `tools/chanlun/*.test.mjs` 共 132 项通过（新增 `signal-display.test.mjs` 11 项）。

平台读取方式同前：用户把脚本粘进 Pine 编辑器，助手点击更新并读图。过程记录：

- 首次编译报错 `"text" cannot be used as a variable or function name (CE10150)`：研究视图面积对比里的局部变量 `text` 与内置命名空间冲突。改名为 `compareText`，并新增测试禁止显示块里出现与 Pine 内置命名空间同名的变量或参数。另有 `low`、`high` 被遮蔽的两条警告，早已存在，与本组无关。
- 修正后 2966 行整份文件编译通过，无运行时错误，新增的“买卖点（信号阶段）”“提醒（信号阶段）”设置和研究视图选项都在。
- BTCUSDT 1 小时图（`BINANCE:BTCUSDT`，默认窗口 4999 根，起点 2026-04-18 20:00 UTC），研究视图状态栏 `背驰信号 D1/D2/D3：10/0/0`、`MACD前缀 4964/10000`，面板结构计数与第 5 组一致（分型 1793、笔 388、线段 63）。
- **普通视图**（[signals-normal-btcusdt-60.jpg](../../tmp/chanlun/signals-normal-btcusdt-60.jpg)）：在 3 个月范围内看到两个实心标记——绿色“L1 盘背买”（价格下方向上指）和一个红色的“三卖”标记（价格上方向下指）；它被相邻的 P#372 笔编号压住了一部分，我只能确认“三卖”二字，层级数字在截图里看不清，所以这里不写层级——这也是标签密度的一个实例：端点附近结构编号与买卖点标记会重叠。结构编号 P#／S# 仍是无底色的彩色文字，两类标记一眼可分。普通视图不画比较线。
- **研究视图**（[signals-research-btcusdt-60.jpg](../../tmp/chanlun/signals-research-btcusdt-60.jpg)、[放大图](../../tmp/chanlun/signals-research-btcusdt-60-zoom.png)）：同一个“L1 盘背买”多出一条虚线，连接 A 段与 C 段端点极值，并标出“…C面积 2605.11”。
- **候选**：1 分钟图上开着候选开关，约 14 分钟没有候选出现（见 validation.md），所以空心候选的实图没有拍到。

**逐个核对（2026-11-13 补做）**：研究状态栏新增 `买卖点标记 买x / 卖y`，直接数绘图注册表里 `D-signal-buy`／`D-signal-sell` 的标签数。重新粘贴 2967 行版本、同一数据（BTCUSDT 1 小时，起点 2026-04-18 22:00 UTC，4999 根）读到 `背驰信号 D1/D2/D3：10/0/0` 与 `买卖点标记 买5 / 卖5`（[截图](../../tmp/chanlun/signals-marks-count-btcusdt-60.jpg)、[读数放大](../../tmp/chanlun/signals-marks-count-zoom.png)）。5＋5＝10，等于 D1 信号数，所以每个确认信号在注册表里恰有一个标记，没有多也没有少。同一时刻标签总数 `标签 120` 已满（全局上限），这 10 个买卖点标记仍全部留着，说明标签预算吃紧时买卖点标记确实被保护。这是注册表层面的核对；屏幕上我另外在 1 小时图上翻看并确认了其中 5 个（9 月 8 日左右盘背卖、9 月 24 日左右三买、10 月 16 日三卖、10 月 30 日左右盘背买、11 月 2 日左右三卖），其余 5 个在更早的历史里，没有逐个在屏幕上找到，原因是 TradingView 往前翻需要边翻边加载历史，我的截图经常落后一步，状态栏面板又盖住图的右上部分。操作中还试了“All”“6M”范围按钮，它们会同时改变图表周期，导致指标换周期重算，已切回 1 小时，数据没有影响。

### 6.1 标记、研究视图与设置

- CORE、SIGNALS、DIVERGENCE 三个区段与 D5 平台 PASS 时的版本**逐字节相同**（测试里钉死哈希），所以 D5 的结论仍对应这份源码。本组只改了 RENDERER 区段与图表调度部分。
- 买卖点标记走统一绘图注册表：类别 `D-signal-buy`／`D-signal-sell` 是实心带箭头标签（文字“层级＋类型＋买／卖”），候选 `D-candidate-buy`／`-sell` 是空心；结构编号仍是无底色的彩色文字。全局标签预算收紧时，买卖点标记最后才被淘汰。
- 设置分组：“买卖点（信号阶段）”（总开关、显示、L1／L2／L3、四种类型、买卖点颜色）与“提醒（信号阶段）”；研究视图新增“显示面积对比与比较段”“显示未成立原因”。默认值：计算与显示开启，未成立原因、候选、提醒关闭。
- 研究视图的面积对比：每个背驰类信号画 A、C 两段端点极值的连线，中点标“A面积／C面积”。未成立原因按原因文字标在对应位置，不触发提醒。
- **没有实现的**：规则 D-004 的其余研究标签（B 段黄白线回拉零轴、C 段黄白线极值是否超过 A、C 终点是否越过 Zk 已归属部件极值、提交后 Zk 的后续走向）；区间套只在悬浮提示里写“可用低级别区间套细化”。这些需要保存 DIF／DEA 极值与后续走向，超出本任务验证的范围，待用户决定是否另做。

### 6.2 提醒

- 用 `alert(..., alert.freq_all)`，每个信号一条；只在“已确认帧里、实时行情、层级与类型两个开关都开着”时调用。候选、未成立记录、历史 K 线都不调用。同一根 K 线确认多个信号时，各自过滤后每个发一条。
- 本地只能静态检查（`signal-display.test.mjs`：全文只有一个 `alert(`，位置、守卫和消息字段）。**一条提醒在实时行情下是否与确认信号一一对应，只能在 TradingView 里实时观察**，尚未做。

### 6.3 文档

- [user-guide.md](user-guide.md#买卖点与背驰信号信号阶段) 新增“买卖点与背驰信号”一节：标记含义、设置、研究视图、提醒创建步骤、未实现项；[reference-comparison.md](reference-comparison.md#买卖点功能对照) 新增对照表。文中规则 ID（M-001～M-003、D-001～D-004、B-001～B-005、E-010）与 [rules.md](rules.md) 逐一核对过存在。

### 还需要在平台做的事

1. 建一条“任何 alert() 函数调用”的提醒，在实时行情里观察到信号确认时的条数与信号一一对应，截图与消息文字归档。这一步只能等行情出现确认信号。
