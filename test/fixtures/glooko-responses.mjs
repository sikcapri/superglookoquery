/**
 * glooko-responses.mjs — hand-built, entirely synthetic raw Glooko response
 * shapes for a few different device combinations, so capability gating,
 * device-specific parsing (deriveBasalStates, extractDeviceEvents,
 * extractDeviceNames), and discovery can all be tested without needing real
 * hardware for every combination (docs/TODO.md's Phase 3 item this exists
 * for). None of this is sampled or derived from any real account.
 *
 * Each fixture has the same top-level shape fetchGlookoRange() actually
 * returns: { data1: { series }, data2, data3 }. `epochStart` lets a test
 * anchor a fixture's timestamps to a real window it's checking.
 *
 * The two named, realistic fixtures are not arbitrary: they're this
 * project's own two confirmed real reference points, deliberately built to
 * disagree with each other on exactly the axes that matter —
 *   - camapsFxFixture: matches this project's real CamAPS FX + Ypso Pump +
 *     Libre 3+ account (see docs/PROMOTION.md/TODO.md's log) — basal-state
 *     bar series and site/sensor-change events genuinely EMPTY (confirmed
 *     against the real account), CamAPS pump-mode stats populated, bolus
 *     split fields as PERCENTAGES.
 *   - omnipod5Fixture: matches the ORIGINAL upstream PodQuery's target
 *     device (Omnipod 5) — the opposite on every one of those axes: basal
 *     states and device events DO populate, no CamAPS stats exist at all,
 *     and bolus split fields use the rarer RAW-DELIVERY shape
 *     (initialDelivery/extendedDelivery/extendedBolusDuration) this
 *     project found once for real and left in `extra`, unpromoted — see
 *     docs/PROMOTION.md's log for why.
 * genericUnknownDeviceFixture is deliberately the opposite of both: no
 * device-specific field anywhere, to confirm nothing guesses at data that
 * was never there.
 */

const DAY = 86400;

export function camapsFxFixture(epochStart) {
  const t0 = epochStart;
  return {
    data1: {
      series: {
        cgmHigh: [],
        cgmLow: [],
        cgmNormal: [
          { x: t0, y: 6.5, mealTag: null, value: 6.5, timestamp: new Date(t0 * 1000).toISOString(), calculated: false },
          { x: t0 + 300, y: 6.7, mealTag: 'breakfast', value: 6.7, timestamp: new Date((t0 + 300) * 1000).toISOString(), calculated: false },
        ],
        cgmDeviceDataBrand: '', // confirmed blank for this real account -- CGM device name comes from data3 instead
        deliveredBolus: [
          {
            x: t0 + 60, y: 4, isManual: false, carbsInput: 40,
            insulinRecommendationForCorrection: 0, isOverrideAbove: false, isOverrideBelow: false,
            insulinDelivered: 4, insulinProgrammed: 4, isInterrupted: false,
            totalInsulinRecommendation: 4, insulinRecommendationForCarbs: 4,
            insulinOnBoard: 0.5, bloodGlucoseInput: null, bloodGlucoseInputSource: null,
            initialDeliveryPercentage: 60, extendedDeliveryPercentage: 40, durationString: '2h',
            highestBolusValue: 4, type: 'normal', group: 'meal', tooltipData: { raw: 'nested, unsupported' },
            deviceName: 'CamDiab CamAPS FX',
          },
        ],
        // Confirmed genuinely empty for this real account -- Omnipod-5-only
        // series, never populated by CamAPS's own Glooko integration.
        setSiteChange: [],
        cgmSensorChange: [],
        basalBarAutomated: [],
        basalBarAutomatedMax: [],
        basalBarAutomatedSuspend: [],
        dailyInsulinTotals: {
          [t0]: { basalUnitsPerDay: 18, bolusUnitsPerDay: 20, totalInsulinPerDay: 38 },
        },
      },
    },
    data2: {
      stdDev: 1.2, median: 6.8,
      camapsPumpModeDurationString: '30d 0h',
      camapsPumpModeAutomaticPercentage: 76,
      camapsPumpModeManualPercentage: 0,
      camapsPumpModeEaseOffPercentage: 2,
      camapsPumpModeBoostPercentage: 5,
      camapsPumpModeLibertyPercentage: 0,
      camapsPumpModeAttemptingPercentage: 24,
      camapsPumpModePerModeDurationStrings: { automatic: '22d 19h' },
    },
    data3: {
      devices: [
        { type: 'cgm', deviceClassification: 'cgm_device', properties: { cgmModel: 'FreeStyle Libre 3' }, brand: 'CamDiab', model: 'CamAPS FX', serialNumber: 'FAKE-SERIAL-NOT-REAL' },
        { type: 'pump', deviceClassification: 'pump', properties: { pumpModel: 'mylife YpsoPump' }, brand: 'CamDiab', model: 'CamAPS FX', serialNumber: 'FAKE-SERIAL-NOT-REAL' },
      ],
      deviceSettings: { pumps: {} },
    },
  };
}

