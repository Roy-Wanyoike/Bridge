#!/usr/bin/env node
// create-pr-wave3.mjs — Wave 3 PR: lint zero + close informational #82
const TOKEN = process.env.GH_TOKEN;
const REPO = 'Roy-Wanyoike/bridge';

const body = `## Wave 3 — lint zero across all packages (audit finding)

Third and final wave of the post-0.2.0 audit fixes. Verified locally: npm run lint passes with **--max-warnings 0** (tightened from 25), npm run build clean, **684/684 tests pass** across all 9 workspaces, generated Java output inspected to confirm the fix.

### Fixes #81 — lint debt, fixed honestly (no rule relaxation)

- **java.ts json sample — real latent bug found by the linter.** The old single-quoted TS literal collapsed its escaped-quote sequence, so the emitted Java sample for a json-typed field was BridgeJson.parse with an unescaped, unterminated string argument — syntactically invalid Java. No example contract has a json field, which is why the javac CI leg never caught it. The literal now carries doubled backslashes and emits a proper Java string literal, verified by evaluating the compiled literal and inspecting generated output.
- **rust-wire.ts**: comma-expression typo (a statement ending in a comma) evaluated the following statement via comma-operator accident; now a real statement, generated Rust unchanged.
- **generators.test.ts**: a require('node:fs') call replaced with the file's existing fs import.
- **bridge-registry-service.ts**: require('../audit') replaced with a static import (no import cycle — server.ts already imports audit.ts).
- **postgres/driver.ts**: empty interface extending Record became a type alias.
- **test/helpers.ts**: json narrowed to unknown where free; the remaining intentional looseness carries an explanatory eslint-disable comment (integration-test helper, per-test shape assertions).
- **cli tests**: no-regex-spaces became counted-quantifier regexes; three useless escape sequences removed (string content unchanged, regex meaning identical).

### Fixes #82 — git-history hygiene (informational, decision recorded)

The audit confirmed .env appears only in early history (commits 6fe2190, 52afc4e) with content DATABASE_URL=file:/home/z/my-project/db/custom.db — a local SQLite path, **no credentials, no tokens**. No token or key material exists anywhere in the worktree or history. Decision: **accept, no history rewrite** — rewriting would invalidate all SHAs and open PR references for zero security benefit. .gitignore at HEAD blocks .env, .env.*, *.pem, *.key, *.p12 and secrets/. This PR documents that decision on the issue for the security review trail.
`;

const res = await fetch(`https://api.github.com/repos/${REPO}/pulls`, {
  method: 'POST',
  headers: {
    Authorization: `token ${TOKEN}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'bridge-audit-bot',
  },
  body: JSON.stringify({
    title: 'fix: zero lint warnings across all packages, tighten gate to --max-warnings 0',
    head: 'fix/81-lint-zero',
    base: 'main',
    body,
  }),
});
const data = await res.json();
if (res.ok) console.log(`PR #${data.number} created: ${data.html_url}`);
else {
  console.error(`FAIL ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  process.exitCode = 1;
}
