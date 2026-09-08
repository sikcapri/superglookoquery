/**
 * Persistent store (SQLite via sql.js — a pure WebAssembly build of SQLite).
 *
 * sql.js was chosen deliberately over Node's built-in node:sqlite or a native
 * addon like better-sqlite3: this server ships as an MCPB that Claude Desktop
 * can launch on either macOS or Windows using whatever Node runtime it bundles,
 * with no build step and no way for us to know its exact version in advance.
 * A pure WASM engine behaves identically everywhere Node runs, with no native
 * compilation and no minimum-Node-version gamble. The tradeoff is that sql.js
 * is IN-MEMORY only: there is no native file-backed journal, so this module
 * loads the whole file into memory on startup and re-serialises it to disk
 * itself after every write transaction (see persist() below).
 *
 * Holds NORMALISED records, not raw Glooko blobs:
 *   - cgm:      one row per 5-minute reading (epoch seconds, value mmol/L, velocity)
 *   - bolus:    one row per bolus event (epoch, units, carbs, iob, class)
 *   - settings: effective-dated pump-setting snapshots (the JSON we already parse),
 *               resolved by date at query time exactly as the original code did
 *   - day_status: which UTC days are COMPLETE (immutable, never re-fetched) vs
 *                 partial (today / the boundary, always re-pulled on top-up)
 *
 * Normalising at ingest means a Glooko markup change can corrupt at most one
 * top-up, never the archive: the archive is in our own stable schema. The raw
 * Glooko parsing stays at the edge (analytics.processUnifiedGlookoData etc).
 *
 * The DB file lives under the user's chosen data folder (see paths.js) so the
 * archive survives extension updates.
 *
 * MULTI-PROCESS NOTE: as an MCPB, this server is not launched once — every
 * surface that wants its tools (the main chat, a Cowork session, a Code
 * session) spawns its OWN separate process over its own stdio pipe, and more
 * than one of those can be starting up or running against the same archive
 * file at the same time. sql.js has no concept of this at all: each process
 * keeps its own private in-memory copy, loaded once and written back out
 * after each write batch. Two things follow from that, and both are handled
 * deliberately below:
 *   1. A read must never observe a WRITE IN PROGRESS from a sibling process
 *      (see persist()'s write-to-temp-then-rename, and initDb()'s retry/
 *      quarantine handling of a load that fails anyway).
 *   2. Two processes' writes are not merged: whichever persists last wins for
 *      anything the other changed concurrently. For a single-user local tool
 *      this is an acceptable tradeoff (a losing process's Glooko sync just
 *      gets re-pulled on its next top-up) in exchange for never corrupting
 *      the archive and never blocking one session's startup on another's.
 *
 * STARTUP LATENCY NOTE: nothing here runs at module-import time any more.
 * Loading the sql.js WASM engine and opening/parsing the archive file are
 * both real I/O/CPU work, and blocking the MCP connection on them (as an
 * earlier version of this file did, via top-level await) delayed the very
 * first response to a client — including the initial version-negotiation
 * handshake a client probes with before it starts a real session. If that's
 * slow (worse under the multi-process contention above) or the probe has a
 * tight timeout, the connection can be torn down before the handshake even
 * completes. So: ensureDbReady() is an explicit, separately-awaited step
 * that range.js calls on the first actual tool invocation, never at import
 * time — the server connects to its transport and can answer `initialize`
 * immediately, and only pays this cost once real work is asked of it.
 */

import initSqlJsFactory from 'sql.js';
import path from 'path';
import fs from 'fs';
import { resolveDbPath, seedExampleDbIfEmpty } from './paths.js';

let SQL = null;       // the sql.js module, loaded lazily (see ensureSqlJsLoaded)
let sqlJsLoading = null; // in-flight load promise, so concurrent callers share it

let db = null;       // the shim below (mimics the .exec()/.prepare() surface
                      // the rest of this file was originally written against)
let rawDb = null;    // the underlying sql.js Database
let dbFilePath = null;

/** Load the sql.js WASM engine exactly once, however many times this is called. */
function ensureSqlJsLoaded() {
  if (SQL) return Promise.resolve(SQL);
  if (!sqlJsLoading) {
    sqlJsLoading = initSqlJsFactory().then((mod) => {
      SQL = mod;
      return SQL;
    });
  }
  return sqlJsLoading;
}

