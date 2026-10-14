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
browser bundle, but the pages themselves were — until issue #163 — open to
anyone who could reach the console's HTTP port.

The console therefore ships with a **built-in OIDC login gate**
(`src/proxy.ts` + `src/lib/auth/`, issue #163):

- every console route requires a valid session — unauthenticated requests
  are redirected to `/login` (302, carrying a same-origin `returnTo`);
- sign-in is a standard **OIDC authorization-code + PKCE** flow against any
  conformant provider (Okta, Auth0, Entra ID, Keycloak, Google Workspace,
  Dex…), configured by discovery — no hardcoded provider URLs;
- the session is a **signed, httpOnly, SameSite=Lax cookie**
  (`bridge_console_session`, HMAC-SHA256 via WebCrypto, short-lived by
  default at 8h); tampered or expired cookies are simply treated as
  signed-out, never as errors;
- `/logout` clears the session; failed round-trips land on `/login` with a
  human-readable explanation (state mismatch, provider error, expired token
  — never a bare error digest);
- the gate verifies only the session cookie — it never touches the registry
  or `REGISTRY_TOKEN`, and static assets are excluded from gating.

Fail-closed posture, matching the registry client's philosophy:

- **Production builds without OIDC config refuse to serve pages** — every
  route answers 503 with an actionable page naming the missing variables
  (`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `SESSION_SECRET`).
- **`next dev` without config stays browsable** (demo data, localhost bind)
  and logs a loud one-time warning — local development should not demand a
  provider.
- **`AUTH_DISABLED=true`** explicitly turns the gate off (exact `true`/`1`
  only). Use it for public *demo* deployments; a warning is logged at
  runtime. The public Vercel demo pins this in `dashboard/vercel.json`.
  Loose values (`TRUE`, `yes`) do **not** disable anything.

Auth applies regardless of data mode — demo deployments are gated like live
ones unless explicitly disabled. A reverse proxy / identity-aware gateway in
front of the console remains good defense-in-depth (rate limiting, IP
allowlists, mTLS), but it is no longer the *required* boundary; the app
authenticates its own viewers now.

Known limitation (documented follow-up): the gate authenticates *people to
the console*, not *users to the registry* — once signed in, every visitor's
registry reads use the deployment's shared server-side token. Mapping
registry orgs to authenticated users (per-user registry ACLs) is the next
boundary step.

## Authentication (OIDC)

Register an OIDC application with your provider of choice:

1. **Callback URL**: `https://<console-origin>/api/auth/callback` (exactly;
   `OIDC_REDIRECT_URI` may also pin it explicitly for deployments where the
   edge does not forward the public origin).
2. **Client type**: confidential (web) application — the console exchanges
   the authorization code server-side with the client secret.
3. **Scopes**: `openid profile email` (requested by the console; email and
   name are display-only).
4. Set the environment variables from the table below and redeploy.

The provider must be OIDC-conformant (discovery document +
`id_token` support). GitHub OAuth Apps are **not** OIDC and will not work;
use an OIDC-conformant provider. Local providers (Keycloak, Dex, ORY Hydra)
on `http://localhost` are accepted for development — https is enforced
everywhere else.

Manual round-trip check against a real provider (runbook):

1. Deploy with the four variables set; visit any console route signed out.
   Expect: 302 → `/login?returnTo=<route>`, sign-in card, provider host shown.
2. Click **Sign in with SSO** → provider consent screen (302 to the
   authorize endpoint with `response_type=code&code_challenge_method=S256`).
3. Authenticate → 302 back to `/api/auth/callback` → 302 to the original
   route. The application cookie `bridge_console_session` is `HttpOnly`,
   `SameSite=Lax`, `Secure` (https origins); no flow cookies remain.
4. Reload, then open DevTools → Application → Cookies: no
   `bridge_oidc_flow` cookie; session cookie expires after
   `SESSION_TTL_SECONDS` (default 8h).
5. Wait out the session (or set `SESSION_TTL_SECONDS=300` for the test):
   next navigation lands on `/login?error=session_expired&returnTo=<route>`.
6. Hand-edit the session cookie's payload → next navigation treats you as
   signed out (signature check) — no stack, no digest.
7. **Sign out** in the header → `/login?notice=signed_out`, both cookies
   cleared. Back-button into a console page from bfcache → the next server
   round-trip re-gates (pages are dynamic; the shell never renders from a
   stale session).

## Deploying to Vercel

The dashboard deploys to Vercel as a standalone project. Because the app lives
in `dashboard/` (with its own lockfile) rather than the monorepo root — the
root builds the compiler packages, not a web app — the Vercel project must be
configured once:

1. Import the repo, then set **Root Directory = `dashboard`** (Project →
   Settings → General). Framework auto-detects as Next.js.
2. No environment variables are required: `dashboard/vercel.json` pins
   `NEXT_PUBLIC_DEMO_MODE=true` **and `AUTH_DISABLED=true`** for the
   deployment, so a fresh import renders the zero-backend demo with the
   login gate explicitly off — the seeded dataset, no registry service, no
   credential anywhere near a public URL (the runtime logs a one-time
   warning acknowledging the open gate).
3. Optional: set `NEXT_PUBLIC_CONSOLE_URL` to the deployment's final origin
   (e.g. `https://bridge-dashboard.vercel.app`) so canonical/OG metadata
   points at the real URL instead of `http://localhost:3000`.

Local check that mirrors the platform build exactly (no auth needed):
`npx vercel@latest build` from `dashboard/`.

Why demo mode is pinned in `vercel.json`: a production build defaults to
live mode (fail-closed — see the environment table below), and live mode on
a public URL additionally requires a signed-in viewer per the gate. To go
live on Vercel: set `NEXT_PUBLIC_DEMO_MODE=false`, `NEXT_PUBLIC_REGISTRY_URL`,
`REGISTRY_TOKEN`, `REGISTRY_ORGS` (overriding the pins) plus the four OIDC
variables from the Authentication section, and redeploy.

Known failure signatures, for diagnosis:

| Signature | Meaning | Fix |
|-----------|---------|-----|
| `[STATIC_BUILD_NO_OUT_DIR] No Output Directory named "public"` | Project Root Directory is the repo root — the compiler's `tsc -b` ran, not Next.js | Set Root Directory = `dashboard` |
| `RegistryMisconfigured: live mode is enabled but ...` | Production build defaulted to live mode with no registry configured | Root Directory = `dashboard` (so `vercel.json` applies) or set `NEXT_PUBLIC_DEMO_MODE=true` |
| Every route answers 503 "Console authentication is not configured" | Production build without OIDC config and without `AUTH_DISABLED=true` | Set the OIDC variables (see Authentication) — or, for intentionally public demo deployments, set `AUTH_DISABLED=true` |

## Routes

| Route | Shows |
|-------|-------|
| `/` | Overview: totals, recent publishes, recent breaking changes |
| `/contracts` | Searchable contract list with consumer counts + language coverage |
| `/contracts/[org]/[project]/[contract]` | Version timeline, consumers/producers, publish metadata, pull command |
| `/contracts/[org]/[project]/[contract]/diff?from=&to=` | Compatibility report (SAFE/WARNING/BREAKING change list) |
| `/graph` | Dependency graph (pure SVG, deterministic layered layout) |
| `/audit` | Audit log with filters |
| `/login` | Sign-in card (OIDC SSO); unauthenticated visitors land here from every gated route |
| `/logout` | Clears the session, lands on `/login?notice=signed_out` |
| `/api/auth/login`, `/api/auth/callback` | OIDC authorization-code + PKCE flow endpoints (302 round-trip) |

## Environment

| Variable | Default | Meaning |
|----------|---------|---------|
| `NEXT_PUBLIC_DEMO_MODE` | unset → **demo in `next dev`, live in production builds** | Renders seeded demo data instead of calling the registry. Exact behavior (see `isDemoMode` in `src/lib/registry-client.ts`): unset or empty keeps the mode-dependent default — **demo under `next dev`, LIVE when `NODE_ENV=production`** (a production build never serves fabricated data just because an env var was forgotten). Exactly `false` / `0` forces live; exactly `true` / `1` forces demo. Any other value logs a warning and keeps the mode-dependent default — booleans are never coerced loosely (`FALSE` does **not** go live). |
| `NEXT_PUBLIC_REGISTRY_URL` | `http://localhost:4350` | Registry service base URL (live mode) — matches the service's default port |
| `REGISTRY_TOKEN` | — | **Server-side** bearer token for live mode (admin role for the audit page). Required; never sent to the browser |
| `REGISTRY_ORGS` | — | Org/project discovery for live mode, e.g. `acme:payments,acme:commerce`. Required — the service exposes no cross-tenant listing by design |
| `NEXT_PUBLIC_CONSOLE_URL` | `http://localhost:3000` | Console's own origin, used as the metadata/OG canonical base |
| `AUTH_DISABLED` | unset → gate enforced | Exactly `true` / `1` turns the OIDC gate off (public demo deployments; logs a warning). Any other value is ignored — booleans are never coerced loosely. Production builds without OIDC config fail closed with a 503 page naming the missing variables. |
| `OIDC_ISSUER` | — | OIDC provider issuer URL with trailing slash, e.g. `https://id.example.com/`. Drives discovery (`<issuer>/.well-known/openid-configuration`) — no hardcoded provider endpoints |
| `OIDC_CLIENT_ID` | — | Confidential client id registered at the provider |
| `OIDC_CLIENT_SECRET` | — | **Server-side** client secret for the code exchange; never reaches the browser |
| `OIDC_REDIRECT_URI` | derived | Optional pinned callback; defaults to `<request-origin>/api/auth/callback` (correct for Vercel and TLS-terminating proxies that forward host/proto) |
| `SESSION_SECRET` | — | **Server-side** HMAC secret (≥ 32 chars, `openssl rand -hex 32`) signing the `bridge_console_session` cookie |
| `SESSION_TTL_SECONDS` | `28800` (8h) | Session lifetime; clamped to 5 minutes – 7 days |

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
