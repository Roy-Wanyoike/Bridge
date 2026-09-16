# Bridge Dashboard

The web console for the Bridge contract registry: browse contracts and their
published versions, inspect consumers and producers, read compatibility
reports between any two versions, explore the dependency graph and follow the
audit log.

Next.js (App Router) + TypeScript + Tailwind CSS + shadcn-style components.

## Quickstart

```bash
cd dashboard
npm install
npm run dev          # http://localhost:3000 — demo mode, no backend needed
```

The dashboard boots in **demo mode** by default: it renders a realistic
seeded dataset derived from the example contracts (`examples/*.bridge`),
including deliberate breaking-change scenarios, so the UI is fully browsable
with zero backend.

## Going live

Point it at a running registry service (see
`packages/bridge-registry-service`):

```bash
NEXT_PUBLIC_DEMO_MODE=false \
NEXT_PUBLIC_REGISTRY_URL=http://localhost:4350 \
npm run dev
```

The REST client (`src/lib/registry-client.ts`) targets the service API:
`/v1/orgs/{org}/projects/{project}/contracts...`, `/v1/graph`, `/v1/audit`.
Search across contracts is derived client-side from the list endpoints
(the registry's `/v1/search` endpoint is a CLI affordance, not used here).

## Routes

| Route | Shows |
|-------|-------|
| `/` | Overview: totals, recent publishes, recent breaking changes |
| `/contracts` | Searchable contract list with consumer counts + language coverage |
| `/contracts/[org]/[project]/[contract]` | Version timeline, consumers/producers, publish metadata, pull command |
| `/contracts/[org]/[project]/[contract]/diff?from=&to=` | Compatibility report (SAFE/WARNING/BREAKING change list) |
| `/graph` | Dependency graph (pure SVG, deterministic layered layout) |
| `/audit` | Audit log with filters |

## Environment

| Variable | Default | Meaning |
|----------|---------|---------|
| `NEXT_PUBLIC_DEMO_MODE` | `true` | Render seeded demo data instead of calling the registry. Only the exact values `false` / `0` enable live mode; any other value keeps demo mode on and logs a warning (booleans are not loosely coerced — `FALSE` does **not** go live) |
| `NEXT_PUBLIC_REGISTRY_URL` | `http://localhost:8080` | Registry service base URL (live mode). Note the service itself binds **4350** by default — set `NEXT_PUBLIC_REGISTRY_URL=http://localhost:4350` when running `@bridge/registry-service` with defaults |
| `NEXT_PUBLIC_CONSOLE_URL` | `http://localhost:3000` | Console's own origin, used as the metadata/OG canonical base |

## Theme

The console is **intentionally dark-only** — one professional developer-infra
theme (`#0a0a0c` base, dark browser chrome via `themeColor`/`colorScheme`),
matching the CLI and docs aesthetic. There is no light theme and no toggle;
contrast is tuned for WCAG 2.1 AA against the dark background.

## Scripts

- `npm run dev` — dev server
- `npm run build` / `npm run start` — production build + serve
- `npm run lint` — ESLint
- `npm run typecheck` — `tsc --noEmit`
