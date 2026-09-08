#!/usr/bin/env node
/**
 * server.js — the MCP server and tool definitions (stdio transport).
 *
 * This is the entry point Claude Desktop launches as an MCPB extension: one
 * Node process, talking MCP over stdio, with no separate stack to run and
 * nothing else listening on any port. Claude Desktop starts it on demand and
 * stops it when the conversation no longer needs it.
 *
 * Each tool is a thin wrapper: validate inputs, resolve the effective glucose
 * unit and boundaries (per-call override, else the server's configured default),
 * pull the data for the window from the archive layer (range.js), hand it to the
 * pure analytics functions (analytics.js), and return the shaped result. The
 * clinical maths lives in analytics.js, not here.
 *
 * Conventions enforced here:
 *  - Credentials come from the environment (GLOOKO_EMAIL / GLOOKO_PASSWORD,
 *    wired in by Claude Desktop from the extension's Settings UI — see
 *    manifest.json's user_config), never from tool arguments.
 *  - All timestamps are plain WALL CLOCK time formatted as ISO 8601, in and
 *    out — NOT true UTC. Glooko records only the literal date/time the
 *    patient's device displayed, with no timezone or offset attached, so a
 *    reading is stamped with wherever the patient physically was when it was
 *    taken. The model passes the patient's own wall-clock digits straight
 *    through with no conversion in either direction (see prompt.js's TIME
 *    ZONES section) — the trailing "Z" in these strings is a wire-format
 *    artifact for parseability only, not a claim that the instant is UTC.
 *  - The server is built by a createServer() factory. Only stdio is ever
 *    connected in practice now, but keeping this as a factory (rather than a
 *    module-level singleton) costs nothing and keeps server construction
 *    testable in isolation.
 */


// Must be the first import: sanitizes the user_config-derived environment
// variables Claude Desktop injects (see src/env.js for why) before any
// other module in this project has a chance to read them.
import './env.js';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

import {
  getProcessedRange,
  assertIsoDate,
  assertWithinCap,
  spanDays,
  CAPS,
} from './range.js';
import { resolveChartsDir } from './paths.js';
import { ensureDbReady, getFieldCapabilities } from './store.js';
import {
  computeSummary,
  calculateHourly,
  buildEnrichedBolusLog,
  buildSplitBolusLog,
  summariseSplitBolusStats,
  bucketTrend,
  downsampleForChart,
  buildChartXAxis,
  buildChartDaySegments,
  buildDaySummaries,
  summariseBasalStates,
  getThresholds,
  calculateTIRMetrics,
  toDisplay,
  toDisplayDelta,
  MGDL_PER_MMOL,
} from './analytics.js';
import { renderChartHtml } from './chartHtml.js';
import { PERSONA_PROMPT } from './prompt.js';

// A FACTORY, not a singleton. Each transport (each stdio process, or each HTTP
// session) needs its OWN McpServer: the SDK forbids connecting one server to
// more than one transport. createServer() builds a fully-registered server.
export function createServer() {
const server = new McpServer({
  name: 'superglookoquery',
  version: '1.0.0',
});

// --- Glucose unit & boundary defaults -------------------------------------
// The user sets their preferred unit and target boundaries ONCE in the
// environment (.env). Tools then use those by default. The per-call units/
// lower/upper parameters are OPTIONAL overrides: omit them to use the
// configured defaults, or pass them for a one-off (e.g. "time under 4.5").
const ENV_UNITS = (() => {
  const u = (process.env.OMNI_UNITS || 'mmol').trim().toLowerCase();
  return u === 'mgdl' ? 'mgdl' : 'mmol'; // anything unrecognised -> mmol
})();
const ENV_LOWER = (() => {
  const v = parseFloat(process.env.OMNI_LOWER);
  return Number.isFinite(v) ? v : ENV_UNITS === 'mgdl' ? 70 : 3.9;
})();
const ENV_UPPER = (() => {
  const v = parseFloat(process.env.OMNI_UPPER);
  return Number.isFinite(v) ? v : ENV_UNITS === 'mgdl' ? 180 : 10.0;
})();

// Resolve the effective unit/boundaries for a call: a provided parameter wins,
// otherwise the environment default applies.
//
// IMPORTANT: ENV_LOWER/ENV_UPPER are fixed numbers in ENV_UNITS (the unit the
// server is configured with) — they are NOT re-derived per call. A caller can
// override `units` alone for a one-off (e.g. "show me this in mg/dL") without
// also passing lower/upper, expecting the configured threshold translated
// into that unit. If we just returned ENV_LOWER/ENV_UPPER unchanged here,
// they'd be silently mislabeled: e.g. a 3.9 mmol/L low boundary would come
// back claiming to be "3.9 mg/dL", off by a factor of ~18. So when the
// effective unit differs from ENV_UNITS and the caller didn't also supply an
// explicit lower/upper, convert the configured default across units first.
function resolveThresholdInputs({ units, lower, upper }) {
  const effectiveUnits = units ?? ENV_UNITS;
  const needsLower = lower == null;
  const needsUpper = upper == null;
  const convert = (v) => {
    if (effectiveUnits === ENV_UNITS) return v;
    return effectiveUnits === 'mgdl' ? v * MGDL_PER_MMOL : v / MGDL_PER_MMOL;
  };
  return {
    units: effectiveUnits,
    lower: needsLower ? convert(ENV_LOWER) : lower,
    upper: needsUpper ? convert(ENV_UPPER) : upper,
  };
}

// Shared threshold inputs reused across tools. All OPTIONAL: when omitted, the
// handler falls back to the env-configured default (see resolveThresholdInputs).
const unitsSchema = z
  .enum(['mmol', 'mgdl'])
  .optional()
  .describe(
    'Optional. Glucose unit for this call. Omit to use the unit configured on ' +
      'the server (OMNI_UNITS). One of: "mmol" (mmol/L) or "mgdl" (mg/dL). ' +
      'Pass only to override the configured unit for this one call.'
  );
const lowerSchema = z
  .number()
  .optional()
  .describe(
    'Optional. Low (hypo) boundary in the chosen unit; readings below it count ' +
      'as time-low. Omit to use the server default (OMNI_LOWER). Pass only to ' +
      'override for this one call, e.g. to ask about time under a different ' +
      'threshold.'
  );
const upperSchema = z
  .number()
  .optional()
  .describe(
    'Optional. High (hyper) boundary in the chosen unit; readings above it ' +
      'count as time-high. Omit to use the server default (OMNI_UPPER). Pass ' +
      'only to override for this one call.'
  );

const startDesc =
  'Required. Window start as an ISO 8601 timestamp, e.g. ' +
  '2026-06-19T00:00:00.000Z. IMPORTANT: despite the trailing "Z", this is ' +
  'plain WALL CLOCK time, not true UTC — Glooko records only the literal ' +
  'date/time the patient\'s device showed, with no timezone attached. Use ' +
  'the patient\'s own wall-clock digits directly (no conversion): resolve ' +
  '"yesterday" or "last 3 weeks" straight into the matching wall-clock date ' +
  'and time. Treated as inclusive.';
const endDesc =
  'Required. Window end as an ISO 8601 timestamp, e.g. ' +
  '2026-06-20T00:00:00.000Z — plain wall clock time, same caveat as start ' +
  '(the "Z" is a format artifact, not a UTC claim). Treated as inclusive and ' +
  'must be after start. All timestamps returned by this API are likewise ' +
  'plain wall clock time, unconverted.';

function jsonResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

function errorResult(message) {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}

// --- get_chart_html point budget -------------------------------------------
// get_chart_html writes its page straight to a file and opens it in the
// browser (see the section below) -- the plotted points are essentially
// NEVER read back by the model (only in the rare embedHtml/auto-open-failed
// fallback), so this budget is sized for what the BROWSER can render
// comfortably, not for LLM token cost. A native CGM reading lands roughly
// every 5 minutes, so 288/day, ~8,640 for a 30-day month. The default below
// clears that with room to spare, so a routine "chart me this month" gets
// every real reading plotted, not smoothed into ~8/day. The cap exists only
// so an accidental very-wide window (e.g. the full 400-day CAPS.summaryMaxDays
// span) doesn't produce an unreasonably large file; it is not meant to be a
// normal ceiling, and downsampleForChart already preserves each bucket's true
// min/max, so an excursion is never smoothed away even when a window IS wide
// enough to need bucketing.
const CHART_DEFAULT_MAX_POINTS = 12000;
const CHART_MAX_POINTS_CAP = 50000;

// --- get_chart_html support: write-to-file + auto-open -------------------
// Why this exists: an earlier version returned the whole chart page inline
// as a JSON string field. That page is a few tens of KB — small for a
// server to generate (well under a second), but the MODEL still has to
// reproduce every one of those characters as its own output before an
// artifact/preview can appear, and token-by-token generation of tens of
// thousands of characters is what actually took minutes, not anything on
// the server side. Writing the page to a real file and opening it directly
// in the OS's default browser sidesteps that entirely: the model only needs
// to report a short confirmation, not retype the page.

/** Keep only the most recent N chart files so this folder doesn't grow forever. */
function pruneOldCharts(dir, keep = 15) {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.html'))
      .map((f) => {
        const full = path.join(dir, f);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const { full } of files.slice(keep)) {
      try {
        fs.unlinkSync(full);
      } catch {
        /* best-effort cleanup only */
      }
    }
  } catch {
    /* directory listing failure is not fatal to chart generation */
  }
}

/**
 * Best-effort: ask the OS to open filePath in the default browser. Resolves
 * true if the open command was launched without an immediate error (e.g. the
 * command exists), false otherwise (unsupported platform, command missing —
 * expected in a plain Linux/dev/test environment with no desktop session).
 * This can never be a hard guarantee a browser window actually appeared
 * (the launch is detached/async), so callers should treat it as "probably
 * opened," not "confirmed."
 */
function tryOpenInBrowser(filePath) {
  return new Promise((resolve) => {
    let cmd;
    let args;
    if (process.platform === 'darwin') {
      cmd = 'open';
      args = [filePath];
    } else if (process.platform === 'win32') {
      cmd = 'cmd';
      args = ['/c', 'start', '""', filePath];
    } else {
      cmd = 'xdg-open'; // best-effort for non-Windows/macOS dev environments
      args = [filePath];
    }
    let settled = false;
    let child;
    try {
      child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    child.on('error', () => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    });
    child.unref();
    // No 'error' event within a short window strongly suggests the command
    // itself launched fine (ENOENT/EACCES fire almost immediately).
    setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(true);
      }
    }, 250);
  });
}

