import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  processUnifiedGlookoData,
  buildSplitBolusLog,
  summariseSplitBolusStats,
  extractCamapsPumpModeBreakdown,
  extractBasalBolusBreakdown,
  extractDeviceNames,
  getActiveSettings,
} from '../src/analytics.js';

// Regression coverage for the SCHEMA_VERSION 8 -> 9 bug found 2026-09-09: the
// bolus split fields are initialDeliveryPercentage/extendedDeliveryPercentage/
// durationString, confirmed against a real sync — NOT initialDelivery/
// extendedDelivery/extendedBolusDuration, which were a real but wrong (and
// much rarer) guess. This test pins the correct field names so a future
// change can't silently drift back to the wrong ones without a test failing.
test('processUnifiedGlookoData maps the confirmed real bolus split fields, not the earlier wrong guess', () => {
  const raw = {
    series: {
      cgmHigh: [], cgmNormal: [], cgmLow: [],
      deliveredBolus: [
        {
          x: 1000, y: 3, isManual: false, carbsInput: 40,
          insulinRecommendationForCorrection: 0, isOverrideAbove: false, isOverrideBelow: false,
          insulinDelivered: 3, insulinProgrammed: 3, isInterrupted: false,
          totalInsulinRecommendation: 3, insulinRecommendationForCarbs: 3,
          insulinOnBoard: 0, bloodGlucoseInput: null, bloodGlucoseInputSource: null,
          initialDeliveryPercentage: 60, extendedDeliveryPercentage: 40, durationString: '2h',
          // A field this project has never seen before — must land in extra,
          // not be silently dropped.
          someBrandNewField: 'abc',
        },
      ],
    },
  };

  const timeline = processUnifiedGlookoData(raw);
  assert.equal(timeline.length, 1);
  const bolus = timeline[0];

  assert.equal(bolus.initialDeliveryPercentage, 60);
  assert.equal(bolus.extendedDeliveryPercentage, 40);
  assert.equal(bolus.durationString, '2h');
  assert.equal(bolus.initialDelivery, undefined, 'the old, wrong field name must not reappear');
  assert.equal(bolus.extendedDelivery, undefined, 'the old, wrong field name must not reappear');
  assert.equal(bolus.extendedBolusDuration, undefined, 'the old, wrong field name must not reappear');

  assert.deepEqual(bolus.extra, { someBrandNewField: 'abc' });
});

test('processUnifiedGlookoData: a non-split bolus has null/undefined split fields, not zeros implying a real split', () => {
  const raw = {
    series: {
      cgmHigh: [], cgmNormal: [], cgmLow: [],
      deliveredBolus: [
        {
          x: 2000, y: 1, isManual: true, carbsInput: 0,
          insulinRecommendationForCorrection: 0, isOverrideAbove: false, isOverrideBelow: false,
          insulinDelivered: 1, insulinProgrammed: 1, isInterrupted: false,
        },
      ],
    },
  };
  const timeline = processUnifiedGlookoData(raw);
  assert.equal(timeline[0].initialDeliveryPercentage, null);
  assert.equal(timeline[0].extendedDeliveryPercentage, null);
  assert.equal(timeline[0].durationString, null);
});

test('buildSplitBolusLog only includes real, positive extendedDeliveryPercentage boluses', () => {
  const timeline = [
    { type: 'BOLUS', epoch: 100, time: 't1', class: 'Meal Bolus', delivered: 5, initialDeliveryPercentage: 60, extendedDeliveryPercentage: 40, durationString: '2h' },
    { type: 'BOLUS', epoch: 200, time: 't2', class: 'Manual Correction Bolus', delivered: 1, initialDeliveryPercentage: null, extendedDeliveryPercentage: null, durationString: null },
    { type: 'BOLUS', epoch: 300, time: 't3', class: 'Meal Bolus', delivered: 2, initialDeliveryPercentage: 100, extendedDeliveryPercentage: 0, durationString: null },
  ];
  const log = buildSplitBolusLog(timeline);
  assert.equal(log.length, 1);
  assert.equal(log[0].time, 't1');
  assert.equal(log[0].initialDeliveryPercent, 60);

  const stats = summariseSplitBolusStats(timeline, log);
  assert.equal(stats.totalBoluses, 3);
  assert.equal(stats.splitCount, 1);
  assert.equal(stats.avgInitialDeliveryPercent, 60);
});

