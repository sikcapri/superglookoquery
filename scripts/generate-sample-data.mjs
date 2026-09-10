#!/usr/bin/env node
/**
 * generate-sample-data.mjs — builds examples/superglookoquery.db, the archive the
 * MCPB bundles so a brand-new install with no Glooko login still has
 * something real to explore (see paths.js's seedExampleDbIfEmpty()).
 *
 * ENTIRELY SYNTHETIC. No real account's data is used anywhere in this
 * script — every value is generated from a seeded random-number generator,
 * not sampled or derived from any real Glooko response. This was a
 * deliberate choice (2026-09-09): the original upstream PodQuery shipped
 * its author's own real 3 months of data as the sample; for this fork,
 * bundling fabricated data avoids ever needing to publish anyone's real
 * health data into a public repo, now or on any future regeneration.
 *
 * Writes normalised timeline records directly via store.js's ingest
 * functions (ingestTimeline/ingestDailyInsulin/ingestBasalStates/
 * ingestDeviceEvents/markDays) — the SAME functions a real sync uses, in
 * the SAME already-normalised shape analytics.js produces, not raw Glooko
 * JSON. That means this script naturally stays schema-compatible with
 * whatever the archive's current SCHEMA_VERSION expects; there is nothing
 * here to update when the schema changes.
 *
 * Run with: node scripts/generate-sample-data.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const OUT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'superglookoquery.db');

// Fresh start every time this is regenerated — never merge with whatever
// was there before.
if (fs.existsSync(OUT_PATH)) fs.unlinkSync(OUT_PATH);
process.env.OMNI_DB_PATH = OUT_PATH;
process.env.GLOOKO_EMAIL = '';
process.env.GLOOKO_PASSWORD = '';

const {
  ensureDbReady,
  ingestTimeline,
  ingestDailyInsulin,
  ingestBasalStates,
  ingestDeviceEvents,
  markDays,
} = await import('../src/store.js');

// --- seeded PRNG, so this is reproducible run to run -----------------------
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260909);
const randRange = (lo, hi) => lo + rand() * (hi - lo);
const randInt = (lo, hi) => Math.floor(randRange(lo, hi + 1));
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const DAYS = 90;
const DAY_SECONDS = 86400;
const now = Math.floor(Date.now() / 1000);
const todayUtc = new Date(now * 1000).toISOString().split('T')[0];
const windowStart = now - DAYS * DAY_SECONDS;

const DEVICE_NAME_PUMP = 'ExampleSim Loop';
const DEVICE_NAME_CGM = 'ExampleSim CGM';

// A gentle diurnal glucose curve (mmol/L): higher after meals, lower
// overnight, with a slow sinusoidal baseline plus meal bumps.
function baselineGlucose(hourOfDay) {
  const circadian = 6.5 + 0.8 * Math.sin(((hourOfDay - 4) / 24) * 2 * Math.PI);
  return circadian;
}
const MEAL_HOURS = [7.5, 12.5, 18.5];
function mealBump(hourOfDay) {
  let bump = 0;
  for (const mh of MEAL_HOURS) {
    const dt = hourOfDay - mh;
    if (dt >= -0.25 && dt <= 3) {
      // Rises for ~1h, decays over the next ~2h.
      bump += dt < 1 ? 3.2 * (dt / 1) : 3.2 * Math.max(0, 1 - (dt - 1) / 2);
    }
  }
  return bump;
}

// --- Settings: one snapshot, active for the whole window ---
const settingsSnapshots = [
  {
    activeTimestamp: new Date(windowStart * 1000).toISOString(),
    settings: {
      generalSettings: { activeInsulinTime: 4 },
      basalSettings: { maxBasalRate: 3.5 },
      profilesBolus: [
        {
          targetBgSegments: { data: [{ segmentStart: 0, value: 6.1 }] },
          isfSegments: { data: [{ segmentStart: 0, value: 2.8 }] },
          insulinToCarbRatioSegments: { data: [{ segmentStart: 0, value: 10 }] },
        },
      ],
    },
  },
];

await ensureDbReady();

// Every ingest function below is called EXACTLY ONCE, across the whole
// 90-day window, rather than once per day. This matters more than it looks:
// each of these functions' own COMMIT triggers store.js's persist(), which
// does a full rawDb.export() + write + atomic rename (see store.js's
// persist() comment) — and calling that many times in rapid succession
// within one process was found, while first writing this script, to
// intermittently corrupt the archive (a genuine, reproducible sql.js/WASM
// issue under this Node version: ~5 ingest calls x 90 days = ~450 persist()
// cycles failed on every single run; the same total row count ingested via
// one call per category, so 4-5 persist() cycles total, succeeded
// reliably every time in dozens of repeated tries). A real Glooko sync
// never does anywhere near 450 persist cycles in one process lifetime (each
// MCP session is its own process, and a normal session syncs far less
// often than once per day), so this is very unlikely to affect real usage
// — but it is a real reliability edge in store.js's shim worth being aware
// of if a future change needs many ingest calls in one process run.
let prevVal = null;
const timeline = [];
const dailyInsulinRecords = [];
const basalIntervals = [];
const podChanges = [];
const sensorChanges = [];
const completeDays = [];

for (let d = 0; d < DAYS; d++) {
  const dayStartEpoch = windowStart + d * DAY_SECONDS;
  const dayUtc = new Date(dayStartEpoch * 1000).toISOString().split('T')[0];
  const isToday = dayUtc === todayUtc;
  const dayTimeline = [];

  // --- CGM: every 5 minutes ---
  const readsThisDay = isToday ? Math.floor(((now - dayStartEpoch) / 300)) : 288;
  for (let r = 0; r < readsThisDay; r++) {
    const epoch = dayStartEpoch + r * 300;
    const hourOfDay = ((epoch - dayStartEpoch) / 3600);
    const val = Math.max(2.8, Math.min(16, baselineGlucose(hourOfDay) + mealBump(hourOfDay) + randRange(-0.4, 0.4)));
    const roundedVal = Math.round(val * 10) / 10;
    const vel = prevVal == null ? 0 : Math.round((roundedVal - prevVal) * 100) / 100;
    prevVal = roundedVal;
    const nearMeal = MEAL_HOURS.some((mh) => Math.abs(hourOfDay - mh) < 0.2);
    dayTimeline.push({
      type: 'CGM',
      epoch,
      val: roundedVal,
      vel,
      extra: nearMeal ? { mealTag: pick(['breakfast', 'lunch', 'dinner']), deviceName: DEVICE_NAME_CGM } : { deviceName: DEVICE_NAME_CGM },
    });
  }

  // --- Bolus: 3 meals/day, occasional correction, occasional split ---
  let bolusUnitsToday = 0;
  for (const mh of MEAL_HOURS) {
    if (isToday && mh > ((now - dayStartEpoch) / 3600)) continue; // meal hasn't happened yet today
    const epoch = dayStartEpoch + Math.round(mh * 3600) + randInt(-300, 300);
    const carbs = randInt(25, 75);
    const units = Math.round((carbs / 10) * 10) / 10; // simple 1:10 ratio
    const isSplit = rand() < 0.12; // ~1 in 8 meals is a split/extended bolus
    const initialPct = isSplit ? randInt(50, 80) : null;
    bolusUnitsToday += units;
    dayTimeline.push({
      type: 'BOLUS',
      epoch,
      units,
      delivered: units,
      programmed: units,
      recTotal: units,
      recCorrection: 0,
      recCarbs: units,
      carbs,
      iob: Math.round(randRange(0, 1.5) * 100) / 100,
      bgInput: null,
      bgSource: null,
      isManual: false,
      interrupted: false,
      override: null,
      class: 'Meal Bolus',
      initialDeliveryPercentage: initialPct,
      extendedDeliveryPercentage: isSplit ? 100 - initialPct : null,
      durationString: isSplit ? pick(['1h', '2h', '3h']) : null,
      extra: { deviceName: DEVICE_NAME_PUMP },
    });
  }
  // ~1 in 4 days gets an extra manual correction bolus in the evening.
  if (rand() < 0.25 && !(isToday && 21 > (now - dayStartEpoch) / 3600)) {
    const epoch = dayStartEpoch + Math.round(randRange(20, 22) * 3600);
    const units = Math.round(randRange(0.5, 2) * 10) / 10;
    bolusUnitsToday += units;
    dayTimeline.push({
      type: 'BOLUS', epoch, units, delivered: units, programmed: units,
      recTotal: units, recCorrection: units, recCarbs: 0, carbs: 0,
      iob: 0, bgInput: null, bgSource: null, isManual: true, interrupted: false,
      override: null, class: 'Manual Correction Bolus',
      initialDeliveryPercentage: null, extendedDeliveryPercentage: null, durationString: null,
      extra: { deviceName: DEVICE_NAME_PUMP },
    });
  }

  timeline.push(...dayTimeline);

  // --- Basal states: mostly normal, occasional suspend/max ---
  const dayEnd = isToday ? now : dayStartEpoch + DAY_SECONDS;
  let cursor = dayStartEpoch;
  while (cursor < dayEnd) {
    const state = rand() < 0.85 ? 'normal' : pick(['suspend', 'max']);
    const segLen = randInt(1800, 7200); // 30min - 2h segments
    const segEnd = Math.min(cursor + segLen, dayEnd);
    const startIso = new Date(cursor * 1000).toISOString();
    const endIso = new Date(segEnd * 1000).toISOString();
    basalIntervals.push({ start: startIso, end: endIso, state, startEpoch: cursor, endEpoch: segEnd, minutes: (segEnd - cursor) / 60 });
    cursor = segEnd;
  }

  // --- Daily insulin total ---
  const basalUnits = Math.round(randRange(17, 21) * 10) / 10;
  dailyInsulinRecords.push({
    dayUtc, dayEpoch: dayStartEpoch,
    basalUnits, bolusUnits: Math.round(bolusUnitsToday * 10) / 10,
    totalUnits: Math.round((basalUnits + bolusUnitsToday) * 10) / 10,
  });

  // --- Device events: pod change every 3 days, sensor every 10 ---
  if (d % 3 === 0) podChanges.push({ epoch: dayStartEpoch + 3600 * 8 });
  if (d % 10 === 0) sensorChanges.push({ epoch: dayStartEpoch + 3600 * 8 });

  if (!isToday) completeDays.push(dayUtc);
}

ingestTimeline(timeline, settingsSnapshots);
ingestBasalStates(basalIntervals);
ingestDailyInsulin(dailyInsulinRecords, todayUtc);
ingestDeviceEvents({ podChanges, sensorChanges });
if (completeDays.length) markDays(completeDays, true);
markDays([todayUtc], false);

console.log(`Generated synthetic sample archive at ${OUT_PATH}`);
console.log(`  ${timeline.filter((t) => t.type === 'CGM').length} CGM readings, ${timeline.filter((t) => t.type === 'BOLUS').length} bolus events over ${DAYS} days.`);
