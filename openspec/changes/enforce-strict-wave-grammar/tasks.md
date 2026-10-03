## 1. 基线与测试先行

- [x] 1.1 记录改动前基线：对 BTC-USD 1d（2025-10-05 ~ now）、ZRO-USD、MU 三个样本跑 `analyze-wave-tree.js`，保存主选、备选前 3、penalized 标记与耗时，作为对照
- [x] 1.2 在 `tests/analyze-wave-tree.test.js` 新增角色单测（先失败）：双锯齿 w 为双锯齿 → 违规；w 歧义（单/双均干净）→ 不违规；联合形 y 为联合形 → 违规；联合形 x 为双锯齿 → 不违规；子腿点数不足 → 叶子不违规
- [x] 1.3 新增楔形单测（先失败）：锯齿 a 位楔形标为引导楔形；终结楔形在 a 位 → 违规；推动浪 ③ 只能读成楔形 → 违规且描述含「（EWP）」；终结楔形子腿为驱动浪 → 违规；推动浪 ⑤ 终结楔形 → 不违规；a 引导 + c 终结 → 违规

## 2. 角色表与形态表

- [x] 2.1 新增 `ROLE_PATTERNS` 角色表（driving / corrective / impulse / impulse|leading / impulse|ending / zigzag / simple-corrective），`patternMatchesRole`、`rolePoints` 改为查表
- [x] 2.2 `PATTERNS` 中 `diagonal` 拆为 `diagonal-leading`（`buildDiagonalManual(dir, 'leading')`）与 `diagonal-ending`
- [x] 2.3 按 design D2 改写各形态 `childRoles`；支持 `childRoleAlternatives`（引导楔形 5-3-5-3-5 / 3-3-3-3-3 两套择一）
- [x] 2.4 全文替换 `patternId === 'diagonal'` 分支（`isImpulseFamily`、`waveLabelsFor`、中文名映射、`patternComplexity` 等）为 `isDrivingPattern(id)` 类辅助函数；grep 确认 `analyze-wave-tree.js` 内不再有裸 `'diagonal'` 引用

## 3. 统一的子腿角色判定

- [x] 3.1 实现 `evaluateLegRole(childFine, role, candles, depth, opts)`：点数不足 → 叶子；按 `[role]` 调 `decompose`，返回 `{ node, fulfills, cleanPatterns, note }`；不胜任时展示节点回退为 `legCharacter` 最佳读法，描述「须为 X，实测为 Y」，EWP 补足规则加「（EWP）」
- [x] 3.2 `decompose` 子腿循环（~L1418）改调 `evaluateLegRole`；多套 childRoles 时取违规最少的一套
- [x] 3.3 实现单锯齿配对约束（design D4）：a 仅能引导楔形 且 c 仅能终结楔形 → 追加一次文法违规
- [x] 3.4 `evaluateExplicitCount` 的 childRoles 循环（~L3160）改调同一函数，删除重复判定逻辑
- [x] 3.5 确认 `legCharacter` 的 `driving` 覆盖推动浪与两种楔形，「两可对侧读法」标注（~L2767）与进行中结构判定行为不变

## 4. 验证

- [x] 4.1 第 1 组单测全部通过；`npm test` 其余用例通过（`analyze-kline-wave.js` 为独立旧引擎，不在本变更范围）
- [x] 4.2 重跑三个样本，对比 1.1 基线：记录主选变化、penalized 比例、耗时；耗时超过基线 2 倍则按 design 风险项做按形态共享缓存
- [x] 4.3 人工检查 BTC-USD 新树：不再出现「双锯齿 w/y 为双锯齿」「终结楔形位于 a 浪 / ③ 浪」；把主选变化及原因写进本文件末尾的验收记录
- [x] 4.4 更新 golden 断言（`btc-usd-1d-golden.json` 是输入 K 线而非结果快照，无需重录），golden 测试通过
- [x] 4.5 README 注明：JSON `patternId` 的 `diagonal` 拆为 `diagonal-leading` / `diagonal-ending`；✅ 规则全过的判定已按书收紧

## 验收记录（2026-09-27）

实施中经用户确认的两项决定（已同步 design D3 / D7 与 spec）：
- 严格口径：子腿在该位置允许的形态里拆不出规则全过的读法即违规，不再退回「最佳读法是否匹配」。
- 顶层（无父级位置）引导 / 终结楔形合并为一条「推动浪（楔形 Diagonal，位置待定）」。

三个样本（同一份缓存 K 线，截止 2026-09-27 10:00 UTC）：

| 样本 | 主选：改动前 → 改动后 | 耗时：改动前 → 改动后 |
|---|---|---|
| BTC-USD 1d | 双锯齿 ✅ → 楔形（位置待定）✅ | 约 4.1s → 约 8.5s |
| ZRO-USD 1d | 双锯齿 ✅ → 双重横向整理（降级，tier1=1） | 约 1.1s → 约 1.2s |
| MU 1d | 双锯齿 ✅ → 双锯齿 ✅（w/y 现为单锯齿） | 约 1.2s → 约 2.3s |

- 主选变化原因：旧双锯齿的 w、y 自身为双锯齿（BTC）、平台形 / 联合形（ZRO），按书 7.3 计文法违规出局。
- BTC 新树人工检查：整段为 3-3-3-3-3 收敛楔形（双锯齿 / 单锯齿 / 双锯齿 / 单锯齿 / 单锯齿），所有双锯齿的 w、y 为单锯齿或点数不足的叶子；楔形仅出现在锯齿 a 位（引导楔形），无嵌套联合形、无错位楔形（golden 不变量测试覆盖）。
- 性能：加入「区间 × 形态」基础分共享缓存 + 角色判定快路径后约为基线 2.0–2.1 倍（未加前 2.4–3.5 倍）；`--count` 打分补上缓存，golden 用例 11.4s → 0.3s。
- 测试：158 / 158 通过。

