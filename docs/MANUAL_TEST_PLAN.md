# Manual test plan — fresh install / cold-start flow

**Purpose:** this is what every new contributor's or new user's first run
actually looks like. `npm test` covers unit-level logic; this covers the
end-to-end experience nothing automated can check — real file I/O against a
genuinely empty starting state, real terminal/Claude Desktop interaction,
and real packaging.

Run this before cutting a release, and any time a change touches
`paths.js`, `store.js`'s schema/version-heal logic, `scripts/
generate-sample-data.mjs`, `manifest.json`, or the `.mcpb` packaging step —
exactly the categories where this project has already found real bugs by
hand this way (see the "Why this exists" section at the bottom).

Each step names what to run and what to check. A step that can be scripted
has the command; a step that genuinely needs a human (Claude Desktop's own
UI, visually judging a chart) says so explicitly.

---

## 1. Fresh clone, dependency install

```bash
# Bash
git clone <repo-url> fresh-checkout
cd fresh-checkout
npm install
```

**Check:** completes with no errors (warnings about deprecated transitive
deps / audit advisories are expected and not a release blocker on their
own — re-evaluate only if a `npm audit` shows something newly severe).

## 2. Test suite passes on the fresh checkout

```bash
# Bash
npm test
```

**Check:** all tests pass. This is the one step most likely to already be
covered by CI once Phase 6 exists — run it here anyway, once, as the
baseline everything else in this plan builds on.

## 3. Offline / sample-data mode, from nothing

No `.env`, no credentials anywhere — this is what a brand-new install with
blank Glooko fields looks like.

```bash
# Bash
OMNI_DB_PATH=/tmp/fresh-offline-test.sqlite node -e "
import('./src/store.js').then(async ({ensureDbReady, getCgmCount}) => {
  await ensureDbReady();
  console.log('CGM count:', getCgmCount());
});
"
```

**Check:** prints a non-zero CGM count (the bundled synthetic sample
database seeded itself) — **not zero**. Zero here means the shipped
`examples/podquery.db` is stale against the current `SCHEMA_VERSION` and got
silently wiped by the version-heal self-repair logic on first open — this
exact failure mode broke the offline experience once already this project
(2026-09-09); see `scripts/generate-sample-data.mjs`'s header. If it fails,
regenerate with `node scripts/generate-sample-data.mjs` and re-run this
step before going any further.

```bash
# Bash
OMNI_DB_PATH=/tmp/fresh-offline-test.sqlite timeout 5 node src/server.js
```

**Check:** prints `[superglookoquery] MCP server running on stdio.` and
nothing else (no `tools/list_changed` — the sample data has no
capability-gated fields confirmed, so nothing beyond the core tool set
should register). An error here, or the process hanging past the timeout
instead of the log line appearing promptly, both matter — see step 8.

## 4. Claude Desktop install (human-only — no script can do this step)

1. Build or download the `.mcpb` (see step 9 first if testing a fresh
   packaging change).
2. Install it in a **clean** Claude Desktop profile if possible (or at
   least a conversation with no prior SuperGlookoQuery state) via
   **Settings → Extensions → Advanced settings → Install Extension…**.
3. **Check:** the install screen lists permissions/capabilities that make
   sense (Glooko network access, local filesystem) — nothing unexpected.
4. Land on the settings/configuration screen. **Check:** every field listed
   in the README's "Configuring Your Settings" table is present, and the
   ones documented as pre-filled defaults actually arrive pre-filled (an
   empty required field would block saving — if the form saves blank
   without complaint, that's a real bug, not a documentation gap).
5. Leave Glooko email/password blank, save.

## 5. First real question, offline mode (human-only)

In a fresh Claude Desktop conversation with the extension enabled, ask:

> Tell me about my diabetes data.

**Check:**
- A response arrives with sensible, internally-consistent figures (TIR,
  GMI, etc.) — this is the synthetic sample data, so exact numbers don't
  matter, only that nothing errors and nothing looks obviously broken
  (negative percentages, NaN, undefined).
- Ask for a chart (`get_chart_html`). **Check:** a browser window/tab
  actually opens with a rendered chart, not just a JSON blob back in chat.
- Try the **Clinical auditor persona** prompt from the prompt picker.
  **Check:** it loads without error and the assistant's tone/behaviour
  visibly shifts to the direct, aggregate-first style described in
  `src/prompt.js`.

## 6. Switching to a real Glooko account (human-only, needs real credentials)

1. Settings → Extensions → SuperGlookoQuery → fill in real Glooko
   email/password, set "Glooko account's glucose unit" to match the real
   account.
2. Per the README's "Switching from the Sample Data to Your Own": delete
   the existing `PodQuery` subfolder under the configured Data folder
   first, so sample data and real data are never mixed.
3. Ask a question. **Check:** the first response takes noticeably longer
   (a real cold-start sync is happening) but does complete — it should not
   hang indefinitely or time out the tool call. `console.error` output
   (visible in Claude Desktop's logs, if accessible) should show batch
   pull progress, not a silent hang.
4. Ask the same overview question again. **Check:** this second call is
   fast (served from the now-populated local archive, no new network
   fetch for data already covered).
5. **Check the numbers make sense** against what the real Glooko web app
   shows for the same account/period — this is the one step in this whole
   plan that actually validates real-world data correctness, not just "it
   ran without crashing."

## 7. Capability-gated modules behave correctly for this real account

```bash
# Bash — with the real account's credentials set (see .env.example)
node -e "
import('./src/store.js').then(async ({ensureDbReady, getFieldCapabilities}) => {
  await ensureDbReady();
  console.log(getFieldCapabilities());
});
"
```

**Check:** the capability rows present match what this account's device(s)
actually report — e.g. a CamAPS FX account should show `stats` category
`camapsPumpMode*` rows and a non-Omnipod account should show empty
`basalBarAutomated*`/`setSiteChange`/`cgmSensorChange` (see
`test/device-fixtures.test.js` for the two reference shapes this compares
against). Ask Claude a question that would exercise a capability-gated tool
(e.g. "how much time was I in automatic mode" for a CamAPS account) and
confirm the tool actually appears/fires — or, for a non-CamAPS account,
confirm it's simply absent rather than present-and-erroring.

## 8. Corruption / interrupted-run resilience (optional, but cheap)

```bash
# Bash — truncate a valid archive mid-file to simulate a crash-during-write
OMNI_DB_PATH=/tmp/corrupt-test.sqlite node -e "
import('./src/store.js').then(({ensureDbReady}) => ensureDbReady());
" 
head -c 100 /tmp/corrupt-test.sqlite > /tmp/corrupt-test-truncated.sqlite
mv /tmp/corrupt-test-truncated.sqlite /tmp/corrupt-test.sqlite
OMNI_DB_PATH=/tmp/corrupt-test.sqlite timeout 5 node src/server.js
```

**Check:** the server still starts (prints the running-on-stdio line), and
if you check the data directory, a `.corrupt-<timestamp>` quarantine file
exists next to a freshly-started empty/re-seeded archive — matching
`store.js`'s `initDb()` documented quarantine behaviour. It must NOT crash
the whole process or silently discard the corrupt file with no trace.

## 9. Packaging (`.mcpb` build)

```bash
# Bash
npm install -g @anthropic-ai/mcpb   # once per machine
npm prune --omit=dev                # drop eslint et al. from node_modules first
mcpb pack
npm install                         # restore devDependencies for local dev
```

**Check:** produces a `.mcpb` file with no errors. Then install *that*
file (not a previously-built one) in step 4 above, so packaging changes
are actually covered by the rest of this plan, not just assumed compatible.

**Why the `npm prune` step:** confirmed by actually running `mcpb pack`
against a normal dev checkout (2026-09-10) — `mcpb` bundles whatever is
physically present in `node_modules`, with no awareness of
`package.json`'s `dependencies`/`devDependencies` split. A developer's own
checkout has `eslint` (and its own dependency tree, including transitive
packages like `qified`) installed for local linting, and packing straight
from that tree pulled all of it into the `.mcpb` too — verified by
comparing a pack before pruning (7.5MB / 3151 files) against one after
(5.4MB / 2255 files) on an otherwise-identical tree. `.mcpbignore` alone
doesn't cover this — it excludes specific known paths, not "whatever the
current devDependency set happens to be." A CI release step should do
this in a fresh `npm ci --omit=dev` checkout rather than a prune/reinstall
dance, since it never has devDependencies installed in the first place.

---

## Why this exists

Not a hypothetical checklist — every category of check above corresponds
to a real bug this project already found by hand, the hard way, at least
once:

- Step 3 (offline seed) — the bundled sample database was found silently
  wiped to empty by the version-heal logic (2026-09-09), which would have
  completely broken this exact flow for any real new user.
- Step 3 (server start) — the Windows entrypoint-guard bug (`file://` vs
  `pathToFileURL`) meant `node src/discover.js`/`submit-registry-entry.js`
  silently produced no output at all on this project's own dev platform;
  caught only by the test suite, not by this kind of manual run — a reason
  to keep running this plan even with good automated coverage.
- Step 6/7 — the bolus split-field names and the CamAPS pump-mode field
  location were both guessed wrong from memory before being confirmed
  against a real account; this plan's step 6/7 are what would have caught
  either mistake immediately instead of needing a dedicated investigation.
- Step 8 — `store.js`'s own quarantine-on-corruption logic exists
  specifically for this scenario and had never been manually exercised
  end-to-end before this plan was written.