export function omnipod5Fixture(epochStart) {
  const t0 = epochStart;
  return {
    data1: {
      series: {
        cgmHigh: [],
        cgmLow: [],
        cgmNormal: [
          { x: t0, y: 7.1 },
          { x: t0 + 300, y: 7.4 },
        ],
        deliveredBolus: [
          {
            x: t0 + 60, y: 3.5, isManual: false, carbsInput: 35,
            insulinRecommendationForCorrection: 0, isOverrideAbove: false, isOverrideBelow: false,
            insulinDelivered: 3.5, insulinProgrammed: 3.5, isInterrupted: false,
            totalInsulinRecommendation: 3.5, insulinRecommendationForCarbs: 3.5,
            insulinOnBoard: 0.2, bloodGlucoseInput: null, bloodGlucoseInputSource: null,
            // The rarer RAW-DELIVERY split shape (not percentages) -- a real
            // shape this project found once and left unpromoted in `extra`.
            initialDelivery: 2.1, extendedDelivery: 1.4, extendedBolusDuration: 120,
            isUnknownComboBolus: true,
          },
        ],
        // Omnipod-5-specific: bar-state series and device-change events DO
        // populate for this device, unlike CamAPS above.
        setSiteChange: [{ x: t0 - DAY }],
        cgmSensorChange: [{ x: t0 - 3 * DAY }],
        basalBarAutomated: [
          { x: t0, y: 1 },
          { x: t0 + 3600, y: 0 },
        ],
        basalBarAutomatedMax: [],
        basalBarAutomatedSuspend: [
          { x: t0 + 3600, y: 1 },
          { x: t0 + 3900, y: 0 },
        ],
        pumpOp5LimitedMode: [
          { timestamp: new Date((t0 + 7200) * 1000).toISOString(), endTimestamp: new Date((t0 + 7200 + 1800) * 1000).toISOString() },
        ],
        dailyInsulinTotals: {
          [t0]: { basalUnitsPerDay: 20, bolusUnitsPerDay: 15, totalInsulinPerDay: 35 },
        },
      },
    },
    data2: {
      stdDev: 1.5, median: 7.2,
      // No camapsPumpMode* fields anywhere -- this is not a CamAPS device.
    },
    data3: {
      devices: [
        { type: 'cgm', deviceClassification: 'cgm_device', properties: { cgmModel: 'Dexcom G6' }, brand: 'Dexcom', model: 'G6', serialNumber: 'FAKE-SERIAL-NOT-REAL' },
        { type: 'pump', deviceClassification: 'pump', properties: { pumpModel: 'Omnipod 5' }, brand: 'Insulet', model: 'Omnipod 5', serialNumber: 'FAKE-SERIAL-NOT-REAL' },
      ],
      deviceSettings: { pumps: {} },
    },
  };
}

/** No device-specific field anywhere -- a hypothetical brand-new/unsupported
 * combo, to confirm nothing here guesses at data that was never present. */
export function genericUnknownDeviceFixture(epochStart) {
  const t0 = epochStart;
  return {
    data1: {
      series: {
        cgmHigh: [], cgmLow: [],
        cgmNormal: [{ x: t0, y: 6.0 }],
        deliveredBolus: [
          {
            x: t0 + 60, y: 2, isManual: true, carbsInput: 0,
            insulinRecommendationForCorrection: 0, isOverrideAbove: false, isOverrideBelow: false,
            insulinDelivered: 2, insulinProgrammed: 2, isInterrupted: false,
          },
        ],
        dailyInsulinTotals: { [t0]: { basalUnitsPerDay: 15, bolusUnitsPerDay: 10, totalInsulinPerDay: 25 } },
      },
    },
    data2: { stdDev: 1.0, median: 6.0 },
    data3: {
      devices: [{ type: 'pump', deviceClassification: 'pump', model: 'Unknown Pump X1' }],
      deviceSettings: { pumps: {} },
    },
  };
}
