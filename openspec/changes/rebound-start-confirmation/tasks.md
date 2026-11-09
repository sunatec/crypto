## 1. 计算

- [x] 1.1 纯函数 `buildReboundConfirmation({ candles, fine, swingExtreme, finerFine })`：高点、K 线级低点、下跌段枢轴 `D`、四条确认线及其越过状态（design D2/D3）
- [x] 1.2 推动浪门槛：低点后 K 线分段取最深回调，得出 ①/② 与 pending / third / overlap 状态、浪③ 目标（D4）
- [x] 1.3 `enrichCurrentPullback` 取 1h（或主周期 / 4h）与 15m 数据并挂到 `narrative.reboundConfirmation`，失败时为 null（D1）；`main()` 往 ctx 传 `endTs`

## 2. 渲染

- [x] 2.1 默认 md：“这段回调走完了吗”节内的确认线表 + 门槛文案（D5/D6）
- [x] 2.2 `--verbose`：每条线的推算、门槛背后的规则、0.236 参考档
- [x] 2.3 简报第 4 条加最近一条未越过的确认线
- [x] 2.4 价位梯子加入未越过的确认线与浪③ 目标

## 3. 验证

- [x] 3.1 单测：用户手工读法（75736.38 / 81196.01 / 79952）、跌出新低后重算、third 与 overlap 状态、只有一段时不出门槛
- [x] 3.2 默认 md 与 verbose md 的渲染测试；默认 md 不含“§3.3”“0.236”
- [x] 3.3 全量 `node --test tests/*.test.js` 通过；用最新数据跑日线与 1h 报告，核对价位
- [x] 3.4 README 补一句说明
