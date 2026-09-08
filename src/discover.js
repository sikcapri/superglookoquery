/**
 * discover.js — DESIGN.md section 2b: the on-demand, shareable capability
 * snapshot. Deliberately separate from section 2a's runtime capability
 * state (store.js's `field_capability` table): 2a asks "has this field
 * EVER been seen populated, even once" (the right question for local
 * capability gating, where a false negative wrongly hides a module the
 * account genuinely supports). This file asks a different, stricter
 * question — "is this field populated often enough to be worth reporting
 * as a real characteristic of this device combo" — because a report meant
 * to be shared and contributed to a public registry needs its own
 * confidence threshold, not "happened once."
 *
 * ALLOWLIST-BY-CONSTRUCTION (see DESIGN.md's hardened privacy section):
 * buildReport() below is the only place that reads real archive rows, and
 * it never lets a real value escape into the returned report — the report
 * object is built field-by-field from a fixed set of derived, synthetic
 * properties (fieldName, type, populatedRate, a SYNTHESIZED example). If
 * you're reading this file wondering "where does it redact a real value
 * before output" — it doesn't need to, because it never puts one in the
 * output in the first place. That's the point.
 */

import { ensureDbReady, getTimeline, isPopulatedValue } from './store.js';
import { resolveDbPath } from './paths.js';

const MIN_WINDOW_DAYS = 30;
const MIN_POPULATED_COUNT = 5;
const MIN_POPULATED_RATE = 0.01; // 1%