// --- get_diabetes_summary -------------------------------------------------
server.registerTool(
  'get_diabetes_summary',
  {
    title: 'Diabetes summary for a window',
    description:
      'The single best starting point for any overview question ("how was my ' +
      'control yesterday / over the last 3 weeks / last 6 months"). Returns ' +
      'fixed-size aggregates no matter how long the span, so it is cheap to call ' +
      'over months and tolerates very long windows.\n\n' +
      'TIP: because this tool is uncapped, a deliberately wide call (e.g. start ' +
      '2000-01-01T00:00:00.000Z, end tomorrow) is the quickest way to discover ' +
      'how much data the system actually holds: the returned reportRange.start ' +
      'and reportRange.end are the first and last readings present in the ' +
      'archive. Use it as an orientation call before drilling into a specific ' +
      'period.\n\n' +
      'Insulin uses the project-wide rule: bolus is summed from individual ' +
      'events; basal comes from Glooko\'s per-day totals. The basal/bolus split ' +
      'is reported as percentages on a per-day-rate basis (a useful balance ' +
      'metric for a closed-loop system). GMI and CV are computed from the CGM ' +
      'readings.\n\n' +
      'Best/worst day and hour are ranked decisively: Time In Range first, then ' +
      'closeness to the glucose target in force at each reading (median absolute ' +
      'deviation), then variability, and each carries those figures so the ' +
      'ranking is explainable.\n\n' +
      'Returns: reportRange (start, end, days, reflecting the actual data ' +
      'present), glucoseControl (averageBG, gmiEstimatedA1c, stdDev, ' +
      'coefficientOfVariation, variability flag, timeInRange/timeLow/timeHigh, ' +
      'cgmReadingCount); glucoseExtremes (highest and lowest readings, each with ' +
      'every timestamped instance); bestWorst (bestDay, worstDay, bestHour, ' +
      'worstHour, each with tir, medianAbsTargetDev, cv); insulin (observedDays, ' +
      'bolusUnits, bolusUnitsPerDay, bolusEventCount, avgUnitsPerBolus, and when ' +
      'Glooko daily data exists basalUnits, basalDayCount, ' +
      'averageBasalUnitsPerDay, basalPercent, bolusPercent); bolusArchitecture ' +
      '(counts by bolus type); carbs (carbsGrams, carbsPerDay, carbEntryCount); ' +
      'and settings (the time-segmented profiles in force). All timestamps are ' +
      'plain wall clock time (see start/end parameter notes), not UTC.',
    inputSchema: {
      start: z.string().describe(startDesc),
      end: z.string().describe(endDesc),
      units: unitsSchema,
      lower: lowerSchema,
      upper: upperSchema,
    },
  },
  async ({ start, end, units: unitsIn, lower: lowerIn, upper: upperIn }) => {
    try {
      const { units, lower, upper } = resolveThresholdInputs({ units: unitsIn, lower: lowerIn, upper: upperIn });
      const s = assertIsoDate(start, 'start');
      const e = assertIsoDate(end, 'end');
      // No span cap here: this tool returns fixed-size aggregates no matter how
      // large the window, so a multi-year summary costs the LLM the same as a
      // single day. An uncapped summary also lets the user/LLM survey the whole
      // archive to locate periods of interest. SQLite handles the aggregation.
      const thresholds = getThresholds(units, lower, upper);
      const bundle = await getProcessedRange(s, e);
      const unitLabel = units === 'mgdl' ? 'mg/dL' : 'mmol/L';
      const summary = computeSummary(
        bundle.timeline,
        bundle.stats,
        bundle.settingsHistory,
        thresholds,
        unitLabel,
        'exact',
        bundle.dailyInsulin
      );
      summary.servedFromArchive = bundle.servedFromArchive;
      if (!bundle.timeline.length) {
        return jsonResult({
          ...summary,
          note: 'No CGM/bolus data is stored for this window (and none was returned by Glooko on top-up).',
        });
      }
      return jsonResult(summary);
    } catch (err) {
      return errorResult(err.message);
    }
  }
);

// --- get_daily_insulin ----------------------------------------------------
server.registerTool(
  'get_daily_insulin',
  {
    title: 'Daily insulin totals (Glooko per-day figures)',
    description:
      'Glooko\'s own per-day insulin totals shown verbatim: basal units, bolus ' +
      'units and the combined total for each day, plus a window aggregate.\n\n' +
      'Use this when you specifically want the device-reported daily totals (for ' +
      'example a day-by-day basal/bolus table, or "what was my total daily dose ' +
      'each day"). Note: the bolus here is Glooko\'s pre-aggregated daily figure. ' +
      'For bolus aggregated from individual events (the project-wide method used ' +
      'everywhere else), use get_diabetes_summary or get_trend. Basal is only ' +
      'available from Glooko, so this and those tools share the same basal ' +
      'source.\n\n' +
      'The most recent day may be flagged provisional if it is still today and ' +
      'not yet finalised.\n\n' +
      'Returns: source ("glooko-daily"), a days array (date, basalUnits, ' +
      'bolusUnits, totalUnits, provisional), and an aggregate (daysWithData, ' +
      'basalUnits, bolusUnits, totalUnits, basalUnitsPerDay, bolusUnitsPerDay, ' +
      'totalUnitsPerDay, basalPercent). All dates are wall-clock (device-local) days.',
    inputSchema: {
      start: z.string().describe(startDesc),
      end: z.string().describe(endDesc),
    },
  },
  async ({ start, end }) => {
    try {
      const s = assertIsoDate(start, 'start');
      const e = assertIsoDate(end, 'end');
      assertWithinCap(s, e, CAPS.summaryMaxDays, 'get_daily_insulin');
      const bundle = await getProcessedRange(s, e);
      const days = bundle.dailyInsulin || [];

      const round = (n) => (n == null ? null : Math.round(n * 100) / 100);
      const withValues = days.filter((d) => d.totalUnits != null);
      const sum = (key) =>
        withValues.reduce((a, d) => a + (d[key] || 0), 0);
      const n = withValues.length;
      const provisional = days.filter((d) => !d.complete).map((d) => d.dayUtc);

      return jsonResult({
        window: { start: s, end: e },
        source: 'glooko-daily',
        sourceNote:
          "These are Glooko's own per-day totals as reported by the device, " +
          'shown verbatim (not recomputed from individual bolus events). For ' +
          'bolus aggregated from stored events, see get_diabetes_summary or ' +
          'get_trend.',
        days: days.map((d) => ({
          date: d.dayUtc,
          basalUnits: round(d.basalUnits),
          bolusUnits: round(d.bolusUnits),
          totalUnits: round(d.totalUnits),
          provisional: !d.complete,
        })),
        aggregate: n
          ? {
              daysWithData: n,
              basalUnits: round(sum('basalUnits')),
              bolusUnits: round(sum('bolusUnits')),
              totalUnits: round(sum('totalUnits')),
              basalUnitsPerDay: round(sum('basalUnits') / n),
              bolusUnitsPerDay: round(sum('bolusUnits') / n),
              totalUnitsPerDay: round(sum('totalUnits') / n),
              basalPercent:
                sum('totalUnits') > 0
                  ? Math.round((sum('basalUnits') / sum('totalUnits')) * 100)
                  : null,
            }
          : null,
        note:
          provisional.length > 0
            ? `${provisional.length} day(s) are today/provisional and may rise as the day completes: ${provisional.join(', ')}.`
            : undefined,
      });
    } catch (err) {
      return errorResult(err.message);
    }
  }
);

