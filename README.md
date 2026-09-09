<div align="center">

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0-orange.svg)](https://github.com/sikcapri/superglookoquery)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey.svg)](#who-this-is-for)
[![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](#building-the-mcpb-yourself)

</div>

# SuperGlookoQuery — Clinical Audit Tool for Claude Desktop
**Connect your Glooko diabetes data directly to Claude, for any pump/CGM combination Glooko supports, and let it do the analysis.**

> [!IMPORTANT]
> **Not medical advice.** This tool is for understanding your data and helping you ask better questions of your diabetes care team. It is not a medical device and must never be used to make changes to your therapy. See the [full disclaimer](#disclaimer).

> [!NOTE]
> This is a fork of [Richard Hall's PodQuery](https://github.com/rilhia/podquery-mcp) (MIT licensed). The original was built around one device combo (Omnipod 5 + Glooko); this fork keeps its MCPB packaging and clinical-analysis core but reworks the ingestion layer to be **device-agnostic**: instead of reading a small fixed set of fields assumed in advance, it discovers what your own account's data actually contains and adapts its available tools to that. See [How discovery and device support work](#how-discovery-and-device-support-work) below.

> [!NOTE]
> **Early stage (v0.1.0).** This fork is under active development, tested end to end against one real account (CamAPS FX pump + Ypso Pump + Libre 3+ CGM). The architecture is built to extend to other pump/CGM combinations via real contributed data, not by guessing at fields nobody has verified — see the section below for exactly how that works and what "device support" honestly means right now.

---

## 📖 Table of Contents
* [What is SuperGlookoQuery?](#what-is-superglookoquery)
  * [What does it actually do?](#what-does-it-actually-do)
* [How discovery and device support work](#how-discovery-and-device-support-work)
* [Who This Is For](#who-this-is-for)
* [Privacy & Security](#privacy--security)
* [The "Tough Love" AI Persona](#the-tough-love-ai-persona)
* [Installing the Extension](#installing-the-extension)
* [Configuring Your Settings](#configuring-your-settings)
* [Using It](#using-it)
* [Switching from the Sample Data to Your Own](#switching-from-the-sample-data-to-your-own)
* [Troubleshooting](#troubleshooting)
* [Get in Touch](#get-in-touch)
* [Tool Reference](#tool-reference)
* [How the Code is Organised](#how-the-code-is-organised)
* [Building the .mcpb Yourself](#building-the-mcpb-yourself)
* [Running the Tests](#running-the-tests)
* [License](#license)
* [Disclaimer](#disclaimer)

---

<a id="what-is-superglookoquery"></a>
## 🌟 What is SuperGlookoQuery?
**SuperGlookoQuery** is a bridge between your diabetes data and Claude. It packages as an **MCPB** (MCP Bundle) — Claude Desktop's one-click local extension format — so installing it is a single double-click, and there is no separate server, container, or config file for you to manage. No copying and pasting data between a website and an AI, and no API costs.

You simply *talk* to Claude. Ask a question in plain language, and Claude reaches into your data through the tools this extension provides, pulls exactly what it needs, and analyses it for you, all within the conversation.

You ask things like:
* *"How was my time in range last month?"*
* *"Why do I keep going high in the evenings?"*
* *"Show me my worst day and tell me what happened."*

<a id="what-does-it-actually-do"></a>
### 🚀 What does it actually do?
SuperGlookoQuery exposes your diabetes history as a set of analytical tools Claude can call:

* **Summaries and trends:** time in range, GMI, variability, best and worst days and hours, basal/bolus balance, over any period you ask about.
* **High-fidelity CGM data:** every 5-minute reading is captured, so no spike or dip is missed, but Claude is guided to pull *aggregates first* and only fetch raw readings when it genuinely needs them.
* **Ready-made visual charts:** a clinical-report-style glucose chart, opened directly in your browser, with hoverable bolus markers and a per-day breakdown, not just numbers in a table.
* **Enriched bolus analysis:** each bolus is matched with the glucose at the time and the pump settings (ISF, carb ratio, target) that were active, so Claude can judge whether a dose made sense — including split/extended-delivery boluses, if your pump reports them.
* **Basal delivery behaviour:** when the algorithm was suspending, running at max, or running blind after losing signal.
* **Device-specific modules that only appear when your data actually supports them** — e.g. CamAPS FX's own automatic/manual/boost/attempting operating-mode breakdown, visible only for an account whose data has ever shown it.

Claude does all of this itself, live, by calling these tools while it talks to you.

---

<a id="how-discovery-and-device-support-work"></a>
## 🔎 How discovery and device support work

Glooko has no public, field-level API schema, and different pump/CGM combinations report different fields. Rather than hardcode support for one device and silently discard everything else (what the original upstream project did, understandably, since it was built around its author's own Omnipod 5), this fork takes a different approach:

* **Every field Glooko sends is kept**, not just the ones a particular tool currently reads — anything not yet mapped to a typed column is kept in an `extra` overflow column, never discarded.
* **Capability, not assumption.** A device-specific tool (like the CamAPS pump-mode breakdown) only appears once your own account's data has actually shown the field it needs, at least once, ever. It's not a fixed tool list that quietly misbehaves on unfamiliar hardware, and it's not a config file you have to hand-edit.
* **A shareable, privacy-guardrailed discovery report, contributable from inside the chat.** Ask Claude to review your device data for the schema registry, or just call it directly — `get_registry_contribution_report` builds a report of which fields your account's data actually populates and how often, with every real value replaced by a fixed, fabricated placeholder before it's ever shown to you. Review it, then type the exact confirmation phrase it gives you yourself (not something Claude can do on your behalf), and `submit_registry_contribution` runs an independent second privacy scan, a content-integrity check, and (if you have the GitHub CLI installed) opens a pull request to this project's `schema-registry/` — all without leaving the conversation, and without your data ever leaving your machine. (A `node src/submit-registry-entry.js` CLI script also exists for local development, but it needs a terminal a real Claude Desktop install doesn't have — the MCP tools above are the actual way to contribute.)

This is genuinely a work in progress: the project has been built and tested end to end against one real account so far. See [`docs/DESIGN.md`](docs/DESIGN.md) for the full architecture, [`docs/PROMOTION.md`](docs/PROMOTION.md) for how a discovered field graduates from the overflow column into a proper typed one, and [`schema-registry/README.md`](schema-registry/README.md) for how to contribute your own device's data.

---

<a id="who-this-is-for"></a>
## 👤 Who This Is For

This project is for anyone who syncs diabetes device data (any pump, any CGM) to **Glooko**. Realistic expectations: it has been built and tested end to end against one CamAPS FX + Ypso Pump + Libre 3+ account. Fields and tools specific to other pumps/CGMs will appear as real accounts contribute discovery reports (see above) — this is an architecture designed to extend, not a claim that every device is already fully supported. If you're not on Glooko at all, you can still explore the project using the built-in **synthetic** sample data — no Glooko account required for that path.

### Prerequisites

* **Claude Desktop** — free download from [claude.ai/download](https://claude.ai/download). This extension only runs inside Claude Desktop (macOS or Windows); it is not a standalone server and does not work with Claude on web or mobile.
* **To analyse your own data:** a device synced to a **Glooko account**. Not required to try the tool with the sample dataset.

Nothing else. No Docker, no Node.js install, no terminal.

---

<a id="privacy--security"></a>
## 🔒 Privacy & Security: Your Data, Your Control
Because this involves sensitive medical credentials and data, it is designed with a **"local-first" architecture**.

* **No Middle Man:** your Glooko username and password never leave your machine. They are sent directly from this extension to Glooko's servers. No third-party server, and not Anthropic, ever sees them.
* **It runs on your computer:** the extension process, the local database, and the analysis tools all run inside Claude Desktop, entirely on your machine.
* **Your credentials are stored by Claude Desktop's own secure settings storage** (the password field is marked sensitive in the extension's configuration), not in a plain-text file.
* **If you ever contribute a discovery report** to the schema registry (see [above](#how-discovery-and-device-support-work)), it is built to never contain a real value from your account — every example in it is a fixed, fabricated placeholder — and it goes through a mandatory human review, a typed confirmation, and an independent second privacy scan before anything is written anywhere.

> [!IMPORTANT]
> Because you're talking to Claude (a cloud AI) about this data, most providers have a setting that allows them to "train" on your conversations. Before discussing your clinical data, consider turning off chat history / model training in Claude's privacy settings, so your medical history stays private.

> [!TIP]
> Want to try it before connecting your own account? This extension ships with a small **built-in sample database** of entirely synthetic data (fabricated, not sampled from any real account) so you can explore everything offline, with no Glooko login and no network access at all, from the moment you install it.

---

<a id="the-tough-love-ai-persona"></a>
## 🧐 The "Tough Love" AI Persona
The tool ships with a built-in AI persona: a **"Tough Love" Endocrinologist**.

Managing Type 1 Diabetes is hard, and placating a user doesn't improve Time in Range. The persona is direct, analytical, and uncompromising. It won't sugar-coat the data; it will tell you where your bolus timing is off, where you are over-correcting, or where your basal is failing to catch a drift. It is also built to work *efficiently*, pulling summaries first and only drilling into granular data when it needs to.

Once installed, this persona is available as a selectable prompt called **"Clinical auditor persona"** in Claude's prompt/attachment menu. Selecting it is what turns Claude into the endocrinologist.

Its directness is a deliberate style, not authority. Everything it says is to help you *understand* what is happening and *ask better questions* of your diabetes care team. It does not, and should not, tell you to change settings such as your DIA or carb ratios. Any change to your therapy is a conversation for you and your healthcare professional.

---

<a id="installing-the-extension"></a>
## 🛠️ Installing the Extension

1. **Download the `.mcpb` file** from this repository's [Releases page](https://github.com/sikcapri/superglookoquery/releases) if one has been published, or build it yourself — see [Building the .mcpb Yourself](#building-the-mcpb-yourself).
2. **Install it**, using any of these (all equivalent):
   * Double-click the downloaded `.mcpb` file.
   * Drag and drop the `.mcpb` file into the Claude Desktop window.
   * In Claude Desktop: **Settings → Extensions → Advanced settings → Install Extension…**, then select the `.mcpb` file.
3. Claude Desktop shows an install screen listing what the extension can do and the permissions it needs. Review it, then confirm.
4. You'll land on the extension's **settings** screen next — see [Configuring Your Settings](#configuring-your-settings) below. You can also always get back here later from **Settings → Extensions → SuperGlookoQuery**.

That's it — there is no separate build step, no container to start, and nothing to keep running in a terminal. Claude Desktop starts the extension's process on demand and stops it when it's not needed.

> [!NOTE]
> Exact menu wording in Claude Desktop can change between versions. If something doesn't match exactly, look for the nearest equivalent (an "Extensions" or "Connectors" area in Settings is the right place either way).

---

<a id="configuring-your-settings"></a>
## ⚙️ Configuring Your Settings

Claude Desktop generates a settings form for this extension automatically — there is no `.env` file to create or edit by hand. Most fields arrive **pre-filled with sensible defaults and marked required**, so the form can't be saved empty; you can accept the defaults as-is and start using the extension immediately against the bundled sample data, or adjust any of them to match your own setup. Only the **Glooko email and password** are optional — leave both blank to stay in offline sample-data mode.

| Setting | What it does |
|---|---|
| **Glooko email** / **Glooko password** | Your Glooko login. The only two optional fields. Leave **both blank** to run in offline mode against the built-in synthetic sample dataset — no account needed, and Glooko is never contacted. Fill both in to download and keep your own data up to date. The password field is masked and stored securely by Claude Desktop. |
| **Glooko account's glucose unit** | The unit your Glooko **account** delivers data in (`mmol` or `mgdl`, often `mgdl` for US accounts). Defaults to `mmol`. Only matters once you've set a Glooko login above — getting it wrong corrupts stored data. This is separate from the display unit below. |
| **Display unit** | How you want to **see** glucose: `mmol` (mmol/L) or `mgdl` (mg/dL). Defaults to `mmol`. Independent from the Glooko account unit above — e.g. a US user on a `mgdl` Glooko account can still choose to view everything in `mmol`. |
| **Low (hypo) boundary** / **High (hyper) boundary** | Your target range, in the display unit above. Defaults to **3.9 / 10.0**, which are **mmol/L** values. Every tool uses these by default; you (or Claude) can still ask about a different one-off threshold without changing this. |
| **History to load on first run** | Only used once a Glooko login is set (ignored in sample-data mode). Defaults to 3 months back. Set this to the earliest date you have device data, or simply the earliest date you want visibility into — that's how far back the first sync will download. |
| **Data folder** | Where the extension keeps its local database of downloaded data. Defaults to your Documents folder (a small `PodQuery` subfolder is created automatically inside it, for historical reasons — this is where your archive lives regardless of the folder name). This stays on your machine and survives extension updates. |

> [!WARNING]
> **If you set Display unit to `mgdl`, update the Low/High boundaries too.** They default to `3.9` / `10.0`, which are mmol/L values, and are **not** automatically converted when you switch units. For mg/dL, the equivalent target range is typically around `70` / `180` — adjust to whatever your care team has set for you.

### Trying it with the sample data (no Glooko account)
Just leave the Glooko email and password blank and save; the rest of the fields can stay on their defaults. The extension serves the built-in synthetic sample database and never contacts Glooko or the network.

### Using your own Glooko data
Fill in your Glooko email and password, set the Glooko account's glucose unit to match your actual Glooko account, and set your preferred display unit and target range. Your first question afterwards triggers a one-time download of your history (a few seconds to about a minute depending on how far back you asked it to go); after that, data is stored locally and answers are fast.

---

<a id="using-it"></a>
## 💬 Using It

1. Start a chat in Claude Desktop.
2. Make sure the **SuperGlookoQuery** extension/connector is enabled for the conversation (Claude Desktop surfaces installed extensions in its tools/connector picker).
3. From the prompt menu, select the **"Clinical auditor persona"** prompt for the full tough-love audit experience — or just ask a question directly; the tools work either way.
4. Ask away. A good first question:

   > *"Tell me about my diabetes data."*

Claude pulls the data and gives its interpretation. You can then discuss the findings, ask follow-ups, drill into a specific day or excursion, or ask for a chart — SuperGlookoQuery opens a real, interactive glucose chart directly in your browser rather than just describing numbers.

---

<a id="switching-from-the-sample-data-to-your-own"></a>
## 🔁 Switching from the Sample Data to Your Own

If you started with the sample data and now want to connect your real Glooko account:

1. Open **Settings → Extensions → SuperGlookoQuery**.
2. Fill in your **Glooko email** and **Glooko password**, and set the other fields to match you (see [Configuring Your Settings](#configuring-your-settings)).
3. Delete the existing database so the sample data isn't mixed with yours: open the **Data folder** you configured (or its default, your Documents folder) and delete the `PodQuery` subfolder inside it.
4. Ask a question. The extension downloads your own history into a fresh archive on that first query.

---

<a id="troubleshooting"></a>
## 🛠️ Troubleshooting
> [!NOTE]
> This section will grow over time. If you hit something not covered here, please open an issue.

**The extension's tools don't show up in a chat.**
Check that the SuperGlookoQuery extension is enabled for the current conversation in Claude Desktop's tools/connector picker, and that it's still enabled in **Settings → Extensions**.

**I asked about a date and got nothing back.**
If you're running against the **sample data** (Glooko fields left blank), only its date range is available. Ask Claude what date range it holds first, or ask for `get_diabetes_summary` over a very wide window and read `reportRange`.

**Claude seems to be running old behaviour after I updated the extension.**
Reinstall the newer `.mcpb` (Claude Desktop will offer to update in place); if a stale answer persists, start a fresh conversation so tool descriptions are re-read.

**The extension won't start / shows an error.**
Open **Settings → Extensions → SuperGlookoQuery** and check the configured Glooko credentials are correct (or both blank for offline mode), and that the configured Data folder is a location Claude Desktop can write to.

**Wrong-looking glucose numbers after connecting my own account.**
Double-check "Glooko account's glucose unit" matches what your actual Glooko account is set to, not what you'd prefer to see (that's the separate "Display unit" field). A mismatch here corrupts how incoming readings are interpreted; if you already have data ingested under the wrong setting, clear the database (see [Switching from the Sample Data to Your Own](#switching-from-the-sample-data-to-your-own)) and let it redownload correctly.

**My Low/High boundaries look wrong after switching to mg/dL.**
The Low/High boundary fields don't auto-convert when you change Display unit — see the warning in [Configuring Your Settings](#configuring-your-settings). Update them by hand to match your unit.

**A chart didn't open in my browser.**
SuperGlookoQuery tries to auto-open the chart file in your OS's default browser; if that fails (no recognised default-browser command on your machine), Claude will tell you the file path instead — open it manually. This is rare and typically only affects unusual system configurations.

**A device-specific tool I expected (e.g. CamAPS pump-mode) isn't showing up.**
These tools only appear once your account's data has actually shown the field they depend on — see [How discovery and device support work](#how-discovery-and-device-support-work). If your device genuinely reports this data and it's still not appearing after a full sync, please open an issue.

---

<a id="get-in-touch"></a>
## 📬 Get in Touch

If something isn't working, please **[open an issue](https://github.com/sikcapri/superglookoquery/issues)** so others can benefit from the solution too.

> [!NOTE]
> **Privacy Reminder:** if you attach a screenshot for support, please blur out any private medical information or Glooko credentials first.

---

<a id="tool-reference"></a>
## 🔌 Tool Reference

These are the MCP tools this extension registers with Claude. You never call them directly — Claude calls them for you while you chat — but this is useful if you want to understand exactly what Claude can (and can't) see, or why it asked a particular follow-up.

### A note on timestamps

**All timestamps these tools use are plain wall-clock time formatted as ISO 8601**, e.g. `2026-01-01T00:00:00.000Z` — despite the trailing "Z", these are NOT true UTC. Glooko records only the literal date/time your device displayed at the moment of each reading, with no timezone or offset attached, so a reading is stamped with wherever you physically were when it happened. This means no timezone conversion ever happens in either direction: Claude resolves your relative phrasing ("yesterday", "last 3 weeks") straight into matching wall-clock digits, and presents times in results exactly as returned, unconverted. The one tradeoff: if you travel across time zones, the archive has no record of which zone a given reading belongs to, so there's no way to reliably compute things like "how many hours ago" across a change of zone — the data is still exactly what your device showed, just without an attached zone.

### A note on glucose units

Most tools accept optional `units`, `lower`, and `upper` parameters. If Claude omits them, the values you configured in the extension's settings (display unit and target range) are used. Claude only passes them to override the defaults for a single question — for example, to check time below a different threshold without changing your normal target.

### Always-available tools

| Tool | Purpose |
|---|---|
| `get_diabetes_summary` | The best starting point for any overview question. Fixed-size aggregates over any window, so it's cheap even across months or years. A deliberately wide call is also how Claude discovers the full date range your archive holds (`reportRange`). Returns glucose control (TIR, GMI, CV, stdDev), glucose extremes, best/worst day and hour, insulin, bolus architecture, carbs, and settings in force. |
| `get_trend` | Splits a span into time buckets (day/week/month/quarter, or fixed-length) and computes each independently from raw readings, for "how have things changed month by month" style questions in one call. |
| `get_glucose` | Individual timestamped CGM readings for a window, capped to 21 days, optionally filtered to `low` (hypos), `high` (hypers), `target`, or `all`. |
| `get_chart_html` | **The primary way to see a chart.** Builds a full clinical-report-style glucose chart (colour-coded in-range/low/high trace, shaded target band, min/max spread, bolus markers hoverable in their own right, header stats, legend, tooltips), saves it to a file, and opens it directly in your browser. Accepts a `ranges` array to compare several non-contiguous dates on one chart. Multi-day windows get a Chronological/Overlay toggle and per-day filter chips (with stats that recalculate for whichever days are shown), plus a collapsible **"Day details"** panel per calendar day carrying that day's full clinical figures with plain-English tooltips. Plots every real reading at native ~5-minute resolution for a typical window (up to about a month); wider windows are lightly thinned by default — flagged via a `downsample` field in the response — and can be re-requested at full detail with the `resolution` parameter (`1` = every reading, `2` = every other one, and so on). |
| `get_chart_series` | Glucose downsampled to a target number of points for plotting, with a min/max band per point so spikes aren't lost, plus bolus event markers. Returns raw chart data rather than a rendered page — used when Claude needs to build a custom visualisation itself, rather than the ready-made chart `get_chart_html` produces. |
| `get_enriched_bolus_log` | Every bolus in a window (capped to 92 days), enriched with the interpolated CGM value at delivery and the ISF/carb-ratio/target/DIA active at that moment, plus delivered-vs-programmed and calculator overrides. Filterable by bolus class. |
| `get_split_bolus_log` | Every SPLIT (extended/dual-wave) bolus in a window — one with a real extended-delivery portion — plus aggregate stats (split rate, average initial-delivery percent) over the whole bolus population in the window. A window with no split boluses is a normal result, not an error. |
| `get_hourly_trends` | Time in range and average glucose pooled by clock-hour across a window — useful for the dawn phenomenon, consistent evening highs, and other time-of-day patterns. |
| `get_basal_delivery` | What the pump's algorithm was doing with basal delivery over time, as behavioural states (`normal` / `suspend` / `max` / `limited`), not units. Reads an Omnipod-5-specific Glooko data series — confirmed empty for a CamAPS FX account (a data-representation gap, not a claim CamAPS lacks basal; see `get_camaps_pump_mode_breakdown` for that device's nearest equivalent). |
| `get_daily_insulin` | Glooko's own per-day basal/bolus/total insulin totals, shown verbatim, for a day-by-day table or total-daily-dose figures. |
| `get_settings_history` | Every pump setting change in force during a window: DIA, max basal rate, and the time-segmented target/ISF/carb-ratio profiles. |
| `get_device_events` | Pod/site change and CGM sensor change timestamps — context only, never asserted as a cause of nearby glucose disruption. Whether Glooko reports these depends on the device — confirmed empty for a CamAPS FX + Ypso Pump account. |
| `get_meal_window_analysis` | A focused look at one meal or bolus event: 30 minutes before to 3 hours after, with the glucose trace and any boluses in that window. |

### Capability-gated tools (appear only if your account's data supports them)

| Tool | Purpose |
|---|---|
| `get_camaps_pump_mode_breakdown` | How much of a window CamAPS FX spent in each of its own operating modes (automatic/manual/easeOff/boost/liberty/attempting). Only registers for an account whose data has ever shown this field — see [How discovery and device support work](#how-discovery-and-device-support-work). Unlike every other tool above, this makes a **live** call to Glooko every time (this data is a per-window aggregate Glooko computes on request, not something this project archives locally), so expect it to be slower and to occasionally return a network error if Glooko is briefly unreachable. |

### Schema registry contribution tools (a two-step, human-confirmed flow)

| Tool | Purpose |
|---|---|
| `get_registry_contribution_report` | Step 1: builds the privacy-guardrailed discovery report for your device(s) — see [How discovery and device support work](#how-discovery-and-device-support-work). Contains no real values; only field names, types, and populated-rates. Returns a `reportHash` alongside it, needed for step 2. |
| `submit_registry_contribution` | Step 2: only ever called after you've reviewed step 1's report yourself and typed its exact confirmation phrase — Claude cannot supply this on your behalf. Runs the independent privacy scan and content-integrity check, writes to `schema-registry/`, and opens a PR if the GitHub CLI is installed and authenticated. Refuses (harmlessly) if the phrase doesn't match, or if the underlying data changed since you reviewed the report. |

There's also one MCP **prompt**, `clinical_auditor` ("Clinical auditor persona" in Claude's UI) — see [The "Tough Love" AI Persona](#the-tough-love-ai-persona).

---

<a id="how-the-code-is-organised"></a>
## How the code is organised
*(For developers reading the source. If you just want to use the tool, you can ignore this.)*

The data flows: Glooko → sync → store → range → analytics → tools → Claude.

* **`manifest.json`** — the MCPB manifest: what Claude Desktop reads to install the extension, what settings it asks the user for, and how it launches `src/server.js`.
* **`src/env.js`** — sanitizes the `user_config`-derived environment variables Claude Desktop injects, before anything else reads them. Must be the first import in `server.js`; see the file's own header comment for the specific Claude Desktop quirk it works around.
* **`src/server.js`** — the MCP server and the tool definitions (what Claude Desktop launches over stdio). Thin wrappers around the analytics. Also where capability-gated modules (see below) register, after the transport connects.
* **`src/analytics.js`** — the heart: all the clinical maths and data shaping, written as pure functions with no imports of its own (kept deliberately dependency-free for testability).
* **`src/chartHtml.js`** — renders the self-contained HTML page `get_chart_html` writes to disk: chart geometry, colour-coding, day segmentation, tooltips, and the Chronological/Overlay toggle all live here.
* **`src/store.js`** — the SQLite archive (typed core columns + a JSON `extra` overflow for anything not yet mapped, see [How discovery and device support work](#how-discovery-and-device-support-work)), backed by [sql.js](https://github.com/sql-js/sql.js) — a pure WebAssembly build of SQLite, chosen so this MCPB runs identically on whatever Node runtime Claude Desktop bundles, with no build step. The tradeoff is that sql.js is in-memory only, so `store.js` re-serialises the archive to disk itself after each write batch, rather than relying on SQLite's own file-backed journal.
* **`src/discover.js`** — builds the privacy-guardrailed discovery report (2b in `docs/DESIGN.md`): which fields your account's data populates and how often, with every real value replaced by a fixed synthetic placeholder before it's ever returned.
* **`src/submit-registry-entry.js`** — the full contribution-submission sequence: display the report in full, a mandatory typed confirmation, an independent second privacy scan (deliberately not trusting `discover.js`'s own redaction logic), a content-integrity hash check, and (if `gh` is installed and authenticated) opening a PR to `schema-registry/`. `runChatDrivenSubmission()` is the version `server.js`'s two MCP tools actually call — the human confirmation step happens in the chat, so it adds a staleness check (`hashReportContent()`) the CLI's `main()` never needed, since that path never has a gap between "shown" and "confirmed" for the archive to change in.
* **`src/paths.js`** — resolves where the archive lives (the user's configured "Data folder", defaulting to their Documents folder) and seeds the bundled sample database into place on a fresh, offline install.
* **`src/range.js`** — the layer the tools call; answers from the local archive and tops up from Glooko only when needed. Offline mode is gated here.
* **`src/sync.js`** — the engine that pulls Glooko data into the archive (cold start, top-up, startup warm-up).
* **`src/glooko.js`** — the Glooko API client (auth and fetching).
* **`src/prompt.js`** — the clinical-auditor persona.
* **`schema-registry/`** — the contributed, per-device-component catalog of what fields a real account's data has shown (`pumps/`, `cgms/`) — see its own [README](schema-registry/README.md).
* **`scripts/generate-sample-data.mjs`** — regenerates the bundled sample database from entirely synthetic, seeded-random data (never a real account's data).
* **`test/`** — the automated test suite, see [Running the Tests](#running-the-tests).
* **`docs/DESIGN.md`** / **`docs/PROMOTION.md`** / **`docs/TODO.md`** — the architecture spec, the process for graduating a discovered field into a typed column, and the running project roadmap, in that order of how deep you want to go.

A few invariants hold throughout: glucose is stored internally in one canonical unit (mmol/L) and only converted on output; bolus is summed from individual events while basal comes from Glooko's daily totals; all times are plain wall-clock time, not UTC (see "A note on timestamps" above); and per-day rates use the real observed span of data.

---

<a id="building-the-mcpb-yourself"></a>
## 🏗️ Building the .mcpb Yourself

You don't need to do this to use the extension if a released `.mcpb` is available — see [Installing the Extension](#installing-the-extension). This is for anyone who wants to build from source, audit the code before installing, or make changes.

```bash
git clone https://github.com/sikcapri/superglookoquery.git
cd superglookoquery
npm install --omit=dev          # installs runtime dependencies, including sql.js, into node_modules
npm install -g @anthropic-ai/mcpb
mcpb pack                       # produces superglookoquery.mcpb in this folder
```

The repo also ships an [`.mcpbignore`](.mcpbignore) that trims repo-only content (docs, unused `sql.js` build variants, and similar) from the packed bundle — you shouldn't need to touch it, but it's worth a look if you're curious what `mcpb pack` includes and why.

Then install the resulting `.mcpb` file as described in [Installing the Extension](#installing-the-extension). See the [MCPB specification](https://github.com/modelcontextprotocol/mcpb) for how the bundle format works.

---

<a id="running-the-tests"></a>
## 🧪 Running the Tests

```bash
npm install
npm test
```

Runs the automated test suite via Node's own built-in test runner (`node --test`) — no extra test framework dependency. Covers the ingestion/schema logic, the discovery report's threshold and redaction behaviour (the area most deserving of scrutiny, since a bug there is a privacy incident, not just a bug), the schema-registry submission gating sequence, and the capability-gated module system. See `test/` for the individual files, and `docs/TODO.md`'s Phase 3 section for what's covered and what's still open.

---

<a id="license"></a>
## 📄 License

This project is released under the **MIT License** — you are free to use, modify, and distribute it, including for commercial purposes, provided the copyright notice and licence text are retained. See the [LICENSE](LICENSE) file for the full text. Forked from [Richard Hall's podquery-mcp](https://github.com/rilhia/podquery-mcp) (MIT licensed).

The MIT licence covers the **code**. The bundled sample database is entirely synthetic (fabricated, seeded-random data — see `scripts/generate-sample-data.mjs`), not sampled from any real account.

---

<a id="disclaimer"></a>
### Disclaimer
*This tool is for informational and educational purposes only. It is not a medical device and is not a substitute for professional medical advice, diagnosis, or treatment. Always seek the advice of your physician or other qualified health provider with any questions regarding a medical condition. Any analysis produced with the help of this tool, including AI-generated suggestions, must be reviewed with a qualified clinical professional before making any changes to your insulin therapy or medical regimen.*
