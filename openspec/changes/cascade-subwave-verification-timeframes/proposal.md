## Why

日线子腿拆不出所需角色时，验证器跳过 4h 直接在 1h 上重拆（fix-book-audit-p1 任务 4.4 为控制耗时只验最细周期）。1h 枢轴多、搜索受限，长腿常落到 pending，无法撤销日线违规。例如用户数法 57717.55→66923.95→62209.81→82283→74887.5→87397 价格规则全过，仅因浪 1 日线拆成双锯齿、1h 返回 pending 而被淘汰。以前跑 4h 时，4h 不是分辨率边界，拆干净也只能给 pending，起不到截止作用。

## What Changes

- 子腿验证改为逐级下钻：主周期拆不出（或子浪未证实）→ 低一档周期；该档拆得出即截止，拆不出才继续下一档，直到声明的最细周期。
- 「拆得出」= 该档存在规则全过的角色拆解，且其直接子腿在该档胜任各自角色（点数不足的子腿为末级叶子）。命中即记 verified，验证范围标注为截止周期，可撤销主周期的角色违规。
- 「拆不出」= 该档未命中上一条（含 invalid、搜索受限 pending、无候选），继续下一档；只有最细周期的完整搜索失败才判 invalid。
- 违规腿与主周期已拆出但子浪 pending 的腿使用同一套逐级规则。
- 周期链：1d → 4h → 1h；1w → 4h → 1h；4h → 1h。`--verify-tf` 指定链的最细一档（`4h` 时链止于 4h，`off` 不下钻）。4h 仍由同一份 1h 行情聚合（交易所接口无 4h 粒度）。
- **BREAKING**（输出）：部分腿的 `attempts` 由 `['1h']` 变为 `['4h']` 或 `['4h','1h']`，`verificationScope` 可能为 4h；主计数与指定数法的排名可能随之变化。

## Capabilities

### New Capabilities
- `subwave-verification-cascade`: 子腿跨周期逐级验证的周期链、截止条件、失败继续条件与证据记录。

### Modified Capabilities
（无。相关约定位于尚未归档的 verify-subwaves-across-timeframes 与 fix-book-audit-p1 变更中，`openspec/specs/` 下没有可修改的主规格；本变更以新能力记录，并在 design.md 说明对这两份变更中「只验最细周期」决定的取代关系。）

## Impact

- 代码：`wave-subwave-verification.js`（`evaluate` 的周期链与截止逻辑、各档 `decompose` 的分辨率边界设置）；`analyze-wave-tree.js` 无需改接口。
- 测试：`tests/wave-subwave-verification.test.js` 中断言「最细为 1h 时只验 1h」的用例需改写，新增 4h 截止与 4h→1h 继续的用例；全量测试需重跑。
- 文档：README `--verify-tf` 说明。
- 性能：4h 每次都跑、1h 仅在 4h 未命中时跑；需与当前默认 BTC 1d 命令（约 170s）对比计时，上限 1.5 倍且不 OOM。
- 无新依赖、无新增网络请求。
