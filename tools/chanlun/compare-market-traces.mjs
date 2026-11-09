import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseCsv, parseTime, priceTicks, sha} from './import-market-csv.mjs';
import {marketTraceFields, nullableMarketFields} from './build-market-validation.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fields = Object.keys(marketTraceFields);
const nullable = new Set(nullableMarketFields);
const prices = ['open', 'high', 'low', 'close'];
const missing = text => /^(?:na|nan)?$/i.test(text.trim());

function traceNumber(text, field) {
  if (missing(text)) {
    assert(nullable.has(field), 'missing ' + field);
    return null;
  }
  assert(/^[+-]?\d+(?:\.\d*)?(?:e[+-]?\d+)?$/i.test(text.trim()), 'invalid number ' + field);
  const value = Number(text);
  assert(field === 'audit_tick_size' ? Number.isFinite(value) : Number.isSafeInteger(value), 'invalid numeric precision ' + field);
  return value;
}

export function validateMarketTrace(csv, baseline, manifest) {
  assert.equal(manifest.caseId, baseline.caseId, 'trace baseline case mismatch');
  assert.equal(manifest.canonicalSha256, sha(JSON.stringify(baseline) + '\n'), 'trace baseline hash mismatch');
  assert.deepEqual(manifest.traceFields, fields, 'unsupported trace columns');
  const parsed = parseCsv(csv);
  const columns = {};
  for (const field of ['time', ...prices, ...fields]) {
    columns[field] = parsed.headers.indexOf(field);
    assert(columns[field] >= 0, 'missing trace column ' + field);
  }
  const parameters = manifest.parameters;
  const metadata = {
    audit_feed_code: manifest.feedCode,
    audit_timeframe_seconds: manifest.seconds,
    audit_tick_size: Number(manifest.tickSize),
    audit_standard: 1,
    audit_core_tag: manifest.coreTag,
    audit_baseline_tag: manifest.baselineTag,
    audit_requested_start: parameters.requestedStart,
    audit_sample_limit: manifest.bars,
    audit_initial_bars: parameters.initialBars,
    audit_segment_pending_limit: parameters.segmentPendingLimit,
    audit_segment_work_limit: parameters.segmentWorkLimit,
    audit_center_sources: parameters.centerSources,
  };
  const rows = [];
  for (const row of parsed.rows) {
    if (missing(row[columns.audit_prefix])) continue;
    const values = Object.fromEntries(fields.map(field => [field, traceNumber(row[columns[field]], field)]));
    const prefix = rows.length + 1;
    const context = baseline.caseId + '/prefix-' + prefix;
    assert.equal(values.audit_prefix, prefix, context + '/missing, duplicate or unordered prefix');
    const expected = baseline.bars[prefix - 1];
    assert(expected, context + '/beyond baseline');
    for (const [field, value] of Object.entries(metadata)) assert.equal(values[field], value, context + '/' + field);
    assert.equal(values.audit_close_time_ms, expected.closeTime, context + '/close-time');
    const label = row[columns.time].trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(label)) {
      assert.equal(manifest.timeframe, 'D', context + '/date-only intraday time');
      assert.equal(label, new Date(expected.time).toISOString().slice(0, 10), context + '/daily date label');
    } else {
      assert.equal(parseTime(label), expected.time, context + '/open-time');
    }
    for (const field of prices) {
      assert.equal(priceTicks(row[columns[field]].trim(), baseline.tickSize), expected[field + 'Ticks'], context + '/' + field);
    }
    const previous = rows.at(-1)?.values;
    for (const field of ['audit_event_count', 'audit_fractals', 'audit_strokes', 'audit_segments', 'audit_l0', 'audit_centers']) {
      assert(values[field] >= (previous?.[field] ?? 0), context + '/' + field + ' regressed');
    }
    assert.equal(values.audit_l0, values.audit_segments, context + '/S-N count');
    for (const field of ['audit_s_blocked', 'audit_s_gap', 'audit_z_blocked']) {
      assert([0, 1].includes(values[field]), context + '/' + field + ' flag');
    }
    for (const field of ['audit_effective_start', 'audit_p_start_time', 'audit_p_end_time', 'audit_s_start_time', 'audit_s_end_time', 'audit_z_start', 'audit_z_formed', 'audit_z_extent']) {
      if (values[field] !== null) assert(values[field] <= expected.closeTime, context + '/' + field + ' future endpoint');
    }
    for (const [field, modulus] of [['audit_event_hash_a', 1000000007], ['audit_event_hash_b', 1000000009]]) {
      assert(values[field] >= 0 && values[field] < modulus, context + '/' + field + ' range');
      if (values.audit_event_count === (previous?.audit_event_count ?? 0)) {
        assert.equal(values[field], previous?.[field] ?? 0, context + '/event checksum changed without event');
      }
    }
    rows.push({time: expected.time, values});
  }
  assert(rows.length > 0, 'no closed target prefixes in exported trace');
  const identity = {caseId: baseline.caseId, coreHash: manifest.coreHash, baselineSha256: manifest.canonicalSha256};
  const canonical = JSON.stringify({...identity, rows}) + '\n';
  return {
    ...identity, rawCsvSha256: sha(csv), traceSha256: sha(canonical), prefixes: rows.length,
    fullWindow: rows.length === manifest.bars, actualObservedParameters: metadata, rows,
  };
}

