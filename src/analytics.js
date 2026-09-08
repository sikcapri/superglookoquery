/**
 * analytics.js — the clinical maths and data shaping.
 *
 * This is the heart of PodQuery. It takes raw Glooko data (and rows read back
 * from the archive) and turns it into the summaries, trends, logs and metrics
 * the tools return. There is no I/O here: functions take data in and return
 * plain objects out, which keeps the maths easy to test in isolation.
 *
 * A few invariants are worth knowing before reading on, because they explain
 * choices that would otherwise look odd:
 *
 *  - Glucose is stored and computed internally in ONE canonical unit, mmol/L.
 *    Incoming data is normalised to mmol at ingest (see normaliseIncoming and
 *    GLOOKO_GLUCOSE_UNIT); outgoing values are converted to the caller's chosen
 *    display unit at the very end (see toDisplay / toDisplayDelta). Nothing in
 *    between has to think about units.
 *
 *  - Bolus insulin is always aggregated from individual stored events. Basal is
 *    only ever taken from Glooko's per-day totals (there is no per-event basal
 *    stream). The two are never blended into a single figure computed two ways.
 *
 *  - Time is plain WALL CLOCK time throughout, NOT true UTC. Glooko records only
 *    the literal date/time the patient's device displayed when a reading was
 *    taken, with no timezone or offset attached, so a reading is stamped with
 *    wherever the patient physically was at that moment — see prompt.js's TIME
 *    ZONES section for the full rationale. Internally this module still uses
 *    the UTC getters/setters (getUTCHours, Date.UTC, etc.) on every epoch, but
 *    only as a mechanical trick to read back the exact digits an epoch was
 *    built from without the host machine's own local timezone silently
 *    shifting them — it is NOT claiming, and must never be read as claiming,
 *    that these instants are true UTC. Day grouping and hour-of-day buckets
 *    are therefore wall-clock day/hour, which is exactly what a clinical
 *    reading of "midnight" or "7am" should mean. No conversion of any kind is
 *    applied at ingest, storage, or output — emitted ISO 8601 timestamps keep
 *    a trailing "Z" purely for wire-format parseability, not as a UTC claim.
 *
 *  - Per-day RATES use the real decimal span of observed data (observedDaySpan),
 *    not a calendar day count, so they are correct regardless of where a window
 *    falls.
 */

// Exact mmol/L <-> mg/dL conversion factor. Used both for normalising incoming
// data and for converting outgoing values to the display unit. Exported so
// server.js can convert a THRESHOLD (not a reading) between units when a
// caller overrides the display unit for one call without also overriding the
// threshold — see resolveThresholdInputs() there.
export const MGDL_PER_MMOL = 18.0182;


// --- unit handling --------------------------------------------------------
// Two separate concerns: normalising INCOMING data to canonical mmol at ingest
// (driven by GLOOKO_GLUCOSE_UNIT, the source account's unit), and converting
// OUTGOING values to the caller's chosen display unit. Storage is always mmol.

/**
 * The unit Glooko delivers glucose in, which depends on how the user configured
 * their Glooko account (US accounts typically mg/dL, others mmol/L). This is the
 * SOURCE unit for incoming data and is SEPARATE from OMNI_UNITS (how the user
 * wants to SEE their data). Set GLOOKO_GLUCOSE_UNIT to match the Glooko account.
 * Defaults to mmol when unset. Anything other than "mgdl" is treated as mmol.
 */
function glookoSourceUnit() {
  const u = (process.env.GLOOKO_GLUCOSE_UNIT || 'mmol').trim().toLowerCase();
  return u === 'mgdl' ? 'mgdl' : 'mmol';
}

/**
 * Normalise an incoming ABSOLUTE glucose value (a reading, target, or BG input)
 * from the Glooko source unit to the canonical internal unit (mmol/L). Storage
 * is always mmol; the display layer converts back out per OMNI_UNITS. Null-safe.
 */
function normaliseIncoming(value, sourceUnit = glookoSourceUnit()) {
  if (value == null || !Number.isFinite(value)) return value;
  return sourceUnit === 'mgdl' ? value / MGDL_PER_MMOL : value;
}

/**
 * Normalise an incoming glucose DELTA (e.g. ISF, a glucose drop per unit of
 * insulin) from the source unit to mmol. A delta scales by the factor with no
 * offset. Null-safe.
 */
function normaliseIncomingDelta(value, sourceUnit = glookoSourceUnit()) {
  if (value == null || !Number.isFinite(value)) return value;
  return sourceUnit === 'mgdl' ? value / MGDL_PER_MMOL : value;
}

/**
 * Convert user-supplied limits into mmol/L thresholds.
 * units: 'mmol' | 'mgdl'. lower/upper are in the chosen unit.
 */
export function getThresholds(units, lower, upper) {
  let low = parseFloat(lower);
  let high = parseFloat(upper);
  if (units === 'mgdl') {
    low /= MGDL_PER_MMOL;
    high /= MGDL_PER_MMOL;
  }
  return { low, high };
}

/**
 * Convert a stored glucose VALUE (always mmol/L internally) to the display unit.
 * mg/dL is rounded to a whole number (clinical convention); mmol/L keeps the
 * requested decimals (1 by default). Returns null for null/undefined input.
 * Use this at EVERY point a glucose value leaves a tool, so output always
 * matches the user's chosen unit.
 */
export function toDisplay(mmolValue, units, decimals = 1) {
  if (mmolValue == null || !Number.isFinite(mmolValue)) return null;
  if (units === 'mgdl') return Math.round(mmolValue * MGDL_PER_MMOL);
  return +mmolValue.toFixed(decimals);
}

/**
 * Convert a glucose DIFFERENCE/spread (e.g. a standard deviation, or a median
 * deviation from target) to the display unit. A delta scales by the factor but
 * has NO offset, so it must not go through toDisplay (which is for absolute
 * points). mg/dL deltas are rounded to whole numbers, mmol keeps decimals.
 */
export function toDisplayDelta(mmolDelta, units, decimals = 2) {
  if (mmolDelta == null || !Number.isFinite(mmolDelta)) return null;
  if (units === 'mgdl') return Math.round(mmolDelta * MGDL_PER_MMOL);
  return +mmolDelta.toFixed(decimals);
}

export function calculateTIRMetrics(bgValues, thresholds) {
  if (!bgValues?.length) return { tir: 0, low: 0, high: 0 };
  const { low, high } = thresholds;
  const inRange = bgValues.filter((v) => v >= low && v <= high).length;
  const lowCount = bgValues.filter((v) => v < low).length;
  const highCount = bgValues.filter((v) => v > high).length;
  return {
    tir: (inRange / bgValues.length) * 100,
    low: (lowCount / bgValues.length) * 100,
    high: (highCount / bgValues.length) * 100,
  };
}

/**
 * Extracts chronological pump-setting changes active within a window.
 * startDate / endDate are epoch milliseconds.
 */
export function getActiveSettings(json, startDate, endDate) {
  if (!json?.deviceSettings?.pumps) return [];
  const startEpoch = new Date(startDate).getTime();
  const endEpoch = new Date(endDate).getTime();
  const pumps = json.deviceSettings.pumps;
  let flatHistory = [];

  Object.keys(pumps).forEach((guid) => {
    Object.keys(pumps[guid]).forEach((ts) => {
      flatHistory.push({
        timestamp: ts,
        epoch: new Date(ts).getTime(),
        data: pumps[guid][ts],
      });
    });
  });

  flatHistory.sort((a, b) => a.epoch - b.epoch);
  const baselineIdx = flatHistory.findLastIndex((s) => s.epoch <= startEpoch);
  const startIndex = baselineIdx !== -1 ? baselineIdx : 0;

  // Glooko returns the bolus-profile glucose values (target, ISF) in the user's
  // Glooko account unit. Normalise them to canonical mmol at ingest so stored
  // settings match the stored CGM/bolus values. Target is an absolute glucose
  // value; ISF is a glucose delta per unit of insulin.
  const srcUnit = glookoSourceUnit();
  const normaliseSettingsData = (data) => {
    if (srcUnit !== 'mgdl' || !data?.profilesBolus) return data;
    const profiles = data.profilesBolus.map((profile) => {
      const p = { ...profile };
      if (p.targetBgSegments?.data) {
        p.targetBgSegments = {
          ...p.targetBgSegments,
          data: p.targetBgSegments.data.map((sn) => ({
            ...sn,
            value: normaliseIncoming(sn.value, srcUnit),
          })),
        };
      }
      if (p.isfSegments?.data) {
        p.isfSegments = {
          ...p.isfSegments,
          data: p.isfSegments.data.map((sn) => ({
            ...sn,
            value: normaliseIncomingDelta(sn.value, srcUnit),
          })),
        };
      }
      return p;
    });
    return { ...data, profilesBolus: profiles };
  };

  return flatHistory
    .slice(startIndex)
    .filter((item) => item.epoch <= endEpoch)
    .map((item) => ({
      activeTimestamp: item.timestamp,
      settings: normaliseSettingsData(item.data),
    }));
}

// --- ingest: raw Glooko JSON -> normalised records ------------------------

/**
 * Unifies CGM and bolus events into a single sorted timeline.
 * CGM points are de-duplicated into 5-minute buckets and tagged with velocity.
 * Boluses are categorised (meal / manual correction / system correction / meal+correction).
 * Incoming glucose values are normalised to canonical mmol/L here, at ingest.
 */
