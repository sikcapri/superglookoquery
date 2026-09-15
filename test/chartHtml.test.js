import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderChartHtml } from '../src/chartHtml.js';

// Regression coverage for a real JSON-in-<script>-tag injection risk found
// 2026-09-15: renderChartHtml splices JSON.stringify(data) directly into a
// `var CHART_DATA = ...;` statement inside a raw <script> block. JSON.stringify
// does not escape "<", so a pass-through Glooko string (e.g. a patient's own
// basal program name, embedded via daySummaries) containing "</script" would
// close the script block early and inject raw HTML into the page. The fix
// escapes every "<" to its unicode form, which closes off the whole class.
function minimalArgs(overrides = {}) {
  return {
    points: [{ t: '2026-01-01T00:00:00.000Z', avg: 6.5, min: 6.0, max: 7.0, n: 12 }],
    boluses: [],
    xAxis: { days: [{ label: 'Jan 1', startT: '2026-01-01T00:00:00.000Z' }] },
    units: 'mmol',
    low: 3.9,
    high: 10.0,
    tirPct: 80,
    timeLowPct: 5,
    timeHighPct: 15,
    avgDisplay: 6.5,
    window: { start: '2026-01-01T00:00:00.000Z', end: '2026-01-02T00:00:00.000Z' },
    daySummaries: [],
    ...overrides,
  };
}

test('renderChartHtml never emits a literal "</script" from embedded data, even when a pass-through string tries to break out', () => {
  const malicious = '</script><script>window.pwned = true;</script>';
  const html = renderChartHtml(
    minimalArgs({
      daySummaries: [
        {
          dayKey: '2026-01-01',
          summary: { settings: [{ activeBasalProgram: malicious }] },
        },
      ],
    })
  );

  // The whole point: no literal "</script" (case-insensitive, since HTML tag
  // matching is) may appear anywhere in the output beyond the one real,
  // fixed closing tag this page is supposed to have.
  const scriptCloses = (html.match(/<\/script/gi) || []).length;
  assert.equal(scriptCloses, 1, `expected exactly the one real </script> tag, found ${scriptCloses} (a data value broke out of the script block)`);

  // The escaped payload must still be present and round-trip correctly once
  // the page's own JS parses it (proving this is an encoding, not a deletion).
  assert.ok(html.includes('\\u003c/script'), 'the malicious string should survive, escaped, inside CHART_DATA');
  const match = html.match(/var CHART_DATA = (.*);\n\(function/s);
  assert.ok(match, 'CHART_DATA assignment must be present');
  const parsed = JSON.parse(match[1].replace(/\\u003c/g, '<'));
  assert.equal(parsed.daySummaries[0].summary.settings[0].activeBasalProgram, malicious);
});

test('renderChartHtml produces valid, parseable CHART_DATA for ordinary data (no false-positive mangling)', () => {
  const html = renderChartHtml(minimalArgs());
  const match = html.match(/var CHART_DATA = (.*);\n\(function/s);
  assert.ok(match);
  const parsed = JSON.parse(match[1]);
  assert.equal(parsed.units, 'mmol');
  assert.equal(parsed.tirPct, 80);
});
