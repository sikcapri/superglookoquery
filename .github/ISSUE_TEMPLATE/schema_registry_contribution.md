---
name: Schema registry contribution (no GitHub CLI / can't open a PR)
about: Contribute your device's discovery report when you can't use `gh pr create`
title: "[Registry] "
labels: schema-registry
---

<!--
This is the documented fallback for contributing a schema registry entry
without the GitHub CLI (see docs/DESIGN.md's "No GitHub account fallback"
note and CONTRIBUTING.md). If `gh` IS installed and authenticated, use the
normal in-chat flow instead (get_registry_contribution_report /
submit_registry_contribution, or `node src/submit-registry-entry.js`
locally) — it opens a PR for you directly, no issue needed.

This path does NOT run the automated independent privacy scan
(scanForLeakage) the normal flow does — a maintainer will re-run that scan
by hand on what you paste below before anything is added to the registry.
That's expected, not a shortcut being skipped carelessly.
-->

**I have personally reviewed the report below in full, and confirm it contains no real values, personal identifiers, or health data from my account.**

<!-- Only proceed if the statement above is genuinely true. If you haven't reviewed the report yourself, go back and read it first. -->

**Paste your discovery report exactly as generated below** (from asking Claude to review your device data for the schema registry, or `node src/discover.js` locally — never hand-edited or summarized):

```
<!-- paste the full report output here -->
```

**Device(s) this report is for** (model name only, nothing else):
- Pump:
- CGM:

**Anything unusual about your setup worth knowing** (e.g. an uncommon Glooko-supported feature, a non-default configuration):
