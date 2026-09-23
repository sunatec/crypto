## Context

简报所有数字取自既有派生数据，不新增计算（除对已有两端点做 0.5/0.618 回撤的算术，用于无 pullback 时兜底）。

## Decisions

### D1 输出形式：简报在前，原三轴折叠
`_tree.md` = 简报 → 免责声明 → 元信息 → `<details>`（轴①②③ + 用户数法评分 + 规则树）。不新增文件或 CLI 参数。

### D2 各条数据来源
| 条目 | 来源 |
|---|---|
| 大局研判 | `buildRankedCounts` 首项（主选形态、起止价、方向）；备选取次项标签；存在框架B末浪备选时附「若跌破/升破失效点则末浪延伸，投影 …」 |
| 当前浪型 | `inProgressStruct`：起点→摆动极值、`swingChar`、是否有 pullback；主选身份取 `assessment.bounceHyp.lean`（xx→「X 连接浪（中继）」，three→「推动（转势）」） |
| 失效点 | `assessment.invalidation` |
| 下预警/支撑 | `inProgressStruct.pullback.fibTargets` 的 0.5~0.618；无 pullback 时对 起点→摆动极值 做同比例回撤 |
| 上阻力/突破 | `inProgressStruct.swingExtreme.price` |
| 反弹目标位 | 主选身份投影前 3 个（`bounceHyp.xx.targets` 或 `bounceHyp.three.targets`） |

近端 0.382 触发线、回撤结构线不进简报（与支撑区重复）。

### D3 措辞随主选身份
- 主选 xx：目标后注「到位后警惕 Z 浪下跌」；突破条注「站稳则转为推动 3 浪、趋势翻多」。
- 主选 three：突破条注「站稳开启 3 浪主升」。
方向相反（结构为上涨、当前为回落）时用 跌破/升破、支撑/阻力 对调的镜像措辞。

### D4 周期名
1d→日线、4h→4小时线、1w→周线、1h→1小时线；其它原样。品种 `-` 显示为 `/`。

## Risks
- 简报只呈现主选，读者可能忽略备选 → 第 1 条附一行备选、`<details>` 保留全文。