test('summariseSplitBolusStats on a window with no split boluses returns 0/null, not an error', () => {
  const timeline = [
    { type: 'BOLUS', epoch: 100, delivered: 5, initialDeliveryPercentage: null, extendedDeliveryPercentage: null, durationString: null },
  ];
  const log = buildSplitBolusLog(timeline);
  const stats = summariseSplitBolusStats(timeline, log);
  assert.equal(stats.splitCount, 0);
  assert.equal(stats.splitRatePercent, 0);
  assert.equal(stats.avgInitialDeliveryPercent, null);
});

// Regression coverage for the 2026-09-09 discovery: CamAPS pump-mode fields
// live in Glooko's per-window stats blob (data2), confirmed via a real
// account. These are synthetic values here, not the real account's numbers.
test('extractCamapsPumpModeBreakdown returns the breakdown when fields are populated', () => {
  const stats = {
    camapsPumpModeDurationString: '34d 23h',
    camapsPumpModeAutomaticPercentage: 76,
    camapsPumpModeManualPercentage: 0,
    camapsPumpModeEaseOffPercentage: 2,
    camapsPumpModeBoostPercentage: 5,
    camapsPumpModeLibertyPercentage: 0,
    camapsPumpModeAttemptingPercentage: 24,
    camapsPumpModePerModeDurationStrings: { automatic: '26d 11h' },
  };
  const breakdown = extractCamapsPumpModeBreakdown(stats);
  assert.equal(breakdown.automaticPercent, 76);
  assert.equal(breakdown.manualPercent, 0, 'a real zero must survive, not be treated as absent');
  assert.deepEqual(breakdown.perModeDurations, { automatic: '26d 11h' });
});

test('extractCamapsPumpModeBreakdown returns null for a non-CamAPS account (fields genuinely absent)', () => {
  assert.equal(extractCamapsPumpModeBreakdown({ stdDev: 1.2, median: 7.0 }), null);
  assert.equal(extractCamapsPumpModeBreakdown(null), null);
});

// Regression coverage for the 2026-09-11 discovery: found via manual
// field_capability inspection during real user testing that a whole new
// 89-field "stats" response had appeared and gone completely unnoticed
// (see the new-capability wiring in server.js). These 8 fields answer the
// "where's my basal rate" question directly. Synthetic values here, not the
// real account's numbers.
test('extractBasalBolusBreakdown returns the breakdown when fields are populated', () => {
  const stats = {
    basalPercentage: 55,
    otherBasalPercentage: 5,
    scheduledBasalsSum: 18.4,
    correctionBolusPercentage: 12,
    numOfCorrectionBolusesPerDay: 1.5,
    automaticBolusPercentage: 30,
    automaticBolusUnitsPerDay: 6.2,
    automaticBolusCountPerDay: 8,
  };
  const breakdown = extractBasalBolusBreakdown(stats);
  assert.equal(breakdown.basalPercent, 55);
  assert.equal(breakdown.otherBasalPercent, 5);
  assert.equal(breakdown.scheduledBasalsSum, 18.4);
  assert.equal(breakdown.correctionBolusPercent, 12);
  assert.equal(breakdown.correctionBolusesPerDay, 1.5);
  assert.equal(breakdown.automaticBolusPercent, 30);
  assert.equal(breakdown.automaticBolusUnitsPerDay, 6.2);
  assert.equal(breakdown.automaticBolusCountPerDay, 8);
});

test('extractBasalBolusBreakdown treats a real zero as populated, not absent', () => {
  const breakdown = extractBasalBolusBreakdown({ basalPercentage: 0, otherBasalPercentage: null });
  assert.equal(breakdown.basalPercent, 0);
  assert.equal(breakdown.otherBasalPercent, null);
});

test('extractBasalBolusBreakdown returns null when none of these fields are populated', () => {
  assert.equal(extractBasalBolusBreakdown({ stdDev: 1.2, median: 7.0 }), null);
  assert.equal(extractBasalBolusBreakdown(null), null);
});

