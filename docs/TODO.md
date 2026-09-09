# SuperGlookoQuery — Path to a proper public release

**Date created:** 2026-09-09
**Status:** Planning — nothing below is started unless checked off.

This is the full checklist for what a properly built, documented, publicly
published MCP project actually needs — not just the architecture from
`DESIGN.md`, but everything around it. Phased roughly in the order it makes
sense to tackle, though phases can overlap.

---

## Phase 3.5 — Backwards feature audit (added 2026-09-09)

Prompted by nearly missing that `get_chart_html` (the original project's
"ready-made visual chart" — a whole clinical-report-style chart tool the
user had forgotten this fork already had, and rediscovered by chance
re-reading the upstream README) still worked after this session's schema/
architecture changes. It does — verified end to end against the real
archive, screenshot-confirmed rendering correctly — but that was checked
only because it happened to come up in conversation, not systematically.
Given this session already found two real regressions by hand (the wrong
bolus field names, the wiped sample database), every ORIGINAL upstream
tool deserves the same explicit, one-by-one check, not an assumption that
"additive schema changes can't break anything."

- [x] `get_chart_html` — verified (see above)
- [x] `get_diabetes_summary` (`computeSummary`) — verified against the real
      archive (14-day window: 51% TIR, sensible day count)
- [x] `get_trend` (`bucketTrend`) — verified (weekly buckets over the real
      archive, sensible per-bucket glucose/coverage figures)
- [x] `get_glucose` (raw CGM filter + `toDisplay`/`toDisplayDelta`) — verified
- [x] `get_chart_series` (`downsampleForChart`) — verified
- [x] `get_enriched_bolus_log` (`buildEnrichedBolusLog`) — verified
- [x] `get_hourly_trends` (`calculateHourly`) — verified
- [x] `get_basal_delivery` — **real finding, not a regression**: confirmed
      ZERO basal-state rows exist anywhere in the real archive (checked a
      full 90-day window). Traced to the source: `deriveBasalStates()`
      reads Omnipod-5-specific Glooko series
      (`basalBarAutomated`/`Max`/`Suspend`), and a live check confirmed all
      three are genuinely empty arrays for this CamAPS FX account over a
      full 30-day fetch — not a fluke, not a bug this session introduced.
      To be clear (corrected after being challenged on this): this is NOT
      a claim that CamAPS lacks basal rates — it obviously has them — it's
      that Glooko's `data1`/`data2`/`data3` feed for this account has no
      per-interval basal-state or basal-rate timeline anywhere in it
      (checked all three payload sections). The closest thing this feed
      does expose for a CamAPS account is the pump-mode percentage
      breakdown already captured by `get_camaps_pump_mode_breakdown`
      (section 4). Updated `get_basal_delivery`'s description, the
      `clinical_auditor` prompt, and the README to say this precisely —
      an empty result must never be read as "basal ran normally."
- [x] `get_daily_insulin` (`bundle.dailyInsulin` passthrough) — verified,
      sensible per-day basal/bolus/total figures
- [x] `get_settings_history` (`bundle.settingsHistory` passthrough) —
      verified, one active snapshot found as expected
- [x] `get_device_events` — **same category of finding as
      `get_basal_delivery`**: confirmed zero pod/site and zero sensor
      change events over a full 30-day live fetch (`setSiteChange`/
      `cgmSensorChange` both genuinely empty arrays for this account).
      Same caveat added to the tool description and the prompt: empty is
      not evidence nothing changed, it may just be data this device
      doesn't report to Glooko this way.
- [x] `get_meal_window_analysis` — verified (a real bolus event's window
      correctly pulled its CGM trace and itself in the enriched log)
- [x] the `clinical_auditor` prompt — **found and fixed a real branding/
      accuracy bug**: the persona's own instructions described it as "a
      world-class authority on the Omnipod 5 (O5) SmartAdjust algorithm"
      and told it to "conduct a clinical audit of the patient's Omnipod 5
      data" — actively misleading for any non-Omnipod account, including
      this project's own reference CamAPS FX account. Generalised the
      persona/mission language to name multiple systems and told it to
      identify which one the patient actually uses rather than assume;
      added the same `get_basal_delivery`/`get_device_events` device-
      coverage caveats to the prompt's own tool-routing guide; added a
      line for `get_camaps_pump_mode_breakdown` noting it's capability-
      gated and may not appear at all.

