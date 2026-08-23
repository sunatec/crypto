# 设计：语法角色判定改为「能否胜任」

> 来自一次探索：用户手数双锯齿被两条假违规压低排名。仅改 `analyze-wave-tree.js`。

## 1. 根因

`legCharacter(legFine, ...)` 返回 `{ character, drivingNode, correctiveNode }`：
- `drivingNode` = 把这条腿按驱动类拆解的结果；`correctiveNode` = 按调整类拆解的结果。
- `character` 用"驱动优先"平局裁决：`dClean → 'driving'`，否则 `cClean → 'corrective'`，……

`decompose` 的文法检查：
```js
if (lc.character && lc.character !== requiredChar) grammarViolations += 1;
```
用的是 `character`（最佳性格）。于是「既能干净驱动、也能干净调整」的歧义腿，`character` 恒为
`'driving'`；一旦父浪要求它是调整浪，就误报违规。

## 2. 正确判据：能否胜任所需角色

一条腿**胜任**某角色 = 该角色方向上存在**干净拆解**（tier1=0）：
```
canDrive   = drivingNode?.primary?.score.tier1 === 0
canCorrect = correctiveNode?.primary?.score.tier1 === 0
```

文法违规判据改为：
```
requiredCorrective 时：违规 ⟺ !canCorrect
requiredDriving   时：违规 ⟺ !canDrive
```

歧义腿（canDrive && canCorrect）胜任任一角色 → 不违规（这正是本次要修的）。

**退化兜底**：当所需角色方向拆不干净、但另一方向也拆不干净时（两种都带违规），
`canDrive`、`canCorrect` 都为 false，退回旧口径——用 `character != requiredChar` 判，
避免「腿本身就成不了任何干净结构」时漏判。即：
```
if (canDrive || canCorrect) {
  grammarViolations += (requiredChar==='driving' ? !canDrive : !canCorrect) ? 1 : 0;
} else if (lc.character && lc.character !== requiredChar) {
  grammarViolations += 1;
}
```

## 3. 为什么这样才对（Elliott 语义）

- 「X 连接浪须是调整浪」的真实含义是「X 处**能**走成一个合法的调整结构」，而非「X 处**不能**
  被读成五浪」。锯齿的 a/c 本就是五浪——一段能读成五浪的走势，同样可以是某个调整结构的
  内部，二者不互斥。
- 只有当一段走势**根本走不成任何干净的调整结构**（canCorrect=false）时，把它放在调整位才
  真正违规。这正是新判据表达的。

## 4. 影响面与风险

- **排名重排**：很多"歧义腿"候选会掉一条/两条文法违规、变得更干净，主选与备选可能变化。
- **风险1（放太松）**：把"其实只能是五浪推动、硬塞进调整位"的也放过？——不会，那种
  canCorrect=false，新判据照样违规。真正被放过的只有"两种都干净"的歧义腿，它们本就两可。
- **风险2（金标准漂移）**：现有 golden 断言（顶层从126296起锚、进行中腿、优雅降级等）须不破；
  优雅降级那条断言现在已因搜索补全改为"能找到零违规顶层"，本次可能让更多段变零违规，
  须复核 golden 不出现"该降级却没降级"的反例。
- **风险3（`--count` 口径）**：用户数法的双锯齿应从 违规×3 → 违规×1（仅 y/w 比例），须验证。

## 5. 验证要点

- `--count "126296,80524,97963,57718"`：双锯齿从 违规×3 → 违规×1（X、Y 的"该3波却像5浪"两条
  假违规消失，只剩 y/w 比例越界~1%）。
- 单测：构造一条"两种都干净"的歧义腿放在调整位 → 不再计文法违规；一条"只能干净五浪"的腿
  放在调整位 → 仍计违规。
- 金标准 10 条不破；1d/1h 两周期端到端无 undefined/NaN、性能正常。