export function processUnifiedGlookoData(rawJson) {
  const series = (rawJson && rawJson.series) || {};
  const allCgm = [
    ...(series.cgmHigh || []),
    ...(series.cgmNormal || []),
    ...(series.cgmLow || []),
  ].sort((a, b) => a.x - b.x);

  const cleanCgm = [];
  // Keyed by 5-minute bucket -> the set of raw y-values already kept in it.
  // This collapses a TRUE duplicate (the identical reading reported more than
  // once, e.g. present in both cgmNormal and cgmHigh near a threshold
  // crossing) exactly as before. It deliberately does NOT collapse two
  // DIFFERENT values landing in the same bucket: Glooko's timestamps are
  // plain wall-clock digits with no timezone attached (see this file's top
  // comment), so on a "fall back" clock-change day two genuinely different
  // real readings an hour apart can carry the identical epoch (same bucket,
  // almost certainly a different glucose value). A bucket- or epoch-keyed
  // Set that kept only the first point per bucket used to silently discard
  // the second of that pair, permanently losing real data once a year, every
  // fall-back day. Both are now kept as distinct rows (see store.js's
  // (epoch, seq) primary key for how they're persisted without colliding).
  const seenByBucket = new Map();
  const srcUnit = glookoSourceUnit();

  allCgm.forEach((p) => {
    const bucket = Math.floor(p.x / 300) * 300;
    let seenYs = seenByBucket.get(bucket);
    if (!seenYs) {
      seenYs = new Set();
      seenByBucket.set(bucket, seenYs);
    }
    if (!seenYs.has(p.y)) {
      seenYs.add(p.y);
      // Normalise the incoming reading to canonical mmol BEFORE deriving
      // velocity, so velocity (a difference of readings) is correct too.
      const valMmol = normaliseIncoming(p.y, srcUnit);
      let vel =
        cleanCgm.length > 0
          ? parseFloat((valMmol - cleanCgm[cleanCgm.length - 1].val).toFixed(2))
          : 0;
      cleanCgm.push({
        epoch: p.x,
        type: 'CGM',
        val: valMmol,
        vel,
        extra: captureExtra(p, CGM_KNOWN_KEYS),
        time: new Date(p.x * 1000).toISOString(),
      });
    }
  });

  const boluses = (series.deliveredBolus || []).map((b) => {
    let cat = 'Unknown';
    if (!b.isManual && b.carbsInput > 0 && b.insulinRecommendationForCorrection === 0)
      cat = 'Meal Bolus';
    else if (b.isManual && b.carbsInput === 0) cat = 'Manual Correction Bolus';
    else if (
      !b.isManual &&
      b.carbsInput === 0 &&
      b.insulinRecommendationForCorrection > 0
    )
      cat = 'System Correction Bolus';
    else if (
      !b.isManual &&
      b.carbsInput > 0 &&
      b.insulinRecommendationForCorrection > 0
    )
      cat = 'Meal With Correction Bolus';
    // Override direction: the device flags when the programmed dose was pushed
    // above or below the algorithm's recommendation.
    const override = b.isOverrideAbove
      ? 'above'
      : b.isOverrideBelow
        ? 'below'
        : null;
    const delivered = numOrNull(b.insulinDelivered);
    const programmed = numOrNull(b.insulinProgrammed);
    // Interrupted if the device says so, OR delivered fell short of programmed
    // (a partial delivery means the bolus was cut off mid-way).
    const interrupted =
      b.isInterrupted === true ||
      (delivered != null && programmed != null && delivered < programmed - 1e-9);
    return {
      epoch: b.x,
      type: 'BOLUS',
      // 'units' kept as the canonical amount = what was actually DELIVERED, so
      // existing analytics (totals, carb ratios, charts) stay correct even when
      // a bolus was interrupted. Falls back to b.y if delivered is missing.
      units: delivered != null ? delivered : b.y,
      delivered,
      programmed,
      recTotal: numOrNull(b.totalInsulinRecommendation),
      recCorrection: numOrNull(b.insulinRecommendationForCorrection),
      recCarbs: numOrNull(b.insulinRecommendationForCarbs),
      carbs: b.carbsInput,
      iob: b.insulinOnBoard,
      bgInput: normaliseIncoming(numOrNull(b.bloodGlucoseInput), srcUnit),
      bgSource: b.bloodGlucoseInputSource ?? null,
      isManual: b.isManual === true,
      interrupted,
      override,
      class: cat,
      // Split/extended-delivery fields — promoted from `extra` under
      // PROMOTION.md's bootstrap exception (SCHEMA_VERSION 9). A real sync
      // of this account confirmed the common-case field names are
      // initialDeliveryPercentage/extendedDeliveryPercentage/durationString
      // (a string, e.g. "2h") — Glooko reports the split as a percentage
      // pair directly, not raw delivered units. A SEPARATE, rarer bolus
      // shape (co-occurring with a real `isUnknownComboBolus` flag) instead
      // carries initialDelivery/extendedDelivery/extendedBolusDuration —
      // the exact names this fork's original SCHEMA_VERSION 8 promotion
      // guessed, which happened to be real but for the wrong (much rarer)
      // case, and so barely ever populated. That second shape is left in
      // `extra` for now rather than promoted alongside this one — see
      // PROMOTION.md's log for the full account and the follow-up.
      initialDeliveryPercentage: numOrNull(b.initialDeliveryPercentage),
      extendedDeliveryPercentage: numOrNull(b.extendedDeliveryPercentage),
      durationString: b.durationString ?? null,
      extra: captureExtra(b, BOLUS_KNOWN_KEYS),
      time: new Date(b.x * 1000).toISOString(),
    };
  });

  return [...cleanCgm, ...boluses].sort((a, b) => a.epoch - b.epoch);
}

/**
 * Circadian distribution: aggregate TIR / average glucose by clock-hour.
 */
export function calculateHourly(timeline, thresholds, units = 'mmol') {
  const hourly = {};
  const cgm = timeline.filter((i) => i.type === 'CGM');
  if (!cgm.length) return [];
  cgm.forEach((p) => {
    const h = new Date(p.epoch * 1000).getUTCHours();
    if (!hourly[h]) hourly[h] = [];
    hourly[h].push(p.val);
  });
  return Object.keys(hourly)
    .map((h) => {
      const metrics = calculateTIRMetrics(hourly[h], thresholds);
      return {
        hour: h.padStart(2, '0') + ':00',
        hourNum: parseInt(h, 10),
        avg: toDisplay(
          hourly[h].reduce((a, b) => a + b, 0) / hourly[h].length,
          units
        ),
        tir: +metrics.tir.toFixed(2),
        low: +metrics.low.toFixed(2),
        high: +metrics.high.toFixed(2),
        readings: hourly[h].length,
      };
    })
    .sort((a, b) => a.hourNum - b.hourNum);
}

/**
 * Metabolic state (interpolated BG) at an arbitrary epoch.
 * Returns null if the nearest CGM points straddle a gap > 10 minutes.
 */
export function getInterpolatedBG(targetEpoch, timeline) {
  const cgm = timeline.filter((i) => i.type === 'CGM');
  const before = [...cgm].reverse().find((i) => i.epoch <= targetEpoch);
  const after = cgm.find((i) => i.epoch > targetEpoch);
  if (!before || !after || after.epoch - before.epoch > 600)
    return before?.val || after?.val || null;
  const weight = (targetEpoch - before.epoch) / (after.epoch - before.epoch);
  return parseFloat((before.val + weight * (after.val - before.val)).toFixed(2));
}

/**
 * Finds the active setting value for a clock-hour from time-segmented data.
 */
export function findActiveDataRecord(data, epoch) {
  const h = new Date(epoch * 1000).getUTCHours();
  const sorted = [...data].sort((a, b) => a.segmentStart - b.segmentStart);
  const active = sorted.findLast((s) => s.segmentStart <= h);
  return active ? active.value : sorted[sorted.length - 1].value;
}

export const formatHour = (h) =>
  `${Math.floor(h)}:${h % 1 === 0.5 ? '30' : '00'}`;

/**
 * Builds the enriched bolus log: each bolus matched with interpolated BG at
 * delivery plus the ISF / CR / target / DIA in force at that moment.
 * This is downloadSubset('bolus') from the browser, as a pure function.
 */
export function buildEnrichedBolusLog(timeline, settingsHistory, units = 'mmol') {
  return timeline
    .filter((i) => i.type === 'BOLUS')
    .map((bolus) => {
      const activeSetting = settingsHistory.findLast(
        (s) => new Date(s.activeTimestamp).getTime() / 1000 <= bolus.epoch
      );
      const context = activeSetting
        ? {
            DIA: activeSetting.settings.generalSettings.activeInsulinTime,
            target: toDisplay(
              findActiveDataRecord(
                activeSetting.settings.profilesBolus[0].targetBgSegments.data,
                bolus.epoch
              ),
              units
            ),
            // ISF is a glucose drop per unit of insulin, so it scales like a
            // glucose delta (factor, no offset).
            isf: toDisplayDelta(
              findActiveDataRecord(
                activeSetting.settings.profilesBolus[0].isfSegments.data,
                bolus.epoch
              ),
              units
            ),
            active_cr: findActiveDataRecord(
              activeSetting.settings.profilesBolus[0].insulinToCarbRatioSegments
                .data,
              bolus.epoch
            ),
          }
        : null;
      return {
        ...bolus,
        // bgInput (the calculator's BG input) is a glucose value stored in mmol.
        bgInput: toDisplay(bolus.bgInput, units),
        cgm_val: toDisplay(getInterpolatedBG(bolus.epoch, timeline), units),
        context,
      };
    });
}

/**
 * Split/extended-delivery bolus log — the original motivating question for
 * this fork, now that initialDeliveryPercentage/extendedDeliveryPercentage/
 * durationString are typed columns (docs/PROMOTION.md's bootstrap promotion,
 * SCHEMA_VERSION 9), not buried in `extra`. Confirmed against a real sync of
 * this account — Glooko already reports the split as a percentage pair
 * directly, not as raw delivered units to derive a percentage from.
 *
 * A bolus counts as "split" here when it has a real, positive
 * extendedDeliveryPercentage — a normal (non-split) bolus naturally has it
 * null/0, which isn't an error, just "wasn't split," so `> 0` alone (true
 * for neither null nor undefined) is the whole filter.
 *
 * durationString is Glooko's own raw formatted text (e.g. "2h") — passed
 * through as-is, not parsed into minutes/seconds, since no confirmed format
 * spec exists yet for it across devices.
 */
