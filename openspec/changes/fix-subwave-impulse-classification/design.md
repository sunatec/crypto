# 设计：子浪驱动/调整判定修正

## 现状与根因

`legShape(sourcePivots, fromPoint, toPoint, direction)` 当前：

```js
const seg = buildSegmentPivots(sourcePivots, fromPoint, toPoint);
const swingCount = Math.max(0, seg.length - 1);
const expectedFirstType = direction === 'up' ? 'L' : 'H';
const impulseLike = seg.length >= 6 && seg[0].type === expectedFirstType; // ← 根因
const abcLike = swingCount >= 2 && swingCount <= 4;
```

`impulseLike` 仅由「子枢轴数 ≥6 + 首类型匹配」决定。由于 `pivotsFine` 是 `lookback=1`、无 ATR 过滤的最细枢轴，跨度大的腿几乎必然满足 ≥6，于是被误判为驱动浪。

## 决策 1：impulseLike 改为「实证推动浪」

新逻辑：

```
legDrivingLike(seg, direction):
  if seg.length < 6: 走「重叠兜底」判定（见决策2），返回 false 或据此判定
  在 seg 上滑动 6 点窗口：
     若某窗口方向、类型匹配，且 buildImpulseStrictManual(direction) 或
        楔形手册 evaluateManual(...).survived === true
     → 返回 true（存在合法推动浪/楔形）
  否则返回 false
```

即：**「驱动浪形态」= 该腿内部确实能找到一个通过全部铁律的推动浪（或楔形）**。这与引擎其它部分同源（复用 `buildImpulseStrictManual` / `buildImpulseDiagonalManual` + `evaluateManual`），保证判据一致、可解释。

注意：评估子窗口推动浪时需要 `ctx.candles` 与 `measures`，`legShape` 已有 `candles` 通道（部分调用点传了 candles，部分没传）。**需要给 `legShape` 补上 `candles` 参数**，并在所有调用点传入（单锯齿/平台/双三锯齿/联合形手册的闭包里都能拿到 `ctx.candles`）。

## 决策 2：重叠兜底（overlap ⇒ 调整浪）

推动浪的核心特征是「不重叠」（推动浪 4 浪不切入 1 浪）。调整浪则普遍重叠。作为 `seg.length < 6` 或推动浪校验失败时的辅助判据：

```
hasOverlap(seg, direction):
  以交替子浪为单位，若任一「同向子浪」的起点被后续反向子浪突破（上行腿中某个回撤跌破前一个上冲子浪的起点）
  → 认为存在重叠 → 倾向调整浪
```

重叠存在时，即使凑齐 6 点也应下调「驱动浪」置信——实现上：`impulseLike = 有合法推动浪窗口 && !明显重叠`。

## 决策 3：递归深度限制

`legShape` 内评估子窗口推动浪时，其规则里的结构判据（如楔形对 3 浪的要求）**不再继续下钻**（用价格几何而非再次 legShape），深度固定 1 层。避免 legShape→评估推动浪→又触发 legShape 的无限递归与性能爆炸。

实现方式：子窗口推动浪校验只用 `buildImpulseStrictManual`/`buildImpulseDiagonalManual`（它们的规则是纯价格/比率/时间几何，不调用 legShape），天然只有一层。单锯齿/平台等**会调用 legShape 的手册不参与**子窗口评估。

## 决策 4：保持向后兼容

- `legShape` 返回对象保留 `swingCount / abcLike / pivotCount / points`，仅 `impulseLike` 语义收紧。
- `legIsZigzagShaped`、`classifyLegStyle` 依赖 `legShape`/`rangeExtreme`，不改其签名（若 `legShape` 加 candles 参数，同步更新调用）。
- 现有 33 单测须全绿；其中「双锯齿 w/y 须呈单锯齿形态」等用例依赖 `legShape` 的 `impulseLike=false`（调整浪）判定，收紧后应更准确，不应回归。

## 验证

1. 单测：构造一段**明显重叠的复杂上行腿**（多次回撤破前高起点），断言新 `legShape().impulseLike === false`；构造一段**干净 5 浪**，断言 `impulseLike === true`。
2. 真实回归：BTC-USD 1d 重跑，检查 116410→60001 作为单锯齿是否不再因 `b-is-corrective` 被误淘汰；若幸存则出现在中级别候选中，若仍淘汰则淘汰理由应为**其它**真实规则（如 c 浪结构、时间规则等），并可解释。
3. 全量 `node --test` 与 `openspec validate --strict` 通过。

## 待解问题

- 「明显重叠」的阈值（突破前起点多少算重叠）需在实现时用真实数据标定；先用「严格突破（>0）」，过严则放宽到 ATR 的一个小比例。
