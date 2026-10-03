## Why

文法引擎对子浪"身份"的约束只做到了「驱动 / 调整」两类，没有落到书中规定的具体形态上。导致：
BTC-USD 1d 报告的主选「双锯齿」，其 w、y 腿本身又是双锯齿（联合形套联合形），却标 ✅ 规则全过；
所有楔形一律标「终结楔形」，并出现在锯齿 A 浪、推动浪第 ③ 浪等书中禁止的位置。主选结论因此不可信，
必须先修正确性，再谈报告表达。

## What Changes

- **子浪角色细化到具体形态（严格按书）**：
  - 双锯齿 / 三锯齿的 w、y、z 腿 MUST 恰为**单锯齿**（书 7.1、7.3：「不可以是双锯齿和三锯齿」）。当前 `'zigzag'` 角色在递归中被降级为「任意调整浪」，此次修正。
  - 联合形（双重 / 三重横向整理）的 w、y、z 腿 MUST 为**简单调整浪**（单锯齿 / 平台形 / 收缩三角形），不得为双锯齿、三锯齿或联合形（书 1.7：「两个 / 三个简单的调整浪的联合」）。
  - 单锯齿 a 浪 MUST 为推动浪或引导楔形；c 浪 MUST 为推动浪或终结楔形；a 为引导楔形时 c 不得为终结楔形（书 4.1、4.5）。
  - 平台形 c 浪 MUST 为推动浪或终结楔形，不得为引导楔形（书 5.1、5.3）。
- **楔形拆分为引导楔形 / 终结楔形两种形态，并按位置约束**：
  - 引导楔形只能出现在推动浪第 1 浪、单锯齿 a 浪；终结楔形只能出现在推动浪第 5 浪、单锯齿 / 平台形 c 浪（书 4.5、4.6、5.3）。
  - 推动浪第 3 浪 MUST 为推动浪（不得为任一楔形）。仓库内书稿仅含第 1–7 章，推动浪 1/3/5 浪的位置规则未见明文，按 Frost & Prechter《艾略特波浪理论》标准补足，并在规则描述中注明来源。
  - 终结楔形内部 MUST 为 3-3-3-3-3（书 3.17 例：「收缩终结楔形，内部浪型…3-3-3-3-3」）；引导楔形内部允许 5-3-5-3-5 或 3-3-3-3-3。
  - 标签按实际形态输出（`推动浪（引导楔形 Leading Diagonal）` / `推动浪（终结楔形 Ending Diagonal）`），不再写死 `'ending'`。
- 违反上述任一角色约束 → 记一次**文法违规**（硬规则，计入 tier1），与现有 grammar-role-fulfillment 口径一致；歧义腿只要能在所需角色下拆出干净结构即不违规。
- 顶层数法（`decompose`）与用户数法打分（`evaluateExplicitCount` 的 childRoles 循环）**共用同一套角色判定**，不得两处口径不一。
- **BREAKING（结果层面）**：主选 / 备选排名与 ✅ 判定会变化；真实行情中"无一全过"而进入降级（penalized）的情况会增多。golden 基线需重录。

## Capabilities

### New Capabilities
<!-- 无 -->

### Modified Capabilities
- `wave-count-tree`：新增「子浪角色须为书中规定的具体形态」与「楔形按位置区分引导 / 终结」两项硬规则要求；✅ 规则全过的含义随之收紧。

## Impact

- 代码：`analyze-wave-tree.js`
  - `PATTERNS` 表（~L932）：`diagonal` 拆为 `diagonal-leading` / `diagonal-ending`；各形态 `childRoles` 改用细化角色。
  - `patternMatchesRole` / `rolePoints` / `legCharacter` / `grammarViolatesRole` / `decompose` 的子腿循环（~L1418）。
  - 用户数法打分 `evaluateExplicitCount` 的 childRoles 循环（~L3160）。
  - `waveLabelsFor`、`patternComplexity`、形态中文名映射（~L3346、~L3430）等按 patternId 分支处的 `'diagonal'`。
  - `buildDiagonalManual(dir, position)`：position 真正生效。
- 测试：`tests/analyze-wave-tree.test.js` 补角色单测；`tests/analyze-wave-tree.golden.test.js` 基线重录。
- 性能：按角色额外 `decompose` 会增加递归量；依赖现有 `opts.cache`（键已含 allowedRoles）与 beam 控制，需实测。
- 报告：轴①主选、备选表、父级候选、简报第 1 条均可能变化；报告模板本身不改（X/XX/Z 一致性另立变更）。
