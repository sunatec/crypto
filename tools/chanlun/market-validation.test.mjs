import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {extractCore} from './build-validation.mjs';
import {generateMarketValidation} from './build-market-validation.mjs';
import {compareMarketTraces, validateMarketTrace} from './compare-market-traces.mjs';
import {sha} from './import-market-csv.mjs';

const root = new URL('../../', import.meta.url);
const read = name => fs.readFileSync(new URL(name, root), 'utf8');
const market = 'tests/fixtures/chanlun/market/';
const plan = JSON.parse(read(market + 'plan.json'));
const production = read('chanlun_original.pine');
function fixture(caseId) {
  const directory = market + 'baselines/' + caseId + '/';
  const baseline = JSON.parse(read(directory + 'bars.json'));
  const receipt = JSON.parse(read(directory + 'receipt.json'));
  return {baseline, receipt, generated: generateMarketValidation(production, baseline, receipt, plan)};
}

test('all six scripts preserve the frozen OHLC and production core', () => {
  let total = 0;
  for (const target of plan.cases) {
    const {baseline, receipt, generated} = fixture(target.id);
    assert(generated.source.includes(extractCore(production)));
    assert.equal(generated.sha256, sha(generated.source));
    assert.equal(generated.canonicalSha256, receipt.canonicalSha256);
    assert.equal(generated.bars, 1008);
    assert(generated.traceFields.length < 64);
    const rows = [...generated.source.matchAll(/^    chunks\.push\((.*)\)$/gm)]
      .flatMap(match => JSON.parse(match[1]).split(';').map(row => row.split(',').map(Number)));
    assert.deepEqual(rows, baseline.bars.map(bar => [bar.openTicks, bar.highTicks, bar.lowTicks, bar.closeTicks]));
    total += rows.length;
  }
  assert.equal(total, 6048);
});

// Exercise the CSV contract without supplying computed morphology expectations.
function traceCsv(baseline, manifest, count, mutate = () => {}) {
  const header = ['time', 'open', 'high', 'low', 'close', ...manifest.traceFields];
  const rows = baseline.bars.slice(0, count).map((bar, i) => {
    const values = Object.fromEntries(manifest.traceFields.map(key => [key, 0]));
    for (const key of manifest.nullableFields) values[key] = '';
    const parameters = manifest.parameters;
    Object.assign(values, {
      time: new Date(bar.time).toISOString().slice(0, manifest.timeframe === 'D' ? 10 : undefined),
      open: (bar.openTicks * Number(baseline.tickSize)).toFixed(2),
      high: (bar.highTicks * Number(baseline.tickSize)).toFixed(2),
      low: (bar.lowTicks * Number(baseline.tickSize)).toFixed(2),
      close: (bar.closeTicks * Number(baseline.tickSize)).toFixed(2),
      audit_feed_code: manifest.feedCode,
      audit_timeframe_seconds: manifest.seconds,
      audit_tick_size: manifest.tickSize,
      audit_standard: 1,
      audit_core_tag: manifest.coreTag,
      audit_baseline_tag: manifest.baselineTag,
      audit_requested_start: parameters.requestedStart,
      audit_sample_limit: manifest.bars,
      audit_initial_bars: parameters.initialBars,
      audit_segment_pending_limit: parameters.segmentPendingLimit,
      audit_segment_work_limit: parameters.segmentWorkLimit,
      audit_center_sources: parameters.centerSources,
      audit_prefix: i + 1,
      audit_close_time_ms: bar.closeTime,
    });
    mutate(values, i);
    return header.map(key => values[key]).join(',');
  });
  return [header.join(','), ...rows].join('\n') + '\n';
}

test('a short replay export compares against the corresponding full loaded prefix', () => {
  const {baseline, generated} = fixture('BTCUSDT-60');
  const left = validateMarketTrace(traceCsv(baseline, generated, 1008), baseline, generated);
  const right = validateMarketTrace(traceCsv(baseline, generated, 2), baseline, generated);
  assert.equal(left.fullWindow, true);
  assert.equal(right.fullWindow, false);
  assert.equal(compareMarketTraces(left, right).comparedPrefixes, 2);
  const daily = fixture('ETHUSDT-D');
  assert.equal(validateMarketTrace(traceCsv(daily.baseline, daily.generated, 2), daily.baseline, daily.generated).prefixes, 2);
});

test('trace verification rejects changed input, parameters, order and future endpoints', () => {
  const {baseline, generated} = fixture('BTCUSDT-60');
  const mismatches = [
    [row => {row.open = '1.00';}, /prefix-1\/open/],
    [row => {row.audit_segment_work_limit++;}, /audit_segment_work_limit/],
    [row => {row.audit_prefix++;}, /missing, duplicate or unordered/],
    [row => {row.audit_p_end_time = row.audit_close_time_ms + 1;}, /future endpoint/],
    [row => {row.audit_event_hash_a = 5;}, /checksum changed without event/],
  ];
  for (const [mutate, expected] of mismatches) {
    const csv = traceCsv(baseline, generated, 2, mutate);
    assert.throws(() => validateMarketTrace(csv, baseline, generated), expected);
  }
});

test('matching OHLC does not hide different candidate prices or event streams', () => {
  const {baseline, generated} = fixture('BTCUSDT-60');
  const parse = mutate => validateMarketTrace(traceCsv(baseline, generated, 2, mutate), baseline, generated);
  const left = parse((row, i) => {if (i === 1) row.audit_p_end_ticks = 7500000;});
  const changed = parse((row, i) => {if (i === 1) row.audit_p_end_ticks = 7500001;});
  assert.throws(() => compareMarketTraces(left, changed), /prefix-2\/audit_p_end_ticks/);
  const eventTrace = hash => parse((row, i) => {
    if (i === 1) Object.assign(row, {audit_event_count: 1, audit_fractals: 1, audit_event_hash_a: hash});
  });
  assert.throws(() => compareMarketTraces(eventTrace(101), eventTrace(102)), /prefix-2\/audit_event_hash_a/);
});
