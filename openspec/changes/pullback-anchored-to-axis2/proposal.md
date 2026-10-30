# Proposal

## Why

「当前高点回撤研判」讲的就是轴②表里那条 ⏳ 进行中的腿（BTC：87395.67 之后的 b 腿 / 浪②），但它完全不读轴②：身份取自轴③的 `bounceHyp`，浪名另起一套 a/b/c、W/X/Y/Z，与轴②的 b 腿、轴③的大级别 Z 浪重名不分级；书里浪② 与单锯齿 b 浪的不同约束（价格上限、时间、常见形态）也没有按身份分开套用。同时轴②自身的排名有缺陷：模板里"上冲段五浪→偏转势"的性格软信号被"已验证腿数"整体覆盖，两条存活情景打平后按模板顺序排，中继排第 1，与轴③主选（推动 3 浪）相反。现行规格已要求"轴②为当前反弹结构的唯一权威"，本变更把回撤研判落到这条要求上。

## What Changes

**第一步：轴②排名可信（先做）**
- 修复 `buildCurrentWaveStructures` 的软分：`soft` = 已验证腿数 + 上冲段性格契合度（原模板 `soft` 改名 `charFit` 保留），不再被已验证腿数覆盖。
- 每条情景输出 `softReasons`，说明软分来源。
- **BREAKING（结果层面）**：上冲段为五浪时，"新推动·浪②进行中（转势）"排到"X 连接浪/B·中继"之前；BTC 当前报告轴②第 1 名由中继变为转势，与轴③主选一致。

**第二步：回撤研判以轴②为准**
- **结构部分迁入轴②**，新增小节「进行腿细化（⏳ 腿内部）」：
  - **身份对照**：对轴②中 tier1=0、且 ⏳ 腿从摆动极值起步的每条情景，写明本回撤在该情景中的身份（b 腿 / 浪② / 浪③）及书中对应约束：价格上限、时间上限与常见时间窗、常见 / 排除形态、(a) 幅度测算；并给出"本回撤现状"对照（已走时间比、(a) 幅度比、内部形态是否相容）。对照结果只作证据展示，**不计入 tier1**。
  - 原「级别 / 升级线」「整段内部形态」「高一级读法」「联合形浪位」「两条 70% 线」整体搬入此节。
- **浪名分级**：⏳ 腿内部一律用低一级括号记号——(a)(b)(c)、(w)(x)(y)(xx)(z)；再往下一级（(a) 自身的内部）只写形态名 + 拐点链，不再用字母，杜绝与轴②的 b 腿、轴③大级别 Z 浪重名。原"高一级读法"改称「⏳ 腿整体读法」，并注明它就是轴②该腿本身。
- **去向取自轴②**：跌破升级线后的去向句不再读轴③ `bounceHyp`，改为逐条列出存活情景的下一腿及其投影（如 #1 转势 → 浪③；#2 中继 → c 腿）。
- **越过摆动极值以轴②为准**：叙述写明越过摆动极值后轴②改以新高为摆动极值重新研判（上冲在延伸）；书中扩散 / 顺势平台 (b) 可越过 a 起点一事降为一句备注，联合形 / 平台形上限保留为备注线位。
- **升级线仅作叙述证据**：写明"已跌破升级线 → 支持前段已走完（转势 / 中继两情景的前提）、削弱 ⑤ 情景的 ⑤ 内部回撤分支"，不改 tier1、不淘汰任何情景。
- **轴③只留目标价**：原小节改为「回撤目标位（⏳ 腿）」：a/① 的 0.382 / 0.5 / 0.618 回撤位、(z) 浪两条路目标、状态②时的平台形 (c) 目标，回撤位与 (z) 目标相距 ≤1% 的标"共振"；结尾指向轴②各情景的下一腿投影。
- **读法三（⏳ 腿已在回撤真低点走完）**：与读法一（整体未完，(a)/(w)+(b)/(x)）、读法二（三重联合形）并列，写明否定线（跌破真低点）与区分条件（下一腿五浪 vs (b)/(x) 三波）；轴③补一句其去向。跌破真低点只否定"在此走完"：同一形态的末段可继续走（**末段延伸读法**），轴③逐形态给出常见目标、指引线、规则失效价与时间上限（取自引擎规则，标共振），已跌破后仍保留。形态去重不再把双锯齿并入单锯齿，零违规的双锯齿 87395.67→79800→84898→79220.74 单独列出并给末段延伸数值。整段内部单锯齿的首段终点若不是跨度极值（失败第五浪 / 截断），价链后注明更极端价，终点不改。
- **细枢轴不漏摆动**：外包线两侧都出枢轴，相邻同型合并时不再丢掉越界的反向摆动，去掉方向颠倒段，中间枢轴归位到段内极值。
- **楔形长度递减降为指引**：书第 1~7 章只要求楔形边界收敛（§2.3），没有"3 浪短于 1 浪、5 浪短于 3 浪"的原文，该条由硬规则改为指引。BTC 87395.67→79800 因此成为合规引导楔形，单锯齿 (a) 直接止于真低点 79800，与双锯齿同链合并列出、注明差在首段内部。
- JSON：`currentPullback.narrative` 新增 `axis2Roles`、`retraceLevels`、`completedReading`、`extensionReading`，`subDegree.rankedPatterns[]` 新增 `beyondEnds`；`currentWaveStructures` 新增 `rallyStart` / `swingExtreme` 枢轴引用，`structures[]` 新增 `charFit`、`softReasons`。既有字段保留，`afterUpgrade.basis` 新增取值 `axis2`。