// --- get_enriched_bolus_log ----------------------------------------------
server.registerTool(
  'get_enriched_bolus_log',
  {
    title: 'Enriched bolus log',
    description:
      'Every bolus in the window, each enriched with the context needed to judge ' +
      'whether it was the right dose: the interpolated CGM value at the moment of ' +
      'delivery, and the ISF, carb ratio, target and DIA in force at that time.\n\n' +
      'Each record also carries delivered vs programmed units (delivered < ' +
      'programmed means the bolus was interrupted, flagged interrupted=true); the ' +
      'calculator recommendation broken into recCorrection, recCarbs and ' +
      'recTotal; whether the user overrode it (override: "above" or "below"); the ' +
      'bloodGlucoseInput and its source the calculator used; the bolus class; and ' +
      'isManual.\n\n' +
      'Use it to investigate insulin stacking, bolus-calculator accuracy, ' +
      'interrupted deliveries and user overrides. Filter with "classes" to pull ' +
      'only the bolus types you care about and keep the response small.\n\n' +
      `Capped to ${CAPS.bolusMaxDays} days per call. All glucose values are in the ` +
      'configured unit; times are plain wall clock time (device-local), not UTC.\n\n' +
      'Returns: count, the classes filter applied, and a boluses array of ' +
      'enriched records (each with time, units, delivered, programmed, ' +
      'interrupted, recCorrection, recCarbs, recTotal, override, bgInput, ' +
      'bgSource, cgm_val, class, isManual, and a context object of the settings ' +
      'in force).',
    inputSchema: {
      start: z.string().describe(startDesc),
      end: z.string().describe(endDesc),
      classes: z
        .array(
          z.enum([
            'Meal Bolus',
            'Manual Correction Bolus',
            'System Correction Bolus',
            'Meal With Correction Bolus'
          ])
        )
        .optional()
        .describe(
          'Optional filter. Array of bolus classes to include. Valid values ' +
          '(use these exact strings): "Meal Bolus" (carb-only dose), ' +
          '"Manual Correction Bolus" (user-initiated correction for a high), ' +
          '"System Correction Bolus" (algorithm-initiated correction), ' +
          '"Meal With Correction Bolus" (combined carb + correction dose). ' +
          'Provide one or more to combine, e.g. ["Manual Correction Bolus", ' +
          '"System Correction Bolus"]. Omit or leave empty to return all classes.'
        ),
    },
  },
  async ({ start, end, classes }) => {
    try {
      const s = assertIsoDate(start, 'start');
      const e = assertIsoDate(end, 'end');
      assertWithinCap(s, e, CAPS.bolusMaxDays, 'get_enriched_bolus_log');
      const bundle = await getProcessedRange(s, e);
      const sEpoch = Date.parse(s) / 1000;
      const eEpoch = Date.parse(e) / 1000;
      const slice = bundle.timeline.filter(
        (i) => i.epoch >= sEpoch && i.epoch <= eEpoch
      );
      let log = buildEnrichedBolusLog(slice, bundle.settingsHistory, resolveThresholdInputs({}).units);

      // Elegantly filter by selected classes if provided
      if (classes && classes.length > 0) {
        log = log.filter((b) => classes.includes(b.class));
      }

      return jsonResult({
        window: { start: s, end: e },
        filterApplied: classes && classes.length > 0 ? classes : 'All',
        count: log.length,
        boluses: log,
      });
    } catch (err) {
      return errorResult(err.message);
    }
  }
);

// --- get_split_bolus_log ---------------------------------------------------
server.registerTool(
  'get_split_bolus_log',
  {
    title: 'Split/extended bolus log and stats',
    description:
      'Every SPLIT (extended/dual-wave) bolus in the window — one with a real ' +
      'extended-delivery portion, not a normal single-shot dose — plus aggregate ' +
      'stats over the whole bolus population for the same window.\n\n' +
      'Each logged bolus carries initialDelivery (the up-front units), ' +
      'extendedDelivery (delivered over the extended portion), ' +
      'extendedBolusDurationRaw (Glooko\'s raw duration value for that extended ' +
      'portion — its unit is not yet confirmed against a real sync, see ' +
      'docs/PROMOTION.md, so treat it as an uncalibrated relative figure rather ' +
      'than assuming minutes), and initialPercent (initialDelivery as a percent ' +
      'of total delivered, so a 60/40 split reads as initialPercent: 60).\n\n' +
      'Use it to see whether/how often splitting is actually used, and whether ' +
      'the split ratio or duration correlates with post-meal control (pair with ' +
      'get_meal_window_analysis on individual events).\n\n' +
      `Capped to ${CAPS.bolusMaxDays} days per call. Times are plain wall clock ` +
      'time (device-local), not UTC.\n\n' +
      'Returns: window, stats (totalBoluses, splitCount, splitRatePercent, ' +
      'avgExtendedDurationRaw, avgInitialPercent — all null/0 for a window with ' +
      'no split boluses, which is a normal result, not an error), and a boluses ' +
      'array of the split events themselves.',
    inputSchema: {
      start: z.string().describe(startDesc),
      end: z.string().describe(endDesc),
    },
  },
  async ({ start, end }) => {
    try {
      const s = assertIsoDate(start, 'start');
      const e = assertIsoDate(end, 'end');
      assertWithinCap(s, e, CAPS.bolusMaxDays, 'get_split_bolus_log');
      const bundle = await getProcessedRange(s, e);
      const sEpoch = Date.parse(s) / 1000;
      const eEpoch = Date.parse(e) / 1000;
      const slice = bundle.timeline.filter((i) => i.epoch >= sEpoch && i.epoch <= eEpoch);
      const splitLog = buildSplitBolusLog(slice);
      const stats = summariseSplitBolusStats(slice, splitLog);

      return jsonResult({
        window: { start: s, end: e },
        stats,
        boluses: splitLog,
      });
    } catch (err) {
      return errorResult(err.message);
    }
  }
);

// --- get_hourly_trends ----------------------------------------------------
server.registerTool(
  'get_hourly_trends',
  {
    title: 'Hourly (circadian) trends',
    description:
      'Time In Range and average glucose pooled by clock-hour across the whole ' +
      'window, so every reading that fell in the 07:00 hour on any day is ' +
      'combined into one 07:00 row, and so on for all 24 hours.\n\n' +
      'Use it for "why am I always high/low at a certain time" questions, ' +
      'recurring circadian patterns, the dawn phenomenon and evening highs.\n\n' +
      'Hours are the device\'s own wall-clock hour (not UTC) — this already IS ' +
      'the patient\'s local hour at the time each reading was taken, so present ' +
      'it as-is with no conversion.\n\n' +
      'Returns: a byHour array of up to 24 rows, each with hour (wall clock, ' +
      '"HH:00"), averageBG, timeInRange, timeLow, timeHigh and the reading ' +
      'count for that hour. Glucose values are in the configured unit.',
    inputSchema: {
      start: z.string().describe(startDesc),
      end: z.string().describe(endDesc),
      units: unitsSchema,
      lower: lowerSchema,
      upper: upperSchema,
    },
  },
  async ({ start, end, units: unitsIn, lower: lowerIn, upper: upperIn }) => {
    try {
      const { units, lower, upper } = resolveThresholdInputs({ units: unitsIn, lower: lowerIn, upper: upperIn });
      const s = assertIsoDate(start, 'start');
      const e = assertIsoDate(end, 'end');
      assertWithinCap(s, e, CAPS.hourlyMaxDays, 'get_hourly_trends');
      const thresholds = getThresholds(units, lower, upper);
      const bundle = await getProcessedRange(s, e);
      const hourly = calculateHourly(bundle.timeline, thresholds, units);
      return jsonResult({
        window: { start: s, end: e },
        unit: units === 'mgdl' ? 'mg/dL' : 'mmol/L',
        byHour: hourly,
      });
    } catch (err) {
      return errorResult(err.message);
    }
  }
);

