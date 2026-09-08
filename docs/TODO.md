# SuperGlookoQuery — Path to a proper public release

**Date created:** 2026-09-09
**Status:** Planning — nothing below is started unless checked off.

This is the full checklist for what a properly built, documented, publicly
published MCP project actually needs — not just the architecture from
`DESIGN.md`, but everything around it. Phased roughly in the order it makes
sense to tackle, though phases can overlap.

---

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
      `initialDelivery`/`extendedDelivery`/`extendedBolusDuration` from
      `extra` to typed columns (SCHEMA_VERSION 8, `docs/PROMOTION.md`'s
      bootstrap exception). The 4th field DESIGN.md's Background section
      calls "percentages" was deliberately NOT promoted — no confirmed real
      field name exists for it (the original raw-payload probe was
      inspected and its dump deleted per this project's own data-handling
      discipline; nothing recorded its exact key). Verified with a
      realistic synthetic `processUnifiedGlookoData()` input: the 3 fields
      land as typed properties and are correctly excluded from `extra`.
- [x] A tool exposing split-bolus history/analysis: `get_split_bolus_log`
      in `server.js` (`buildSplitBolusLog()` / `summariseSplitBolusStats()`
      in `analytics.js`) — logs each split/extended bolus with its
      initial/extended units and split percentage, plus aggregate stats
      (split rate, average duration, average split percent) over the whole
      bolus population in the window. `extendedBolusDuration`'s unit is
      explicitly flagged unconfirmed in the tool's own description rather
      than assumed.
- [ ] Capture CamAPS pump-mode breakdown (automatic/manual/boost/attempting
      percentages) as the first genuinely device-specific, capability-gated
      module — **blocked**: same problem as "percentages" above, but for
      the whole module. No confirmed real field name exists for these
      fields — DESIGN.md only ever describes them, never records the exact
      key(s) a real CamAPS payload uses. `camapsPumpModeAutomaticPercentage`
      appearing as the illustrative example in `server.js`'s `GATED_MODULES`
      comment is exactly that: illustrative, invented for the gating-
      mechanism smoke test, not a verified field name. Building this module
      for real needs a fresh look at a real CamAPS payload first (a live,
      carefully-scoped Glooko sync under the current code, the same kind of
      one-off probe the original Phase B investigation did) — not
      something to guess into the schema.
- [ ] Submit the first real schema-registry entry (this account's own
      CamAPS FX + Ypso pump + Libre 3+ combo) — **blocked on the same real-
      sync gap**: the archive has no data ingested under the current
      (SCHEMA_VERSION 8) code yet, so there is no real `field_capability`/
      `extra` evidence yet to build a genuine report from. This is the
      project's own bootstrap contribution once unblocked.

## Phase 3 — Testing

- [ ] Unit tests for the new ingestion/schema logic
- [ ] **Heaviest test coverage on the discover/redaction path specifically**
      — a bug here is a privacy incident, not just a bug. Test the allowlist
      builder against deliberately hostile/unexpected input shapes.
- [ ] Synthetic mock Glooko response fixtures for a few different device
      shapes (hand-built, not real accounts) to test capability gating
      without needing real hardware for every combination
- [ ] Confirm sql.js's in-memory/full-reserialize behavior isn't degraded by
      the wider schema (row size, write frequency)
- [ ] A manual test plan for a fresh install / cold-start flow, since that's
      what every new contributor's first run actually looks like

## Phase 4 — Documentation

- [ ] Rewrite `README.md` for the new project identity (still describes the
      original PodQuery/Omnipod-specific framing right now)
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
