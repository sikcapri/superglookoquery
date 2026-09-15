/**
 * chartHtml.js — renders the get_chart_html tool's HTML page.
 *
 * ARCHITECTURE (v2 — rewritten after the first version proved slow and broke
 * on a multi-day window): this file no longer computes chart GEOMETRY on the
 * server. It is a genuinely STATIC shell — a fixed HTML/CSS/JS document,
 * defined once as module-level string constants (HTML_HEAD / HTML_TAIL) — with
 * one small JSON data blob spliced in between. All scaling, axis-tick
 * placement, zone-coloring, gap detection, and the hover/tooltip/table
 * machinery happen in the browser, computed generically from the data's own
 * time/value extents. That is what makes it handle ANY window (a single day
 * or many weeks) without server-side per-range logic: the server does no
 * more work for a 3-day window than a 1-day one, since it never touches
 * pixels — it only aggregates numbers (TIR%, average) and passes the
 * downsampled points through as-is.
 *
 * v3 (day-slot x-axis): the chronological view's x-axis moved from "one
 * linear epoch scale across [windowStart, windowEnd]" to "each calendar day
 * gets an equal-width slot, in chronological order". A single day's pixel
 * mapping doesn't change, but this is what makes two further features
 * possible without server involvement: (1) DISCONNECTED date selections
 * (e.g. the 20th, 23rd and 30th of a month shown together) no longer waste
 * most of the axis on the days in between, since a slot only exists for a
 * day that's actually present; (2) hiding a day from either view (a client-
 * side filter, no new tool call) just removes its slot and the remaining
 * days re-pack to fill the width, in both chronological and overlay modes.
 * A line NEVER bridges across a day-slot boundary (even for genuinely
 * back-to-back days) since that would visually claim continuity a
 * disconnected selection doesn't have.
 *
 * Design still follows the workspace's dataviz skill: color assigned by the
 * job it does (the glucose line is a STATUS encoding — in-range/low/high,
 * not a categorical series; the min/max band is a neutral spread indicator;
 * bolus markers are a distinct categorical identity; day identity in overlay
 * mode is the validated categorical palette), documented palette steps only,
 * fixed mark specs (2px lines, hairline gridlines), a legend, and a
 * mandatory hover layer (crosshair + tooltip) backed by a table view so
 * every value stays reachable without hovering.
 *
 * All timestamps in/out are plain wall-clock time (see analytics.js's top
 * comment) — nothing in this module ever applies a timezone conversion.
 */

import { formatDayLabel, wallClockParts } from './analytics.js';

// --- palette (dataviz skill's validated reference instance; see the skill's
// references/palette.md — these hex values are copied verbatim, not
// eyeballed) ----------------------------------------------------------------
// Categorical slots 1-8, verbatim from the dataviz skill's reference palette
// (blue, orange, aqua, yellow, magenta, green, violet, red) -- used ONLY for
// day-identity coloring (overlay mode, and the day-filter chips in EITHER
// mode so the same day reads as the same color everywhere on the page).
// Never mix these with the status colors above (good/warning/serious/
// critical): a status color means good/bad, a categorical color means
// "which day" -- the skill's collision rule says a chart never wears both
// meanings on the same hue channel. Only the first 3 slots pass the
// "all-pairs" CVD check (any two can be visual neighbors, as they can in an
// overlay); beyond 3 days, the legend + direct end-of-line labels carry the
// distinction, not hue alone.
const L_CAT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
const D_CAT = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];

const L = {
  surface: '#fcfcfb', page: '#f9f9f7', ink: '#0b0b0b', inkSecondary: '#52514e', inkMuted: '#898781',
  gridline: '#e1e0d9', axis: '#c3c2b7', good: '#0ca30c', warning: '#fab219', serious: '#ec835a',
  critical: '#d03b3b', seriesBlue: '#2a78d6', seriesViolet: '#4a3aa7', border: 'rgba(11,11,11,0.10)',
};
const D = {
  surface: '#1a1a19', page: '#0d0d0d', ink: '#ffffff', inkSecondary: '#c3c2b7', inkMuted: '#898781',
  gridline: '#2c2c2a', axis: '#383835', good: '#0ca30c', warning: '#fab219', serious: '#ec835a',
  critical: '#e66767', seriesBlue: '#3987e5', seriesViolet: '#9085e9', border: 'rgba(255,255,255,0.10)',
};

const CAT_VARS_LIGHT = L_CAT.map((hex, i) => `--cat-${i + 1}: ${hex};`).join(' ');
const CAT_VARS_DARK = D_CAT.map((hex, i) => `--cat-${i + 1}: ${hex};`).join(' ');