// Bump SCHEMA_VERSION whenever the set of data we derive-and-store changes
// (new series, new tables) so older archives self-heal. On a version mismatch,
// an existing archive's data is wiped and re-pulled fresh on the next query,
// rather than leaving days that predate a feature missing its data silently.
//   1 = cgm + bolus + settings + daily_insulin
//   2 = + basal_state + device_event (basal delivery states, pod/sensor changes)
//   3 = force re-pull: clears any basal_state rows written by an earlier build
//       whose derivation could differ, so states are re-derived from current code
//   4 = basal bar edge-pairing fix (re-derive all basal states)
//   5 = widened bolus table: delivered/programmed/recommendation split, override,
//       interrupted, bg input/source, is_manual
//   6 = cgm/bolus keyed by (epoch, seq) instead of epoch alone. Glooko's
//       timestamps are plain wall-clock digits with no timezone attached (see
//       analytics.js's top comment), so on a clock-change ("fall back") day
//       two genuinely different real readings, an hour apart, can carry the
//       IDENTICAL epoch. Under the old epoch-only primary key the second one
//       silently overwrote the first; `seq` lets both survive as distinct
//       rows. Force a re-pull so any archive written before this fix
//       (which may already have quietly lost one of a colliding pair) gets a
//       fresh chance to capture both from Glooko, though whether Glooko's own
//       backend still has both to give us at that point is unverified.
//   7 = SuperGlookoQuery fork: typed-core + `extra` overflow. cgm/bolus each
//       gain an `extra` TEXT column (JSON-serialised, everything Glooko sent
//       for that record that isn't already a named typed column — see
//       DESIGN.md section 1). New `field_capability` table backs the
//       runtime capability state from DESIGN.md section 2a: one row per
//       (category, field_name) EVER confirmed populated for this account,
//       monotonic (rows are only ever inserted, never updated/removed) so a
//       capability once confirmed can never be silently revoked by a later
//       sync that happens not to see that field again. This is deliberately
//       a separate table from cgm/bolus's own `extra` column: `extra` is the
//       raw per-record data, `field_capability` is the derived "have we ever
//       seen this field populated, and when" state that capability-gated
//       modules (DESIGN.md section 4) actually read from.
//   8 = first field promotion (docs/PROMOTION.md, bootstrap exception):
//       bolus gains initial_delivery/extended_delivery/extended_bolus_duration
//       typed columns, promoted out of `extra` — the original motivating
//       question for this whole fork. Still swept into `extra` too until
//       BOLUS_KNOWN_KEYS in analytics.js is updated (it is, as of this same
//       version), so no data is lost either way.
const SCHEMA_VERSION = 8;

/**
 * Serialise the in-memory database to disk. Cheap enough to call once per
 * write transaction (see makeShim's exec()); NOT called per-row.
 *
 * Writes to a sibling temp file and RENAMES it into place, rather than
 * writing dbFilePath directly. fs.writeFileSync on an existing file truncates
 * and writes in place; a sibling process reading dbFilePath at the wrong
 * moment could see a half-written, unparseable file. rename() is atomic on
 * both POSIX and Windows (same volume), so any concurrent reader always sees
 * either the complete old file or the complete new one, never a partial one.
 */
