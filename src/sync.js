/**
 * Sync engine.
 *
 * One shared module for getting Glooko data into the archive, used by both the
 * MCP server (on its first tool call, and on explicit refresh) and the
 * standalone warm-up CLI. Having a single engine means the cold-start, top-up
 * and staleness logic is identical however it is triggered, so there is one
 * code path to trust.
 *
 * Design decisions (see the long discussion that produced this):
 *
 *  - COLD START walks forward from an env floor date (OMNI_OLDEST_DATE) in
 *    one-year batches, so no single Glooko request spans a huge range. It is
 *    RECENT-FIRST: the most recent batch is pulled and ingested before the
 *    older history, so the very first question is answerable quickly while the
 *    backfill continues.
 *
 *  - TOP-UP keys off the OLDEST of the per-stream maxima (store.getStreamMaxima
 *    -> coverageEpoch), NOT CGM recency alone. If one stream lagged a Glooko
 *    sync, keying off CGM would leave it permanently behind. A short trailing
 *    re-pull window also corrects late/provisional boundary readings.
 *
 *  - An in-process LOCK (syncInProgress) serialises everything. A query that
 *    arrives mid-pull awaits the same promise rather than starting a second
 *    Glooko session or reading a half-written DB. This is the single safeguard
 *    that makes background backfill and foreground reads coexist safely.
 *
 *  - STALENESS is reported, never auto-actioned mid-session. Tools call
 *    describeStaleness() and surface the flag; the user chooses to refresh,
 *    which calls topUp() (same engine). The only automatic pull is the one at
 *    first-call cold start / initial top-up.
 */

import { pullAndIngest } from './range.js';
import {
  getStreamMaxima,
  getNewestDataEpoch,
  getEarliestCgmEpoch,
  getCgmCount,
  getOldestSyncedEpoch,
  setOldestSyncedEpoch,
} from './store.js';

const YEAR_SECONDS = 365 * 86400;
// Default amount of history to acquire on a fresh install when OMNI_OLDEST_DATE
// is not set: 3 months back from "now" (computed at runtime). This keeps a
// first run fast and is the amount shipped in the example database. Users who
// want more set OMNI_OLDEST_DATE to an earlier date to override it.
const DEFAULT_HISTORY_SECONDS = 90 * 86400;

// How stale (seconds) the newest data may be before tools warn the user.
// Two hours, per the spec: long enough not to nag during a working session,
// short enough to catch a server that has been idle.
export const STALENESS_THRESHOLD_SECONDS = 2 * 60 * 60;

// Trailing window always re-pulled on a top-up, so the partial current day and
// any late boundary readings are refreshed even if "coverage" looks current.
const TOPUP_TRAILING_SECONDS = 2 * 86400;

// Stop the cold-start backfill after this many CONSECUTIVE empty year-batches,
// so a user who sets OMNI_OLDEST_DATE far too early does not trigger an endless
// walk through years Glooko has no data for.
const MAX_EMPTY_BATCHES = 2;

// --- the lock -------------------------------------------------------------
// A single in-flight sync promise. Anything that would pull awaits this first.
let syncInProgress = null;

/**
 * Run `fn` under the sync lock. If a sync is already running, await THAT one
 * instead of starting a second (the caller still gets a resolved promise when
 * the in-flight work finishes). Returns whatever the active run returns.
 */
export function withSyncLock(fn) {
  if (syncInProgress) return syncInProgress;
  syncInProgress = (async () => {
    try {
      return await fn();
    } finally {
      syncInProgress = null;
    }
  })();
  return syncInProgress;
}

/** True if a sync is currently running. */
export function isSyncing() {
  return syncInProgress !== null;
}

// --- env floor date -------------------------------------------------------

/**
 * The oldest date the cold start will reach back to, from OMNI_OLDEST_DATE.
 * Validated hard: a malformed value would corrupt every batch boundary, so we
 * fail loudly rather than silently defaulting to an absurd range. If unset,
 * falls back to 3 months before today (computed from the current system date at
 * runtime), which is the amount shipped in the example database.
 */