// --- get_settings_history -------------------------------------------------
server.registerTool(
  'get_settings_history',
  {
    title: 'Pump settings history',
    description:
      'Every Omnipod 5 setting change that was in effect during the window, in ' +
      'chronological order: DIA, max basal rate, and the time-segmented target, ' +
      'ISF and carb-ratio profiles.\n\n' +
      'Use it to establish which settings were active at a given time (essential ' +
      'before judging a bolus or an excursion), or to see how settings have been ' +
      'adjusted over a long span.\n\n' +
      'Glucose-based values (target, ISF) are in the configured unit. Effective ' +
      'timestamps are plain wall clock time (device-local), not UTC; the ' +
      'per-segment "from" times are pump-schedule clock-hours.\n\n' +
      'Returns: a settings array, each entry with its effective timestamp, ' +
      'DIA_hours, maxBasalRate, and the targetBg, isf and carbRatio profiles ' +
      '(each a list of {from, value} time segments).',
    inputSchema: {
      start: z.string().describe(startDesc),
      end: z.string().describe(endDesc),
    },
  },
  async ({ start, end }) => {
    try {
      const s = assertIsoDate(start, 'start');
      const e = assertIsoDate(end, 'end');
      assertWithinCap(s, e, CAPS.summaryMaxDays, 'get_settings_history');
      const bundle = await getProcessedRange(s, e);
      // Reuse computeSummary's settings shaping for consistency. Use the
      // configured display unit so target/ISF profiles come back in the user's
      // unit, not always mmol.
      const cfg = resolveThresholdInputs({});
      const summary = computeSummary(
        bundle.timeline,
        bundle.stats,
        bundle.settingsHistory,
        getThresholds(cfg.units, cfg.lower, cfg.upper),
        cfg.units === 'mgdl' ? 'mg/dL' : 'mmol/L'
      );
      return jsonResult({
        window: { start: s, end: e },
        settings: summary.settings,
      });
    } catch (err) {
      return errorResult(err.message);
    }
  }
);

// --- get_trend ------------------------------------------------------------
server.registerTool(
  'get_trend',
  {
    title: 'Bucketed trend over any timeframe',
    description:
      'Glucose, insulin and carb aggregates split into time buckets across a ' +
      'span, for "how have things changed month by month over the last year" ' +
      'style questions.\n\n' +
      'Each bucket is computed independently from the raw readings (not by ' +
      'averaging averages), so a year split by month returns 12 correct rows in ' +
      'a single call without pulling raw data back to you. Prefer this over ' +
      'making many separate summary calls for a multi-period comparison.\n\n' +
      'Insulin per bucket follows the same rule as elsewhere: bolus is summed ' +
      'from individual events; basal comes from Glooko\'s per-day totals. Each ' +
      'bucket also reports observedDays (the real decimal span of data in it) ' +
      'and a coverage percentage, so you can judge which rows to trust.\n\n' +
      'Returns: bucketCount and a buckets array. Each row has: bucket (period ' +
      'key), start, end, observedDays; glucose (avg, timeInRange, timeLow, ' +
      'timeHigh, stdDev, coefficientOfVariation, gmiEstimatedA1c, ' +
      'cgmReadingCount); insulin (bolusUnits, bolusUnitsPerDay, bolusEventCount, ' +
      'avgUnitsPerBolus, and when Glooko daily data exists basalUnits, ' +
      'basalDayCount, averageBasalUnitsPerDay, basalPercent, bolusPercent); ' +
      'carbs (carbsGrams, carbsPerDay, carbEntryCount); and coverage ' +
      '(cgmReadingCount, expectedReadingCount, coveragePercent, trustworthy).',
    inputSchema: {
      start: z.string().describe(startDesc),
      end: z.string().describe(endDesc),
      mode: z
        .enum(['calendar', 'fixed'])
        .default('calendar')
        .describe(
          'Optional (default: "calendar"). How the span is divided into buckets. ' +
            '"calendar" uses real calendar units (days/weeks/months/quarters) with ' +
            'ragged edges at the ends; "fixed" uses equal-length buckets of ' +
            'fixedSizeDays counting from the start date. Choose the bucket size ' +
            'with "granularity" (calendar) or "fixedSizeDays" (fixed).'
        ),
      granularity: z
        .enum(['day', 'week', 'month', 'quarter'])
        .default('month')
        .describe(
          'Optional (default: "month"). Calendar bucket size. Only used when ' +
            'mode is "calendar". One of: "day", "week", "month", "quarter".'
        ),
      fixedSizeDays: z
        .number()
        .int()
        .positive()
        .default(7)
        .describe(
          'Optional (default: 7). Length of each bucket in days. Only used when ' +
            'mode is "fixed".'
        ),
      units: unitsSchema,
      lower: lowerSchema,
      upper: upperSchema,
    },
  },
  async ({ start, end, mode, granularity, fixedSizeDays, units: unitsIn, lower: lowerIn, upper: upperIn }) => {
    try {
      const { units, lower, upper } = resolveThresholdInputs({ units: unitsIn, lower: lowerIn, upper: upperIn });
      const s = assertIsoDate(start, 'start');
      const e = assertIsoDate(end, 'end');
      // Aggregating tool: generous cap, like the summary.
      assertWithinCap(s, e, CAPS.summaryMaxDays, 'get_trend');
      const thresholds = getThresholds(units, lower, upper);
      const bundle = await getProcessedRange(s, e);
      const rows = bucketTrend(
        bundle.timeline,
        thresholds,
        {
          mode,
          granularity,
          fixedSizeDays,
          windowStart: Math.floor(Date.parse(s) / 1000),
          windowEnd: Math.floor(Date.parse(e) / 1000),
          units,
        },
        bundle.dailyInsulin
      );
      return jsonResult({
        window: { start: s, end: e },
        mode,
        granularity: mode === 'calendar' ? granularity : `${fixedSizeDays}d`,
        unit: units === 'mgdl' ? 'mg/dL' : 'mmol/L',
        bucketCount: rows.length,
        buckets: rows,
      });
    } catch (err) {
      return errorResult(err.message);
    }
  }
);

