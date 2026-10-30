'use strict';

// 价格 / 百分比的统一格式化。报告与叙述校验共用这套精度，保证"报告里的数 ↔ 事实 JSON 里的数"可对账。

function priceDecimals(n) {
  const a = Math.abs(n);
  if (a >= 1000) return 2;
  if (a >= 1) return 4;
  if (a >= 0.01) return 6;
  return 8;
}

function fmtPrice(n) {
  if (n == null || !Number.isFinite(n)) return '待查';
  const fixed = n.toFixed(priceDecimals(n));
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

// 0.0306 → +3.06%（比例输入）
function fmtPct(ratio, digits = 2) {
  if (ratio == null || !Number.isFinite(ratio)) return '待查';
  const v = ratio * 100;
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

// 不带正号的比例（占权益、带宽、风险预算等）
function fmtPctPlain(ratio, digits = 2) {
  if (ratio == null || !Number.isFinite(ratio)) return '待查';
  return `${(ratio * 100).toFixed(digits)}%`;
}

function fmtNum(n, digits = 2) {
  if (n == null || !Number.isFinite(n)) return '待查';
  return n.toFixed(digits);
}

const PENDING = '待查';

module.exports = { fmtPrice, fmtPct, fmtPctPlain, fmtNum, priceDecimals, PENDING };
