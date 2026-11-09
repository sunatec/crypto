# Tasks

## 1. 候选池与角色（analyzePullbackCompleted）

- [x] 1.1 在新文件 `tests/pullback-internal-roles.test.js`（夹具 `tests/fixtures/btcusdt-1d-20261109.json`）写用例：用 BTC 实例枢轴 87395.67 → 79800 → 84898 → 76325.98 → 81196.01 → 73510（下跌）调用 `analyzePullbackCompleted`，期望结果含引导楔形，角色只有"单锯齿的 (a)"；再加一个单锯齿与三锯齿同为干净候选的用例，期望两者都在（用例与实现同步编写，未单独跑失败阶段）
- [x] 1.2 在 `analyzePullbackCompleted` 中，用 `[ROLE_IMPULSE_LEADING]` 对同一组枢轴再拆一次（beamK 6、maxDepth 2，独立 cache），只保留无 severe、无文法违规的候选，归为五浪类（design D1），并让 1.1 的楔形用例通过
- [x] 1.3 按 design D2 的映射给每个候选加 `roles` 字段，五浪类只给"单锯齿的 (a)"；验证 JSON 中 `currentPullback.subDegree.rankedPatterns` 每项都有 `roles`，旧字段不变
- [x] 1.4 三锯齿单独成族、其余仍按族去重（design D3），保留双锯齿原有挑选逻辑；验证 1.1 的三锯齿用例通过，且 `tests/pullback-higher-degree.test.js` 中现有双锯齿用例不受影响
- [x] 1.5 为楔形候选计算通道收窄比例（复用 `diagonal.pattern.boundaries-converge` 的宽度算法）和指引命中情况，挂在候选上（design D4）；单测验证 BTC 实例的收窄比例约为 7%，且候选未被移除

## 2. 高一级读法：20% 线与三态（buildHigherDegreeReading / buildCompletedReading）

- [x] 2.1 先写失败用例：G = 13885.67、真低点 73510、反弹最高 75599.22，期望 20% 线为 76287.13，状态①下标记"反弹未到 20% 线"；再写反弹最高越过 70% 线但未越过摆动高点的用例，期望单锯齿仍在候选
- [x] 2.2 在 `buildHigherDegreeReading` 中计算 20% 线并给出状态①的细分（≥20% / <20%），以及状态③"此前是否触及 20% 线"；让 2.1 的用例通过
- [x] 2.3 状态②加入单锯齿（深 (b)），越过摆动高点时排除；结果中带出"整段内部是否有五浪类候选"，供渲染引用；单测覆盖越过 / 未越过摆动高点两种情况
- [x] 2.4 `buildCompletedReading` 在存在五浪类候选时带出"若整段为五浪则本读法不成立"的标记，不存在时不带；单测覆盖两种情况

## 3. 渲染（renderPullbackLegDetail / renderHigherDegree）

- [x] 3.1 内部清单按"调整类 / 五浪类"两行渲染，每个候选带角色；五浪类写明"(b) 三波反弹（20% 线～摆动高点）后还有 (c)"，楔形附收窄比例与指引命中；有五浪类时去掉"均为三段式调整""走完即到头"；用渲染单测验证 BTC 实例文案包含"单锯齿的 (a)"和 76287.13，且不包含"均为三段式调整"
- [x] 3.2 读法一分支①：写出单锯齿（深 (b)）、平台形、联合形三者并存，区分依据引用内部清单；分支②：按 20% 线细分，并在无五浪类候选时注明单锯齿缺少依据；用渲染单测验证状态①（<20% 与 ≥20%）和状态②的关键句
- [x] 3.3 读法三按 2.4 的标记追加五浪风险说明；渲染单测验证有、无五浪候选时的差异
- [x] 3.4 确认文案中不出现"新一轮下跌第 1 浪"之类前提外的表述，轴②排名表与其余章节输出不变：对现有回归样本比较改动前后的 md，除"进行腿细化"一节外无差异

## 4. 回归与实跑

- [x] 4.1 更新 `tests/wave-regressions.test.js`、`tests/pullback-higher-degree.test.js` 中受影响的快照与断言，并运行全部测试确认通过
- [x] 4.2 实跑 `NODE_USE_ENV_PROXY=1 node analyze-wave-tree.js --product BTC-USD --tf 1d --start 2025-10-05T00:00:00+08:00 --end 2026-11-09T14:11:27+08:00 --verbose`（与旧报告同窗口），人工核对"进行腿细化"一节：五浪类一行、20% 线、分支①②和读法三的说明与规格场景一致

## 5. 精简版同步（renderPullbackPlain）

- [x] 5.1 "已走完"在有五浪类读法时追加"若这段本身是五浪，只是第一段"；"横着走"在有五浪类读法且未越过摆动高点时列单锯齿；状态①未过 20% 线时增列 20% 线；用 BTC 夹具的渲染单测验证三处文案，并验证无五浪类读法时保持原文
- [x] 5.2 跑全量测试，并用同窗口实跑非 verbose 报告核对"这段回调走完了吗"一节
