# Bridge Deployment Runbook

Public hosting for the Bridge contract registry service — and the wiring that
puts the web console in front of it. One supported path, end to end, plus the
alternatives and the rollback story.

This covers the server side: hosting `bridge-registry-service` (the
multi-tenant HTTP registry in
[`packages/bridge-registry-service`](../packages/bridge-registry-service)),
secrets, storage, signing, audit — then connecting the dashboard console
([`dashboard/`](../dashboard/README.md)) to it in live mode. CLI day-to-day
usage is in [QUICKSTART](./QUICKSTART.md); the local filesystem registry needs
no deployment and is not covered here.

---

## 1. Overview

Who this is for: the operator deploying the registry for real traffic —
internet-facing, authenticated, audited — and pointing the console at it.

The primary path this runbook walks through:

1. Build the container image from the repository `Dockerfile`.
2. Run it on a host that terminates TLS, backed by PostgreSQL, in the
   production profile (signed publishes mandatory, rate limiting on).
3. Store the ed25519 signing keys and tokens in a named secret manager.
4. Wire the Vercel-hosted console to it in live mode behind its OIDC gate.
5. Run the smoke checklist.

Everything here is derived from the repository: the flags are the CLI's real
flags (`docker run --rm bridge:local service --help` prints the same table),
and the image is the real image the release workflow publishes.

## 2. Prerequisites

| Requirement | Why | Notes |
|---|---|---|
| Docker | Build/run the service image | Any recent engine; the image is `node:22-bookworm-slim` based and runs as non-root |
| A host with TLS termination | The service has **no built-in TLS** and binds loopback by default | Fly.io, Railway, or a VPS with Caddy/nginx in front |
| PostgreSQL (recommended) | Durable contracts + audit rows | Any managed instance works; in-memory mode is the zero-ops alternative (see §5) |
| An OIDC provider account | The console's login gate (dashboard issue #163) | Any standard provider: GitHub, Auth0, WorkOS, self-hosted Keycloak … |
| `openssl` | Generate the ed25519 signing key pair and high-entropy tokens | Present on most hosts |
| Node 22+ / npm | Only for the smoke checklist (building the CLI from this repo) | `npm install && npm run build`, per [QUICKSTART](./QUICKSTART.md) |

## 3. Architecture

```
                 ┌─────────────────────────────────────────────┐
                 │  Vercel project (dashboard/, Next.js)       │
                 │  console in live mode                       │
                 │  NEXT_PUBLIC_DEMO_MODE=false                │
                 └──────┬─────────────────────┬────────────────┘
                        │ /v1/... reads       │ login
  REGISTRY_TOKEN        │ (server components) │ (issue #163)
  (server-side only)    │                  ┌──▼────────────────┐
                        │                  │  OIDC provider    │
                        │                  │  (login gate)     │
                        │                  └───────────────────┘
  ┌─────────────────────▼──────────────────────────────────────┐
  │  Host with TLS (Fly.io / Railway / VPS + Caddy/nginx)      │
  │                                                            │
  │  TLS :443 ──► reverse proxy ──► bridge-registry-service    │
  │                                    --host 0.0.0.0          │
  │                                    --port 4350             │
  │                                    --production-profile    │
  │                                              │             │
  │                               PostgreSQL ◄───┘             │
  │                                                            │
  └────────────────────────────────────────────────────────────┘
          ▲
          │ bridge publish --registry https://<your-domain> ...
          │ (publishers sign with the ed25519 private key)
```

The pieces:

- **Registry service (this doc)** — dependency-free Node HTTP API. JSON over
  HTTP with org/project tenancy, bearer-token or OIDC auth, ed25519 publish
  signature verification, append-only audit, token-bucket rate limiting.