export function buildSplitBolusLog(timeline) {
  return timeline
    .filter((i) => i.type === 'BOLUS' && i.extendedDeliveryPercentage > 0)
    .map((b) => ({
      time: b.time,
      class: b.class,
      totalDelivered: b.delivered,
      initialDeliveryPercent: b.initialDeliveryPercentage,
      extendedDeliveryPercent: b.extendedDeliveryPercentage,
      durationString: b.durationString,
    }));
}

/** Aggregate stats over a split-bolus log against the full bolus population
 * it was drawn from — how often splitting happens, not just the individual
 * events. `splitLog` must be `buildSplitBolusLog(timeline)`'s own output. */
export function summariseSplitBolusStats(timeline, splitLog) {
  const totalBoluses = timeline.filter((i) => i.type === 'BOLUS').length;
  const splitCount = splitLog.length;
  const avg = (values) => (values.length ? values.reduce((s, v) => s + v, 0) / values.length : null);
  return {
    totalBoluses,
    splitCount,
    splitRatePercent: totalBoluses > 0 ? Math.round((splitCount / totalBoluses) * 1000) / 10 : 0,
    avgInitialDeliveryPercent: avg(splitLog.map((s) => s.initialDeliveryPercent).filter((v) => v != null)),
  };
}

// Confirmed 2026-09-09 against a real sync of this account: these live in
// Glooko's per-window stats blob (`data2`, called `stats` below), not in any
// per-record cgm/bolus field — a fundamentally different shape from
// everything else this file captures via `extra`. `data2` is Glooko's own
// pre-aggregated figure for whatever window was requested, computed
// server-side; it is NOT archived anywhere in this project (see range.js's
// getProcessedRange, which always returns stats: null by design), so a
// CamAPS pump-mode tool must fetch it live rather than read the local
// archive. See DESIGN.md/PROMOTION.md for the fuller account.
export const CAMAPS_PUMP_MODE_KEYS = [
  'camapsPumpModeDurationString',
  'camapsPumpModeAutomaticPercentage',
  'camapsPumpModeManualPercentage',
  'camapsPumpModeEaseOffPercentage',
  'camapsPumpModeBoostPercentage',
  'camapsPumpModeLibertyPercentage',
  'camapsPumpModeAttemptingPercentage',
  'camapsPumpModePerModeDurationStrings',
];

/**
 * Pull the CamAPS pump-mode breakdown out of a raw `stats` (Glooko's data2)
 * blob, or null if this account's data has none of these fields populated
 * (a non-CamAPS pump, or CamAPS data Glooko hasn't computed for this
 * window) — genuinely absent, not a record of all zeros. A real zero for
 * one mode (e.g. this account never uses "liberty" mode) still counts as
 * populated, per `isPopulatedValue`'s "0 and false are data" rule; only
 * null/undefined fields are absent.
 *
 * Percentages are Glooko's own figures and are not guaranteed to sum to
 * 100 — "attempting" appears to overlap with "automatic" in practice
 * rather than being a disjoint category, so treat each percentage
 * independently rather than assuming a clean partition.
 */
export function extractCamapsPumpModeBreakdown(stats) {
  if (!stats) return null;
  // Local copy of store.js's isPopulatedValue rule (0/false count, null/
  // undefined/NaN/empty-string don't) — this file deliberately has no
  // imports (see its header comment), so the tiny check is duplicated
  // rather than pulled in across that boundary.
  const isPopulated = (v) => v !== null && v !== undefined && !(typeof v === 'number' && Number.isNaN(v));
  const hasAny = CAMAPS_PUMP_MODE_KEYS.some((k) => isPopulated(stats[k]));
  if (!hasAny) return null;
  return {
    durationCovered: stats.camapsPumpModeDurationString ?? null,
    automaticPercent: numOrNull(stats.camapsPumpModeAutomaticPercentage),
    manualPercent: numOrNull(stats.camapsPumpModeManualPercentage),
    easeOffPercent: numOrNull(stats.camapsPumpModeEaseOffPercentage),
    boostPercent: numOrNull(stats.camapsPumpModeBoostPercentage),
    libertyPercent: numOrNull(stats.camapsPumpModeLibertyPercentage),
    attemptingPercent: numOrNull(stats.camapsPumpModeAttemptingPercentage),
    perModeDurations: stats.camapsPumpModePerModeDurationStrings ?? null,
  };
}

/**
 * Computes the full aggregate summary for a window: the glucose-control,
 * insulin-delivery, bolus-architecture, best/worst day and hour figures that
 * formatHeader assembled in the browser. Returned as structured data rather
 * than a formatted string, so the model can reason over it directly.
 *
 * stats is Glooko's data2 (statistics/overall) blob.
 */
/**
 * The glucose target in force for a single reading: resolves BOTH the settings
 * VERSION active at that timestamp (settings change over weeks) AND the target
 * SEGMENT active at that reading's clock-hour (the PDM can set different targets
 * per hour). Returns null if no settings/target can be resolved for it.
 */
export function targetForEpoch(epoch, settingsHistory) {
  if (!settingsHistory || !settingsHistory.length) return null;
  const activeSetting = settingsHistory.findLast(
    (s) => new Date(s.activeTimestamp).getTime() / 1000 <= epoch
  );
  const segs =
    activeSetting?.settings?.profilesBolus?.[0]?.targetBgSegments?.data;
  if (!segs || !segs.length) return null;
  return findActiveDataRecord(segs, epoch);
}

/** Median of a numeric array (returns null for empty). */
function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Ranking metrics for a set of CGM points (each {epoch, val}). Used to compare
 * days or clock-hours decisively: TIR first, then closeness to the per-reading
 * target (median absolute deviation, robust to single spikes), then variability
 * (CV). Each reading is compared to the target IN FORCE at its own timestamp, so
 * hourly target profiles are honoured automatically; a whole-day single target
 * collapses to the same number. medianAbsTargetDev is null when no target can be
 * resolved (e.g. settings history missing), and ranking then falls back to CV.
 */
export function rankingMetrics(points, thresholds, settingsHistory) {
  const vals = points.map((p) => p.val);
  const tir = +calculateTIRMetrics(vals, thresholds).tir.toFixed(2);

  const devs = [];
  for (const p of points) {
    const tgt = targetForEpoch(p.epoch, settingsHistory);
    if (tgt != null) devs.push(Math.abs(p.val - tgt));
  }
  const med = median(devs);
  const medianAbsTargetDev = med == null ? null : +med.toFixed(2);

  let cv = null;
  if (vals.length) {
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    if (avg > 0) {
      const sd = Math.sqrt(
        vals.map((v) => (v - avg) ** 2).reduce((a, b) => a + b, 0) / vals.length
      );
      cv = +((sd / avg) * 100).toFixed(2);
    }
  }
  return { tir, medianAbsTargetDev, cv };
}

/**
 * Compares two ranking-metric objects. Returns >0 if A is BETTER than B, <0 if
 * worse, 0 if indistinguishable. Better = higher TIR, then lower median target
 * deviation (closer to target), then lower CV (steadier). Nulls sort last so a
 * day with a computable deviation beats one without.
 */
function compareRanking(a, b) {
  if (a.tir !== b.tir) return a.tir - b.tir; // higher TIR better
  // lower median target deviation better; null (unknown) is worse
  const ad = a.medianAbsTargetDev, bd = b.medianAbsTargetDev;
  if (ad != null && bd != null && ad !== bd) return bd - ad;
  if (ad == null && bd != null) return -1;
  if (ad != null && bd == null) return 1;
  // lower CV better; null worse
  const ac = a.cv, bc = b.cv;
  if (ac != null && bc != null && ac !== bc) return bc - ac;
  if (ac == null && bc != null) return -1;
  if (ac != null && bc == null) return 1;
  return 0;
}

// --- window summary (the get_diabetes_summary aggregator) -----------------

