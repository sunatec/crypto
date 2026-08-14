# 设计：首尾边界锚定枢轴

## 算法：anchorBoundaryPivots(pivots, candles)

输入：某级别的枢轴数组（已按 index 升序、类型交替），及对应 candles。
输出：新的枢轴数组，首尾锚定到区间起点极值与当前。

```
若 candles 为空 → 原样返回
若 pivots 为空 → 用全局 max-high / min-low 生成两个边界枢轴（H 在前或 L 在前取决于谁的 index 更小），返回

result = pivots.slice()

# —— 起点锚定 ——
first = result[0]
leadType = first.type === 'L' ? 'H' : 'L'   # 与首枢轴相反
在 [0 .. first.index] 内找 leadType 对应的极值（H→max high；L→min low）及其 barIndex
若 barIndex < first.index:                    # 极值确实在首枢轴之前
    result.unshift({ index:barIndex, type:leadType, price:极值, timestamp })

# —— 终点锚定 ——
last = result[result.length-1]
tailFrom = last.index + 1
若 tailFrom <= lastBarIndex:
    trailHigh = [tailFrom..lastBar] 内 max high 及 idxH
    trailLow  = [tailFrom..lastBar] 内 min low  及 idxL
    若 last.type === 'L':
        若 trailLow < last.price:              # 下跌延续，创更低低点
            result[last] = { index:idxL, type:'L', price:trailLow, ... }   # 延伸/替换
        否则:                                  # 反弹 → 追加一个 H
            result.push({ index:idxH, type:'H', price:trailHigh, ... })
    否则 (last.type === 'H'):
        若 trailHigh > last.price:             # 上涨延续，创更高高点
            result[last] = { index:idxH, type:'H', price:trailHigh, ... }
        否则:                                  # 回落 → 追加一个 L
            result.push({ index:idxL, type:'L', price:trailLow, ... })

return result
```

## 关键决策

**决策 1：起点用「前导区间极值」而非「第 0 根固定值」。**
126296 恰在第 0 根，但一般情况下起点极值可能落在被跳过的前导几根里的任意一根。取 `[0..first.index]` 的极值能通用捕获，而不是硬编码第 0 根。类型取「与第一个真实枢轴相反」，保证 `H126296 → L107000 → …` 的交替与方向正确（下跌开局）。

**决策 2：终点分「延续」与「反转」两种处理。**
- 延续（同向创新极值）→ **替换**最后一个枢轴（避免出现两个同类型枢轴），等价于把最后一浪拉长到当前。
- 反转（价格已往回走）→ **追加**一个反向枢轴，让数浪出现"最新的一段回撤/反弹"，抵达当前。
这与书 3.15「终点=末根K线的极值」一致，且照顾了用户"要算当前的"诉求。

**决策 3：应用位置。**
在 `scanAtDegree`（每个级别的 ATR 枢轴）与 `pivotsFine`（lookback=1）产生处各调用一次。这样：
- 每个级别都从起点极值跨到当前；
- 细枢轴也含边界，子结构判定（legShape）在边界腿上更完整。

**决策 4：幂等与安全。**
- 若起点极值就在 first.index（无更早极值）→ 不前置，避免重复。
- 若最后枢轴已是最后一根K线 → 尾部区间为空，不处理。
- 结果保持严格交替：起点锚定用相反类型；终点"延续"用替换（不新增同类型）、"反转"用相反类型追加。

## 验证

1. 单测：
   - 前导区间含更极端高点（首枢轴为 L）→ 前置一个 H 锚点、价格=前导 max high、index 在首枢轴之前。
   - 尾部延续（末枢轴 L，其后更低低点）→ 末枢轴被替换为更低的 L。
   - 尾部反转（末枢轴 L，其后是反弹高点）→ 追加一个 H。
   - 幂等：极值恰在边界枢轴上时不产生重复。
2. 真实回归：BTC-USD 1d 重跑，断言级别枢轴序列首元素为 `H126296.00 @ 2025-10-06`，末元素锚到 08-12/08-13 附近。
3. 全量 `node --test` 与 `openspec validate --strict` 通过。

## 待解问题

- "当前"用末根K线的**极值**（本设计，book-aligned）还是**收盘价**？本设计用极值；若用户更想要"当前收盘价"作为终点，可加一个开关，默认极值。
