# Contributing to SuperGlookoQuery

Thanks for considering it. This project is still early (see `docs/TODO.md`
for exactly what's done and what isn't), so the most valuable contribution
right now is often data — a schema registry entry from a device combo this
project hasn't seen — not necessarily code. Both are covered below.

## Before you start

Read these in this order, going as deep as the change warrants:

1. [`README.md`](README.md) — what this is and how it's used.
2. [`docs/DESIGN.md`](docs/DESIGN.md) — the architecture: typed-core +
   `extra` overflow, capability-gated modules, the schema registry.
3. [`docs/TODO.md`](docs/TODO.md) — the living roadmap. Check here before
   starting something in case it's already in progress or has a documented
   reason it's deliberately not done yet.

## Development setup

```bash
# Bash
git clone https://github.com/sikcapri/superglookoquery.git
cd superglookoquery
npm install
npm test
```

For local dev against real Glooko data (optional — most changes don't need
it), copy `.env.example` to `.env` and fill in your own credentials; see the
file's own comments. **Never** commit `.env` (it's gitignored) or any real
archive file (`podquery.db` outside `examples/`).

Run [`docs/MANUAL_TEST_PLAN.md`](docs/MANUAL_TEST_PLAN.md) before a release,
or whenever a change touches `paths.js`, `store.js`'s schema/version-heal
logic, `scripts/generate-sample-data.mjs`, or the `.mcpb` packaging step —
`npm test` doesn't cover a genuinely fresh install/cold-start.

## Coding conventions

These aren't arbitrary style preferences — each one exists because this
project hit a real problem without it:

- **Never guess a Glooko field name or its location from memory or a design
  doc.** Confirm it against a real sync first. This project got bitten by
  this twice in one session (a bolus field name, then the CamAPS pump-mode
  location) before adopting the rule. If you don't have a real account to
  test against, say so in the PR rather than guessing — a maintainer can
  verify, or it can wait for `discover.js`'s report from a real
  contribution.
- **Never discard a field Glooko sends, even if unused.** Anything not
  mapped to a typed column goes in `extra` (see `captureExtra()` in
  `analytics.js`) — this is the whole point of the typed-core + overflow
  design.
- **`analytics.js` has zero imports, by design** — pure functions only, no
  I/O, so the clinical maths stays trivially testable in isolation. Don't
  add an import there; if a function needs data outside what's passed in
  (e.g. `data3.devices` alongside `data1`), the caller (usually `range.js`)
  combines them, not `analytics.js` itself — see `extractDeviceNames()` /
  its use in `range.js`'s `pullAndIngest` for the pattern.
- **`server.js` stays thin.** Tool handlers validate input, call into
  `analytics.js`/`store.js`/`range.js`, and shape the result — the actual
  logic lives in those modules, not in the tool handler closure. If a tool
  handler is growing real orchestration logic (see
  `submit-registry-entry.js`'s `runChatDrivenSubmission()` for an example
  of this exact refactor), extract it to a named, exported, testable
  function instead.
- **No comments explaining *what* code does** — a well-named function/
  variable already does that. A comment earns its place only for a
  non-obvious *why*: a hidden constraint, a workaround for a specific bug,
  something that would genuinely surprise the next reader. Most files here
  lean heavily on this already; match it.