// --- get_chart_series -----------------------------------------------------
server.registerTool(
  'get_chart_series',
  {
    title: 'Downsampled series for plotting',
    description:
      'Glucose downsampled to a target number of points for drawing a chart, ' +
      'with a min/max band per point so spikes are not lost, plus bolus events ' +
      'as overlay markers.\n\n' +
      'Use this whenever the patient wants a GRAPH or CHART of glucose over a ' +
      'window, or when illustrating "what a good/bad day looked like" — a picture ' +
      'of the trace is far more useful here than a table of numbers. It returns a ' +
      'few hundred points instead of every 5-minute reading, so it is far cheaper ' +
      'than get_glucose and a chart cannot show more points than its pixel width ' +
      'anyway. Reserve get_glucose for close-up numeric inspection of a short ' +
      'window, not for wide charts.\n\n' +
      'IMPORTANT — this tool returns DATA, not a picture: after calling it, ' +
      'actually render the points as a visual line/area chart with time on the ' +
      'x-axis and glucose on the y-axis, shading the target range and marking ' +
      'boluses, rather than only describing the numbers in prose. Producing ' +
      'that chart is the point of calling this tool at all.\n\n' +
      'HOW TO RENDER IT — DO NOT use a quick/built-in auto-chart shortcut for ' +
      'this: any lightweight "visualize this data" feature that infers its own ' +
      'axis from a plain array almost always falls back to plotting by point ' +
      'POSITION (1, 2, 3, ...) because it never looks at the `t` field or the ' +
      '`xAxis` data below — this has been confirmed to happen and produces a ' +
      'meaningless, unlabelled time axis. Instead, BUILD A CUSTOM CHART ' +
      'YOURSELF (e.g. an HTML/SVG or JS-charting-library artifact you write) ' +
      'where you explicitly control the x-axis scale and can use the `xAxis` ' +
      'data below directly. If your environment offers both a quick chart ' +
      'shortcut and the ability to write custom HTML/code, always choose the ' +
      'custom option for this tool\'s output.\n\n' +
      'X-AXIS — READ THIS CAREFULLY, this is commonly gotten wrong: the x-axis ' +
      'MUST be a genuine TIME SCALE, NEVER a plain category/index axis showing ' +
      'point position (1, 2, 3, ... maxPoints, or "286"). Points are NOT evenly ' +
      'spaced in time (a sensor gap or the short-fidelity path below means the ' +
      'interval between consecutive points can vary), so an index axis silently ' +
      'distorts time and every tick is meaningless to the reader.\n\n' +
      'To make this hard to get wrong, the response includes a ready-made ' +
      '`xAxis` object — USE IT DIRECTLY instead of inventing your own tick ' +
      'scheme:\n' +
      '  - `xAxis.ticks`: an array of {t, label} already spaced sensibly for ' +
      'the window\'s span (every 3-4 hours for anything up to ~10 days, daily ' +
      'beyond that). Plot these as the x-axis tick marks, using `label` as the ' +
      'tick text VERBATIM — do not recompute your own tick positions or labels.\n' +
      '  - `xAxis.days`: one {startT, endT, label} entry per calendar day the ' +
      'window touches (e.g. "Wed 17 Jun"), present whenever the window spans ' +
      'more than a single day. For a multi-day chart, this is what makes it ' +
      'read correctly: divide the plot into these segments with a vertical ' +
      'divider at each boundary, and print each segment\'s `label` centred ' +
      'underneath — e.g. three equal sections labelled "Wed 17 Jun", "Thu 18 ' +
      'Jun", "Fri 19 Jun" for a 3-day window, each showing that day\'s own ' +
      'hour ticks above it. This is exactly the "N equally spaced, dated ' +
      'sections" layout a multi-day glucose chart needs. `days` is empty for ' +
      'a single-day window (nothing to divide) and for very long windows ' +
      '(too many days to label individually — `ticks` switches to one date ' +
      'label per tick there instead).\n' +
      '  - A gap in the data (missing points) must still show as a visual gap ' +
      'or interrupted line against this time scale — never compressed away.\n\n' +
      'Glucose values are in the configured unit; times are plain wall clock ' +
      'time (device-local), not UTC.\n\n' +
      'Returns: unit, a points array (t, avg, min, max, n per point), an ' +
      'events array of bolus markers for overlay, and xAxis (spanHours, ' +
      'ticks, days) as described above.',
    inputSchema: {
      start: z.string().describe(startDesc),
      end: z.string().describe(endDesc),
      maxPoints: z
        .number()
        .int()
        .min(20)
        .max(1000)
        .default(250)
        .describe(
          'Optional (default: 250). Target number of plotted points (20-1000). ' +
            '200-400 is plenty for a smooth chart at typical screen widths; higher ' +
            'values cost more for little visual gain.'
        ),
    },
  },
  async ({ start, end, maxPoints }) => {
    try {
      const s = assertIsoDate(start, 'start');
      const e = assertIsoDate(end, 'end');
      // Aggregating/downsampling tool: bounded output, so generous span cap.
      assertWithinCap(s, e, CAPS.summaryMaxDays, 'get_chart_series');
      const bundle = await getProcessedRange(s, e);
      const sEpoch = Math.floor(Date.parse(s) / 1000);
      const eEpoch = Math.floor(Date.parse(e) / 1000);
      const slice = bundle.timeline.filter(
        (i) => i.epoch >= sEpoch && i.epoch <= eEpoch
      );
      const chartUnits = resolveThresholdInputs({}).units;
      const series = downsampleForChart(slice, maxPoints, chartUnits);
      const xAxis = buildChartXAxis(sEpoch, eEpoch);
      return jsonResult({
        window: { start: s, end: e },
        unit: chartUnits === 'mgdl' ? 'mg/dL' : 'mmol/L',
        ...series,
        xAxis,
      });
    } catch (err) {
      return errorResult(err.message);
    }
  }
);