export function computeSummary(
  timeline,
  stats,
  settingsHistory,
  thresholds,
  unitLabel,
  statsScope = 'exact', // 'exact' | 'wider': whether stats match the timeline window
  dailyInsulin = null // per-day basal/bolus/total records for the window, if available
) {
  // Display unit code derived from the label. All stored values are mmol/L;
  // every glucose value emitted below is converted to this unit via toDisplay
  // (absolute points) or toDisplayDelta (spreads/deviations).
  const units = unitLabel === 'mg/dL' ? 'mgdl' : 'mmol';
  const cgmVals = timeline.filter((i) => i.type === 'CGM').map((i) => i.val);

  const reportStart = timeline.length
    ? new Date(timeline[0].epoch * 1000).toISOString()
    : null;
  const reportEnd = timeline.length
    ? new Date(timeline[timeline.length - 1].epoch * 1000).toISOString()
    : null;
  const days =
    timeline.length > 1
      ? (timeline[timeline.length - 1].epoch - timeline[0].epoch) / 86400
      : 0;

  let avg = 0,
    std = 0,
    cv = 0,
    gmi = 0,
    tir = { tir: 0, low: 0, high: 0 };
  if (cgmVals.length) {
    avg = cgmVals.reduce((a, b) => a + b, 0) / cgmVals.length;
    std = Math.sqrt(
      cgmVals.map((v) => Math.pow(v - avg, 2)).reduce((a, b) => a + b, 0) /
        cgmVals.length
    );
    cv = (std / avg) * 100;
    tir = calculateTIRMetrics(cgmVals, thresholds);
    gmi = +(3.31 + 0.02392 * (avg * MGDL_PER_MMOL)).toFixed(2);
  }

  // Best / worst day by TIR
  // Best / worst day. Ranked decisively: TIR, then closeness to the target in
  // force per reading (median absolute deviation, hour-aware), then CV. Keep
  // full {epoch,val} points so each reading's target can be resolved.
  const dailyPts = {};
  timeline
    .filter((i) => i.type === 'CGM')
    .forEach((p) => {
      const k = new Date(p.epoch * 1000).toISOString().split('T')[0];
      (dailyPts[k] = dailyPts[k] || []).push({ epoch: p.epoch, val: p.val });
    });
  let bestD = null;
  let worstD = null;
  let bestDM = null;
  let worstDM = null;
  Object.keys(dailyPts).forEach((k) => {
    const m = rankingMetrics(dailyPts[k], thresholds, settingsHistory);
    if (bestDM === null || compareRanking(m, bestDM) > 0) {
      bestDM = m;
      bestD = { day: k, tir: m.tir, medianAbsTargetDev: toDisplayDelta(m.medianAbsTargetDev, units), cv: m.cv };
    }
    if (worstDM === null || compareRanking(m, worstDM) < 0) {
      worstDM = m;
      worstD = { day: k, tir: m.tir, medianAbsTargetDev: toDisplayDelta(m.medianAbsTargetDev, units), cv: m.cv };
    }
  });
  if (!bestD) bestD = { day: 'N/A', tir: 0, medianAbsTargetDev: null, cv: null };
  if (!worstD) worstD = { day: 'N/A', tir: 0, medianAbsTargetDev: null, cv: null };

  // Best / worst hour (recurring clock-hour, pooled across all days). Same
  // decisive ranking, and per-reading target lookup means each clock-hour is
  // judged against the target set for THAT hour in the PDM.
  const hourly = calculateHourly(timeline, thresholds);
  const hourlyPts = {};
  timeline
    .filter((i) => i.type === 'CGM')
    .forEach((p) => {
      const h = new Date(p.epoch * 1000).getUTCHours();
      (hourlyPts[h] = hourlyPts[h] || []).push({ epoch: p.epoch, val: p.val });
    });
  let bestH = null;
  let worstH = null;
  let bestHM = null;
  let worstHM = null;
  Object.keys(hourlyPts).forEach((h) => {
    const m = rankingMetrics(hourlyPts[h], thresholds, settingsHistory);
    const label = String(h).padStart(2, '0') + ':00';
    if (bestHM === null || compareRanking(m, bestHM) > 0) {
      bestHM = m;
      bestH = { hour: label, tir: m.tir, medianAbsTargetDev: toDisplayDelta(m.medianAbsTargetDev, units), cv: m.cv };
    }
    if (worstHM === null || compareRanking(m, worstHM) < 0) {
      worstHM = m;
      worstH = { hour: label, tir: m.tir, medianAbsTargetDev: toDisplayDelta(m.medianAbsTargetDev, units), cv: m.cv };
    }
  });
  if (!bestH) bestH = { hour: 'N/A', tir: 0, medianAbsTargetDev: null, cv: null };
  if (!worstH) worstH = { hour: 'N/A', tir: 0, medianAbsTargetDev: null, cv: null };

  // Highest / lowest glucose readings in the window, WITH timestamps. If a peak
  // or trough value occurs more than once, every instance is returned (e.g. four
  // separate readings of 17.9 all come back). CGM values are quantised to 0.1
  // mmol/L, so an exact-equality match (with a tiny epsilon for float safety) on
  // the rounded value reliably groups identical readings.
  const cgmPoints = timeline.filter((i) => i.type === 'CGM');
  let glucoseExtremes = null;
  if (cgmPoints.length) {
    const EPS = 0.001;
    let hi = -Infinity;
    let lo = Infinity;
    for (const p of cgmPoints) {
      if (p.val > hi) hi = p.val;
      if (p.val < lo) lo = p.val;
    }
    const instances = (target) =>
      cgmPoints
        .filter((p) => Math.abs(p.val - target) < EPS)
        .map((p) => ({
          value: toDisplay(p.val, units),
          time: new Date(p.epoch * 1000).toISOString(),
        }))
        .sort((a, b) => a.time.localeCompare(b.time));
    const highs = instances(hi);
    const lows = instances(lo);
    glucoseExtremes = {
      highest: {
        value: toDisplay(hi, units),
        count: highs.length,
        instances: highs,
      },
      lowest: {
        value: toDisplay(lo, units),
        count: lows.length,
        instances: lows,
      },
    };
  }

  // Bolus architecture
  const boluses = timeline.filter((i) => i.type === 'BOLUS');
  const bolusArchitecture = {
    meal: boluses.filter((b) => b.class === 'Meal Bolus').length,
    manualCorrection: boluses.filter((b) => b.class === 'Manual Correction Bolus')
      .length,
    systemCorrection: boluses.filter((b) => b.class === 'System Correction Bolus')
      .length,
    mealWithCorrection: boluses.filter(
      (b) => b.class === 'Meal With Correction Bolus'
    ).length,
  };

  // Settings snapshots, human-readable
  const settings = settingsHistory.map((s) => ({
    effective: s.activeTimestamp,
    DIA_hours: s.settings.generalSettings.activeInsulinTime,
    maxBasalRate: s.settings.basalSettings.maxBasalRate,
    targetBg: s.settings.profilesBolus[0].targetBgSegments.data.map((sn) => ({
      from: formatHour(sn.segmentStart),
      value: toDisplay(sn.value, units),
    })),
    isf: s.settings.profilesBolus[0].isfSegments.data.map((sn) => ({
      from: formatHour(sn.segmentStart),
      value: toDisplayDelta(sn.value, units),
    })),
    carbRatio: s.settings.profilesBolus[0].insulinToCarbRatioSegments.data.map(
      (sn) => ({ from: formatHour(sn.segmentStart), value: sn.value })
    ),
  }));

  return {
    unit: unitLabel,
    reportRange: { start: reportStart, end: reportEnd, days: +days.toFixed(2) },
    glucoseControl: {
      averageBG: toDisplay(avg, units),
      gmiEstimatedA1c: gmi,
      stdDev: toDisplayDelta(std, units),
      coefficientOfVariation: +cv.toFixed(2),
      variabilityFlag: cv > 36 ? 'High Variability' : 'Stable',
      timeInRange: +tir.tir.toFixed(2),
      timeLow: +tir.low.toFixed(2),
      timeHigh: +tir.high.toFixed(2),
      cgmReadingCount: cgmVals.length,
    },
    glucoseExtremes,
    bestWorst: {
      bestDay: bestD,
      worstDay: worstD,
      bestHour: bestH,
      worstHour: worstH,
    },
    insulin: summariseInsulin(timeline, dailyInsulin, units),
    bolusArchitecture,
    carbs: summariseCarbs(timeline, units),
    settings,
  };
}

/**
 * Window-level insulin summary. BOLUS is aggregated from archive events (one
 * method), with per-day rate over the decimal observed span. BASAL comes only
 * from Glooko daily totals: every day with a basal figure is included (no
 * exclusions, no notes), and we report the total, the count of basal days, and
 * the average per basal day. Because basal is whole-day quantised, basalDayCount
 * can differ slightly from the decimal observed span; both numbers are shown so
 * the difference is visible. The basal/bolus split is computed on a per-day-rate
 * basis (immune to the day-count vs span mismatch), an important balance metric
 * for a closed-loop system.
 */
export function summariseInsulin(timeline, dailyInsulin, units = 'mmol') {
  const bolusItems = timeline.filter((i) => i.type === 'BOLUS');
  const bolusUnits = bolusItems.reduce((a, b) => a + (b.units || 0), 0);
  const bolusEventCount = bolusItems.length;
  const cgmEpochs = timeline.filter((i) => i.type === 'CGM').map((i) => i.epoch);
  const observedDays = observedDaySpan(cgmEpochs);
  const bolusUnitsPerDay = bolusUnits / observedDays;

  const out = {
    observedDays: +observedDays.toFixed(2),
    bolusSource: 'archive-events',
    bolusUnits: +bolusUnits.toFixed(2),
    bolusUnitsPerDay: +bolusUnitsPerDay.toFixed(2),
    bolusEventCount,
    avgUnitsPerBolus: bolusEventCount ? +(bolusUnits / bolusEventCount).toFixed(2) : null,
  };

  if (dailyInsulin && dailyInsulin.length) {
    let basalUnits = 0;
    let basalDayCount = 0;
    for (const rec of dailyInsulin) {
      if (rec.basalUnits == null) continue;
      basalUnits += rec.basalUnits;
      basalDayCount++;
    }
    const averageBasalUnitsPerDay = basalDayCount ? basalUnits / basalDayCount : null;
    out.basalSource = 'glooko-daily';
    out.basalUnits = +basalUnits.toFixed(2);
    out.basalDayCount = basalDayCount;
    out.averageBasalUnitsPerDay =
      averageBasalUnitsPerDay == null ? null : +averageBasalUnitsPerDay.toFixed(2);

    // Basal/bolus split on a per-day-rate basis (normalises the differing
    // denominators: basal over basalDayCount whole days, bolus over the
    // observed span).
    if (averageBasalUnitsPerDay != null) {
      const dailyTotal = averageBasalUnitsPerDay + bolusUnitsPerDay;
      out.basalPercent = dailyTotal ? +((averageBasalUnitsPerDay / dailyTotal) * 100).toFixed(1) : null;
      out.bolusPercent = dailyTotal ? +((bolusUnitsPerDay / dailyTotal) * 100).toFixed(1) : null;
    }
  }
  return out;
}

/** Window-level carb summary from archive carb-bearing bolus events. */
export function summariseCarbs(timeline, units = 'mmol') {
  const cgmEpochs = timeline.filter((i) => i.type === 'CGM').map((i) => i.epoch);
  const observedDays = observedDaySpan(cgmEpochs);
  let carbsGrams = 0;
  let carbEntryCount = 0;
  for (const i of timeline) {
    if (i.type === 'BOLUS' && (i.carbs || 0) > 0) {
      carbsGrams += i.carbs;
      carbEntryCount++;
    }
  }
  return {
    carbsGrams: Math.round(carbsGrams),
    carbsPerDay: Math.round(carbsGrams / observedDays),
    carbEntryCount,
  };
}

