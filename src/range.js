/**
 * Range layer (now archive-backed).
 *
 * Every question is answered from the local SQLite archive. Because past days
 * are immutable, the archive only ever needs topping up:
 *
 *   1. TOP-UP: on every question, pull from the day after the newest stored
 *      COMPLETE day up to now, ingest it, and mark newly-complete days. The
 *      current (incomplete) day is always re-pulled and stored as partial, so
 *      its filling-in tail stays current. This is the small, cheap fetch.
 *
 *   2. BACKFILL: if the question reaches further back than the oldest stored
 *      reading, pull the missing older span once and ingest it. Thereafter it
 *      is permanent and never re-fetched.
 *
 *   3. SERVE: build the timeline and settings for the requested window straight
 *      from the archive and hand them to the analytics functions unchanged.
 *
 * The expensive historical pull therefore happens at most once per span, ever,
 * rather than once per container life. Glooko is touched only for genuine gaps.
 *
 * Relative date language is resolved by the model into ISO timestamps; this
 * layer only deals in ISO and epochs.
 */

import { fetchGlookoRange } from './glooko.js';
import {
  processUnifiedGlookoData,
  getActiveSettings,
  extractDailyInsulin,
  deriveBasalStates,
  extractDeviceEvents,
  extractCamapsPumpModeBreakdown,
  extractDeviceNames,
} from './analytics.js';
import {
  ensureDbReady,
  ingestTimeline,
  ingestDailyInsulin,
  ingestBasalStates,
  ingestDeviceEvents,
  markDays,
  getStreamMaxima,
  getTimeline,
  getSettingsHistory,
  getDailyInsulin,
  getBasalStates,
  getDeviceEvents,
  recordFieldCapabilities,
} from './store.js';
// sync.js imports pullAndIngest + date helpers from THIS module. The cycle is
// safe because both sides reference the imported bindings only inside functions
// invoked at call time, never during module evaluation.
import { runColdStart, withSyncLock, ensureConfiguredFloorSynced, STALENESS_THRESHOLD_SECONDS } from './sync.js';

export const CAPS = {
  summaryMaxDays: 400,
  timelineMaxDays: 21,
  bolusMaxDays: 92,
  hourlyMaxDays: 400,
};

// A request whose end is within this margin of the freshest stored reading is
// treated as already covered. CGM lags "now" by minutes, the current day is
// never complete, and sensors have short gaps, so without a tolerance every
// "today" question would refetch. Reuses sync.js's own staleness threshold
// (an hour or two) so "the data is fresh enough to skip a sync" and "the data
// is fresh enough that tools shouldn't flag it as stale" are the same
// definition of "fresh" everywhere in the codebase, rather than two separate
// numbers that could quietly drift apart.
const COVERAGE_TOLERANCE_SECONDS = STALENESS_THRESHOLD_SECONDS;

// Deliberately NOT called at module-import time (an earlier version of this
// file did `initDb()` here, unconditionally). This module is imported by
// server.js before the MCP transport is connected, so any I/O done here would
// delay the very first response to a client — including the initial
// version-negotiation handshake a client probes with before starting a real
// session. getProcessedRange() below awaits ensureDbReady() itself, on first
// actual use, so the server can answer `initialize` immediately and only
// pays this cost once real work is asked of it. See store.js's top-of-file
// comment for the full rationale (this also matters because Claude runs a
// separate copy of this server per surface — chat, Cowork, Code — so more
// than one process can be starting up against the same archive at once).

export function assertIsoDate(value, label) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(
      `${label} must be an ISO 8601 timestamp (e.g. 2026-06-19T00:00:00.000Z). Received: ${JSON.stringify(
        value
      )}`
    );
  }
  return new Date(value).toISOString();
}

export function spanDays(startISO, endISO) {
  return (Date.parse(endISO) - Date.parse(startISO)) / 86400000;
}

