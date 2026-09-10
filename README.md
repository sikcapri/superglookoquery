<div align="center">

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0-orange.svg)](https://github.com/sikcapri/superglookoquery)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey.svg)](#who-this-is-for)
[![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](#building-the-mcpb-yourself)

</div>

# SuperGlookoQuery
**Talk to Claude Desktop about your Glooko diabetes data, whatever pump or CGM combination you're actually running.**

> [!IMPORTANT]
> **Not medical advice.** This is for understanding your own data and preparing sharper questions for your care team. It is not a medical device, and nothing it says should change your therapy on its own. Full text in the [disclaimer](#disclaimer) at the bottom.

> [!NOTE]
> **This started as a fork of [Richard Hall's PodQuery](https://github.com/rilhia/podquery-mcp)** (MIT licensed), which was built around one specific setup: an Omnipod 5 syncing to Glooko. Credit to Richard for the original MCPB packaging and clinical-analysis core. What's different here: the ingestion layer no longer assumes a fixed set of fields belonging to one device. It looks at what your own account's data actually contains and builds its tool list from that. See [How device support actually works](#how-device-support-actually-works) below for the mechanics.

> [!NOTE]
> **Early days (v0.1.0).** Built and tested end to end against one real setup so far: a Ypsomed YpsoPump running CamAPS FX as the AID app, paired with a Libre 3+ CGM. Other combinations grow in as real accounts contribute data, not by guessing at fields nobody's verified.

---

## Contents
* [What this actually does](#what-this-actually-does)
* [How device support actually works](#how-device-support-actually-works)
* [Who this is for](#who-this-is-for)
* [Privacy, in plain terms](#privacy-in-plain-terms)
* [The clinical auditor persona](#the-clinical-auditor-persona)
* [Installing it](#installing-it)
* [Configuring it](#configuring-it)
* [Using it](#using-it)
* [Moving from sample data to your own](#moving-from-sample-data-to-your-own)
* [Troubleshooting](#troubleshooting)
* [Get in touch](#get-in-touch)
* [Tool reference](#tool-reference)
* [How the code is laid out](#how-the-code-is-laid-out)
* [Building the .mcpb yourself](#building-the-mcpb-yourself)
* [Running the tests](#running-the-tests)
* [License](#license)
* [Disclaimer](#disclaimer)

---

<a id="what-this-actually-does"></a>
## What this actually does

SuperGlookoQuery connects to your Glooko diabetes data and hands Claude a set of analytical tools, not a raw data dump. Install the extension, ask a question in plain language, and Claude reaches into your history to answer it, live, in the conversation.

People ask things like:
* "How was my time in range last month?"
* "Why do I keep going high in the evenings?"
* "Show me my worst day and tell me what happened."

That means, under the hood:

* **Summaries on demand.** Time in range, GMI, variability, best/worst days and hours, basal/bolus split, over whatever window you ask about.
* **Full-resolution CGM data kept locally.** Every 5-minute reading is archived so nothing's missed, though Claude is steered toward aggregates first and only pulls raw readings when a question genuinely needs them.
* **A real chart, not a description of one.** A clinical-report-style glucose chart opens directly in your browser: colour-coded ranges, hoverable bolus markers, a day-by-day breakdown.
* **Bolus context, not just numbers.** Each bolus is matched against the ISF, carb ratio, and target active at the time, including split or extended deliveries where a pump reports them, so Claude can actually judge whether a dose made sense.
* **Basal behaviour as states.** Suspended, running at max, or blind after a lost signal, rather than raw delivery units.
* **Device-specific extras, only when earned.** Something like CamAPS FX's own operating-mode breakdown appears once your account's data has actually produced that field, not before.

You never call any of this directly. Claude does it mid-conversation, as many small calls as the question actually needs.

---

<a id="how-device-support-actually-works"></a>
## How device support actually works

Glooko doesn't publish a field-level schema, and different pump/CGM pairings send back genuinely different shapes of data. The original PodQuery handled this by hardcoding one device's fields, which made sense given it was built around its own author's Omnipod 5. This fork takes a different approach:

* **Nothing gets thrown away.** Every field Glooko sends is kept, not just the ones a tool currently reads. Anything not yet mapped to a typed column lands in an `extra` overflow column instead of being discarded.
* **Tools are earned, not assumed.** A device-specific tool, like the CamAPS pump-mode breakdown, only registers once your own account's data has shown the field it needs at least once. There's no config file to hand-edit and no tool silently misbehaving on hardware it was never written for.
* **You can contribute your own device's shape, from inside the chat.** Ask Claude to review your data for the schema registry, or call `get_registry_contribution_report` yourself. It builds a report of which fields your account populates and how often, with every real value already swapped for a fixed, fabricated placeholder before you ever see it. You review it, then type the confirmation phrase it gives you yourself (this is deliberately not something Claude can do on your behalf), and `submit_registry_contribution` runs an independent second privacy scan plus a content-integrity check before opening a pull request against this project's `schema-registry/` folder. Your actual data never leaves your machine at any point in this. A `node src/submit-registry-entry.js` CLI also exists for local development, but it needs a terminal a real Claude Desktop install doesn't have, so the in-chat tools above are the real path for an actual user.

This is genuinely a work in progress: tested end to end against one real account so far. See [`docs/DESIGN.md`](docs/DESIGN.md) for the full architecture, [`docs/PROMOTION.md`](docs/PROMOTION.md) for how a discovered field graduates from the overflow column into a proper typed one, and [`schema-registry/README.md`](schema-registry/README.md) if you'd like to contribute your own device's data.

---

<a id="who-this-is-for"></a>
## Who this is for

Anyone syncing pump or CGM data to Glooko. Realistic expectations first: this has been built and tested end to end against one Ypsomed YpsoPump running CamAPS FX, paired with a Libre 3+ CGM. Other pump/CGM combinations gain real support as real accounts contribute discovery reports (see above), not because this README is claiming coverage it hasn't earned. No Glooko account at all? You can still explore using the bundled, entirely synthetic sample data.

### What you need

* **Claude Desktop**, free from [claude.ai/download](https://claude.ai/download). This only runs inside Claude Desktop, macOS or Windows. It's not a standalone server and doesn't work with Claude on web or mobile.
* **A Glooko account with a device synced to it**, if you want to analyse your own data. Not required for the sample dataset.

That's the whole list. No Docker, no separate Node install, no terminal.

---

<a id="privacy-in-plain-terms"></a>
## Privacy, in plain terms

This handles real medical credentials and real health data, so it's built local-first, on purpose:

* **No middle server.** Your Glooko email and password go straight from this extension to Glooko's own servers. Nothing in between, and nothing Anthropic ever sees.
* **Everything runs on your machine.** The extension process, the local database, and every analysis tool live entirely inside Claude Desktop, on your computer.
* **Credentials aren't stored in plain text.** They sit in Claude Desktop's own secure settings storage; the password field is marked sensitive at the config level.
* **Schema-registry contributions carry no real values.** Every example in a discovery report is a fixed, fabricated placeholder, and the whole flow goes through a mandatory human review, a typed confirmation, and an independent second privacy scan before anything is ever written anywhere.

> [!IMPORTANT]
> You're talking to a cloud AI about this data. Most providers let you turn off chat history or model training somewhere in their settings. Worth doing before you get into anything clinical, so your medical history isn't retained anywhere it doesn't need to be.

> [!TIP]
> Want to try it before connecting a real account? The extension ships with a small built-in sample database, entirely fabricated rather than sampled from anyone's real data, so you can explore everything offline: no Glooko login, no network access at all.

---

<a id="the-clinical-auditor-persona"></a>
## The clinical auditor persona

The extension ships a selectable prompt, **"Clinical auditor persona,"** that turns Claude into a direct, no-nonsense reviewer of your own control data.

Managing type 1 diabetes is hard enough without an assistant that softens every finding to keep things pleasant. This persona doesn't do that. It'll say plainly where your bolus timing looks off, where you're over-correcting, or where basal isn't catching an overnight drift, and it's built to reach for summaries first rather than wading through raw readings when it doesn't need to.

The directness is a style choice, not a claim of medical authority. Everything it says exists to help you understand your own data and walk into your next appointment with better questions, not to tell you what to change. It won't hand you a specific new DIA or carb ratio to try. That decision belongs to you and your healthcare professional, always.

---

<a id="installing-it"></a>
## Installing it

1. Grab the `.mcpb` file from this repo's [Releases page](https://github.com/sikcapri/superglookoquery/releases), if one's been published yet, or build it yourself (see [Building the .mcpb yourself](#building-the-mcpb-yourself)).
2. Install it any of these ways, they're equivalent:
   * Double-click the downloaded `.mcpb` file.
   * Drag it into the Claude Desktop window.
   * In Claude Desktop: **Settings → Extensions → Advanced settings → Install Extension…**, then pick the file.
3. Claude Desktop shows what the extension can do and what permissions it wants. Review it, then confirm.
4. You'll land on the extension's settings screen next, see [Configuring it](#configuring-it) below. You can always get back here from **Settings → Extensions → SuperGlookoQuery**.

No separate build step, no container to start, nothing to keep running in a terminal yourself. Claude Desktop starts the process when it's needed and stops it when it isn't.

> [!NOTE]
> Claude Desktop's exact menu wording shifts between versions. If something doesn't match exactly, look for the nearest equivalent under Settings.

---

<a id="configuring-it"></a>
## Configuring it

Claude Desktop builds the settings form for this extension automatically; there's no `.env` file to create or hand-edit. Most fields arrive pre-filled with sensible defaults and marked required, so the form saves fine as-is against the bundled sample data, or you can adjust anything to match your own setup. The **Glooko email and password** are the only optional pair; leave both blank to stay in offline sample-data mode.

| Setting | What it does |
|---|---|
| **Glooko email** / **Glooko password** | Your Glooko login. Leave both blank to run offline against the built-in synthetic sample data; no account needed, and Glooko is never contacted. Fill both in to download and keep your own data current. The password field is masked and stored securely by Claude Desktop. |
| **Glooko account's glucose unit** | The unit your Glooko account itself reports in (`mmol` or `mgdl`, often `mgdl` for US accounts). Defaults to `mmol`. Only matters once a Glooko login is set; getting it wrong corrupts how readings get interpreted on the way in. Separate from the display unit below. |
| **Display unit** | How you want to see glucose: `mmol` or `mgdl`. Defaults to `mmol`, independent of the Glooko account unit above, so a US account on `mgdl` can still be viewed entirely in `mmol` if you prefer. |
| **Low (hypo) boundary** / **High (hyper) boundary** | Your target range, in whatever display unit you picked. Defaults to `3.9` / `10.0`, both mmol/L values. Every tool falls back to these unless you or Claude asks about a different one-off threshold. |
| **History to load on first run** | Only used once a Glooko login is set (ignored in sample-data mode). Defaults to 3 months back. Set it to however far back you actually have device data, or however far you want visibility into; that's how far the first sync reaches. |
| **Data folder** | Where the local archive lives. Defaults to your Documents folder, with a small `PodQuery` subfolder created inside it automatically (a naming leftover from the fork, not a bug; this is genuinely where your data lives). Survives extension updates and stays entirely on your machine. |

> [!WARNING]
> **Switching Display unit to `mgdl`? Update the Low/High boundaries too.** They default to `3.9` / `10.0`, both mmol/L values, and don't auto-convert when you change units. The rough mg/dL equivalent is `70` / `180`, but use whatever your own care team actually set for you.

### Trying the sample data first

Leave the Glooko email and password blank, save, and leave everything else on its defaults. The extension serves its built-in synthetic dataset and never touches the network.

### Connecting your own Glooko account

Fill in your Glooko email and password, set the account glucose unit to match your real Glooko setup, then pick your display unit and target range. The first question you ask afterward triggers a one-time history download (seconds to about a minute, depending on how far back you set it), and everything after that reads from the local archive.

---

<a id="using-it"></a>
## Using it

1. Start a chat in Claude Desktop.
2. Confirm the **SuperGlookoQuery** extension is enabled for the conversation, in Claude Desktop's tools/connector picker.
3. Pick **"Clinical auditor persona"** from the prompt menu for the full audit experience, or just ask a question directly; the tools work either way.
4. Ask something. A decent opener:

   > *"Tell me about my diabetes data."*

Claude pulls what it needs and gives its read on it. Keep going from there: ask follow-ups, drill into a single day, or ask for a chart. SuperGlookoQuery opens a real, interactive glucose chart directly in your browser rather than describing numbers at you.

---

<a id="moving-from-sample-data-to-your-own"></a>
## Moving from sample data to your own

Started on the sample data and ready to connect a real account?

1. Open **Settings → Extensions → SuperGlookoQuery**.
2. Fill in your **Glooko email** and **Glooko password**, and set the rest to match your own setup (see [Configuring it](#configuring-it)).
3. Clear the existing database first, so sample data doesn't mix with yours: open the **Data folder** you've configured (your Documents folder by default) and delete the `PodQuery` subfolder inside it.
4. Ask a question. A fresh archive downloads your own history on that first call.

---

<a id="troubleshooting"></a>
## Troubleshooting

> [!NOTE]
> This section grows over time. Hit something not covered here? Open an issue.

**The extension's tools aren't showing up in a chat.**
Check it's enabled for the current conversation in Claude Desktop's tools/connector picker, and still enabled under **Settings → Extensions**.

**Asked about a date and got nothing back.**
On the sample data (Glooko fields left blank), only its fixed date range exists. Ask Claude what range it holds, or call `get_diabetes_summary` over a very wide window and read `reportRange` off the result.

**Claude seems to be running old behaviour after an update.**
Reinstall the newer `.mcpb` (Claude Desktop offers to update in place). If something still looks stale, start a fresh conversation so tool descriptions get re-read.

**The extension won't start, or shows an error.**
Check **Settings → Extensions → SuperGlookoQuery**: are the Glooko credentials correct (or both blank for offline mode), and is the configured Data folder somewhere Claude Desktop can actually write?

**Glucose numbers look wrong after connecting my own account.**
Check "Glooko account's glucose unit" matches your real Glooko account, not the unit you'd prefer to see (that's the separate Display unit field). Getting this wrong corrupts how incoming readings get interpreted. If data's already been ingested under the wrong setting, clear the database (see [Moving from sample data to your own](#moving-from-sample-data-to-your-own)) and let it redownload.

**Low/High boundaries look wrong after switching to mg/dL.**
They don't auto-convert when you change Display unit, see the warning under [Configuring it](#configuring-it). Update them by hand.

**A chart didn't open in my browser.**
SuperGlookoQuery tries to open it automatically in your OS's default browser. If that fails (no recognised default-browser command on your system), Claude tells you the file path instead; open it yourself. Rare, and usually only on unusual system setups.

**A device-specific tool I expected, like CamAPS pump-mode, isn't showing up.**
These only appear once your account's data has actually produced the field they depend on, see [How device support actually works](#how-device-support-actually-works). If your device genuinely reports this and it's still missing after a full sync, open an issue.

---

<a id="get-in-touch"></a>
## Get in touch

Something not working? [Open an issue](https://github.com/sikcapri/superglookoquery/issues) so the fix is there for the next person too.

> [!NOTE]
> **Before attaching a screenshot for support:** blur out anything private, medical details or Glooko credentials.

---

<a id="tool-reference"></a>
## Tool reference

These are the MCP tools this extension registers. You never call them directly, Claude does, mid-conversation, but this is here if you want to know exactly what Claude can (and can't) see, or why it asked a particular follow-up.

### A note on timestamps

Every timestamp these tools use is plain wall-clock time, formatted as ISO 8601 (e.g. `2026-01-01T00:00:00.000Z`). Despite the trailing "Z", these aren't true UTC instants. Glooko only records the literal date and time your device displayed at the moment of a reading, with no timezone attached, so a reading carries whatever the clock said wherever you physically were. Practically, this means no timezone conversion happens anywhere: Claude turns your relative phrasing ("yesterday", "last 3 weeks") straight into matching wall-clock digits, and presents results exactly as returned. The tradeoff: cross a time zone and the archive has no record of which one a given reading belongs to, so there's no reliable way to compute an elapsed "how long ago" across that boundary. The data is still exactly what your device showed; it's just not zone-stamped.

### A note on glucose units

Most tools take optional `units`, `lower`, and `upper` parameters. Left out, Claude falls back to whatever you configured (display unit, target range). It only overrides them for a single question, say, checking time under a different threshold without touching your normal target.

### Always-available tools

| Tool | Purpose |
|---|---|
| `get_diabetes_summary` | Start here for almost any overview question. Cheap fixed-size aggregates over any span, months or years included. A deliberately wide call is also how Claude works out the full range your archive holds (`reportRange`). Covers glucose control (TIR, GMI, CV, stdDev), extremes, best/worst day and hour, insulin, bolus split, carbs, and the settings in force. |
| `get_trend` | Buckets a span into periods (day/week/month/quarter, or a fixed length) and computes each independently, for "how has this changed month by month" style questions in one call. |
| `get_glucose` | Individual timestamped CGM readings, capped to 21 days, filterable to `low`, `high`, `target`, or `all`. |
| `get_chart_html` | The main way to actually see a chart. Builds a clinical-report-style glucose chart (colour-coded ranges, shaded target band, min/max spread, hoverable bolus markers, header stats, legend, tooltips), saves it, and opens it straight in your browser. Takes a `ranges` array to compare several non-contiguous dates on one chart. Multi-day windows get a Chronological/Overlay toggle and per-day filter chips (stats recalculate for whatever's still shown), plus a collapsible day-details panel per date. Plots every real reading at native resolution for a typical window (up to about a month); wider windows get lightly thinned by default, flagged via a `downsample` field, and can be re-requested at full detail via the `resolution` parameter. |
| `get_chart_series` | Downsampled glucose points for plotting, with a min/max band so spikes survive, plus bolus markers. Raw data rather than a rendered page, for when Claude needs to build its own visualisation instead of using the ready-made chart. |
| `get_enriched_bolus_log` | Every bolus in a window (capped to 92 days), matched with the interpolated glucose at delivery and the ISF/carb-ratio/target/DIA active then, plus delivered-vs-programmed and calculator overrides. Filterable by bolus class. |
| `get_split_bolus_log` | Every split (extended/dual-wave) bolus in a window, one with a genuine extended-delivery portion, plus aggregate stats (split rate, average initial-delivery percent) across the window's whole bolus population. No split boluses in a window is a normal result, not an error. |
| `get_hourly_trends` | Time in range and average glucose pooled by clock hour across a window. Useful for dawn phenomenon, recurring evening highs, that kind of time-of-day pattern. |
| `get_basal_delivery` | What the pump's algorithm was doing with basal over time, as behavioural states (`normal` / `suspend` / `max` / `limited`), not raw units. Reads an Omnipod-5-specific Glooko data series, confirmed empty for a CamAPS FX account (a gap in what Glooko exposes, not a claim CamAPS lacks basal delivery; see `get_camaps_pump_mode_breakdown` for that device's nearest equivalent). |
| `get_daily_insulin` | Glooko's own per-day basal/bolus/total figures, shown as-is, for a day-by-day table or total-daily-dose numbers. |
| `get_settings_history` | Every pump setting change in force during a window: DIA, max basal rate, and the time-segmented target/ISF/carb-ratio profiles. |
| `get_device_events` | Pod/site change and CGM sensor change timestamps, context only, never treated as the cause of nearby glucose swings. Whether Glooko reports these at all depends on the device; confirmed empty for a CamAPS FX + Ypso Pump account. |
| `get_meal_window_analysis` | Zooms into one meal or bolus event: 30 minutes before to 3 hours after, with the glucose trace and any boluses inside that window. |

### Capability-gated tools (only appear once your account's data supports them)

| Tool | Purpose |
|---|---|
| `get_camaps_pump_mode_breakdown` | How much of a window CamAPS FX spent in each of its own operating modes (automatic/manual/easeOff/boost/liberty/attempting). Registers only for an account whose data has actually shown this field, see [How device support actually works](#how-device-support-actually-works). Unlike everything else above, this is a live call to Glooko every time (a per-window aggregate Glooko computes on request, not something this project archives), so expect it to be slower, and occasionally to hit a transient network error. |

### Schema-registry contribution tools (a two-step, human-confirmed flow)

| Tool | Purpose |
|---|---|
| `get_registry_contribution_report` | Step 1: builds the privacy-guardrailed discovery report for your device(s), see [How device support actually works](#how-device-support-actually-works). No real values, only field names, types, and populated-rates. Returns a `reportHash` you'll need for step 2. |
| `submit_registry_contribution` | Step 2: only runs after you've reviewed step 1 yourself and typed its exact confirmation phrase; Claude can't supply that on your behalf. Runs an independent privacy scan and a content-integrity check, writes to `schema-registry/`, and opens a pull request if the GitHub CLI is installed and authenticated. Refuses harmlessly if the phrase doesn't match, or if the underlying data changed since you reviewed the report. |

There's also one MCP **prompt**: `clinical_auditor` ("Clinical auditor persona" in the Claude UI), see [The clinical auditor persona](#the-clinical-auditor-persona).

---

<a id="how-the-code-is-laid-out"></a>
## How the code is laid out

*(For anyone reading the source. If you just want to use the tool, skip this.)*

Data flows in this order: Glooko → sync → store → range → analytics → tools → Claude.

* **`manifest.json`**: the MCPB manifest: what Claude Desktop reads to install the extension, what settings it asks for, and how it launches `src/server.js`.
* **`src/env.js`**: sanitizes the `user_config`-derived environment variables Claude Desktop injects, before anything else reads them. Must stay the first import in `server.js`; see its own header comment for the specific Claude Desktop quirk this works around.
* **`src/server.js`**: the MCP server and the tool definitions, what Claude Desktop actually launches over stdio. Thin wrappers around the analytics. Also where capability-gated modules register, after the transport connects.
* **`src/analytics.js`**: the actual clinical maths and data shaping, written as pure functions with no imports of its own, kept deliberately dependency-free for testability.
* **`src/chartHtml.js`**: renders the self-contained HTML page `get_chart_html` writes to disk: chart geometry, colour-coding, day segmentation, tooltips, the Chronological/Overlay toggle all live here.
* **`src/store.js`**: the SQLite archive (typed core columns plus a JSON `extra` overflow for anything not yet mapped, see [How device support actually works](#how-device-support-actually-works)), backed by [sql.js](https://github.com/sql-js/sql.js), a pure WebAssembly build of SQLite chosen so this runs identically on whatever Node runtime Claude Desktop happens to bundle, with no build step. The tradeoff: sql.js is in-memory only, so `store.js` re-serialises the archive to disk itself after each write batch, rather than leaning on SQLite's own file-backed journal.
* **`src/discover.js`**: builds the privacy-guardrailed discovery report: which fields your account's data populates and how often, every real value already swapped for a fixed synthetic placeholder before it's ever returned.
* **`src/submit-registry-entry.js`**: the full submission sequence: show the report in full, require a typed confirmation, run an independent second privacy scan (deliberately not trusting `discover.js`'s own redaction logic), a content-integrity hash check, and, if `gh` is installed and authenticated, opening a PR to `schema-registry/`. `runChatDrivenSubmission()` is the version `server.js`'s two MCP tools actually call; the human confirmation step happens in the chat itself, so it adds a staleness check the CLI's `main()` never needed.
* **`src/paths.js`**: resolves where the archive lives (your configured Data folder, defaulting to Documents) and seeds the bundled sample database into place on a fresh, offline install.
* **`src/range.js`**: the layer the tools actually call; answers from the local archive and tops up from Glooko only when needed. Offline mode is gated here.
* **`src/sync.js`**: the engine pulling Glooko data into the archive: cold start, top-up, startup warm-up.
* **`src/glooko.js`**: the Glooko API client itself, auth and fetching.
* **`src/prompt.js`**: the clinical-auditor persona text.
* **`schema-registry/`**: the contributed catalog of what fields real accounts have shown, split by device component (`pumps/`, `cgms/`), see its own [README](schema-registry/README.md).
* **`scripts/generate-sample-data.mjs`**: regenerates the bundled sample database from entirely synthetic, seeded-random data. Never a real account's data.
* **`test/`**: the automated test suite, see [Running the tests](#running-the-tests).
* **`docs/DESIGN.md`** / **`docs/PROMOTION.md`** / **`docs/TODO.md`**: the architecture spec, the process for graduating a discovered field into a typed column, and the running roadmap, roughly in order of how deep you want to go.
* **`docs/MANUAL_TEST_PLAN.md`**: the fresh-install/cold-start checklist to run before cutting a release. `npm test` covers unit-level logic; this covers everything that only shows up against a genuinely empty starting state or a real Claude Desktop install.

A few invariants hold everywhere: glucose is stored internally in one canonical unit (mmol/L) and only converted on output; bolus is summed from individual events while basal comes from Glooko's own daily totals; every timestamp is plain wall-clock time, never UTC (see [the timestamps note above](#a-note-on-timestamps)); and per-day rates use the actual observed span of data, not an assumed calendar day.

---

<a id="building-the-mcpb-yourself"></a>
## Building the .mcpb yourself

Not needed to use the extension if a released `.mcpb` already exists, see [Installing it](#installing-it). This is for anyone building from source, auditing the code first, or making changes.

```bash
git clone https://github.com/sikcapri/superglookoquery.git
cd superglookoquery
npm install --omit=dev          # runtime dependencies only, including sql.js
npm install -g @anthropic-ai/mcpb
mcpb pack                       # produces superglookoquery.mcpb here
```

The repo also ships an [`.mcpbignore`](.mcpbignore) that trims repo-only content (docs, unused `sql.js` build variants, that sort of thing) from the packed bundle. You shouldn't need to touch it, but it's worth a glance if you're curious what `mcpb pack` includes and why.

Install the resulting `.mcpb` file as described under [Installing it](#installing-it). See the [MCPB specification](https://github.com/modelcontextprotocol/mcpb) for how the bundle format itself works.

---

<a id="running-the-tests"></a>
## Running the tests

```bash
npm install
npm test
```

Runs the automated suite through Node's own built-in test runner (`node --test`), no extra test framework needed. Covers the ingestion/schema logic, the discovery report's threshold and redaction behaviour (the area most deserving of scrutiny, since a bug there is a privacy incident, not just a bug), the schema-registry submission gating sequence, and the capability-gated module system. See `test/` for the individual files, and `docs/TODO.md`'s Phase 3 section for what's covered and what's still open.

---

<a id="license"></a>
## License

Released under the **MIT License**: free to use, modify, and distribute, commercially included, provided the copyright notice and licence text stay attached. Full text in [LICENSE](LICENSE). Forked from [Richard Hall's podquery-mcp](https://github.com/rilhia/podquery-mcp) (also MIT licensed).

The MIT licence covers the **code**. The bundled sample database is entirely synthetic (fabricated, seeded-random data, see `scripts/generate-sample-data.mjs`), not sampled from any real account.

---

<a id="disclaimer"></a>
### Disclaimer

*This tool is for informational and educational purposes only. It is not a medical device and is not a substitute for professional medical advice, diagnosis, or treatment. Always talk to your physician or another qualified health provider about any question regarding a medical condition. Any analysis this tool produces, including anything Claude says, needs review by a qualified clinical professional before it changes your insulin therapy or wider medical regimen in any way.*
