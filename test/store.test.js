import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';

// Isolated scratch DB for this test process only — never the real archive.
// Must be set before store.js's resolveDbPath() is first consulted
// (ensureDbReady, below), not before import (paths.js reads it lazily).
process.env.OMNI_DB_PATH = path.join(os.tmpdir(), `superglookoquery-test-${process.pid}.sqlite`);

const {
  ensureDbReady,
  ingestTimeline,
  getTimeline,
  getFieldCapabilities,
  isCapabilityConfirmed,
  takeNewlyConfirmedCapabilities,
  recordFieldCapabilities,
  isPopulatedValue,
  ingestDailyInsulin,
  getDailyInsulin,
  ingestBasalStates,
  getBasalStates,
  ingestDeviceEvents,
  getDeviceEvents,
  getSettingsHistory,
  _wipe,
} = await import('../src/store.js');

before(async () => {
  await ensureDbReady();
});

beforeEach(() => {
  _wipe();
});

test('isPopulatedValue: 0 and false count as populated; null/undefined/NaN/blank-string do not', () => {
  assert.equal(isPopulatedValue(0), true);
  assert.equal(isPopulatedValue(false), true);
  assert.equal(isPopulatedValue(''), false);
  assert.equal(isPopulatedValue('  '), false);
  assert.equal(isPopulatedValue(null), false);
  assert.equal(isPopulatedValue(undefined), false);
  assert.equal(isPopulatedValue(NaN), false);
  assert.equal(isPopulatedValue('x'), true);
});

test('ingestTimeline + getTimeline round-trips typed bolus columns and extra together', () => {
  ingestTimeline([
    {
      type: 'BOLUS', epoch: 5000, units: 3, delivered: 3, programmed: 3,
      initialDeliveryPercentage: 60, extendedDeliveryPercentage: 40, durationString: '2h',
      extra: { someOtherNewField: 42 },
    },
  ], []);

  const tl = getTimeline(0, 999999);
  assert.equal(tl.length, 1);
  assert.equal(tl[0].initialDeliveryPercentage, 60);
  assert.equal(tl[0].extendedDeliveryPercentage, 40);
  assert.equal(tl[0].durationString, '2h');
  assert.deepEqual(tl[0].extra, { someOtherNewField: 42 });
});

test('ingestTimeline records a field_capability row only for fields in extra, from the first-seen epoch', () => {
  ingestTimeline([
    { type: 'BOLUS', epoch: 100, extra: { fieldA: 1 } },
    { type: 'BOLUS', epoch: 200, extra: { fieldA: 2 } }, // same field, later epoch
  ], []);
  const caps = getFieldCapabilities().filter((c) => c.category === 'bolus');
  assert.equal(caps.length, 1);
  assert.equal(caps[0].fieldName, 'fieldA');
  assert.equal(caps[0].firstSeenEpoch, 100, 'must keep the FIRST occurrence, not the latest');
});

test('field_capability is monotonic: a later sync that omits a field never revokes it', () => {
  ingestTimeline([{ type: 'BOLUS', epoch: 100, extra: { rareField: true } }], []);
  assert.equal(isCapabilityConfirmed('bolus', 'rareField'), true);

  // A later sync's records simply don't have the field at all.
  ingestTimeline([{ type: 'BOLUS', epoch: 200, extra: { unrelatedField: 1 } }], []);
  assert.equal(isCapabilityConfirmed('bolus', 'rareField'), true, 'capability must survive a sync that does not see it again');
});

test('a real zero/false value in extra still counts as a confirmed capability', () => {
  ingestTimeline([{ type: 'BOLUS', epoch: 100, extra: { zeroField: 0, falseField: false, blankField: '' } }], []);
  assert.equal(isCapabilityConfirmed('bolus', 'zeroField'), true);
  assert.equal(isCapabilityConfirmed('bolus', 'falseField'), true);
  assert.equal(isCapabilityConfirmed('bolus', 'blankField'), false, 'a blank string is not populated');
});

