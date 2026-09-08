# SuperGlookoPodQuery — High-Level Design

**Date:** 2026-09-09
**Status:** Reviewed, both must-fix items addressed. Ready for implementation.

## Background

[PodQuery](https://github.com/rilhia/podquery-mcp) (MIT licensed, by Richard Hall)
is an MCP server that pulls Glooko diabetes data (CGM, bolus, basal, pump
settings) into a local SQLite archive and exposes it to Claude as analysis
tools. It was built around one author's own device combo (Omnipod 5), and its
ingestion code reads a small, fixed set of fields from Glooko's internal
`deliveredBolus`/stats API response, discarding everything else.

Inspecting a live raw payload (one CamAPS FX + Ypso pump + Libre 3+ account,
3-day sample) found a large number of fields silently discarded at ingest,
including:
- Bolus split/extended-delivery data (`initialDelivery`, `extendedDelivery`,
  `extendedBolusDuration`, and percentages) — present on every bolus record,
  just never read.
- Device-specific operating-mode stats (e.g. CamAPS's own
  automatic/manual/boost/attempting-mode percentage breakdown).
- A `mealTag` field on every CGM reading.
- A large stats block covering carbs/fat/protein per meal, exercise,
  medications, weight, blood pressure — present in the schema but empty for
  this specific account, since it doesn't use Glooko's structured food/health
  diary features.

Glooko has no public, field-level API schema. Its official developer portal
(`developers.glooko.com`) documents only a B2B/EHR integration product (gated
behind a business relationship, different auth model, no payload-level
schema). No community reverse-engineering documentation was found either.
**The only ground truth available to this project is whatever a
contributor's own account actually returns** — which will differ by pump
brand, CGM brand, and which optional Glooko features (food diary, exercise
log, weight, BP) a given user actually uses.

## Goal

Fork PodQuery into a new project (working name: SuperGlookoPodQuery) that:
1. Captures materially more of what Glooko already sends, instead of
   discarding most of it at ingest.
2. Is **not** built around any one pump/CGM/app combination. It must work
   sensibly for a contributor whose device set was never seen during
   development.
3. Is publishable on a public repo, MIT-licensed, for other users to run
   against their own accounts.
4. Runs as a normal MCP server, so it works from Claude and from any other
   MCP-compatible client — nothing about the design is Claude-specific.

## Core problem

We cannot enumerate "all possible Glooko fields" in advance. A schema
hardcoded from one account's observed fields would just reproduce PodQuery's
original problem (built around one setup) in a new shape. The design has to
assume **the field set is only knowable per-account, at run time**, and adapt
to that rather than pre-declare it.

## Architecture

### 1. Typed core + raw overflow

Every ingested record (CGM reading, bolus event, etc.) keeps:
- A small set of **typed columns** for fields confident to be universal
  across all Glooko accounts regardless of device (epoch, glucose value,
  delivered insulin units, carbs input — the handful PodQuery already
  captures).
- One **`extra` JSON column** holding everything else Glooko returned for
  that record, verbatim and unfiltered. Nothing is silently dropped because
  it wasn't anticipated; an unfamiliar device's fields land here just as
  readily as a known one's.

### 2. Discovery — two distinct mechanisms, not one

Draft 2 of this design used a single "periodic re-discovery on a rolling
window" mechanism for everything. On reflection that's the wrong shape for
truly rare, occasional features: a rolling-window rescan can miss a feature
used once and not again for months, and worse, it can **flip a previously-
confirmed capability back off** if that later window happens not to contain
another instance of it. That's a regression, not just a gap. The fix is to
split this into two mechanisms with different jobs:

**2a. Runtime capability state — continuous and monotonic.**
This is what capability-gating in section 4 actually reads from. Every
normal sync already processes each newly-ingested record; as a byproduct of
that same pass, check each record for any field turning up populated that
the archive hasn't confirmed populated before, and update a persistent
per-field "ever confirmed populated" flag. Once true, always true — this
state is never re-evaluated or rolled back by a later sync seeing fewer
instances. This means a rare feature (extended bolus used once, ever) gets
detected and its module switched on the moment it first happens, not
dependent on falling inside some later periodic snapshot's window. Cost is
negligible since it rides along on ingestion the archive is doing anyway,
not a separate scan.

**Prompt to contribute, the moment something new is confirmed.** The first
time a field flips from "never confirmed populated" to "confirmed," surface
a one-time notice to the user (e.g. in the next tool response, or a flagged
note next session) — something like: "New field detected: `initialDelivery`
(Insulin Pump Data). Your local capability for this is now on. Consider
running `discover --for-registry` to contribute this to the shared schema
registry for other users with your device." This only fires once per field
(not on every subsequent sync), and ties the continuous local detection
directly back into growing the shared registry, rather than leaving
registry contribution as something a user has to remember to do
unprompted.

**2b. The shareable discovery report — a deliberate, point-in-time
snapshot, unchanged in spirit from draft 1.** This is a `discover` command a
user runs on demand when they want to produce something to contribute (in
response to the prompt above, or any time they choose). It walks a sample of
the archive (minimum 30 days, falling back to whatever is available for a
brand-new account, flagged low-confidence until 30 days accumulate) and
produces a report: every field name per Glooko category (Glucose Readings /
CGM Data / Insulin Events / Carbs Events / Insulin Pump Data / Lifestyle
Data), whether each is populated above a real threshold (present and
non-null on at least 1% of records or at least 5, whichever is higher —
never "seen once"), and a **redacted** sample for anything populated.
Concretely: a rarely-used feature (extended/split bolus, etc.) needs to have
actually been used **at least 5 times** somewhere in the account's archive
for it to show up in a registry-bound report — using it once confirms the
capability locally (2a, permanently, immediately) but will not by itself
appear in a *shared* report. This is intentional, not a shortfall to fix:
a single occurrence is deliberately not enough evidence to tell a public
registry "this device supports X" — but it needs to be stated as a real
number, not left implicit, so a contributor knows what to expect rather
than assuming "used it once" is sufficient for either purpose. Since this
snapshot only feeds the shared registry (not local gating, which 2a now
owns), an imperfect sample here is far lower-stakes than it would be for
runtime gating — worst case, a contributed registry entry under-reports a
rare field, correctable once it's been used enough times to clear the bar.

**Privacy — hard guardrails, not a redaction default (strengthened after
further review; this is health-data-adjacent and gets the strictest
treatment in the whole design).**

The report generator is **allowlist-by-construction**, not redact-by-removal.
It never touches or clones a real record — it only knows how to emit a fixed
set of pre-approved metadata keys (field name, category, type,
populated-yes/no, a synthesized example). A new/unexpected field's safe
failure mode is "doesn't appear in the report," never "appears unredacted."
This is a stronger guarantee than "strip the sensitive parts out of a copy,"
where one missed field is a leak.

Synthesized examples are **type-aware**: a numeric/date field gets a
plausible fabricated value (a fake glucose number, a fake timestamp); a
free-text field (food name, note, custom medication name) gets only a
generic placeholder ("example text"), never anything that resembles real
content. If a field's *key itself* is user-authored rather than fixed by
Glooko's schema (e.g. a custom tag name), the key is generalized or omitted
too — the same treatment as a value, not just what's inside it.

**Submission is a gated, multi-step sequence, not a single command:**
1. Generate the report (allowlist-built, as above).
2. Display it **in full** to the user, with an explicit disclaimer.
3. Require a real typed confirmation phrase (e.g. "I have reviewed this and
   confirm it contains no personal data") — not a scriptable `--yes` flag.
4. Run an **independent** second pattern-scan over the generated report,
   checking for anything that resembles real health data (plausible glucose
   ranges, ISO timestamps, etc.) — a check that doesn't trust the same code
   path that built the report, as defense-in-depth on top of the allowlist.
5. Hash the exact confirmed content at the moment of step 3's confirmation.
6. Only after steps 2–4 pass does the tool proceed to submit — and it may
   do so **seamlessly within the same AI session** (e.g. `gh pr create`,
   same as this project's normal PR workflow), no requirement to browse out
   to GitHub manually. The one hard rule at this final step: the content
   actually submitted must match the step-5 hash exactly, or submission is
   refused. This closes the gap between "what was approved" and "what got
   sent" — confirmation and submission are strictly sequential and operate
   on identically the same bytes, never a regenerated or edited version.

The earlier `--include-real-samples` idea (a local-debugging escape hatch
that could skip redaction) is dropped from this design — given the strength
of the allowlist approach, a separate "unsafe mode" flag is an unnecessary
second way for something to go wrong, not a useful feature.

**No GitHub account fallback.** Submitting a PR inherently requires a GitHub
identity (fork/branch permissions, `gh` CLI auth), so a contributor without
one can still generate and review a report locally but has no path to submit
it themselves. Not worth building dedicated tooling around; a one-line
mention in the project's README pointing at a manual fallback (email the
maintainer, or paste the report into a GitHub issue) is enough unless this
turns out to be a real barrier in practice.

### 3. A contributed schema registry, not author-maintained guesses

The discovery report is designed to be shareable. A user can submit theirs as
a PR, **keyed per device component, not per combination** — e.g.
`schema-registry/pumps/camaps-fx.json`, `schema-registry/cgms/libre3.json`,
plus a separate `schema-registry/lifestyle-features.json` for the
Glooko-account-level features (food diary, exercise, weight, BP) that are
gated by which optional Glooko features a user has turned on, not by device
brand. (Draft 1 proposed combo-keyed files, e.g. `camaps-fx-ypsopump.json`
— rejected on review: with even a handful of pumps and CGMs the combos
fragment into mostly-duplicate files that don't share coverage, and it works
against section 4's module system, which is already implicitly per-component,
not per-combo.) Registry entries are merged per-component at capability-check
time. Over time this becomes an evidence-based, cross-device field catalog
built from real contributed accounts, not from the maintainers' guesses about
hardware they don't own. (Same pattern as Nightscout's plugin ecosystem or a
database driver registry: the core doesn't need to know every backend in
advance, contributors extend coverage for backends they actually have.)

Each registry entry carries a `discovered_at` date and a short description of
what was observed, so a stale or since-changed entry is at least dateable
rather than trusted indefinitely as if Glooko's undocumented API were stable
(it isn't — nothing obligates Glooko to keep field names/shapes constant).

### 4. Capability-gated modules — the adaptation mechanism

Each optional module (e.g. "CamAPS pump-mode breakdown", "bolus split
detail") declares which raw fields it needs. At sync/startup time, the
server checks the current account's discovery data:
- Required fields present and populated → the module's tools register
  normally for this session.
- Required fields absent → the module's tools simply don't appear. Not an
  error, not a tool that returns nulls — genuinely absent, the way a
  CamAPS-specific tool should never show up for a Tandem user whose account
  has no such field.

Gating happens at startup, not per-call — a mid-session device swap is rare
enough not to design around. The real staleness risk is different: discovery
data going stale relative to the archive whenever something changes
*without* a device swap (a firmware update populates a previously-null
field; the user turns on food logging for the first time). Section 2a's
continuous, monotonic capability state is what actually addresses this — it
updates as a byproduct of every normal sync, so a module can switch on
between sessions without needing a separate rescan, and (per its monotonic
design) never flips back off once confirmed.

This is the concrete "pivot based on discovery" mechanism: capability
detection at runtime, not a config file a user has to hand-edit, and not a
fixed tool list that quietly misbehaves on unfamiliar hardware.

### 5. Promotion path

A field starts out living only in the generic `extra` JSON column,
unstructured and unindexed. Once it's confirmed common enough (present
across multiple registry entries) and real analysis gets built around it, it
graduates into a proper typed column with dedicated ingestion/query support
— exactly the path `initialDelivery`/`extendedDelivery` would take once
split-bolus analysis is built out. Nothing has to be fully understood on day
one; the architecture's only obligation is to never lose data while a field
waits to be promoted.

## Platform note

This ships as an MCP server (Model Context Protocol — an open standard, not
Claude-specific; other AI clients that support MCP can use it too). No part
of this design is Claude-specific; it's a straightforward local server
process with a SQLite archive, same as the original PodQuery.

## Explicitly out of scope for this design pass

- Which specific fields get promoted to typed columns first (bolus split
  data is the obvious first candidate, given the original motivating
  question, but that's an implementation decision, not an architecture one).
- UI/tool surface design (what the actual MCP tools look like) — this
  document only covers ingestion/storage/module architecture.
- Migration path for existing PodQuery users/archives.

## Decisions from independent review (2026-09-09)

This design was sent for independent architectural review before any
implementation started. Verdict: the core pattern is sound and roughly the
minimum viable mechanism for the stated problem, not over-engineered — but
draft 1 was a storage pattern, not a finished design, since it never
specified how "populated for this account" gets decided reliably. That gap
is fixed above (section 2). Resolved questions:

1. **JSON overflow over EAV** — confirmed. sql.js has no streaming writer;
   every write re-serializes the whole database. EAV's one-row-per-field
   multiplies row count (and therefore serialize cost) roughly linearly with
   field cardinality, for a single-user, read-mostly archive. No benefit to
   pay that cost for here.
2. **Per-component registry keying, not per-combo** — changed above (section
   3). Combo-keyed files fragment into mostly-duplicate entries and work
   against the already-per-component module system.
3. **Startup-time capability gating, not per-call** — confirmed, with the
   real risk correctly reframed as discovery-data staleness (addressed via
   periodic re-discovery in section 2), not mid-session device swaps.

## Later refinement (2026-09-09, same day, after further discussion)

Section 2's original "periodic re-discovery on a rolling window" was
replaced with the current split (2a continuous/monotonic runtime state, 2b
on-demand snapshot for registry contribution) after realizing a rolling
rescan could both miss a truly rare feature and regress a previously-
confirmed one. The prompt-to-contribute behavior in 2a was added at the same
time, so a newly-detected field doesn't just sit locally — it nudges the
user toward the registry that section 3 depends on.

## Second refinement (2026-09-09, same day) — submission guardrails

Section 2b's privacy handling was strengthened from "redact by construction"
(a removal pattern, one missed field away from leaking) to a hard,
allowlist-by-construction report generator, plus a gated multi-step
submission sequence (mandatory full display, typed confirmation, an
independent second pattern-scan, and a content-integrity hash check tying
what was approved to what actually gets submitted). Actually opening the PR
is still allowed to happen seamlessly within the AI session once those gates
pass — the guardrail is on the content being reviewed and hash-verified
before submission, not on requiring the human to manually use GitHub's
website.

## Known follow-ups (not blocking, to revisit during implementation)

- **Registry conflict resolution:** given sampling error is the expected
  case (not an edge case), two honest contributors' entries for the same
  component may disagree on whether a field is populated. Needs a merge
  policy (e.g. "populated" wins if any contributed entry saw it populated)
  before the registry has more than a couple of entries per component.
- ~~**Promotion trigger ownership**~~ — resolved, see `docs/PROMOTION.md`:
  maintainer-driven, manual, with concrete candidate criteria and a
  bootstrap exception for the period before the registry has independent
  contributions.
- **Nested fields in `extra`:** some discovered fields are structured
  sub-objects (e.g. CamAPS's mode-percentage block), not flat scalars.
  Promotion of a nested block to typed columns needs different handling
  than promoting a scalar field; the current design doesn't distinguish the
  two cases.
