## Context

- 「当前高点回撤研判」由 `enrichCurrentPullback` 计算、`renderPullbackNarrative` 成句（报告渲染时以 `pricePrecision` 重渲）。
- 定级：`classifyPullbackDegree(rally, up, structureLine)`，`rally` = 前段上涨起点 → 摆动高点的细枢轴；`depth` = 高点 − 结构低点；与 `maxInternalRetrace(rally)` 比较（书§3.3）。`maxInternalRetrace` 目前只返回 `{depth, from, to}` 三个数，不带枢轴。
- 结构低点 = `splitPullbackAtLow(...).trueLow`（可能来自下钻子级别），目前只取 `.price`。
- 轴③反弹身份：`tree.assessment.bounceHyp`，`lean ∈ {xx, b, three}` 由 `deriveParentDegree` 在 `buildCountTree` 中写入（早于 `enrichCurrentPullback`）；`bounceHyp.term` = 结构终点（反弹起点），`bounceHyp.anchor` = 反弹极值（暂取 swingExtreme）；`xx.aftermath` 在父级为联合形时改写为"Y 浪下跌"。
- 规格漂移：`current-pullback-narrative` 规格的定级仍写"历史中位数"，代码已是书§3.3；规格写"正文只给主目标+延伸档"，代码正文已含极端档。

BTC 实例（`BTC-USD_1d_202510050000_202610052256`）：高点 87397（2026-09-21），结构低点 82510.37，前段上涨 57717.55→87397，内部最大回撤 82283→74887.5（幅 7395.5），升级线 80001.5；Z 极端 79770.74 < 升级线；轴③主选 X 连接浪，其后 Y 浪下跌。

## Goals / Non-Goals

**Goals:**
- 第一句每个数都有可回到图上核对的锚点（价+日期）。
- 给出级别升级线，并让同节 Z 浪结论与升级线、轴③主选一致。

**Non-Goals:**
- 下跌结构的回撤叙述（`enrichCurrentPullback` 目前固定 `up=true`）；升级线公式按方向写对即可，不扩展呈现。
- 跌破升级线后重新按高一级数浪、重算目标——只说明结局去向并指向轴③。
- 改变轴③的身份排名或目标。

## Decisions

### 1. 前置查证 XX 173%

Y=85250→82510.37（幅 2739.63），173% 意味着 `bounceExtreme`≈87250，几近高点，而主级别边缘在 84425.07。先核对细枢轴序列与 `splitPullbackAtLow` 中"真低点之后离真低点最远的反向枢轴"的取法：若取错（如越界取到高点之前或把高点所在枢轴算入），先修，并把结论记入本节。Z 目标以 `bounceExtreme` 为量度起点，起点不对则后续标注无意义。

查证结论（2026-10-07）：原 BTC 报告及同窗日线缓存的细枢轴为 87397（09-21）→82708.96（09-24）→85250（09-25）→82510.37（09-28）→87249.05（10-02）→84425.07（10-03）。`splitPullbackAtLow` 仅在真低点之后取反弹极值，87249.05 确实晚于真低点，XX/Y=(87249.05−82510.37)/(85250−82510.37)=172.9679%；84425.07 是其后回落的边缘价，不能代替 XX 高点。取法无误，保留 Z 目标；补回归锁住此顺序。原示例把高点日期写成 09-20，但原报告的 timestamp=1789948800 与缓存均对应 UTC 2026-09-21；验收采用实际时间戳，不把示例日期写死。

### 2. 锚点与日期

- `maxInternalRetrace` 保留峰值枢轴与谷值枢轴，返回 `{depth, from, to, fromTs, toTs}`（`from/to` 仍为价，兼容既有读者与测试）。
- `classifyPullbackDegree` 返回 `extreme: {price, timestamp}`、`rallyStart: {price, timestamp}`（取 `swingPivots` 首尾）。
- `enrichCurrentPullback` 记录 `structureLow: {price, timestamp, tf}`（取自 `split.trueLow`，未拆出时取主级别边缘并标注）。
- 日期格式：日线及以上 `YYYY-MM-DD`（沿用 `toISOString().slice(0,10)`）；下钻子级别得到的点用 `YYYY-MM-DD HH:mm UTC`。
- 成句：`自高点 **H**（日期）回撤至结构低点 **L**（日期），幅 **D**（p%）。前段上涨 S（日期）→H 内部最大一次回撤为 a（日期）→b（日期），幅 M，本次约为其 r%：…`

### 3. 升级线

- `upgradeLine = up ? extreme − maxInternal.depth : extreme + maxInternal.depth`，仅在 `maxInternal` 存在时给出。
- `exceeds===false`：在"续涨条件"之后单列 `**级别升级线**：跌破 **U**（=H−M），回撤幅度即超过前段上涨内部最大一次，按书§3.3 视为 S→H 这段上涨已经走完。`
- `exceeds===true`：不单列；第一句改为"已跌破升级线 U（…）"并沿用既有"高一级"表述。
- `exceeds===null`：不出现。
- 措辞约束：只陈述级别判定的后果，不出现"警惕/警戒/注意风险"等预警语（沿用规格"MUST NOT 输出阈值预警"）。

### 4. Z 浪冲突（方案 B）

- `zwaveProjection` 增加可选 `upgradeLine` 参数，主/延伸/极端各档标 `belowUpgradeLine`；正文在低于升级线的档后注"（低于升级线 U）"。
- 只要存在升级线且有 Z 跌破路径，结局一律按升级线分叉（跌破路径向下无界，不以"列出的档是否越线"为条件）：
  - 升级线上方走完 → "转向上涨"（原结论）。
  - 跌破升级线 → 由 `afterUpgrade` 给出：
    - `lean=xx`：`前段上涨视为走完；按轴③主选（X 连接浪），X 已在 H 完成，接下来看 <xx.aftermath>（目标见轴③）`
    - `lean=b`：`…按轴③主选（B 反弹），B 已在 H 完成，接下来看 C 浪下跌（目标见轴③）`
    - `lean=three`：`…按轴③主选（推动 3 浪），此回撤属其后的高一级调整，走完后仍看上涨`
    - 均附："本节 W-X-Y-Z 为子浪级数法，升级后仅作参考"。
  - `exceeds===true` 时直接使用跌破分支。
- **同源校验**：仅当 `bounceHyp` 存在、`bounceHyp.term` 等于前段上涨起点价、`bounceHyp.anchor` 等于高点价时引用轴③；否则通用写法 `前段上涨视为已走完，后续按轴③反弹身份重新研判`。`afterUpgrade.basis` 记 `axis3` 或 `generic`。
- **时序**：`lean` 在 `buildCountTree` 写入、早于叙述计算；但为避免依赖调用顺序，跌破分支在报告渲染时（`renderPullbackNarrative(nr, pricePrecision, bounceHyp)`）生成，计算期的 `narrative.text` 同样传入 `tree.assessment.bounceHyp`。

### 5. 规格对齐

- 定级要求改名为「回撤定级与级别升级线」，内容改为书§3.3 判据（替换"历史中位数"）。
- 正文深度：主目标 + 延伸 + 极端（对齐现状），各档依据与 `belowUpgradeLine` 入 JSON。

## Risks / Trade-offs

- 引用轴③使本节与轴③耦合 → 同源校验 + 通用写法回退；测试覆盖不同源场景。
- 下钻子级别的结构低点时间精度与主级别不同 → 子级别点带时分与 UTC 标注。
- 前置查证若发现 `bounceExtreme` 取法错误，Z 目标数值会变，golden 需随之更新；在 tasks 中先于 Z 标注完成。
