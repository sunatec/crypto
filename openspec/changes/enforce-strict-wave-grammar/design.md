## Context

`analyze-wave-tree.js` 用「文法」递归拆浪：`PATTERNS` 表给每个形态声明 `childRoles`，`decompose` 对每条子腿调用
`legCharacter` 判定它「能否胜任」所需角色，不能胜任就记一次文法违规（tier1，硬规则）。

现状问题：

1. **角色只有两档。** `childRoles` 虽然允许写具体形态 id（如 `'zigzag'`），但子腿循环（~L1424）里：
   ```js
   const requiredChar = childRole === DRIVING ? 'driving' : 'corrective';
   const childNode = ... : lc.correctiveNode;
   ```
   `'zigzag'` 被折算成 `'corrective'`，`patternMatchesRole` 只在 `decompose` 顶层过滤形态时起作用，子腿从未按具体形态校验。
   结果：双锯齿的 w/y 可以是双锯齿，联合形可以套联合形。
2. **楔形只有一种。** `PATTERNS` 里 `diagonal` 固定 `buildDiagonalManual(dir, 'ending')`，`childRoles` 为 5-3-5-3-5，
   且任何「驱动」位（推动浪 1/3/5、锯齿 a/c）都接受它。于是出现「终结楔形当锯齿 a 浪 / 推动浪 ③ 浪」。
3. **两处口径。** 用户数法打分（~L3160）有一份独立的 childRoles 循环，同样只判两档。

书中依据（仓库 `books/波浪理论详解.epub`，第 1–7 章）：

| 位置 | 书中规定 | 出处 |
|---|---|---|
| 单锯齿 a | 推动浪或引导楔形，不能是终结楔形 | 4.1 / 4.5 |
| 单锯齿 c | 推动浪或终结楔形，不能是引导楔形；a 为引导楔形时 c 不能是终结楔形 | 4.1 / 4.5 |
| 平台形 c | 推动浪或终结楔形（终结楔形极少），不能是引导楔形 | 5.1 / 5.3 / 5.11 |
| 双/三锯齿 w、y、z | 必须是单锯齿，不可以是双锯齿、三锯齿 | 7.1 / 7.3 |
| 双/三锯齿 x、xx | 任意调整浪（含联合形、三角形） | 7.3 |
| 联合形 w、y、z | 「简单的调整浪」 | 1.7 |
| 终结楔形内部 | 3-3-3-3-3 | 3.17 例（收缩终结楔形） |
| 扩散终结楔形 | 出现在驱动浪第 5 浪和单锯齿 c 浪 | 4.6 |

推动浪 1/3/5 浪的位置规则、引导楔形内部结构不在 1–7 章，按 Frost & Prechter 补足（见 Open Questions）。

## Goals / Non-Goals

**Goals:**
- 子浪角色能表达「具体形态集合」，并在子腿校验中真正生效。
- 楔形拆为引导 / 终结两种形态，各自有位置约束和内部结构。
- `decompose` 与用户数法打分共用同一个角色判定函数。
- 违规描述指明「须为 X，实测更像 Y」，便于报告展示。

**Non-Goals:**
- 收缩三角形各子浪的形态约束（书 6.4：b 必须是锯齿类等）——另立变更。
- 末级 / 不可再分叶子的置信度展示（上次讨论的 C 项）——另立变更。
- 报告中 X/XX/Z 级别标注与目标位一致性——另立变更。
- 不改变「数据不足不证伪」（Q3=b）：子腿点数不足以成形所需角色时仍为叶子、不计违规。

## Decisions

### D1 角色 = 允许形态集合

引入角色表，替代「类别 or 单个形态 id」的二元写法：

```
ROLE_PATTERNS = {
  driving:            [impulse-strict, diagonal-leading, diagonal-ending]   // 仅供 legCharacter / 顶层
  corrective:         [所有调整形态]
  impulse:            [impulse-strict]
  'impulse|leading':  [impulse-strict, diagonal-leading]
  'impulse|ending':   [impulse-strict, diagonal-ending]
  zigzag:             [zigzag]
  'simple-corrective':[zigzag, flat, flat-regular, flat-expanded, flat-running, triangle]
}
```

`patternMatchesRole(pat, role)` 改为查表；`rolePoints(role)` 取集合内形态的最小点数。
角色名是稳定字符串，`decompose` 的缓存键（已含 `allowedRoles.join(',')`）无需改结构。

*备选：* 在 `pattern` 上加 `canBe: [...]` 反向声明。放弃——位置约束是父级语义，放在父级 `childRoles` 更直观，和现有文法一致。

### D2 文法表改写

| 形态 | childRoles |
|---|---|
| impulse-strict | `impulse\|leading`, corrective, `impulse`, corrective, `impulse\|ending` |
| diagonal-leading | 两套择一：[driving, corrective, driving, corrective, driving] 或 [corrective ×5] |
| diagonal-ending | [corrective ×5] |
| zigzag | `impulse\|leading`, corrective, `impulse\|ending` ＋ 配对约束 |
| flat / flat-* | corrective, corrective, `impulse\|ending` |
| zigzag-double / triple | zigzag, corrective, zigzag(, corrective, zigzag) |
| sideways-double / triple | simple-corrective, corrective, simple-corrective(, corrective, simple-corrective) |
| triangle | 不变（Non-Goal） |

`childRoles` 允许为「备选数组的数组」（`childRoleAlternatives`），用于引导楔形的两种内部结构：分别评估，取文法违规最少的一套。

### D3 统一的子腿角色判定 `evaluateLegRole(childFine, role, ...)`

对一条子腿、给定所需角色：

