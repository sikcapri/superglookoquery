import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// Proves the actual claim made in schema-registry/entry.schema.json's own
// $comment: an older client's entry (missing formatVersion and other
// fields that didn't exist yet) and a newer client's entry (formatVersion
// plus a hypothetical future field) both validate cleanly against TODAY'S
// schema, while a genuinely broken entry still correctly fails. Added
// 2026-09-10, prompted by a direct question about whether an older/newer
// submission file format could break something -- this is the answer,
// verified, not just asserted in a comment.
process.env.OMNI_DB_PATH = path.join(os.tmpdir(), `superglookoquery-test-formatcompat-${process.pid}.sqlite`);

const { ensureDbReady, ingestTimeline, _wipe } = await import('../src/store.js');
const { buildComponentReports, REGISTRY_ENTRY_FORMAT_VERSION } = await import('../src/discover.js');

const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'schema-registry', 'entry.schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

const NOW = Math.floor(Date.now() / 1000);

before(async () => {
  await ensureDbReady();
});

beforeEach(() => {
  _wipe();
});

/**
 * A small, generic-enough (not hardcoded to this one schema) JSON Schema
 * validator covering the subset entry.schema.json actually uses: type,
 * required, additionalProperties, enum, minimum/maximum, pattern,
 * maxLength, and one level of array `items`. Not a full draft-07
 * implementation (no $ref/oneOf/anyOf/if-then-else) -- not needed for this
 * schema, and not worth a new dependency for what this project's own
 * schema actually exercises.
 */
function validate(value, schema, path = '$') {
  const errors = [];
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    const jsonType = actual === 'number' && Number.isInteger(value) ? 'integer' : actual;
    const matches = types.includes(actual) || (types.includes('integer') && jsonType === 'integer') || (types.includes('number') && actual === 'number');
    if (!matches) errors.push(`${path}: type ${actual} not in [${types.join(', ')}]`);
  }
  if (schema.enum && !schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(value))) {
    errors.push(`${path}: value ${JSON.stringify(value)} not in enum`);
  }
  if (typeof value === 'string') {
    if (schema.maxLength != null && value.length > schema.maxLength) errors.push(`${path}: exceeds maxLength`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: does not match pattern`);
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${path}: below minimum`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${path}: above maximum`);
  }
  if (schema.type === 'object' || (value !== null && typeof value === 'object' && !Array.isArray(value) && schema.properties)) {
    for (const req of schema.required || []) {
      if (!(req in value)) errors.push(`${path}: missing required "${req}"`);
    }
    for (const key of Object.keys(value)) {
      if (schema.properties && key in schema.properties) {
        errors.push(...validate(value[key], schema.properties[key], `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}: unexpected property "${key}"`);
      }
    }
  }
  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((item, i) => errors.push(...validate(item, schema.items, `${path}[${i}]`)));
  }
  return errors;
}

test('entry.schema.json itself is well-formed and loads', () => {
  assert.equal(schema.type, 'object');
  assert.ok(Array.isArray(schema.required));
});

test('a freshly-generated real entry validates cleanly against the current schema', async () => {
  const records = [];
  for (let i = 0; i < 10; i++) {
    records.push({ type: 'BOLUS', epoch: NOW - i * 60, extra: { deviceName: 'Test Pump' } });
  }
  ingestTimeline(records, []);
  const [entry] = await buildComponentReports();

  assert.equal(entry.formatVersion, REGISTRY_ENTRY_FORMAT_VERSION, 'a freshly-generated entry must carry the current format version');
  const errors = validate(entry, schema);
  assert.deepEqual(errors, []);
});

test('BACKWARD COMPATIBILITY: an entry written before formatVersion existed still validates cleanly', () => {
  // Mirrors the two real entries already committed to this registry from
  // before this change (schema-registry-contribution-1788928054734) --
  // no formatVersion field at all, exactly as an older client would have
  // produced.
  const oldEntry = {
    component: 'pump',
    deviceName: 'CamDiab CamAPS FX',
    slug: 'camdiab-camaps-fx',
    discoveredAt: '2026-09-09T04:27:33.639Z',
    windowDaysActual: 30,
    lowConfidence: false,
    fields: [
      { fieldName: 'highestBolusValue', type: 'number', populatedCount: 108, populatedRate: 1, syntheticExample: 12.34 },
    ],
  };
  const errors = validate(oldEntry, schema);
  assert.deepEqual(errors, [], 'a pre-versioning real entry must not fail validation just because formatVersion is absent');
});

test('FORWARD COMPATIBILITY: a hypothetical future entry with a new top-level and per-field property still validates cleanly', () => {
  const futureEntry = {
    formatVersion: 2, // a hypothetical future version this schema has never heard of
    component: 'cgm',
    deviceName: 'Some Future CGM',
    slug: 'some-future-cgm',
    discoveredAt: '2030-01-01T00:00:00.000Z',
    windowDaysActual: 30,
    lowConfidence: false,
    contributorNote: 'a hypothetical future top-level field this schema has never heard of',
    fields: [
      {
        fieldName: 'someNewField',
        type: 'number',
        populatedCount: 50,
        populatedRate: 1,
        syntheticExample: 12.34,
        confidenceScore: 0.97, // a hypothetical future per-field property
      },
    ],
  };
  const errors = validate(futureEntry, schema);
  assert.deepEqual(errors, [], 'an unrecognised extra field must never fail validation, at top level or per-field');
});

test('a genuinely broken entry (missing a truly foundational field) still correctly fails', () => {
  const brokenEntry = {
    formatVersion: 1,
    deviceName: 'Something',
    // component is missing entirely -- this is not "old" or "new", it's broken
    slug: 'something',
    fields: [],
  };
  const errors = validate(brokenEntry, schema);
  assert.ok(errors.some((e) => e.includes('component')), 'a missing foundational field must still be caught');
});

test('a real value smuggled in as syntheticExample still correctly fails (leniency must not become a leak vector)', () => {
  const entry = {
    formatVersion: 1,
    component: 'pump',
    deviceName: 'Test',
    slug: 'test',
    fields: [
      { fieldName: 'insulinOnBoard', type: 'number', populatedRate: 0.5, syntheticExample: 4.87 },
    ],
  };
  const errors = validate(entry, schema);
  assert.ok(errors.length > 0, 'leniency on structure must never extend to the fixed syntheticExample allowlist');
});
