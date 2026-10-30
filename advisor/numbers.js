'use strict';

// "报告 / 叙述里的数字都必须出自事实 JSON"的对账工具。
// 只校验 ≥3 位有效数字的数；日期时间、MA90/ATR14 这类标识符、4H/1D、12/26/9 比值不算数字。

function stripNonNumeric(text) {
  return String(text)
    .replace(/\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?/g, ' ')
    .replace(/\d{1,2}:\d{2}(?::\d{2})?/g, ' ')
    .replace(/\d{4}\s*年|\d{1,2}\s*月|\d{1,2}\s*日|\d{8,}/g, ' ')
    .replace(/\d+(?:\/\d+)+/g, ' ')
    .replace(/[A-Za-z§#_]+\d+(?:\.\d+)*/g, ' ')
    .replace(/\d+(?:\.\d+)?[A-Za-z](?![A-Za-z])/g, ' ');
}

function sigDigits(token) {
  const digits = token.replace(/[-,]/g, '').replace('.', '').replace(/^0+/, '');
  return digits.length;
}

function decimalsOf(token) {
  const i = token.indexOf('.');
  return i < 0 ? 0 : token.length - i - 1;
}

// 返回文本中所有 ≥3 位有效数字的数字 token
function extractNumbers(text) {
  const out = [];
  for (const m of stripNonNumeric(text).matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const token = m[0].replace(/,/g, '');
    if (sigDigits(token) >= 3) out.push(token);
  }
  return out;
}

// 收集事实 JSON 里所有数值：数值叶子 + 字符串里出现的数字
function collectFactNumbers(value, acc = []) {
  if (typeof value === 'number' && Number.isFinite(value)) acc.push(value);
  else if (typeof value === 'string') for (const m of stripNonNumeric(value).matchAll(/\d[\d,]*(?:\.\d+)?/g)) acc.push(Number(m[0].replace(/,/g, '')));
  else if (Array.isArray(value)) for (const v of value) collectFactNumbers(v, acc);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) collectFactNumbers(v, acc);
  return acc;
}

function roundTo(v, d) {
  const f = 10 ** d;
  return Math.round(Math.abs(v) * f) / f;
}

// token 按其小数位数舍入后，能否对上某个事实数值（含 ×100 的百分比口径）
function matchesFact(token, factNumbers) {
  const d = decimalsOf(token);
  const t = Math.abs(Number(token));
  const eps = 0.5 * 10 ** -d + 1e-12;
  for (const v of factNumbers) {
    if (Math.abs(roundTo(v, d) - t) < 1e-9 || Math.abs(Math.abs(v) - t) <= eps) return true;
    // ×100 只对比例型数值（|v| < 10，如 0.0306 → 3.06%）成立，避免价格/ATR 的 100 倍被当成"出自事实"
    if (Math.abs(v) < 10 && (Math.abs(roundTo(v * 100, d) - t) < 1e-9 || Math.abs(Math.abs(v * 100) - t) <= eps)) return true;
  }
  return false;
}

// 返回文本中不出自事实 JSON 的数字 token
function findUnverifiedNumbers(text, facts) {
  const factNumbers = collectFactNumbers(facts);
  return extractNumbers(text).filter((t) => !matchesFact(t, factNumbers));
}

module.exports = { stripNonNumeric, extractNumbers, collectFactNumbers, matchesFact, findUnverifiedNumbers };