// --- get_chart_html ----------------------------------------------------------
// Writes a COMPLETE, ready-to-display HTML page (real geometry, real colors,
// real data — see chartHtml.js) to a file and opens it directly in the
// default browser, instead of returning the page as a JSON string field.
// That earlier design generated fast on the server but was slow end-to-end
// anyway, because the model had to reproduce every character of a
// tens-of-KB page as its own output before anything could appear. Writing a
// file and opening it bypasses that "typed" bottleneck completely — the
// tool call itself does the showing, so the model's job shrinks to a
// one-line confirmation.
server.registerTool(
  'get_chart_html',
  {
    title: 'Open a clinical glucose chart in the browser',
    description:
      'Generates a clinical-report-style glucose chart for a window (or ' +
      'several separate windows via `ranges`) — line trace colour-coded ' +
      'in-range/low/high, a shaded target-range band, a min/max spread band, ' +
      'bolus markers (hoverable in their own right for that bolus\'s units/ ' +
      'carbs/type, in addition to the aligned CGM reading\'s own tooltip), a ' +
      'header stat row (time in range, average glucose, time low, time high), ' +
      'a legend, and hover tooltips — saves it to a file, and ' +
      'opens it directly in the patient\'s default web browser. USE THIS ' +
      'instead of get_chart_series whenever the patient wants to SEE a chart.\n\n' +
      'Multi-day charts open with a Chronological/Overlay toggle: chronological ' +
      'is the usual continuous timeline; overlay re-plots every calendar day on ' +
      'a shared 0-24h axis (colour-coded per day, with a day legend) so days can ' +
      'be compared directly. Use `ranges` instead of start/end when the patient ' +
      'wants to compare specific, possibly non-contiguous dates together (e.g. ' +
      '"the 20th, 23rd and 30th") — every requested day gets equal width on the ' +
      'axis regardless of the calendar gap between them. The page also has a ' +
      'day-filter chip per day (in both views) so the patient can hide/show ' +
      'individual days themselves, with the header stats recalculating for ' +
      'whichever days are still visible — you never need a new call just to ' +
      'compare a subset of the days already shown.\n\n' +
      'The page also includes a "Day details" panel per calendar day (open by ' +
      'default for a single day, collapsed for multiple), with that day\'s full ' +
      'glucose control (average, GMI, TIR/low/high, std dev, CV), extremes ' +
      '(highest/lowest with times), best/worst hour, insulin (bolus units/count/ ' +
      'avg, basal units, bolus-basal split), bolus type counts, carbs, and the ' +
      'settings in force — the SAME figures get_diabetes_summary would return ' +
      'for that single day, computed by the identical aggregator so the two ' +
      'never disagree. Hiding a day\'s filter chip hides its detail panel too.\n\n' +
      'DATA RESOLUTION: a routine call (no `resolution`/`maxPoints` given) ' +
      'already plots every single CGM reading with NO smoothing for a typical ' +
      'window (a day, a week, a full month) — the point budget only kicks in on ' +
      'wider windows, where it keeps each bucket\'s true min/max so no low or ' +
      'high excursion is ever smoothed away, only the moment-to-moment trace ' +
      'between them is thinned. When a call DOES get thinned this way, the ' +
      'result includes a `downsample` object naming the raw vs plotted reading ' +
      'counts — treat that as an invitation to offer the patient a choice, not ' +
      'as data that has become unavailable: mention it in plain terms ("I ' +
      'plotted a lightly smoothed version of this wide a window — want the ' +
      'full-detail version instead? It may take a little longer to load") and, ' +
      'if they want more detail, re-call with `resolution` set to how much of ' +
      'the real data to use — 1 for every single reading, 2 for every other ' +
      'one, 3 for every third, and so on. Never decide this smoothing tradeoff ' +
      'silently on the patient\'s behalf beyond the routine default.\n\n' +
      'CRITICAL — how to respond after calling this, this is what keeps it ' +
      'fast: this tool does the displaying itself. Do NOT copy, re-type, ' +
      'rebuild, or paste the chart as an artifact/code block/canvas yourself — ' +
      'reproducing a large HTML page as your own output is exactly the slow ' +
      'path this tool exists to avoid, and it is unnecessary work since the ' +
      'browser window is already open by the time you respond. If the JSON ' +
      'result has `openAttempted: true`, just tell the patient in one short ' +
      'sentence that the chart has opened in their browser — do not describe ' +
      'or restate its contents in detail, do not emit any HTML/code, and treat ' +
      'the tool call as already complete. If `openAttempted: false`, the auto-' +
      'open could not be launched from this machine (e.g. no recognised ' +
      'default-browser command) — tell the patient to open the file at the ' +
      'returned `filePath` themselves; only in that fallback case, or if ' +
      '`embedHtml` was explicitly requested, does the response also include a ' +
      'full `html` field. Do NOT reach for a quick/built-in "auto-visualize ' +
      'this data" shortcut either — this tool already produces the real chart.\n\n' +
      'Times are plain wall clock time (device-local), not UTC.\n\n' +
      'Returns: ranges (the resolved windows actually used), dayCount, unit, ' +
      'pointCount, bolusCount, filePath (where the page was saved), ' +
      'openAttempted (whether the browser launch was attempted without an ' +
      'immediate error), downsample (only present when the plotted points were ' +
      'thinned from the raw CGM readings — see DATA RESOLUTION above), and — ' +
      'only as a fallback — html.',
    inputSchema: {
      start: z
        .string()
        .optional()
        .describe(startDesc + ' Omit this (and end) when passing `ranges` instead for several separate windows.'),
      end: z
        .string()
        .optional()
        .describe(endDesc + ' Omit this (and start) when passing `ranges` instead for several separate windows.'),
      ranges: z
        .array(
          z.object({
            start: z.string().describe(startDesc),
            end: z.string().describe(endDesc),
          })
        )
        .min(1)
        .max(30)
        .optional()
        .describe(
          'Optional. Use this INSTEAD OF start/end to show several separate, ' +
            'possibly non-contiguous windows on ONE chart -- e.g. "the 20th, ' +
            '23rd and 30th of June" is ranges: [{start:"2026-06-20T00:00:00.000Z", ' +
            'end:"2026-06-21T00:00:00.000Z"}, {start:"2026-06-23T00:00:00.000Z", ' +
            'end:"2026-06-24T00:00:00.000Z"}, {start:"2026-06-30T00:00:00.000Z", ' +
            'end:"2026-07-01T00:00:00.000Z"}] (each entry is that day\'s own ' +
            'midnight to the next day\'s midnight). Ranges can be single days or ' +
            'multi-day spans, do not need to be contiguous, and do not need to ' +
            'be given in order -- the chart always lays them out chronologically ' +
            'and gives every calendar day equal width on the axis, so a 10-day ' +
            'gap between two selected dates does not waste space. The combined ' +
            'span across all ranges is still capped like a normal window. The ' +
            'chart itself also lets the viewer hide/show individual days ' +
            'afterward without a new call.'
        ),
      resolution: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe(
          'Optional. The simple, patient-facing way to control chart detail: a ' +
            'plain divisor for how much of the real CGM data to plot, applied to ' +
            'each range independently. 1 = ALL readings (full native ~5-minute ' +
            'resolution, no downsampling at all, however wide the window -- use ' +
            'this whenever the patient wants full detail and is fine with a ' +
            'larger/slower-to-load file). 2 = every 2nd reading (roughly half), ' +
            '3 = every 3rd (roughly a third), and so on. Omit this in normal use ' +
            '-- see DATA RESOLUTION above for when to offer it as a choice. ' +
            'Overrides `maxPoints` when both are given.'
        ),
      maxPoints: z
        .number()
        .int()
        .min(20)
        .max(CHART_MAX_POINTS_CAP)
        .optional()
        .describe(
          `Optional, advanced. A precise total-point-budget alternative to ` +
            `\`resolution\` (20-${CHART_MAX_POINTS_CAP}), shared across all ranges ` +
            'when `ranges` is used; ignored if `resolution` is also given. Omit ' +
            `both in normal use: the routine default is up to ${CHART_DEFAULT_MAX_POINTS} ` +
            'points, which covers a full month at native cadence with no ' +
            'downsampling -- see DATA RESOLUTION above.'
        ),
      units: unitsSchema,
      lower: lowerSchema,
      upper: upperSchema,
      embedHtml: z
        .boolean()
        .default(false)
        .describe(
          'Optional (default: false). Force the full HTML page to also be ' +
            'included in the response even when the browser auto-open succeeded. ' +
            'Leave this false in normal use — including it costs exactly the ' +
            'slow, large-response-body path this tool is designed to avoid. Only ' +
            'set true if the patient explicitly asks to see the raw page/markup.'
        ),
    },
  },
  async ({ start, end, ranges, resolution, maxPoints, units: unitsIn, lower: lowerIn, upper: upperIn, embedHtml }) => {
    try {
      if (!ranges && (!start || !end)) {
        throw new Error('Provide either start and end, or a ranges array of {start, end} windows.');
      }
      const rawRanges = ranges && ranges.length ? ranges : [{ start, end }];
      const effectiveRanges = rawRanges
        .map((r, i) => {
          const label = ranges ? `ranges[${i}]` : null;
          const s = assertIsoDate(r.start, label ? `${label}.start` : 'start');
          const e = assertIsoDate(r.end, label ? `${label}.end` : 'end');
          assertWithinCap(s, e, CAPS.summaryMaxDays, 'get_chart_html');
          return { start: s, end: e };
        })
        .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

      const totalDays = effectiveRanges.reduce((sum, r) => sum + spanDays(r.start, r.end), 0);
      if (totalDays > CAPS.summaryMaxDays) {
        throw new Error(
          `Combined span across all ranges is ${totalDays.toFixed(1)} days, which exceeds ` +
            `the ${CAPS.summaryMaxDays}-day limit for get_chart_html. Request fewer or narrower ranges.`
        );
      }

      const { units, lower, upper } = resolveThresholdInputs({ units: unitsIn, lower: lowerIn, upper: upperIn });
      const unitLabel = units === 'mgdl' ? 'mg/dL' : 'mmol/L';
      const thresholdsMmol = getThresholds(units, lower, upper);
      const effectiveMaxPoints = maxPoints ?? CHART_DEFAULT_MAX_POINTS;

      const allPoints = [];
      const allBoluses = [];
      const allDays = [];
      const allDaySummaries = [];
      const allCgmMmol = [];
      let rawCgmReadingCount = 0;
      for (const r of effectiveRanges) {
        const bundle = await getProcessedRange(r.start, r.end);
        const sEpoch = Math.floor(Date.parse(r.start) / 1000);
        const eEpoch = Math.floor(Date.parse(r.end) / 1000);
        const slice = bundle.timeline.filter((i) => i.epoch >= sEpoch && i.epoch <= eEpoch);
        const rawCgmForRange = slice.filter((i) => i.type === 'CGM').length;
        rawCgmReadingCount += rawCgmForRange;
        const rangeDays = Math.max(spanDays(r.start, r.end), 1 / 24);
        // Each range is downsampled independently (never pooled into one
        // global bucket pass) -- otherwise a bucket could straddle the dead
        // time between two disconnected dates and silently smear them
        // together.
        let rangeMaxPoints;
        if (resolution != null) {
          // `resolution` is a plain divisor of THIS range's own raw reading
          // count -- 1 means "every reading", so the target IS the raw count
          // and downsampleForChart's own pass-through-when-under-cap behaviour
          // takes over, giving true full resolution with no forced ceiling.
          rangeMaxPoints = Math.max(2, Math.ceil(rawCgmForRange / resolution));
        } else {
          // No explicit resolution: share the point budget proportional to
          // each range's own length.
          rangeMaxPoints = Math.max(10, Math.round((effectiveMaxPoints * rangeDays) / totalDays));
        }
        const series = downsampleForChart(slice, rangeMaxPoints, units);
        allPoints.push(...series.points);
        allBoluses.push(...series.boluses);
        const daySegs = buildChartDaySegments(sEpoch, eEpoch);
        allDays.push(...daySegs);
        // Full clinical detail per calendar day (glucose control, extremes,
        // best/worst hour, insulin, carbs, settings in force) -- the SAME
        // aggregator get_diabetes_summary uses, just narrowed to one day at
        // a time, so the chart's day panels never drift from that tool's
        // own numbers.
        allDaySummaries.push(
          ...buildDaySummaries(daySegs, bundle.timeline, bundle.dailyInsulin, bundle.settingsHistory, thresholdsMmol, unitLabel)
        );
        allCgmMmol.push(...slice.filter((i) => i.type === 'CGM').map((i) => i.val));
      }
      allPoints.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
      allBoluses.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));

      const xAxis = { days: allDays };

      const tirMetrics = calculateTIRMetrics(allCgmMmol, thresholdsMmol);
      const avgMmol = allCgmMmol.length
        ? allCgmMmol.reduce((a, b) => a + b, 0) / allCgmMmol.length
        : null;

      const html = renderChartHtml({
        points: allPoints,
        boluses: allBoluses,
        xAxis,
        units,
        low: lower,
        high: upper,
        tirPct: tirMetrics.tir,
        timeLowPct: tirMetrics.low,
        timeHighPct: tirMetrics.high,
        avgDisplay: toDisplay(avgMmol, units),
        window: { start: effectiveRanges[0].start, end: effectiveRanges[effectiveRanges.length - 1].end },
        daySummaries: allDaySummaries,
      });

      const chartsDir = resolveChartsDir();
      fs.mkdirSync(chartsDir, { recursive: true });
      const filePath = path.join(chartsDir, `glucose-chart-${Date.now()}.html`);
      fs.writeFileSync(filePath, html, 'utf8');
      pruneOldCharts(chartsDir);

      const openAttempted = await tryOpenInBrowser(filePath);

      const result = {
        ranges: effectiveRanges,
        dayCount: allDays.length,
        unit: units === 'mgdl' ? 'mg/dL' : 'mmol/L',
        pointCount: allPoints.length,
        bolusCount: allBoluses.length,
        filePath,
        openAttempted,
      };
      // Only present when the plotted points were actually thinned from the
      // raw CGM readings (never when resolution:1 was explicitly requested,
      // since that always plots the full raw count 1:1). An invitation to
      // offer the patient a choice, not a claim that data is unavailable --
      // see this tool's DATA RESOLUTION description.
      if (allPoints.length < rawCgmReadingCount) {
        const ratio = rawCgmReadingCount / allPoints.length;
        result.downsample = {
          rawCgmReadingCount,
          plottedPointCount: allPoints.length,
          note:
            `Plotted ${allPoints.length} of ${rawCgmReadingCount} raw CGM readings ` +
            `(about 1 in ${ratio.toFixed(1)}) to keep the file a reasonable size for ` +
            'this wide a window. Each plotted point still keeps its bucket\'s true ' +
            'min/max, so no low or high excursion is smoothed away -- only the ' +
            'moment-to-moment trace between them is thinned. Offer the patient ' +
            'the choice of full detail: re-call with resolution: 1 for every ' +
            'reading, 2 for every other one, 3 for every third, etc.',
        };
      }
      if (embedHtml || !openAttempted) {
        result.html = html;
      }
      return jsonResult(result);
    } catch (err) {
      return errorResult(err.message);
    }
  }
);

