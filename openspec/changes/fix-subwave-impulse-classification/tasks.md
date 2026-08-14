# Tasks：修正子浪驱动/调整判定

## 1. 前置
- [x] 1.1 确认 P1/P2/P3 已实现、33 单测通过（本变更在其之上修正 legShape）

## 2. 实现
- [x] 2.1 ~~给 `legShape` 增加 `candles` 参数~~ —— 实现时发现推动浪/楔形手册的规则只读 `ctx.points`（价格/索引），不读 `ctx.candles`/`ctx.measures`，故子窗口校验用最小 ctx 即可，**无需 candles 参数、无需改动任何调用点**（更小的改动面）
- [x] 2.2 新增 `legHasValidImpulse(seg, direction)`：在 seg 上滑 6 点窗口套 `buildImpulseStrictManual`/楔形手册 + `evaluateManual`，任一窗口 survived 即返回 true
- [x] 2.3 新增 `legHasOverlap(seg, direction)`：同向极值序列出现逆序（上行腿更低低点／下行腿更高高点）即判重叠
- [x] 2.4 重写 `impulseLike = legHasValidImpulse(...) && !legHasOverlap(...)`；保留 `swingCount/abcLike/pivotCount/points`
- [x] 2.5 确认无无限递归（子窗口只用纯几何推动浪手册，不回调 legShape）

## 3. 测试
- [x] 3.1 单测：重叠复杂上行腿（BTC 真实 80524→97963）→ impulseLike=false（即使 10 枢轴）
- [x] 3.2 单测：干净五浪腿 → impulseLike=true
- [x] 3.3 单测：两段等枢轴数（五浪 vs 复杂调整）判定不同
- [x] 3.4 回归：既有单测全绿（修正 2 个此前用"数枢轴"蒙混过关、c 浪腿并非真推动浪的旧 fixture；共 36/36 通过）

## 4. 真实回归与收尾
- [x] 4.1 BTC-USD 1d 重跑：80524→97963 现被正确判为调整浪（`b-is-corrective` 现通过）
- [x] 4.2 记录回归结论（如实）：
      修复前 116410→60001 单锯齿淘汰于 `zigzag.pattern.b-is-corrective`（**误判** b 浪为驱动浪，假阴性）；
      修复后淘汰理由变为 `zigzag.pattern.c-is-driving`——即 b 浪的假阴性已消除，否定法推进到 c 浪的真实检验。
      c 浪（97963→60001）内部不构成干净 5 浪推动浪：其"3浪"扩展比仅约 0.48（< 推动浪要求的 ≥1.0）、
      "4浪"(90477)越过"1浪"终点(87156) 即 4浪切入1浪、真正的下杀集中在最后一段 90477→60001（无内部细分）。
      结论：116410→60001 仍不构成单一单锯齿，但**淘汰已由真实浪型规则决定，而非 legShape 的计数假象**——
      符合本变更目标。（是否作为其它复合浪型成立，属更大级别/多时间框课题，不在本修正范围。）
- [x] 4.3 `npx openspec validate fix-subwave-impulse-classification --strict` 通过
