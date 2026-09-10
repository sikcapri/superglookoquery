# Changelog

All notable changes to this project are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/), and versioning
follows the policy in `CONTRIBUTING.md` once this leaves pre-1.0.

Still in active pre-1.0 development — nothing has been tagged or released
yet, so everything so far sits under `[Unreleased]`. See `docs/TODO.md` for
the full, detailed roadmap and status; this file is the user/contributor-
facing summary, not a substitute for it.

## [Unreleased]

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