**不在本次范围**：回撤内部证据（三波 / 五浪、升级线）回流参与轴②排名；`上表内部细化导读`（父级口径的一句导读）的合并；T4 选点重写（属 `engine-backed-current-impulse-template`）。

## Capabilities

### New Capabilities
<!-- 无 -->

### Modified Capabilities
- `wave-count-tree`：新增「当前进行浪排名软分须含上冲段性格契合度」；修改「Markdown 报告按主题轴单一权威呈现」，明确 ⏳ 腿内部结构细化归轴②、⏳ 腿目标位归轴③，并放开本变更新增的序列化字段；修改「currentPullback 序列化扩展」，新增 `axis2Roles` / `retraceLevels`。
- `current-pullback-narrative`：修改「当前高点回撤叙述段」（位置拆为轴②结构 + 轴③目标，身份取自轴②）；新增「回撤身份取自轴②存活情景」「⏳ 腿内部低一级记号」；修改「高一级读法」（改称 ⏳ 腿整体读法、注明即轴②该腿）、「分级失效线」（越过摆动极值以轴②为准）、「Z 浪双路径投影」（走完后的去向取自轴②）。

## Impact

- 代码：`analyze-wave-tree.js`
  - `buildCurrentWaveStructures`：软分口径、`charFit` / `softReasons`、返回 `rallyStart` / `swingExtreme`。
  - `enrichCurrentPullback`：新增 `axis2Roles`、`retraceLevels` 计算（新函数 `buildAxis2Roles`）。
  - `renderPullbackNarrative` 拆为 `renderPullbackLegDetail`（轴②）与 `renderPullbackTargets`（轴③），原函数保留为两者拼接（供 `narrative.text`）；`pullbackAfterUpgrade` 改读 `axis2Roles`；`renderCurrentWaveStructures` 之后挂进行腿细化；`renderAxis3` 改挂目标小节。
- 测试：`tests/narrate-current-pullback.test.js`、`tests/pullback-higher-degree.test.js`、`tests/wave-regressions.test.js`、`tests/analyze-wave-tree.golden.test.js` 中涉及措辞、浪名与轴②排名顺序的断言需按新口径更新；新增身份对照、软分、共振标注单测。
- 报告：轴②变长（新增进行腿细化），轴③的回撤小节变短；BTC 轴②第 1 名变化，简报 / 导读中取首行的位置随之变化。
- 依赖：`engine-backed-current-impulse-template`（0/14，未开工）同改 `buildCurrentWaveStructures` 的软分与 `wave-count-tree` 规格，并计划删除 T4 的 `leg1Char` 软信号；本变更只改软分的合成方式、不动 T4 选点，两者先后实施时需按后实施者合并 `charFit` 口径。
- 书依据（`reports/wave-book-audit/book-extract`）：ch005 p0083/p0086（b ≤ a、② < ①）、p0094（时间）、p0133/p0154/p0156（② 常见单锯齿及 (a) 测算）、p0060（单锯齿 b 可为三角形）、ch007 p0200（驱动浪 ② 不可为收缩三角形）、ch002 p0134（② 可为横向）。
