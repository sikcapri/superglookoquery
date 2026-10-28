import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';

// An offline install (no Glooko login) seeded from the bundled sample DB at an
// older schema version: the upgrade empties its tables, and nothing can be
// re-pulled, so the sample must be put back rather than left empty.
const dbPath = path.join(os.tmpdir(), `superglookoquery-test-migrate-${process.pid}.sqlite`);
process.env.OMNI_DB_PATH = dbPath;
process.env.GLOOKO_EMAIL = '';
process.env.GLOOKO_PASSWORD = '';

test('an offline sample-data archive at an older schema version is re-seeded, not left empty', async () => {
  const SQL = await initSqlJs();
  const example = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'superglookoquery.db');
  const old = new SQL.Database(fs.readFileSync(example));
  old.exec('PRAGMA user_version = 9');
  fs.writeFileSync(dbPath, Buffer.from(old.export()));
  old.close();

  const { ensureDbReady, getTimeline } = await import('../src/store.js');
  await ensureDbReady();
  const rows = getTimeline(0, Math.floor(Date.now() / 1000) + 10 * 365 * 86400);
  assert.ok(rows.length > 0, 'sample data must be present after the upgrade');
});