function round(v, dp = 2) {
  if (v === undefined || v === null || Number.isNaN(Number(v))) return null;
  return +Number(v).toFixed(dp);
}

// --- day completeness & observed span -------------------------------------
/**
 * Build the set of UTC day strings (YYYY-MM-DD) that contain at least one CGM
 * reading. Used to classify a day as "whole" by the neighbour rule.
 */
export function daysWithReadings(timeline) {
  const days = new Set();
  for (const item of timeline) {
    if (item.type !== 'CGM') continue;
    days.add(new Date(item.epoch * 1000).toISOString().slice(0, 10));
  }
  return days;
}

/** The UTC day string N days from the given day string. */
function shiftDay(dayStr, deltaDays) {
  const d = new Date(dayStr + 'T00:00:00.000Z');
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

/**
 * A day is WHOLE when both adjacent calendar days have at least one reading: a
 * day bracketed by data on each side must itself be fully covered. The only
 * partial days are therefore the first and last of the data (or any day next to
 * an interior gap). Whole days carry a trustworthy whole-day basal that can be
 * combined with our bolus into a clean daily total; partial days show basal
 * flagged as a whole-day figure that the window may not fully cover.
 */
export function isWholeDay(dayStr, daySet) {
  return daySet.has(shiftDay(dayStr, -1)) && daySet.has(shiftDay(dayStr, 1));
}

/**
 * Decimal day-span actually observed between the first and last CGM reading of
 * a set of epochs (seconds). This is the correct denominator for per-day RATES
 * of things we measure event-by-event (bolus, CGM), avoiding calendar-boundary
 * miscounts. Returns a small positive floor for a single reading.
 */
export function observedDaySpan(epochs) {
  if (!epochs.length) return 0;
  let min = Infinity;
  let max = -Infinity;
  for (const e of epochs) {
    if (e < min) min = e;
    if (e > max) max = e;
  }
  const span = (max - min) / 86400;
  return span > 0 ? span : 1 / 24;
}

// --- bucketed trend aggregation -------------------------------------------

const MGDL_PER_MMOL_TREND = 18.0182;

/**
 * Map a UTC epoch (seconds) to a calendar bucket key for the given granularity.
 * Keys sort lexically into chronological order.
 */
function calendarBucketKey(epochSeconds, granularity) {
  const d = new Date(epochSeconds * 1000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth(); // 0-11
  const day = d.getUTCDate();
  if (granularity === 'day') {
    return d.toISOString().split('T')[0]; // YYYY-MM-DD
  }
  if (granularity === 'week') {
    // ISO-ish week: bucket by the Monday of the reading's week (UTC).
    const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
    const monday = new Date(Date.UTC(y, m, day - dow));
    return 'W:' + monday.toISOString().split('T')[0];
  }
  if (granularity === 'month') {
    return `${y}-${String(m + 1).padStart(2, '0')}`;
  }
  if (granularity === 'quarter') {
    const q = Math.floor(m / 3) + 1;
    return `${y}-Q${q}`;
  }
  throw new Error(`Unknown granularity: ${granularity}`);
}

/**
 * Map an epoch to a fixed-length bucket index relative to a start epoch.
 * sizeDays is 1/7/14/30 etc. Returns a key like 'F:<startISO>'.
 */
function fixedBucketKey(epochSeconds, startEpochSeconds, sizeDays) {
  const sizeSecs = sizeDays * 86400;
  const idx = Math.floor((epochSeconds - startEpochSeconds) / sizeSecs);
  const bucketStart = startEpochSeconds + idx * sizeSecs;
  return 'F:' + new Date(bucketStart * 1000).toISOString().split('T')[0];
}

/**
 * Bucket a unified timeline and aggregate each bucket INDEPENDENTLY from raw
 * readings. Critically, every metric is derived from sums and counts within the
 * bucket, never by combining pre-computed averages, so the rows are accurate
 * regardless of differing reading counts (e.g. sensor dropout) between buckets.
 *
 * mode: 'calendar' | 'fixed'
 * granularity: 'day'|'week'|'month'|'quarter' (calendar) or a day-size (fixed)
 * windowStart/windowEnd are epoch seconds, used for coverage expectation.
 *
 * Each row carries:
 *   - glucose: avg, TIR/low/high %, stdDev, CV, GMI, reading count
 *   - insulin: bolus units total + per-day (basal not stored; see note)
 *   - carbs:   total + per-day, carb-entry count
 *   - coverage: expected vs actual readings and a percentage, so each row's
 *               trustworthiness is visible
 */
export function bucketTrend(
  timeline,
  thresholds,
  { mode, granularity, fixedSizeDays, windowStart, windowEnd, units = 'mmol' },
  dailyInsulin = null
) {
  const buckets = new Map();

  const keyFor = (epoch) =>
    mode === 'fixed'
      ? fixedBucketKey(epoch, windowStart, fixedSizeDays)
      : calendarBucketKey(epoch, granularity);

  for (const item of timeline) {
    const key = keyFor(item.epoch);
    if (!buckets.has(key)) {
      buckets.set(key, {
        key,
        firstEpoch: item.epoch,
        lastEpoch: item.epoch,
        cgmEpochs: [],
        cgmSum: 0,
        cgmSumSq: 0,
        cgmCount: 0,
        inRange: 0,
        low: 0,
        high: 0,
        bolusUnits: 0,
        bolusCount: 0,
        carbs: 0,
        carbEntries: 0,
        // Per-day Glooko basal for this bucket: dayStr -> basalUnits. Bolus is
        // NOT taken from Glooko (we aggregate it ourselves from events above).
        basalByDay: new Map(),
        hasInsulinData: false,
      });
    }
    const b = buckets.get(key);
    if (item.epoch < b.firstEpoch) b.firstEpoch = item.epoch;
    if (item.epoch > b.lastEpoch) b.lastEpoch = item.epoch;

    if (item.type === 'CGM') {
      const v = item.val;
      b.cgmEpochs.push(item.epoch);
      b.cgmSum += v;
      b.cgmSumSq += v * v;
      b.cgmCount++;
      if (v < thresholds.low) b.low++;
      else if (v > thresholds.high) b.high++;
      else b.inRange++;
    } else if (item.type === 'BOLUS') {
      b.bolusUnits += item.units || 0;
      b.bolusCount++;
      if ((item.carbs || 0) > 0) {
        b.carbs += item.carbs;
        b.carbEntries++;
      }
    }
  }

  // Attribute Glooko per-day BASAL to its bucket, keyed by day so we can later
  // classify each day as whole/partial. We deliberately take ONLY basal from
  // Glooko: bolus is aggregated by us from individual events above (one
  // consistent method), so Glooko's pre-aggregated bolus is not used here.
  if (dailyInsulin && dailyInsulin.length) {
    for (const rec of dailyInsulin) {
      if (rec.basalUnits == null) continue;
      const dayEpoch = Math.floor(
        new Date(rec.dayUtc + 'T12:00:00.000Z').getTime() / 1000
      );
      const key = keyFor(dayEpoch);
      if (!buckets.has(key)) {
        buckets.set(key, {
          key,
          firstEpoch: dayEpoch,
          lastEpoch: dayEpoch,
          cgmEpochs: [],
          cgmSum: 0,
          cgmSumSq: 0,
          cgmCount: 0,
          inRange: 0,
          low: 0,
          high: 0,
          bolusUnits: 0,
          bolusCount: 0,
          carbs: 0,
          carbEntries: 0,
          basalByDay: new Map(),
          hasInsulinData: false,
        });
      }
      const b = buckets.get(key);
      b.basalByDay.set(rec.dayUtc, rec.basalUnits || 0);
      b.hasInsulinData = true;
    }
  }

  const rows = [...buckets.values()]
    .sort((a, b) => a.firstEpoch - b.firstEpoch)
    .map((b) => buildBucketRow(b, thresholds, units));
  return rows;
}

/** Build a single trend bucket's output row. */
function buildBucketRow(b, thresholds, units) {
  const avg = b.cgmCount ? b.cgmSum / b.cgmCount : 0;
  const variance = b.cgmCount ? b.cgmSumSq / b.cgmCount - avg * avg : 0;
  const std = Math.sqrt(Math.max(0, variance));
  const cv = avg ? (std / avg) * 100 : 0;
  const gmi = b.cgmCount
    ? +(3.31 + 0.02392 * (avg * MGDL_PER_MMOL_TREND)).toFixed(2)
    : null;

  // Decimal days actually observed in this bucket (first to last CGM reading).
  // This is the denominator for per-day RATES of things we measure event by
  // event (bolus, carbs), and is correct regardless of calendar boundaries.
  const observedDays = observedDaySpan(b.cgmEpochs);

  // Coverage relative to the observed span at 5-min cadence.
  const expectedReadings = Math.max(1, Math.round(observedDays * 288));
  const coveragePct = +Math.min(100, (b.cgmCount / expectedReadings) * 100).toFixed(1);

  // Sum ALL basal days in this bucket (no whole/partial exclusion). basalDayCount
  // is the number of whole-day basal loads; it may differ slightly from the
  // decimal observedDays, and both are shown so the difference is visible.
  let basalUnits = 0;
  let basalDayCount = 0;
  for (const [, basal] of b.basalByDay) {
    basalUnits += basal;
    basalDayCount++;
  }

  // Bolus is aggregated from events (authoritative, single method).
  const bolusUnits = +b.bolusUnits.toFixed(2);
  const bolusUnitsPerDay = b.bolusUnits / observedDays;
  const avgUnitsPerBolus = b.bolusCount
    ? +(b.bolusUnits / b.bolusCount).toFixed(2)
    : null;

  // Insulin block. Bolus always present (from events). Basal present only when
  // Glooko supplied daily figures: total, day count, average per basal day, and
  // a per-day-rate basal/bolus split.
  const insulin = {
    bolusSource: 'archive-events',
    bolusUnits,
    bolusUnitsPerDay: +bolusUnitsPerDay.toFixed(2),
    bolusEventCount: b.bolusCount,
    avgUnitsPerBolus,
  };
  if (b.hasInsulinData) {
    const averageBasalUnitsPerDay = basalDayCount ? basalUnits / basalDayCount : null;
    insulin.basalSource = 'glooko-daily';
    insulin.basalUnits = +basalUnits.toFixed(2);
    insulin.basalDayCount = basalDayCount;
    insulin.averageBasalUnitsPerDay =
      averageBasalUnitsPerDay == null ? null : +averageBasalUnitsPerDay.toFixed(2);
    if (averageBasalUnitsPerDay != null) {
      const dailyTotal = averageBasalUnitsPerDay + bolusUnitsPerDay;
      insulin.basalPercent = dailyTotal ? +((averageBasalUnitsPerDay / dailyTotal) * 100).toFixed(1) : null;
      insulin.bolusPercent = dailyTotal ? +((bolusUnitsPerDay / dailyTotal) * 100).toFixed(1) : null;
    }
  }

  return {
    bucket: b.key.replace(/^[WF]:/, ''),
    start: new Date(b.firstEpoch * 1000).toISOString(),
    end: new Date(b.lastEpoch * 1000).toISOString(),
    observedDays: +observedDays.toFixed(3),
    glucose: {
      avg: toDisplay(avg, units),
      timeInRange: b.cgmCount ? +((b.inRange / b.cgmCount) * 100).toFixed(2) : 0,
      timeLow: b.cgmCount ? +((b.low / b.cgmCount) * 100).toFixed(2) : 0,
      timeHigh: b.cgmCount ? +((b.high / b.cgmCount) * 100).toFixed(2) : 0,
      stdDev: toDisplayDelta(std, units),
      coefficientOfVariation: +cv.toFixed(2),
      gmiEstimatedA1c: gmi,
      cgmReadingCount: b.cgmCount,
    },
    insulin,
    carbs: {
      carbsGrams: Math.round(b.carbs),
      carbsPerDay: Math.round(b.carbs / observedDays),
      carbEntryCount: b.carbEntries,
    },
    coverage: {
      cgmReadingCount: b.cgmCount,
      expectedReadingCount: expectedReadings,
      coveragePercent: coveragePct,
      trustworthy: coveragePct >= 70,
    },
  };
}

// --- chart downsampling ---------------------------------------------------

/**
 * Downsample a timeline into at most maxPoints buckets for plotting. Each point
 * carries the average plus min/max for its bucket, so a sharp excursion between
 * samples shows as a band rather than being silently smoothed away. Bolus events
 * are returned separately as markers to overlay (meals/corrections), not folded
 * into the line.
 *
 * The whole purpose is to keep volume OUT of the model's context: a wide chart
 * that would be ~6000 raw readings becomes a few hundred points here, so it is
 * far faster and cheaper to pass through the model and draw. Full resolution
 * remains available via get_glucose_timeline for deliberate close-ups.
 *
 * Returns { points: [{t, avg, min, max, n}], boluses: [{t, units, carbs, class}], requestedMax, actualPoints }.
 */
export function downsampleForChart(timeline, maxPoints, units = 'mmol') {
  const cgm = timeline.filter((i) => i.type === 'CGM');
  const boluses = timeline
    .filter((i) => i.type === 'BOLUS')
    .map((b) => ({
      t: new Date(b.epoch * 1000).toISOString(),
      epoch: b.epoch,
      units: b.units ?? null,
      carbs: b.carbs ?? null,
      class: b.class ?? null,
    }));

  if (!cgm.length) {
    return { points: [], boluses, requestedMax: maxPoints, actualPoints: 0 };
  }

  const cap = Math.max(2, Math.floor(maxPoints) || 200);

  // If there are already fewer readings than the cap, return them as-is
  // (each its own bucket), so short windows keep full fidelity.
  if (cgm.length <= cap) {
    const points = cgm.map((p) => ({
      t: new Date(p.epoch * 1000).toISOString(),
      avg: toDisplay(p.val, units),
      min: toDisplay(p.val, units),
      max: toDisplay(p.val, units),
      n: 1,
    }));
    return { points, boluses, requestedMax: cap, actualPoints: points.length };
  }

  // Bucket by time span so points are evenly spaced on the x-axis (important:
  // bucketing by reading-index would distort spacing across coverage gaps).
  const startEpoch = cgm[0].epoch;
  const endEpoch = cgm[cgm.length - 1].epoch;
  const totalSpan = endEpoch - startEpoch || 1;
  const bucketSpan = totalSpan / cap;

  const buckets = new Map();
  for (const p of cgm) {
    const idx = Math.min(cap - 1, Math.floor((p.epoch - startEpoch) / bucketSpan));
    if (!buckets.has(idx)) {
      buckets.set(idx, { sum: 0, n: 0, min: Infinity, max: -Infinity, firstEpoch: p.epoch });
    }
    const b = buckets.get(idx);
    b.sum += p.val;
    b.n++;
    if (p.val < b.min) b.min = p.val;
    if (p.val > b.max) b.max = p.val;
  }

  const points = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([idx, b]) => ({
      t: new Date((startEpoch + idx * bucketSpan) * 1000).toISOString(),
      avg: toDisplay(b.sum / b.n, units),
      min: toDisplay(b.min, units),
      max: toDisplay(b.max, units),
      n: b.n,
    }));

  return { points, boluses, requestedMax: cap, actualPoints: points.length };
}

// --- chart x-axis metadata -------------------------------------------------

export const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const MONTH_ABBR = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** Wall-clock digits of an epoch, read via UTC getters (see this file's top
 * comment for why: it extracts the literal digits an epoch was built from,
 * with no host-timezone interference — NOT a claim these are true UTC).
 * Exported so other modules (e.g. chartHtml.js) format labels identically
 * rather than re-deriving their own wall-clock digit extraction. */
export function wallClockParts(epochSeconds) {
  const d = new Date(epochSeconds * 1000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth(), // 0-11
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    weekday: d.getUTCDay(), // 0 = Sunday
  };
}

export const pad2 = (n) => String(n).padStart(2, '0');

export function formatClockLabel(epochSeconds) {
  const { hour, minute } = wallClockParts(epochSeconds);
  return `${pad2(hour)}:${pad2(minute)}`;
}

export function formatDayLabel(epochSeconds) {
  const { weekday, day, month } = wallClockParts(epochSeconds);
  return `${WEEKDAY_ABBR[weekday]} ${day} ${MONTH_ABBR[month]}`;
}

/**
 * Pre-computes ready-to-use x-axis tick marks and calendar-day segments for a
 * [startEpoch, endEpoch] chart window, so a chart-rendering step never has to
 * invent its own axis scale from bare data points (which is exactly how a
 * plain point-INDEX axis — "1, 2, 3 ... 286" instead of real times — creeps
 * in: computing a correct time scale, with sensibly-spaced ticks AND a
 * day-boundary breakdown, from scratch every time is easy to get wrong even
 * with explicit instructions). This hands over the actual decisions already
 * made:
 *
 *   - `ticks`: evenly time-spaced {t, label} marks with a clock-time label
 *     (e.g. "00:00", "03:00"). Interval scales with the window's span so a
 *     single day gets a tick every 4 hours and a multi-day window (up to
 *     ~10 days) gets one every 3 hours, matching a typical CGM report's
 *     layout — never based on point count.
 *   - `days`: one segment per calendar day the window touches (even a
 *     partial day at either end), each with its start/end and a ready
 *     display label (e.g. "Wed 17 Jun"). Meant to be rendered as the axis's
 *     day-grouping row: a vertical divider at each boundary and the day's
 *     label centred under its segment — exactly the "3 equally spaced
 *     sections, each labelled with its date" layout a multi-day chart needs.
 *   - Beyond ~10 days there are too many day segments to label individually,
 *     so `ticks` switches to one date label per tick instead, and `days` is
 *     omitted (still returned as an empty array, never undefined).
 *
 * Returns { spanHours, ticks: [{t, label}], days: [{startT, endT, label}] }.
 */
export function buildChartXAxis(startEpoch, endEpoch) {
  if (!Number.isFinite(startEpoch) || !Number.isFinite(endEpoch) || endEpoch <= startEpoch) {
    return { spanHours: 0, ticks: [], days: [] };
  }
  const spanHours = (endEpoch - startEpoch) / 3600;

  let tickIntervalHours;
  let tickMode; // 'clock' | 'date'
  if (spanHours <= 30) {
    tickIntervalHours = 4;
    tickMode = 'clock';
  } else if (spanHours <= 24 * 10) {
    tickIntervalHours = 3;
    tickMode = 'clock';
  } else {
    tickIntervalHours = 24;
    tickMode = 'date';
  }
  const stepSeconds = tickIntervalHours * 3600;

  // Ticks anchored to the window's own start (not a separate day-aligned
  // grid): when start is midnight, as a day/multi-day report normally asks
  // for, this naturally lands on 00:00, 03:00/04:00, ... The final tick is
  // always the window's own end, even if that lands off-interval, so the
  // axis never stops short of the actual data.
  const ticks = [];
  for (let e = startEpoch; e < endEpoch; e += stepSeconds) {
    ticks.push({
      t: new Date(e * 1000).toISOString(),
      label: tickMode === 'clock' ? formatClockLabel(e) : formatDayLabel(e),
    });
  }
  const lastTickEpoch = ticks.length ? Date.parse(ticks[ticks.length - 1].t) / 1000 : null;
  if (lastTickEpoch !== endEpoch) {
    ticks.push({
      t: new Date(endEpoch * 1000).toISOString(),
      label: tickMode === 'clock' ? formatClockLabel(endEpoch) : formatDayLabel(endEpoch),
    });
  }

  // One segment per calendar day the window touches, including partial days
  // at either end. Omitted (empty array) once the window is long enough that
  // `ticks` has switched to per-tick date labels instead.
  const days = [];
  if (tickMode === 'clock') {
    let cursor = Math.floor(startEpoch / 86400) * 86400;
    while (cursor < endEpoch) {
      const segStart = Math.max(cursor, startEpoch);
      const segEnd = Math.min(cursor + 86400, endEpoch);
      if (segEnd > segStart) {
        days.push({
          startT: new Date(segStart * 1000).toISOString(),
          endT: new Date(segEnd * 1000).toISOString(),
          label: formatDayLabel(segStart),
        });
      }
      cursor += 86400;
    }
  }

  return { spanHours: +spanHours.toFixed(2), ticks, days };
}

/**
 * Per-day segments with their OWN tick marks, for chart windows that may be
 * DISCONNECTED (several separate date ranges shown together, e.g. "the 20th,
 * 23rd and 30th of June") or have individual days hidden by the viewer at
 * render time. buildChartXAxis's `days` are meant to be labelled under one
 * continuous linear time axis and share one flat `ticks` list; that breaks
 * down once days aren't contiguous, because a linear epoch scale would waste
 * most of its width on the gaps between the dates actually wanted. This
 * function instead makes each day fully self-contained -- its own ticks
 * relative to its own start -- so a chart can lay days out as equal-width
 * slots in sequence (a "day 1, day 2, day 3..." position) regardless of the
 * real calendar distance between them, and can drop any single day's slot
 * without disturbing the others.
 *
 * Returns [{ startT, endT, label, ticks: [{t, label}] }], one entry per
 * calendar day the [startEpoch, endEpoch) window touches (including partial
 * days at either end).
 */
export function buildChartDaySegments(startEpoch, endEpoch, tickIntervalHours = 4) {
  if (!Number.isFinite(startEpoch) || !Number.isFinite(endEpoch) || endEpoch <= startEpoch) return [];
  const stepSeconds = Math.max(1, tickIntervalHours) * 3600;
  const days = [];
  let cursor = Math.floor(startEpoch / 86400) * 86400;
  while (cursor < endEpoch) {
    const segStart = Math.max(cursor, startEpoch);
    const segEnd = Math.min(cursor + 86400, endEpoch);
    if (segEnd > segStart) {
      const ticks = [];
      for (let e = cursor; e < segEnd; e += stepSeconds) {
        if (e < segStart) continue;
        ticks.push({ t: new Date(e * 1000).toISOString(), label: formatClockLabel(e) });
      }
      if (!ticks.length || Date.parse(ticks[0].t) / 1000 !== segStart) {
        ticks.unshift({ t: new Date(segStart * 1000).toISOString(), label: formatClockLabel(segStart) });
      }
      const lastTickEpoch = Date.parse(ticks[ticks.length - 1].t) / 1000;
      if (lastTickEpoch !== segEnd) {
        ticks.push({ t: new Date(segEnd * 1000).toISOString(), label: formatClockLabel(segEnd) });
      }
      days.push({
        startT: new Date(segStart * 1000).toISOString(),
        endT: new Date(segEnd * 1000).toISOString(),
        label: formatDayLabel(segStart),
        ticks,
      });
    }
    cursor += 86400;
  }
  return days;
}

/**
 * Narrows a settingsHistory array (already shaped like getSettingsHistory's
 * output -- a baseline snapshot plus every change within some OUTER window)
 * down to just what applies to a NARROWER sub-window inside it, e.g. picking
 * one calendar day's settings out of a whole multi-day range's history,
 * without a second database round trip. Mirrors getSettingsHistory's own
 * rule exactly: the last snapshot effective at or before the sub-window
 * start, plus any snapshot that changed within it.
 */
export function narrowSettingsHistory(fullHistory, subStartEpoch, subEndEpoch) {
  if (!fullHistory || !fullHistory.length) return [];
  const withEpoch = fullHistory.map((s) => ({ ...s, epoch: Date.parse(s.activeTimestamp) / 1000 }));
  const baselineIdx = withEpoch.findLastIndex((s) => s.epoch <= subStartEpoch);
  const startIndex = baselineIdx !== -1 ? baselineIdx : 0;
  return withEpoch
    .slice(startIndex)
    .filter((s) => s.epoch <= subEndEpoch)
    .map((s) => ({ activeTimestamp: s.activeTimestamp, settings: s.settings }));
}

/**
 * Per-day clinical detail for a chart: for each day segment from
 * buildChartDaySegments, slices the WINDOW's timeline/dailyInsulin/settings
 * down to just that one calendar day and runs them through computeSummary --
 * the exact same aggregator get_diabetes_summary uses. This means a chart's
 * per-day panel reports precisely what a "how was Tuesday" question would,
 * from one code path, rather than a second parallel implementation that
 * could drift out of sync with it.
 *
 * daySegs: {startT, endT, ...} segments (from one or several ranges, already
 * chronologically sorted -- each is handled independently, so disconnected/
 * non-contiguous days fall out for free, same as the chart's own axis).
 * timeline/dailyInsulin/settingsHistory are the FULL window's data as
 * returned by getProcessedRange; this function does all the per-day slicing.
 *
 * Returns one { dayKey, summary } per segment. dayKey is the wall-clock
 * YYYY-MM-DD the segment starts on, matching dailyInsulin's own dayUtc key.
 */
export function buildDaySummaries(daySegs, timeline, dailyInsulin, settingsHistory, thresholds, unitLabel) {
  if (!daySegs || !daySegs.length) return [];
  const segs = daySegs.map((d) => ({
    startEpoch: Date.parse(d.startT) / 1000,
    endEpoch: Date.parse(d.endT) / 1000,
    dayKey: d.startT.split('T')[0],
  }));

  // Two-pointer bucket pass over the (chronologically sorted) timeline. A
  // reading exactly on a boundary shared by two adjacent segments goes to
  // the EARLIER one -- matching the chart's own findDayIndexForEpoch, which
  // returns the first inclusive match.
  const buckets = segs.map(() => []);
  let segIdx = 0;
  for (const item of timeline) {
    while (segIdx < segs.length && item.epoch > segs[segIdx].endEpoch) segIdx++;
    if (segIdx >= segs.length) break;
    if (item.epoch >= segs[segIdx].startEpoch) buckets[segIdx].push(item);
  }

  return segs.map((seg, i) => {
    const dayInsulin = (dailyInsulin || []).filter((d) => d.dayUtc === seg.dayKey);
    const daySettings = narrowSettingsHistory(settingsHistory, seg.startEpoch, seg.endEpoch);
    const summary = computeSummary(buckets[i], null, daySettings, thresholds, unitLabel, 'exact', dayInsulin);
    return { dayKey: seg.dayKey, summary };
  });
}

// --- daily insulin totals -------------------------------------------------

/**
 * Extract the dailyInsulinTotals block Glooko returns when the
 * totalInsulinPerDay series is requested, into normalised per-day records.
 *
 * The block is keyed by a per-day epoch (seconds). Per the Glooko data, that
 * epoch denotes the calendar day (its UTC date is the day it belongs to, even
 * though the literal time may sit at midday). We key our records by that UTC
 * date string so they line up with the CGM/bolus day.
 *
 * Returns [{ dayUtc, dayEpoch, basalUnits, bolusUnits, totalUnits }].
 * Tight scope: only basal, bolus and total, as agreed.
 */
export function extractDailyInsulin(rawJson) {
  // The block lives under series.dailyInsulinTotals (confirmed against the real
  // Glooko response), NOT at the top level. It is keyed by an epoch at midday
  // UTC of the day it describes.
  const block =
    rawJson && rawJson.series && rawJson.series.dailyInsulinTotals;
  if (!block || typeof block !== 'object') return [];
  const out = [];
  for (const key of Object.keys(block)) {
    const rec = block[key];
    const dayEpoch = parseInt(key, 10);
    if (Number.isNaN(dayEpoch)) continue;
    out.push({
      dayUtc: new Date(dayEpoch * 1000).toISOString().split('T')[0],
      dayEpoch,
      basalUnits: numOrNull(rec.basalUnitsPerDay),
      bolusUnits: numOrNull(rec.bolusUnitsPerDay),
      totalUnits: numOrNull(rec.totalInsulinPerDay),
    });
  }
  return out.sort((a, b) => a.dayEpoch - b.dayEpoch);
}

function numOrNull(v) {
  if (v === undefined || v === null || Number.isNaN(Number(v))) return null;
  return +Number(v).toFixed(2);
}

/**
 * SuperGlookoQuery fork — DESIGN.md section 1 (typed core + `extra`
 * overflow). Returns everything in `raw` that ISN'T one of `knownKeys`, as a
 * plain object, or null if there's nothing left over. This is the ingest-
 * side half of the overflow mechanism: whatever this account's Glooko API
 * response actually contains beyond the fields this fork already knows how
 * to type gets captured here rather than silently discarded, so a device
 * this project has never been tested against still has its data preserved
 * (see store.js's `extra` column and `field_capability` table for where
 * this ends up and how it drives capability-gated modules).
 *
 * Deliberately NOT recursive/deep — Glooko fields observed so far are a flat
 * bag per record (see DESIGN.md's "Known follow-ups" re: nested sub-objects
 * needing separate handling if/when one shows up; this is the simple case).
 */
function captureExtra(raw, knownKeys) {
  if (!raw || typeof raw !== 'object') return null;
  const known = new Set(knownKeys);
  const extra = {};
  let hasAny = false;
  for (const [key, value] of Object.entries(raw)) {
    if (known.has(key)) continue;
    extra[key] = value;
    hasAny = true;
  }
  return hasAny ? extra : null;
}

// The typed columns each record type already reads from the raw Glooko
// response — kept as a named constant (not inline) so it's the one place
// to update if a field here ever gets promoted to a real typed column,
// per DESIGN.md's promotion path.
const CGM_KNOWN_KEYS = ['x', 'y'];
const BOLUS_KNOWN_KEYS = [
  'x', 'y', 'isManual', 'carbsInput', 'insulinRecommendationForCorrection',
  'isOverrideAbove', 'isOverrideBelow', 'insulinDelivered', 'insulinProgrammed',
  'isInterrupted', 'totalInsulinRecommendation', 'insulinRecommendationForCarbs',
  'insulinOnBoard', 'bloodGlucoseInput', 'bloodGlucoseInputSource',
  'initialDeliveryPercentage', 'extendedDeliveryPercentage', 'durationString',
];


// --- basal delivery state ------------------------------------------------

/**
 * The Omnipod 5 basal delivery state over time, derived from Glooko's bar
 * series. These series are DRAWING instructions (y is only 0/1/null, the bar
 * rising and falling); the information is in the x timestamps. Consecutive
 * pairs of x values bound an interval during which that state was active.
 *
 * Four states, in order of precedence when they overlap:
 *   - 'limited' : pumpOp5LimitedMode. The system LOST CGM signal (>20 min) and
 *                 fell back to a fixed programmed basal. The smart algorithm was
 *                 NOT adjusting. This is "running blind", not an effort level, so
 *                 it takes precedence: anything during limited is reported limited.
 *   - 'max'     : basalBarAutomatedMax. Algorithm delivering at its ceiling,
 *                 typically fighting a rise it cannot otherwise catch.
 *   - 'suspend' : basalBarAutomatedSuspend. Algorithm paused basal, typically to
 *                 prevent a predicted low.
 *   - 'normal'  : basalBarAutomated. Ordinary automated delivery.
 *
 * IMPORTANT: these are STATES, not insulin amounts. 'max' means at the ceiling,
 * 'suspend' means paused; neither is a number of units. Downstream descriptions
 * must stay qualitative.
 *
 * Returns merged, sorted intervals: [{ start, end, state, startEpoch, endEpoch, minutes }].
 */
export function deriveBasalStates(rawJson, windowStartEpoch, windowEndEpoch) {
  const series = rawJson && rawJson.series ? rawJson.series : {};

  // Pull [start,end] intervals from a bar series. Glooko encodes each bar with
  // its y-value: a bar is "on" between the x where y rises to 1 and the x where
  // y falls back to 0. We must pair on these EDGES, not by blind positional
  // (0,1),(2,3) pairing of distinct x's. A series can begin mid-bar (its first
  // point is a falling edge that closes a bar started before the window), and
  // positional pairing then pairs (end,start),(end,start) and silently inverts
  // every interval into the gaps. Tracking the y level avoids that entirely.
  const barIntervals = (arr) => {
    if (!Array.isArray(arr) || !arr.length) return [];
    const out = [];
    let openStart = null; // x at which the current bar turned on, or null
    let prevY = 0;
    for (const p of arr) {
      if (typeof p.x !== 'number') continue;
      const y = p.y === 1 ? 1 : 0; // treat null/0/undefined as off, 1 as on
      if (y === 1 && prevY !== 1) {
        // rising edge: a bar starts here (only if not already open)
        if (openStart === null) openStart = p.x;
      } else if (y !== 1 && prevY === 1) {
        // falling edge: the open bar ends here
        if (openStart !== null && p.x > openStart) out.push([openStart, p.x]);
        openStart = null;
      }
      prevY = y;
    }
    return out;
  };

  // Mode series (pumpOp5LimitedMode) carry real start/end timestamps with a
  // duration; take distinct [x, endTimestamp-derived] from timestamp/endTimestamp.
  const modeIntervals = (arr) => {
    if (!Array.isArray(arr) || !arr.length) return [];
    const seen = new Set();
    const out = [];
    for (const p of arr) {
      if (!p.timestamp || !p.endTimestamp) continue;
      const s = Math.floor(new Date(p.timestamp).getTime() / 1000);
      const e = Math.floor(new Date(p.endTimestamp).getTime() / 1000);
      const key = `${s}|${e}`;
      if (e > s && !seen.has(key)) {
        seen.add(key);
        out.push([s, e]);
      }
    }
    return out;
  };

  const suspend = barIntervals(series.basalBarAutomatedSuspend);
  const max = barIntervals(series.basalBarAutomatedMax);
  const normal = barIntervals(series.basalBarAutomated);
  const limited = modeIntervals(series.pumpOp5LimitedMode);

  // Determine the day/window bounds from the data if not supplied.
  const allStarts = [...suspend, ...max, ...normal, ...limited].map((i) => i[0]);
  const allEnds = [...suspend, ...max, ...normal, ...limited].map((i) => i[1]);
  if (!allStarts.length) return [];
  const lo = windowStartEpoch ?? Math.min(...allStarts);
  const hi = windowEndEpoch ?? Math.max(...allEnds);

  const inAny = (t, ivs) => ivs.some(([s, e]) => t >= s && t < e);

  // Collect all boundary points, classify each sub-interval by precedence.
  const bounds = new Set([lo, hi]);
  for (const [s, e] of [...suspend, ...max, ...normal, ...limited]) {
    if (s >= lo && s <= hi) bounds.add(s);
    if (e >= lo && e <= hi) bounds.add(e);
  }
  const pts = [...bounds].sort((a, b) => a - b);

  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (b <= a) continue;
    const mid = a + (b - a) / 2;
    let state;
    if (inAny(mid, limited)) state = 'limited';
    else if (inAny(mid, max)) state = 'max';
    else if (inAny(mid, suspend)) state = 'suspend';
    else state = 'normal';
    segs.push([a, b, state]);
  }

  // Merge consecutive same-state segments.
  const merged = [];
  for (const [a, b, st] of segs) {
    const last = merged[merged.length - 1];
    if (last && last.state === st && last.endEpoch === a) {
      last.endEpoch = b;
    } else {
      merged.push({ startEpoch: a, endEpoch: b, state: st });
    }
  }

  return merged.map((m) => ({
    state: m.state,
    start: new Date(m.startEpoch * 1000).toISOString(),
    end: new Date(m.endEpoch * 1000).toISOString(),
    startEpoch: m.startEpoch,
    endEpoch: m.endEpoch,
    minutes: Math.round((m.endEpoch - m.startEpoch) / 60),
  }));
}

