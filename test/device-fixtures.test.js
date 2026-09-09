import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';

import { camapsFxFixture, omnipod5Fixture, genericUnknownDeviceFixture } from './fixtures/glooko-responses.mjs';

// Phase 3's "synthetic mock Glooko response fixtures for a few different
// device shapes" item: exercises deriveBasalStates, extractDeviceEvents,
// extractDeviceNames, extractCamapsPumpModeBreakdown, and capability gating
// against three hand-built device shapes, so a new device combination's
// behaviour can be reasoned about without needing that real hardware.
process.env.OMNI_DB_PATH = path.join(os.tmpdir(), `superglookoquery-test-fixtures-${process.pid}.sqlite`);

const {
  processUnifiedGlookoData,
  deriveBasalStates,
  extractDeviceEvents,
  extractDeviceNames,
  extractCamapsPumpModeBreakdown,
} = await import('../src/analytics.js');
const { ensureDbReady, recordFieldCapabilities, isCapabilityConfirmed, _wipe } = await import('../src/store.js');

const T0 = 1_700_000_000;

before(async () => {
  await ensureDbReady();
});

beforeEach(() => {
  _wipe();
});

test('camapsFxFixture: basal-state series and device-change events are genuinely empty, matching the real reference account', () => {
  const fx = camapsFxFixture(T0);
  assert.deepEqual(deriveBasalStates(fx.data1, null, null), []);
  assert.deepEqual(extractDeviceEvents(fx.data1), { podChanges: [], sensorChanges: [] });
});

test('camapsFxFixture: bolus split fields land as the confirmed-real PERCENTAGE typed fields', () => {
  const fx = camapsFxFixture(T0);
  const timeline = processUnifiedGlookoData(fx.data1);
  const bolus = timeline.find((i) => i.type === 'BOLUS');
  assert.equal(bolus.initialDeliveryPercentage, 60);
  assert.equal(bolus.extendedDeliveryPercentage, 40);
  assert.equal(bolus.durationString, '2h');
  assert.equal(bolus.extra.tooltipData !== undefined, true, 'unmapped fields (e.g. tooltipData) still land in extra');
});

test('camapsFxFixture: CamAPS pump-mode breakdown is present; device names come from data3', () => {
  const fx = camapsFxFixture(T0);
  const breakdown = extractCamapsPumpModeBreakdown(fx.data2);
  assert.ok(breakdown);
  assert.equal(breakdown.automaticPercent, 76);

  const names = extractDeviceNames(fx.data3);
  assert.equal(names.cgm, 'FreeStyle Libre 3');
  assert.equal(names.pump, 'mylife YpsoPump');
});

test('camapsFxFixture: only the CamAPS stats capability is confirmed, gating a get_camaps_pump_mode_breakdown-style check on', () => {
  const fx = camapsFxFixture(T0);
  recordFieldCapabilities('stats', fx.data2, T0);
  assert.equal(isCapabilityConfirmed('stats', 'camapsPumpModeAutomaticPercentage'), true);
});

test('omnipod5Fixture: basal states DO derive, with normal/suspend/limited all present', () => {
  const fx = omnipod5Fixture(T0);
  const states = deriveBasalStates(fx.data1, null, null);
  const byState = new Set(states.map((s) => s.state));
  assert.ok(byState.has('normal'));
  assert.ok(byState.has('suspend'));
  assert.ok(byState.has('limited'));
});

test('omnipod5Fixture: device-change events DO populate (unlike the CamAPS fixture)', () => {
  const fx = omnipod5Fixture(T0);
  const events = extractDeviceEvents(fx.data1);
  assert.equal(events.podChanges.length, 1);
  assert.equal(events.sensorChanges.length, 1);
});

test('omnipod5Fixture: the rarer RAW-DELIVERY split shape stays in extra, not the typed percentage columns', () => {
  const fx = omnipod5Fixture(T0);
  const timeline = processUnifiedGlookoData(fx.data1);
  const bolus = timeline.find((i) => i.type === 'BOLUS');
  assert.equal(bolus.initialDeliveryPercentage, null, 'this device never populates the percentage fields');
  assert.equal(bolus.extendedDeliveryPercentage, null);
  assert.equal(bolus.durationString, null);
  assert.equal(bolus.extra.initialDelivery, 2.1, 'the raw-delivery shape must still be captured, just in extra');
  assert.equal(bolus.extra.extendedDelivery, 1.4);
  assert.equal(bolus.extra.extendedBolusDuration, 120);
  assert.equal(bolus.extra.isUnknownComboBolus, true);
});

test('omnipod5Fixture: no CamAPS pump-mode breakdown exists for this device', () => {
  const fx = omnipod5Fixture(T0);
  assert.equal(extractCamapsPumpModeBreakdown(fx.data2), null);
});

test('omnipod5Fixture: device names resolve to Dexcom/Omnipod, not CamAPS', () => {
  const fx = omnipod5Fixture(T0);
  const names = extractDeviceNames(fx.data3);
  assert.equal(names.cgm, 'Dexcom G6');
  assert.equal(names.pump, 'Omnipod 5');
});

test('omnipod5Fixture: the CamAPS stats capability is correctly NEVER confirmed for this device', () => {
  const fx = omnipod5Fixture(T0);
  recordFieldCapabilities('stats', fx.data2, T0);
  assert.equal(isCapabilityConfirmed('stats', 'camapsPumpModeAutomaticPercentage'), false);
});

test('genericUnknownDeviceFixture: everything device-specific is absent, not guessed at', () => {
  const fx = genericUnknownDeviceFixture(T0);
  assert.deepEqual(deriveBasalStates(fx.data1, null, null), []);
  assert.deepEqual(extractDeviceEvents(fx.data1), { podChanges: [], sensorChanges: [] });
  assert.equal(extractCamapsPumpModeBreakdown(fx.data2), null);

  const names = extractDeviceNames(fx.data3);
  assert.equal(names.cgm, null, 'no cgm device is listed at all for this fixture');
  assert.equal(names.pump, 'Unknown Pump X1', 'falls back to the generic model field when no pumpModel property exists');
});

test('genericUnknownDeviceFixture: a plain manual bolus with no extra fields at all round-trips with extra: null', () => {
  const fx = genericUnknownDeviceFixture(T0);
  const timeline = processUnifiedGlookoData(fx.data1);
  const bolus = timeline.find((i) => i.type === 'BOLUS');
  assert.equal(bolus.extra, null);
  assert.equal(bolus.initialDeliveryPercentage, null);
});