- **Don't build for a hypothetical future.** A fix doesn't need a
  generalised framework around it; three similar lines beat a premature
  abstraction. This project has undone more than one over-eager abstraction
  already (see `docs/DESIGN.md`'s revision history).

## Testing

`node:test` (Node's own built-in runner), no other framework — `npm test`
runs `node --test test/*.test.js`. A few patterns to match:

- **Isolated scratch DB per test file**, never the real archive:
  ```js
  process.env.OMNI_DB_PATH = path.join(os.tmpdir(), `superglookoquery-test-<name>-${process.pid}.sqlite`);
  ```
  set at the top of the file, before importing `store.js`. See any existing
  `test/*.test.js` file for the full pattern (including `_wipe()` between
  tests in the same file).
- **Synthetic data only** — `test/fixtures/glooko-responses.mjs` has
  hand-built raw-response shapes for a couple of real reference devices;
  add a new fixture there rather than a real account's data if you're
  testing a new device shape.
- **Test the failure/adversarial case, not just the happy path** — this
  project's own history: `writeAndVerify`'s restore-don't-destroy behaviour
  on a hash mismatch, `scanForLeakage`'s adversarial-input tests, and the
  staleness check in `runChatDrivenSubmission` were all found or hardened
  by deliberately testing what happens when something is wrong, not just
  when everything works.

## Contributing a schema registry entry

**Why this exists, not just how:** Glooko has no public, field-level API
schema, and different pumps/CGMs report different fields under it — this
project has no way to know what a device combination it wasn't built around
actually reports, or whether a capability-gated tool would even work for
it, without a real account's evidence. That's what a registry entry is:
proof, from a real account, of what a specific device combination actually
sends, so this project can extend to devices beyond the one it happens to
have been built against, and so someone else with your same combo benefits
from your account having already proven it out — without your data, or
theirs, ever leaving their own machine. This is often the single most
useful contribution available: most people reading this can't add a new
feature to the codebase, but anyone on an untested device combo can hand
this project real evidence it currently has none of.

1. Sync your own account's data normally (ask Claude a diabetes question,
   or run the server locally against your `.env` credentials).
2. In a live chat with the extension enabled, ask Claude to review your
   device data for the schema registry — this calls
   `get_registry_contribution_report`, which builds a report containing
   **no real values from your account**: only field names, types, and how
   often each is populated, with every example replaced by a fixed
   placeholder. Review it in full.
3. If you're satisfied it contains nothing sensitive, type the exact
   confirmation phrase it gives you (Claude cannot supply this on your
   behalf — see `src/prompt.js`'s tool guide for why). This calls
   `submit_registry_contribution`, which runs an independent second privacy
   scan (`scanForLeakage` — deliberately doesn't trust the first pass),
   writes to `schema-registry/`, and opens a PR if you have the GitHub CLI
   installed and authenticated.
4. No terminal/no `gh`? The files are still written and hash-verified
   locally under `schema-registry/` — commit and open the PR yourself, or
   see `docs/DESIGN.md`'s "No GitHub account fallback" note (email the
   maintainer, or paste the report into a GitHub issue).
5. (Local dev only, needs a real terminal): `node
   src/submit-registry-entry.js` runs the same sequence interactively —
   useful for testing this flow itself, not the intended path for a real
   end user, who has no terminal in Claude Desktop at all.

See `schema-registry/README.md` for the entry format itself, and
`docs/PROMOTION.md` for how a field eventually graduates from `extra` into
a proper typed column once enough real accounts have shown it.

## Adding a capability-gated module

A capability-gated module is a tool that should only appear for accounts
whose data has actually shown the field(s) it needs — see `docs/DESIGN.md`
section 4. `server.js`'s `GATED_MODULES` array is the extension point:

```js
const GATED_MODULES = [
  {
    name: 'your_module_name',
    requires: [{ category: 'bolus', fieldName: 'someConfirmedRealField' }],
    register: (srv) => {
      srv.registerTool('get_your_tool_name', { /* title, description, inputSchema */ }, async (args) => {
        // handler
      });
    },
  },
];
```

- `requires` lists every `(category, fieldName)` pair that must have been
  confirmed populated (via `store.js`'s `field_capability` table) for this
  module to register at all — checked once, after `server.connect()`, not
  per-call (see the comment above `GATED_MODULES` for why gating can't
  happen inside `createServer()` itself).
- The field name(s) in `requires` must be confirmed against a **real**
  sync first — see the coding-conventions note above. `get_camaps_pump_mode_breakdown`
  is the one real example so far; read its full entry in `server.js` before
  writing a new one.
- If the module's data can be served from the local archive, do that
  (matching every other tool). If it genuinely can't (like the CamAPS
  pump-mode breakdown, which is a live Glooko aggregate this project
  deliberately never archives — see `range.js`'s `getProcessedRange`
  comment), say so explicitly in the tool's own description, the way that
  one does.
- Add a fixture to `test/fixtures/glooko-responses.mjs` and tests
  exercising both "capability confirmed → registers" and "capability
  absent → genuinely doesn't register, not an error" — see
  `test/server.test.js` for the pattern.

## Pull requests

- Run `npm test` first — it should be green.
- A PR touching `schema-registry/` directly (not through the guardrail
  sequence above) will be treated with extra scrutiny — the whole point of
  the submission gating is that entries are supposed to arrive already
  reviewed and hash-verified, not hand-edited.
- Keep the PR scoped to one change. This project's own commit history
  (this session's, specifically) is full of examples of "found X while
  doing Y" moments that became their own separate, clearly-described
  commits rather than being folded silently into an unrelated change —
  match that.
- If your change reveals that something documented as done in
  `docs/TODO.md` wasn't actually complete (it's happened before — see the
  "seamless in-session PR submission" entry's own correction), say so
  plainly rather than working around it quietly.

## Questions / issues

Open a [GitHub issue](https://github.com/sikcapri/superglookoquery/issues).
