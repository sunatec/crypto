# Tasks

## 1. 基线

- [x] 1.1 运行 `node --test tests/*.test.js` 记录当前通过数；用 `time` 跑一次默认命令 `node analyze-wave-tree.js --product BTC-USD --tf 1d --start 2025-10-05T00:00:00+08:00 --end now`（输出到 /tmp），记录耗时、主选，以及 `--count "57717.55,66923.95,62209.81,82283,74887.5,87397"` 的推动浪违规数，作为对照写入 tasks 备注

## 2. 周期链与逐级截止

- [x] 2.1 在 `wave-subwave-verification.js` 的 `evaluate()` 中把 `lowerFrames` 改为周期链（固定顺序 4h、1h，取比 sourceTf 细且不细于 finestTf 的部分）；新增单测覆盖 1d/1h、1d/4h、4h/1h、1w/1h、1h/1h 五种组合的 `attempts` 顺序，并验证测试通过
- [x] 2.2 每档 `decompose` 传 `finestResolution: tf`；该档 verified 即截止，理由写明截止档；非最细档 invalid 继续下一档，最细档 invalid 才整体 invalid。新增注入行情单测：4h 可拆出时 `attempts` 为 `['4h']`、状态 verified、`verificationScope.finestTimeframe` 为 4h；4h 不可拆时 `attempts` 为 `['4h','1h']`；1h 搜索受限时为 pending，并验证测试通过
- [x] 2.3 `adoptedNode` 取截止档拆解，无截止时取最后尝试档；单测断言 `evaluateLegRole` 在 4h 截止时采用节点的 `timeframe` 为 4h 且 `violates` 为 false，并验证测试通过
- [x] 2.4 改写 `tests/wave-subwave-verification.test.js` 中断言「最细为 1h 时只验 1h」（`attempts` 为 `['1h']`）及「跨断档仍进入 1h」等受影响用例，使其符合新链；`node --test tests/wave-subwave-verification.test.js` 全过

## 3. 父级验证范围与报告

- [x] 3.1 `analyze-wave-tree.js` 中父候选汇总 bounded 范围时，`finestTimeframe` 取子范围中最粗的一档；单测构造一腿截至 4h、一腿截至 1h 的候选，断言父级为 4h，报告行为「验证范围截至4小时线」，并验证测试通过
- [x] 3.2 更新 README `--verify-tf` 说明（逐级链、截止规则、4h 由小时行情聚合），按文档中的命令跑一次确认可执行

## 4. 集成验证

- [x] 4.1 运行 `node --test tests/*.test.js`；对 golden/回归测试中的每个失败逐条核对，确认是逐级截止带来的预期变化后再更新期望值，并在 tasks 备注里列出变更原因
- [x] 4.2 用 `time` 重跑 1.1 的默认命令和 `--count` 命令：耗时不超过基线 1.5 倍且不 OOM；记录新主选、浪 1 证据的 `attempts` 和状态，以及推动浪违规数，与基线对比写入备注

## 备注

### 基线（改动前，HEAD 4a0fc58，2026-10-08 运行）
- `node --test tests/*.test.js`：341 项，341 通过，0 失败。
- 默认命令（BTC-USD 1d，2025-10-05 起至 now）：耗时 real 113.59s；主选为「单锯齿 Zigzag 5-3-5（下跌）」，大局研判为 W 浪，验证范围截至 1 小时线。
- `--count "57717.55,66923.95,62209.81,82283,74887.5,87397"`：耗时 real 约 113s；`impulse-strict` 推动浪违规 1 条，来自浪 1（`1d` 拆不出合法结构，`attempts` 为 `['1h']`，状态 pending，故违规保留）。
- 注：设计文档写的基线耗时约 170s，本机实测为 113.6s，4.2 的 1.5 倍上限以实测值 113.6s 为准（约 170s）。

### 实施后（2026-10-08）
- `node --test tests/*.test.js`：346 项全过（基线 341 + 新增 5）。golden/回归测试无失败，无需改期望值；被改写的是 `tests/wave-subwave-verification.test.js` 中 4 个断言「只验 1h」（`attempts` 为 `['1h']` / 长度 1）的用例，原因均是逐级链后 `attempts` 变为 `['4h','1h']`。新增用例经 `git stash` 还原旧实现验证会失败。
- 3.2：README `--verify-tf` 说明已更新；文档命令实测可执行：`--verify-tf off --background off`（约 2.6s）、`--verify-tf 4h --background off`（约 45s，报告写「验证范围截至4小时线」）。
- 4.2 耗时：默认命令 real 132.61s、`--count` 命令 real 133.02s，基线 113.59s / 约 113s，约 1.17 倍（上限 1.5 倍），未 OOM。
- 4.2 结果对比：
  - 默认命令主选不变（单锯齿 Zigzag 5-3-5，下跌；大局 W 浪），验证范围由「截至1小时线」变为「截至4小时线」（该主选各腿有在 4h 截止者，父级取最粗档）。
  - `--count` 指定数法：推动浪违规数仍为 1（基线 1），**动机用例未被本变更解决**。浪 1（57717.55→66923.95）`attempts` 由 `['1h']` 变为 `['4h','1h']`，状态仍为 pending（报告里本周期违规保留为 invalid）。原因：4h 有 38 个枢轴、1h 有 180 个枢轴，均超过 8 个，搜索受限，无法在任一档给出 verified；4h 上最佳读法还有「4 浪切入 1 浪」的路径违规。浪 2 由 1h 验证变为在 4h 截止（verified）。
  - 要让该数法过关，需要放宽搜索覆盖（beamK / 枢轴数上限 / 先过滤小枢轴），属于 design.md 非目标「不调整 beamK 等搜索参数」，另开变更。