// --- the shell: fixed, built once at module load, never rebuilt per call --
// (only the JSON data blob spliced between HTML_HEAD and HTML_TAIL differs
// from one get_chart_html response to the next).
const HTML_HEAD = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Glucose trace</title>
<style>
  :root {
    color-scheme: light;
    --surface: ${L.surface}; --page: ${L.page}; --ink: ${L.ink}; --ink-secondary: ${L.inkSecondary};
    --ink-muted: ${L.inkMuted}; --gridline: ${L.gridline}; --axis: ${L.axis};
    --good: ${L.good}; --warning: ${L.warning}; --serious: ${L.serious}; --critical: ${L.critical};
    --series-blue: ${L.seriesBlue}; --series-violet: ${L.seriesViolet}; --border: ${L.border};
    ${CAT_VARS_LIGHT}
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --surface: ${D.surface}; --page: ${D.page}; --ink: ${D.ink}; --ink-secondary: ${D.inkSecondary};
      --ink-muted: ${D.inkMuted}; --gridline: ${D.gridline}; --axis: ${D.axis};
      --good: ${D.good}; --warning: ${D.warning}; --serious: ${D.serious}; --critical: ${D.critical};
      --series-blue: ${D.seriesBlue}; --series-violet: ${D.seriesViolet}; --border: ${D.border};
      ${CAT_VARS_DARK}
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --surface: ${D.surface}; --page: ${D.page}; --ink: ${D.ink}; --ink-secondary: ${D.inkSecondary};
    --ink-muted: ${D.inkMuted}; --gridline: ${D.gridline}; --axis: ${D.axis};
    --good: ${D.good}; --warning: ${D.warning}; --serious: ${D.serious}; --critical: ${D.critical};
    --series-blue: ${D.seriesBlue}; --series-violet: ${D.seriesViolet}; --border: ${D.border};
    ${CAT_VARS_DARK}
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--page); color: var(--ink);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    padding: 16px;
  }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 20px; max-width: 980px; margin: 0 auto; }
  .card-title { font-size: 18px; font-weight: 600; margin: 0 0 2px; }
  .card-subtitle { font-size: 13px; color: var(--ink-secondary); margin: 0 0 16px; min-height: 16px; }
  .day-filter { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
  .day-chip {
    display: inline-flex; align-items: center; gap: 6px; font: inherit; font-size: 12px;
    color: var(--ink-secondary); background: var(--page); border: 1px solid var(--border);
    border-radius: 999px; padding: 4px 10px 4px 8px; cursor: pointer;
  }
  .day-chip-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: none; }
  .day-chip.hidden-day { opacity: 0.45; text-decoration: line-through; }
  .filter-note { font-size: 11px; color: var(--ink-muted); margin: -6px 0 14px; font-style: italic; }
  .stat-row { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 18px; }
  .stat-tile { flex: 1 1 120px; background: var(--page); border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px; }
  .stat-label { font-size: 12px; color: var(--ink-muted); margin-bottom: 4px; }
  .stat-value { font-size: 22px; font-weight: 600; }
  .chart-wrap { position: relative; overflow-x: auto; }
  svg { width: 100%; height: auto; display: block; min-width: 480px; }
  .gridline { stroke: var(--gridline); stroke-width: 1; }
  .gridline-v { opacity: 0.6; }
  .y-tick, .x-tick, .day-label { fill: var(--ink-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
  .day-label { font-size: 12px; fill: var(--ink-secondary); font-weight: 600; }
  .day-divider { stroke: var(--axis); stroke-width: 1; }
  .target-band { fill: var(--good); opacity: 0.10; }
  .target-line { stroke: var(--good); stroke-width: 1; opacity: 0.55; }
  .band-fill { fill: var(--series-blue); opacity: 0.12; stroke: none; }
  .zone-line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  .zone-dot { stroke: none; }
  .zone-good { stroke: var(--good); }
  .zone-critical { stroke: var(--critical); }
  .zone-serious { stroke: var(--serious); }
  .zone-dot.zone-good { fill: var(--good); }
  .zone-dot.zone-critical { fill: var(--critical); }
  .zone-dot.zone-serious { fill: var(--serious); }
  .bolus-marker { fill: var(--series-violet); cursor: pointer; }
  .cat-line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  .cat-dot { stroke: none; }
  .cat-bolus { cursor: pointer; }
  .legend-row { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 12px; font-size: 12px; color: var(--ink-secondary); }
  .legend-item { display: inline-flex; align-items: center; gap: 6px; }
  .legend-swatch-line, .legend-swatch-block, .legend-swatch-tri { display: inline-block; width: 16px; height: 3px; border-radius: 2px; }
  .legend-swatch-line.zone-good { background: var(--good); }
  .legend-swatch-line.zone-critical { background: var(--critical); }
  .legend-swatch-line.zone-serious { background: var(--serious); }
  .legend-swatch-block { height: 10px; border-radius: 2px; }
  .legend-target { background: var(--good); opacity: 0.35; }
  .legend-band { background: var(--series-blue); opacity: 0.3; }
  .legend-swatch-tri { width: 10px; height: 10px; background: var(--series-violet); clip-path: polygon(0 0, 100% 0, 50% 100%); }
  .legend-note { color: var(--ink-muted); font-style: italic; }
  .cat-end-label { font-size: 10px; font-weight: 600; }
  .view-toggle { display: inline-flex; gap: 2px; background: var(--page); border: 1px solid var(--border); border-radius: 7px; padding: 2px; margin-bottom: 12px; }
  .toggle-btn {
    font: inherit; font-size: 12px; color: var(--ink-secondary); background: transparent; border: none;
    border-radius: 5px; padding: 5px 12px; cursor: pointer;
  }
  .toggle-btn.active { background: var(--surface); color: var(--ink); font-weight: 600; box-shadow: 0 1px 2px rgba(0,0,0,0.08); }
  .crosshair-line { stroke: var(--ink-muted); stroke-width: 1; pointer-events: none; opacity: 0; }
  .hover-dot { fill: var(--surface); stroke: var(--ink); stroke-width: 2; pointer-events: none; opacity: 0; }
  .hover-rect { fill: transparent; cursor: crosshair; }
  .tooltip {
    position: absolute; pointer-events: none; opacity: 0; transition: opacity 0.06s linear;
    background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
    padding: 8px 10px; font-size: 12px; box-shadow: 0 4px 14px rgba(0,0,0,0.15);
    max-width: 240px; z-index: 5;
  }
  .tooltip .tt-time { color: var(--ink-secondary); margin-bottom: 3px; }
  .tooltip .tt-value { font-size: 13px; font-weight: 600; display: flex; align-items: baseline; gap: 5px; flex-wrap: wrap; }
  .tooltip .tt-value .tt-bolus-inline { font-weight: 400; font-size: 11px; color: var(--ink-secondary); }
  .tooltip .tt-sub { color: var(--ink-muted); font-size: 11px; margin-top: 2px; }
  .tooltip .tt-bolus { margin-top: 4px; padding-top: 4px; border-top: 1px solid var(--border); color: var(--ink-secondary); }
  .table-toggle {
    margin-top: 14px; font-size: 12px; color: var(--ink-secondary); background: var(--page);
    border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; cursor: pointer;
  }
  .data-table-wrap { display: none; margin-top: 10px; max-height: 320px; overflow: auto; border: 1px solid var(--border); border-radius: 6px; }
  .data-table-wrap.open { display: block; }
  table.data-table { border-collapse: collapse; width: 100%; font-size: 12px; }
  table.data-table th, table.data-table td { padding: 5px 8px; text-align: left; border-bottom: 1px solid var(--border); }
  table.data-table td.num, table.data-table th.num { text-align: right; font-variant-numeric: tabular-nums; }
  table.data-table th { position: sticky; top: 0; background: var(--surface); color: var(--ink-muted); font-weight: 600; }
  .empty-state { color: var(--ink-muted); padding: 40px 0; text-align: center; }
  .section-title { font-size: 13px; font-weight: 600; color: var(--ink-secondary); margin: 22px 0 8px; }
  .day-details { display: flex; flex-direction: column; gap: 8px; }
  details.day-detail { border: 1px solid var(--border); border-radius: 8px; background: var(--page); }
  details.day-detail summary {
    list-style: none; cursor: pointer; padding: 10px 12px; display: flex; align-items: center;
    gap: 8px; font-size: 13px; font-weight: 600;
  }
  details.day-detail summary::-webkit-details-marker { display: none; }
  details.day-detail summary::before { content: '\\25b8'; color: var(--ink-muted); font-size: 10px; display: inline-block; transition: transform 0.1s; }
  details.day-detail[open] summary::before { transform: rotate(90deg); }
  .day-detail-quick { font-weight: 400; color: var(--ink-secondary); font-size: 12px; }
  .day-detail-body {
    padding: 0 12px 12px; display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 10px 16px;
  }
  .day-detail-empty { padding: 0 12px 12px; color: var(--ink-muted); font-size: 12px; }
  .detail-group-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.02em; color: var(--ink-muted); margin-bottom: 4px; }
  .detail-row { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; padding: 1px 0; }
  .detail-label { color: var(--ink-secondary); }
  .detail-value { font-weight: 600; text-align: right; }
  .day-detail-body [title] {
    cursor: help; border-bottom: 1px dotted var(--ink-muted); text-decoration: none;
  }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<div class="card">
  <p class="card-title">Glucose trace</p>
  <p class="card-subtitle" id="subtitle"></p>
  <div class="empty-state" id="empty-state" hidden>No glucose readings in this window.</div>
  <div id="chart-body" hidden>
    <div class="view-toggle" id="view-toggle" hidden>
      <button type="button" class="toggle-btn active" id="toggle-chrono" data-mode="chrono">Chronological</button>
      <button type="button" class="toggle-btn" id="toggle-overlay" data-mode="overlay">Overlay</button>
    </div>
    <div class="day-filter" id="day-filter" hidden></div>
    <p class="filter-note" id="filter-note" hidden></p>
    <div class="stat-row" id="stat-row"></div>
    <div class="chart-wrap">
      <svg id="chart-svg" viewBox="0 0 1000 460" preserveAspectRatio="xMidYMid meet"></svg>
      <div class="tooltip" id="tooltip"></div>
    </div>
    <div class="legend-row" id="legend-row"></div>
    <button class="table-toggle" id="table-toggle" type="button">Show data table</button>
    <div class="data-table-wrap" id="data-table-wrap">
      <table class="data-table">
        <thead><tr><th>Time</th><th class="num">Avg</th><th class="num">Min</th><th class="num">Max</th><th class="num">n</th><th>Bolus</th></tr></thead>
        <tbody id="table-body"></tbody>
      </table>
    </div>
    <p class="section-title" id="day-details-title" hidden>Day details</p>
    <div class="day-details" id="day-details"></div>
  </div>
</div>
<script>
var CHART_DATA = `;

const HTML_TAIL = `;
(function () {
  'use strict';
  var DATA = CHART_DATA;
  var VBW = 1000, VBH = 460, ML = 54, MR = 16, MT = 16;

  var svg = document.getElementById('chart-svg');
  var subtitle = document.getElementById('subtitle');
  var emptyState = document.getElementById('empty-state');
  var chartBody = document.getElementById('chart-body');
  var statRow = document.getElementById('stat-row');
  var legendRow = document.getElementById('legend-row');
  var tableBody = document.getElementById('table-body');
  var tooltip = document.getElementById('tooltip');
  var wrap = document.querySelector('.chart-wrap');
  var dayFilterEl = document.getElementById('day-filter');
  var filterNote = document.getElementById('filter-note');
  var dayDetailsEl = document.getElementById('day-details');
  var dayDetailsTitle = document.getElementById('day-details-title');

  function fmt(v) {
    if (v == null || typeof v !== 'number' || isNaN(v)) return '—';
    return DATA.units === 'mgdl' ? String(Math.round(v)) : (Math.round(v * 10) / 10).toString();
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function svgEl(tag, attrs) {
    var e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  function escXml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // --- "nice numbers" axis scale (Heckbert), same algorithm the old
  // server-side version used, just running in the browser now. -------------
  function niceNumber(range, round) {
    var exponent = Math.floor(Math.log(range) / Math.LN10);
    var fraction = range / Math.pow(10, exponent);
    var niceFraction;
    if (round) {
      if (fraction < 1.5) niceFraction = 1;
      else if (fraction < 3) niceFraction = 2;
      else if (fraction < 7) niceFraction = 5;
      else niceFraction = 10;
    } else {
      if (fraction <= 1) niceFraction = 1;
      else if (fraction <= 2) niceFraction = 2;
      else if (fraction <= 5) niceFraction = 5;
      else niceFraction = 10;
    }
    return niceFraction * Math.pow(10, exponent);
  }

  function niceScale(min, max, maxTicks) {
    if (max <= min) max = min + 1;
    var range = niceNumber(max - min, false);
    var step = niceNumber(range / (maxTicks - 1), true);
    var niceMin = Math.floor(min / step) * step;
    var niceMax = Math.ceil(max / step) * step;
    var ticks = [];
    for (var v = niceMin; v <= niceMax + step / 2; v += step) ticks.push(Math.round(v * 10000) / 10000);
    return { min: niceMin, max: niceMax, ticks: ticks };
  }

  subtitle.textContent = DATA.titleRange +
    (DATA.points.length ? ' · Target range ' + fmt(DATA.low) + '–' + fmt(DATA.high) + ' ' + DATA.unitLabel : '');

  if (!DATA.points || !DATA.points.length) {
    emptyState.hidden = false;
    return;
  }
  chartBody.hidden = false;

  // --- shared value axis (independent of chronological/overlay view -- only
  // the X mapping differs between the two modes; the Y domain is the data's
  // own extent either way) ----------------------------------------------------
  var points = DATA.points.map(function (p) {
    return { t: p.t, epoch: Date.parse(p.t) / 1000, avg: p.avg, min: p.min, max: p.max, n: p.n };
  });

  var rawMin = DATA.low, rawMax = DATA.high;
  points.forEach(function (p) {
    if (p.min < rawMin) rawMin = p.min;
    if (p.max > rawMax) rawMax = p.max;
  });
  var pad = (rawMax - rawMin) * 0.12 || 1;
  var scale = niceScale(rawMin - pad, rawMax + pad, 6);
  var yMin = scale.min, yMax = scale.max, yTicks = scale.ticks;
  // Each render creates its own Y pixel mapping from this shared domain,
  // since the two views use different bottom margins (chronological reserves
  // room for the day-band strip; overlay doesn't need one).
  function makeYScale(plotTop, plotHeight) {
    return function (v) { return plotTop + (1 - (v - yMin) / (yMax - yMin)) * plotHeight; };
  }

  var dts = [];
  for (var i = 1; i < points.length; i++) dts.push(points[i].epoch - points[i - 1].epoch);
  dts.sort(function (a, b) { return a - b; });
  var medianDt = dts.length ? dts[Math.floor(dts.length / 2)] : 300;
  var gapThreshold = Math.max(3 * medianDt, 1800);

  var ZONE_COLOR = { inrange: 'good', low: 'critical', high: 'serious' };
  var ZONE_LABEL = { inrange: 'In range', low: 'Low', high: 'High' };
  function zoneOf(p) { return p.avg < DATA.low ? 'low' : p.avg > DATA.high ? 'high' : 'inrange'; }

  // --- calendar-day metadata: one entry per day segment the server built
  // (DATA.days), each already carrying its own tick marks. 'colorIdx' is the
  // day-identity color assigned to that day, reused consistently for the
  // overlay lines, the overlay legend, AND the day-filter chips below --
  // the same calendar day is always the same color everywhere on the page,
  // whichever view is showing. ------------------------------------------
  var dayMeta = (DATA.days || []).map(function (d, idx) {
    return {
      idx: idx, label: d.label, ticks: d.ticks || [],
      startEpoch: Date.parse(d.startT) / 1000, endEpoch: Date.parse(d.endT) / 1000,
      colorIdx: idx % 8,
    };
  });
  var hiddenDays = {}; // dayIdx -> true when the viewer has hidden that day

  function findDayIndexForEpoch(epoch) {
    for (var d = 0; d < dayMeta.length; d++) {
      if (epoch >= dayMeta[d].startEpoch && epoch <= dayMeta[d].endEpoch) return d;
    }
    return -1;
  }

  // Points/boluses tagged with which calendar day they belong to. This is
  // the single shared source both views (and the data table) build from, so
  // "which day is this" is decided once, the same way, everywhere.
  var pointsWithDay = points.map(function (p) {
    return { t: p.t, epoch: p.epoch, avg: p.avg, min: p.min, max: p.max, n: p.n, zone: zoneOf(p), dayIdx: findDayIndexForEpoch(p.epoch), boluses: [] };
  });
  var bolusesWithDay = (DATA.boluses || []).map(function (b) {
    var bEpoch = Date.parse(b.t) / 1000;
    return { t: b.t, epoch: bEpoch, units: b.units, carbs: b.carbs, class: b.class, dayIdx: findDayIndexForEpoch(bEpoch) };
  });
  // Attach each bolus to its nearest point WITHIN THE SAME DAY (never across
  // a day boundary -- important once days can be non-contiguous, where the
  // numerically-nearest point overall could easily belong to a different,
  // unrelated day). This is what lets the overlay tooltip show carbs/bolus
  // aligned with the CGM reading for that time of day, not just chrono mode.
  bolusesWithDay.forEach(function (b) {
    if (b.dayIdx < 0) return;
    var best = null, bestDist = Infinity;
    for (var j = 0; j < pointsWithDay.length; j++) {
      if (pointsWithDay[j].dayIdx !== b.dayIdx) continue;
      var dd = Math.abs(pointsWithDay[j].epoch - b.epoch);
      if (dd < bestDist) { bestDist = dd; best = pointsWithDay[j]; }
    }
    if (best) best.boluses.push(b);
  });

  // --- day buckets for overlay mode: same pointsWithDay/bolusesWithDay,
  // grouped by day and re-expressed as hour-of-day (0-24) within their own
  // day so every day can share one 24-hour axis. --------------------------
  var dayBuckets = dayMeta.map(function (dm) {
    var pts = pointsWithDay.filter(function (p) { return p.dayIdx === dm.idx; }).map(function (p) {
      return { avg: p.avg, hour: (p.epoch - dm.startEpoch) / 3600, boluses: p.boluses };
    });
    var buls = bolusesWithDay.filter(function (b) { return b.dayIdx === dm.idx; }).map(function (b) {
      return { hour: (b.epoch - dm.startEpoch) / 3600, t: b.t, units: b.units, carbs: b.carbs, class: b.class };
    });
    return { idx: dm.idx, label: dm.label, colorIdx: dm.colorIdx, points: pts, boluses: buls };
  });

  // --- stat tiles: the server's own TIR/average/time-low/time-high for the
  // FULL window by default; once the viewer hides at least one day, these
  // recompute for just the days still showing, so filtering is actually
  // useful for comparing subsets of days, not just a visual trim.
  //
  // This is EXACT, not an estimate: DATA.daySummaries carries each day's own
  // computeSummary() output -- the full-resolution figures, computed from
  // that day's raw CGM readings server-side, never downsampled -- so
  // reading-count-weighting them across just the visible days reconstructs
  // precisely the same totals a single pooled computation over the visible
  // days' raw readings would give (a day's timeInRange% times its own
  // cgmReadingCount recovers its exact in-range reading count, and summing
  // those before dividing is exact, not an approximation). The downsampled
  // pointsWithDay/'n' fallback below only matters for a page saved by an
  // older version of this tool, before daySummaries existed. ---------------
  function computeVisibleStats() {
    var sumN = 0, sumAvgN = 0, sumLowN = 0, sumHighN = 0, sumInN = 0;
    var haveExact = DATA.daySummaries && DATA.daySummaries.length === dayMeta.length;
    if (haveExact) {
      dayMeta.forEach(function (dm) {
        if (hiddenDays[dm.idx]) return;
        var entry = DATA.daySummaries[dm.idx];
        var gc = entry && entry.summary && entry.summary.glucoseControl;
        if (!gc || !gc.cgmReadingCount) return;
        var n = gc.cgmReadingCount;
        sumN += n;
        sumAvgN += gc.averageBG * n;
        sumInN += (gc.timeInRange / 100) * n;
        sumLowN += (gc.timeLow / 100) * n;
        sumHighN += (gc.timeHigh / 100) * n;
      });
    } else {
      pointsWithDay.forEach(function (p) {
        if (p.dayIdx < 0 || hiddenDays[p.dayIdx]) return;
        var n = p.n || 1;
        sumN += n;
        sumAvgN += p.avg * n;
        if (p.zone === 'low') sumLowN += n;
        else if (p.zone === 'high') sumHighN += n;
        else sumInN += n;
      });
    }
    if (!sumN) return { tirPct: 0, timeLowPct: 0, timeHighPct: 0, avgDisplay: null, exact: haveExact };
    return {
      tirPct: (sumInN / sumN) * 100, timeLowPct: (sumLowN / sumN) * 100, timeHighPct: (sumHighN / sumN) * 100,
      avgDisplay: sumAvgN / sumN, exact: haveExact,
    };
  }

  function renderStats() {
    while (statRow.firstChild) statRow.removeChild(statRow.firstChild);
    var totalDays = dayMeta.length;
    var visibleCount = dayMeta.filter(function (d) { return !hiddenDays[d.idx]; }).length;
    var filtered = totalDays > 1 && visibleCount < totalDays;
    var s = filtered
      ? computeVisibleStats()
      : { tirPct: DATA.tirPct, timeLowPct: DATA.timeLowPct, timeHighPct: DATA.timeHighPct, avgDisplay: DATA.avgDisplay, exact: true };
    var stats = [
      ['Time in range', Math.round(s.tirPct) + '%'],
      ['Average glucose', s.avgDisplay != null ? fmt(s.avgDisplay) + ' ' + DATA.unitLabel : '—'],
      ['Time low', Math.round(s.timeLowPct) + '%'],
      ['Time high', Math.round(s.timeHighPct) + '%'],
    ];
    stats.forEach(function (st) {
      var tile = el('div', 'stat-tile');
      tile.appendChild(el('div', 'stat-label', st[0]));
      tile.appendChild(el('div', 'stat-value', st[1]));
      statRow.appendChild(tile);
    });
    filterNote.hidden = !filtered;
    if (filtered) {
      filterNote.textContent = 'Stats above are recalculated for the ' + visibleCount + ' of ' + totalDays + ' day' + (totalDays === 1 ? '' : 's') + ' currently shown' +
        (s.exact ? '.' : ' (approximate -- based on the downsampled plot points).');
    }
  }

  // --- data table: the raw list for whichever days are currently visible,
  // rebuilt whenever the day filter changes. -------------------------------
  function renderTable() {
    while (tableBody.firstChild) tableBody.removeChild(tableBody.firstChild);
    pointsWithDay.forEach(function (p) {
      if (p.dayIdx < 0 || hiddenDays[p.dayIdx]) return;
      var row = document.createElement('tr');
      var d = new Date(p.t);
      row.appendChild(el('td', null, d.toUTCString().replace(' GMT', '').replace(/^\\w+, /, '')));
      row.appendChild(el('td', 'num', fmt(p.avg)));
      row.appendChild(el('td', 'num', fmt(p.min)));
      row.appendChild(el('td', 'num', fmt(p.max)));
      row.appendChild(el('td', 'num', String(p.n)));
      var bolusText = p.boluses.length
        ? p.boluses.map(function (b) {
            var parts = [];
            if (b.units != null) parts.push(b.units + 'u');
            if (b.carbs != null) parts.push(b.carbs + 'g');
            return parts.join(' / ');
          }).join('; ')
        : '';
      row.appendChild(el('td', null, bolusText));
      tableBody.appendChild(row);
    });
  }

  // --- chronological view: a day-slot timeline (each visible day gets an
  // equal-width slot, in chronological order -- see this file's top comment
  // for why), status/zone-colored trace. Returns the hover state the shared
  // hover layer below needs. ----------------------------------------------
  function renderChrono() {
    var showDayBand = dayMeta.length > 1;
    var marginBottom = showDayBand ? 58 : 32;
    var plotWidth = VBW - ML - MR;
    var plotHeight = VBH - MT - marginBottom;
    var plotTop = MT, plotBottom = MT + plotHeight, plotLeft = ML, plotRight = VBW - MR;
    var yScale = makeYScale(plotTop, plotHeight);

    var visible = dayMeta.filter(function (d) { return !hiddenDays[d.idx]; });
    if (!visible.length) {
      svg.setAttribute('viewBox', '0 0 ' + VBW + ' ' + VBH);
      svg.innerHTML = '<text x="' + (VBW / 2) + '" y="' + (VBH / 2) + '" text-anchor="middle" class="x-tick">All days are hidden -- turn one back on to see the chart.</text>';
      return { mode: 'chrono', px: [], plotLeft: plotLeft, plotRight: plotRight, plotWidth: plotWidth, bolusMarkers: [] };
    }

    var slotWidth = plotWidth / visible.length;
    function slotFor(epoch) {
      for (var s = 0; s < visible.length; s++) {
        if (epoch >= visible[s].startEpoch && epoch <= visible[s].endEpoch) return s;
      }
      return -1;
    }
    function xScale(epoch) {
      var s = slotFor(epoch);
      if (s < 0) return null;
      var d = visible[s];
      var frac = d.endEpoch > d.startEpoch ? (epoch - d.startEpoch) / (d.endEpoch - d.startEpoch) : 0;
      return plotLeft + (s + frac) * slotWidth;
    }

    var px = [];
    pointsWithDay.forEach(function (p) {
      if (p.dayIdx < 0 || hiddenDays[p.dayIdx]) return;
      var x = xScale(p.epoch);
      if (x == null) return;
      px.push({
        t: p.t, epoch: p.epoch, avg: p.avg, min: p.min, max: p.max, n: p.n, zone: p.zone, boluses: p.boluses, dayIdx: p.dayIdx,
        x: x, yAvg: yScale(p.avg), yMin: yScale(p.min), yMax: yScale(p.max),
      });
    });

    var zonesPresent = {};
    px.forEach(function (p) { zonesPresent[p.zone] = true; });

    // A run breaks on a real time gap WITHIN a day, or unconditionally when
    // crossing into a different day's slot -- days are never bridged by a
    // continuous line (required once days can be non-contiguous dates, and
    // arguably clearer even for back-to-back days).
    var lineRuns = [], bandRuns = [], curLine = null, curBand = null;
    for (var k = 0; k < px.length; k++) {
      var dayBreak = k > 0 && px[k].dayIdx !== px[k - 1].dayIdx;
      var gapBefore = k > 0 && !dayBreak && (px[k].epoch - px[k - 1].epoch) > gapThreshold;
      var breakHere = dayBreak || gapBefore;
      if (!curBand || breakHere) { if (curBand) bandRuns.push(curBand); curBand = [px[k]]; }
      else curBand.push(px[k]);
      if (!curLine || breakHere) {
        if (curLine) lineRuns.push(curLine);
        curLine = { zone: px[k].zone, pts: [px[k]] };
      } else if (curLine.zone !== px[k].zone) {
        lineRuns.push(curLine);
        curLine = { zone: px[k].zone, pts: [px[k - 1], px[k]] };
      } else {
        curLine.pts.push(px[k]);
      }
    }
    if (curLine) lineRuns.push(curLine);
    if (curBand) bandRuns.push(curBand);

    var svgParts = [];

    var targetTop = yScale(DATA.high), targetBottom = yScale(DATA.low);
    svgParts.push('<rect class="target-band" x="' + plotLeft + '" width="' + (plotRight - plotLeft) +
      '" y="' + targetTop.toFixed(1) + '" height="' + Math.max(0, targetBottom - targetTop).toFixed(1) + '" />');
    svgParts.push('<line class="target-line" x1="' + plotLeft + '" x2="' + plotRight + '" y1="' + targetTop.toFixed(1) + '" y2="' + targetTop.toFixed(1) + '" />');
    svgParts.push('<line class="target-line" x1="' + plotLeft + '" x2="' + plotRight + '" y1="' + targetBottom.toFixed(1) + '" y2="' + targetBottom.toFixed(1) + '" />');

    yTicks.filter(function (v) { return v >= yMin && v <= yMax; }).forEach(function (v) {
      var y = yScale(v);
      svgParts.push('<line class="gridline" x1="' + plotLeft + '" x2="' + plotRight + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '" />');
      svgParts.push('<text class="y-tick" x="' + (plotLeft - 8) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end">' + fmt(v) + '</text>');
    });

    var bandY = plotBottom + 30;
    visible.forEach(function (vd, slotIdx) {
      var segLeft = plotLeft + slotIdx * slotWidth, segRight = segLeft + slotWidth;
      if (slotIdx > 0) {
        svgParts.push('<line class="day-divider" x1="' + segLeft.toFixed(1) + '" x2="' + segLeft.toFixed(1) + '" y1="' + plotTop + '" y2="' + (bandY + 14).toFixed(1) + '" />');
      }
      if (showDayBand) {
        var cx = (segLeft + segRight) / 2;
        svgParts.push('<text class="day-label" x="' + cx.toFixed(1) + '" y="' + (bandY + 10).toFixed(1) + '" text-anchor="middle">' + escXml(vd.label) + '</text>');
      }
      (vd.ticks || []).forEach(function (tick) {
        var te = Date.parse(tick.t) / 1000;
        // Skip this day's OWN start-of-day tick once it isn't the first
        // visible day -- the previous day already draws its end-of-day tick
        // (24:00) at the exact same pixel (that instant IS both boundaries
        // at once), so drawing both would just overlap two labels. Each
        // day still always draws its own end tick, so the shared boundary
        // gets exactly one label instead of zero or two.
        if (te === vd.startEpoch && slotIdx > 0) return;
        var span = vd.endEpoch - vd.startEpoch || 1;
        var tx = segLeft + ((te - vd.startEpoch) / span) * slotWidth;
        svgParts.push('<line class="gridline gridline-v" x1="' + tx.toFixed(1) + '" x2="' + tx.toFixed(1) + '" y1="' + plotTop + '" y2="' + plotBottom.toFixed(1) + '" />');
        svgParts.push('<text class="x-tick" x="' + tx.toFixed(1) + '" y="' + (plotBottom + 16).toFixed(1) + '" text-anchor="middle">' + escXml(tick.label) + '</text>');
      });
    });

    bandRuns.filter(function (run) { return run.length >= 2; }).forEach(function (run) {
      var top = run.map(function (p) { return p.x.toFixed(1) + ',' + p.yMax.toFixed(1); }).join(' L ');
      var bottom = run.slice().reverse().map(function (p) { return p.x.toFixed(1) + ',' + p.yMin.toFixed(1); }).join(' L ');
      svgParts.push('<path class="band-fill" d="M ' + top + ' L ' + bottom + ' Z" />');
    });

    lineRuns.forEach(function (run) {
      var colorClass = 'zone-' + ZONE_COLOR[run.zone];
      if (run.pts.length === 1) {
        var p0 = run.pts[0];
        svgParts.push('<circle class="zone-dot ' + colorClass + '" cx="' + p0.x.toFixed(1) + '" cy="' + p0.yAvg.toFixed(1) + '" r="2.4" />');
      } else {
        var d = run.pts.map(function (p, idx2) { return (idx2 === 0 ? 'M' : 'L') + ' ' + p.x.toFixed(1) + ',' + p.yAvg.toFixed(1); }).join(' ');
        svgParts.push('<path class="zone-line ' + colorClass + '" d="' + d + '" />');
      }
    });

    var markerY = plotBottom + 8;
    // bolusMarkerMeta stays in step with each <path class="bolus-marker">
    // actually pushed below (in the same order), so after the SVG is parsed
    // into the DOM, zipping querySelectorAll('.bolus-marker') against this
    // array by index recovers each marker's own bolus record -- no data-*
    // attribute/JSON-encoding needed for the hover tooltip.
    var bolusMarkerMeta = [];
    bolusesWithDay.forEach(function (b) {
      if (b.dayIdx < 0 || hiddenDays[b.dayIdx]) return;
      var x = xScale(b.epoch);
      if (x == null || x < plotLeft - 1 || x > plotRight + 1) return;
      svgParts.push('<path class="bolus-marker" transform="translate(' + x.toFixed(1) + ',' + markerY + ')" d="M -5,-8 L 5,-8 L 0,0 Z" />');
      bolusMarkerMeta.push({ t: b.t, units: b.units, carbs: b.carbs, class: b.class });
    });

    svgParts.push('<line class="crosshair-line" id="crosshair" x1="0" x2="0" y1="' + plotTop + '" y2="' + plotBottom.toFixed(1) + '" />');
    svgParts.push('<circle class="hover-dot" id="hover-dot" r="4.5" />');
    svgParts.push('<rect class="hover-rect" id="hover-rect" x="' + plotLeft + '" y="' + plotTop + '" width="' + Math.max(0, plotRight - plotLeft) + '" height="' + Math.max(0, plotBottom - plotTop).toFixed(1) + '" tabindex="0" />');

    svg.setAttribute('viewBox', '0 0 ' + VBW + ' ' + VBH);
    svg.innerHTML = svgParts.join('');

    var legendItems = [];
    if (zonesPresent.inrange) legendItems.push(['In range', 'legend-swatch-line zone-good']);
    if (zonesPresent.low) legendItems.push(['Low', 'legend-swatch-line zone-critical']);
    if (zonesPresent.high) legendItems.push(['High', 'legend-swatch-line zone-serious']);
    legendItems.push(['Target range (' + fmt(DATA.low) + '–' + fmt(DATA.high) + ')', 'legend-swatch-block legend-target']);
    legendItems.push(['Reading spread (min–max)', 'legend-swatch-block legend-band']);
    if (DATA.boluses && DATA.boluses.length) legendItems.push(['Bolus', 'legend-swatch-tri']);
    legendItems.forEach(function (li) {
      var item = el('span', 'legend-item');
      item.appendChild(el('span', li[1]));
      item.appendChild(document.createTextNode(li[0]));
      legendRow.appendChild(item);
    });

    return { mode: 'chrono', px: px, plotLeft: plotLeft, plotRight: plotRight, plotWidth: plotWidth, bolusMarkers: bolusMarkerMeta };
  }

  // --- overlay view: every VISIBLE calendar day plotted on a shared 0-24h
  // axis for direct day-to-day comparison. Color now means DAY IDENTITY, not
  // in-range/low/high, so it switches to the categorical palette (never the
  // status colors, per the collision rule) with a day-identity legend PLUS
  // direct end-of-line labels as the secondary encoding the skill mandates
  // once more than 3 series can be visual neighbors anywhere on the chart.
  // The min/max spread band is dropped here (overlapping bands from several
  // days would just be visual noise), and bolus markers move to hour-of-day,
  // colored to match their own day. ---------------------------------------
  function renderOverlay() {
    var marginBottom = 32;
    var plotWidth = VBW - ML - MR;
    var plotHeight = VBH - MT - marginBottom;
    var plotTop = MT, plotBottom = MT + plotHeight, plotLeft = ML, plotRight = VBW - MR;
    var yScale = makeYScale(plotTop, plotHeight);
    function xScale(hour) { return ML + (Math.max(0, Math.min(24, hour)) / 24) * plotWidth; }

    var visibleBuckets = dayBuckets.filter(function (b) { return !hiddenDays[b.idx] && b.points.length; });
    if (!visibleBuckets.length) {
      svg.setAttribute('viewBox', '0 0 ' + VBW + ' ' + VBH);
      svg.innerHTML = '<text x="' + (VBW / 2) + '" y="' + (VBH / 2) + '" text-anchor="middle" class="x-tick">All days are hidden -- turn one back on to see the chart.</text>';
      return { mode: 'overlay', plotLeft: plotLeft, plotRight: plotRight, plotWidth: plotWidth, bolusMarkers: [] };
    }

    var svgParts = [];
    // Kept in step with each <path class="cat-bolus"> pushed below (same
    // order), so the hover binder can zip DOM order against this array --
    // see the matching comment in renderChrono().
    var bolusMarkerMeta = [];
    var targetTop = yScale(DATA.high), targetBottom = yScale(DATA.low);
    svgParts.push('<rect class="target-band" x="' + plotLeft + '" width="' + (plotRight - plotLeft) +
      '" y="' + targetTop.toFixed(1) + '" height="' + Math.max(0, targetBottom - targetTop).toFixed(1) + '" />');
    svgParts.push('<line class="target-line" x1="' + plotLeft + '" x2="' + plotRight + '" y1="' + targetTop.toFixed(1) + '" y2="' + targetTop.toFixed(1) + '" />');
    svgParts.push('<line class="target-line" x1="' + plotLeft + '" x2="' + plotRight + '" y1="' + targetBottom.toFixed(1) + '" y2="' + targetBottom.toFixed(1) + '" />');

    yTicks.filter(function (v) { return v >= yMin && v <= yMax; }).forEach(function (v) {
      var y = yScale(v);
      svgParts.push('<line class="gridline" x1="' + plotLeft + '" x2="' + plotRight + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '" />');
      svgParts.push('<text class="y-tick" x="' + (plotLeft - 8) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end">' + fmt(v) + '</text>');
    });

    var HOUR_TICKS = [0, 4, 8, 12, 16, 20, 24];
    HOUR_TICKS.forEach(function (h) {
      var x = xScale(h);
      svgParts.push('<line class="gridline gridline-v" x1="' + x.toFixed(1) + '" x2="' + x.toFixed(1) + '" y1="' + plotTop + '" y2="' + plotBottom.toFixed(1) + '" />');
      var label = (h < 10 ? '0' : '') + h + ':00';
      svgParts.push('<text class="x-tick" x="' + x.toFixed(1) + '" y="' + (plotBottom + 16).toFixed(1) + '" text-anchor="middle">' + label + '</text>');
    });

    visibleBuckets.forEach(function (bucket) {
      var colorVar = 'var(--cat-' + (bucket.colorIdx + 1) + ')';
      var runs = [], cur = null;
      for (var bi = 0; bi < bucket.points.length; bi++) {
        var bp = bucket.points[bi];
        var gapBefore = bi > 0 && (bp.hour - bucket.points[bi - 1].hour) * 3600 > gapThreshold;
        if (!cur || gapBefore) { if (cur) runs.push(cur); cur = []; }
        cur.push({ x: xScale(bp.hour), y: yScale(bp.avg) });
      }
      if (cur) runs.push(cur);
      runs.forEach(function (run) {
        if (run.length === 1) {
          svgParts.push('<circle class="cat-dot" style="fill:' + colorVar + '" cx="' + run[0].x.toFixed(1) + '" cy="' + run[0].y.toFixed(1) + '" r="2.4" />');
        } else {
          var d = run.map(function (pt, idx2) { return (idx2 === 0 ? 'M' : 'L') + ' ' + pt.x.toFixed(1) + ',' + pt.y.toFixed(1); }).join(' ');
          svgParts.push('<path class="cat-line" style="stroke:' + colorVar + '" d="' + d + '" />');
        }
      });
      var last = bucket.points[bucket.points.length - 1];
      var lx = Math.min(xScale(last.hour) + 6, plotRight - 2);
      var ly = yScale(last.avg);
      var weekday = String(bucket.label).split(' ')[0];
      svgParts.push('<text class="cat-end-label" style="fill:' + colorVar + '" x="' + lx.toFixed(1) + '" y="' + (ly + 3).toFixed(1) + '">' + escXml(weekday) + '</text>');

      bucket.boluses.forEach(function (b) {
        var x = xScale(b.hour);
        if (x < plotLeft - 1 || x > plotRight + 1) return;
        svgParts.push('<path class="cat-bolus" style="fill:' + colorVar + '" transform="translate(' + x.toFixed(1) + ',' + (plotBottom + 8) + ')" d="M -5,-8 L 5,-8 L 0,0 Z" />');
        bolusMarkerMeta.push({ t: b.t, units: b.units, carbs: b.carbs, class: b.class, dayLabel: bucket.label, colorIdx: bucket.colorIdx });
      });
    });

    svgParts.push('<line class="crosshair-line" id="crosshair" x1="0" x2="0" y1="' + plotTop + '" y2="' + plotBottom.toFixed(1) + '" />');
    svgParts.push('<rect class="hover-rect" id="hover-rect" x="' + plotLeft + '" y="' + plotTop + '" width="' + Math.max(0, plotRight - plotLeft) + '" height="' + Math.max(0, plotBottom - plotTop).toFixed(1) + '" tabindex="0" />');

    svg.setAttribute('viewBox', '0 0 ' + VBW + ' ' + VBH);
    svg.innerHTML = svgParts.join('');

    visibleBuckets.forEach(function (bucket) {
      var item = el('span', 'legend-item');
      var swatch = el('span', 'legend-swatch-line');
      swatch.style.background = 'var(--cat-' + (bucket.colorIdx + 1) + ')';
      item.appendChild(swatch);
      item.appendChild(document.createTextNode(bucket.label));
      legendRow.appendChild(item);
    });
    var targetItem = el('span', 'legend-item');
    targetItem.appendChild(el('span', 'legend-swatch-block legend-target'));
    targetItem.appendChild(document.createTextNode('Target range (' + fmt(DATA.low) + '–' + fmt(DATA.high) + ')'));
    legendRow.appendChild(targetItem);
    if (DATA.boluses && DATA.boluses.length) {
      var noteItem = el('span', 'legend-item legend-note');
      noteItem.appendChild(document.createTextNode('Bolus markers use the matching day colour'));
      legendRow.appendChild(noteItem);
    }

    return { mode: 'overlay', plotLeft: plotLeft, plotRight: plotRight, plotWidth: plotWidth, bolusMarkers: bolusMarkerMeta };
  }

  // --- day-filter chips: one per calendar day, shown whenever there's more
  // than one day, working the same way in EITHER view (clicking toggles
  // that day's slot/bucket out of whichever chart is currently showing, the
  // stat tiles, and the data table). State persists across the chrono/
  // overlay toggle, since "which days am I looking at" is a separate
  // question from "which layout am I looking at them in". ------------------
  if (dayMeta.length > 1) {
    dayFilterEl.hidden = false;
    dayMeta.forEach(function (dm) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'day-chip';
      var dot = el('span', 'day-chip-dot');
      dot.style.background = 'var(--cat-' + (dm.colorIdx + 1) + ')';
      chip.appendChild(dot);
      chip.appendChild(document.createTextNode(dm.label));
      chip.title = 'Click to hide/show ' + dm.label;
      chip.addEventListener('click', function () {
        hiddenDays[dm.idx] = !hiddenDays[dm.idx];
        chip.classList.toggle('hidden-day', !!hiddenDays[dm.idx]);
        refreshChart();
      });
      dayFilterEl.appendChild(chip);
    });
  }

  // --- day detail panels: one collapsible card per calendar day, built once
  // at startup from DATA.daySummaries (the server's per-day computeSummary
  // output -- the SAME aggregator get_diabetes_summary uses, just narrowed
  // to one day, so these numbers never drift from what that tool reports).
  // Hiding a day via its filter chip hides its detail panel too (toggled in
  // refreshChart below); the panels themselves are never rebuilt, only
  // shown/hidden, since their content doesn't depend on which OTHER days
  // are currently visible. -----------------------------------------------
  function fmtTimeOfDay(iso) {
    var d = new Date(iso);
    var hh = String(d.getUTCHours()).padStart(2, '0');
    var mm = String(d.getUTCMinutes()).padStart(2, '0');
    return hh + ':' + mm;
  }

  function numFmt(v, dp) {
    if (v == null || typeof v !== 'number' || isNaN(v)) return '—';
    return (+v.toFixed(dp == null ? 2 : dp)).toString();
  }

  // Renders a settings profile's time-segmented value list the way the
  // clinical-summary tools already do: a bare value when only one segment
  // covers the whole day, else "value (from), value (from), ..." so a
  // mid-day change is visible without cluttering the common single-segment
  // case.
  function fmtSegments(segs, formatter) {
    if (!segs || !segs.length) return '—';
    if (segs.length === 1) return formatter(segs[0].value);
    return segs.map(function (s) { return formatter(s.value) + ' (' + s.from + ')'; }).join(', ');
  }

  // Plain-English explanations for the Day details row labels and the two
  // group titles whose rows have no individual label of their own (Bolus
  // types, Carbs). Shown as a native hover tooltip (title attribute) on the
  // label itself -- keyed by the exact label/title text used below, so a
  // wording change here and in buildDayDetailPanel must stay in sync.
  var LABEL_TOOLTIPS = {
    'Average': 'Average glucose across this day’s CGM readings.',
    'GMI (est. A1c)': 'Glucose Management Indicator: an ESTIMATED HbA1c calculated from this day’s average glucose — not a lab-measured A1c.',
    'Time in range': 'Percentage of this day’s readings that fell within the target range.',
    'Time low': 'Percentage of this day’s readings below the low (hypo) boundary.',
    'Time high': 'Percentage of this day’s readings above the high (hyper) boundary.',
    'Std dev': 'Standard deviation: how far a typical reading strayed from this day’s average, in the same units as glucose itself. Higher means less steady.',
    'CV': 'Coefficient of variation: variability relative to the average (std dev ÷ average). Under 36% is generally considered stable, more consistent control.',
    'Highest': 'The single highest glucose reading recorded this day, and when it happened.',
    'Lowest': 'The single lowest glucose reading recorded this day, and when it happened.',
    'Best hour': 'The clock-hour this day with the best time in range.',
    'Worst hour': 'The clock-hour this day with the worst time in range.',
    'Bolus': 'Total rapid-acting insulin delivered as boluses (meal and correction doses) this day.',
    'Basal': 'Total background insulin delivered automatically through the day (Glooko’s own daily total).',
    'Split': 'How this day’s total insulin divided between bolus (meal/correction) and basal (background) delivery.',
    'DIA': 'Duration of Insulin Action: how many hours the pump assumes a bolus keeps working, used to estimate insulin still on board.',
    'Max basal': 'The highest background insulin rate the pump is allowed to run on its own.',
    'Target': 'The glucose target(s) the pump’s algorithm aims for, by time of day.',
    'ISF': 'Insulin Sensitivity Factor: how much one unit of insulin is expected to lower glucose.',
    'Carb ratio': 'Grams of carbohydrate covered by one unit of insulin, by time of day.',
  };
  var GROUP_TOOLTIPS = {
    'Bolus types': 'Meal: insulin dosed for food. Manual correction: a dose entered by hand to bring down a high. System correction: an automatic correction dose from the pump’s own algorithm. Meal+correction: one combined dose covering both.',
    'Carbs': 'Total grams of carbohydrate logged alongside boluses this day.',
  };

  function buildGroup(title, rows) {
    var group = el('div', 'detail-group');
    if (title) {
      var titleEl = el('div', 'detail-group-title', title);
      if (GROUP_TOOLTIPS[title]) titleEl.title = GROUP_TOOLTIPS[title];
      group.appendChild(titleEl);
    }
    rows.forEach(function (r) {
      var row = el('div', 'detail-row');
      if (r[0]) {
        var labelEl = el('span', 'detail-label', r[0]);
        if (LABEL_TOOLTIPS[r[0]]) labelEl.title = LABEL_TOOLTIPS[r[0]];
        row.appendChild(labelEl);
      }
      row.appendChild(el('span', 'detail-value', r[1]));
      group.appendChild(row);
    });
    return group;
  }

  function buildDayDetailPanel(dm, entry) {
    var s = entry && entry.summary;
    var details = document.createElement('details');
    details.className = 'day-detail';
    if (dayMeta.length <= 1) details.open = true;

    var summaryEl = document.createElement('summary');
    var dot = el('span', 'day-chip-dot');
    dot.style.background = 'var(--cat-' + (dm.colorIdx + 1) + ')';
    summaryEl.appendChild(dot);
    summaryEl.appendChild(document.createTextNode(dm.label));
    if (s && s.glucoseControl) {
      var gc = s.glucoseControl;
      summaryEl.appendChild(el(
        'span', 'day-detail-quick',
        ' — Avg ' + fmt(gc.averageBG) + ' ' + DATA.unitLabel + ' · TIR ' + gc.timeInRange + '% · GMI ' + gc.gmiEstimatedA1c + '%'
      ));
    }
    details.appendChild(summaryEl);

    if (!s) {
      details.appendChild(el('p', 'day-detail-empty', 'No data for this day.'));
      dayDetailsEl.appendChild(details);
      return details;
    }

    var body = el('div', 'day-detail-body');

    var gc2 = s.glucoseControl;
    body.appendChild(buildGroup('Glucose control', [
      ['Average', fmt(gc2.averageBG) + ' ' + DATA.unitLabel],
      ['GMI (est. A1c)', gc2.gmiEstimatedA1c + '%'],
      ['Time in range', gc2.timeInRange + '%'],
      ['Time low', gc2.timeLow + '%'],
      ['Time high', gc2.timeHigh + '%'],
      ['Std dev', fmt(gc2.stdDev)],
      ['CV', gc2.coefficientOfVariation + '% (' + gc2.variabilityFlag + ')'],
    ]));

    if (s.glucoseExtremes) {
      var hi = s.glucoseExtremes.highest, lo = s.glucoseExtremes.lowest;
      body.appendChild(buildGroup('Extremes', [
        ['Highest', fmt(hi.value) + ' ' + DATA.unitLabel + (hi.instances[0] ? ' at ' + fmtTimeOfDay(hi.instances[0].time) : '') + (hi.count > 1 ? ' (+' + (hi.count - 1) + ' more)' : '')],
        ['Lowest', fmt(lo.value) + ' ' + DATA.unitLabel + (lo.instances[0] ? ' at ' + fmtTimeOfDay(lo.instances[0].time) : '') + (lo.count > 1 ? ' (+' + (lo.count - 1) + ' more)' : '')],
      ]));
    }

    if (s.bestWorst) {
      body.appendChild(buildGroup('Hour pattern', [
        ['Best hour', s.bestWorst.bestHour.hour + ' (' + s.bestWorst.bestHour.tir + '% TIR)'],
        ['Worst hour', s.bestWorst.worstHour.hour + ' (' + s.bestWorst.worstHour.tir + '% TIR)'],
      ]));
    }

    if (s.insulin) {
      var ins = s.insulin;
      var insRows = [
        ['Bolus', ins.bolusUnits + 'u across ' + ins.bolusEventCount + ' event' + (ins.bolusEventCount === 1 ? '' : 's') +
          (ins.avgUnitsPerBolus != null ? ' (avg ' + ins.avgUnitsPerBolus + '/dose)' : '')],
      ];
      if (ins.basalUnits != null) insRows.push(['Basal', ins.basalUnits + 'u']);
      if (ins.basalPercent != null) insRows.push(['Split', ins.bolusPercent + '% bolus / ' + ins.basalPercent + '% basal']);
      body.appendChild(buildGroup('Insulin', insRows));
    }

    if (s.bolusArchitecture) {
      var arch = s.bolusArchitecture;
      var archParts = [];
      if (arch.meal) archParts.push(arch.meal + ' meal');
      if (arch.manualCorrection) archParts.push(arch.manualCorrection + ' manual correction');
      if (arch.systemCorrection) archParts.push(arch.systemCorrection + ' system correction');
      if (arch.mealWithCorrection) archParts.push(arch.mealWithCorrection + ' meal+correction');
      if (archParts.length) body.appendChild(buildGroup('Bolus types', [[null, archParts.join(', ')]]));
    }

    if (s.carbs && s.carbs.carbEntryCount) {
      body.appendChild(buildGroup('Carbs', [
        [null, s.carbs.carbsGrams + 'g total across ' + s.carbs.carbEntryCount + ' entr' + (s.carbs.carbEntryCount === 1 ? 'y' : 'ies')],
      ]));
    }

    (s.settings || []).forEach(function (set, i) {
      var label = s.settings.length > 1 ? 'Settings in force (change ' + (i + 1) + ')' : 'Settings in force';
      body.appendChild(buildGroup(label, [
        ['DIA', numFmt(set.DIA_hours, 1) + ' hours'],
        ['Max basal', numFmt(set.maxBasalRate, 2) + ' U/hr'],
        ['Target', fmtSegments(set.targetBg, fmt) + ' ' + DATA.unitLabel],
        ['ISF', fmtSegments(set.isf, fmt) + ' ' + DATA.unitLabel + '/U'],
        ['Carb ratio', fmtSegments(set.carbRatio, function (v) { return numFmt(v, 1); }) + ' g/U'],
      ]));
    });

    details.appendChild(body);
    dayDetailsEl.appendChild(details);
    return details;
  }

  var dayDetailPanels = [];
  if (dayMeta.length && DATA.daySummaries && DATA.daySummaries.length) {
    dayDetailsTitle.hidden = false;
    dayMeta.forEach(function (dm) {
      var panelEl = buildDayDetailPanel(dm, DATA.daySummaries[dm.idx]);
      dayDetailPanels.push({ idx: dm.idx, el: panelEl });
    });
  }

  // --- shared hover layer: crosshair + tooltip, dispatched by current mode.
  // Coordinate mapping deliberately avoids getScreenCTM()/createSVGPoint():
  // some embedded/sandboxed renderers only partially implement the SVG DOM,
  // and a plain viewBox-to-rect ratio is both simpler and more portable. The
  // svg element has no explicit CSS height (height:auto), so its rendered
  // aspect ratio always matches the viewBox exactly -- no letterboxing to
  // correct for. -------------------------------------------------------------
  var currentMode = 'chrono';
  var hoverState = null;
  var crosshair, hoverDot, hoverRect;
  var chronoFocusIdx = 0;
  var overlayFocusHour = 0;

  function toSvgX(clientX) {
    var rect = svg.getBoundingClientRect();
    if (!rect.width) return ML;
    return (clientX - rect.left) * (VBW / rect.width);
  }

  function nearestIndexChrono(xUser) {
    var px = hoverState.px;
    if (!px.length) return -1;
    var lo = 0, hi = px.length - 1;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (px[mid].x < xUser) lo = mid + 1; else hi = mid;
    }
    if (lo > 0 && Math.abs(px[lo - 1].x - xUser) < Math.abs(px[lo].x - xUser)) return lo - 1;
    return lo;
  }

  function positionTooltip(clientX, clientY) {
    var wrapRect = wrap.getBoundingClientRect();
    var relX = clientX - wrapRect.left;
    var relY = clientY - wrapRect.top;
    tooltip.style.opacity = 1;
    var left = relX + 14;
    if (left + 240 > wrapRect.width) left = relX - 254;
    tooltip.style.left = Math.max(0, left) + 'px';
    tooltip.style.top = Math.max(0, relY - 50) + 'px';
  }

  function bolusSuffix(boluses) {
    if (!boluses || !boluses.length) return '';
    return boluses.map(function (b) {
      var parts = [];
      if (b.units != null) parts.push(b.units + 'u');
      if (b.carbs != null) parts.push(b.carbs + 'g');
      return '💉' + (parts.join('/') || '');
    }).join(' ');
  }

  function showTooltipChrono(idx, clientX, clientY) {
    if (idx < 0 || !hoverState.px.length) return;
    var p = hoverState.px[idx];
    crosshair.setAttribute('x1', p.x); crosshair.setAttribute('x2', p.x);
    crosshair.style.opacity = 1;
    hoverDot.setAttribute('cx', p.x); hoverDot.setAttribute('cy', p.yAvg);
    hoverDot.style.opacity = 1;

    while (tooltip.firstChild) tooltip.removeChild(tooltip.firstChild);
    var dObj = new Date(p.t);
    tooltip.appendChild(el('div', 'tt-time', dObj.toUTCString().replace(' GMT', '')));
    var zoneLabel = ZONE_LABEL[p.zone] || '';
    tooltip.appendChild(el('div', 'tt-value', fmt(p.avg) + ' ' + DATA.unitLabel + (zoneLabel ? ' · ' + zoneLabel : '')));
    tooltip.appendChild(el('div', 'tt-sub', 'range ' + fmt(p.min) + '–' + fmt(p.max) + ' · n=' + p.n));
    p.boluses.forEach(function (b) {
      var parts = [];
      if (b.units != null) parts.push(b.units + 'u');
      if (b.carbs != null) parts.push(b.carbs + 'g carbs');
      tooltip.appendChild(el('div', 'tt-bolus', '💉 ' + (parts.join(' / ') || 'bolus')));
    });

    positionTooltip(clientX, clientY);
  }

  // "One tooltip, every series": the readout lists every VISIBLE day's
  // nearest reading at the hovered hour-of-day, so the pointer never has to
  // land exactly on a line to get a value -- and each day's line also shows
  // its carbs/bolus, aligned to that same nearest reading, not just the
  // glucose number on its own.
  function showTooltipOverlay(svgX, clientX, clientY) {
    var clampedX = Math.max(hoverState.plotLeft, Math.min(hoverState.plotRight, svgX));
    var hour = ((clampedX - hoverState.plotLeft) / hoverState.plotWidth) * 24;
    crosshair.setAttribute('x1', clampedX); crosshair.setAttribute('x2', clampedX);
    crosshair.style.opacity = 1;

    while (tooltip.firstChild) tooltip.removeChild(tooltip.firstChild);
    var hh = Math.floor(hour);
    var mm = Math.round((hour - hh) * 60);
    if (mm === 60) { mm = 0; hh = Math.min(24, hh + 1); }
    var hourLabel = (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
    tooltip.appendChild(el('div', 'tt-time', hourLabel));

    var any = false;
    dayBuckets.forEach(function (bucket) {
      if (hiddenDays[bucket.idx] || !bucket.points.length) return;
      var best = null, bestDist = Infinity;
      bucket.points.forEach(function (p) {
        var dd = Math.abs(p.hour - hour);
        if (dd < bestDist) { bestDist = dd; best = p; }
      });
      if (!best || bestDist > 1) return;
      any = true;
      var row = el('div', 'tt-value');
      var chip = document.createElement('span');
      chip.style.display = 'inline-block';
      chip.style.width = '8px';
      chip.style.height = '8px';
      chip.style.borderRadius = '2px';
      chip.style.flex = 'none';
      chip.style.background = 'var(--cat-' + (bucket.colorIdx + 1) + ')';
      row.appendChild(chip);
      row.appendChild(document.createTextNode(bucket.label + ': ' + fmt(best.avg) + ' ' + DATA.unitLabel));
      var suffix = bolusSuffix(best.boluses);
      if (suffix) row.appendChild(el('span', 'tt-bolus-inline', suffix));
      tooltip.appendChild(row);
    });
    if (!any) tooltip.appendChild(el('div', 'tt-sub', 'No readings near this hour'));

    positionTooltip(clientX, clientY);
  }

  function humanizeBolusClass(cls) {
    if (cls === 'Meal Bolus') return 'Meal bolus';
    if (cls === 'Manual Correction Bolus') return 'Manual correction';
    if (cls === 'System Correction Bolus') return 'System correction';
    if (cls === 'Meal With Correction Bolus') return 'Meal + correction';
    return cls || 'Bolus';
  }

  // Dedicated tooltip for hovering a bolus marker (the purple triangle)
  // directly, rather than the nearest CGM reading -- so the exact bolus a
  // triangle represents is always reachable by hovering IT, not just by
  // landing on whichever plotted point it happened to attach to. Works the
  // same in both views; in overlay mode b.dayLabel/b.colorIdx are also
  // set, so the day it belongs to stays identifiable on the shared axis.
  function showTooltipForBolus(b, clientX, clientY) {
    if (crosshair) crosshair.style.opacity = 0;
    if (hoverDot) hoverDot.style.opacity = 0;

    while (tooltip.firstChild) tooltip.removeChild(tooltip.firstChild);
    var dObj = new Date(b.t);
    var timeRow = el('div', 'tt-time');
    if (b.colorIdx != null) {
      var chip = document.createElement('span');
      chip.style.display = 'inline-block';
      chip.style.width = '8px';
      chip.style.height = '8px';
      chip.style.borderRadius = '2px';
      chip.style.marginRight = '5px';
      chip.style.verticalAlign = 'middle';
      chip.style.background = 'var(--cat-' + (b.colorIdx + 1) + ')';
      timeRow.appendChild(chip);
    }
    timeRow.appendChild(document.createTextNode(dObj.toUTCString().replace(' GMT', '')));
    tooltip.appendChild(timeRow);
    tooltip.appendChild(el('div', 'tt-value', '💉 ' + humanizeBolusClass(b.class)));
    var parts = [];
    if (b.units != null) parts.push(b.units + ' units');
    if (b.carbs != null) parts.push(b.carbs + 'g carbs');
    if (parts.length) tooltip.appendChild(el('div', 'tt-sub', parts.join(' · ')));

    positionTooltip(clientX, clientY);
  }

  function hideTooltip() {
    if (crosshair) crosshair.style.opacity = 0;
    if (hoverDot) hoverDot.style.opacity = 0;
    tooltip.style.opacity = 0;
  }

  function onHover(clientX, clientY) {
    var svgX = toSvgX(clientX);
    if (currentMode === 'chrono') showTooltipChrono(nearestIndexChrono(svgX), clientX, clientY);
    else showTooltipOverlay(svgX, clientX, clientY);
  }

  function onKeydown(ev) {
    if (currentMode === 'chrono') {
      if (!hoverState.px.length) return;
      if (ev.key === 'ArrowRight') chronoFocusIdx = Math.min(hoverState.px.length - 1, chronoFocusIdx + 1);
      else if (ev.key === 'ArrowLeft') chronoFocusIdx = Math.max(0, chronoFocusIdx - 1);
      else return;
      ev.preventDefault();
      var rect = hoverRect.getBoundingClientRect();
      var p = hoverState.px[chronoFocusIdx];
      var frac = (p.x - hoverState.plotLeft) / Math.max(1, hoverState.plotRight - hoverState.plotLeft);
      showTooltipChrono(chronoFocusIdx, rect.left + frac * rect.width, rect.top + rect.height / 2);
    } else {
      if (ev.key === 'ArrowRight') overlayFocusHour = Math.min(24, overlayFocusHour + 0.5);
      else if (ev.key === 'ArrowLeft') overlayFocusHour = Math.max(0, overlayFocusHour - 0.5);
      else return;
      ev.preventDefault();
      var rect2 = hoverRect.getBoundingClientRect();
      var svgXAt = hoverState.plotLeft + (overlayFocusHour / 24) * hoverState.plotWidth;
      var frac2 = (svgXAt - hoverState.plotLeft) / Math.max(1, hoverState.plotWidth);
      showTooltipOverlay(svgXAt, rect2.left + frac2 * rect2.width, rect2.top + rect2.height / 2);
    }
  }

  function bindHoverElements() {
    crosshair = document.getElementById('crosshair');
    hoverDot = document.getElementById('hover-dot');
    hoverRect = document.getElementById('hover-rect');
  }

  function attachHoverListeners() {
    if (!hoverRect) return;
    hoverRect.addEventListener('mousemove', function (ev) { onHover(ev.clientX, ev.clientY); });
    hoverRect.addEventListener('mouseleave', hideTooltip);
    hoverRect.addEventListener('touchmove', function (ev) {
      if (!ev.touches || !ev.touches.length) return;
      var t = ev.touches[0];
      onHover(t.clientX, t.clientY);
    }, { passive: true });
    hoverRect.addEventListener('touchend', hideTooltip);
    hoverRect.addEventListener('keydown', onKeydown);
    hoverRect.addEventListener('blur', hideTooltip);
  }

  // Bolus markers sit just below the hover-rect's own y-range (marker Y is
  // plotBottom+8, hover-rect ends at plotBottom), so they never overlap it --
  // each marker can carry its own hover listeners with no z-order/pointer-
  // events conflict against the crosshair layer above. markerData is in the
  // same order the matching mode's render function pushed each marker path,
  // so zipping it against querySelectorAll's (DOM-order) NodeList recovers
  // each element's own bolus record with no data-*/JSON round trip.
  function bindBolusMarkerHover(markerData) {
    var markers = svg.querySelectorAll('.bolus-marker, .cat-bolus');
    markers.forEach(function (m, i) {
      var info = markerData[i];
      if (!info) return;
      m.addEventListener('mouseenter', function (ev) { showTooltipForBolus(info, ev.clientX, ev.clientY); });
      m.addEventListener('mousemove', function (ev) { showTooltipForBolus(info, ev.clientX, ev.clientY); });
      m.addEventListener('mouseleave', hideTooltip);
      m.addEventListener('touchstart', function (ev) {
        if (!ev.touches || !ev.touches.length) return;
        var t = ev.touches[0];
        showTooltipForBolus(info, t.clientX, t.clientY);
        ev.stopPropagation();
      }, { passive: true });
    });
  }

  function clearChart() {
    svg.innerHTML = '';
    while (legendRow.firstChild) legendRow.removeChild(legendRow.firstChild);
  }

  function renderMode(mode) {
    currentMode = mode;
    clearChart();
    hoverState = mode === 'overlay' ? renderOverlay() : renderChrono();
    bindHoverElements();
    attachHoverListeners();
    bindBolusMarkerHover(hoverState.bolusMarkers || []);
    hideTooltip();
  }

  // Re-render everything the day filter affects: the chart itself (whichever
  // mode is active), the header stats, and the data table.
  function refreshChart() {
    renderStats();
    renderTable();
    renderMode(currentMode);
    dayDetailPanels.forEach(function (panel) {
      panel.el.hidden = !!hiddenDays[panel.idx];
    });
  }

  renderStats();
  renderTable();
  renderMode('chrono');

  // --- view toggle: only meaningful (and only shown) once there's more than
  // one calendar day to compare. ------------------------------------------
  var viewToggle = document.getElementById('view-toggle');
  var toggleChronoBtn = document.getElementById('toggle-chrono');
  var toggleOverlayBtn = document.getElementById('toggle-overlay');
  if (dayMeta.length > 1) {
    viewToggle.hidden = false;
    toggleChronoBtn.addEventListener('click', function () {
      if (currentMode === 'chrono') return;
      toggleChronoBtn.classList.add('active');
      toggleOverlayBtn.classList.remove('active');
      renderMode('chrono');
    });
    toggleOverlayBtn.addEventListener('click', function () {
      if (currentMode === 'overlay') return;
      toggleOverlayBtn.classList.add('active');
      toggleChronoBtn.classList.remove('active');
      renderMode('overlay');
    });
  }

  var toggle = document.getElementById('table-toggle');
  var tableWrap = document.getElementById('data-table-wrap');
  toggle.addEventListener('click', function () {
    var open = tableWrap.classList.toggle('open');
    toggle.textContent = open ? 'Hide data table' : 'Show data table';
  });
})();
</script>
</body>
</html>
`;

/**
 * The chart data blob is spliced into the page as
 * `var CHART_DATA = <this>;` inside a raw <script> block (see HTML_HEAD/
 * HTML_TAIL above). JSON.stringify() does NOT escape "<", so a string value
 * anywhere in the data that happens to contain the literal sequence
 * "</script" (case-insensitive; browsers match tag names case-insensitively)
 * would close the script block early right there, turning everything after
 * it into raw, unescaped HTML the page never intended to render — a classic
 * JSON-in-<script>-tag injection. Most of this project's chart data is
 * numeric, but `daySummaries` embeds full computeSummary() output, which
 * includes real pass-through strings from Glooko (e.g. settings[].
 * activeBasalProgram -- a basal PROGRAM NAME, which some pumps let a patient
 * or clinic set to arbitrary free text). Escaping every "<" as its unicode
 * escape closes off the entire class at once (the standard fix used by
 * libraries like `serialize-javascript`) — "<" can never appear in the
 * output, so "</script" specifically never can either, and the escape is a
 * valid no-op inside a JS string literal either way. U+2028/U+2029 are also
 * escaped: valid in a JSON string but not always valid unescaped inside a
 * bare JS string literal.
 */
function escapeForInlineScript(json) {
  return json
    .replace(/</g, '\\u003c')
    .split(String.fromCharCode(0x2028)).join('\\u2028')
    .split(String.fromCharCode(0x2029)).join('\\u2029');
}

/**
 * Builds the HTML page for the get_chart_html tool: the fixed shell
 * (HTML_HEAD/HTML_TAIL, identical on every call) with one small JSON data
 * blob spliced in. The server does no per-point pixel/path computation here
 * — that's the whole point: generation time and payload size stay small and
 * roughly constant regardless of the window's span or point count, since
 * all of that is now the browser's job at render time.
 *
 * @param {object} p
 * @param {Array<{t:string, avg:number, min:number, max:number, n:number}>} p.points
 *   Already downsampled and in the DISPLAY unit (as returned by
 *   downsampleForChart), sorted ascending by t. May span several
 *   disconnected calendar-day ranges concatenated together.
 * @param {Array<{t:string, epoch:number, units:number|null, carbs:number|null, class:string|null}>} p.boluses
 * @param {{days:Array<{startT:string,endT:string,label:string,ticks:Array<{t:string,label:string}>}>}} p.xAxis
 *   One entry per calendar day touched by ANY of the requested ranges,
 *   already in chronological order, each carrying its own tick marks (see
 *   analytics.js's buildChartDaySegments) -- this is what lets the client
 *   lay days out as equal-width slots regardless of real calendar gaps
 *   between them.
 * @param {'mmol'|'mgdl'} p.units
 * @param {number} p.low  Low (hypo) boundary, in the display unit.
 * @param {number} p.high High (hyper) boundary, in the display unit.
 * @param {number} p.tirPct
 * @param {number} p.timeLowPct
 * @param {number} p.timeHighPct
 * @param {number|null} p.avgDisplay
 * @param {{start:string, end:string}} p.window  Earliest range's start to
 *   latest range's end -- only used as a display fallback when xAxis.days
 *   is empty (no readings at all).
 * @param {Array<{dayKey:string, summary:object}>} [p.daySummaries]  One full
 *   computeSummary() result per day in xAxis.days (same order, same index),
 *   narrowed to that single calendar day -- powers the "Day details" panels.
 *   Optional/omittable; panels just don't render without it.
 * @returns {string} a complete, self-contained HTML document.
 */
export function renderChartHtml(p) {
  const { points, boluses, xAxis, units, low, high, tirPct, timeLowPct, timeHighPct, avgDisplay, window, daySummaries } = p;
  const unitLabel = units === 'mgdl' ? 'mg/dL' : 'mmol/L';
  const days = xAxis.days || [];
  const dayCount = days.length;

  // Title: for a handful of days (contiguous or not) list every one by name
  // so a disconnected selection ("the 20th, 23rd and 30th") reads honestly
  // as separate dates rather than implying one continuous span; beyond that,
  // fall back to a "first – last (N days)" summary.
  let titleRange;
  if (dayCount === 0) {
    const sEpoch = Math.floor(Date.parse(window.start) / 1000);
    titleRange = formatDayLabel(sEpoch) + ' ' + wallClockParts(sEpoch).year;
  } else if (dayCount === 1) {
    const s0 = Math.floor(Date.parse(days[0].startT) / 1000);
    titleRange = days[0].label + ' ' + wallClockParts(s0).year;
  } else if (dayCount <= 5) {
    const lastStart = Math.floor(Date.parse(days[dayCount - 1].startT) / 1000);
    titleRange = days.map((d) => d.label).join(', ') + ' ' + wallClockParts(lastStart).year;
  } else {
    const lastStart = Math.floor(Date.parse(days[dayCount - 1].startT) / 1000);
    titleRange = days[0].label + ' – ' + days[dayCount - 1].label + ` (${dayCount} days) ` + wallClockParts(lastStart).year;
  }

  const data = {
    points: (points || []).map((pt) => ({ t: pt.t, avg: pt.avg, min: pt.min, max: pt.max, n: pt.n })),
    boluses: (boluses || []).map((b) => ({ t: b.t, units: b.units, carbs: b.carbs, class: b.class })),
    days,
    daySummaries: daySummaries || [],
    low,
    high,
    units,
    unitLabel,
    tirPct,
    timeLowPct,
    timeHighPct,
    avgDisplay,
    titleRange,
    windowStart: window.start,
    windowEnd: window.end,
  };

  return HTML_HEAD + escapeForInlineScript(JSON.stringify(data)) + HTML_TAIL;
}
