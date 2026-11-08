# Tasks

## 1. 基线与 Y/Z 修正

- [x] 1.1 用 `NODE_USE_ENV_PROXY=1 node analyze-wave-tree.js --product BTC-USD --tf 1h --start 2026-10-31T00:00:00+08:00 --end 2026-11-04T17:39:50+08:00`（固定 end，可复现）生成基线 md/json 存 scratchpad；1d 同样生成一份；`node --test tests/*.test.js` 基线为 491 通过
- [x] 1.2 在 `bounceHypotheses` 的 `ref: 'whole'` 分支设 `aftermath = 'Y 浪…'`；简报续行浪名改读 `aftermath`；新增断言“越过末腿起点 → Y、未越过 → Z”（`tests/wave-book-ch3.test.js`）。注：golden 测试里手工设置的 `aftermath = 'Y 浪下跌'` 模拟的是父级联合形路径（`analyze-wave-tree.js:2355` 本就改为 Y），与本 bug 无关，予以保留

## 2. 价位梯子（轴③）

- [x] 2.1 实现 `collectPriceLevels`（收集、降序、0.03% 合并、以现价分上下），为 BTC 样例数字写单测（`tests/slim-wave-tree-report.test.js`）：78878.01 一档含“X 上限 / 窗口最高”、现价档写“反弹已回撤整段 W 的 87%”、同一价位只一行、77236.65 不被 77307.2 吞并
- [x] 2.2 实现 `renderPriceLadder`，替换轴③ 的“反弹目标”“通道参考”“回撤目标位”“近端看”（近端改为一句只引数字的触发线）；`renderPullbackTargets` 增 `compact` 只留条件段落；时间窗和“走完之后”各输出一次；断言 md 中回撤梯度只在梯子出现一次
- [x] 2.3 轴① 的“当前在哪”不再打印带倍数的回撤梯度（改“回撤位见轴③”）；更新 golden / regressions 中依赖旧版式的断言，`node --test tests/*.test.js` 通过

## 3. 轴①、轴② 精简

- [x] 3.1 轴② 情景表过滤违规情景，表下输出“已排除：…”；md 内进行腿细化不列“约束出处”（`--verbose` 恢复）。书页列表已在 JSON `currentPullback.narrative.axis2Roles[].refs` 中，无需新增字段；`narrative.text` 保持原样。T4 回归用例改为“违规→已排除”+零违规副本校验投影文案
- [x] 3.2 轴① 备选表按“框架 + 方向 + 各腿点位”分组合并，浪型用“ / ”拼接、排名写作“备选2–5”；主选的子浪验证证据仅 `--verbose` 输出（“验证范围截至 X 线”是结论边界提示，保留）；单测断言备选表无重复“框架+腿”行

## 4. 调试信息、短周期背景与 `--verbose`

- [x] 4.1 `main()` 解析 `--verbose` 并更新 `--help`；默认不输出规则树与进行中结构代码块、框架长说明、内部模式 id（顶层读法代表读法只列点位）、“专章待补”；单测断言默认 md 不含这些字样、`--verbose` 时含规则树
- [x] 4.2 非 verbose 时（任何主周期），大级别背景与顶层读法合并为一段大白话（`renderHigherDegreePlain`），父级表下的“，顶层：”佐证与“展示 N 级前段证据”一句移到 verbose；`tests/higher-degree-background.test.js` 断言 1h/1d 默认无术语、verbose 完整，以及 `background`、`topLevel` 对象不变（实施中由“仅短周期出摘要”修订而来，见 design D2）
- [x] 4.3 免责声明只保留简报后那一条（轴② 说明与回撤条件段落的免责去掉）；单测断言全文只出现一次

## 5. 简报顺延

- [x] 5.1 简报第 4 条：反弹目标全部已到、或上阻力已被站上时，改取价位梯子中现价前方最近 1~2 档；实跑 BTC 1h 简报为“上阻力/突破：78878.01（X 上限；窗口最高）（78164 已站上…）”，单测断言顺延价在现价之上

## 6. 集成核对

- [x] 6.1 同一条命令（固定 end）重新生成：1h md 243 → 140 行（非空 98 行），约 21K → 10K 字；未达到 design 估计的 80~100 行——价位梯子本身占 17 行、进行腿细化仍有 17 行（其中“b 腿进行中”的过时内容留给 `track-live-swing-extreme`）。`_tree.json` 与基线逐字段 diff：1h 零差异；`node --test tests/*.test.js` 499 通过
- [x] 6.2 `--tf 1d --start 2025-10-05` 重新生成：676 → 245 行，大级别背景与顶层读法完整输出、价位梯子正常；JSON 仅 `meta.lastClose` 不同（当日日线未收盘、实盘数据变化，与本变更无关）
- [x] 6.3 （实施中追加）轴② 进行腿细化默认改为 `renderPullbackPlain`（“这段回调走完了吗”），轴③ 条件目标默认改为 `renderPullbackTargetsPlain`，原全文与“上表内部细化导读”移到 verbose；70% 线与跌破后目标进价位梯子；日线 md 184 → 152 行；`node --test tests/*.test.js` 509 通过
