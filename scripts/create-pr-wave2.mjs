#!/usr/bin/env node
// create-pr-wave2.mjs — Wave 2 PR: dashboard trust batch + a11y hardening
const TOKEN = process.env.GH_TOKEN;
const REPO = 'Roy-Wanyoike/bridge';

const body = `## Wave 2 — dashboard trust/correctness batch + accessibility hardening (audit findings)

Second wave of the post-0.2.0 audit fixes. Wave 1 (#83) closed the blocker + majors; this closes the remaining dashboard findings. Verified locally: \`tsc --noEmit\` clean, \`eslint\` 0 errors, \`next build\` clean, live smoke test of \`/\`, \`/contracts\`, \`/graph\`, \`/audit\` and a contract detail page in demo mode (all HTTP 200, skip link + DEMO disclosure present).

### Fixes #79 — trust & correctness (remaining items)
- **Fabricated metric removed**: "objects in the store" was a duplicate of the Versions count rendered as an independent stat. \`OverviewData.objectCount\` is gone from the REST client, demo dataset and types.
- **Scope switcher discipline**: the header switcher now renders only on \`/contracts\` routes. On \`/graph\` and \`/audit\` it showed "All orgs" regardless of the page's own \`?org=\` and teleported to \`/contracts\` on change (\`/graph\` keeps its own org tabs).
- **Org-scoped project dropdown**: project options on \`/contracts\` follow the selected org — org+project mismatches no longer silently yield empty results.
- **Repository link**: rendered as a real anchor when the value looks like a URL; the ExternalLink icon no longer labels a dead element.
- **Demo severity honesty**: depth-2 consumers no longer fabricate WARNING when the adjacent verdict is SAFE (inflated "affected" counts, demo-only distortion of the impact model).
- **Diagnosable layout**: the orgs-load failure in the root layout is logged (was silently swallowed); production deployments missing \`NEXT_PUBLIC_CONSOLE_URL\` get a loud warning that canonical/OG URLs point at localhost.
- **README sync**: \`/v1/search\` described as a CLI affordance; the client's actual list-endpoint fan-out documented.

### Fixes #80 — accessibility hardening
- **Dialog**: app root set \`inert\` while open — keyboard focus was trapped, but screen-reader virtual cursors could still browse/activate background content.
- **Tabpanel**: visible focus indicator kept (WCAG 2.4.7) — was \`focus-visible:outline-none\` on a focusable panel.
- **Graph nodes**: accessible name now includes "latest diff verdict: X" — verdict was color-only per node.
- **Language badges**: \`aria-label\` with the full language name (TS/GO/RS/PY relied on \`title\` only — unreliable on touch and in SR announcement).
- **Reduced motion**: \`prefers-reduced-motion\` guard collapses skeleton pulses/transitions.
- **Skip link**: first tab stop, visible on focus, targets \`#main-content\`.
- **Heading order**: CardTitle renders \`h2\` — no skipped h1→h3 levels.
- **Dead code removed** (each verified unused): \`DemoRegistryClient.publishers\`, \`RegistryClientWithHelpers\`, \`Separator\` (skeleton.tsx), \`CardFooter\`, \`EmptyState\`'s unused \`action\` prop.
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
    title: 'fix(dashboard): trust & correctness batch + accessibility hardening',
    head: 'fix/79-dashboard-trust-a11y',
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
