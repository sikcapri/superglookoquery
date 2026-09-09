import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSummary,
  bucketTrend,
  calculateHourly,
  downsampleForChart,
  buildEnrichedBolusLog,
  summariseBasalStates,
  buildDaySummaries,
  buildChartDaySegments,
  getThresholds,
  toDisplay,
  toDisplayDelta,
} from '../src/analytics.js';

// Regression coverage for Phase 3.5's backwards feature audit (2026-09-09):
// each of these was verified live against the real archive, but that
// verification wasn't pinned anywhere — this file is the pin, so a future
// change that breaks one of these field/shape dependencies fails a test
// immediately instead of requiring a live sync to notice, same as the
// bolus split-field bug this session found by hand.

const THRESHOLDS = getThresholds('mmol', 3.9, 10.0);

function cgm(epoch, val) {
  return { type: 'CGM', epoch, val, vel: 0, extra: null, time: new Date(epoch * 1000).toISOString() };
}
function bolus(epoch, overrides = {}) {
  return {
    type: 'BOLUS', epoch, units: 4, delivered: 4, programmed: 4, recTotal: 4,
    recCorrection: 0, recCarbs: 4, carbs: 40, iob: 0.5, bgInput: 7.5, bgSource: 'CGM',
    isManual: false, interrupted: false, override: null, class: 'Meal Bolus',
    initialDeliveryPercentage: null, extendedDeliveryPercentage: null, durationString: null,
    extra: null, time: new Date(epoch * 1000).toISOString(),
    ...overrides,
  };
}

// A 2-day synthetic timeline: day 1 mostly in-range, day 2 with a low and a high.
const DAY = 86400;
// Floored to a clean UTC midnight so the synthetic 2-day timeline below maps
// to exactly 2 calendar-day segments (buildChartDaySegments splits on
// calendar-day boundaries, not on the raw span length).
const START = Math.floor(1_700_000_000 / 86400) * 86400;
function buildTimeline() {
  const items = [];
  for (let h = 0; h < 24; h++) {
    items.push(cgm(START + h * 3600, 6.5)); // day 1: steady in-range
  }
  items.push(bolus(START + 8 * 3600));
  for (let h = 0; h < 24; h++) {
    const val = h === 3 ? 3.2 : h === 15 ? 12.5 : 6.5; // day 2: a low and a high
    items.push(cgm(START + DAY + h * 3600, val));
  }
  items.push(bolus(START + DAY + 8 * 3600));
  return items.sort((a, b) => a.epoch - b.epoch);
}

test('computeSummary returns the field shape get_diabetes_summary depends on', () => {
  const timeline = buildTimeline();
  const settingsHistory = [{
    activeTimestamp: new Date(START * 1000).toISOString(),
    settings: {
      generalSettings: { activeInsulinTime: 4 },
      basalSettings: { maxBasalRate: 3.5 },
      profilesBolus: [{
        targetBgSegments: { data: [{ segmentStart: 0, value: 6.1 }] },
        isfSegments: { data: [{ segmentStart: 0, value: 2.8 }] },
        insulinToCarbRatioSegments: { data: [{ segmentStart: 0, value: 10 }] },
      }],
    },
  }];
  const dailyInsulin = [
    { dayUtc: new Date(START * 1000).toISOString().split('T')[0], dayEpoch: START, basalUnits: 18, bolusUnits: 4, totalUnits: 22 },
    { dayUtc: new Date((START + DAY) * 1000).toISOString().split('T')[0], dayEpoch: START + DAY, basalUnits: 18, bolusUnits: 4, totalUnits: 22 },
  ];

  const s = computeSummary(timeline, null, settingsHistory, THRESHOLDS, 'mmol/L', 'exact', dailyInsulin);

  assert.ok(s.reportRange.start && s.reportRange.end);
  assert.ok(s.glucoseControl.timeInRange >= 0 && s.glucoseControl.timeInRange <= 100);
  assert.equal(typeof s.glucoseControl.gmiEstimatedA1c, 'number');
  assert.ok(s.bestWorst.bestDay && s.bestWorst.worstDay, 'best/worst day must be present');
  assert.ok(s.bestWorst.bestHour && s.bestWorst.worstHour, 'best/worst hour must be present');
  assert.equal(typeof s.insulin.bolusUnits, 'number');
  assert.equal(typeof s.insulin.basalPercent, 'number');
  assert.ok(Array.isArray(s.settings) && s.settings[0].maxBasalRate === 3.5);
});