export function resolveOldestEpoch() {
  const raw = process.env.OMNI_OLDEST_DATE;
  if (!raw || !raw.trim()) {
    // Default floor: 3 months before today, using the current system date.
    return Math.floor(Date.now() / 1000) - DEFAULT_HISTORY_SECONDS;
  }
  const parsed = Date.parse(raw.trim());
  if (Number.isNaN(parsed)) {
    throw new Error(
      `OMNI_OLDEST_DATE is not a valid date: ${JSON.stringify(raw)}. ` +
        `Use an ISO date like 2024-01-01.`
    );
  }
  const epoch = Math.floor(parsed / 1000);
  const now = Math.floor(Date.now() / 1000);
  if (epoch > now) {
    throw new Error(
      `OMNI_OLDEST_DATE (${raw}) is in the future. It must be a past date.`
    );
  }
  return epoch;
}

// --- batch helpers --------------------------------------------------------

/**
 * Build forward-walking one-year [startEpoch, endEpoch] batches spanning
 * [fromEpoch, toEpoch]. The final batch is clamped to toEpoch. Batches abut;
 * idempotent ingest tolerates the shared boundary day.
 */
export function yearBatches(fromEpoch, toEpoch) {
  const batches = [];
  let cursor = fromEpoch;
  while (cursor < toEpoch) {
    const end = Math.min(cursor + YEAR_SECONDS, toEpoch);
    batches.push([cursor, end]);
    cursor = end;
  }
  return batches;
}

const iso = (epoch) => new Date(epoch * 1000).toISOString();

/**
 * Pull one batch and report whether it produced any NEW stored CGM rows. Used
 * by the cold start to detect runs of empty (pre-history) batches. Compares the
 * exact CGM row count before and after, so detection is unambiguous (the
 * earliest-epoch heuristic could misfire on abutting boundaries).
 */
async function pullBatch(startEpoch, endEpoch) {
  const before = getCgmCount();
  await pullAndIngest(iso(startEpoch), iso(endEpoch));
  const after = getCgmCount();
  return after > before;
}

// --- cold start / backfill: shared batch-walking engine --------------------

// Hard cap on how many year-batches a SINGLE on-demand call (the part a tool
// call actually waits on) will pull before handing the rest off to a
// background continuation. Without this, a genuinely deep, densely-populated
// gap (a real account with many continuous years of real history) would
// still walk every batch in one tool call no matter how long that takes.
const MAX_BATCHES_PER_CALL = 3;

/**
 * Walk a list of pre-ordered [startEpoch, endEpoch] batches (newest-first),
 * pulling each in turn, and stop early for any of three reasons:
 *
 *   - MAX_EMPTY_BATCHES consecutive empty pulls: reached pre-history (older
 *     than this account's actual data). Nothing further back is worth
 *     trying, so `remaining` comes back empty.
 *   - requiredFromEpoch reached (a batch's start <= requiredFromEpoch): the
 *     immediate question that triggered this walk is now answerable.
 *     Everything past this point is returned as `remaining`.
 *   - maxBatchesThisCall pulled: a hard cap on how much ONE call does, so a
 *     single tool call's worst-case latency is bounded even when every
 *     batch has real data (so the empty-batch heuristic never fires).
 *     Everything past this point is also returned as `remaining`.
 *
 * Returns { remaining, consecutiveEmpty, reachedEpoch } so a caller can hand
 * `remaining` to continueInBackground() to pick up exactly where this left
 * off (without making the original caller wait for it), and can hand
 * `reachedEpoch` to recordOldestSynced() once nothing remains — reachedEpoch
 * is the start of the OLDEST batch this walk actually attempted, i.e. how
 * far back it got (whether or not that batch had data).
 */
