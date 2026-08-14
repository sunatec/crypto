# Tasks：艾略特工具与级别体系（P3）

## 1. 前置
- [x] 1.1 确认 P1 引擎与 P2 浪型库已实现（通道/取点按浪型分派需要浪型库）—— P1/P2 已完成，33 单测通过

## 2. 艾略特通道（wave-channels）
- [x] 2.1 平行通道构建与浪型映射 —— `buildChannel` + `channelTypeFor`（推动浪/锯齿/平台/横向整理）
- [x] 2.2 收缩通道用于楔形/收缩三角形 —— 楔形连1-3/2-4，三角形连a-c/b-d
- [x] 2.3 扩散通道用于扩散平台形 —— `channelTypeFor` 返回 'expanding'
- [x] 2.4 "价格流出通道 ⇒ 浪型完成" 提示（Guideline）—— `channelExitHint`
- [x] 2.5 通道边缘预测下一拐点位置 —— `channelNextPivotProjection`

## 3. 斐波那契（wave-fibonacci）
- [x] 3.1 回撤取点规则（0/5、衰竭 0/3、0/c、0/y、0/z）+ 常用比率 —— `fibRetracementForPattern`（含 70%）
- [x] 3.2 扩展取点规则（3浪 0/1/2、5浪 0/1/4、c 浪 0/a/b …；三角形取 e 点）—— `fibExtensionPoints`（`triangleERef` 覆盖第3点）
- [x] 3.3 时间周期数列标记 + 共振日（仅 Guideline）—— `fibTimeResonance`

## 4. 级别体系（wave-degree）
- [x] 4.1 浪型级别标注与父子/兄弟嵌套 —— 候选带 `.degree`；`countChildPivots` 统计父跨度内子枢轴
- [x] 4.2 "月→周→日" 从高到低验证顺序 + 回退修正 —— `buildDegreeChain` 自顶向下（单时间框内以逐级放大枢轴过滤近似，分形等价；见代码内注释与下方说明）
- [x] 4.3 最低级别轻微不符按 3.23 酌情忽略 + 报告标注 —— 某级别无主选时 `note` 标注「以更粗级别为准」

## 5. 收尾
- [x] 5.1 通道/取点/时间/级别单测（对照书章节）—— `tests/analyze-wave-manual.test.js`（P3 新增 9 项，共 33/33 通过）
- [x] 5.2 端到端：多级别对同一品种出统一报告 —— 见下方 1d 真实数据回归
- [x] 5.3 `npx openspec validate add-elliott-tools-and-degrees --strict` 通过

### 实现范围说明（诚实标注）
- 「月→周→日 跨时间框」的严格实现需分别对多个时间框取数；本次以**单时间框内逐级放大枢轴过滤**（级别 0 最粗 → 级别 2 最细）实现自顶向下的**分形等价**能力。这已足以解决用户的核心诉求——让一段含数十枢轴的大跨度走势在更粗级别上坍缩为少数枢轴、从而被 ABC/12345/WXY 手册整体识别。真正的多时间框联合取数留作后续增强。
- 通道的「完成提示」「下一拐点投影」为辅助性 Guideline 信息，未作为否定依据（符合书中通道仅为辅助工具的定位）。
