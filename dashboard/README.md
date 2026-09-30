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

The dashboard boots in **demo mode** by default under `next dev`: it renders a
realistic seeded dataset derived from the example contracts
(`examples/*.bridge`), including deliberate breaking-change scenarios, so the
UI is fully browsable with zero backend. Production builds default to **live**
mode instead (see the environment table below for the exact switch logic).

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
`/v1/search` endpoint is a CLI affordance, not used here). Audit reads pass a
`limit` filter (see `AuditFilters` in `src/lib/types.ts`): the service clamps
it server-side, applies its own default of 100 when the filter is absent, and
returns entries newest → oldest; the console reads at most `AUDIT_FETCH_LIMIT`
(500) newest entries per render.

## Deployment boundary

In live mode the console holds a **server-side admin-role `REGISTRY_TOKEN`
(registry admin, not infra admin)** — that is the credential behind every
page, including `/v1/audit`. The Next.js server keeps the token out of the
browser bundle, but the app itself has **no user authentication**: anyone who
can reach the console's HTTP port can browse every org/project the deployment
declares, and the console performs the token-authenticated registry reads on
their behalf.

Therefore, when running live (especially with an admin token), one of the
following is **required**:

- run the console on a network-isolated segment (private network, VPN,
  cluster-internal ingress only), or
- put an authenticating reverse proxy / identity-aware gateway (SSO, mTLS,
  bastion) in front of it.

The security headers set in `next.config.ts` (no framing, `nosniff`, strict
referrer, no powerful browser features, no `X-Powered-By`) harden the browser
surface; they do not authenticate viewers. Demo mode carries no registry
credential and no real data, so the boundary applies to live deployments only.

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
| `NEXT_PUBLIC_DEMO_MODE` | unset → **demo in `next dev`, live in production builds** | Renders seeded demo data instead of calling the registry. Exact behavior (see `isDemoMode` in `src/lib/registry-client.ts`): unset or empty keeps the mode-dependent default — **demo under `next dev`, LIVE when `NODE_ENV=production`** (a production build never serves fabricated data just because an env var was forgotten). Exactly `false` / `0` forces live; exactly `true` / `1` forces demo. Any other value logs a warning and keeps the mode-dependent default — booleans are never coerced loosely (`FALSE` does **not** go live). |
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