// Regression coverage for the 2026-09-09 fix: CGM readings never carry a
// device name anywhere in data1 (confirmed against a real account), but
// data3.devices does have one — this is what backfills it.
test('extractDeviceNames reads cgmModel/pumpModel from data3.devices, preferring the specific property over generic model/brand', () => {
  const data3 = {
    devices: [
      { type: 'cgm', deviceClassification: 'cgm_device', properties: { cgmModel: 'FreeStyle Libre 3' }, model: 'CamAPS FX', serialNumber: 'should-never-be-read' },
      { type: 'pump', deviceClassification: 'pump', properties: { pumpModel: 'mylife YpsoPump' }, model: 'CamAPS FX' },
    ],
  };
  const names = extractDeviceNames(data3);
  assert.equal(names.cgm, 'FreeStyle Libre 3');
  assert.equal(names.pump, 'mylife YpsoPump');
});

test('extractDeviceNames falls back to model/displayName when no specific *Model property exists', () => {
  const data3 = { devices: [{ type: 'cgm', deviceClassification: 'cgm_device', model: 'Dexcom G7' }] };
  assert.equal(extractDeviceNames(data3).cgm, 'Dexcom G7');
});

test('extractDeviceNames returns nulls, not an error, when no devices list exists', () => {
  assert.deepEqual(extractDeviceNames({}), { cgm: null, pump: null });
  assert.deepEqual(extractDeviceNames(null), { cgm: null, pump: null });
});

test('processUnifiedGlookoData + range.js-style backfill: a CGM point with no per-reading device field can still end up with extra.deviceName', () => {
  // This mirrors what pullAndIngest actually does (see range.js) rather than
  // testing analytics.js in isolation, since the backfill deliberately
  // lives in range.js, not in processUnifiedGlookoData itself.
  const raw = {
    series: {
      cgmHigh: [], cgmLow: [],
      cgmNormal: [{ x: 1000, y: 6.5 }],
      deliveredBolus: [],
    },
  };
  const timeline = processUnifiedGlookoData(raw);
  assert.equal(timeline[0].extra, null, 'processUnifiedGlookoData itself must not invent a deviceName -- that is range.js\'s job');

  const deviceNames = extractDeviceNames({ devices: [{ type: 'cgm', properties: { cgmModel: 'FreeStyle Libre 3' } }] });
  for (const item of timeline) {
    if (item.type === 'CGM' && (!item.extra || item.extra.deviceName == null)) {
      item.extra = { ...(item.extra || {}), deviceName: deviceNames.cgm };
    }
  }
  assert.equal(timeline[0].extra.deviceName, 'FreeStyle Libre 3');
});

// Regression coverage for the 2026-09-15 sweep: getActiveSettings normalises
// targetBgSegments' value from a mg/dL-source Glooko account to canonical
// mmol at ingest, but until this fix left the sibling valueLow/valueHigh
// fields untouched -- they'd have shipped in raw mg/dL while value read as
// mmol from the exact same segment.
test('getActiveSettings normalises targetBg valueLow/valueHigh alongside value for a mg/dL-source account', () => {
  const prevUnit = process.env.GLOOKO_GLUCOSE_UNIT;
  process.env.GLOOKO_GLUCOSE_UNIT = 'mgdl';
  try {
    const json = {
      deviceSettings: {
        pumps: {
          guid1: {
            '2026-01-01T00:00:00.000Z': {
              profilesBolus: [{
                targetBgSegments: {
                  data: [{ segmentStart: 0, value: 110, valueLow: 100, valueHigh: 126 }],
                },
                isfSegments: { data: [{ segmentStart: 0, value: 50 }] },
              }],
            },
          },
        },
      },
    };
    const history = getActiveSettings(json, '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z');
    const sn = history[0].settings.profilesBolus[0].targetBgSegments.data[0];
    assert.ok(Math.abs(sn.value - 6.1) < 0.01, `value should be normalised to mmol, got ${sn.value}`);
    assert.ok(Math.abs(sn.valueLow - 5.55) < 0.01, `valueLow should be normalised to mmol, got ${sn.valueLow}`);
    assert.ok(Math.abs(sn.valueHigh - 7.0) < 0.01, `valueHigh should be normalised to mmol, got ${sn.valueHigh}`);
  } finally {
    if (prevUnit === undefined) delete process.env.GLOOKO_GLUCOSE_UNIT;
    else process.env.GLOOKO_GLUCOSE_UNIT = prevUnit;
  }
});
