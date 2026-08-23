# 任务：语法角色判定改为「能否胜任」

> 仅改 `analyze-wave-tree.js`。

## 1. 判据改造 ✅

- [x] 1.1 `legCharacter` 返回补充 `canDrive`/`canCorrect`（driving/corrective 拆解是否 tier1=0）。
- [x] 1.2 新增 `grammarViolatesRole(lc, requiredChar)`：所需方向能干净拆→不违规；不能→违规；
      两方向都拆不干净→退回旧口径（`character != requiredChar`）。`decompose` 与
      `evaluateExplicitCount`（--count 路径）两处文法判定都改用它，口径一致。
- [x] 1.3 只改文法判定；`legCharacter().character` 输出未动，现状研判的反弹 5波/3波 性格等其它
      调用方不受影响。

## 2. 验证 ✅

- [x] 2.1 `--count "126296,80524,97963,57718"`：双锯齿 **违规×3 → 违规×1**（X、Y 的两条
      "该3波却像5浪"假违规消失，只剩 y/w 比例越界~1%），且从第4位升到第2位。
- [x] 2.2 单测 `grammarViolatesRole`：歧义腿(两种都干净)放任一角色不违规；只能干净五浪的腿放
      调整位仍违规；只能干净三波的放驱动位仍违规；两种都不干净退回旧口径。
- [x] 2.3 金标准 10 条不破；`node --test tests/` 87/87 全绿。
- [x] 2.4 1d/1h 两周期端到端无 undefined/NaN，用时 2.7~3.1s。排名如期重排——**双锯齿家族现在作为
      "✅规则全过"的读法出现在排名表**（84400 版最干净、居前；用户手数的 80524 版为违规×1、
      稍靠后，两者都已公平打分）；抽查重排后的候选 `macroAlternates` 仍成立、无非法骨架混入，
      变化都来自"歧义腿假违规消除"。
- [x] 2.5 脚本内注释：`legCharacter`（canDrive/canCorrect）、`grammarViolatesRole`、两处调用点
      均已就地注明新判据语义。

## 影响小结

grammar 的"驱动优先"假违规是**引擎级**的（不止用户那套数法）：修完后大量含"歧义腿"的候选
掉了 1~2 条假违规、变干净，排名更丰富也更公平。风险点（放太松）不成立——只能干净走五浪、
走不成三波的腿放在调整位仍照常违规，被放过的只有本就两可的歧义腿。
