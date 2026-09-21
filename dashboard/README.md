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
`packages/bridge-registry-service`). Live mode needs three configuration
values — the service fails closed without credentials, and it intentionally
exposes no cross-tenant discovery route, so the deployment declares the
org/project surface it serves:

```bash
# 1. run the service with an admin-role credential
bridge-registry-service --port 4350 \
  --token devsecret=acme:admin

# 2. run the dashboard in live mode
NEXT_PUBLIC_DEMO_MODE=false \
NEXT_PUBLIC_REGISTRY_URL=http://localhost:4350 \
REGISTRY_TOKEN=devsecret \
REGISTRY_ORGS="acme:payments,acme:commerce" \
npm run dev
```

| Variable | Meaning |
|----------|---------|
| `REGISTRY_TOKEN` | **Server-side only.** Bearer credential for every `/v1` read — the service rejects unauthenticated requests. Use an **admin**-role token so the Overview and Audit pages can read `/v1/audit` (read/write tokens cover the contract, graph and diff pages). Never prefixed with `NEXT_PUBLIC_` — it must not reach the browser bundle. |
| `REGISTRY_ORGS` | Org/project surface to render, as `org:project` pairs (`"acme:payments,acme:commerce"`). Every credential is bound to exactly one org; entries for other orgs render as genuinely not-found (the service answers 404, never leaking their existence). A bare org name without a project is a configuration error, not an empty page. |

In live mode a missing `NEXT_PUBLIC_REGISTRY_URL`, `REGISTRY_TOKEN` or
`REGISTRY_ORGS` throws an actionable `RegistryMisconfigured` error at
startup — the console never silently falls back to demo data, and never
serves a bare error digest where a hint belongs.

The REST client (`src/lib/registry-client.ts`) targets the service API:
`/v1/orgs/{org}/projects/{project}/contracts...`, `/v1/audit`. Search across
contracts is derived client-side from the list endpoints (the registry's
`/v1/search` endpoint is a CLI affordance, not used here).

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
| `NEXT_PUBLIC_REGISTRY_URL` | `http://localhost:4350` | Registry service base URL (live mode) — matches the service's default port |
| `REGISTRY_TOKEN` | — | **Server-side** bearer token for live mode (admin role for the audit page). Required; never sent to the browser |
| `REGISTRY_ORGS` | — | Org/project discovery for live mode, e.g. `acme:payments,acme:commerce`. Required — the service exposes no cross-tenant listing by design |
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
