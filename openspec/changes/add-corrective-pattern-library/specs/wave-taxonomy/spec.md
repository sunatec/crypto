# wave-taxonomy

## ADDED Requirements

### Requirement: 平台形三子类
系统 SHALL 在平台形基础手册之上区分三个子类，均以运行总量（gross）为比率基准：
- 规则平台（Regular）：`0.7 ≤ b.gross/a.gross ≤ 1`，c 接近 a 终点。
- 扩散平台（Expanded）：`1 < b.gross/a.gross < 2`，c 超过 a 终点但 `< 3 × a.price`。
- 顺势平台（Running）：`1 < b.gross/a.gross < 2`，c 不超过 a 终点但与 a 有重叠。

#### Scenario: b 浪超 a 终点且 c 不过 a 终点判为顺势平台
- **WHEN** 候选平台形 b 浪 gross 大于 a 浪 gross 且 c 浪终点未越过 a 浪终点但切入 a 区间
- **THEN** 该候选被归类为顺势平台（Running Flat）

#### Scenario: 顺势平台不出现在 2 浪位置
- **WHEN** 引擎在 2 浪位置评估候选
- **THEN** 顺势平台不作为候选（书 5.4.3）

### Requirement: 收缩三角形（a-b-c-d-e）
系统 SHALL 提供收缩三角形手册：5 个子浪 a-b-c-d-e、内部 3-3-3-3-3、各子浪振幅依次收敛并落在收缩艾略特通道内、作为驱动浪 4 浪时任一子浪不切入 1 浪。

#### Scenario: 子浪不收敛即淘汰
- **WHEN** 候选三角形的后续子浪振幅未整体收敛
- **THEN** 该收缩三角形候选被淘汰

#### Scenario: 作为 4 浪切入 1 浪即淘汰
- **WHEN** 候选收缩三角形位于推动浪 4 浪位置且其任一子浪切入 1 浪
- **THEN** 该候选被淘汰（书 6.20）

### Requirement: 锯齿类分级（单/双/三）
系统 SHALL 区分单锯齿(5-3-5, a-b-c)、双锯齿(3-3-3, w-x-y)、三锯齿(3-3-3-3-3, w-x-y-xx-z)，并以连接段（x/xx）的回撤关系与内部结构判定归属。

#### Scenario: 双锯齿由 x 连接段区分于单锯齿
- **WHEN** 候选由两个锯齿经一个 x 连接段相连、内部呈 3-3-3
- **THEN** 归类为双锯齿而非单锯齿

### Requirement: 联合形（双重/三重横向整理）
系统 SHALL 提供联合形手册：双重横向整理(w-x-y，x 须回撤 w 的 70%)、三重横向整理(w-x-y-xx-z，x 回撤 w 70% 且 xx 回撤 y 70%)。

#### Scenario: x 浪回撤不足 70% 即淘汰
- **WHEN** 候选双重横向整理的 x 浪回撤不足 w 浪的 70%
- **THEN** 该候选被淘汰（书第 8 章）

### Requirement: 引导 vs 终结楔形按位置区分
系统 SHALL 用 diagonal 出现的位置与内部子浪结构区分引导楔形（Leading，出现于 1 浪 / A 浪）与终结楔形（Ending，出现于 5 浪 / C 浪），替换 P1 的统一 diagonal 标签。

#### Scenario: 5 浪位置的楔形标为终结楔形
- **WHEN** diagonal 出现在推动浪 5 浪或单锯齿 c 浪位置
- **THEN** 该 diagonal 被标注为终结楔形

### Requirement: 交替原则作为指引
系统 SHALL 依据"陡直 / 横向"交替（书 1.7），在已知 2 浪浪型时对 4 浪浪型给出先验加权，作为 Guideline 参与幸存候选排名，MUST NOT 作为 Rule 淘汰候选。

#### Scenario: 2 浪陡直则 4 浪横向得指引加分
- **WHEN** 2 浪为锯齿类（陡直）且 4 浪候选为平台/三角（横向）
- **THEN** 该 4 浪候选获得交替指引加分，但不因不满足交替而被淘汰
