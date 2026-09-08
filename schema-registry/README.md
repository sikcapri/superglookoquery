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

Each file is the output of `src/submit-registry-entry.js`, unedited:

```json
{
  "component": "pump",
  "deviceName": "CamDiab CamAPS FX",
  "slug": "camdiab-camaps-fx",
  "discoveredAt": "2026-09-09T12:00:00.000Z",
  "windowDaysActual": 30,
  "lowConfidence": false,
  "fields": [
    { "fieldName": "initialDelivery", "type": "number", "populatedRate": 0.5, "syntheticExample": 12.34 }
  ]
}
```

**No real values are ever present in a contributed entry** — `syntheticExample`
is always one of a small fixed set of fabricated placeholders (see
`src/discover.js`'s `classify()`), never data read from a real account.
`docs/DESIGN.md`'s submission-gating sequence enforces this before a file
can be submitted at all.

## Contributing

Run `node src/submit-registry-entry.js`. It walks you through generating a
report, reviewing it in full, a required typed confirmation, and then opens
a PR for you (via `gh pr create`) if you have the GitHub CLI installed and
authenticated. If not, your entries are still written and hash-verified
locally under `schema-registry/` — push the branch and open the PR
yourself, or email the maintainer / paste the report into a GitHub issue.
See `CONTRIBUTING.md` (not yet written — Phase 4) for the full walkthrough.

## If two contributors' entries for the same component disagree

Not yet resolved — see `docs/DESIGN.md`'s "Known follow-ups" (registry
conflict resolution has no policy yet). Flag it in the PR description if you
hit this rather than silently overwriting an existing entry.
