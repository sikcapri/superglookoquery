<!--
Thanks for the PR. A few things to check before/while reviewing —
CONTRIBUTING.md has the full detail behind each of these.
-->

**What does this change, and why?**

**Checklist**
- [ ] `npm test` passes
- [ ] If this touches `paths.js`, `store.js`'s schema/version-heal logic,
      `scripts/generate-sample-data.mjs`, or `.mcpb` packaging: ran the
      relevant steps of `docs/MANUAL_TEST_PLAN.md`
- [ ] If a Glooko field name or its location is asserted anywhere new
      (code or docs): confirmed against a real sync, not guessed from
      memory or a design doc (see CONTRIBUTING.md's coding conventions —
      this project has been bitten by this twice)
- [ ] If `docs/TODO.md` claimed something was done that this PR reveals
      wasn't actually complete: said so plainly here, rather than working
      around it quietly

---

<!--
DELETE THIS SECTION IF THE PR DOES NOT TOUCH schema-registry/.

A PR that touches schema-registry/ directly (rather than arriving through
the submission guardrail sequence — get_registry_contribution_report /
submit_registry_contribution, or the CLI script) gets extra scrutiny:
entries are supposed to arrive already reviewed and hash-verified, not
hand-edited. If you're a maintainer merging a contribution that came
through a GitHub issue (the no-gh fallback — see
schema_registry_contribution.md), confirm you've personally re-run
scanForLeakage-equivalent judgement on the pasted content yourself before
merging, since that path never ran the automated scan.
-->

**Schema registry PR checklist**
- [ ] Entry arrived via the guardrail sequence (in-chat tools, or the CLI
      script) — not hand-written or hand-edited
- [ ] If arriving via a GitHub issue (no-`gh` fallback): re-checked the
      pasted report myself for anything that looks like a real value, not
      just a fixed placeholder
- [ ] File validates against `schema-registry/entry.schema.json`
- [ ] If this disagrees with an existing entry for the same
      component/slug: flagged it explicitly rather than silently
      overwritten (registry conflict resolution has no policy yet — see
      `docs/DESIGN.md`'s Known follow-ups)