export function compareMarketTraces(left, right) {
  for (const key of ['caseId', 'coreHash', 'baselineSha256']) assert.equal(left[key], right[key], 'different trace ' + key);
  assert.deepEqual(left.actualObservedParameters, right.actualObservedParameters, 'different trace parameters');
  const prefixes = Math.min(left.rows.length, right.rows.length);
  assert(prefixes > 0, 'no common prefix');
  for (let i = 0; i < prefixes; i++) {
    const context = 'prefix-' + (i + 1);
    assert.equal(left.rows[i].time, right.rows[i].time, context + '/time');
    for (const field of fields) assert.equal(left.rows[i].values[field], right.rows[i].values[field], context + '/' + field);
  }
  return {
    status: 'matching-exported-prefix-traces', caseId: left.caseId, coreHash: left.coreHash,
    baselineSha256: left.baselineSha256, comparedPrefixes: prefixes,
    leftPrefixes: left.prefixes, rightPrefixes: right.prefixes,
    leftTraceSha256: left.traceSha256, rightTraceSha256: right.traceSha256,
    leftRawCsvSha256: left.rawCsvSha256, rightRawCsvSha256: right.rawCsvSha256,
    actualObservedParameters: left.actualObservedParameters,
  };
}

export function inspectMarketTrace(caseId, leftPath, rightPath) {
  const market = path.join(root, 'tests/fixtures/chanlun/market');
  const plan = JSON.parse(fs.readFileSync(path.join(market, 'plan.json'), 'utf8'));
  assert(plan.cases.some(entry => entry.id === caseId), 'unknown case ID');
  const base = path.join(market, 'baselines', caseId);
  const raw = fs.readFileSync(path.join(base, 'bars.json'));
  const receipt = JSON.parse(fs.readFileSync(path.join(base, 'receipt.json'), 'utf8'));
  assert.equal(sha(raw), receipt.canonicalSha256, 'baseline corrupted');
  const baseline = JSON.parse(raw);
  const directory = path.join(root, 'tmp/chanlun/market-validation');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, caseId.toLowerCase() + '.pine.json'), 'utf8'));
  assert.equal(sha(fs.readFileSync(manifest.output)), manifest.sha256, 'generated Pine differs from manifest');
  const left = validateMarketTrace(fs.readFileSync(leftPath, 'utf8'), baseline, manifest);
  let report;
  if (rightPath) {
    assert.notEqual(fs.realpathSync(leftPath), fs.realpathSync(rightPath), 'provide two distinct exports');
    const right = validateMarketTrace(fs.readFileSync(rightPath, 'utf8'), baseline, manifest);
    report = {...compareMarketTraces(left, right), leftPath: path.resolve(leftPath), rightPath: path.resolve(rightPath)};
  } else {
    const {rows, ...summary} = left;
    const last = rows.at(-1);
    report = {status: 'single-export-validated', ...summary, last, leftPath: path.resolve(leftPath)};
  }
  report.scope = 'Numeric states and confirmation-event checksums. Replay and reload context recorded separately.';
  const output = path.join(directory, caseId.toLowerCase() + '-' + sha(JSON.stringify(report)).slice(0, 16) + '.json');
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  return {...report, output};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert([4, 5].includes(process.argv.length), 'usage: node tools/chanlun/compare-market-traces.mjs CASE_ID FIRST_CSV [SECOND_CSV]');
    console.log(JSON.stringify(inspectMarketTrace(process.argv[2], process.argv[3], process.argv[4]), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
