'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  checkUpImpulse,
  checkUpABC,
  checkDownWXY,
  detectPatterns,
  validatePatternHardRules,
  buildBriefWxyOutput,
} = require('../analyze-kline-wave.js');

function pivots(types, prices) {
  return types.map((type, index) => ({ type, price: prices[index], index, timestamp: index }));
}

test('impulse accepts wave 3 shorter than wave 1 when wave 5 is shortest', () => {
  const pattern = checkUpImpulse(pivots(
    ['L', 'H', 'L', 'H', 'L', 'H'],
    [100, 110, 105, 113, 111, 116],
  ));
  assert.equal(pattern?.mode, 'strict');
});

test('expanded-flat geometry reaches the ABC subtype validator', () => {
  const pattern = checkUpABC(pivots(
    ['L', 'H', 'L', 'H'],
    [100, 110, 98, 112],
  ));
  assert.ok(pattern);
});

test('legacy eight-pivot WXY with a one-leg X is rejected', () => {
  const oldShape = pivots(
    ['H', 'L', 'H', 'L', 'H', 'L', 'H', 'L'],
    [100, 80, 90, 70, 85, 65, 75, 55],
  );
  assert.equal(detectPatterns(oldShape).candidates.some((p) => p.type === 'wxy'), false);
});

test('WXY requires three swings in W, X and Y', () => {
  const pattern = checkDownWXY(pivots(
    ['H', 'L', 'H', 'L', 'H', 'L', 'H', 'L', 'H', 'L'],
    [100, 80, 90, 70, 78, 74, 85, 65, 75, 55],
  ));
  assert.equal(pattern?.points.length, 10);
});

test('diagonal endpoint geometry is not enough without internal subwaves', () => {
  const patternPoints = pivots(
    ['L', 'H', 'L', 'H', 'L', 'H'],
    [100, 120, 110, 128, 119, 134],
  ).map((point) => ({ ...point, index: point.index * 10 }));
  const pattern = checkUpImpulse(patternPoints);
  const incompleteMicro = patternPoints.concat([
    { type: 'H', price: 112, index: 5, timestamp: 5 },
  ]).sort((a, b) => a.index - b.index);
  assert.equal(pattern?.mode, 'diagonal');
  assert.equal(validatePatternHardRules(pattern, { pivotsMicro: incompleteMicro }), false);
});

test('brief mode refuses to invent WXY when no validated scenario exists', () => {
  const output = buildBriefWxyOutput(
    { patternScenarios: [] },
    'BTC-USD',
    '1h',
    [{ high: 101, low: 99 }],
  );
  assert.match(output, /未识别到满足 W-X-Y/);
});