export function assertWithinCap(startISO, endISO, capDays, toolName) {
  const span = spanDays(startISO, endISO);
  if (span < 0) throw new Error('Start date is after end date.');
  if (span > capDays) {
    throw new Error(
      `Requested window is ${span.toFixed(
        1
      )} days, which exceeds the ${capDays}-day limit for ${toolName}. ` +
        `Request a narrower window. For wide overviews use get_diabetes_summary, ` +
        `which aggregates and tolerates long spans.`
    );
  }
}

export function dayStr(epochSeconds) {
  return new Date(epochSeconds * 1000).toISOString().split('T')[0];
}

export function startOfTodayEpochSeconds() {
  const t = new Date();
  t.setUTCHours(0, 0, 0, 0);
  return Math.floor(t.getTime() / 1000);
}

/** Complete UTC days strictly before today, within [fromEpoch, toEpoch]. */
function completeDaysInSpan(fromEpoch, toEpoch) {
  const days = [];
  const todayStart = startOfTodayEpochSeconds();
  let cursor = new Date(fromEpoch * 1000);
  cursor.setUTCHours(0, 0, 0, 0);
  let c = Math.floor(cursor.getTime() / 1000);
  while (c <= toEpoch) {
    if (c < todayStart) days.push(dayStr(c));
    c += 86400;
  }
  return days;
}

/**
 * Pull a Glooko range, normalise it, ingest it, and mark completeness.
 * Days strictly before today are marked complete; today is marked partial.
 */
export async function pullAndIngest(startISO, endISO) {
  const raw = await fetchGlookoRange(startISO, endISO);
  const timeline = processUnifiedGlookoData(raw.data1);

  // Backfill a device name onto CGM records specifically — unlike bolus
  // records, a CGM reading never carries one anywhere in data1 (see
  // extractDeviceNames's own comment for the full account of why this is
  // needed and where the name actually comes from: data3.devices, not
  // anything captureExtra() sweeps from a per-reading object). Done here,
  // not inside processUnifiedGlookoData, because that function only ever
  // receives data1 and stays deliberately free of any data3 dependency.
  const deviceNames = extractDeviceNames(raw.data3);
  if (deviceNames.cgm) {
    for (const item of timeline) {
      if (item.type === 'CGM' && (!item.extra || item.extra.deviceName == null)) {
        item.extra = { ...(item.extra || {}), deviceName: deviceNames.cgm };
      }
    }
  }

  const settings = getActiveSettings(
    raw.data3,
    Date.parse(startISO),
    Date.parse(endISO)
  );
  ingestTimeline(timeline, settings);

  // Daily insulin totals (basal/bolus/total per day) from the dailyInsulinTotals
  // block. Today is provisional; past days final. Keyed by UTC day.
  const dailyInsulin = extractDailyInsulin(raw.data1);
  // Diagnostic: surface whether the block arrived and how many days parsed.
  // stdout is the MCP channel, so this MUST go to stderr only.
  const hasBlock =
    raw.data1 && raw.data1.series && raw.data1.series.dailyInsulinTotals
      ? Object.keys(raw.data1.series.dailyInsulinTotals).length
      : 'ABSENT';
  console.error(
    `[podquery] pull ${startISO.split('T')[0]}..${endISO.split('T')[0]}: ` +
      `dailyInsulinTotals keys=${hasBlock}, parsed=${dailyInsulin.length} days`
  );
  if (dailyInsulin.length) {
    const todayUtc = new Date().toISOString().split('T')[0];
    ingestDailyInsulin(dailyInsulin, todayUtc);
    console.error(`[podquery] ingested ${dailyInsulin.length} daily-insulin rows`);
  } else {
    console.error('[podquery] NO daily-insulin rows to ingest (block absent or empty)');
  }

  // Basal delivery states (normal/suspend/max/limited), derived from the bar
  // and mode series and stored as collapsed intervals.
  const basalStates = deriveBasalStates(
    raw.data1,
    Math.floor(Date.parse(startISO) / 1000),
    Math.floor(Date.parse(endISO) / 1000)
  );
  if (basalStates.length) ingestBasalStates(basalStates);

  // Device events: pod (setSiteChange) and sensor (cgmSensorChange) changes,
  // deduplicated by timestamp.
  const deviceEvents = extractDeviceEvents(raw.data1);
  if (deviceEvents.podChanges.length || deviceEvents.sensorChanges.length) {
    ingestDeviceEvents(deviceEvents);
  }

  const fromEpoch = Math.floor(Date.parse(startISO) / 1000);
  const toEpoch = Math.floor(Date.parse(endISO) / 1000);
  const complete = completeDaysInSpan(fromEpoch, toEpoch);
  if (complete.length) markDays(complete, true);

  // Mark today partial if the window reached into it.
  const todayStart = startOfTodayEpochSeconds();
  if (toEpoch >= todayStart) markDays([dayStr(todayStart)], false);

  // Opportunistic capability capture for Glooko's per-window stats blob
  // (data2) — it's never archived (see getProcessedRange's stats: null), so
  // this is the only place its fields' presence can ever be recorded as a
  // byproduct of a normal sync (DESIGN.md section 2a). Confirms whether this
  // account has CamAPS pump-mode data at all, independent of whatever
  // window the CALLER asked for — the module-registration check just needs
  // "has this ever been seen," not this call's own numbers.
  if (raw.data2) {
    recordFieldCapabilities('stats', raw.data2, Math.floor(Date.now() / 1000));
  }

  return { rawStats: raw.data2 };
}

