# Security Policy

This project handles two things that deserve real care: your Glooko login
credentials and your personal health data. Both stay on your own machine
by design (see README.md's "Privacy & Security" section) — a
vulnerability that undermines that is treated as high priority.

## Reporting a vulnerability

**Please do not open a public GitHub issue for a security vulnerability.**
A public issue is visible to anyone before a fix exists.

Instead, report it privately:
- Open a [GitHub security advisory](https://github.com/sikcapri/superglookoquery/security/advisories/new)
  for this repository (preferred — keeps the report private until resolved), or
- Email the maintainer directly (see the profile linked from the repo's
  GitHub page).

Please include:
- What you found and why it's a concern.
- Steps to reproduce, if applicable.
- Anything you know about the potential impact (e.g. could this expose
  Glooko credentials, real health data, or allow writing outside the
  intended files).

**Do not include any real Glooko credentials or real health data in a
report**, even a private one — describe the issue in words, or use
fabricated example values, the same discipline this project's own code
follows (see `docs/DESIGN.md`'s discovery/redaction design).

## What's in scope

- Anything that could expose Glooko credentials beyond "sent directly to
  Glooko's own servers" (the one place they're meant to go).
- Anything that could expose real health data beyond the local machine —
  including through the schema registry contribution flow, which is
  specifically designed to never include real values (see
  `src/discover.js`/`src/submit-registry-entry.js` and their test
  coverage) — a way around that guarantee is a real vulnerability, not a
  theoretical one.
- Command/path injection in anything that shells out (`git`/`gh` calls in
  `submit-registry-entry.js`, browser-opening in `server.js`).
- Anything that could write outside the intended data directory or
  `schema-registry/` folder.

## What's likely out of scope

- Issues that require an attacker to already have local code-execution
  access to the machine running this MCPB — at that point the local
  archive and any credentials in the environment are already compromised
  by something outside this project's control.
- Vulnerabilities in dependencies (`sql.js`, `@modelcontextprotocol/sdk`,
  etc.) that don't have a project-specific exploitation path here — report
  those upstream, though a note here is still welcome if it affects how
  this project uses that dependency.

## Response

This is a small project without a dedicated security team — expect an
initial response within a few days, not a formal SLA. Credit will be given
in the eventual fix/release notes unless you'd prefer otherwise.
