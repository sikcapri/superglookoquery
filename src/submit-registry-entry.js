/**
 * submit-registry-entry.js — DESIGN.md's submission gating sequence:
 *   1. Generate report (discover.js's buildComponentReports)
 *   2. Display it in FULL, with a disclaimer
 *   3. Require a real typed confirmation phrase (not a scriptable flag)
 *   4. Run an INDEPENDENT second pattern-scan — deliberately does not trust
 *      discover.js's own classify()/redaction logic, re-checks the output
 *      against a hard allowlist of known-safe synthetic values
 *   5. Hash the exact confirmed content
 *   6. Write to schema-registry/, then read it back and verify the hash
 *      matches before declaring success — refuses to proceed on mismatch
 *   7. Open a PR (`gh pr create`) for the written files, seamlessly within
 *      the same session — see openRegistryPullRequest(). Only ever runs
 *      after steps 2-6 have already passed; a missing/unauthenticated `gh`,
 *      or any git/gh failure, falls back to "written and verified locally,
 *      finish the push/PR yourself" rather than silently doing nothing or
 *      leaving anything in a half-done state.
 *
 * The functions here are deliberately split into pure/testable pieces
 * (scanForLeakage, hashContent, writeAndVerify) and the interactive CLI
 * orchestration (promptTypedConfirmation, main) — the former can and should
 * be exercised by automated tests; the latter, by its nature, requires a
 * real human typing a real confirmation and can't be meaningfully faked
 * without defeating the entire point of the gate.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import readline from 'readline';
import { execFileSync } from 'child_process';
import { pathToFileURL } from 'url';
import { buildComponentReports } from './discover.js';

const REQUIRED_PHRASE = 'I have reviewed this and confirm it contains no personal data';

// The exact, fixed set of values discover.js's classify() is documented to
// ever produce as a syntheticExample. This scanner does NOT import or call
// classify() — it hardcodes its own copy of what "safe" looks like, on
// purpose. If classify() is ever changed to emit something new without this
// list being updated too, the scan starts FAILING (the safe direction) —
// deliberate coupling, not an oversight; see this file's header comment.
const KNOWN_SAFE_EXAMPLES = new Set([12.34, true, '2000-01-01T00:00:00.000Z', 'example text', null]);
const KNOWN_SAFE_TYPES = new Set(['number', 'boolean', 'date', 'string', 'nested-unsupported', 'unknown']);

/**
 * Independent second check (gating sequence step 4). Walks a component
 * entry and flags anything that doesn't match the hardcoded known-safe
 * shape — including, as defense-in-depth, values that merely *resemble*
 * real health data even if they happen to coincide with an allowed
 * constant (a glucose-plausible number that ISN'T exactly 12.34, an ISO
 * timestamp that ISN'T exactly the fixed placeholder, etc).
 * Returns { ok: boolean, problems: string[] }.
 */
export function scanForLeakage(entry) {
  const problems = [];

  if (entry.deviceName !== null && typeof entry.deviceName !== 'string') {
    problems.push(`deviceName has unexpected type ${typeof entry.deviceName}`);
  }
  if (typeof entry.deviceName === 'string' && entry.deviceName.length > 100) {
    problems.push('deviceName is suspiciously long for a device model name');
  }

  for (const field of entry.fields || []) {
    if (!KNOWN_SAFE_TYPES.has(field.type)) {
      problems.push(`field "${field.fieldName}": unrecognised type "${field.type}"`);
    }
    if (!KNOWN_SAFE_EXAMPLES.has(field.syntheticExample)) {
      problems.push(
        `field "${field.fieldName}": syntheticExample ${JSON.stringify(field.syntheticExample)} is not one of the known-safe fixed placeholders — possible real value leak`
      );
    }
    if (typeof field.populatedRate !== 'number' || field.populatedRate < 0 || field.populatedRate > 1) {
      problems.push(`field "${field.fieldName}": populatedRate ${field.populatedRate} out of [0,1] range`);
    }
    if (typeof field.fieldName !== 'string' || field.fieldName.length > 200) {
      problems.push(`field name is missing or implausibly long — possible real value stored as a key`);
    }
  }

  return { ok: problems.length === 0, problems };
}

/** Canonical (stable key order) JSON string of an entry, for hashing —
 * so hash comparison isn't sensitive to incidental key reordering. */
function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashContent(entry) {
  return crypto.createHash('sha256').update(canonicalize(entry)).digest('hex');
}

function componentFolder(component) {
  if (component === 'pump') return 'pumps';
  if (component === 'cgm') return 'cgms';
  throw new Error(`Unknown component "${component}" — no registry folder for it`);
}