test('bucketTrend buckets by calendar granularity with sensible per-bucket fields', () => {
  const timeline = buildTimeline();
  const buckets = bucketTrend(timeline, THRESHOLDS, {
    mode: 'calendar', granularity: 'day', units: 'mmol',
  });
  assert.equal(buckets.length, 2, 'two distinct calendar days must produce two buckets');
  for (const b of buckets) {
    assert.ok(typeof b.glucose.avg === 'number');
    assert.ok(typeof b.observedDays === 'number');
  }
});

test('calculateHourly pools by clock hour', () => {
  const timeline = buildTimeline();
  const hourly = calculateHourly(timeline, THRESHOLDS, 'mmol');
  assert.ok(hourly.length > 0 && hourly.length <= 24);
  assert.ok(hourly.every((h) => 'hour' in h && 'tir' in h && 'readings' in h));
});

test('downsampleForChart keeps only the fields get_chart_series/get_chart_html read', () => {
  const timeline = buildTimeline();
  const series = downsampleForChart(timeline, 500, 'mmol');
  assert.ok(series.points.length > 0);
  assert.ok(series.boluses.length === 2);
  const b = series.boluses[0];
  assert.deepEqual(Object.keys(b).sort(), ['carbs', 'class', 'epoch', 't', 'units'].sort());
});

test('buildEnrichedBolusLog resolves context from settingsHistory and converts bgInput', () => {
  const timeline = buildTimeline();
  const settingsHistory = [{
    activeTimestamp: new Date(START * 1000).toISOString(),
    settings: {
      generalSettings: { activeInsulinTime: 4 },
      profilesBolus: [{
        targetBgSegments: { data: [{ segmentStart: 0, value: 6.1 }] },
        isfSegments: { data: [{ segmentStart: 0, value: 2.8 }] },
        insulinToCarbRatioSegments: { data: [{ segmentStart: 0, value: 10 }] },
      }],
    },
  }];
  const log = buildEnrichedBolusLog(timeline, settingsHistory, 'mmol');
  assert.equal(log.length, 2);
  assert.equal(log[0].context.DIA, 4);
  assert.equal(log[0].context.active_cr, 10);
  assert.equal(typeof log[0].cgm_val, 'number');
});

test('summariseBasalStates: no intervals returns available:false, not an error', () => {
  const r = summariseBasalStates([]);
  assert.equal(r.available, false);
});

test('summariseBasalStates: populated intervals compute minutes/percent/episodes per state', () => {
  const intervals = [
    { startEpoch: START, endEpoch: START + 3600, state: 'normal' },
    { startEpoch: START + 3600, endEpoch: START + 3600 + 600, state: 'suspend' },
  ];
  const r = summariseBasalStates(intervals);
  assert.equal(r.available, true);
  assert.equal(r.normal.episodes, 1);
  assert.equal(r.suspend.episodes, 1);
  assert.equal(r.normal.minutes, 60);
  assert.equal(r.suspend.minutes, 10);
});

test('buildDaySummaries returns one summary per day segment, each with its own computeSummary shape', () => {
  const timeline = buildTimeline();
  const daySegs = buildChartDaySegments(START, START + 2 * DAY);
  const summaries = buildDaySummaries(daySegs, timeline, [], [], THRESHOLDS, 'mmol/L');
  assert.equal(summaries.length, 2);
  assert.ok(summaries[0].dayKey && summaries[0].summary.glucoseControl);
});

test('get_glucose-style output: toDisplay/toDisplayDelta convert stored mmol values for the requested unit', () => {
  assert.equal(toDisplay(6.5, 'mmol'), 6.5);
  assert.equal(toDisplay(6.5, 'mgdl'), 117); // 6.5 * 18, rounded
  assert.equal(typeof toDisplayDelta(0.3, 'mmol'), 'number');
});
