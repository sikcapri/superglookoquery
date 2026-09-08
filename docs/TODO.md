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
- [ ] Seamless in-session PR submission (`gh pr create`). **Not started** —
      the flow currently stops at "written and hash-verified locally under
      `schema-registry/`," deliberately not implying it goes any further.
- [ ] Capability-gated module registration in `server.js` (a module's tools
      only register if its required fields are confirmed present)
- [x] `schema-registry/` folder structure: `pumps/`, `cgms/` (with
      `.gitkeep`), `lifestyle-features.json` not yet created (no lifestyle
      data path exists yet — see Phase 1's other pending items), plus a
      `README.md` documenting the entry format and contribution flow.
- [ ] A documented (even if manual-for-now) promotion process: who reviews
      registry contributions and decides when a field graduates from `extra`
      to a typed column

## Phase 2 — First real features on the new architecture

(The point of doing Phase 1 at all — pick a first real payoff before
generalizing further.)

- [ ] Capture bolus split/extended-delivery fields (`initialDelivery`,
      `extendedDelivery`, `extendedBolusDuration`, percentages) — the
      original motivating question
- [ ] A tool exposing split-bolus history/analysis once captured
- [ ] Capture CamAPS pump-mode breakdown (automatic/manual/boost/attempting
      percentages) as the first genuinely device-specific, capability-gated
      module — proves the gating mechanism actually works end to end
- [ ] Submit the first real schema-registry entry (this account's own
      CamAPS FX + Ypso pump + Libre 3+ combo) — the project's own bootstrap
      contribution, dogfooding the submission mechanism itself

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