// --- get_basal_delivery ---------------------------------------------------
server.registerTool(
  'get_basal_delivery',
  {
    title: 'Basal delivery state timeline',
    description:
      'What the Omnipod 5 was doing with basal over time: delivering normally, ' +
      'pausing it (suspend), running at its ceiling (max), or running blind on a ' +
      'fixed preset because it lost CGM signal (limited).\n\n' +
      'IMPORTANT: these are STATES describing the algorithm\'s behaviour, NOT ' +
      'insulin amounts. "suspend" means paused, "max" means at the ceiling; ' +
      'neither is a number of units. (For basal units, use get_daily_insulin.)\n\n' +
      'Use it to investigate lows (was basal already suspended beforehand?), ' +
      'rebound patterns (max, then suspend, then a low), how hard the system is ' +
      'working, and whether excursions coincided with limited mode (algorithm ' +
      'not adjusting at all).\n\n' +
      'Times are plain wall clock time (device-local), not UTC. Capped to a ' +
      'generous span since it returns collapsed intervals, not raw points.\n\n' +
      'Returns: a summary of minutes and percentage per state ' +
      '(normal/suspend/max/limited) and, unless includeIntervals is false, an ' +
      'intervals array (state, start, end, minutes).',
    inputSchema: {
      start: z.string().describe(startDesc),
      end: z.string().describe(endDesc),
      includeIntervals: z
        .boolean()
        .default(true)
        .describe(
          'Optional (default: true). Whether to include the full interval ' +
            'timeline. Set false to get only the per-state summary totals, which ' +
            'is much smaller over a long span.'
        ),
    },
  },
  async ({ start, end, includeIntervals }) => {
    try {
      const s = assertIsoDate(start, 'start');
      const e = assertIsoDate(end, 'end');
      assertWithinCap(s, e, CAPS.summaryMaxDays, 'get_basal_delivery');
      const bundle = await getProcessedRange(s, e);
      const intervals = bundle.basalStates || [];
      const summary = summariseBasalStates(intervals);
      const result = {
        window: { start: s, end: e },
        summary,
      };
      if (includeIntervals) {
        result.intervals = intervals.map((i) => ({
          state: i.state,
          start: i.start,
          end: i.end,
          minutes: i.minutes,
        }));
      }
      return jsonResult(result);
    } catch (err) {
      return errorResult(err.message);
    }
  }
);

// --- get_device_events ----------------------------------------------------
server.registerTool(
  'get_device_events',
  {
    title: 'Pod and CGM sensor changes',
    description:
      'Pod changes (the Omnipod is replaced roughly every 3 days) and CGM sensor ' +
      'changes, as timestamped events, kept as two separate lists.\n\n' +
      'These are point-in-time markers, not amounts. They are most useful as ' +
      'CONTEXT for nearby glucose disruption: a fresh pod can run high for the ' +
      'first hours while the cannula settles, and a new sensor can read ' +
      'erratically while it warms up. Use them to check whether an unexplained ' +
      'high or a run of odd readings lines up with a recent change. Treat any ' +
      'such link as a possible contributing factor, never assert it as the ' +
      'cause.\n\n' +
      'Times are plain wall clock time (device-local), not UTC.\n\n' +
      'Returns: podChanges and sensorChanges arrays of wall-clock timestamps, ' +
      'plus a count for each.',
    inputSchema: {
      start: z.string().describe(startDesc),
      end: z.string().describe(endDesc),
    },
  },
  async ({ start, end }) => {
    try {
      const s = assertIsoDate(start, 'start');
      const e = assertIsoDate(end, 'end');
      assertWithinCap(s, e, CAPS.summaryMaxDays, 'get_device_events');
      const bundle = await getProcessedRange(s, e);
      const ev = bundle.deviceEvents || { podChanges: [], sensorChanges: [] };
      return jsonResult({
        window: { start: s, end: e },
        podChanges: ev.podChanges.map((x) => x.time),
        sensorChanges: ev.sensorChanges.map((x) => x.time),
        counts: {
          podChanges: ev.podChanges.length,
          sensorChanges: ev.sensorChanges.length,
        },
      });
    } catch (err) {
      return errorResult(err.message);
    }
  }
);


