/**
 * paths.js — where this MCPB keeps its data.
 *
 * Claude Desktop launches this server with `${__dirname}` pointing at the
 * extension's own install directory, which is NOT a safe place to keep a
 * database: it can be wiped and replaced whenever the extension updates.
 * So the archive lives in a small folder under wherever the user picked as
 * their "Data folder" in the extension's settings (OMNI_DATA_DIR, wired from
 * the `data_directory` user_config field in manifest.json), defaulting to
 * their Documents folder if they never touched that setting.
 *
 * OMNI_DB_PATH remains supported as a direct full-path override, useful for
 * local development/testing outside of Claude Desktop (`node src/server.js`).
 */

import os from 'os';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const APP_FOLDER_NAME = 'SuperGlookoQuery';
const DB_FILE_NAME = 'superglookoquery.db';

// Pre-rebrand installs (this project's own early builds, and the original
// upstream PodQuery this was forked from) used these names instead. Detected
// and preferred over the new names below ONLY when the new ones don't
// already exist, so an existing archive is picked up automatically on
// upgrade rather than silently starting a second, empty one — no manual
// migration step, no re-downloading history from Glooko.
const LEGACY_APP_FOLDER_NAME = 'PodQuery';
const LEGACY_DB_FILE_NAME = 'podquery.db';

/** This module's own directory, independent of the process's cwd. */
function moduleDir() {
  return path.dirname(fileURLToPath(import.meta.url));
}

/** The extension/repo root (one level up from src/). */
export function projectRoot() {
  return path.join(moduleDir(), '..');
}

/**
 * The folder the archive database lives in. Resolution order:
 *   1. OMNI_DB_PATH (explicit full file path override) -> its directory.
 *   2. OMNI_DATA_DIR (from the manifest's "data_directory" user_config,
 *      typically the user's Documents folder) -> a small named subfolder
 *      inside it, created on demand.
 *   3. The OS home directory's Documents folder, same subfolder, as a
 *      fallback for running outside Claude Desktop entirely.
 */
export function resolveDataDir() {
  if (process.env.OMNI_DB_PATH) {
    return path.dirname(process.env.OMNI_DB_PATH);
  }
  const parent =
    (process.env.OMNI_DATA_DIR && process.env.OMNI_DATA_DIR.trim()) ||
    path.join(os.homedir(), 'Documents');
  const preferred = path.join(parent, APP_FOLDER_NAME);
  if (fs.existsSync(preferred)) return preferred;
  const legacy = path.join(parent, LEGACY_APP_FOLDER_NAME);
  if (fs.existsSync(legacy)) return legacy;
  return preferred;
}

/** The full path to the SQLite archive file. */
export function resolveDbPath() {
  if (process.env.OMNI_DB_PATH) return process.env.OMNI_DB_PATH;
  const dir = resolveDataDir();
  const preferred = path.join(dir, DB_FILE_NAME);
  if (fs.existsSync(preferred)) return preferred;
  const legacy = path.join(dir, LEGACY_DB_FILE_NAME);
  if (fs.existsSync(legacy)) return legacy;
  return preferred;
}

/** The bundled example database shipped inside the extension, if present. */
export function exampleDbPath() {
  return path.join(projectRoot(), 'examples', DB_FILE_NAME);
}

/**
 * Where get_chart_html writes its generated chart pages: a "charts"
 * subfolder next to the archive database, created on demand. Writing an
 * actual file (and opening it directly in the browser — see server.js) is
 * what keeps chart generation fast: the alternative, inlining the whole page
 * into the tool response, forces the model to reproduce tens of KB of text
 * token-by-token before anything can be shown, which is the slow path this
 * exists to avoid.
 */
export function resolveChartsDir() {
  return path.join(resolveDataDir(), 'charts');
}

/**
 * Same check range.js's glookoConfigured() makes, duplicated here (rather than
 * imported) to avoid a circular import: range.js imports store.js, and store.js
 * needs this check before store.js has even finished initialising.
 */
function glookoCredentialsPresent() {
  return Boolean(
    process.env.GLOOKO_EMAIL &&
      process.env.GLOOKO_PASSWORD &&
      process.env.GLOOKO_EMAIL.trim() &&
      process.env.GLOOKO_PASSWORD.trim()
  );
}

/**
 * First-run convenience: if nothing is at the resolved DB path yet, and the
 * server has no Glooko credentials configured (so it can only ever run in
 * offline/archive-only mode), seed the archive from the bundled example
 * database. This is what previously required a manual "copy examples/omni-
 * endo.db into data/" step in the Docker README; with the data folder no
 * longer something the user has to touch by hand, a fresh MCPB install can
 * just work immediately and show real (the author's own, shared on purpose)
 * sample data. Never overwrites an existing archive, and never runs at all
 * once a Glooko login is configured (that path downloads the user's own
 * data instead).
 *
 * MUST run before store.js's initDb() reads/creates the DB file, since
 * initDb() will otherwise create an empty file at dbPath first and this
 * check would then see the path as already "existing" and skip seeding.
 */
export function seedExampleDbIfEmpty(dbPath = resolveDbPath()) {
  if (fs.existsSync(dbPath)) return false;
  if (glookoCredentialsPresent()) return false;
  const example = exampleDbPath();
  if (!fs.existsSync(example)) return false;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.copyFileSync(example, dbPath);
  return true;
}
