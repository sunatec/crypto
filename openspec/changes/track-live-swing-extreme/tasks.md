# Tasks

## 1. 定位与夹具

- [x] 1.1 查明 `anchorBoundaryExtremes` 补上的 `boundary: 'end'` 枢轴在哪一步没能传到 `buildInProgressStructure`，把结论写进 design.md 的 Context（只记录、不修改主流程）；用 BTC 1h 样例打印传入 `buildInProgressStructure` 的末两个枢轴，作为核实依据
- [x] 1.2 固化夹具 `tests/fixtures/btcusdt-1h-live-extreme-20261104.json`（2026-10-31 起至 11-04 17:00 的 1h K 线，末段最高价越过 78164）；验证方法：夹具加载后，末确认枢轴之后的最高价大于 78164

## 2. 引擎

- [x] 2.1 在 `buildInProgressStructure` 中按 D1 补入 provisional 边界极值，并按 D2 处理 pullback；单测（基于 1.2 的夹具）断言：`swingExtreme.provisional === true`、价格等于末段最高价、`pullback === null`、`invalidation === 75736.38`
- [x] 2.2 单测断言：未越过摆动极值时，结果与改动前完全一致（用现有 `btc-usd-pullback-20261005.json` 夹具做前后对比）
- [x] 2.3 按 D3 核对并修改 `enrichCurrentPullback`、`bounceHypotheses` 和 `buildCurrentWaveStructures` 的取值；单测断言：越过时回撤位以新极值计算，X 占 W 的比例以新极值计算

## 3. 呈现

- [x] 3.1 轴② 当前腿在 provisional 时写“a / 浪① 延伸中（⏳）”；进行腿细化与回撤叙述在 `currentPullback === null` 时不输出；简报第 2 条去掉“回调或已结束”分支，改为“仍在延伸中”；断言夹具渲染出的 md 不含“b腿（进行中）”“浪②（进行中）”“回调或已结束”

## 4. 集成核对

- [x] 4.1 `node --test tests/` 全部通过（golden 与 regression 中的历史段断言保持不变）
- [x] 4.2 实盘复跑 `NODE_USE_ENV_PROXY=1 node analyze-wave-tree.js --product BTC-USD --tf 1h --start 2026-10-31T00:00:00+08:00 --end now`：现价高于已确认极值时，轴② 与简报口径一致；现价回落到已确认极值以下时，输出与改动前相同

## 实施记录

- 1.1：边界新高从未生成为枢轴（`anchorBoundaryExtremes` 右端只补反向极值），详见 design.md Context。
- 1.2：夹具 114 根，末根最高 78556.01 > 78164；实测末根收盘 78400（原 proposal 写的 78462 来自另一次运行）。
- 2.1：实现为 `appendLiveExtreme` + `buildCountTree` 调用处统一补点（design D1 已更新）；摆动极值 78556.01、provisional、pullback null、失效位 75736.38。
- 2.2：截到越过前的夹具与 golden 1d 夹具上 `appendLiveExtreme` 原样返回同一数组；另对 6 个夹具做改动前后快照比对，未越过的 5 个逐字节一致。
- 2.3：`bounceHypotheses.anchor`、`retraceTargets`、轴② 投影均按 78556.01 计；轴② 新增延伸中分支（design D3）。
- 3.1：另修 golden 测试中断言旧文案“回调或已结束”的一处；`wave-regressions` 中一处因 `serializeInProgress` 此前未导出而一直被跳过的断言（参数传错）已改正。
- 4.1：`node --test tests/*.test.js` 505/505 通过（新增 `tests/track-live-swing-extreme.test.js` 6 条）。
- 4.2：`--end now`（2026-11-05）时行情已转为自 80962 的回落，未触发新逻辑；改用 `--end 2026-11-04T17:39:50+08:00` 复跑完整流水线：轴②“a 腿 / 浪① 延伸中”、简报“仍在延伸中”、无“b腿（进行中）”；`tree` 仅 `verification.windows/cacheHits` 计数增加（进行中段多一条子腿被验证），主树计数不变。md 140 → 122 行。
