import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  processUnifiedGlookoData,
  buildSplitBolusLog,
  summariseSplitBolusStats,
  extractCamapsPumpModeBreakdown,
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