/**
 * Aggregate basal-state intervals into totals and counts for a window.
 * Returns durations and percentages per state, plus episode counts, with
 * explicit notes on what each state means so the model reasons correctly.
 */
export function summariseBasalStates(intervals) {
  if (!intervals || !intervals.length) {
    return { available: false, note: 'No basal-state data for this window.' };
  }
  const totalSecs = intervals.reduce(
    (a, i) => a + (i.endEpoch - i.startEpoch),
    0
  );
  const byState = { normal: 0, suspend: 0, max: 0, limited: 0 };
  const counts = { normal: 0, suspend: 0, max: 0, limited: 0 };
  for (const i of intervals) {
    byState[i.state] = (byState[i.state] || 0) + (i.endEpoch - i.startEpoch);
    counts[i.state] = (counts[i.state] || 0) + 1;
  }
  const pct = (s) => (totalSecs ? +((s / totalSecs) * 100).toFixed(1) : 0);
  const mins = (s) => Math.round(s / 60);

  return {
    available: true,
    spanHours: +(totalSecs / 3600).toFixed(2),
    normal: { minutes: mins(byState.normal), percent: pct(byState.normal), episodes: counts.normal },
    suspend: { minutes: mins(byState.suspend), percent: pct(byState.suspend), episodes: counts.suspend },
    max: { minutes: mins(byState.max), percent: pct(byState.max), episodes: counts.max },
    limited: { minutes: mins(byState.limited), percent: pct(byState.limited), episodes: counts.limited },
    interpretation: {
      suspend: 'Algorithm paused basal, typically to prevent a predicted low. A state, not zero units quantified.',
      max: 'Algorithm delivering at its ceiling, typically fighting a rise. A state, not a unit amount.',
      limited: 'System lost CGM signal (>20 min) and ran a fixed preset basal. The smart algorithm was NOT adjusting; glucose excursions during limited mode are not attributable to algorithm decisions.',
      normal: 'Ordinary automated delivery.',
    },
  };
}

