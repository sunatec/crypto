# Tasks

## 1. 基线与回归夹具

- [x] 1.1 记录当前 `node --test tests/*.test.js` 的通过数；把浪 1 的 4h 窗口（57717.55→66923.95，来自 `.cache` 小时线，取 2026-07-01 07:00Z 起至 2026-07-21 14:00Z 止）固化为测试夹具文件 `tests/fixtures/` 下的 JSON，并新增测试断言「现状」：`impulse|leading` 主选为 `impulse-strict` 且带「4 浪切入 1 浪」违规。验证：`node --test tests/wave-subwave-verification.test.js` 通过。
- [x] 1.2 在同一夹具上写一个暂时用 `test.todo` 标注的目标用例：开启楔形枚举后主选为 `diagonal-leading`、违规数为 0。验证：测试文件可加载，todo 被列出但不失败。

## 2. 楔形枚举

- [x] 2.1 在 `analyze-wave-tree.js` 新增 `diagonalSegmentations(segFine, pat, direction)`：DFS 选 4 个内部枢轴，类型交替、索引递增，按普适价格条件剪枝，输出候选切分；并导出以便单测。验证：单测在 1.1 夹具上返回的切分包含已知合格读法（如 `57717.55>63940.79>61250>64669.42>63608.54>66923.95`），且每个返回切分都满足交替和起终点固定。
- [x] 2.2 在 `decompose` 的 `lite` 阶段，当 `depth===0 && opts.diagonalEnumeration` 且形态为三种楔形、内部枢轴≤60 时，把枚举结果与 `segmentations` 结果按点索引去重合并，走既有基础打分，只保留 `tier1===0`，按 `compareCandidates` + 点索引串排序，取前 12；把开关加入 `lite` 缓存键和节点缓存键。验证：在 1.1 夹具上主选变为 `diagonal-leading`、`candidateViolations` 为空；把开关关掉后结果与 1.1 现状断言一致。
- [x] 2.3 补充单测并验证全过：确定性（同输入两次结果相同）；预筛反例（无收敛几何的小幅震荡不产出楔形候选）；枢轴数 >60 时跳过且不报错；开关缺省时候选集合与改动前相同。

## 3. 钉死端点后清除过期的临时标记（实施中发现，见 design 决策 7）

- [x] 3.1 `wave-subwave-verification.js` 的 `prepare` 在把窗口端点钉成 `start`/`finish` 之后，清除内部枢轴上残留的 `provisional`/`boundary` 标记（它们标记的是原始序列末端未确认的枢轴，端点钉死后已不是末端）。验证：新增单测，在 wave-1 夹具上 `createSubwaveVerifier(...).evaluate(wFrom,wTo,'impulse|leading','1d')` 的 4h 证据状态为 verified、范围 4h、`attempts` 仅含 4h、`patternId` 为 `diagonal-leading`；`git stash` 还原该修改后该用例失败。
- [x] 3.2 核对该清除对既有验证的影响：运行 `node --test tests/*.test.js`，对每个变化逐条核对原因。验证：全量通过，变化原因写入备注。

## 4. 接入验证器与证据

- [x] 4.1 `wave-subwave-verification.js` 在 `tf==='4h'` 的 `decompose` 调用传入 `diagonalEnumeration:true`，并在该档 `attempt` 记录 `diagonalEnumeration:{considered,kept,skipped}`。验证：注入夹具行情的单测中，4h 的 `attempts[0].diagonalEnumeration.kept>0`，1h 档（超限窗口）`skipped` 为 true。
- [x] 4.2 单测覆盖三种结果：楔形子腿成形时 4h verified 且 `attempts` 仅含 4h、范围 4h；楔形子腿点数不足时 4h pending 并继续 1h、日线违规保留；`--verify-tf off` 与主周期路径候选集合不变。验证：`node --test tests/wave-subwave-verification.test.js` 全过。
- [x] 4.3 更新 README `--verify-tf` 说明：4h 档对楔形角色补充枚举、枢轴数上限 60 及超限跳过。验证：按文档命令 `--verify-tf 4h` 跑通，报告里仍写「验证范围截至4小时线」。

## 5. 集成验证

- [x] 5.1 运行 `node --test tests/*.test.js`；对 golden/回归测试中的每个失败逐条核对，确认是楔形枚举带来的预期变化后再更新期望值，并在 tasks 备注里列出变更原因。验证：全量通过，备注逐条对应。
- [x] 5.2 用 `time` 重跑默认命令和 `--count "57717.55,66923.95,62209.81,82283,74887.5,87397"`：耗时不超过 170s 且不 OOM。验证：记录耗时、主选、浪 1 证据的 `attempts`/`diagonalEnumeration`/状态，以及推动浪违规数；预期违规数不高于 1，若浪 1 选中楔形则违规数应降为 0。若浪 1 选中楔形但仍 pending，如实记录原因（如子腿点数不足），不改规则凑结果。与上一变更后的基线（默认 132.6s、违规 1）对比写入备注。

## 备注

### 基线（本变更前）
- 上一变更完成后（cascade-subwave-verification-timeframes）：默认命令 132.61s、`--count` 命令 133.02s；`--count "57717.55,66923.95,62209.81,82283,74887.5,87397"` 推动浪违规 1 条（浪 1：`attempts` 为 `['4h','1h']`，均 pending，4h 最佳读法为 `impulse-strict` 且 4 浪切入 1 浪）。全量测试 346/346。

### 实施后（2026-10-08）
- 全量测试 355/355（新增 `tests/diagonal-enumeration.test.js` 9 个用例；既有用例无失败，无需改期望值）。3.2 的核对结论：清除过期 provisional 标记没有让任何既有测试变化。
- 耗时：默认命令 real 108.54s、`--count` 命令 real 140.47s，均在 170s 上限内，未 OOM（上一变更后 132.6s / 133.0s，基线 113.6s）。
- `--count` 指定数法：`impulse-strict` 违规由 1 条降为 0，状态由 invalid 变为 pending。浪 1 的证据：`attempts` 仅 `['4h']`，状态 verified，形态 `diagonal-leading`，`diagonalEnumeration` 为 考察 3445 / 保留 12 / 未跳过。浪 2 在 4h 截止（verified）；浪 3、4、5 仍 pending（4h、1h 搜索受限，其中浪 5 的 4h/1h 均无结构）。
- 默认命令主选仍为「单锯齿 Zigzag 5-3-5（下跌）」，但文字研判随之改变：大局由「主选 W 浪」变为「主选新推动浪之前的熊市调整」，当前浪型由「X 连接浪（中继）」变为「偏推动的 5 浪形态（推动浪，待确认），主选为推动 3 浪（转势）」。这是浪 1 违规被撤销后的预期排名变化。
- 实施中发现并处理：验证器 `prepare` 钉死窗口终点后，原始末位枢轴仍带 `provisional` 标记，使窗口末腿恒过不了分辨率边界（见 design 决策 7、任务 3.1）。该修复对所有 4h/1h 窗口、所有角色生效，不限于楔形。
