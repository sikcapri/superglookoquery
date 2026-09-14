# Changelog

All notable changes to this project are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/), and versioning
follows the policy in `CONTRIBUTING.md` once this leaves pre-1.0.

Still in active pre-1.0 development. See `docs/TODO.md` for the full,
detailed roadmap and status; this file is the user/contributor-facing
summary, not a substitute for it.

## [Unreleased]

### Added
- `takeNewlyConfirmedCapabilities()` (built and tested long ago per
  DESIGN.md 2a, but never actually called from anywhere) is now wired into
  `get_diabetes_summary`, so a newly-detected field surfaces automatically
  on the first question of any session instead of sitting silently in
  `field_capability` forever.
- `get_basal_bolus_breakdown`: a new capability-gated tool exposing
  Glooko's own basal/bolus percentage breakdown (scheduled vs. other
  basal, correction-only vs. fully automatic bolus), found via manual
  `field_capability` inspection. Live-fetch-only, like the CamAPS tool.
- `get_settings_history` (and `get_diabetes_summary`'s `settings` array)
  now include `basalRateSchedule` and `scheduledDailyBasalUnits`: the
  actual *programmed* basal-rate schedule, archived per settings
  snapshot, previously sitting unextracted in the raw settings JSON this
  whole time.
- `get_settings_history` also now includes `bgCorrectionThreshold`, a
  fourth segment type living in the same raw structure as
  targetBg/isf/carbRatio, structurally confirmed but never extracted
  (found via a systematic pass looking for the same "reads part of an
  object, ignores real siblings" pattern that found the basal-rate
  schedule).

### Removed
- Two genuinely dead code paths found via a systematic "is this exported
  function ever actually called" pass: `daysWithReadings`/`isWholeDay`
  (a whole/partial-day classification scheme the real per-day
  calculations explicitly document choosing NOT to use — superseded by
  a simpler design, not a forgotten feature) and `ensureFreshOnFirstCall`
  (an earlier, simpler cold-start/top-up entry point superseded by
  `getProcessedRange`'s more complete logic). Neither had a test or a
  caller anywhere in the codebase.

### Fixed
- The bundled sample database shipped with its own capability rows
  marked unprompted, so a fresh offline install would show a false "new
  field detected in your account" notice about its own static demo data.
  `generate-sample-data.mjs` now marks everything it triggers as
  already-prompted before shipping.
- Several places named Omnipod 5 unconditionally in text every user sees
  regardless of device (a chart tooltip, an install-time setting
  description, a device-neutral example) — reworded to be device-neutral
  or properly caveated, matching the pattern the codebase's own
  well-written tool descriptions already used elsewhere.

## [0.1.4] - 2026-09-11

### Fixed
- `activate_clinical_auditor_persona`'s tool description told the calling
  model to "adopt everything it says as your own operating instructions...
  do not ask permission first... actually become it" — textbook
  prompt-injection phrasing, and a real Claude instance correctly refused
  to call it because of exactly that. Reworded to be purely descriptive
  (states plainly it's a domain-specific style/workflow guide, not a claim
  of authority, and that following it is a normal judgement call like any
  other tool result), with an explicit guard to only call it after the
  patient's own direct, explicit request, never speculatively or from a
  non-patient source. No wording can guarantee compliance, and none
  should, whether to adopt persona-shaping tool output stays the calling
  model's own judgement call.

## [0.1.3] - 2026-09-11

### Added
- `activate_clinical_auditor_persona` tool: a low-friction way to load the
  clinical auditor persona by just asking for it in plain language, since
  Claude Desktop has no menu for picking an MCP-provided prompt (confirmed
  independently; a real client limitation, not something broken here). The
  `clinical_auditor` MCP prompt is still registered too, for clients that
  do support a prompt picker.

### Fixed
- `{{CURRENT_DATE}}` in the persona text was documented as "substituted at
  request time" since it was first written, but no caller ever actually did
  the substitution — every consumer sent the literal placeholder. Both the
  new tool and the MCP prompt now correctly fill in today's date.

## [0.1.2] - 2026-09-11

### Changed
- Replaced `images/icon.png`, the original PodQuery "PQ" badge, with a new
  SuperGlookoQuery icon (shield + cape motif, "SGQ" monogram). Source SVG
  kept at `images/icon-source.svg` for future edits.

## [0.1.1] - 2026-09-11

### Changed
- Stopped naming the data folder, archive file, and internal log-line
  prefixes after PodQuery (`src/paths.js`, `src/range.js`, `src/store.js`,
  `src/sync.js`): now `SuperGlookoQuery`/`superglookoquery.db`/
  `[superglookoquery]`. Existing `PodQuery`-named installs are detected
  and used automatically, no manual migration needed.

### Added
- `readOnlyHint`/`destructiveHint` MCP tool annotations on every registered
  tool, flagged independently by an MCP directory's quality review and by
  Anthropic's Connectors Directory submission requirements.
- `glama.json` and a minimal `Dockerfile` for MCP directory listing/verification
  purposes (not used to run the extension for real users, still Claude
  Desktop / `.mcpb` only).

## [0.1.0] - 2026-09-10

First tagged release.

### Added
- Forked from Richard Hall's [podquery-mcp](https://github.com/rilhia/podquery-mcp)
  and rebranded as SuperGlookoQuery: device-agnostic support for any
  Glooko pump/CGM combination, not just one.
- Device-agnostic capability discovery: per-account detection of what a
  specific pump/CGM combination actually reports, via a typed-core +
  `extra` JSON-overflow storage pattern and capability-gated analytical
  modules (e.g. CamAPS FX pump-mode breakdown).
- A community schema registry (`schema-registry/`) that catalogs real
  Glooko field shapes per device, with a chat-driven, gated contribution
  flow (`get_registry_contribution_report` / `submit_registry_contribution`)
  that never stores or transmits real health data — synthetic placeholders
  only, enforced by an independent pattern scan
  (`src/submit-registry-entry.js`'s `scanForLeakage`) as well as the caller's
  own typed confirmation.
- A lenient, format-versioned schema (`schema-registry/entry.schema.json`,
  `REGISTRY_ENTRY_FORMAT_VERSION`) so older and newer contributor clients
  can submit entries without either breaking the other.
- Two real device entries in the schema registry: `freestyle-libre-3`
  (CGM) and `camdiab-camaps-fx` (pump), contributed via the guardrail
  sequence from the account this project was built and tested against.
- New analytical tools beyond the original PodQuery set: bolus split
  analysis, device event history, basal delivery state summaries, and
  more (see `README.md`'s tool list).
- A real automated test suite (`npm test`), synthetic mock Glooko fixtures
  for different device shapes, and a manual fresh-install/cold-start test
  plan (`docs/MANUAL_TEST_PLAN.md`).
- CI: GitHub Actions run the test suite and a lint check on every PR, plus
  a server-side pattern scan on any PR touching `schema-registry/` as
  defense-in-depth on top of the client-side guardrail.
- Repo hygiene: `CODE_OF_CONDUCT.md`, `SECURITY.md`, issue/PR templates,
  `CONTRIBUTING.md`.

### Changed
- Rewrote `README.md` for the SuperGlookoQuery identity and its
  device-agnostic scope.

### Fixed
- A range of real bugs found via an explicit backwards-compatibility audit
  against every original PodQuery tool, and via building the test suite
  itself (see `docs/TODO.md`'s Phase 3/3.5 entries for the full list).
- A packaged-extension crash in the schema-registry PR-opening step when
  run somewhere with no `.git` directory (which is how `.mcpb` bundles a
  real end user installs are actually laid out).