1. 点数不足 `rolePoints(role)` → 叶子，不违规（沿用 Q3=b）。
2. `decompose(childFine, candles, [role], depth+1, opts)`：得到「在该角色允许的形态里」的最优拆解。
   primary 的 tier1 = 0 → **胜任**，展示该节点。
3. 否则 → **违规**（严格口径，实施中经用户确认）：不再像旧 `grammarViolatesRole` 那样在「驱动、调整读法都拆不干净」时
   退回比较最佳读法。展示节点：最佳读法不属于允许形态 → 展示最佳读法，描述 `w 须为单锯齿，实测为双锯齿`；
   最佳读法本属于允许形态、只是自身带违规 → 展示角色内最优拆解，描述 `3 须为推动浪，拆不出规则全过的读法（最接近：推动浪，自身违规）`。
   类别角色（driving / corrective）沿用旧展示节点；最佳性格与所需不同时沿用旧文案「走不成干净的X（更像Y）」，性格相同只是自身违规时写「拆不出规则全过的X（最接近：Z，自身违规）」（`classRoleViolationNote`）。

歧义腿（在所需角色下有干净读法，在其它角色下也有）不违规——与 grammar-role-fulfillment 口径一致。

*备选（已否决）：* 保留退回口径。实测 BTC 主选会变成「第 ③ 浪自身带违规却 ✅ 的推动浪」，用户选择严格口径。

`decompose` 子腿循环（~L1418）与用户数法打分（~L3160）都改调此函数。`legCharacter` 保留，
继续服务于「两可」对侧读法标注和进行中结构判定；它内部的 `driving` 角色覆盖三种驱动形态。

*备选：* 在 `legCharacter` 里一次性按所有细角色各拆一遍。放弃——多数角色用不到，递归量翻倍；按需拆 + 缓存更省。

### D4 单锯齿配对约束（a 为引导楔形时 c 不得为终结楔形）

子腿各自通过角色校验后，在父级追加一次检查：若 a 腿**只能**以引导楔形干净成立（不能以推动浪成立），
且 c 腿**只能**以终结楔形干净成立，则记一次文法违规。只要有一种组合满足就不违规。
实现上只在 a 腿主读法为引导楔形、c 腿主读法为终结楔形时，才另按 `impulse-strict` 单形态拆一次 a、c 判断能否以推动浪成立（命中缓存）。

### D5 楔形标签与 patternId

- `PATTERNS` 中 `diagonal` → `diagonal-leading`（`buildDiagonalManual(dir, 'leading')`）与 `diagonal-ending`。
- 所有 `patternId === 'diagonal'` 的分支（`isImpulseFamily`、`waveLabelsFor`、中文名映射 ~L3430、`patternComplexity` 等）
  改用 `isDrivingPattern(id)` 之类的辅助函数。
- 顶层（无父级位置）见 D7。
- **JSON 输出的 `patternId` 值变化**（`diagonal` → 两个新值），属对外结构变化，需在 README 注明。

### D6 规则来源标注

书外补足的规则（推动浪 1/3/5 位置、引导楔形内部结构）在违规描述中加后缀「（EWP）」，便于区分书内硬规则与补足规则。

### D7 顶层楔形合并（实施中经用户确认）

顶层（depth 0 且允许驱动类）没有父级位置，引导/终结楔形价格规则相同、引导楔形的内部结构又包含终结楔形的 3-3-3-3-3，
两者会以同一点位重复出现。顶层只让 `diagonal-leading` 参与竞争，标签改为「推动浪（楔形 Diagonal，位置待定）」并标 `positionPending`。
顺带减少顶层前沿里的重复楔形候选，缓解 beam 被挤占。

## Risks / Trade-offs

- [真实行情更多段落「无一全过」→ 频繁降级为 penalized] → 这是严格按书的预期后果；验收时对 BTC / ZRO / MU 三个样本记录主选变化和降级比例，写进 tasks 的验收记录。
- [按角色额外 decompose 导致递归量上升、可能 OOM] → 依赖缓存和 beam；若实测耗时超过基线 2 倍，先对 `simple-corrective` / `impulse|*` 共享底层单形态结果（按形态缓存，再按角色组合）。
- [终结楔形改为 3-3-3-3-3 后，原来靠 5-3-5-3-5 识别出的「楔形」大量消失] → 符合书；这些段会改由推动浪或调整形态解释。
- [golden 基线全部变化，难以区分预期变化和回归] → 先补角色单测锁定新规则，再重录 golden；重录 diff 需人工过一遍主选变化。
- [`patternId` 变化影响下游读 JSON 的脚本] → 仓库内 grep 所有 `'diagonal'` 引用一并修改；README 标注。

## Migration Plan

纯本地 CLI，无部署。改动合入后重跑三个样本、重录 golden；回滚即回退提交。

## Open Questions

- **推动浪位置规则的来源**：仓库书稿只有 1–7 章，「第 3 浪不能是楔形、第 1 浪可以是引导楔形」来自 EWP。是否接受以 EWP 补足？（本设计默认接受，并以「（EWP）」标注。）
- **「简单的调整浪」是否包含双锯齿**：书 1.7 未列举。本设计按 EWP 取 单锯齿 / 平台形 / 收缩三角形，**不含**双锯齿、三锯齿。
- **引导楔形内部结构**：EWP 允许 5-3-5-3-5 与 3-3-3-3-3 两种。本设计两种都接受（D2）。
- **联合形中三角形的位置**：EWP 要求三角形只能是最后一个成分（y 或 z）。书 5.11 提到「y 浪是收缩三角形」但未说 w 不能。本变更暂不加此约束，列为后续。
