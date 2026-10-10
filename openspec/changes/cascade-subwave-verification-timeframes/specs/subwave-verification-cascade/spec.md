# Spec Delta

## Purpose

规定子腿在主周期拆不出所需位置角色或子浪未证实时，如何沿周期链逐级下钻验证、何时截止、何时继续，以及证据如何记录与影响排名。

## ADDED Requirements

### Requirement: 按周期链逐级验证子腿
需要较小周期证据的子腿 SHALL 按周期链从低一档开始逐档验证：主周期 1d 为 1d → 4h → 1h，1w 为 1w → 4h → 1h，4h 为 4h → 1h。链的最细一档由 `--verify-tf` 指定（默认 1h；为 4h 时链止于 4h；为 off 时不下钻）。主周期已是最细一档时 SHALL NOT 下钻。4h K 线 SHALL 由与 1h 相同的小时行情聚合，不另发网络请求。

#### Scenario: 日线违规腿默认逐级
- **WHEN** 日线子腿拆不出所需角色，`--verify-tf` 为默认 1h
- **THEN** 系统 SHALL 先在 4h 验证，4h 未截止时再在 1h 验证，证据 `attempts` 按 4h、1h 顺序记录

#### Scenario: 最细档为 4h
- **WHEN** `--verify-tf 4h` 且日线子腿需要较小周期证据
- **THEN** 系统 SHALL 只在 4h 验证，`attempts` 仅含 4h

#### Scenario: 关闭下钻
- **WHEN** `--verify-tf off`
- **THEN** 系统 SHALL NOT 进行较小周期验证，日线角色违规照计

### Requirement: 首个拆得出的周期即截止
某档存在规则全过的所需角色拆解，且其直接子腿在该档各自胜任角色（点数不足者为末级叶子）时，系统 SHALL 在该档截止：证据状态为 verified，验证范围记为该档周期，SHALL NOT 继续验证更细周期。该 verified 证据 SHALL 能撤销主周期的角色违规，并以 verified 参与排名。

#### Scenario: 4h 拆出推动浪
- **WHEN** 日线浪 1 拆不出推动浪或引导楔形，而 4h 上存在规则全过且子腿胜任的推动浪拆解
- **THEN** 证据 SHALL 为 verified、范围为 4h、`attempts` 仅含 4h，该数法 SHALL NOT 再因浪 1 计为违规

#### Scenario: 截止周期在报告中可见
- **WHEN** 一条子腿在 4h 截止
- **THEN** Markdown 与 JSON 证据 SHALL 标明验证截至 4h，不得表述为已验证至 1h

### Requirement: 拆不出才继续下一档
某档未满足截止条件时（完整搜索不合格、搜索受限、无候选、子腿未胜任或路径规则待定），系统 SHALL 继续验证下一档。只有最细一档的完整搜索不满足角色时，证据 SHALL 为 invalid；最细一档仍未证明且搜索不完整时 SHALL 为 pending。非最细档的 invalid SHALL NOT 终止验证。

#### Scenario: 4h 不合格继续 1h
- **WHEN** 4h 上完整搜索后无规则全过的拆解
- **THEN** 系统 SHALL 在 1h 继续验证，不以 4h 结论判 invalid

#### Scenario: 1h 搜索受限仍未证明
- **WHEN** 4h 未截止，1h 未找到合法拆解且搜索受限
- **THEN** 证据 SHALL 为 pending，`attempts` 为 4h、1h，主周期角色违规 SHALL 保留

### Requirement: 违规腿与待证腿共用逐级规则
主周期拆不出所需角色的违规腿，以及主周期已拆出但子浪未证实的 pending 腿，SHALL 使用同一周期链与截止规则。

#### Scenario: 日线已拆出的 pending 腿在 4h 截止
- **WHEN** 日线子腿已有规则全过的拆解但子浪 pending，4h 上满足截止条件
- **THEN** 证据 SHALL 为 verified、范围为 4h，不再验证 1h
