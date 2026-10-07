## 0. 前置

- [x] 0.1 查证"XX 已回撤 Y 浪 173%"：核对 BTC 报告细枢轴序列与 `splitPullbackAtLow` 的 `bounceExtreme` 取法（反弹极值≈87250 几近高点 87397，而主级别边缘为 84425.07）；若取法有误先修并补单测，结论记入 design 决策 1。
- [x] 0.2 归档 `narrate-current-pullback`，建立 `current-pullback-narrative` 主规格（本变更的 MODIFIED/RENAMED 依赖它）。

## 1. 锚点

- [x] 1.1 `maxInternalRetrace` 保留峰/谷枢轴，返回 `fromTs/toTs`，`from/to` 价格字段不变。
- [x] 1.2 `classifyPullbackDegree` 返回 `extreme`、`rallyStart`（价+时间戳）与 `upgradeLine`（按方向加减）。
- [x] 1.3 `enrichCurrentPullback` 记录 `structureLow {price, timestamp, tf}`。
- [x] 1.4 日期格式工具：日线及以上 `YYYY-MM-DD`，下钻子级别 `YYYY-MM-DD HH:mm UTC`。
- [x] 1.5 第一句改写：高点/结构低点/前段上涨/内部最大回撤均带价与日期，附本次占内部最大回撤比例；`exceeds===true` 时注明已跌破升级线。

## 2. 升级线

- [x] 2.1 `exceeds===false` 时在"续涨条件"后单列"级别升级线"一行；`exceeds===null` 不出现；措辞不含预警语。

## 3. Z 浪冲突（方案 B）

- [x] 3.1 `zwaveProjection` 接收 `upgradeLine`，各档标 `belowUpgradeLine`；正文对低于升级线的档加注。
- [x] 3.2 结局分叉：升级线上方 → 转向上涨；跌破 → `afterUpgrade`（按 `bounceHyp.lean` 生成 xx/b/three 文案，附"子浪级数法仅作参考"）；`exceeds===true` 直接用跌破分支。
- [x] 3.3 同源校验（`bounceHyp.term`=前段上涨起点价、`bounceHyp.anchor`=高点价），不同源或无主选时用通用写法；JSON 记 `afterUpgrade.basis`。
- [x] 3.4 `renderPullbackNarrative(nr, pricePrecision, bounceHyp)`：计算期与报告渲染处均传入 `tree.assessment.bounceHyp`。

## 4. 测试与验收

- [x] 4.1 `tests/narrate-current-pullback.test.js`：锚点与日期（含子级别时分）、升级线三种 exceeds 情形、下跌方向升级线公式、Z 档 `belowUpgradeLine`、xx/b/three 三种跌破结局、不同源回退、无升级线时原结论、无预警措辞。
- [x] 4.2 更新受影响 golden；全量测试通过。
- [x] 4.3 实网验收 BTC：第一句含 87397（2026-09-21）/82510.37/57717.55/82283/74887.5 及日期；升级线 80001.5 单列；79770.74 注"低于升级线"；跌破分支引用 X 连接浪 → Y 浪下跌。
- [x] 4.4 README 相关段落更新；`openspec validate pullback-narrative-anchors` 通过。

验收记录（2026-10-07）：全量 node --test tests/*.test.js 为 341/341 通过；Coinbase 日线实网刷新后，以原窗口（2025-10-04T16:00:00Z 至 2026-10-05T14:56:25.702Z）、--verify-tf 1h --background off 完整 CLI 验收通过。原报告高点时间戳核实为 UTC 2026-09-21，已更正示例日期。报告/JSON/回执位于 .cache/acceptance/pullback-narrative-anchors/。
