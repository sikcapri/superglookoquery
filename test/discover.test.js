import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';

// TODO.md calls this file's source (discover.js) the area needing the
// heaviest test coverage: a bug in the redaction/threshold path is a
// privacy incident, not just a bug. Isolated scratch DB, never the real
// archive — same pattern as store.test.js.
process.env.OMNI_DB_PATH = path.join(os.tmpdir(), `superglookoquery-test-discover-${process.pid}.sqlite`);

const { ensureDbReady, ingestTimeline, _wipe } = await import('../src/store.js');
const { buildReport, buildComponentReports, renderReportText } = await import('../src/discover.js');

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

before(async () => {
  await ensureDbReady();
});

beforeEach(() => {
  _wipe();
});

test('a field used only once in the window is excluded from the report (below both thresholds)', async () => {
  // 200 bolus records so 1 occurrence is well under both the 5-count and
  // 1%-rate thresholds.
  const records = [];
  for (let i = 0; i < 200; i++) {
    records.push({ type: 'BOLUS', epoch: NOW - i * 60, extra: i === 0 ? { rareField: 'x' } : {} });
  }
  ingestTimeline(records, []);
  const report = await buildReport();
  const fieldNames = report.categories.bolus.fields.map((f) => f.fieldName);
  assert.ok(!fieldNames.includes('rareField'), 'a single occurrence must not clear the reporting bar');
});

test('a field used >=5 times clears the count threshold even at a low rate', async () => {
  const records = [];
  for (let i = 0; i < 1000; i++) {
    records.push({ type: 'BOLUS', epoch: NOW - i * 60, extra: i < 5 ? { commonEnoughField: 1 } : {} });
  }
  ingestTimeline(records, []);
  const report = await buildReport();
  const field = report.categories.bolus.fields.find((f) => f.fieldName === 'commonEnoughField');
  assert.ok(field, '5 occurrences must clear the reporting bar even at 0.5% rate');
});

test('a field used at a real rate (>=1%) clears the threshold even under 5 raw occurrences', async () => {
  // 50 records, 1 populated (2%) — rate clears, even though count (1) does not.
  const records = [];
  for (let i = 0; i < 50; i++) {
    records.push({ type: 'BOLUS', epoch: NOW - i * 60, extra: i === 0 ? { lowVolumeButHighRateField: 1 } : {} });
  }
  ingestTimeline(records, []);
  const report = await buildReport();
  const field = report.categories.bolus.fields.find((f) => f.fieldName === 'lowVolumeButHighRateField');
  assert.ok(field, 'a 2% rate must clear the bar even with only 1 raw occurrence');
});

test('reported examples are ALWAYS the fixed synthetic placeholder, never the real value', async () => {
  const records = [];
  for (let i = 0; i < 10; i++) {
    records.push({
      type: 'BOLUS',
      epoch: NOW - i * 60,
      extra: {
        numericField: 987.65, // a deliberately distinctive, "real-looking" value
        boolField: true,
        stringField: 'a real secret string',
        dateField: new Date(NOW * 1000).toISOString(),
      },
    });
  }
  ingestTimeline(records, []);
  const report = await buildReport();
  const byName = Object.fromEntries(report.categories.bolus.fields.map((f) => [f.fieldName, f]));

  assert.equal(byName.numericField.syntheticExample, 12.34, 'numeric example must be the fixed placeholder, never the real number');
  assert.equal(byName.boolField.syntheticExample, true);
  assert.equal(byName.stringField.syntheticExample, 'example text', 'string example must never leak the real string');
  assert.equal(byName.dateField.syntheticExample, '2000-01-01T00:00:00.000Z', 'date example must never leak the real timestamp');

  // Belt and suspenders: the real distinctive value must not appear ANYWHERE
  // in the rendered report text.
  const text = renderReportText(report);
  assert.ok(!text.includes('987.65'), 'the real numeric value must never appear in report text');
  assert.ok(!text.includes('a real secret string'), 'the real string value must never appear in report text');
});

test('a nested/object field is flagged nested-unsupported with a null example, not guessed at', async () => {
  const records = [];
  for (let i = 0; i < 10; i++) {
    records.push({ type: 'BOLUS', epoch: NOW - i * 60, extra: { nestedField: { a: 1, b: 2 } } });
  }
  ingestTimeline(records, []);
  const report = await buildReport();
  const field = report.categories.bolus.fields.find((f) => f.fieldName === 'nestedField');
  assert.equal(field.type, 'nested-unsupported');
  assert.equal(field.syntheticExample, null);
});

test('lowConfidence is flagged when the archive has less than the full 30-day window', async () => {
  ingestTimeline([{ type: 'CGM', epoch: NOW - 2 * DAY, val: 6.0, extra: null }], []);
  const report = await buildReport();
  assert.equal(report.lowConfidence, true);
});

test('buildComponentReports keys entries by real device name (not redacted) and correct component folder', async () => {
  const records = [];
  for (let i = 0; i < 10; i++) {
    records.push({ type: 'BOLUS', epoch: NOW - i * 60, extra: { deviceName: 'CamDiab CamAPS FX' } });
  }
  ingestTimeline(records, []);
  const entries = await buildComponentReports();
  const pumpEntry = entries.find((e) => e.component === 'pump');
  assert.ok(pumpEntry);
  assert.equal(pumpEntry.deviceName, 'CamDiab CamAPS FX', 'deviceName is deliberately real, not synthetic');
  assert.equal(pumpEntry.slug, 'camdiab-camaps-fx');
});