// Maps this fork's internal record-type categories onto Glooko's own six
// category names (taken from developers.glooko.com's own nav — see
// DESIGN.md) — used only for report labelling, not a live mapping.
const CATEGORY_LABELS = {
  cgm: 'CGM Data',
  bolus: 'Insulin Events',
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

/**
 * Classify a real value's TYPE only (never returned itself) and produce a
 * fixed, fabricated example for that type. Fixed synthetic constants per
 * type, not derived from the real value's magnitude/content — the safest
 * possible construction, since the output can never resemble the real data
 * beyond its JSON type. Nested objects/arrays are flagged unsupported
 * rather than guessed at (see DESIGN.md's "Known follow-ups": a nested
 * field needs different promotion handling than a scalar one, out of scope
 * here).
 */
function classify(sampleValue) {
  if (typeof sampleValue === 'number') {
    return { type: 'number', syntheticExample: 12.34 };
  }
  if (typeof sampleValue === 'boolean') {
    return { type: 'boolean', syntheticExample: true };
  }
  if (typeof sampleValue === 'string') {
    if (ISO_DATE_RE.test(sampleValue)) {
      return { type: 'date', syntheticExample: '2000-01-01T00:00:00.000Z' };
    }
    return { type: 'string', syntheticExample: 'example text' };
  }
  if (sampleValue !== null && typeof sampleValue === 'object') {
    return { type: 'nested-unsupported', syntheticExample: null };
  }
  return { type: 'unknown', syntheticExample: null };
}

/**
 * Tally every field seen in `extra` across `records`, and return only the
 * ones meeting the populated-rate threshold, as allowlisted report entries.
 * `records` here are real archive rows (this function reads real data) —
 * everything it RETURNS is derived/synthetic only.
 */
function summariseCategory(category, records) {
  const counts = new Map(); // fieldName -> populated count
  const sampleTypeValue = new Map(); // fieldName -> one real value, used only to classify type, never returned

  for (const r of records) {
    if (!r.extra) continue;
    for (const [key, value] of Object.entries(r.extra)) {
      if (!isPopulatedValue(value)) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
      if (!sampleTypeValue.has(key)) sampleTypeValue.set(key, value);
    }
  }

  const total = records.length;
  const fields = [];
  for (const [fieldName, populatedCount] of counts.entries()) {
    const populatedRate = total > 0 ? populatedCount / total : 0;
    if (populatedCount < MIN_POPULATED_COUNT && populatedRate < MIN_POPULATED_RATE) {
      continue; // below threshold — not confident this is a real, reportable field
    }
    const { type, syntheticExample } = classify(sampleTypeValue.get(fieldName));
    fields.push({
      fieldName,
      type,
      populatedCount,
      populatedRate: Math.round(populatedRate * 1000) / 1000,
      syntheticExample, // NEVER the real value — see classify()
    });
  }
  fields.sort((a, b) => b.populatedRate - a.populatedRate);
  return { label: CATEGORY_LABELS[category] || category, recordCount: total, fields };
}

/**
 * Build the full discovery report. Reads the local archive only (never
 * contacts Glooko) — this is a snapshot of what's already been synced.
 */
export async function buildReport(dbPath = resolveDbPath()) {
  await ensureDbReady(dbPath);

  const nowEpoch = Math.floor(Date.now() / 1000);
  const windowStart = nowEpoch - MIN_WINDOW_DAYS * 86400;

  const timeline = getTimeline(windowStart, nowEpoch);
  const cgmRecords = timeline.filter((t) => t.type === 'CGM');
  const bolusRecords = timeline.filter((t) => t.type === 'BOLUS');

  const earliestSeen = timeline.length ? Math.min(...timeline.map((t) => t.epoch)) : nowEpoch;
  const actualWindowDays = Math.round(((nowEpoch - earliestSeen) / 86400) * 10) / 10;

  return {
    generatedAt: new Date().toISOString(),
    windowDaysRequested: MIN_WINDOW_DAYS,
    windowDaysActual: actualWindowDays,
    lowConfidence: actualWindowDays < MIN_WINDOW_DAYS,
    categories: {
      cgm: summariseCategory('cgm', cgmRecords),
      bolus: summariseCategory('bolus', bolusRecords),
    },
  };
}

// Which registry component (DESIGN.md section 3: pumps/ vs cgms/) each
// internal record-type category's fields belong to. This is a different
// axis from Glooko's own category labelling above — CATEGORY_LABELS is
// "what kind of data is this" (for display), COMPONENT_FOR_CATEGORY is
// "which physical device does this data come from" (for registry filing).
const COMPONENT_FOR_CATEGORY = {
  bolus: 'pump', // insulin delivery/algorithm fields are pump+algorithm specific
  cgm: 'cgm',
};

function slugify(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * `deviceName` is a real value carried in `extra` on most records (e.g.
 * "CamDiab CamAPS FX") — unlike everything else this file redacts, it's
 * deliberately NOT synthesized: it's the device model name, identical for
 * every user of that device, carrying no patient-identifying information,
 * and it's the whole point of a registry entry (which device is this for).
 * Returns the most common non-null value seen, or null if none.
 */
function findDeviceName(records) {
  const counts = new Map();
  for (const r of records) {
    const name = r.extra?.deviceName;
    if (typeof name === 'string' && name.trim()) {
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  }
  let best = null, bestCount = 0;
  for (const [name, count] of counts.entries()) {
    if (count > bestCount) { best = name; bestCount = count; }
  }
  return best;
}

/**
 * Reshapes buildReport()'s output into the per-component registry-entry
 * format (DESIGN.md section 3 — pumps/ and cgms/ keyed separately, not
 * combo-keyed). Each returned entry is what actually gets written under
 * schema-registry/. `deviceName`/`slug` are real (see findDeviceName);
 * `fields` are the same allowlisted/synthetic entries buildReport already
 * produced — this function only regroups them, it doesn't touch real data
 * itself.
 */
export async function buildComponentReports(dbPath = resolveDbPath()) {
  await ensureDbReady(dbPath);
  const report = await buildReport(dbPath);

  const nowEpoch = Math.floor(Date.now() / 1000);
  const windowStart = nowEpoch - MIN_WINDOW_DAYS * 86400;
  const timeline = getTimeline(windowStart, nowEpoch);

  const entries = [];
  for (const [category, summary] of Object.entries(report.categories)) {
    const component = COMPONENT_FOR_CATEGORY[category] || 'unknown';
    const records = timeline.filter((t) => t.type === category.toUpperCase());
    const deviceName = findDeviceName(records);
    const slug = deviceName ? slugify(deviceName) : `unknown-${category}`;
    entries.push({
      component,
      deviceName: deviceName || null,
      slug,
      discoveredAt: report.generatedAt,
      windowDaysActual: report.windowDaysActual,
      lowConfidence: report.lowConfidence,
      fields: summary.fields,
    });
  }
  return entries;
}

/** Render a report as human-readable text for the mandatory display step
 * (DESIGN.md's submission gating sequence, step 2) — plain text, no
 * external formatting deps needed for a CLI. */
export function renderReportText(report) {
  const lines = [];
  lines.push(`SuperGlookoQuery discovery report`);
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(
    report.lowConfidence
      ? `Window: ${report.windowDaysActual} of ${report.windowDaysRequested} requested days — LOW CONFIDENCE (archive doesn't have a full window yet)`
      : `Window: ${report.windowDaysActual} days`
  );
  lines.push('');
  lines.push('This report contains NO real values from your account — every');
  lines.push('example below is a fixed, fabricated placeholder, not data read');
  lines.push('from your archive. Only field names, types, and how often each');
  lines.push('field appears populated are real.');
  lines.push('');
  lines.push('A field only appears below if used at least 5 times somewhere in');
  lines.push('your archive (not just once) — this report is meant to be shared,');
  lines.push('so a single occurrence isn\'t enough evidence to tell the registry');
  lines.push('"this device supports X." Using a feature once still switches on');
  lines.push('your own local tools for it immediately (a separate mechanism) —');
  lines.push('it just won\'t show up HERE until used a few more times.');
  lines.push('');
  for (const [category, summary] of Object.entries(report.categories)) {
    lines.push(`## ${summary.label} (${summary.recordCount} records in window)`);
    if (!summary.fields.length) {
      lines.push('  (no fields met the reporting threshold)');
    }
    for (const f of summary.fields) {
      lines.push(
        `  - ${f.fieldName}  [${f.type}]  populated ${(f.populatedRate * 100).toFixed(1)}%  example: ${JSON.stringify(f.syntheticExample)}`
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

// CLI entry point: `node src/discover.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  const report = await buildReport();
  console.log(renderReportText(report));
  console.log(
    '\n(This is a preview only — the submit/confirmation flow that lets you\n' +
    'actually contribute this to the schema registry is not built yet.)'
  );
}
