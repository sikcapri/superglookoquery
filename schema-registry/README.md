# Schema registry

Evidence-based catalog of what fields Glooko actually returns, per device
component — built from real contributed reports, not maintainer guesses
about hardware nobody on this project owns. See `docs/DESIGN.md` sections
2b/3 for the full design.

## Layout

- `pumps/<slug>.json` — one file per insulin pump/algorithm (e.g.
  `camdiab-camaps-fx.json`). Bolus/insulin-event fields only.
- `cgms/<slug>.json` — one file per CGM device. CGM-reading fields only.
- `lifestyle-features.json` — a single shared file for Glooko-account-level
  features (food diary, exercise, weight, blood pressure) that are gated by
  which optional Glooko features a user has turned on, not by device brand.

`<slug>` is derived from Glooko's own `deviceName` field where available
(lowercased, spaces to hyphens), falling back to a name the contributor
supplies if `deviceName` isn't present in a given category's records.

## Entry format

Each file is the output of `submit_registry_contribution`/`runChatDrivenSubmission()`
(or the CLI script's `main()`), unedited. Full field-by-field spec:
[`entry.schema.json`](entry.schema.json) (JSON Schema draft-07) — validated
against both real entries currently in this registry. A real example (this
project's own first contribution):

```json
{
  "component": "pump",
  "deviceName": "CamDiab CamAPS FX",
  "slug": "camdiab-camaps-fx",
  "discoveredAt": "2026-09-09T04:27:33.639Z",
  "windowDaysActual": 30,
  "lowConfidence": false,
  "fields": [
    { "fieldName": "highestBolusValue", "type": "number", "populatedCount": 108, "populatedRate": 1, "syntheticExample": 12.34 }
  ]
}
```

**No real values are ever present in a contributed entry** — `syntheticExample`
is always one of a small fixed set of fabricated placeholders (see
`src/discover.js`'s `classify()`), never data read from a real account.
`docs/DESIGN.md`'s submission-gating sequence enforces this before a file
can be submitted at all.

## Contributing

See [`CONTRIBUTING.md`](../CONTRIBUTING.md)'s "Contributing a schema
registry entry" section for the full walkthrough (why this matters, not
just the mechanics) — in short: ask Claude to review your device data for
the schema registry in a live chat (this calls
`get_registry_contribution_report` then, once you've reviewed it and typed
its exact confirmation phrase yourself, `submit_registry_contribution`),
which writes here and opens a PR via `gh pr create` if available. No
terminal/no `gh`? Entries are still written and hash-verified locally —
push the branch and open the PR yourself, or see `docs/DESIGN.md`'s "No
GitHub account fallback" note (email the maintainer, or paste the report
into a GitHub issue). `node src/submit-registry-entry.js` runs the same
sequence interactively for local development.

## If two contributors' entries for the same component disagree

Not yet resolved — see `docs/DESIGN.md`'s "Known follow-ups" (registry
conflict resolution has no policy yet). Flag it in the PR description if you
hit this rather than silently overwriting an existing entry.
