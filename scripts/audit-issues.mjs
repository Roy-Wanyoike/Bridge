#!/usr/bin/env node
// scripts/audit-issues.mjs — create GitHub issues for the 0.2.0 post-release audit findings
const TOKEN = process.env.GH_TOKEN;
const REPO = 'Roy-Wanyoike/bridge';
const API = `https://api.github.com/repos/${REPO}/issues`;

const issues = [
  {
    title: '[dashboard][blocker] Demo mode is the production default — fabricated data served when env is forgotten',
    labels: ['bug', 'dashboard', 'blocker', 'production-readiness'],
    body: `## Problem

The dashboard defaults to **demo mode in production builds**. \`src/lib/demo-data.ts\` exports \`DEMO_MODE_DEFAULT = true\`, and \`src/lib/registry-client.ts\` uses it when \`NEXT_PUBLIC_DEMO_MODE\` is unset. A \`npm run build && npm start\` deployment that forgets the env var serves an **invented acme/globex registry** — fake payments v3 BREAKING verdicts, fake publishers, fake hashes — as if it were real registry state.

For a product whose core promise is contract trust and honesty, this is a data-honesty trap. The demo-mode warning banner covers "garbled values", but not "prod build, env forgotten".

## Expected behavior

- Live mode is the production default (\`DEMO_MODE_DEFAULT = false\`).
- Demo remains the default **only for development** (\`next dev\`), so the out-of-the-box demo experience is preserved for developers cloning the repo.
- When a production build starts without \`NEXT_PUBLIC_REGISTRY_URL\` set (i.e. live mode is unusable), surface a loud, honest configuration error rather than silently falling back to demo data.

## Acceptance criteria

- [ ] Production build with no env vars set: shows an actionable configuration error, never fabricated data
- [ ] \`next dev\` with no env vars: demo mode works as before
- [ ] \`NEXT_PUBLIC_DEMO_MODE=false\` + registry URL: live mode works as before
- [ ] README updated to describe the new behavior`,
  },
  {
    title: '[dashboard] Demo-mode disclosure invisible on mobile — fabricated data shown with zero indication below 1024px',
    labels: ['bug', 'dashboard', 'ux'],
    body: `## Problem

The sidebar (which carries the "Demo mode" card) is \`hidden lg:flex\` (\`src/components/app-shell.tsx\` ~line 137), and the DEMO chip in the sidebar footer is also hidden below \`lg\` (~line 174). On viewports < 1024px a mobile user sees **fabricated registry data with zero disclosure**.

## Expected behavior

A compact DEMO/LIVE indicator is rendered in the mobile header row (\`lg:hidden\`), visible on every route, so demo data is always disclosed.

## Acceptance criteria

- [ ] On a 375px viewport, every page shows a visible DEMO (or LIVE) badge
- [ ] The badge links to (or explains) demo mode the same way the sidebar card does`,
  },
  {
    title: '[dashboard] error.tsx RegistryError branch is dead code — error identity is lost across the RSC serialization boundary',
    labels: ['bug', 'dashboard', 'correctness'],
    body: `## Problem

\`src/app/error.tsx\` (~line 25) checks \`error instanceof RegistryError\` to render the tailored "Could not reach the registry — check NEXT_PUBLIC_REGISTRY_URL" copy. But all data fetching happens in **server components**; Next.js serializes server-thrown errors to plain objects before they reach the client error boundary, so \`instanceof\` is never true. The tailored branch can never render — users get the generic message precisely when the tailored one matters most.

## Fix direction

Encode the failure kind into the thrown error's message server-side (e.g. \`throw new Error("RegistryUnreachable: ...")\`) and sniff a stable prefix in the boundary — or route reachability state through data instead of error identity.

## Acceptance criteria

- [ ] Stopping the registry service and loading a contracts page renders the "registry unreachable + remediation" message, in production builds
- [ ] A unit test (or a scriptable check) pins this behavior`,
  },
  {
    title: '[dashboard] Data-layer performance: N−1 sequential diff fetches, unbounded overview fan-out, sequential graph fetches',
    labels: ['bug', 'dashboard', 'performance'],
    body: `## Problem

Three fetch-pattern defects that will time out or hammer a real registry at scale:

1. **N−1 sequential round-trips** — \`contracts/[org]/[project]/[contract]/page.tsx\` (~65-76) awaits each adjacent-pair \`getDiff\` inside the loop. 20 versions ⇒ 19 serial requests (10s timeout each) before first paint. Fix: \`Promise.all\` over the pairs (the overview already does this correctly).
2. **Unbounded concurrent fan-out** — \`RestRegistryClient.getOverview\` (\`registry-client.ts\` ~256-270) issues \`listVersions\`+\`getDiff\` for every non-SAFE contract via one \`Promise.all\` with no cap. Large registry ⇒ hundreds of simultaneous fetches per page view. Fix: bounded batches (8-10).
3. **Sequential graph fetches** — \`graph/page.tsx\` (~31-42) awaits \`getGraph\` → \`listAllContracts\` → \`listOrgs\` serially; independent — use \`Promise.all\`. Related: \`audit/page.tsx\` fetches the entire unfiltered trail to derive an actor dropdown — page/limit it.

## Acceptance criteria

- [ ] Diff history for a 20-version contract loads in one batched round
- [ ] Overview fan-out is capped (no more than ~10 in flight)
- [ ] Graph page fetches are parallel`,
  },
  {
    title: '[dashboard] URL/param correctness: unencoded route segments in registry-client + breadcrumbs; silent substitution of bad diff params',
    labels: ['bug', 'dashboard', 'correctness'],
    body: `## Problem

1. \`RestRegistryClient\` interpolates org/project/version into path segments **unencoded** (\`registry-client.ts\` ~165, 175, 186, 201, 213). Any identifier containing \`/\`, \`?\`, \`#\` or non-ASCII silently breaks the request. Fix: \`encodeURIComponent\` every segment (\`DiffVersionPicker.tsx\` already does this).
2. Breadcrumbs on the contract detail page (~88, 92) build hrefs from raw params — same fix.
3. \`diff/page.tsx\` (~78-86) silently substitutes invalid \`from\`/\`to\` query values: a shared deep link with a stale version renders a **different** diff with no indication. Fix: 404 when an explicitly-provided version doesn't exist.

## Acceptance criteria

- [ ] An org named \`a/b\` (or any param with special chars) round-trips through client + links
- [ ] A deep link with an unknown \`from\`/\`to\` returns 404, not a different diff`,
  },
  {
    title: '[dashboard] Trust & correctness batch: derived objectCount metric, lexicographic attention ordering, zero-versions edge, scope switcher off /contracts, registry port mismatch',
    labels: ['bug', 'dashboard', 'correctness'],
    body: `## Problem — six trust-eroding defects

1. **"objects in the store" is a derived duplicate** — \`registry-client.ts\` (~309) sets \`objectCount = Σ versionCount\`; the home page (~90) renders it as an independent metric. Two labels, one number. Fix: drop it or make it a real store metric.
2. **Attention list is semver-unaware in live mode** — sorted lexicographically by \`to\` (\`0.10.0\` before \`0.9.0\`); demo sorts by publish time. Fix: sort by target version \`publishedAt\` in the REST client.
3. **Zero-versions contract edge** — \`contract/page.tsx\` (~58) falls back to \`getVersion(…, 'v1')\` (fabricated string) and the Versions tab renders a bare empty \`<ol>\`. Fix: proper empty state + skip the call.
4. **Scope switcher misbehaves off /contracts** — on \`/graph\`/\`/audit\` the header select shows "All orgs" regardless of the page's own \`?org=\`, and changing it teleports to \`/contracts\`. Also the project dropdown on \`/contracts\` lists projects from all orgs. Fix: scope project options to the selected org; make the switcher reflect each page's scope param.
5. **Default live registry port is wrong** — \`registry-client.ts\` (~52) defaults \`NEXT_PUBLIC_REGISTRY_URL\` to \`:8080\`, but the registry service binds **4350** (README says so). Enabling live mode without the env var silently targets the wrong port. Fix: default to 4350.
6. **Repository line looks clickable but isn't** — \`ExternalLink\` icon + no anchor (~117-122); demo values lack protocol. Fix: link when it looks like a URL, plain text otherwise. README drift: \`/v1/search\` documented but never called by the client.`,
  },
  {
    title: '[dashboard][a11y] Accessibility hardening: dialog background inert, tabpanel focus, color-only verdicts, title-only abbreviations, reduced motion, skip link',
    labels: ['accessibility', 'dashboard'],
    body: `## Problem — WCAG gaps from the UI audit

1. **Dialog** (\`ui/dialog.tsx\` ~96-110): focus trap + Escape work, but background content is not \`inert\`/\`aria-hidden\` — screen-reader virtual cursors browse behind the modal. Fix: set \`inert\` on the app root while open.
2. **Tabpanel** (\`ui/tabs.tsx\` ~132): \`focus-visible:outline-none\` on a \`tabIndex={0}\` panel removes the only focus indicator (WCAG 2.4.7). Fix: subtle \`focus-visible:ring-1\`.
3. **Graph verdicts are color-only** (\`compat-graph.tsx\` ~163,169): node aria-label lacks the verdict; the ring color has no text alternative. Fix: append "latest diff verdict: X" to each node's aria-label.
4. **Language badges** (\`language-badges.tsx\` ~29-32): "TS/GO/RS/PY" rely on \`title\` (unreliable on touch/SR). Fix: \`aria-label\` with full language names.
5. **No \`prefers-reduced-motion\` guard** for skeletons/transitions in globals.css.
6. **No skip-to-content link** before the nav.
7. Heading levels jump h1→h3 via CardTitle directly under page h1s.
8. \`role="presentation"\` on the error message (\`error.tsx\` ~39) is a no-op oddity; \`ChangeRow\` key \`\\\`\\\${path}-\\\${kind}\\\`\` can collide on real data (\`diff/page.tsx\` ~199).`,
  },
  {
    title: '[registry-service] Lint debt: 13 warnings (require() imports, no-explicit-any, empty-object-type) — CI lint gate has headroom, zero it out',
    labels: ['tech-debt', 'registry-service', 'code-quality'],
    body: `## Problem

\`npm run lint\` reports **13 warnings, 0 errors** — all in \`bridge-registry-service\`:

- \`no-require-imports\` (~4× in \`src/bin/bridge-registry-service.ts\`, \`src/storage/postgres/driver.ts\`)
- \`no-explicit-any\` (~7×, incl. \`src/test/helpers.ts\` 106/121)
- \`no-empty-object-type\` (\`src/storage/postgres/driver.ts\` ~38)

The root lint script allows \`--max-warnings 25\`. Warnings left open invite more. Fix the warning sites honestly (real types / ESM imports / named interface) rather than relaxing the rule set, then tighten \`--max-warnings\` (target 0 or document why not).

## Acceptance criteria

- [ ] \`npm run lint\` reports 0 warnings
- [ ] \`--max-warnings\` tightened accordingly
- [ ] No \`eslint-disable\` without an explanatory comment`,
  },
  {
    title: '[repo] Git-history hygiene: .env present in early history (content harmless — local SQLite path only)',
    labels: ['tech-debt', 'security'],
    body: `## Finding (informational, low severity)

\`.env\` was committed in early history (commits \`6fe2190\` "Initial commit", \`52afc4e\` "scaffold Bridge monorepo") and later removed. Full-history scan confirms the file contained **only** \`DATABASE_URL=file:/home/z/my-project/db/custom.db\` — a local SQLite path, **no credentials, no tokens**. No \`ghp_\`/API-key material exists anywhere in worktree or history.

## Options

- **Accept** (recommended): no secret material ⇒ no rotation risk; history rewrite would invalidate all commit SHAs and existing clones/PR references.
- If the project ever gains external contributors who care about clean history, scrub with \`git filter-repo --path .env --invert-paths\` in a coordinated rewrite. Not worth the churn today.

## Guard rail already in place

\`.gitignore\` blocks \`.env\`, \`.env.*\`, \`*.pem\`, \`*.key\`, \`*.p12\`, \`secrets/\` — verified current HEAD.

This issue exists to document the finding and the decision for the security review trail.`,
  },
];

const GH = {
  method: 'POST',
  headers: {
    Authorization: `token ${TOKEN}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'bridge-audit-bot',
  },
};

let n = 0;
for (const iss of issues) {
  const res = await fetch(API, { ...GH, body: JSON.stringify(iss) });
  const data = await res.json();
  if (res.ok) {
    n++;
    console.log(`#${data.number} created: ${iss.title.slice(0, 70)}`);
  } else {
    console.error(`FAIL ${res.status}: ${iss.title.slice(0, 50)} → ${JSON.stringify(data).slice(0, 200)}`);
    process.exitCode = 1;
  }
}
console.log(`\n${n}/${issues.length} issues created`);