Still open from this pass: regression tests locking in each tool's exact
field/shape dependencies (the synthetic-data pinning that would have
caught the bolus split-field bug immediately, per the original framing of
this phase) — the live-data verification above is done, the `test/`
coverage for it is not yet written.

## Phase 1 — Core architecture (from DESIGN.md)

- [x] Typed core + `extra` JSON overflow column schema change in `store.js`
      (SCHEMA_VERSION 7; `cgm`/`bolus` gain an `extra` TEXT column,
      `analytics.js`'s raw→timeline mapping captures everything not already
      a typed field via `captureExtra()`). Verified with a synthetic
      round-trip test (real data, not yet exercised — see Phase 3).
- [x] Runtime capability state (2a): continuous, monotonic, updates as a
      byproduct of every sync. New `field_capability` table, populated by
      `ingestTimeline`'s `recordCapabilities()`, `INSERT ... DO NOTHING` so a
      confirmed capability can never be revoked by a later sync. Verified:
      a field seen populated twice records one row with the *first*
      occurrence's epoch, not the second's.
- [x] Prompt-to-contribute notification: `takeNewlyConfirmedCapabilities()`
      in `store.js` returns newly-confirmed fields and marks them prompted
      in the same call — verified fires exactly once per field. **Not yet
      wired up**: nothing in `server.js`/the tool layer actually surfaces
      this to the user yet, or points them at the (not yet built) `discover
      --for-registry` command. The data mechanism exists; the "tell the
      user" half doesn't.
- [x] `discover` command (2b) core: `src/discover.js`, `buildReport()` +
      `renderReportText()`, CLI-runnable (`node src/discover.js`). 30-day
      window (flags `lowConfidence` if the archive doesn't have a full
      window yet), real populated-threshold (≥5 records OR ≥1% rate — "seen
      once" alone is correctly excluded, verified with synthetic data: a
      1-in-150 field was correctly left out of the report).
- [x] Allowlist-by-construction report builder — `summariseCategory()` reads
      real archive rows but the report it returns only ever contains
      derived/synthetic fields (name, type, rate, fixed fake example);
      verified the reported example for a real numeric field never matches
      any of the actual ingested values.
- [x] Type-aware redaction: numbers/booleans/ISO-date-strings get a fixed
      synthetic example per type; anything else (free text) gets a generic
      placeholder. Nested objects are flagged `nested-unsupported` rather
      than guessed at (per the Known Follow-ups item on nested fields).
- [x] Submission gating sequence — `src/submit-registry-entry.js`: full
      display (`renderEntryText`) → typed confirmation phrase (exact-match,
      interactive, not scriptable) → independent second pattern-scanner
      (`scanForLeakage`, hardcoded allowlist, doesn't trust `discover.js`'s
      own redaction logic) → content-integrity hash (`hashContent` +
      `writeAndVerify`). All verified with synthetic tests, including two
      negative cases that matter more than the happy path: (1) a
      deliberately-injected fake "leaked" value was correctly caught by the
      independent scanner; (2) a hash-mismatch on a slug that already had a
      legitimate pre-existing file correctly **restores** that file instead
      of deleting it (caught and fixed a real bug here — the first version
      unconditionally deleted on mismatch, which would have destroyed an
      already-merged registry entry in a real failure).
- [x] Seamless in-session PR submission (`gh pr create`):
      `openRegistryPullRequest()` in `submit-registry-entry.js`, wired into
      `main()` after every written entry has already passed the typed
      confirmation, independent scan, and write/re-read hash check. Creates
      one branch, stages exactly the written files (never `git add -A`),
      commits, pushes, and opens the PR. Falls back to a clear "written and
      verified locally, finish this yourself" message (per DESIGN.md's "no
      GitHub account fallback" note) if `gh` isn't installed/authenticated,
      if there's nothing to submit, or if push/PR creation fails for any
      reason — never silent, never destructive. Verified end-to-end with
      real `git`/`gh` against an isolated scratch repo (a local bare
      remote, not a real GitHub repo): confirmed the exact intended file
      gets committed, confirmed the "no changes to submit" short-circuit,
      and confirmed a push-succeeds-but-PR-creation-fails case reports
      cleanly with the commit left intact. Never touched the real
      superglookoquery repo or opened a real PR during testing.
