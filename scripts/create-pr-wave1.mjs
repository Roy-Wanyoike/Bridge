#!/usr/bin/env node
// create-pr-wave1.mjs — Wave 1 PR: dashboard production-readiness fixes
const TOKEN = process.env.GH_TOKEN;
const REPO = 'Roy-Wanyoike/bridge';

const body = `## Wave 1 — dashboard production-readiness (audit findings)

Closes the blocker and all major findings from the post-0.2.0 full-stack audit (backend → frontend → UI). Every fix was verified locally: \`tsc --noEmit\` clean, \`eslint\` 0 errors, \`next build\` clean, plus two live functional checks:

- **Prod build with no env vars** → renders the honest "Could not reach the registry" boundary; server log shows \`RegistryMisconfigured: live mode is enabled but NEXT_PUBLIC_REGISTRY_URL is not set...\`. No fabricated data.
- **Prod build with \`NEXT_PUBLIC_DEMO_MODE=true\`** → demo registry renders, DEMO disclosure visible (header chip + sidebar card).

### Fixes #74 — demo mode is the production default (BLOCKER)
- \`DEMO_MODE_DEFAULT = false\`: production builds start LIVE.
- \`next dev\` keeps demo as the zero-setup default (\`NODE_ENV\` check) so clone-and-browse DX is unchanged.
- Live mode with no \`NEXT_PUBLIC_REGISTRY_URL\` throws an actionable \`RegistryMisconfigured\` error — never a silent demo fallback.

### Fixes #75 — demo disclosure invisible on mobile
- Compact DEMO/LIVE chip in the mobile header row (\`lg:hidden\`), visible on every route below 1024px, warning-colored in demo mode.

### Fixes #76 — dead \`instanceof RegistryError\` branch in error.tsx
- Server components serialize errors across the RSC boundary; identity is lost, so the tailored copy could never render.
- The data layer now throws with stable \`RegistryUnreachable:\` / \`RegistryMisconfigured:\` message prefixes; the boundary sniffs them and renders the tailored copy + remediation in production.

### Fixes #77 — data-layer performance at real scale
- Contract detail: version detail + consumers + **all adjacent-pair diffs** in one \`Promise.all\` round (was N−1 serial round-trips).
- \`RestRegistryClient.getOverview\`: bounded worker-pool fan-out (8 in flight) instead of unbounded \`Promise.all\` per candidate.
- Graph page: graph + contracts + orgs fetched in parallel.
- Audit page: action/actor filters applied **server-side** (API-supported), actor dropdown fetched in parallel; contract substring filter stays client-side (API has no contains).

### Fixes #78 — URL/param correctness
- \`encodeURIComponent\` on every registry path segment in \`RestRegistryClient\` (listContracts/listAllProjects/getContract/listVersions/getVersion/listConsumers/getDiff) and on every data-built href (breadcrumbs, graph/audit/consumer/diff links, graph org tabs).
- Diff deep links with explicitly-unknown \`from\`/\`to\` now **404** instead of silently rendering a different diff than the link promised.

### In passing (partial #79 / #80, remainder follows in Wave 2)
- Attention list ordered by target version publish time (lexicographic sort put 0.10.0 before 0.9.0).
- Zero-versions contract: no fabricated \`'v1'\` fallback; honest empty state.
- \`ChangeRow\` list key collision (path+kind) fixed with an index component.
- No-op \`role="presentation"\` removed from the error boundary.
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
    title: 'fix(dashboard): live-by-default prod builds, honest error boundary, batched fetches, URL encoding',
    head: 'fix/74-dashboard-prod-readiness',
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