function persist() {
  if (!rawDb || !dbFilePath) return;
  const dir = path.dirname(dbFilePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.${path.basename(dbFilePath)}.tmp-${process.pid}-${Date.now()}`
  );
  fs.writeFileSync(tmpPath, Buffer.from(rawDb.export()));
  fs.renameSync(tmpPath, dbFilePath);
}

/**
 * A thin shim over a sql.js Database giving it the same .exec()/.prepare()
 * surface node:sqlite's DatabaseSync had, so every query below this point is
 * completely unchanged. The one behavioural addition: exec() persists to disk
 * after every statement EXCEPT a bare "BEGIN" — so a BEGIN / many .run() calls
 * in a loop / COMMIT (or ROLLBACK) block, the pattern every ingest function
 * below uses, writes to disk once per batch on the COMMIT/ROLLBACK, not once
 * per row.
 */
function makeShim(sqlJsDb) {
  return {
    exec(sql) {
      sqlJsDb.exec(sql);
      if (sql.trim().toUpperCase() !== 'BEGIN') persist();
    },
    prepare(sqlText) {
      let runStmt = null; // reused across repeated .run() calls in a loop
      return {
        get(...args) {
          const stmt = sqlJsDb.prepare(sqlText);
          try {
            if (args.length) stmt.bind(args);
            return stmt.step() ? stmt.getAsObject() : undefined;
          } finally {
            stmt.free();
          }
        },
        all(...args) {
          const stmt = sqlJsDb.prepare(sqlText);
          try {
            if (args.length) stmt.bind(args);
            const rows = [];
            while (stmt.step()) rows.push(stmt.getAsObject());
            return rows;
          } finally {
            stmt.free();
          }
        },
        run(...args) {
          if (!runStmt) runStmt = sqlJsDb.prepare(sqlText);
          if (args.length) runStmt.bind(args); // bind() implicitly resets
          runStmt.step();
          return { changes: sqlJsDb.getRowsModified() };
        },
      };
    },
  };
}

/**
 * Async, idempotent readiness gate: loads the sql.js engine and opens the
 * archive. This is the ONLY thing that does real I/O on a cold process, and
 * it is called lazily on first actual use (range.js's getProcessedRange),
 * never at module-import time — see the multi-process/startup-latency note
 * at the top of this file for why that matters.
 */
export async function ensureDbReady(dbPath = resolveDbPath()) {
  await ensureSqlJsLoaded();
  return initDb(dbPath);
}

const SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS cgm (
      epoch INTEGER NOT NULL,
      seq   INTEGER NOT NULL DEFAULT 0, -- disambiguates genuine same-epoch
                                         -- collisions (DST fall-back); see
                                         -- SCHEMA_VERSION 6 note above
      val   REAL NOT NULL,
      vel   REAL,
      extra TEXT,            -- JSON: everything else Glooko sent for this
                              -- reading (e.g. mealTag) that isn't one of the
                              -- typed columns above. See SCHEMA_VERSION 7.
      PRIMARY KEY (epoch, seq)
    );
    CREATE TABLE IF NOT EXISTS bolus (
      epoch        INTEGER NOT NULL,
      seq          INTEGER NOT NULL DEFAULT 0, -- see cgm.seq above
      units        REAL,    -- canonical amount = delivered (kept for existing analytics)
      delivered    REAL,    -- insulinDelivered: what actually went in
      programmed   REAL,    -- insulinProgrammed: what was commanded
      rec_total    REAL,    -- totalInsulinRecommendation: algorithm's suggestion
      rec_corr     REAL,    -- insulinRecommendationForCorrection
      rec_carb     REAL,    -- insulinRecommendationForCarbs
      carbs        REAL,
      iob          REAL,    -- insulinOnBoard at delivery (Glooko-computed)
      bg_input     REAL,    -- bloodGlucoseInput the bolus calc used, if any
      bg_source    TEXT,    -- bloodGlucoseInputSource ('CGM' / manual / null)
      is_manual    INTEGER, -- 1 = user-initiated manual bolus
      interrupted  INTEGER, -- 1 = delivered cut short of programmed
      override     TEXT,    -- 'above' | 'below' | null vs recommendation
      class        TEXT,
      initial_delivery        REAL, -- initialDelivery: the up-front portion of
                                     -- a split/extended bolus. See SCHEMA_VERSION 8.
      extended_delivery       REAL, -- extendedDelivery: the portion delivered
                                     -- over extended_bolus_duration.
      extended_bolus_duration REAL, -- extendedBolusDuration: raw Glooko value;
                                     -- unit not yet confirmed against a real
                                     -- sync (see docs/PROMOTION.md's log).
      extra        TEXT,    -- JSON: everything else Glooko sent for this
                             -- bolus, not yet promoted to a typed column. See
                             -- SCHEMA_VERSION 7/8.
      PRIMARY KEY (epoch, seq)
    );
    CREATE TABLE IF NOT EXISTS field_capability (
      category         TEXT NOT NULL,  -- Glooko category, e.g. 'bolus',
                                        -- 'cgm', 'insulin_pump', 'lifestyle'
      field_name       TEXT NOT NULL,
      first_seen_epoch INTEGER NOT NULL, -- when first confirmed populated
      prompted         INTEGER NOT NULL DEFAULT 0, -- has the one-time
                                        -- "new field detected" notice fired?
      PRIMARY KEY (category, field_name)
    );
    CREATE TABLE IF NOT EXISTS settings (
      effective_epoch INTEGER PRIMARY KEY,
      effective_iso   TEXT NOT NULL,
      json            TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS device_event (
      epoch   INTEGER NOT NULL,
      type    TEXT NOT NULL,        -- 'pod' | 'sensor'
      day_utc TEXT NOT NULL,
      PRIMARY KEY (epoch, type)
    );
    CREATE TABLE IF NOT EXISTS basal_state (
      start_epoch INTEGER PRIMARY KEY,
      end_epoch   INTEGER NOT NULL,
      state       TEXT NOT NULL,      -- 'normal' | 'suspend' | 'max' | 'limited'
      day_utc     TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS daily_insulin (
      day_utc     TEXT PRIMARY KEY,   -- 'YYYY-MM-DD'
      day_epoch   INTEGER NOT NULL,
      basal_units REAL,
      bolus_units REAL,
      total_units REAL,
      complete    INTEGER NOT NULL,   -- 1 = past day (final), 0 = today (provisional)
      ingested_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS day_status (
      day_utc   TEXT PRIMARY KEY,   -- 'YYYY-MM-DD'
      complete  INTEGER NOT NULL,   -- 1 = immutable past day, 0 = partial
      ingested_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_state (
      id                  INTEGER PRIMARY KEY CHECK (id = 1),
      oldest_synced_epoch INTEGER
    );
  `;

/**
 * Open a database from `bytes` (undefined = start fresh/empty), create the
 * schema if needed, and run the version-heal check. Sets the module-level
 * rawDb/db as a side effect. Can throw — e.g. sql.js accepts opening a
 * non-SQLite blob without complaint (it validates lazily), so a genuinely
 * corrupt file often only fails HERE, on the first real statement, not when
 * it was first opened. Callers are responsible for catching that.
 */
function openArchive(bytes) {
  rawDb = bytes ? new SQL.Database(bytes) : new SQL.Database();
  db = makeShim(rawDb);

  // Self-heal: if this archive was written by an older schema, DROP its
  // versioned tables BEFORE (re)creating them, rather than merely deleting
  // their rows. This must run before db.exec(SCHEMA_SQL) below, and the
  // version must be read here first: CREATE TABLE IF NOT EXISTS is a no-op
  // against a table that already exists on disk, so if a past version only
  // deleted rows (as this function itself used to), an old table's COLUMN
  // LAYOUT survives untouched even after a "wipe" — the very next INSERT
  // referencing a newly-added column (e.g. this version's cgm/bolus `seq`
  // column) then fails outright with "no column named seq", not merely
  // returning stale/incomplete data. Dropping and letting SCHEMA_SQL recreate
  // from scratch guarantees the on-disk layout always matches the CURRENT
  // code's CREATE TABLE statements, however many columns or keys have changed
  // since. The next query cold-starts a fresh pull that repopulates every
  // table for the whole span; nothing here is treated as unrecoverable, since
  // the archive is always just a rebuildable cache of Glooko's own data.
  const preStored = db.prepare('PRAGMA user_version').get();
  const storedVersion = preStored ? Object.values(preStored)[0] : 0;
  if (storedVersion > 0 && storedVersion < SCHEMA_VERSION) {
    db.exec(
      'DROP TABLE IF EXISTS cgm; DROP TABLE IF EXISTS bolus; DROP TABLE IF EXISTS settings; ' +
        'DROP TABLE IF EXISTS daily_insulin; DROP TABLE IF EXISTS basal_state; ' +
        'DROP TABLE IF EXISTS device_event; DROP TABLE IF EXISTS day_status; ' +
        'DROP TABLE IF EXISTS sync_state; DROP TABLE IF EXISTS field_capability;'
    );
  }
  db.exec(SCHEMA_SQL);
  // Stamp the current version (covers both fresh DBs at 0 and just-healed ones).
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

const RETRY_PAUSE_MS = 150;

/** Block synchronously for a short pause. Only ever used on the rare
 * archive-failed-to-open path, never in any hot loop. */
function briefSyncPause(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* deliberately busy — see call sites */ }
}

export function initDb(dbPath = resolveDbPath()) {
  if (rawDb) return db;
  if (!SQL) {
    throw new Error('initDb() called before the sql.js engine finished loading — call ensureDbReady() first.');
  }
  dbFilePath = dbPath;
  try {
    fs.mkdirSync(path.dirname(dbFilePath), { recursive: true });
  } catch {
    /* dir may already exist */
  }
  // Seed from the bundled example database on a genuinely fresh, offline
  // (no Glooko login configured) install, before this function creates an
  // empty file at dbFilePath itself. See paths.js for the full rationale.
  seedExampleDbIfEmpty(dbFilePath);

  const fileExisted = fs.existsSync(dbFilePath);
  try {
    const bytes = fileExisted ? fs.readFileSync(dbFilePath) : undefined;
    openArchive(bytes);
    return db;
  } catch (err) {
    if (!fileExisted) {
      // A brand-new, empty database failing is not a corrupt-file problem —
      // something deeper is wrong (e.g. sql.js itself). Nothing useful to
      // quarantine; let it propagate as a normal tool-call error rather than
      // silently swallowing it.
      throw err;
    }
    rawDb = null;
    db = null;
  }

  // The file existed but failed to open/parse. This can happen for two very
  // different reasons: (a) an unlucky read against a sibling process's write
  // — despite persist()'s atomic rename, some filesystems/timings can still
  // let a reader observe a mid-replace state — or (b) the file is genuinely
  // corrupt. Distinguish by retrying once after a brief pause: a sibling's
  // write finishes in milliseconds, so a real race clears on retry, while
  // genuine corruption doesn't.
  briefSyncPause(RETRY_PAUSE_MS);
  try {
    const bytes = fs.readFileSync(dbFilePath);
    openArchive(bytes);
    console.error(`[podquery] Archive read failed once but succeeded on retry (likely a sibling process was mid-write).`);
    return db;
  } catch (err) {
    rawDb = null;
    db = null;
    // Genuinely unreadable — quarantine it rather than silently discarding
    // it, and start a fresh archive so the server still comes up. The normal
    // sync/top-up path repopulates the new archive on the next query.
    const quarantinePath = `${dbFilePath}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(dbFilePath, quarantinePath);
      console.error(
        `[podquery] Archive at ${dbFilePath} could not be opened (${err.message}). ` +
          `Moved it aside to ${quarantinePath} and starting a fresh archive.`
      );
    } catch (renameErr) {
      console.error(
        `[podquery] Archive at ${dbFilePath} could not be opened (${err.message}), ` +
          `and could not be quarantined either (${renameErr.message}). Starting a fresh in-memory archive; it will not overwrite the file on disk until the next successful write.`
      );
    }
    openArchive(undefined);
    return db;
  }
}

function d() {
  if (!db) initDb();
  return db;
}

// --- ingest ---------------------------------------------------------------

/**
 * Upsert a unified timeline (CGM + bolus rows) and settings snapshots into the
 * store. Idempotent: re-ingesting the same epochs overwrites, so re-pulling a
 * partial day and later the complete day converges correctly.
 *
 * SEQ ASSIGNMENT: `timeline` is keyed by (epoch, seq), not epoch alone (see
 * SCHEMA_VERSION 6). Most epochs occur exactly once, so seq is 0 for the
 * ordinary case. When the SAME epoch appears more than once within this one
 * batch — the DST fall-back collision this exists for, where two real
 * readings an hour apart share identical wall-clock digits — each repeat
 * gets the next seq (0, 1, 2, ...) in the order it appears in `timeline`,
 * which is itself sorted by epoch with a STABLE sort (see
 * processUnifiedGlookoData), so re-ingesting the identical Glooko response
 * later assigns the same seq to the same logical point and converges rather
 * than accumulating duplicates.
 */
/**
 * True if `value` counts as "populated" — not null/undefined, not an empty
 * string, not NaN. Zero and false DO count (a real 0% or false is data, not
 * absence of data). Shared single source of truth between ingestTimeline's
 * monotonic capability recording (2a) and discover.js's own threshold-based
 * populated-rate calculation (2b) — the two use this same base rule, they
 * just apply different thresholds on top of it (2a: populated even once,
 * ever; 2b: populated above a real rate — see DESIGN.md section 2).
 */
export function isPopulatedValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'number' && Number.isNaN(value)) return false;
  if (typeof value === 'string' && value.trim() === '') return false;
  return true;
}

export function ingestTimeline(timeline, settingsSnapshots) {
  const conn = d();
  const cgmStmt = conn.prepare(
    `INSERT INTO cgm (epoch, seq, val, vel, extra) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(epoch, seq) DO UPDATE SET val=excluded.val, vel=excluded.vel, extra=excluded.extra`
  );
  const bolStmt = conn.prepare(
    `INSERT INTO bolus
       (epoch, seq, units, delivered, programmed, rec_total, rec_corr, rec_carb,
        carbs, iob, bg_input, bg_source, is_manual, interrupted, override, class,
        initial_delivery, extended_delivery, extended_bolus_duration, extra)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(epoch, seq) DO UPDATE SET
       units=excluded.units, delivered=excluded.delivered,
       programmed=excluded.programmed, rec_total=excluded.rec_total,
       rec_corr=excluded.rec_corr, rec_carb=excluded.rec_carb,
       carbs=excluded.carbs, iob=excluded.iob, bg_input=excluded.bg_input,
       bg_source=excluded.bg_source, is_manual=excluded.is_manual,
       interrupted=excluded.interrupted, override=excluded.override,
       class=excluded.class, initial_delivery=excluded.initial_delivery,
       extended_delivery=excluded.extended_delivery,
       extended_bolus_duration=excluded.extended_bolus_duration, extra=excluded.extra`
  );
  // Monotonic capability state (DESIGN.md 2a): INSERT ... DO NOTHING, so a
  // field's first-seen record is permanent — a later sync that doesn't see
  // that field populated again can never revoke a capability already
  // confirmed. See getNewlyConfirmedCapabilities() for how a caller finds
  // out which of these are brand new (for the one-time contribute prompt).
  const capStmt = conn.prepare(
    `INSERT INTO field_capability (category, field_name, first_seen_epoch, prompted)
     VALUES (?, ?, ?, 0)
     ON CONFLICT(category, field_name) DO NOTHING`
  );

  /** Record capability state for every populated key in an `extra` object.
   * `extra` itself is left as-is (including nulls) for storage — this only
   * decides what counts as a confirmed capability, it doesn't filter what's
   * stored in the row's own `extra` JSON. */
  function recordCapabilities(category, extra, epoch) {
    if (!extra) return;
    for (const [key, value] of Object.entries(extra)) {
      if (isPopulatedValue(value)) capStmt.run(category, key, epoch);
    }
  }

  conn.exec('BEGIN');
  try {
    const cgmSeqByEpoch = new Map();
    const bolusSeqByEpoch = new Map();
    for (const item of timeline) {
      if (item.type === 'CGM') {
        const seq = cgmSeqByEpoch.get(item.epoch) || 0;
        cgmSeqByEpoch.set(item.epoch, seq + 1);
        const extraJson = item.extra ? JSON.stringify(item.extra) : null;
        cgmStmt.run(item.epoch, seq, item.val, item.vel ?? null, extraJson);
        recordCapabilities('cgm', item.extra, item.epoch);
      } else if (item.type === 'BOLUS') {
        const seq = bolusSeqByEpoch.get(item.epoch) || 0;
        bolusSeqByEpoch.set(item.epoch, seq + 1);
        const extraJson = item.extra ? JSON.stringify(item.extra) : null;
        bolStmt.run(
          item.epoch,
          seq,
          item.units ?? null,
          item.delivered ?? null,
          item.programmed ?? null,
          item.recTotal ?? null,
          item.recCorrection ?? null,
          item.recCarbs ?? null,
          item.carbs ?? null,
          item.iob ?? null,
          item.bgInput ?? null,
          item.bgSource ?? null,
          item.isManual ? 1 : 0,
          item.interrupted ? 1 : 0,
          item.override ?? null,
          item.class ?? null,
          item.initialDelivery ?? null,
          item.extendedDelivery ?? null,
          item.extendedBolusDuration ?? null,
          extraJson
        );
        recordCapabilities('bolus', item.extra, item.epoch);
      }
    }
    if (settingsSnapshots && settingsSnapshots.length) {
      const setStmt = conn.prepare(
        `INSERT INTO settings (effective_epoch, effective_iso, json) VALUES (?, ?, ?)
         ON CONFLICT(effective_epoch) DO UPDATE SET json=excluded.json`
      );
      for (const s of settingsSnapshots) {
        const eIso = s.activeTimestamp;
        const eEpoch = Math.floor(new Date(eIso).getTime() / 1000);
        setStmt.run(eEpoch, eIso, JSON.stringify(s.settings));
      }
    }
    conn.exec('COMMIT');
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Mark a set of UTC day strings with a completeness flag.
 * complete=1 days are treated as immutable and never re-fetched.
 */
export function markDays(dayStrings, complete) {
  const conn = d();
  const stmt = conn.prepare(
    `INSERT INTO day_status (day_utc, complete, ingested_at) VALUES (?, ?, ?)
     ON CONFLICT(day_utc) DO UPDATE SET complete=excluded.complete, ingested_at=excluded.ingested_at`
  );
  const now = Date.now();
  conn.exec('BEGIN');
  try {
    for (const day of dayStrings) stmt.run(day, complete ? 1 : 0, now);
    conn.exec('COMMIT');
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Upsert per-day insulin totals. Past days are stored complete (final); today
 * is stored provisional (complete=0) and overwritten on each top-up until the
 * day is over, because today's totals keep accruing.
 */
export function ingestDailyInsulin(records, todayUtc) {
  if (!records || !records.length) return;
  const conn = d();
  const stmt = conn.prepare(
    `INSERT INTO daily_insulin
       (day_utc, day_epoch, basal_units, bolus_units, total_units, complete, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(day_utc) DO UPDATE SET
       day_epoch=excluded.day_epoch,
       basal_units=excluded.basal_units,
       bolus_units=excluded.bolus_units,
       total_units=excluded.total_units,
       complete=excluded.complete,
       ingested_at=excluded.ingested_at`
  );
  const now = Date.now();
  conn.exec('BEGIN');
  try {
    for (const r of records) {
      const complete = r.dayUtc < todayUtc ? 1 : 0;
      stmt.run(
        r.dayUtc,
        r.dayEpoch,
        r.basalUnits,
        r.bolusUnits,
        r.totalUnits,
        complete,
        now
      );
    }
    conn.exec('COMMIT');
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Upsert basal-state intervals (normal/suspend/max/limited), keyed by start
 * epoch. Idempotent: re-deriving a day's intervals overwrites by start time.
 * Note: a re-pull whose interval boundaries shift slightly could leave a stale
 * old interval; we clear the window's day(s) first to keep it clean.
 */
export function ingestBasalStates(intervals) {
  if (!intervals || !intervals.length) return;
  const conn = d();
  const days = [...new Set(intervals.map((i) => i.start.split('T')[0]))];
  const del = conn.prepare('DELETE FROM basal_state WHERE day_utc = ?');
  const stmt = conn.prepare(
    `INSERT INTO basal_state (start_epoch, end_epoch, state, day_utc)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(start_epoch) DO UPDATE SET
       end_epoch=excluded.end_epoch, state=excluded.state, day_utc=excluded.day_utc`
  );
  conn.exec('BEGIN');
  try {
    for (const day of days) del.run(day);
    for (const i of intervals) {
      stmt.run(i.startEpoch, i.endEpoch, i.state, i.start.split('T')[0]);
    }
    conn.exec('COMMIT');
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Upsert device events (pod and sensor changes). Keyed by (epoch, type), so
 * re-pulling the same event is idempotent and the two types never collide.
 */
export function ingestDeviceEvents(events) {
  const conn = d();
  const all = [
    ...(events.podChanges || []).map((e) => ({ ...e, type: 'pod' })),
    ...(events.sensorChanges || []).map((e) => ({ ...e, type: 'sensor' })),
  ];
  if (!all.length) return;
  const stmt = conn.prepare(
    `INSERT INTO device_event (epoch, type, day_utc) VALUES (?, ?, ?)
     ON CONFLICT(epoch, type) DO NOTHING`
  );
  conn.exec('BEGIN');
  try {
    for (const e of all) {
      const day = new Date(e.epoch * 1000).toISOString().split('T')[0];
      stmt.run(e.epoch, e.type, day);
    }
    conn.exec('COMMIT');
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Device events within [startEpoch, endEpoch] (seconds), split by type.
 * Returns { podChanges: [{epoch,time}], sensorChanges: [{epoch,time}] }.
 */
export function getDeviceEvents(startEpoch, endEpoch) {
  const rows = d()
    .prepare(
      `SELECT epoch, type FROM device_event
        WHERE epoch BETWEEN ? AND ? ORDER BY epoch`
    )
    .all(startEpoch, endEpoch);
  const podChanges = [];
  const sensorChanges = [];
  for (const r of rows) {
    const item = { epoch: r.epoch, time: new Date(r.epoch * 1000).toISOString() };
    if (r.type === 'pod') podChanges.push(item);
    else if (r.type === 'sensor') sensorChanges.push(item);
  }
  return { podChanges, sensorChanges };
}


/**
 * Basal-state intervals overlapping [startEpoch, endEpoch] (seconds), ordered.
 * Returns [{ state, start, end, startEpoch, endEpoch, minutes }].
 */
export function getBasalStates(startEpoch, endEpoch) {
  const rows = d()
    .prepare(
      `SELECT start_epoch, end_epoch, state FROM basal_state
        WHERE end_epoch > ? AND start_epoch < ?
        ORDER BY start_epoch`
    )
    .all(startEpoch, endEpoch);
  return rows.map((r) => ({
    state: r.state,
    start: new Date(r.start_epoch * 1000).toISOString(),
    end: new Date(r.end_epoch * 1000).toISOString(),
    startEpoch: r.start_epoch,
    endEpoch: r.end_epoch,
    minutes: Math.round((r.end_epoch - r.start_epoch) / 60),
  }));
}


/**
 * Daily insulin rows whose day falls within [startEpoch, endEpoch] (seconds).
 * Returns [{ dayUtc, basalUnits, bolusUnits, totalUnits, complete }].
 */
export function getDailyInsulin(startEpoch, endEpoch) {
  const startDay = new Date(startEpoch * 1000).toISOString().split('T')[0];
  // Half-open on the end: if the window ends exactly at a day's 00:00:00 UTC,
  // that day has no duration inside the window and must be excluded (this was
  // the cause of an off-by-one day count, e.g. a 10-day window reporting 11).
  const endDate = new Date(endEpoch * 1000);
  const endsAtMidnight =
    endDate.getUTCHours() === 0 &&
    endDate.getUTCMinutes() === 0 &&
    endDate.getUTCSeconds() === 0;
  const endRef = endsAtMidnight ? new Date(endEpoch * 1000 - 1000) : endDate;
  const endDay = endRef.toISOString().split('T')[0];
  const rows = d()
    .prepare(
      `SELECT day_utc, basal_units, bolus_units, total_units, complete
         FROM daily_insulin
        WHERE day_utc BETWEEN ? AND ?
        ORDER BY day_utc`
    )
    .all(startDay, endDay);
  return rows.map((r) => ({
    dayUtc: r.day_utc,
    basalUnits: r.basal_units,
    bolusUnits: r.bolus_units,
    totalUnits: r.total_units,
    complete: !!r.complete,
  }));
}



/** Returns the set of complete day strings as a Set. */
export function getCompleteDays() {
  const rows = d()
    .prepare('SELECT day_utc FROM day_status WHERE complete=1')
    .all();
  return new Set(rows.map((r) => r.day_utc));
}

/** Newest stored CGM epoch (seconds), or null if empty. */
export function getLatestCgmEpoch() {
  const row = d().prepare('SELECT MAX(epoch) m FROM cgm').get();
  return row && row.m ? row.m : null;
}

/** Oldest stored CGM epoch (seconds), or null if empty. */
export function getEarliestCgmEpoch() {
  const row = d().prepare('SELECT MIN(epoch) m FROM cgm').get();
  return row && row.m ? row.m : null;
}

/** Total stored CGM row count. Used to detect whether a pull added anything. */
export function getCgmCount() {
  const row = d().prepare('SELECT COUNT(*) c FROM cgm').get();
  return row ? row.c : 0;
}

/**
 * Newest stored epoch (seconds) across EVERY data stream, returned per stream
 * plus the overall minimum-of-maxima. The sync top-up keys off the OLDEST of
 * the per-stream maxima ("coverageEpoch"), not CGM alone: if one stream (e.g.
 * daily insulin) lagged behind a Glooko sync, CGM recency would wrongly report
 * the archive as current and that stream would never be backfilled. Pulling
 * from the oldest stream max guarantees every stream is brought up to date.
 *
 * Streams with no rows are ignored (null), so an as-yet-unused table does not
 * peg coverage at the epoch (the start of time). Returns null fields where a
 * stream is empty, and coverageEpoch = null only when ALL streams are empty.
 */
export function getStreamMaxima() {
  const conn = d();
  const maxOf = (sql) => {
    const r = conn.prepare(sql).get();
    return r && r.m ? r.m : null;
  };
  const cgm = maxOf('SELECT MAX(epoch) m FROM cgm');
  const bolus = maxOf('SELECT MAX(epoch) m FROM bolus');
  const basal = maxOf('SELECT MAX(end_epoch) m FROM basal_state');
  // daily_insulin is keyed by day string; convert its newest day to an epoch.
  const diRow = conn.prepare('SELECT MAX(day_epoch) m FROM daily_insulin').get();
  const dailyInsulin = diRow && diRow.m ? diRow.m : null;

  const present = [cgm, bolus, basal, dailyInsulin].filter((v) => v != null);
  const coverageEpoch = present.length ? Math.min(...present) : null;
  return { cgm, bolus, basal, dailyInsulin, coverageEpoch };
}

/**
 * Newest stored epoch (seconds) across all streams (the MAX of maxima), used
 * for staleness reporting: "how fresh is the most recent thing we have".
 * null if the archive is entirely empty.
 */
export function getNewestDataEpoch() {
  const { cgm, bolus, basal, dailyInsulin } = getStreamMaxima();
  const present = [cgm, bolus, basal, dailyInsulin].filter((v) => v != null);
  return present.length ? Math.max(...present) : null;
}

/**
 * Rebuild a unified, sorted timeline for [startEpoch, endEpoch] (seconds)
 * directly from the store, in the same shape processUnifiedGlookoData produces,
 * so the analytics functions consume it unchanged.
 */
export function getTimeline(startEpoch, endEpoch) {
  const conn = d();
  const cgm = conn
    .prepare('SELECT epoch, val, vel, extra FROM cgm WHERE epoch BETWEEN ? AND ? ORDER BY epoch, seq')
    .all(startEpoch, endEpoch)
    .map((r) => ({
      epoch: r.epoch,
      type: 'CGM',
      val: r.val,
      vel: r.vel,
      extra: r.extra ? JSON.parse(r.extra) : null,
      time: new Date(r.epoch * 1000).toISOString(),
    }));
  const bolus = conn
    .prepare(
      `SELECT epoch, units, delivered, programmed, rec_total, rec_corr, rec_carb,
              carbs, iob, bg_input, bg_source, is_manual, interrupted, override, class,
              initial_delivery, extended_delivery, extended_bolus_duration, extra
         FROM bolus WHERE epoch BETWEEN ? AND ? ORDER BY epoch, seq`
    )
    .all(startEpoch, endEpoch)
    .map((r) => ({
      epoch: r.epoch,
      type: 'BOLUS',
      units: r.units,
      delivered: r.delivered,
      programmed: r.programmed,
      recTotal: r.rec_total,
      recCorrection: r.rec_corr,
      recCarbs: r.rec_carb,
      carbs: r.carbs,
      iob: r.iob,
      bgInput: r.bg_input,
      bgSource: r.bg_source,
      isManual: !!r.is_manual,
      interrupted: !!r.interrupted,
      override: r.override,
      class: r.class,
      initialDelivery: r.initial_delivery,
      extendedDelivery: r.extended_delivery,
      extendedBolusDuration: r.extended_bolus_duration,
      extra: r.extra ? JSON.parse(r.extra) : null,
      time: new Date(r.epoch * 1000).toISOString(),
    }));
  return [...cgm, ...bolus].sort((a, b) => a.epoch - b.epoch);
}

/**
 * All field capabilities ever confirmed populated for this account —
 * DESIGN.md section 2a/4's runtime capability state. A capability-gated
 * module checks this (not a fresh sample) to decide whether its tools
 * should register: present here means "confirmed at least once, ever,
 * never revoked," which is exactly the monotonic guarantee ingestTimeline's
 * recordCapabilities() maintains.
 * Returns [{ category, fieldName, firstSeenEpoch, prompted }].
 */
export function getFieldCapabilities() {
  return d()
    .prepare('SELECT category, field_name, first_seen_epoch, prompted FROM field_capability ORDER BY first_seen_epoch')
    .all()
    .map((r) => ({
      category: r.category,
      fieldName: r.field_name,
      firstSeenEpoch: r.first_seen_epoch,
      prompted: !!r.prompted,
    }));
}

/** Whether a specific (category, fieldName) has ever been confirmed populated. */
export function isCapabilityConfirmed(category, fieldName) {
  const row = d()
    .prepare('SELECT 1 FROM field_capability WHERE category = ? AND field_name = ?')
    .get(category, fieldName);
  return !!row;
}

/**
 * Capabilities confirmed for the first time that haven't been surfaced to
 * the user yet (DESIGN.md 2a's "prompt to contribute" — fires once per
 * field, not on every subsequent sync). Calling this marks them prompted in
 * the same call, so a caller should treat the returned list as "show this
 * notice now" — there is no separate "peek without consuming" read.
 */
export function takeNewlyConfirmedCapabilities() {
  const conn = d();
  const rows = conn
    .prepare('SELECT category, field_name, first_seen_epoch FROM field_capability WHERE prompted = 0')
    .all();
  if (!rows.length) return [];
  conn.exec('BEGIN');
  try {
    const markStmt = conn.prepare(
      'UPDATE field_capability SET prompted = 1 WHERE category = ? AND field_name = ?'
    );
    for (const r of rows) markStmt.run(r.category, r.field_name);
    conn.exec('COMMIT');
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
  return rows.map((r) => ({
    category: r.category,
    fieldName: r.field_name,
    firstSeenEpoch: r.first_seen_epoch,
  }));
}

/**
 * Settings snapshots effective at or before endEpoch, in the
 * { activeTimestamp, settings } shape getActiveSettings produced, including the
 * one in force at the start of the window (the most recent prior snapshot).
 */
export function getSettingsHistory(startEpoch, endEpoch) {
  const conn = d();
  const rows = conn
    .prepare('SELECT effective_epoch, effective_iso, json FROM settings ORDER BY effective_epoch')
    .all();
  if (!rows.length) return [];
  const mapped = rows.map((r) => ({
    epoch: r.effective_epoch,
    activeTimestamp: r.effective_iso,
    settings: JSON.parse(r.json),
  }));
  // Baseline: last snapshot effective at or before window start.
  const baselineIdx = mapped.findLastIndex((s) => s.epoch <= startEpoch);
  const startIndex = baselineIdx !== -1 ? baselineIdx : 0;
  return mapped
    .slice(startIndex)
    .filter((s) => s.epoch <= endEpoch)
    .map((s) => ({ activeTimestamp: s.activeTimestamp, settings: s.settings }));
}

/**
 * The earliest epoch (seconds) this archive has CONFIRMED is fully backfilled
 * — either real data starts there, or an earlier walk hit MAX_EMPTY_BATCHES
 * consecutive empty pulls and concluded there's nothing older to find. null
 * means "not yet established" (a brand-new archive, or one written by a
 * version before this marker existed).
 *
 * This is the single source of truth sync.js uses to decide whether ANY
 * further backfilling is warranted: once set, an old question is answered
 * from whatever the archive already holds and never by itself triggers a
 * new Glooko pull. Only lowering the OMNI_OLDEST_DATE config below this
 * marker (or the marker being unset) re-opens backfilling. See sync.js's
 * ensureConfiguredFloorSynced().
 */
export function getOldestSyncedEpoch() {
  const row = d().prepare('SELECT oldest_synced_epoch e FROM sync_state WHERE id = 1').get();
  return row && row.e != null ? row.e : null;
}

/**
 * Record how far back this archive is now confirmed backfilled. Callers
 * should only ever move this EARLIER (never let a partial/aborted run
 * regress it forward) — see sync.js's recordOldestSynced, which enforces
 * that by taking the min against the existing value before calling this.
 */
export function setOldestSyncedEpoch(epoch) {
  const conn = d();
  conn.exec('BEGIN');
  try {
    conn
      .prepare(
        'INSERT INTO sync_state (id, oldest_synced_epoch) VALUES (1, ?) ' +
          'ON CONFLICT(id) DO UPDATE SET oldest_synced_epoch = excluded.oldest_synced_epoch'
      )
      .run(epoch);
    conn.exec('COMMIT');
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
}

export function closeDb() {
  if (rawDb) {
    persist();
    rawDb.close();
    rawDb = null;
    db = null;
    dbFilePath = null;
  }
}

// Test helper: wipe everything.
export function _wipe() {
  const conn = d();
  conn.exec('DELETE FROM cgm; DELETE FROM bolus; DELETE FROM settings; DELETE FROM day_status; DELETE FROM daily_insulin; DELETE FROM basal_state; DELETE FROM device_event; DELETE FROM sync_state; DELETE FROM field_capability;');
}
