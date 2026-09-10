#!/usr/bin/env node
/**
 * CI-side defense-in-depth for schema-registry/ contributions.
 *
 * A contributor's local guardrail (submit-registry-entry.js's scanForLeakage,
 * run as part of get_registry_contribution_report / submit_registry_contribution)
 * is not the only line of defense before something merges — this script
 * re-runs that same independent pattern-scan, server-side, against every
 * committed *.json file under schema-registry/pumps and schema-registry/cgms.
 * It is deliberately the SAME function the client-side guardrail uses (not a
 * reimplementation) so the two can never drift apart silently.
 *
 * Exits non-zero (failing the PR check) if any file fails the scan, is not
 * valid JSON, or does not look like a registry entry at all.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { scanForLeakage } from '../src/submit-registry-entry.js';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const registryDirs = ['pumps', 'cgms'].map((d) => path.join(repoRoot, 'schema-registry', d));

let hadProblems = false;

for (const dir of registryDirs) {
  if (!fs.existsSync(dir)) continue;

  for (const filename of fs.readdirSync(dir)) {
    if (!filename.endsWith('.json')) continue;
    const filePath = path.join(dir, filename);
    const relPath = path.relative(repoRoot, filePath);

    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      console.error(`FAIL ${relPath}: not valid JSON (${err.message})`);
      hadProblems = true;
      continue;
    }

    const scan = scanForLeakage(entry);
    if (!scan.ok) {
      hadProblems = true;
      console.error(`FAIL ${relPath}:`);
      for (const problem of scan.problems) {
        console.error(`  - ${problem}`);
      }
    } else {
      console.log(`OK   ${relPath}`);
    }
  }
}

if (hadProblems) {
  console.error(
    '\nOne or more schema-registry/ entries failed the independent pattern scan. ' +
      'See CONTRIBUTING.md — entries are meant to arrive via the guardrail ' +
      'sequence (in-chat tools, or the CLI script), not hand-written or hand-edited.'
  );
  process.exit(1);
}

console.log('\nAll schema-registry/ entries passed the pattern scan.');