/**
 * Live fetch of the CamAPS pump-mode breakdown for an exact window. Unlike
 * every other tool in this project, this one CANNOT be served from the
 * local archive — Glooko computes these percentages server-side for
 * whatever window is requested, and range.js deliberately never persists
 * that blob (see getProcessedRange's stats: null and analytics.js's
 * extractCamapsPumpModeBreakdown for the fuller rationale). Returns null in
 * offline mode (no Glooko credentials) or if this account's data has none
 * of these fields.
 */
export async function fetchCamapsPumpModeBreakdown(startISO, endISO) {
  if (!glookoConfigured()) return null;
  await ensureDbReady();
  const raw = await fetchGlookoRange(startISO, endISO);
  if (raw.data2) {
    recordFieldCapabilities('stats', raw.data2, Math.floor(Date.now() / 1000));
  }
  return extractCamapsPumpModeBreakdown(raw.data2);
}

/**
 * Whether Glooko credentials are configured. When they are NOT, the server runs
 * in OFFLINE / ARCHIVE-ONLY mode: it never logs in, never fetches, and serves
 * only whatever is already in the shipped database. This is the master switch
 * that makes it safe to distribute a prebuilt DB (e.g. example data) without
 * the server trying to mutate it on a machine that has no credentials.
 */
export function glookoConfigured() {
  return Boolean(
    process.env.GLOOKO_EMAIL &&
      process.env.GLOOKO_PASSWORD &&
      process.env.GLOOKO_EMAIL.trim() &&
      process.env.GLOOKO_PASSWORD.trim()
  );
}

/**
 * Ensure the archive covers up to "now" and back to the requested start,
 * pulling only the gaps. Returns Glooko's stats blob ONLY when a fresh pull
 * exactly matching the requested window happened (so insulin/carb aggregates
 * are trustworthy for that window); otherwise null, and the caller computes
 * everything from the archived timeline.
 */