async function walkBatches(orderedBatches, onProgress, opts = {}) {
  const {
    requiredFromEpoch = null,
    maxBatchesThisCall = Infinity,
    startConsecutiveEmpty = 0,
  } = opts;

  let consecutiveEmpty = startConsecutiveEmpty;
  let reachedEpoch = null;
  for (let i = 0; i < orderedBatches.length; i++) {
    if (i >= maxBatchesThisCall) {
      onProgress(
        `  pausing after ${maxBatchesThisCall} batches for this call; continuing further ` +
          `back in the background so this question doesn't wait for it`
      );
      return { remaining: orderedBatches.slice(i), consecutiveEmpty, reachedEpoch };
    }
    const [s, e] = orderedBatches[i];
    onProgress(
      `batch ${i + 1}/${orderedBatches.length}: ${iso(s).split('T')[0]} .. ${iso(e).split('T')[0]}`
    );
    const produced = await pullBatch(s, e);
    reachedEpoch = s;
    if (produced) {
      consecutiveEmpty = 0;
    } else {
      consecutiveEmpty += 1;
      onProgress(`  (no data in batch; ${consecutiveEmpty} consecutive empty)`);
      if (consecutiveEmpty >= MAX_EMPTY_BATCHES) {
        onProgress(
          `  stopping: ${MAX_EMPTY_BATCHES} consecutive empty batches (reached pre-history)`
        );
        return { remaining: [], consecutiveEmpty, reachedEpoch };
      }
    }

    // Stop as soon as we have pulled back far enough to cover the question
    // that triggered this walk. Newest-first order means every batch pulled
    // so far is at least this fresh, so the archive already answers it.
    // Anything OLDER than this is handed to continueInBackground() by the
    // caller, rather than making this call wait for it — without this, a
    // deep OMNI_OLDEST_DATE (or a wide orientation query) makes the
    // question wait for far more history than it actually needed before
    // answering, easily slow enough to trip an MCP client's tool-call
    // timeout.
    if (requiredFromEpoch !== null && s <= requiredFromEpoch) {
      return { remaining: orderedBatches.slice(i + 1), consecutiveEmpty, reachedEpoch };
    }
  }
  return { remaining: [], consecutiveEmpty, reachedEpoch };
}

/**
 * Record how far back the archive is now confirmed backfilled, only ever
 * moving the marker EARLIER (never letting one run's result regress it
 * forward past what an earlier run already established).
 */
function recordOldestSynced(reachedEpoch) {
  if (reachedEpoch == null) return;
  const current = getOldestSyncedEpoch();
  if (current === null || reachedEpoch < current) {
    setOldestSyncedEpoch(reachedEpoch);
  }
}

/**
 * Fire-and-forget continuation of a batch walk that stopped early only
 * because it had done enough for the moment (maxBatchesThisCall reached, or
 * requiredFromEpoch satisfied) — NOT because it hit pre-history. Runs under
 * the normal sync lock so it cannot race a later foreground pull, but is
 * never awaited by the caller that kicked it off, so the tool call that
 * triggered the original walk gets its answer immediately while this keeps
 * working in the background toward full coverage back to OMNI_OLDEST_DATE.
 *
 * MUST be called only AFTER the withSyncLock() call that produced `remaining`
 * has itself resolved (i.e. from runColdStart/runBackfillGap, never from
 * inside coldStart/backfillGap itself) — calling withSyncLock() while still
 * nested inside an in-flight locked call just returns that same in-flight
 * promise without running this continuation at all, since the lock is still
 * held by the outer call at that point.
 */
function continueInBackground(remaining, consecutiveEmpty, onProgress, label) {
  if (!remaining || !remaining.length) return;
  withSyncLock(() =>
    walkBatches(remaining, (m) => onProgress(`[background ${label}] ${m}`), {
      startConsecutiveEmpty: consecutiveEmpty,
    })
  )
    .then(({ reachedEpoch }) => {
      // No maxBatchesThisCall is passed above, so this walk always runs
      // `remaining` to completion (either exhausting it or hitting
      // MAX_EMPTY_BATCHES) — there is no further "remaining" to chase here.
      recordOldestSynced(reachedEpoch);
    })
    .catch((err) => {
      console.error(`[superglookoquery] background ${label} failed: ${err.message}`);
    });
}

// --- cold start -----------------------------------------------------------

/**
 * Full historical load for an empty archive. RECENT-FIRST: pulls the most
 * recent year batch first (so the first question is answerable), then walks
 * the remaining batches from newest to oldest, stopping after
 * MAX_EMPTY_BATCHES consecutive empty pulls (older than the user actually
 * has data for).
 *
 * Caller is responsible for the lock (use runColdStart, which wraps this AND
 * schedules the background continuation — see continueInBackground's doc).
 * onProgress(msg) is optional, used by the CLI to log.
 */
