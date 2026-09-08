import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  scanForLeakage,
  hashContent,
  writeAndVerify,
} from '../src/submit-registry-entry.js';

function validEntry(overrides = {}) {
  return {
    component: 'pump',
    deviceName: 'CamDiab CamAPS FX',
    slug: 'camdiab-camaps-fx',
    discoveredAt: '2026-09-09T12:00:00.000Z',
    windowDaysActual: 30,
    lowConfidence: false,
    fields: [
      { fieldName: 'initialDeliveryPercentage', type: 'number', populatedRate: 0.5, syntheticExample: 12.34 },
      { fieldName: 'isManual', type: 'boolean', populatedRate: 1, syntheticExample: true },
    ],
    ...overrides,
  };
}

test('scanForLeakage passes a genuinely clean, allowlisted entry', () => {
  const result = scanForLeakage(validEntry());
  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
});

test('scanForLeakage catches a real-value leak disguised as a syntheticExample', () => {
  // Adversarial: someone (or a future bug) put a real-looking number in
  // where a fixed placeholder should be.
  const entry = validEntry({
    fields: [
      { fieldName: 'insulinOnBoard', type: 'number', populatedRate: 0.3, syntheticExample: 4.87 },
    ],
  });
  const result = scanForLeakage(entry);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes('insulinOnBoard')));
});

test('scanForLeakage catches an unrecognised type', () => {
  const entry = validEntry({
    fields: [{ fieldName: 'weirdField', type: 'exotic-type', populatedRate: 0.5, syntheticExample: null }],
  });
  const result = scanForLeakage(entry);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes('unrecognised type')));
});

test('scanForLeakage catches an out-of-range populatedRate', () => {
  const entry = validEntry({
    fields: [{ fieldName: 'x', type: 'number', populatedRate: 1.5, syntheticExample: 12.34 }],
  });
  const result = scanForLeakage(entry);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes('out of [0,1] range')));
});

test('scanForLeakage catches an implausibly long deviceName (possible real-value-as-key leak)', () => {
  const entry = validEntry({ deviceName: 'x'.repeat(200) });
  const result = scanForLeakage(entry);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes('deviceName')));
});

test('hashContent is stable regardless of key order (canonical JSON)', () => {
  const a = { component: 'pump', slug: 's', fields: [{ fieldName: 'x', type: 'number' }] };
  const b = { slug: 's', fields: [{ type: 'number', fieldName: 'x' }], component: 'pump' };
  assert.equal(hashContent(a), hashContent(b));
});

test('hashContent differs when content actually differs', () => {
  const a = validEntry();
  const b = validEntry({ deviceName: 'Different Device' });
  assert.notEqual(hashContent(a), hashContent(b));
});

test('writeAndVerify writes a file and its hash matches the confirmed hash', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sgq-test-'));
  const entry = validEntry();
  const confirmedHash = hashContent(entry);
  const filePath = writeAndVerify(entry, confirmedHash, repoRoot);
  assert.ok(fs.existsSync(filePath));
  const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(hashContent(written), confirmedHash);
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('writeAndVerify deletes the file (nothing pre-existing) on a hash mismatch', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sgq-test-'));
  const entry = validEntry();
  const wrongHash = 'deadbeef'.repeat(8); // deliberately wrong
  assert.throws(() => writeAndVerify(entry, wrongHash, repoRoot));
  const filePath = path.join(repoRoot, 'schema-registry', 'pumps', `${entry.slug}.json`);
  assert.equal(fs.existsSync(filePath), false, 'a fresh mismatch must leave nothing on disk');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('writeAndVerify RESTORES pre-existing legitimate content on a mismatch, rather than deleting it', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sgq-test-'));
  const entry = validEntry();
  const dir = path.join(repoRoot, 'schema-registry', 'pumps');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${entry.slug}.json`);
  const legitimateContent = JSON.stringify({ some: 'previously-merged-entry' });
  fs.writeFileSync(filePath, legitimateContent);

  const wrongHash = 'deadbeef'.repeat(8);
  assert.throws(() => writeAndVerify(entry, wrongHash, repoRoot));

  assert.equal(fs.existsSync(filePath), true, 'a mismatch must never destroy a pre-existing file');
  assert.equal(fs.readFileSync(filePath, 'utf8'), legitimateContent, 'the original content must be restored byte-for-byte');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});