// --- get_glucose ----------------------------------------------------------
server.registerTool(
  'get_glucose',
  {
    title: 'Glucose readings for a window (filterable by band)',
    description:
      'Individual timestamped CGM readings for a window, optionally filtered to ' +
      'just the part of the range you care about.\n\n' +
      'The "band" option decides which readings come back: "low" (below the low ' +
      'boundary, i.e. hypos), "high" (above the high boundary), "target" (in ' +
      'range), or "all" (every reading, each tagged with its band). Use ' +
      '"low"/"high" to pull only excursions for a close look without dragging in ' +
      'thousands of normal readings; "all" gives the full trace.\n\n' +
      'This returns raw points, so it is capped to ' +
      `${CAPS.timelineMaxDays} days. For a wide chart use get_chart_series ` +
      '(downsampled); for aggregate stats use get_diabetes_summary or get_trend ' +
      'rather than computing over a raw array yourself.\n\n' +
      'Glucose values are in the configured unit; times are plain wall clock ' +
      'time (device-local), not UTC.\n\n' +
      'Returns: window, thresholdsUsed (lower, upper, unit), the band requested, ' +
      'count, and a readings array (time, value, velocity, plus band when ' +
      'band="all").',
    inputSchema: {
      start: z.string().describe(startDesc),
      end: z.string().describe(endDesc),
      units: unitsSchema,
      lower: lowerSchema,
      upper: upperSchema,
      band: z
        .enum(['low', 'high', 'target', 'all'])
        .default('all')
        .describe(
          'Optional (default: "all"). Which readings to return. "low" = below ' +
            'the low boundary (hypo); "high" = above the high boundary (hyper); ' +
            '"target" = in range, between the boundaries inclusive; "all" = every ' +
            'reading, each tagged with its band.'
        ),
    },
  },
  async ({ start, end, units: unitsIn, lower: lowerIn, upper: upperIn, band }) => {
    try {
      const { units, lower, upper } = resolveThresholdInputs({ units: unitsIn, lower: lowerIn, upper: upperIn });
      const s = assertIsoDate(start, 'start');
      const e = assertIsoDate(end, 'end');
      assertWithinCap(s, e, CAPS.timelineMaxDays, 'get_glucose');
      const thresholds = getThresholds(units, lower, upper);
      const bundle = await getProcessedRange(s, e);

      const sEpoch = Date.parse(s) / 1000;
      const eEpoch = Date.parse(e) / 1000;

      // Classify a reading relative to the boundaries. Target is inclusive of
      // both boundaries; low/high are strictly outside them.
      const bandOf = (v) => {
        if (v < thresholds.low) return 'low';
        if (v > thresholds.high) return 'high';
        return 'target';
      };

      const readings = bundle.timeline
        .filter((i) => {
          if (i.type !== 'CGM') return false;
          if (i.epoch < sEpoch || i.epoch > eEpoch) return false;
          if (band === 'all') return true;
          return bandOf(i.val) === band;
        })
        .map((i) => {
          const r = { time: i.time, value: toDisplay(i.val, units), velocity: toDisplayDelta(i.vel, units) };
          if (band === 'all') r.band = bandOf(i.val);
          return r;
        });

      return jsonResult({
        window: { start: s, end: e },
        thresholdsUsed: {
          lower: toDisplay(thresholds.low, units),
          upper: toDisplay(thresholds.high, units),
          unit: units,
        },
        band,
        count: readings.length,
        readings,
      });
    } catch (err) {
      return errorResult(err.message);
    }
  }
);


// --- get_meal_window_analysis --------------------------------------------
server.registerTool(
  'get_meal_window_analysis',
  {
    title: 'Post-meal target window analysis',
    description:
      'A focused look around a single event (typically a meal bolus): exactly 30 ' +
      'minutes before and 3 hours after the timestamp you pass.\n\n' +
      'Use it to judge a post-meal excursion and how well a dose worked, without ' +
      'pulling whole days. Find the event time first (e.g. from ' +
      'get_enriched_bolus_log), then pass it here.\n\n' +
      'Glucose values are in the configured unit; times are plain wall clock ' +
      'time (device-local), not UTC.\n\n' +
      'Returns: targetEvent (the timestamp you passed), unit, a glucoseTimeline ' +
      'array (time, value) across the window, and an associatedBoluses array of ' +
      'enriched bolus records that fall in the window.',
    inputSchema: {
      eventTimestamp: z.string().describe('The concrete ISO 8601 timestamp of the meal/bolus event, in plain wall clock time (device-local) — use the exact wall-clock digits, no UTC conversion. Returned times are likewise wall clock, not UTC.'),
      units: unitsSchema,
    },
  },
  async ({ eventTimestamp, units: unitsIn }) => {
    try {
      const { units } = resolveThresholdInputs({ units: unitsIn });
      const eventEpoch = Date.parse(assertIsoDate(eventTimestamp, 'eventTimestamp'));
      const startIso = new Date(eventEpoch - 30 * 60 * 1000).toISOString();
      const endIso = new Date(eventEpoch + 180 * 60 * 1000).toISOString();

      const bundle = await getProcessedRange(startIso, endIso);
      const sEpoch = Date.parse(startIso) / 1000;
      const eEpoch = Date.parse(endIso) / 1000;

      const slice = bundle.timeline.filter((i) => i.epoch >= sEpoch && i.epoch <= eEpoch);
      const cgm = slice.filter((i) => i.type === 'CGM');
      const boluses = buildEnrichedBolusLog(slice, bundle.settingsHistory, units);

      return jsonResult({
        targetEvent: eventTimestamp,
        unit: units === 'mgdl' ? 'mg/dL' : 'mmol/L',
        glucoseTimeline: cgm.map((i) => ({ time: i.time, value: toDisplay(i.val, units) })),
        associatedBoluses: boluses,
      });
    } catch (err) {
      return errorResult(err.message);
    }
  }
);


// --- persona prompt -------------------------------------------------------
server.registerPrompt(
  'clinical_auditor',
  {
    title: 'Clinical auditor persona',
    description:
      'The tough-love endocrinologist persona and audit workflow. Load this to ' +
      'set the analytical frame before asking diabetes questions.',
  },
  () => ({
    messages: [
      {
        role: 'user',
        content: { type: 'text', text: PERSONA_PROMPT },
      },
    ],
  })
);

  return server;
}

// --- Capability-gated modules (DESIGN.md section 4) -----------------------
//
// A gated module's tools must genuinely not appear for an account that has
// never populated the fields they depend on (not an error, not a tool that
// returns nulls — absent). That check needs `field_capability` out of the
// archive, which means real DB I/O — and createServer() above is
// deliberately synchronous and DB-free, because it runs before the MCP
// transport connects, and any I/O there would delay the `initialize`
// handshake every client probes with first (see range.js / store.js's
// ensureDbReady() comments for the full rationale; this file's own core
// tools rely on that same laziness).
//
// So gated modules register in a separate, later step: main() awaits
// server.connect() first (the handshake can proceed immediately, same as
// today), then calls registerCapabilityGatedModules() afterward. The SDK's
// registerTool() works fine post-connect — a tool added at this point sends
// the client a tools/list_changed notification, which is the correct
// "a module just switched on" signal rather than something the client has to
// poll for.
//
// No gated module exists yet — Phase 2 (docs/TODO.md) adds the first one
// (a CamAPS pump-mode breakdown tool gated on the camapsPumpMode* fields).
// This array is where that entry goes; the mechanism below is what makes
// adding it a matter of describing requirements, not writing new plumbing.
const GATED_MODULES = [
  // {
  //   name: 'camaps_pump_mode',
  //   requires: [{ category: 'bolus', fieldName: 'camapsPumpModeAutomaticPercentage' }],
  //   register: (server) => { server.registerTool('get_pump_mode_breakdown', { ... }, async () => { ... }); },
  // },
];

/**
 * Registers every module in GATED_MODULES whose required fields are ALL
 * confirmed present for this account (per store.js's monotonic
 * field_capability state), and silently skips the rest. Must run after
 * server.connect() — see the comment above GATED_MODULES for why.
 */
export async function registerCapabilityGatedModules(server) {
  if (!GATED_MODULES.length) return;

  await ensureDbReady();
  const confirmed = new Set(
    getFieldCapabilities().map((c) => `${c.category}:${c.fieldName}`)
  );

  for (const mod of GATED_MODULES) {
    const satisfied = mod.requires.every((r) => confirmed.has(`${r.category}:${r.fieldName}`));
    if (satisfied) mod.register(server);
  }
}

async function main() {
  const transport = new StdioServerTransport();
  const server = createServer();
  await server.connect(transport);
  // stderr is safe for logging; stdout is the MCP channel.
  console.error('[superglookoquery] MCP server running on stdio.');

  // Runs after connect so a slow/first-run DB open never delays `initialize`
  // (see the comment above GATED_MODULES). A failure here shouldn't take
  // down a server whose core tools are already live and working.
  try {
    await registerCapabilityGatedModules(server);
  } catch (err) {
    console.error('[superglookoquery] Capability-gated module registration failed (core tools unaffected):', err.message);
  }
}

main().catch((err) => {
  console.error('[superglookoquery] Fatal:', err);
  process.exit(1);
});