/**
 * Write `entry` to its registry file, then read it back and re-hash it —
 * refuses to report success unless the on-disk content hashes to EXACTLY
 * `confirmedHash` (the hash taken at the moment the user gave their typed
 * confirmation). This is the gating sequence's step 6: confirmation and
 * what-actually-gets-written must be the identical bytes, never a
 * regenerated or edited version.
 */
export function writeAndVerify(entry, confirmedHash, repoRoot) {
  const folder = componentFolder(entry.component);
  const dir = path.join(repoRoot, 'schema-registry', folder);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${entry.slug}.json`);

  // Preserve whatever was already there (e.g. a previously-merged registry
  // entry for this same slug) so a failed verification below restores it
  // instead of just deleting it — a hash-mismatch on THIS run's write is
  // not evidence that a pre-existing file was ever wrong.
  const previousContent = fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;

  const json = JSON.stringify(entry, null, 2);
  fs.writeFileSync(filePath, json);

  const writtenBack = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const rehash = hashContent(writtenBack);
  if (rehash !== confirmedHash) {
    // Refuse silently-wrong output. Restore whatever was there before this
    // call rather than unconditionally deleting — if nothing was there,
    // this correctly removes the file; if something legitimate was there,
    // this correctly puts it back instead of destroying it.
    if (previousContent !== null) fs.writeFileSync(filePath, previousContent);
    else fs.unlinkSync(filePath);
    throw new Error(
      `Content-integrity check failed for ${filePath}: written content does not match what was confirmed (${rehash} != ${confirmedHash}). ` +
      (previousContent !== null ? 'Restored the previous file content.' : 'Nothing was left on disk.')
    );
  }
  return filePath;
}

/** Run a git/gh command and return trimmed stdout, or throw with stderr
 * attached to the error message (execFileSync already avoids any shell,
 * since args are passed as an array, not interpolated into a string). */
function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: opts.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * Whether `gh` is installed and authenticated. DESIGN.md's "no GitHub
 * account fallback" note: submitting a PR inherently needs a GitHub
 * identity, and this project doesn't build dedicated tooling around that
 * gap — a contributor without one gets a manual fallback message instead
 * (see main()'s use of this).
 */
export function ghAvailable() {
  try {
    run('gh', ['auth', 'status']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Opens the PR for one or more already-written-and-verified registry files
 * (DESIGN.md section 2b step 6: "may do so seamlessly within the same AI
 * session... the guardrail is on the content being reviewed and
 * hash-verified before submission, not on requiring the human to manually
 * use GitHub's website"). Called only AFTER every gate above this point —
 * typed confirmation, the independent scan, and the write/re-read hash
 * check — has already passed for every file passed in here.
 *
 * Deliberately narrow: creates one branch, stages exactly the given files
 * (never `git add -A`), commits, pushes, opens the PR, and returns its URL.
 * Any failure partway through is reported with exactly what state was left
 * (branch created, whether it was pushed) rather than silently swallowed or
 * papered over — nothing here is destructive, so a failed attempt just
 * means trying again or finishing the last step by hand.
 */
export function openRegistryPullRequest({ repoRoot, filePaths, slugs, confirmedAtIso }) {
  if (!ghAvailable()) {
    return {
      opened: false,
      reason:
        'gh is not installed/authenticated. Files are written and verified locally — ' +
        'push the branch and open the PR yourself, or see the README for the manual ' +
        'fallback (email the maintainer, or paste the report into a GitHub issue).',
    };
  }

  const relPaths = filePaths.map((p) => path.relative(repoRoot, p));
  const changed = run('git', ['status', '--porcelain', '--', ...relPaths], { cwd: repoRoot });
  if (!changed) {
    return { opened: false, reason: 'No changes to submit — these entries already match what is committed.' };
  }

  const branchName = `schema-registry-contribution-${Date.now()}`;

  try {
    run('git', ['checkout', '-b', branchName], { cwd: repoRoot });
    run('git', ['add', '--', ...relPaths], { cwd: repoRoot });
    run('git', ['commit', '-m', `Add schema registry entries: ${slugs.join(', ')}`], { cwd: repoRoot });
  } catch (err) {
    // Nothing pushed yet — safe to leave the branch as-is for the user to
    // inspect (`git status`), rather than guessing at cleanup.
    return {
      opened: false,
      reason: `Could not commit on branch "${branchName}": ${err.message}. Nothing was pushed.`,
    };
  }

  try {
    run('git', ['push', '-u', 'origin', branchName], { cwd: repoRoot });
    const prUrl = run('gh', [
      'pr', 'create',
      '--title', `Schema registry contribution: ${slugs.join(', ')}`,
      '--body',
      `Auto-generated by \`src/submit-registry-entry.js\` after the full guardrail sequence ` +
      `(typed confirmation, independent leak scan, content-integrity hash check) passed at ${confirmedAtIso}.\n\n` +
      `Entries: ${slugs.join(', ')}\n\n` +
      `No real account values are included — see \`schema-registry/README.md\` for the entry format.`,
      '--head', branchName,
    ], { cwd: repoRoot });
    return { opened: true, url: prUrl, branchName };
  } catch (err) {
    return {
      opened: false,
      reason:
        `Committed locally on branch "${branchName}" but push/PR creation failed: ${err.message}. ` +
        `The commit is safe — push it and run "gh pr create" yourself to finish.`,
    };
  }
}