test('takeNewlyConfirmedCapabilities fires exactly once per field', () => {
  ingestTimeline([{ type: 'BOLUS', epoch: 100, extra: { freshField: 1 } }], []);
  const first = takeNewlyConfirmedCapabilities();
  assert.equal(first.some((c) => c.fieldName === 'freshField'), true);
  const second = takeNewlyConfirmedCapabilities();
  assert.equal(second.some((c) => c.fieldName === 'freshField'), false, 'must not re-fire for an already-prompted field');
});

test('recordFieldCapabilities works standalone for a category outside the cgm/bolus timeline path', () => {
  recordFieldCapabilities('stats', { camapsPumpModeAutomaticPercentage: 76, camapsPumpModeManualPercentage: 0 }, 12345);
  assert.equal(isCapabilityConfirmed('stats', 'camapsPumpModeAutomaticPercentage'), true);
  assert.equal(isCapabilityConfirmed('stats', 'camapsPumpModeManualPercentage'), true, 'a real 0 must still count');
  assert.equal(isCapabilityConfirmed('stats', 'neverSeenField'), false);
});

// Phase 3.5's backwards feature audit: get_daily_insulin, get_basal_delivery,
// get_device_events, and get_settings_history all read straight from these
// store.js functions with no analytics.js transformation in between — the
// round-trip IS the whole tool.

test('ingestDailyInsulin + getDailyInsulin round-trips per-day totals, with complete flagged by todayUtc', () => {
  ingestDailyInsulin([
    { dayUtc: '2026-01-01', dayEpoch: 1767225600, basalUnits: 18, bolusUnits: 20.1, totalUnits: 38.1 },
    { dayUtc: '2026-01-02', dayEpoch: 1767312000, basalUnits: 17, bolusUnits: 15, totalUnits: 32 },
  ], '2026-01-02'); // today is the 2nd, so the 1st must be complete and the 2nd provisional
  const rows = getDailyInsulin(1767225600, 1767312000 + 86400);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].complete, true);
  assert.equal(rows[1].complete, false);
  assert.equal(rows[0].totalUnits, 38.1);
});

test('ingestBasalStates + getBasalStates round-trips state intervals', () => {
  ingestBasalStates([
    { start: '2026-01-01T00:00:00.000Z', end: '2026-01-01T01:00:00.000Z', state: 'normal', startEpoch: 1767225600, endEpoch: 1767229200, minutes: 60 },
    { start: '2026-01-01T01:00:00.000Z', end: '2026-01-01T01:10:00.000Z', state: 'suspend', startEpoch: 1767229200, endEpoch: 1767229800, minutes: 10 },
  ]);
  const rows = getBasalStates(1767225600, 1767229800);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].state, 'normal');
  assert.equal(rows[0].minutes, 60);
  assert.equal(rows[1].state, 'suspend');
});

test('ingestDeviceEvents + getDeviceEvents round-trips pod/sensor changes as separate lists', () => {
  ingestDeviceEvents({
    podChanges: [{ epoch: 1767225600 }],
    sensorChanges: [{ epoch: 1767229200 }, { epoch: 1767312000 }],
  });
  const events = getDeviceEvents(1767225600, 1767312000);
  assert.equal(events.podChanges.length, 1);
  assert.equal(events.sensorChanges.length, 2);
  assert.ok(events.podChanges[0].time);
});

test('getDeviceEvents returns empty (not an error) lists when nothing was ever ingested', () => {
  const events = getDeviceEvents(0, 9999999999);
  assert.deepEqual(events, { podChanges: [], sensorChanges: [] });
});

test('getSettingsHistory returns the baseline snapshot active at window start, even if it predates the window', () => {
  ingestTimeline([], [
    { activeTimestamp: '2025-12-01T00:00:00.000Z', settings: { generalSettings: { activeInsulinTime: 4 } } },
    { activeTimestamp: '2026-01-15T00:00:00.000Z', settings: { generalSettings: { activeInsulinTime: 5 } } },
  ]);
  // Window starts well after the first snapshot but before the second -- the
  // first (still in force) must be the one returned, not omitted.
  const history = getSettingsHistory(
    Math.floor(Date.parse('2026-01-01T00:00:00.000Z') / 1000),
    Math.floor(Date.parse('2026-01-10T00:00:00.000Z') / 1000)
  );
  assert.equal(history.length, 1);
  assert.equal(history[0].settings.generalSettings.activeInsulinTime, 4);
});