- [x] Capability-gated module registration in `server.js`: `GATED_MODULES` +
      `registerCapabilityGatedModules()`, checked against `store.js`'s
      `field_capability` state. Runs *after* `server.connect()`, not inside
      `createServer()` — gating registration on a DB read would otherwise
      delay the `initialize` handshake, which `range.js`/`store.js` are
      explicit that nothing should do. Verified with two synthetic modules
      (one whose required field was seeded present, one whose required field
      was never seen): only the satisfied one registered. No real gated
      module exists yet — Phase 2's CamAPS pump-mode tool will be the first.
- [x] `schema-registry/` folder structure: `pumps/`, `cgms/` (with
      `.gitkeep`), `lifestyle-features.json` not yet created (no lifestyle
      data path exists yet — see Phase 1's other pending items), plus a
      `README.md` documenting the entry format and contribution flow.
- [x] A documented (even if manual-for-now) promotion process:
      `docs/PROMOTION.md`. Owner is the maintainer (manual, not automated,
      by design — schema/ingestion changes deserve a human decision each
      time). Concrete candidate criteria (2+ independent registry entries
      for that component, or 1 under an explicit bootstrap exception since
      the registry has zero entries today; plus a real tool/analysis that
      needs it structured), a 6-step how-to for the migration itself, and a
      promotion log table to track what's been promoted and why. Nested
      fields (DESIGN.md's other open follow-up) explicitly deferred to the
      first real nested-field candidate rather than guessed at now.

## Phase 2 — First real features on the new architecture

(The point of doing Phase 1 at all — pick a first real payoff before
generalizing further.)

- [x] Capture bolus split/extended-delivery fields — promoted
      `initialDeliveryPercentage`/`extendedDeliveryPercentage`/`durationString`
      from `extra` to typed columns (SCHEMA_VERSION 9, `docs/PROMOTION.md`'s
      bootstrap exception). **A real sync of this account was run** (the
      project's actual archive, not a synthetic test) to confirm this: the
      first attempt (SCHEMA_VERSION 8) guessed `initialDelivery`/
      `extendedDelivery`/`extendedBolusDuration` from memory of DESIGN.md's
      Background section, without checking against real data first — those
      turned out to be real, but for a much rarer bolus shape, so the
      columns almost never populated. Corrected once real evidence existed;
      see `docs/PROMOTION.md`'s log for the full account. The rarer
      raw-delivery shape stays in `extra` for now.
- [x] A tool exposing split-bolus history/analysis: `get_split_bolus_log`
      in `server.js` (`buildSplitBolusLog()` / `summariseSplitBolusStats()`
      in `analytics.js`) — logs each split/extended bolus with its
      initial/extended split percentage and Glooko's own raw duration text,
      plus aggregate stats (split rate, average initial-delivery percent)
      over the whole bolus population in the window.
- [x] Capture CamAPS pump-mode breakdown as the first genuinely
      device-specific, capability-gated module. **Found the real location
      by probing the raw payload's top-level series/stats keys directly**
      (structure only — key names, never values — same discipline as the
      original Phase B probe): it's neither in `cgm`/`bolus` `extra` nor in
      basal-state data as suspected, but in Glooko's own per-window stats
      blob (`data2`) — `camapsPumpModeAutomaticPercentage`,
      `ManualPercentage`, `EaseOffPercentage`, `BoostPercentage`,
      `LibertyPercentage`, `AttemptingPercentage`, `DurationString`,
      `PerModeDurationStrings`. Confirmed populated for this account (a
      real fetch: 76% automatic, 24% attempting, etc.). `data2` is
      deliberately never archived locally (`range.js`'s `getProcessedRange`
      always returns `stats: null`, by design — it's a live, Glooko-computed
      aggregate for whatever window is asked, not a fact about a point in
      time), so this module's tool cannot be archive-backed like every
      other tool here: `get_camaps_pump_mode_breakdown` always makes a live
      Glooko call, documented as such in its own description.
      Capability is tracked via a new generalised `recordFieldCapabilities()`
      in `store.js`, called from `range.js`'s `pullAndIngest` (opportunistic,
      byproduct of any sync) and its own live fetch — against a NEW `'stats'`
      category (a category `field_capability` already supported generically;
      no schema change needed). Passing the WHOLE `data2` blob (not just the
      CamAPS keys) means this also incidentally seeds capability state for
      every other stats field (carbs/exercise/weight/BP/etc.) for free,
      groundwork for the still-unbuilt lifestyle-data module. Verified
      end-to-end for real: a live fetch recorded the capability, and a stub
      `registerCapabilityGatedModules()` call confirmed the tool actually
      registers. `docs/DESIGN.md`/`docs/PROMOTION.md` updated to correct the
      earlier (wrong) guess that this lived in basal data.
- [ ] Submit the first real schema-registry entry (this account's own
      CamAPS FX + Ypso pump + Libre 3+ combo) — **no longer data-blocked**:
      a real sync now populates the archive under SCHEMA_VERSION 9, and
      `node src/submit-registry-entry.js` would produce a real report for
      `cgm` (`mealTag`, `value`, `timestamp`, `calculated`, all ~100%
      populated) and `pump` (`highestBolusValue`, `timestamp`, `type`,
      `group`, `tooltipData` [nested, so excluded], `deviceName`). The split
      fields don't clear the 5-use/1%-rate reporting threshold for this
      account in a 30-day window — expected for a mostly-closed-loop user
      who rarely manually splits a bolus, not a bug. (`discover.js`'s report
      does not currently cover the new `'stats'` category at all — it only
      ever summarised `cgm`/`bolus` — so the CamAPS breakdown itself won't
      appear in a registry entry yet either; that's a real, separate gap,
      not urgent since a registry entry is about device capability
      discovery, not this account's own live tool.) **Still not run**: the
      submission sequence's typed-confirmation step needs a human physically
      at a terminal (by design, not scriptable), and actually opening it
      submits a real PR to the public repo — both are for the user to
      decide to do, not something to run as a side effect of other work.

## Phase 3 — Testing

- [x] Test runner: Node's own built-in `node:test`/`node:assert` (Node 24,
      already the minimum this project needs) — no new dependency, no build
      step, consistent with the MCPB's own "just `node src/server.js`"
      philosophy. `npm test` runs `node --test test/*.test.js` (the glob
      form, not a bare directory path — `node --test test/` mis-resolves on
      this Node version; verified working from both bash and real
      PowerShell).
- [x] Unit tests for the new ingestion/schema logic:
      `test/store.test.js` (typed-column + `extra` round-trip,
      `field_capability` monotonicity and "0/false still counts as
      populated", `recordFieldCapabilities()` standalone), `test/
      analytics.test.js` (the confirmed-real bolus split field names —
      pins the SCHEMA_VERSION 9 fix so it can't silently regress back to
      the wrong guess — plus `extractCamapsPumpModeBreakdown`), `test/
      server.test.js` (the actual production `registerCapabilityGatedModules`
      against the real CamAPS module: registers when confirmed, genuinely
      absent when not, an unrelated capability doesn't falsely satisfy it).
- [x] **Heaviest test coverage on the discover/redaction path specifically**
      — `test/discover.test.js`: both threshold axes (count AND rate) independently
      confirmed to gate correctly, reported examples proven to be the fixed
      synthetic placeholder even when the real underlying value is a
      deliberately distinctive "real-looking" number/string (and asserted
      absent from the rendered report text entirely, not just the
      structured field), nested fields flagged not guessed at,
      `lowConfidence` and `buildComponentReports`'s real-deviceName/slug
      behavior. `test/submit-registry-entry.test.js` covers the gating
      sequence itself: `scanForLeakage` against both a clean entry and
      multiple adversarial ones (a real-looking leaked value, an
      unrecognised type, an out-of-range rate, an implausibly long
      deviceName), canonical-hash stability, and `writeAndVerify`'s three
      real paths (clean write, mismatch-with-nothing-pre-existing, and the
      no-destroy-a-pre-existing-file case that was a real bug caught during
      Phase 1's manual testing — now a permanent regression test rather
      than a one-off manual check).
- [x] **Found and fixed a real, separate bug while writing the server.js
      test**: `server.js`, `discover.js`, and `submit-registry-entry.js`
      each guarded their CLI/main entrypoint with a naive
      `import.meta.url === \`file://${process.argv[1]}\`` string
      comparison — broken on Windows (a raw backslash path can never equal
      a `file://` URL), so `node src/discover.js` and `node
      src/submit-registry-entry.js` silently produced NO output at all on
      this project's actual development platform, and importing `server.js`
      from anywhere (including this test suite) unconditionally started a
      real stdio server with no way to opt out. Fixed all three with
      `pathToFileURL(process.argv[1] || '').href`, the correct
      cross-platform comparison. Verified: the real CLI commands now
      produce output, and `node src/server.js` (the actual Claude
      Desktop/`npm start` launch command) still works unchanged.
- [ ] Synthetic mock Glooko response fixtures for a few different device
      shapes (hand-built, not real accounts) to test capability gating
      without needing real hardware for every combination
- [x] Confirm sql.js's in-memory/full-reserialize behavior isn't degraded by
      the wider schema — **found a real, if narrow, reliability edge while
      building `scripts/generate-sample-data.mjs` (2026-09-09)**: calling an
      ingest function (and therefore a COMMIT -> `persist()` ->
      `rawDb.export()` cycle) **many times in rapid succession within one
      process** (~450 cycles, one ingest call per day x ~5 categories x 90
      days) intermittently corrupted the archive on this sql.js/WASM build
      under Node 24 — reproducible on every run. The SAME total data
      ingested via one call per category (~5 `persist()` cycles total, same
      ~26k rows) succeeded reliably across dozens of repeated tries.
      Root-caused down to "many persist() cycles in one process", not
      transaction size, prepared-statement reuse, or any specific data
      shape (all independently ruled out first). Not a fix to store.js
      itself — a real Glooko sync never does anywhere near 450 persist
      cycles in one process lifetime (each MCP session is its own process,
      and a session syncs far less often than once per day), so this
      doesn't look like a practical production risk. Worked around in the
      generator by batching once per category instead of once per day; left
      as a documented reliability edge for anyone who later needs many
      ingest calls in one long-lived process (see the generator's own
      header comment for the full account).
- [ ] A manual test plan for a fresh install / cold-start flow, since that's
      what every new contributor's first run actually looks like

## Phase 4 — Documentation

- [x] Regenerated the bundled `examples/podquery.db` sample database, found
      broken while starting this phase: it had been created under an old
      schema, and the very first open under the current
      `SCHEMA_VERSION` silently wiped it to empty (the version-heal
      self-repair logic correctly cleared old-schema data, but nothing
      ever regenerated the shipped file afterward) — a real bug that would
      have completely broken the "try it offline first" experience for any
      new user with no Glooko login. Rebuilt via a new
      `scripts/generate-sample-data.mjs`, generating entirely SYNTHETIC
      data (a deliberate choice, not the maintainer's real data like
      upstream PodQuery did — see the script's own header) through the
      real `store.js` ingest functions, so it stays schema-compatible with
      no manual updates needed on a future schema change. Verified: the
      regenerated file survives being reopened, and produces sensible
      output through the real `computeSummary()`/`discover.js` code paths
      (97.9% TIR, a plausible basal/bolus split, a small clean discovery
      report). Also added `.gitignore` coverage for `store.js`'s
      `persist()` temp files, after several got orphaned on disk by
      crashed runs while chasing the reliability issue above.
- [x] Rewrite `README.md` for the new project identity: SuperGlookoQuery
      branding and repo links throughout, a new "How discovery and device
      support work" section explaining the actual architecture (typed
      core + `extra`, capability gating, the schema registry) in plain
      language with links to `docs/DESIGN.md`/`docs/PROMOTION.md`/
      `schema-registry/README.md` for depth, honest "who this is for"
      wording (tested against one real account, architecture designed to
      extend — not a claim of broad device support), updated tool
      reference (added `get_split_bolus_log`, added
      `get_camaps_pump_mode_breakdown` under a new "capability-gated
      tools" table with its live-fetch caveat spelled out), an updated
      "how the code is organised" section covering every file added this
      project (`discover.js`, `submit-registry-entry.js`,
      `schema-registry/`, `scripts/`, `test/`), a new "Running the Tests"
      section, and corrected sample-data wording (synthetic, not the
      maintainer's real data). Dropped the old PodQuery-branded header
      banner image rather than leave stale branding — a real new banner
      is a nice-to-have, not done here. Also fixed two tool descriptions
      in `server.js` that still said "Omnipod 5" for behaviour confirmed
      device-agnostic in practice (`get_settings_history`,
      `get_basal_delivery` — the latter's genuinely Omnipod-specific
      "limited" state is called out honestly rather than generalised
      away). Personal contact info (the original author's LinkedIn) was
      dropped rather than guessed at for the new maintainer — GitHub
      Issues is the one support channel stated, matching `manifest.json`.
- [ ] `CONTRIBUTING.md` — how to submit a schema registry entry (walking
      through the actual guardrail sequence), how to add a capability
      module, coding conventions
- [ ] Schema registry format spec — what a registry JSON file must contain
      to be valid
- [ ] Setup/installation guide (Glooko credentials, `.env`, first-run
      experience, what "offline/sample data mode" looks like)
- [ ] Troubleshooting guide
- [ ] Keep `docs/DESIGN.md` as the living source of truth, updated as
      implementation reveals design gaps (already happened twice during
      planning — will keep happening)

## Phase 5 — Repo hygiene

- [ ] Confirm original MIT copyright notice is intact in `LICENSE`
      (required, not optional — this is a legal term of the license, not a
      courtesy)
- [ ] `CODE_OF_CONDUCT.md`
- [ ] Issue templates (bug report, schema registry contribution, feature
      request)
- [ ] PR template — specifically flagging the guardrail sequence for any PR
      touching `schema-registry/`
- [ ] `SECURITY.md` — how to report a vulnerability, with explicit emphasis
      given this handles both login credentials and health data
- [ ] `.gitignore` audit — make certain `podquery.db`/`superglookoquery.db`,
      `.env`, and any local archive file can never be accidentally committed
- [ ] GitHub repo metadata: description, topics, About section

## Phase 6 — CI/CD

- [ ] GitHub Actions: run tests on every PR
- [ ] Lint check on every PR
- [ ] An automated CI check that mirrors the independent pattern-scanner on
      any PR touching `schema-registry/`, as server-side defense-in-depth on
      top of the local guardrail (a contributor's local tool being correct
      shouldn't be the *only* line of defense before something merges)

## Phase 7 — Packaging & release process

- [ ] Confirm/adapt the `.mcpb` build/packaging step for Claude Desktop
      distribution
- [ ] Versioning approach (semver) and a `CHANGELOG.md`
- [ ] GitHub Releases with the packaged bundle attached

## Phase 8 — Before actually publishing/announcing

- [ ] Explicit, prominent "not a medical device" disclaimer in the README
      (already in the manifest description; needs to be unmissable in the
      repo's front door too)
- [ ] Decide how to honestly represent device coverage at launch — realistic
      wording is "built and tested against one CamAPS FX/Ypso pump/Libre 3+
      account; architecture designed to extend to other devices via
      contribution" rather than implying broad device support that doesn't
      exist yet
- [ ] Own review pass for anything that could read as medical advice rather
      than data analysis
- [ ] Decide whether/where to announce (T1D tech communities, MCP
      directories) — entirely optional, your call, not a technical
      requirement

---

## Explicitly not on this list

Anything already covered and closed out in `docs/DESIGN.md` (the
architecture decisions themselves) — this file is about everything *around*
building it properly, not re-litigating what's already been designed.