// --- device events (pod / sensor changes) --------------------------------

/**
 * Extract pod (setSiteChange) and CGM sensor (cgmSensorChange) change events
 * from a Glooko response. These are point-in-time markers, not intervals or
 * amounts. Glooko sometimes emits the same event twice (identical timestamp),
 * so we deduplicate by timestamp: same time means the same event.
 *
 * Kept as two separate event types. Useful as context for explaining nearby
 * glucose disruption (a fresh pod can run high while the cannula settles; a new
 * sensor can read erratically while it warms up), never asserted as a cause.
 *
 * Returns { podChanges: [{epoch, time}], sensorChanges: [{epoch, time}] }.
 */
export function extractDeviceEvents(rawJson) {
  const series = rawJson && rawJson.series ? rawJson.series : {};

  const dedupe = (arr) => {
    if (!Array.isArray(arr)) return [];
    const seen = new Set();
    const out = [];
    for (const e of arr) {
      const epoch = typeof e.x === 'number' ? e.x : (e.timestamp ? Math.floor(new Date(e.timestamp).getTime() / 1000) : null);
      if (epoch == null) continue;
      if (seen.has(epoch)) continue; // same timestamp = same event
      seen.add(epoch);
      out.push({ epoch, time: new Date(epoch * 1000).toISOString() });
    }
    return out.sort((a, b) => a.epoch - b.epoch);
  };

  return {
    podChanges: dedupe(series.setSiteChange),
    sensorChanges: dedupe(series.cgmSensorChange),
  };
}