export async function coldStart(onProgress = () => {}, requiredFromEpoch = null) {
  const oldest = resolveOldestEpoch();
  const now = Math.floor(Date.now() / 1000);
  const batches = yearBatches(oldest, now);
  if (!batches.length) return { remaining: [], consecutiveEmpty: 0, reachedEpoch: null };

  const ordered = [...batches].reverse(); // newest-first
  return walkBatches(ordered, onProgress, { requiredFromEpoch });
}

/**
 * Pull a bounded historical gap in year-sized batches, walking backward from
 * the NEWEST edge of the gap (closest to data already known-good) toward the
 * oldest requested edge — mirroring coldStart's recent-first walk. This
 * makes the MAX_EMPTY_BATCHES heuristic meaningful here too: consecutive
 * empty batches, approached from the known-data side, reliably means
 * "reached before this account's real history began," exactly as it does in
 * coldStart. Used by ensureConfiguredFloorSynced() below (via runBackfillGap,
 * which also schedules the background continuation) — NOT triggered by an
 * individual question's requested start date (see that function's comment
 * for why: a query about an old period must never itself reopen fetching).
 *
 * The per-call cap exists because of a real incident: a wide "orientation"
 * call (e.g. start 2000-01-01, per get_diabetes_summary's own description
 * tip) issued against a real account walked EVERY intervening empty year
 * sequentially — one Glooko request per year, all the way from 2000 to the
 * account's actual history start — with nothing to stop it. That is dozens
 * of sequential requests for a single tool call, easily enough to exceed an
 * MCP client's patience and surface as a generic "Failed to call tool" with
 * no useful error message at all (the process was still working; it just
 * never got the chance to finish before the client gave up).
 */
export async function backfillGap(fromEpoch, toEpoch, onProgress = () => {}) {
  const batches = yearBatches(fromEpoch, toEpoch);
  const ordered = [...batches].reverse(); // newest-first
  return walkBatches(ordered, onProgress, { maxBatchesThisCall: MAX_BATCHES_PER_CALL });
}

// --- top-up ---------------------------------------------------------------

/**
 * Bring an existing archive up to now. Pulls from the OLDEST stream max (so a
 * lagging stream is caught) minus a trailing safety window, up to now. No-op
 * for the historical portion if everything is already current; the trailing
 * window is always re-pulled so the partial day and late readings refresh.
 *
 * Caller holds the lock (use runTopUp).
 */
export async function topUp(onProgress = () => {}) {
  const { coverageEpoch } = getStreamMaxima();
  const now = Math.floor(Date.now() / 1000);

  if (coverageEpoch === null) {
    // Empty archive: this is really a cold start.
    onProgress('archive empty; performing cold start instead of top-up');
    await coldStart(onProgress);
    return;
  }

  const start = Math.max(0, coverageEpoch - TOPUP_TRAILING_SECONDS);
  if (now <= start) {
    onProgress('archive already current; nothing to top up');
    return;
  }
  onProgress(`top-up: ${iso(start).split('T')[0]} .. ${iso(now).split('T')[0]}`);
  await pullAndIngest(iso(start), iso(now));
}

// --- locked public entry points -------------------------------------------

/**
 * Cold start under the lock. Answers the triggering question as soon as
 * enough history is pulled (bounded by requiredFromEpoch), then — once the
 * lock from THIS call has been released — schedules any remaining history
 * back to OMNI_OLDEST_DATE as a background continuation, so the full
 * configured history still ends up in the archive without the original
 * question having to wait for it.
 */
export async function runColdStart(onProgress = () => {}, requiredFromEpoch = null) {
  const { remaining, consecutiveEmpty, reachedEpoch } = await withSyncLock(() =>
    coldStart(onProgress, requiredFromEpoch)
  );
  if (!remaining.length) {
    recordOldestSynced(reachedEpoch);
  } else {
    continueInBackground(remaining, consecutiveEmpty, onProgress, 'cold-start');
  }
}

/**
 * On-demand backfill under the lock (see backfillGap's doc), used only by
 * ensureConfiguredFloorSynced() below. Answers with whatever this call's
 * batch cap allows, then continues the rest in the background, recording the
 * oldest-synced marker once nothing remains either way.
 */
