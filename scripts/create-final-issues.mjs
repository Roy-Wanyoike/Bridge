// Create the final-validation wave of issues (audit findings F1-F6).
// One coherent unit of work per issue, structured per policy.
const REPO = 'Roy-Wanyoike/bridge';

const issues = [
  {
    title: 'fix(ci): restore broken push/pull_request branch filter ("ain]" instead of "[main]")',
    labels: ['ci', 'bug'],
    body: `## Problem
The CI workflow's trigger filters are corrupted:

\`\`\`yaml
on:
  push:
    branches: ain]
  pull_request:
    branches: ain]
\`\`\`

The literal value \`ain]\` never matches \`main\`, so **pushes to \`main\` never trigger CI**. The merge commit of PR #85 (6924590) has **zero check runs**. The corruption has been present since the scaffold commit (52afc4e).

## Context
Every PR-branch run between Sep 4 and Sep 9 also shows all 9 jobs failing in ~2s with no steps executed — that is the separate account-level Actions billing lock (see README/RELEASE.md). But once billing is unblocked, pushes to main still would not trigger CI at all because of this filter, so merged work would remain unverified.

## Current Behavior
- \`git push\` to \`main\` → no CI run (0 check runs on HEAD).
- Only PR events happened to run, and those failed on the billing lock.

## Expected Behavior
- \`branches: [main]\` on both \`push\` and \`pull_request\`.
- Pushes to main and PRs targeting main trigger the CI workflow.

## Scope
- \`.github/workflows/ci.yml\` trigger block only.

## Out of Scope
- Job definitions, toolchain versions, the billing lock itself (owner-side action).

## Acceptance Criteria
- [ ] \`push.branches\` and \`pull_request.branches\` are exactly \`[main]\`.
- [ ] The changed file parses as valid YAML.
- [ ] A push to main triggers a CI run once the Actions billing lock is lifted (owner-side prerequisite, tracked separately).

## Validation Requirements
- YAML parse check locally.
- Post-merge: confirm a run appears for the merge commit (requires billing lift).

## Dependencies
None. Independent of all other open work.

## Definition of Done
PR merged to main with the corrected filter; post-merge verification confirms the workflow file on main is correct.`,
  },
  {
    title: 'fix(e2e): make e2e-gate.sh self-contained — build the release binary instead of assuming it',
    labels: ['testing', 'bug'],
    body: `## Problem
Steps 24–25 of \`scripts/e2e-gate.sh\` run \`./dist/release/bridge-v0.2.1-linux-amd64\` but the gate never builds that binary. On a fresh clone (or any clean checkout) the gate **fails 2 of 25 steps** even when the whole workspace is green: build ✓, 684/684 tests ✓, lint ✓.

## Context
The gate is the project's end-to-end acceptance run (documented in README and RELEASE.md). A gate that fails on a clean environment produces false negatives and trains people to ignore red. The release-rehearsal script builds the binary, but running rehearsal first is not documented as a gate prerequisite.

## Current Behavior
- \`bash scripts/e2e-gate.sh\` on a clean checkout → FAIL 24 "release binary runs", FAIL 25 "release binary validates" (binary missing).
- After manually running \`bun scripts/package-release.mjs --current-only\` → 25/25 PASS (verified).

## Expected Behavior
- The gate builds the current-platform release binary itself when it is missing.
- If \`bun\` is not installed, the release-binary steps are reported as SKIP with an actionable message (consistent with verify-*.sh skip semantics, exit 77), not a bare FAIL.

## Scope
- \`scripts/e2e-gate.sh\` steps 24–25 only.

## Out of Scope
- The release workflow (\`.github/workflows/release.yml\`), packaging targets, checksums.

## Acceptance Criteria
- [ ] On a clean checkout with bun installed, the gate reaches 25/25 PASS with no manual pre-step.
- [ ] Without bun, steps 24–25 report SKIP (or gate fails only with STRICT_SKIP=1), never a misleading FAIL.
- [ ] The binary used matches the current workspace version (no stale-binary false positives — rebuild when missing, run when present).

## Validation Requirements
- Run the gate twice: once on a clean tree (binary absent) and once with the binary prebuilt; both must be green.
- Runtime validation: gate output printed and reviewed.

## Dependencies
None.

## Definition of Done
PR merged; clean-checkout gate run and prebuilt gate run both verified green.`,
  },
  {
    title: 'chore(repo): remove committed AI/agent development artifacts from scripts/',
    labels: ['repo-hygiene'],
    body: `## Problem
Sixteen agent-workflow files and one stale verifier are committed under \`scripts/\`:

- \`create-issues.mjs\`, \`audit-issues.mjs\`, \`create-labels.sh\` — one-off GitHub-issue/label bootstrapping used during the audit wave
- \`create-pr-41.mjs\`, \`create-pr-42.mjs\`, \`create-pr-49.mjs\`, \`create-pr-50.mjs\`, \`create-pr-51.mjs\`, \`create-pr-wave1.mjs\`, \`create-pr-wave2.mjs\`, \`create-pr-wave3.mjs\` — per-PR body/upload scripts tied to already-merged PRs
- \`issues-data-1.mjs\`, \`issues-data-2.mjs\` — issue-content dumps for the above
- \`pr-body-49.md\`, \`pr-body-50.md\`, \`pr-body-51.md\`, \`pr45-body.md\` — PR body drafts for merged PRs
- \`verify-registry-client.mjs\` — "local evidence only, not committed" per its own header; it hardcodes \`/home/z/my-project/worktrees/dash-ui/dashboard\` (a deleted worktree) and crashes with \`spawnSync /bin/sh ENOENT\` as committed

## Context
The repository should contain only intentional product artifacts. These files are agent development plumbing: they reference merged PRs, deleted worktrees and one-off automation, and they make the repo look like an AI workspace. No tracked file references any of them (verified by cross-reference grep).

## Current Behavior
\`git ls-files scripts/\` lists all of the above; \`node scripts/verify-registry-client.mjs\` crashes.

## Expected Behavior
\`scripts/\` contains only durable, runnable tooling: generators, verifiers, e2e gate, packaging, release rehearsal, fixture/round-trip helpers.

## Scope
Delete the 17 files listed above. Nothing else changes.

## Out of Scope
- \`generate-all.mjs\`, \`generate-ffi.mjs\`, \`package-release.mjs\`, \`release-rehearsal.sh\`, \`e2e-gate.sh\`, all \`verify-*.sh\`, \`verify-demo-links.mjs\`, \`python_roundtrip.py\`, \`requirements-serialization.txt\` — these are durable and stay.

## Acceptance Criteria
- [ ] All 17 files are gone from the repo.
- [ ] No tracked file references them (verified).
- [ ] Full regression still green: build, 684 tests, lint, dashboard build, e2e gate 25/25.

## Validation Requirements
- \`git grep\` cross-reference check post-removal.
- Full local regression after removal.

## Dependencies
None.

## Definition of Done
PR merged; scripts/ contains only durable tooling; regression green.`,
  },
  {
    title: 'fix(cli): reject URL-shaped --registry values instead of silently writing a bogus directory',
    labels: ['bug', 'cli'],
    body: `## Problem
\`bridge publish payments.bridge --registry http://127.0.0.1:4400\` prints "✓ published payments.v1@v1" and **writes the contract into a filesystem directory literally named \`http:/127.0.0.1:4400\`** under the current working directory. The success message is a lie: nothing was published to any registry service.

## Context
Bridge ships a multi-tenant HTTP registry service with a full REST API (publish/versions/inspect/pull/search). A user pointing the CLI at a running service (the most natural reading of \`--registry http://…\`) gets silent filesystem corruption instead of an error or a publish. Verified twice against a live service on localhost. This also left untracked junk (\`examples/payments/http:/\`) inside a tracked directory during testing.

## Current Behavior
\`registryDir()\` (\`packages/bridge-cli/src/registry-cli.ts\`) returns the raw \`--registry\` value; the filesystem store then \`mkdir\`s it as a path.

## Expected Behavior
Values starting with \`http://\` or \`https://\` are rejected by every registry command (publish/pull/versions/inspect/search/check/impact) with an actionable error explaining that the CLI registry is filesystem-backed and where HTTP registry support is tracked. Fail-fast, no partial writes.

## Scope
- \`packages/bridge-cli/src/registry-cli.ts\` (shared \`registryDir()\` — one chokepoint).
- Tests covering URL rejection for at least publish, pull, versions, inspect, search.

## Out of Scope
- HTTP registry support in the CLI (tracked as a separate feature issue).
- Registry service or dashboard changes.

## Acceptance Criteria
- [ ] \`--registry http://…\` / \`https://…\` exits non-zero with a clear message on all registry commands.
- [ ] \`BRIDGE_REGISTRY=http://…\` environment form is rejected the same way.
- [ ] No directory is created in any rejection case.
- [ ] Filesystem registry behavior is unchanged (existing tests pass).
- [ ] New unit tests cover the rejection path per command.

## Validation Requirements
- Unit tests (mock-free; pure argument handling).
- Runtime validation against a live service: CLI must fail loudly, service untouched.

## Dependencies
None.

## Definition of Done
PR merged; rejection verified on all registry commands; regression green.`,
  },
  {
    title: 'feat(cli): publish/pull/versions/inspect/search against HTTP registry services',
    labels: ['feature', 'cli'],
    body: `## Problem
The registry service exposes a complete REST API (POST publish, GET pull/latest, GET versions, GET list, GET search — all authenticated, tenant-scoped, rate-limited), and the dashboard consumes it in live mode. But **no first-party CLI path can write to it**: the CLI's \`--registry\` is filesystem-only. The canonical user journey — *publish from CLI → view in the dashboard's live mode* — is impossible today.

## Context
Today the only publisher is in-process test helpers. This closes the loop between the three shipped surfaces (CLI ⇄ registry service ⇄ dashboard) and makes the service usable for its stated purpose: onboarding real users.

## Current Behavior
CLI registry commands only accept a filesystem root; URL values are silently mishandled (see the companion bug fix that rejects them).

## Expected Behavior
Every registry command transparently supports HTTP(S) registries:

\`\`\`
bridge publish payments.bridge --registry https://registry.example.com --org acme --project payments --token <tok>
bridge versions payments.v1 --registry https://registry.example.com --org acme --project payments --token <tok>
bridge inspect payments.v1 --registry https://... --org acme --project payments --token <tok>
bridge search payment --registry https://... --org acme --token <tok>
bridge pull payments.v1 --version v2 --registry https://... --org acme --project payments --token <tok>
\`\`\`

- Token via \`--token\` or \`BRIDGE_TOKEN\` env; never logged.
- Publish maps the CLI's IR + metadata (owner, description, version, hash) onto the service's publish body contract (verified against \`server.ts\`: \`packageName\`, \`ir\`, \`version\`, owner/description, content-hash assertion).
- Responses are mapped to the same CLI output as the filesystem path; server errors (401/403/404/409/412/429/500) produce the existing friendly \`registryCliError\` hints where applicable.
- Timeouts and connection failures fail loudly with a typed error (consistent with the dashboard client's behavior).

## Scope
- New HTTP transport in the CLI (\`packages/bridge-cli/src/\`), reusing \`@bridge/registry\` types where practical.
- \`registryDir()\` evolves into a registry-target resolver (filesystem root vs remote).
- Unit tests with a mocked \`fetch\` (success, 401, 404, 409 immutable, 429, network failure, timeout).
- Integration test: boots the real registry service in-memory on localhost (same pattern as \`registry-service\` tests), publishes a real compiled example over HTTP, then versions/inspect/pull/search round-trips.

## Out of Scope
- Signing headers (the service already accepts unsigned publishes in optional mode; signed publish is a follow-up).
- Dashboard or service API changes.

## Acceptance Criteria
- [ ] All five commands work against a live in-memory service on localhost (integration test asserts it).
- [ ] Publish over HTTP then pull from a different process returns byte-identical IR.
- [ ] Auth failures surface as actionable CLI errors without leaking the token.
- [ ] \`--registry\` remains backwards-compatible for filesystem roots.
- [ ] Unit tests cover mocked success and failure paths.
- [ ] Documentation updated (README quick start + command help text).

## Validation Requirements
- Unit + integration tests as above.
- Runtime validation: live service + CLI publish + live-mode dashboard render (browser-checked).

## Dependencies
Requires the URL-rejection bug fix to land first (this feature replaces the rejection with real support for registry commands; the rejection remains for any non-registry URL consumer if applicable).

## Definition of Done
PR merged with tests + docs; live end-to-end publish → dashboard verified in the running application.`,
  },
  {
    title: 'docs(readme): sync test counts (669 → 684), version era (0.2.0 → 0.2.1) and registry workflow',
    labels: ['documentation'],
    body: `## Problem
The README's Status section is stale:
- Says "**669 tests green across nine packages (CLI 98, compat 101, core 154, FFI 10, generators 18, LSP 33, registry 65, registry-service 78, serialization 112)**" — actual current counts are **684 total (FFI 11, generators 32; others unchanged)**, verified by running the suite.
- Headline says "Bridge 0.2.0" while the workspace version is 0.2.1 (version lockstep merged in PR #86).
- The registry section does not mention the CLI↔HTTP-registry workflow once CLI HTTP support ships.

## Context
Recruiters and external reviewers rely on the README as the first source of truth; numbers that disagree with the actual suite undermine the honest-claims standard the project holds itself to.

## Current Behavior
Stale counts and version strings in README.md.

## Expected Behavior
README states the current, verified numbers and the current version; the registry workflow reflects the shipped CLI capability after the CLI HTTP feature lands.

## Scope
README.md only (plus command help text if the CLI feature changes usage strings — that belongs to the CLI PR).

## Out of Scope
docs/*.md deep content (verified current in the 0.2.0 docs-sync PR).

## Acceptance Criteria
- [ ] Test totals and per-package counts match a fresh \`npm test\` run.
- [ ] Version references match the workspace version.
- [ ] Any README command block runs successfully as written.

## Validation Requirements
- Run \`npm test\` and compare counts immediately before merging.
- Execute the README quick-start commands in a scratch directory.

## Dependencies
Should land after the CLI HTTP registry feature (its counts/workflow text depends on what ships).

## Definition of Done
PR merged; README numbers re-verified against the final merged tree.`,
  },
];

const created = [];
for (const i of issues) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/issues`, {
    method: 'POST',
    headers: {
      authorization: `token ${process.env.GH_TOKEN}`,
      'content-type': 'application/json',
      accept: 'application/vnd.github+json',
    },
    body: JSON.stringify({ title: i.title, body: i.body, labels: i.labels }),
  });
  const j = await res.json();
  if (j.number) {
    created.push({ n: j.number, t: i.title });
    console.log(`#${j.number} ${i.title}`);
  } else {
    console.error(`FAILED: ${i.title} ->`, JSON.stringify(j).slice(0, 200));
    process.exit(1);
  }
}
console.log(JSON.stringify(created));