function renderEntryText(entry) {
  const lines = [];
  lines.push(`=== ${entry.component.toUpperCase()}: ${entry.deviceName || '(unknown device name)'} (slug: ${entry.slug}) ===`);
  lines.push(`Discovered: ${entry.discoveredAt}`);
  if (entry.lowConfidence) lines.push(`LOW CONFIDENCE — archive window is shorter than 30 days`);
  if (!entry.fields.length) {
    lines.push('  (no fields met the reporting threshold for this component)');
  }
  for (const f of entry.fields) {
    lines.push(`  - ${f.fieldName}  [${f.type}]  populated ${(f.populatedRate * 100).toFixed(1)}%  example: ${JSON.stringify(f.syntheticExample)}`);
  }
  return lines.join('\n');
}

function promptTypedConfirmation(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  const repoRoot = path.resolve(new URL('.', import.meta.url).pathname, '..').replace(/^\/([A-Za-z]:)/, '$1');
  const entries = await buildComponentReports();

  console.log('SuperGlookoQuery — schema registry submission\n');
  console.log('This report contains NO real values from your account — every');
  console.log('example is a fixed, fabricated placeholder. Review it in full below.\n');
  for (const entry of entries) {
    console.log(renderEntryText(entry));
    console.log('');
  }

  console.log('DISCLAIMER: by confirming below, you are stating that you have');
  console.log('personally reviewed the report above and it contains no real');
  console.log('values, personal identifiers, or health data from your account.\n');

  const answer = await promptTypedConfirmation(`Type exactly: "${REQUIRED_PHRASE}"\n> `);
  if (answer.trim() !== REQUIRED_PHRASE) {
    console.log('\nConfirmation phrase did not match exactly. Nothing was submitted.');
    process.exitCode = 1;
    return;
  }

  const confirmedAtEpoch = Date.now();
  const confirmedAtIso = new Date(confirmedAtEpoch).toISOString();
  let anyFailed = false;
  const written = []; // { filePath, slug }
  for (const entry of entries) {
    const scan = scanForLeakage(entry);
    if (!scan.ok) {
      console.log(`\nINDEPENDENT SCAN FAILED for ${entry.slug} — refusing to write this entry:`);
      for (const p of scan.problems) console.log(`  - ${p}`);
      anyFailed = true;
      continue;
    }
    const confirmedHash = hashContent(entry);
    try {
      const filePath = writeAndVerify(entry, confirmedHash, repoRoot);
      console.log(`\nWrote and verified: ${filePath} (sha256 ${confirmedHash.slice(0, 12)}...)`);
      written.push({ filePath, slug: entry.slug });
    } catch (err) {
      console.log(`\n${err.message}`);
      anyFailed = true;
    }
  }

  console.log(
    anyFailed
      ? '\nOne or more entries were NOT written — see above. Nothing failed silently.'
      : '\nAll entries written and hash-verified locally.'
  );

  if (!written.length) {
    console.log('\nNothing to submit — no entry made it past the checks above.');
    return;
  }

  console.log('\nOpening a pull request for the written entries...');
  const result = openRegistryPullRequest({
    repoRoot,
    filePaths: written.map((w) => w.filePath),
    slugs: written.map((w) => w.slug),
    confirmedAtIso,
  });
  if (result.opened) {
    console.log(`\nPull request opened: ${result.url}`);
  } else {
    console.log(`\nPR not opened: ${result.reason}`);
    console.log(
      `Files remain staged locally under schema-registry/ (confirmed at ${confirmedAtIso}) — ` +
      'nothing was lost.'
    );
  }
}

// pathToFileURL(), not a naive `file://${process.argv[1]}` string
// comparison — the naive form is broken on Windows and silently never
// matches; see server.js's own guard for the fuller account.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main();
}
