# Tasks

## 1. 脚手架与参数

- [x] 1.1 建 `advisor/` 目录与 `advise.js` 入口骨架，实现参数解析（SYMBOL、`--cost --side --qty --equity --lev --liq --margin --risk --snapshot --narrate --model --json`），缺 `--side` 等非法输入以非零码退出；`tests/advise-cli.test.js` 覆盖模式判定、`BTC-USD`/`btcusdt`/`ETHUSDT` 交易对解析与错误提示并通过
- [x] 1.2 实现 `advisor/params.js`：集中全部阈值默认值（斜率走平 0.1%、粘合 3%、止跌下影 50%、合并 0.5×ATR、失效缓冲 0.3×ATR、盈亏比 1.5、风险 1%、杠杆参考线 3、拐点 lookback/ATR 倍数）及来源级别；单测断言每项都带来源标注
- [x] 1.3 `npm install yaml` 并确认 `require('yaml')` 可用

## 2. 数据层

- [x] 2.1 实现 `advisor/data.js`：经 `getCandles`（binance transport）拉 1D 全量与 4H 最近 400 根，剔除未收盘 K 线；注入假 fetch 的离线测试通过
- [x] 2.2 用 `transformCandles(daily, TIMEFRAMES['1w'])` 合成周线并剔除未走完的当周；测试用 `btcusdt-1d-20261025.json` 断言周起点均为周一 00:00 UTC、OHLC 取值正确
- [x] 2.3 实现合约 `fapi/v1/premiumIndex` 标记价与资金费率读取，失败返回 `null` 不抛错；离线测试覆盖成功与失败两路

## 3. 指标与结构

- [x] 3.1 实现 `advisor/indicators.js`：SMA、EMA、MACD(12/26/9)、5 根斜率方向、排列、粘合、止跌/止涨 K，历史不足返回 `null` 并写 `dataGaps`；单测用手算小样本核对数值，并断言同一 fixture 两次结果相同
- [x] 3.2 实现 `advisor/structure.js` 拐点：复用 `detectPivots` + `computeATR` 并交替化，输出 HH/HL / LH/LL；单测用 fixture 断言拐点交替且与波浪引擎同参数结果一致
- [x] 3.3 实现三段顶/底背离（`confirmed`/`forming`/`none` 与 §8.4 必填字段）；单测构造"已确认""缺反向柱""第三低点后柱未缩短"三种序列并通过

## 4. 市场状态

- [x] 4.1 实现 `advisor/state.js` 6 态分类及条件命中清单；单测为每个状态构造最小事实输入，并覆盖优先级（破坏优先于趋势）

## 5. 点位模式

- [x] 5.1 实现 `advisor/levels.js` 候选价位收集与 0.5×ATR 共振合并、排序、上下各取 3；单测断言 MA90 与斐波 0.5 相近时合并且来源均列出
- [x] 5.2 实现计划卡（左侧带、§11.2 三条右侧触发及满足情况、失效价、TP1/TP2、盈亏比、性价比不足标记）与方向过滤（逆势只作观察位、`TREND_BROKEN_LONG` 不出多头计划）；单测覆盖规格中"逆势观察""盈亏比不足"两个场景

## 6. 持仓模式

- [x] 6.1 实现 `advisor/position.js` 成本定位与失效价止损相对成本百分比、持有/减仓/止损/加仓触发；单测覆盖规格"只给成本与方向"场景（98000 / 95000 → -3.06%，其余字段"待查"）
- [x] 6.2 实现 §14 风控计算（名义、实际杠杆、ΔLoss、TradeLoss、Q_max、-3/-5/-10%）、强平早于止损判定与 25% 步长减仓分步表（逐仓列保留/释放两种）；单测覆盖"超出预算""强平早于止损"场景
- [x] 6.3 实现 `--snapshot` yaml/json 读取（§20.2 字段子集，币本位标"不支持"）；单测用临时 yaml 文件断言逐仓位输出

## 7. 报告与叙述

- [x] 7.1 实现 `advisor/report.js`：终端摘要、`reports/advise/<SYMBOL>-<YYYYMMDD-HHmm>.md`（A–H、参数附录、首尾免责声明）、`--json`；单测断言章节齐全且报告中的价格均出现在事实 JSON 里
- [x] 7.2 实现 `advisor/narrate.js`：fetch Messages API、数字校验、无密钥/失败回退模板；注入假 fetch 测试覆盖"叙述引入新数字被作废"与"无密钥回退"
- [x] 7.3 在 `半木夏交易理论/README.md` 末尾补一节"脚本用法"，列出两种模式的命令示例，并按示例实际跑通

## 8. 集成验证

- [x] 8.1 `node --test tests/advise-*.test.js` 全绿，且现有 `node --test tests/*.test.js` 不回归
- [x] 8.2 联网实跑 `node advise.js BTC-USD` 与 `node advise.js BTC-USD --cost <当前价附近> --side long --qty 0.1 --equity 10000`，人工核对 MA90/MA120 与 Binance 图表一致（误差仅舍入），报告生成在 `reports/advise/`