- **Console (Vercel)** — the dashboard in live mode. Its Next.js server reads
  the registry on behalf of viewers with a single admin-role token that never
  reaches the browser bundle. It has no user authentication of its own — the
  OIDC gate (issue #163) is what puts a login in front of it.
- **OIDC provider** — used by the console's login gate. The service itself can
  also accept OIDC (`--oidc-issuer/--oidc-audience/--oidc-jwks-url`), but the
  primary path below uses static tokens.

## 4. Primary path

### 4.1 Build the image

The repo-root `Dockerfile` is a multi-stage build (build → prod-deps →
runtime) that compiles every workspace package and ships only compiled `dist/`
plus production `node_modules`. Two smoke checks before anything ships:

```sh
docker build -t bridge:local .
docker run --rm bridge:local version        # CLI works: prints tool versions
docker run --rm bridge:local service --help # prints the registry service flag table
```

The image's entrypoint (`docker/bridge-entrypoint.sh`) routes the default CLI
to `bridge <args>` and `service <args>` to `bridge-registry-service`. Tags
`X.Y.Z`, `vX.Y.Z` and `latest` of the multi-arch image (linux/amd64 +
linux/arm64) are published to `ghcr.io/roy-wanyoike/bridge` by the release
workflow on every `v*.*.*` tag — pulling one instead of building is fine:

```sh
docker pull ghcr.io/roy-wanyoike/bridge:v0.2.1
```

### 4.2 Provision PostgreSQL

Create a database reachable from the host (a managed instance is the low-ops
choice). The service applies its migrations
(`packages/bridge-registry-service/migrations/*.sql`, tracked per-file in
`bridge_schema_migrations`) on boot — there is no separate migrate step. Tables
are prefixed `bridge_` (`bridge_contracts`, `bridge_audit`) so the service can
share a database. Put TLS on the wire via the DSN:

```
postgres://<user>:<password>@<host>:5432/<db>?sslmode=require
```

A DSN without `sslmode` defaults to `prefer`; under the production profile
`sslmode=disable` is refused outright.

### 4.3 Generate and store secrets

Everything secret is generated locally and stored in your platform's secret
manager — never in git, never in the image. Named options: **Fly.io secrets**
(`fly secrets set …`), **Railway variables** (`railway variables --set …`),
and on a VPS **systemd credentials** (`LoadCredentialEncrypted=` +
`/etc/credstore.encrypted/`) or a root-owned `0600` file provisioned via
`/etc/tmpfiles.d/bridge.conf` (`f /etc/bridge/secrets/registry_token 0600
root root -`).

**Signing key pair (ed25519).** Publishers hold the private half; the service
holds only the public half, mapped by a key id:

```sh
openssl genpkey -algorithm ed25519 -out publisher-signing.pem
openssl pkey -in publisher-signing.pem -pubout -out publisher-signing.pub
```

The private PEM (`publisher-signing.pem`) goes into the CI/publisher secret
store. The public PEM (`publisher-signing.pub`) is configured on the service
with `--signing-key <kid>=<pemfile>` (repeatable — keep old public keys around
so historical versions stay verifiable during rotation). Only ed25519 keys are
accepted. There is deliberately no env-var equivalent for signing keys: the
public key is loaded from a file at boot, so on PaaS hosts it rides in a
mounted volume or a thin derived image.

**Admin token.** Static bearer tokens are `<secret>=<org>:<role>` with role
`read | write | admin`, and every credential is bound to exactly one org. The
floor is 32 characters (~128 bits); the production profile refuses to start
with anything shorter:

```sh
openssl rand -hex 32   # → the REGISTRY_TOKEN secret (admin role)
```

### 4.4 Run the service

On a VPS-style host, run the image with the production profile and publish it
to loopback only — TLS belongs to the proxy in front:

```sh
docker run -d --name bridge-registry --restart unless-stopped \
  -p 127.0.0.1:4350:4350 \
  -v /etc/bridge/keys:/etc/bridge/keys:ro \
  ghcr.io/roy-wanyoike/bridge:v0.2.1 \
  service \
    --host 0.0.0.0 --port 4350 \
    --driver postgres \
    --pg-dsn "$PG_DSN" \
    --token "$REGISTRY_TOKEN=acme:admin" \
    --signing-key k1=/etc/bridge/keys/publisher-signing.pub \
    --production-profile
```

Flag-by-flag:

| Flag | Meaning |
|---|---|
| `--host 0.0.0.0` | Required to bind beyond loopback (the default is `127.0.0.1`). Prints a loud `SECURITY WARNING` to stderr before the socket opens — expected here, because TLS terminates in front. Inside Docker the container interface must be bound for the published port to work. |
| `--port 4350` | TCP port (the default anyway; the image's healthcheck probes `127.0.0.1:4350/healthz`, so override `--health-cmd` if you change it). |
| `--driver postgres --pg-dsn …` | Durable storage (§5). With `memory` both flags are omitted. |
| `--token $REGISTRY_TOKEN=acme:admin` | The admin-role credential the console uses. Repeat the flag for read/publisher tokens (`--token $PUB_TOKEN=acme:write`). |
| `--signing-key k1=/path/pub.pem` | Public half for key id `k1`; when any key is configured, **signed publishes are required**. `--signing-optional` would relax that — never combine it with the production profile (the service refuses the combination). |
| `--production-profile` | Hardened defaults: rate limiting on (auth bucket 120 capacity @ 30/s per IP; publish 30 @ 5/s per principal), signing mandatory, strict TLS for the Postgres transport, hard start failure on short tokens. |

Every flag has an env equivalent where argv is awkward (PaaS cmd lines):
`BRIDGE_REGISTRY_PORT`, `BRIDGE_REGISTRY_DRIVER`, `PG_DSN`,
`BRIDGE_REGISTRY_TOKEN` (repeatable within the value via `;`:
`secret=org:role;secret2=org:role`), `BRIDGE_REGISTRY_PRODUCTION=1`.
Signing keys remain flag-only.

On **Fly.io** the same deployment is: `fly apps create <app>`, `fly secrets
set PG_DSN=… REGISTRY_TOKEN=… BRIDGE_REGISTRY_PRODUCTION=1`, a `fly.toml` with
`internal_port = 4350` (health check `GET /healthz`), a `[mounts]` volume for
`/etc/bridge/keys`, `cmd = ["service", "--signing-key", "k1=/etc/bridge/keys/publisher-signing.pub"]`,
then `fly deploy --image ghcr.io/roy-wanyoike/bridge:v0.2.1` and `fly certs add <your-domain>`.
Fly terminates TLS for you; Railway and Kubernetes equivalents are in §10.

### 4.5 Enable audit

Audit is always on and fail-closed: one append-only entry per `/v1` request
(publishes, reads, admin access, failed auth), stored with the driver — in
`bridge_audit` under PostgreSQL. Rate-limited floods and pre-auth noise are
deliberately not persisted, so a flood cannot evict audit history. If the
audit append itself fails, the request is answered `5xx` rather than going
unaudited. On Postgres, retention is always enabled at **30 days**
(`--audit-retention-days <days>` or `BRIDGE_REGISTRY_AUDIT_RETENTION_DAYS` to
widen/narrow; boot sweep, then every 6 hours).

To mirror entries to an append-only JSONL file as well (survives even a
database restore gap), add:

```sh
--audit /var/lib/bridge/audit.jsonl
```

and mount `/var/lib/bridge` writable — the image runs as the non-root `node`
user, so the mounted directory must be writable by that user.

### 4.6 First boot check

```sh
curl -f https://<your-domain>/healthz
# → {"ok":true}

curl -sS https://<your-domain>/v1/openapi.json | head -c 200
# → the public API document (no auth required)
```

The stderr log shows the non-loopback `SECURITY WARNING` (§4.4) and
`bridge-registry-service listening on port 4350`. If artifact signing were
misconfigured you would instead see `WARNING: artifact signing is NOT
required` — treat that as a failed boot in production.

## 5. Storage decision

| | `--driver memory` (default) | `--driver postgres` |
|---|---|---|
| Contract persistence | None — every version lives in process; a restart empties the registry (publishers re-push; versions are content-addressed so identical content replays) | Durable rows keyed `(org, project, base, version)`; immutable, hash-checked |
| Audit log | In-memory bounded ring — restarts erase history | `bridge_audit` table, retention default 30 days, queryable/filterable |
| Backups | Not applicable | `pg_dump`/`pg_restore`, or managed snapshots/PITR |
| Ops burden | Zero (no DSN, no migrations) | A database to run, back up, and patch |
| When to choose | Ephemeral environments: demos, CI, throwaway previews | **Anything internet-facing or shared with a team** — the primary path |

If you choose PostgreSQL: enable automated backups (managed PITR is ideal —
the schema is small: contract JSONB plus audit rows), test a restore into a
scratch database, and remember the audit JSONL mirror (§4.5) is an extra
safety net, not a replacement. Migrations are additive
(`CREATE TABLE/INDEX IF NOT EXISTS` plus one `DROP INDEX IF EXISTS`), applied
on boot and tracked in `bridge_schema_migrations` — do not run them by hand.

## 6. Console wiring (Vercel)

The console deploys as its own Vercel project with **Root Directory =
`dashboard`** (`dashboard/vercel.json` pins `NEXT_PUBLIC_DEMO_MODE=true` at
build time, so a fresh import is a zero-backend demo). Going live means
overriding that pin with four variables in **Project → Settings → Environment
Variables** — set them as secrets, never commit them:

| Variable | Value | Notes |
|---|---|---|
| `NEXT_PUBLIC_DEMO_MODE` | `false` | Exactly `false` (or `0`) forces live mode and overrides the `vercel.json` demo pin. Not `FALSE`, not `off` — booleans are never coerced loosely. |
| `NEXT_PUBLIC_REGISTRY_URL` | `https://<your-domain>` | The TLS origin from §4 (no trailing path). |
| `REGISTRY_TOKEN` | the admin-role secret from §4.3 | **Server-side only** — no `NEXT_PUBLIC_` prefix, so it stays out of the browser bundle. Admin role (not just read/write) because the Overview and Audit pages read `/v1/audit`, which is admin-only. |
| `REGISTRY_ORGS` | `acme:payments` (comma-separated pairs: `acme:payments,acme:commerce`) | The org/project surface the console renders. The service exposes no cross-tenant discovery by design; a bare org without a project is a configuration error. |

Redeploy after saving. Live mode fails closed: with any of
`NEXT_PUBLIC_REGISTRY_URL`, `REGISTRY_TOKEN` or `REGISTRY_ORGS` missing, the
console throws an actionable `RegistryMisconfigured` error at startup instead
of silently degrading.

**OIDC login gate** (dashboard issue #163): the console itself has no user
authentication today — anyone who can reach it can browse the declared
org/project surface, and it performs token-authenticated registry reads on
their behalf (the full deployment-boundary discussion lives in
`dashboard/README.md`). The gate adds four server-side variables in the same
Vercel project:

```sh
OIDC_ISSUER=https://<your-oidc-issuer>       # provider registration steps: dashboard/README.md
OIDC_CLIENT_ID=<client id for the console>
OIDC_CLIENT_SECRET=<client secret>           # server-side only
SESSION_SECRET=<openssl rand -hex 32>        # cookie/session signing key
```

Until the gate ships, keep the console behind an authenticating reverse proxy,
on a private network, or in demo mode — per the deployment boundary in
`dashboard/README.md`.

## 7. Smoke checklist

Run from a machine with the repo built (`npm install && npm run build`; the
`bridge` binary is at `packages/bridge-cli/dist/bin/bridge.js`):

```sh
export BRIDGE_REGISTRY=https://<your-domain>
export BRIDGE_TOKEN=<the admin token>        # 32+ chars, org acme
export BRIDGE_ORG=acme
export BRIDGE_PROJECT=payments
```

1. **Health.** `curl -f https://<your-domain>/healthz` → `{"ok":true}`
   (unauthenticated, by design).
2. **Unauthenticated requests are rejected.**
   `curl -i -sS $BRIDGE_REGISTRY/v1/orgs/acme/projects/payments/contracts/payments.v1`
   → `HTTP 401` with the envelope
   `{"error":{"code":"unauthenticated",…}}`.
3. **Publish a contract.**
   `bridge publish examples/versioning/v1.payments.bridge --signing-key-id k1 --signing-key-file publisher-signing.pem`
   → `published payments.v1@v1 (hash <short-hash>)`, `registry: … (org acme,
   project payments)`. The production profile makes the signing flags
   mandatory — an unsigned attempt fails with `signature-required`.
4. **Visible in the console.** Open the console's `/contracts` page → the
   `acme / payments` project lists `payments.v1` with its language coverage
   and consumer counts.
5. **Publish a second version.**
   `bridge publish examples/versioning/v2.payments.bridge --version v2 --signing-key-id k1 --signing-key-file publisher-signing.pem`
   → `published payments.v1@v2`. `bridge versions payments.v1` → `v1`, `v2`.
6. **Diff renders.** Open
   `/contracts/acme/payments/payments.v1/diff?from=v1&to=v2` in the console →
   the compatibility report classifies the revision-2 changes (added
   `Payment.reference` = SAFE, added `PaymentStatus.REFUNDED` = WARNING,
   removed `Payment.currency` = BREAKING). `bridge diff examples/versioning/v1.payments.bridge examples/versioning/v2.payments.bridge`
   shows the same verdict locally.
7. **Audit lists entries.**
   `curl -sS -H "Authorization: Bearer $BRIDGE_TOKEN" "$BRIDGE_REGISTRY/v1/audit?limit=5"`
   → `{"entries":[…]}` newest-first, including the publishes from steps 3 and
   5; the console's `/audit` page shows the same trail (it reads up to the 500
   newest entries per render).
8. **Cross-tenant stays invisible.**
   `curl -i -sS -H "Authorization: Bearer $BRIDGE_TOKEN" $BRIDGE_REGISTRY/v1/orgs/other/projects/x/contracts/y`
   → `404`, never `403` — other tenants' existence is not leaked.

## 8. Security notes

- **The admin token lives server-side only** — as a Vercel environment
  variable consumed by the console's server components, and in the host's
  secret manager. It is never prefixed `NEXT_PUBLIC_`, never logged, and never
  echoed in errors. It is a *registry* admin within one org, not an infra
  admin.
- **TLS is required.** The service has no built-in TLS; it binds loopback by
  default and demands an explicit `--host` decision (with a stderr warning) to
  go beyond. Terminate TLS in front of it — always.
- **Rate limiting is on** by default: the auth bucket (120 capacity @ 30/s per
  IP) absorbs token-guessing floods; the publish bucket (30 @ 5/s per
  principal) stops one compromised credential from starving other publishers.
  Exceeding a bucket returns `429` with `Retry-After`.
- **Audit is enabled and fail-closed** (§4.5), with 30-day retention on
  Postgres. Failed authentications are recorded as `action: 'auth'` security
  events; audit reads are force-scoped to the caller's org.
- **No contract contents in logs.** The service's stdout is boot lines and
  internal-error messages; audit rows carry coordinates (org, project,
  contract, version, actor, IP, status) — not IR payloads. The CLI only ever
  sends the token in the `Authorization` header.
- **Publishes are signed.** ed25519 signatures over the canonical JSON of the
  publish body (`x-bridge-key-id` / `x-bridge-signature` headers) are
  mandatory under the production profile; any content change invalidates the
  signature, and a declared `contentHash` mismatch is rejected as tampering.
- The image runs as the non-root `node` user; error envelopes never leak stack
  traces or driver messages.

## 9. Rollback notes

**Console → demo mode.** In the Vercel project settings, remove the live-mode
overrides from §6 (or set `NEXT_PUBLIC_DEMO_MODE=true`) and redeploy — the
`vercel.json` build-time pin takes over again and the deployment serves the
seeded demo with no registry URL and no credential. This is the instant
"stop exposing live data" lever; it does not touch the service or its data.

**Service → previous version.** Release images are tagged per version, so
redeploy the previous tag:

```sh
docker pull ghcr.io/roy-wanyoike/bridge:v<previous>
# then re-run §4.4 with that tag (or: fly deploy --image …:v<previous>)
```

The shipped migrations are additive and applied on boot, so an older image
runs cleanly against a database already migrated by a newer one. Verify with
`/healthz` and the §7 checklist. Published versions are immutable
(content-addressed), so there is no data rollback — republishing identical
content is a replay, and nothing mutates underneath you. If the service's
public URL changed during the incident, revert `NEXT_PUBLIC_REGISTRY_URL` in
the Vercel project to the previous origin and redeploy.

## 10. Alternatives

| Host | When to choose | Notes |
|---|---|---|
| **Fly.io** | Turnkey TLS + anycast edge, small team, few minutes to first deploy | `fly secrets set` for tokens/DSN; volume mount for the signing public key; `internal_port = 4350`, health path `/healthz` in `fly.toml`; Postgres via `fly postgres create` or any managed instance |
| **Railway** | GitHub-connected PaaS, PR environments, variables UI | `railway variables --set` for the env equivalents (§4.4); add the PostgreSQL plugin; `railway up` builds the repo Dockerfile |
| **VPS + Caddy/nginx** | Full control, predictable cost at scale, existing infra | The §4.4 `docker run` + a two-line Caddyfile (`reverse_proxy 127.0.0.1:4350`); systemd unit with `LoadCredentialEncrypted`/tmpfiles for secrets; you own TLS renewal and reboots |
| **Kubernetes** | The org already runs k8s; needs rollouts, HPA, standard ingress | Single stateless Deployment + external PostgreSQL; tokens/DSN as `Secret` objects, signing public key via ConfigMap/Secret volume; TLS via cert-manager ingress |

Whichever host you pick, the invariants are the same: TLS in front of a
loopback-default service, `--production-profile` with signing keys, secrets in
a named manager, audit on, and the smoke checklist green before the console
goes live.