async function ensureCoverage(startISO, endISO) {
  // OFFLINE / ARCHIVE-ONLY: no credentials means never contact Glooko. Serve
  // exactly what is in the database. This is the single gate that guarantees a
  // shipped example DB is never mutated and no login is ever attempted.
  if (!glookoConfigured()) return;

  const reqStartEpoch = Math.floor(Date.parse(startISO) / 1000);
  const reqEndEpoch = Math.floor(Date.parse(endISO) / 1000);

  const { coverageEpoch } = getStreamMaxima();

  // COLD START: archive empty. Year-batched, recent-first historical load.
  // This call only WAITS for enough history to cover THIS request
  // (reqStartEpoch) — see coldStart()'s comment for why: waiting for the
  // entire configured OMNI_OLDEST_DATE range up front is slow enough to trip
  // an MCP client's tool-call timeout. The rest of the configured history
  // still gets pulled — runColdStart schedules it as a background
  // continuation once this call's own lock is released, so it lands in the
  // archive without this (or any single) question having to wait for it.
  // Owned by the sync module (locked).
  if (coverageEpoch === null) {
    await runColdStart((m) => console.error(`[podquery] ${m}`), reqStartEpoch);
    return;
  }

  if (reqEndEpoch > coverageEpoch + COVERAGE_TOLERANCE_SECONDS) {
    // NEWER GAP: the question reaches MEANINGFULLY past our freshest stored data
    // (e.g. asking about today when the archive stops two days ago). CGM always
    // lags "now" by a few minutes and the current day is never "complete", so a
    // tolerance prevents every "today" question from triggering a needless pull;
    // only a real gap (older than the tolerance) fetches. Pull just the missing
    // tail, keyed off the OLDEST stream max so a lagging stream is included, with
    // a short trailing overlap to refresh the partial boundary day.
    const TOPUP_TRAILING = 2 * 86400;
    const from = Math.max(0, coverageEpoch - TOPUP_TRAILING);
    await withSyncLock(() =>
      pullAndIngest(
        new Date(from * 1000).toISOString(),
        new Date(reqEndEpoch * 1000).toISOString()
      )
    );
  }

  // CONFIGURED-FLOOR CHECK: the ONLY thing that reopens fetching further back
  // than what this archive already has confirmed is the OMNI_OLDEST_DATE
  // setting itself having been lowered since the last sync — NOT a question
  // asking about an old period. A request for a date before the configured
  // floor is simply answered from whatever the archive already holds (its
  // reportRange will reflect that honestly); it never itself triggers a
  // Glooko pull. This is deliberate: reacting to a query's date range is what
  // caused the runaway-backfill failure mode fixed earlier, and it means
  // asking about the same old period twice is free the second time, every
  // time, with no surprise network activity. See
  // sync.js's ensureConfiguredFloorSynced for the full rationale.
  await ensureConfiguredFloorSynced((m) => console.error(`[podquery] ${m}`));
}

/**
 * Public entry point used by the tools. Tops up + backfills as needed, then
 * builds the window straight from the archive.
 *
 * Returns { startDate, endDate, timeline, stats, settingsHistory, servedFromArchive, statsAreForWiderRange }.
 *
 * stats is always null here (the archive does not keep Glooko's pre-aggregated
 * statistics blob, by design), so computeSummary will recompute insulin/carb
 * aggregates from the archived bolus rows. statsAreForWiderRange is therefore
 * always false: every figure is computed for exactly the requested window.
 */
export async function getProcessedRange(startISO, endISO) {
  // Lazy DB bootstrap: see the comment above this file's imports for why this
  // is here (on first real use) rather than at module-import time.
  await ensureDbReady();
  await ensureCoverage(startISO, endISO);

  const sEpoch = Math.floor(Date.parse(startISO) / 1000);
  const eEpoch = Math.floor(Date.parse(endISO) / 1000);
  const timeline = getTimeline(sEpoch, eEpoch);
  const settingsHistory = getSettingsHistory(sEpoch, eEpoch);
  const dailyInsulin = getDailyInsulin(sEpoch, eEpoch);
  const basalStates = getBasalStates(sEpoch, eEpoch);
  const deviceEvents = getDeviceEvents(sEpoch, eEpoch);

  return {
    startDate: startISO,
    endDate: endISO,
    timeline,
    stats: null,
    settingsHistory,
    dailyInsulin,
    basalStates,
    deviceEvents,
    servedFromArchive: true,
    statsAreForWiderRange: false,
  };
}
