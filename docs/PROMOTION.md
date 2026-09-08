# Promotion process — from `extra` to a typed column

`docs/DESIGN.md` section 5 describes the promotion *path* (an `extra` field
graduates into a dedicated typed column once it's "confirmed common enough").
That section deliberately left two things unspecified — a concrete trigger,
and an owner — flagged in its own "Known follow-ups" as a real gap, not a
detail. This doc closes that gap.

This is a manual, maintainer-driven process for now. There's no tooling that
promotes a field automatically, and none is planned — promotion changes the
schema and the ingestion code, which deserves a human decision each time, not
an automatic threshold trigger.

## Who decides

The project maintainer (currently the repo owner). There is exactly one
person doing this today, so "who reviews registry contributions" has a
trivial answer right now — but the process below is written so it still
works once/if there's more than one contributor, per DESIGN.md's own
conflict-resolution follow-up.

## When a field becomes a promotion candidate

A field is a *candidate* once **both** are true:

1. **Evidence of real prevalence**, not a single account's data. Concretely:
   the field appears in the schema registry (`schema-registry/pumps/` or
   `schema-registry/cgms/`) for **at least 2 different contributed entries**
   for that component, OR for one entry if that's the only contribution that
   component has ever received (the bootstrap case — see below). One
   person's `extra` column being full of a field says nothing about whether
   it's a real characteristic of the device or a quirk of that account.
2. **Something wants to use it structured.** A field only earns a typed
   column when a real tool/analysis needs to filter, sum, or join on it —
   `extra` is JSON-parsed on read already (`store.js`'s `getTimeline()`), so
   "it would be nice to have a column" is not by itself a reason; querying
   *inside* `extra` a few times as part of building a feature is normal and
   doesn't itself justify promotion.

Meeting both isn't a guarantee of promotion, just a signal it's worth the
maintainer looking. A field can sit in `extra` indefinitely with no penalty
beyond "not indexed" — see DESIGN.md section 5's own point that the
architecture's only real obligation is to never lose the data while it
waits.

### The bootstrap case

Right now the schema registry has zero contributed entries — this project's
own CamAPS FX/Ypso/Libre 3+ account will be the first (Phase 2 in
`docs/TODO.md`). Until a second, independent contributor exists for a given
component, "at least 2 entries" can't be satisfied for anything. That's
expected, not a bug in this process: a single account's data is enough to
build and ship a feature (Phase 2's bolus-split tool is exactly this), but
promoting the underlying field to a typed *column* — implying it's a general
characteristic of the device, not this one account — should wait for a
second confirming entry once one exists. Track fields promoted under the
bootstrap exception explicitly in the promotion log below, so a later
contributor's disagreement has something concrete to point at.

## What promotion actually involves

Promoting a field is a normal schema-migration change, done by hand:

1. Bump `SCHEMA_VERSION` in `store.js` and add the new typed column(s) to the
   relevant `CREATE TABLE` in `SCHEMA_SQL`.
2. Update the category's known-keys list in `analytics.js`
   (`CGM_KNOWN_KEYS` / `BOLUS_KNOWN_KEYS`) to include the newly-typed field,
   so `captureExtra()` stops duplicating it into `extra` once it has a real
   column.
3. Update the mapping function that builds each record (the `cleanCgm.push`
   / bolus `.map()` blocks in `analytics.js`) to read the field from the raw
   Glooko payload into the new typed column, the same way every existing
   typed field already works.
4. Write a one-off backfill for existing archives: read the value back out
   of each row's `extra` JSON and write it into the new column, then leave it
   in `extra` too — promotion is additive, it should never delete
   historical data or require a re-sync from Glooko.
5. Add or extend the MCP tool that actually uses the field, if one doesn't
   exist yet — promotion without a consuming tool is just schema churn.
6. Record the change in the promotion log below.

## Nested fields — not yet handled

DESIGN.md's "Known follow-ups" already flags this: some `extra` fields are
structured sub-objects (CamAPS's mode-percentage block is the concrete
example), not flat scalars, and `captureExtra()` stores them as-is without
flattening. Promoting a nested block needs a decision this process doesn't
make yet — one column per sub-field, or a single JSON column with dedicated
query helpers. Treat the first real nested-field promotion candidate as the
point to decide this, rather than guessing now with no real case in front of
it.

## Promotion log

Track every promotion here as it happens — this is the record a future
contributor checks before assuming a field is still `extra`-only.

| Date | Field(s) | Component | Trigger | Notes |
|------|----------|-----------|---------|-------|
| _none yet_ | | | | |