export async function runBackfillGap(fromEpoch, toEpoch, onProgress = () => {}) {
  const { remaining, consecutiveEmpty, reachedEpoch } = await withSyncLock(() =>
    backfillGap(fromEpoch, toEpoch, onProgress)
  );
  if (!remaining.length) {
    recordOldestSynced(reachedEpoch);
  } else {
    continueInBackground(remaining, consecutiveEmpty, onProgress, 'backfill');
  }
}

/**
 * The ONLY thing that may reopen backfilling further back than what this
 * archive already has: the OMNI_OLDEST_DATE config itself being lowered (or
 * the oldest-synced marker being unknown — a brand-new marker on an archive
 * that predates it). An individual question's requested start date, however
 * old, NEVER by itself triggers a new historical pull — it is simply
 * answered from whatever the archive already holds. This is the explicit,
 * intentional trade the user asked for: once the configured floor has been
 * reached, repeatedly asking about old periods costs nothing (no surprise
 * Glooko calls, no risk of the runaway-backfill failure mode this project
 * has already hit twice), and the only way to see further history is to
 * lower the "History to load" setting.
 *
 * Called on every question once the archive is non-empty (see range.js's
 * ensureCoverage) — cheap when there's nothing to do: two epoch comparisons
 * and, at most, one DB read.
 */
export async function ensureConfiguredFloorSynced(onProgress = () => {}) {
  const configuredFloor = resolveOldestEpoch();
  const oldestSynced = getOldestSyncedEpoch();
  if (oldestSynced !== null && configuredFloor >= oldestSynced) {
    return; // already covers the configured floor (or it was raised); nothing to do
  }
  const earliest = getEarliestCgmEpoch();
  if (earliest === null) return; // no data yet at all; cold start owns this case
  if (configuredFloor >= earliest) {
    // Already have data back to (or past) the configured floor — just not
    // marked yet (e.g. an archive from before this marker existed, or the
    // config was raised back up after being lowered). Record it so this
    // cheap check doesn't need to re-derive the answer on every question.
    recordOldestSynced(Math.min(earliest, configuredFloor));
    return;
  }
  // The config asks for MORE history than we have confirmed. This is the one
  // deliberate exception to "never pull older data because of a question":
  // the exception here is a CONFIG change, not a question's date range.
  await runBackfillGap(configuredFloor, earliest, onProgress);
}

/** Top-up under the lock. */
export function runTopUp(onProgress) {
  return withSyncLock(() => topUp(onProgress));
}

/**
 * First-call entry for the server: if the archive is empty, cold start;
 * otherwise top up. Returns when the archive is usable. If a sync is already
 * running (e.g. a background cold start), awaits it rather than duplicating.
 */
export function ensureFreshOnFirstCall(onProgress = () => {}) {
  return withSyncLock(async () => {
    const { coverageEpoch } = getStreamMaxima();
    if (coverageEpoch === null) {
      await coldStart(onProgress);
    } else {
      await topUp(onProgress);
    }
  });
}

// --- staleness reporting --------------------------------------------------

/**
 * Describe how fresh the archive is, for tools to surface to the user. Never
 * triggers a pull. Returns:
 *   { newestEpoch, ageSeconds, ageHours, stale, hint } or
 *   { empty: true, ... } when there is no data at all.
 */
export function describeStaleness() {
  const newest = getNewestDataEpoch();
  if (newest === null) {
    return {
      empty: true,
      stale: true,
      hint: 'No data has been loaded yet. Ask to load data to populate the archive.',
    };
  }
  const now = Math.floor(Date.now() / 1000);
  const ageSeconds = Math.max(0, now - newest);
  const ageHours = Math.round((ageSeconds / 3600) * 10) / 10;
  const stale = ageSeconds > STALENESS_THRESHOLD_SECONDS;
  return {
    empty: false,
    newestEpoch: newest,
    newestIso: iso(newest),
    ageSeconds,
    ageHours,
    stale,
    syncing: isSyncing(),
    hint: stale
      ? `Data is ${ageHours}h old. Ask to refresh to pull the latest from Glooko.`
      : undefined,
  };
}
