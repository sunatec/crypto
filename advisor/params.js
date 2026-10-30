'use strict';

// 全部量化阈值集中于此。来源级别沿用手册 §1.1：A 本人公开 / B 转载 / D 手册（或本脚本）执行建议。
// 手册明言"没有已验证的本人固定阈值"的数值一律标 D；报告附录逐项列出本次所用值与来源。

const PARAM_DEFS = {
  maPeriods: { value: [5, 10, 30, 90, 120, 256], source: 'A', note: '手册 §5：2020 本人分享列出的均线' },
  macdFast: { value: 12, source: 'A', note: '手册 §8.1：MACD 12/26/9' },
  macdSlow: { value: 26, source: 'A', note: '手册 §8.1' },
  macdSignal: { value: 9, source: 'A', note: '手册 §8.1' },
  atrPeriod: { value: 14, source: 'D', note: 'ATR 周期，与波浪引擎默认一致' },
  slopeLookback: { value: 5, source: 'D', note: '手册 §5.1：近 5～10 根已收盘 K 线看斜率' },
  slopeFlat: { value: 0.001, source: 'D', note: '|5 根变化| < 0.1% 视为走平，无本人固定阈值' },
  gluePct: { value: 0.03, source: 'D', note: '手册 §7：粘合阈值无已验证的本人固定值' },
  glueLookback: { value: 20, source: 'D', note: '粘合后突破回踩：回看多少根日线内出现过粘合' },
  retestWindow: { value: 5, source: 'D', note: '突破后回踩：回看最近多少根日线的最低/最高价' },
  stopWickRatio: { value: 0.5, source: 'D', note: '止跌/止涨 K：影线占振幅 ≥ 50%' },
  pivotLookback: { value: 2, source: 'D', note: '拐点左右各 2 根，与波浪引擎同参数' },
  pivotAtrMult: { value: 1, source: 'D', note: '拐点摆幅 ≥ 1×ATR，与波浪引擎同参数' },
  divergenceWindow: { value: 3, source: 'D', note: '取拐点前后各 3 根内的柱峰/谷作为该段极值' },
  divergenceZeroTol: { value: 0.1, source: 'D', note: '手册 §8.1：相邻柱段间"接近零轴"按前一谷值的 10% 以内判定' },
  divergenceMaxAge: { value: 40, source: 'D', note: '第三极值距最新收盘不超过 40 根才视为当前有效' },
  mergeAtr: { value: 0.5, source: 'D', note: '共振区合并：相邻价位差 ≤ 0.5×日线 ATR' },
  invalidationBufferAtr: { value: 0.3, source: 'D', note: '失效价 = 最近确认高低点 ∓ 0.3×日线 ATR' },
  maxZoneSpanAtr: { value: 1, source: 'D', note: '共振区总宽度不超过 1×日线 ATR，防止相邻价位链式并成一个超宽区' },
  fibLevels: { value: [0.382, 0.5, 0.618], source: 'D', note: '手册 §10：通用斐波那契回撤位' },
  zonesPerSide: { value: 3, source: 'D', note: '现价上下方各输出至多 3 个共振区' },
  minRR: { value: 1.5, source: 'D', note: '盈亏比低于此值标"性价比不足"' },
  riskPct: { value: 0.01, source: 'D', note: '手册 §14.4：单笔 1%～2% 为参考起步，非本人固定数字' },
  levRef: { value: 3, source: 'D', note: '杠杆参考线 3；A 源 2020 经验为低杠杆，非固定数字' },
  reduceStep: { value: 0.25, source: 'D', note: '减仓分步表每步 25%' },
  stressPcts: { value: [3, 5, 10], source: 'A', note: '手册 §14.3：统一下跌 -3%/-5%/-10%' },
};

const VALID_SOURCES = ['A', 'B', 'D'];

// 参数对象：{ 名称: 取值 }，overrides 只覆盖已知名称。
function resolveParams(overrides = {}) {
  const out = {};
  for (const [name, def] of Object.entries(PARAM_DEFS)) out[name] = def.value;
  for (const [name, value] of Object.entries(overrides || {})) {
    if (!(name in PARAM_DEFS)) throw new Error(`未知参数 ${name}`);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

// 附录用：[{ name, value, source, note }]，value 取本次实际使用值。
function describeParams(params = resolveParams()) {
  return Object.entries(PARAM_DEFS).map(([name, def]) => ({
    name, value: params[name], source: def.source, note: def.note,
  }));
}

module.exports = { PARAM_DEFS, VALID_SOURCES, resolveParams, describeParams };
