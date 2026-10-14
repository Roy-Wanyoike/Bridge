# Engineering Audit — Security

An honest audit of the security posture as implemented. Nothing here is
aspirational: every "implemented" row cites the code that implements it, and
every "missing" row is genuinely absent from the tree (verified by
inspection, not by reading docs). Policy posture lives in
[SECURITY.md](../../SECURITY.md); this document audits reality against it.

## 1. What is implemented (with evidence)

### Registry service (`packages/bridge-registry-service`)

| Control | Status | Evidence |
| --- | --- | --- |
| OIDC JWT auth (RS256/ES256) against a fetched or injected JWKS; issuer/audience/`exp`/`nbf` enforced; fail-closed 401 | ✅ | `src/auth.ts` (697 LOC); header contract L1-18 |
| Org-bound tokens: valid token without `org` claim → 403 on every `/v1` route (tenancy decided by the claim) | ✅ | `auth.ts` L14-16; `missing-org-claim` error code in `openapi.ts` L37 |
| Static bearer tokens with roles `read < write < admin` mapped to access levels 1/2/3 | ✅ | `auth.ts` L37-47 (`ROLE_RANK`, `Levels`); documented as dev/test mechanism, "not a production mechanism" |
| Token entropy floor (≥32 chars ≈ 128 bits), enforced at startup — hard error in production profile; token material never echoed in errors | ✅ | `auth.ts` L59 (`TOKEN_MIN_LENGTH`), `assertTokenEntropy` L86-110 (issue #120 item 7) |
| `kid` negative-cache with TTL + spray bound | ✅ | `auth.ts` L118-120 (issue #48) |
| Two-tier token-bucket rate limiting: auth tier 120 cap / 30 refills per IP; publish tier 30 / 5 per `<principal>\|<ip>`; lazy+timed sweeps, 50k bucket cap with eviction; 429 + `Retry-After` | ✅ | `src/ratelimit.ts` L38-58 (issue #120) |
| ed25519 publish signing over canonical JSON (`x-bridge-key-id`, `x-bridge-signature`), plus v2 signed envelope binding org/project/contract/version coordinates (CLI still signs legacy; both accepted) | ✅ | `src/signing.ts` L1-38 (issue #120); CLI flags `--signing-key-id/--signing-key-file` (`bridge-cli/src/usage.ts` publish help) |
| `contentHash` tripwire: optional SHA-256 over canonical IR verified server-side | ✅ | `signing.ts` L16-19; `openapi.ts` L194 |
| Append-only, queryable audit log — one entry per rate-limited API request incl. failed auth (`action: 'auth'`); admin-scope-only query; driver / memory-ring (10k) / JSONL-file backends; torn-line tolerant | ✅ | `src/audit.ts` L1-32; `GET /v1/audit` requires `registry:admin` (`openapi.ts` L140-156); PG index migration `migrations/0002_audit_index.sql` |
| Multi-tenant isolation: every route scoped `orgs/{org}/projects/{project}`; cross-tenant access answers **404** (never 403 — no existence leak) | ✅ | `openapi.ts` L97, L169, L220 |
| Request-body cap (8 MB → 413) and canonical-JSON depth cap (512 → 400) against parser DoS | ✅ | `server.ts` L47 `MAX_BODY_BYTES`; `signing.ts` L58 `MAX_CANONICAL_DEPTH` (issue #48) |
| Service-side security headers (`X-Content-Type-Options: nosniff` et al.) | ✅ | `server.ts` ~L917 (issue #120) |
| Input validation for org/project/contract names and versions | ✅ | `src/validation.ts` (`isValidOrgOrProject` used by `auth.ts` L22) |
| Hand-written OpenAPI 3.1 with shared error envelope; zero-dependency implementation (hand-rolled JWT/ed25519 on `node:crypto`) | ✅ | `src/openapi.ts`; no third-party runtime deps in `package.json` |
| Postgres storage driver + migrations (audited schema) | ✅ | `storage/postgres/driver.ts`, `migrations/0001_init.sql`; CI job `registry-service-postgres` exercises it against Postgres 16 (`ci.yml` L145-175) |

### Dashboard (`dashboard/`)

| Control | Status | Evidence |
| --- | --- | --- |
| Response headers: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (no camera/mic/geolocation), `X-Powered-By` off | ✅ | `next.config.ts` `SECURITY_HEADERS` (issue #122); comment honestly defers network isolation/auth to deployment |
| Demo/live mode with strict boolean parsing; production defaults to **live**, not demo | ✅ | `src/lib/registry-client.ts` L46-59 |
| No secrets client-side: only `NEXT_PUBLIC_*` vars used (`NEXT_PUBLIC_REGISTRY_URL`, `NEXT_PUBLIC_DEMO_MODE`, `NEXT_PUBLIC_DASHBOARD_URL` in website) | ✅ | repo-wide grep of `process.env` in `dashboard/src` |
| Auth gate (OIDC login) | ❌ **not implemented** | no `dashboard/src/lib/auth/` directory exists (verified); tracked as issue #163, listed as "Next" in the worklog. Interim mitigation: `dashboard/vercel.json` bakes `NEXT_PUBLIC_DEMO_MODE=true` so the deployed console shows fabricated data |

### Compiler & supply chain

| Control | Status | Evidence |
| --- | --- | --- |
| Untrusted-input posture: compiler never executes schema content; fuzz harness asserts the never-throw contract over hostile bytes | ✅ | `SECURITY.md` design principles; `bridge-core/src/fuzz/fuzz.ts`; `BR2999` internal-error reporting |
| Registry immutability + tamper detection (re-hash on read) | ✅ | `bridge-registry/src/store.ts` (`assertSha256Hex`, verify); `hash-conflict`/`immutable` error codes |
| Release artifact security: SHA-256 checksums, SPDX + CycloneDX SBOMs, cosign keyless signing of binaries/checksums/containers, attestation of the checksums file, multi-arch manifest signed **by digest** | ✅ (defined; never executed — no tag cut yet) | `.github/workflows/release.yml` L165-234, L381-389; guard refuses Homebrew `sha256 :no_check` (L96-101) |
| CI least privilege: `permissions: contents: read` workflow-wide; no job elevates | ✅ | `ci.yml` L9-12 |
| Secret handling hygiene | ✅ post-incident | `.env.example` documents required vars; the 2026-10 workspace-archive incident (exposed `DATABASE_URL` to remote for ~2 minutes, branch deleted, commit rebuilt clean) is recorded in `worklog.md` with an owner action to **rotate the credential** — rotation must be confirmed by the owner |

## 2. What is missing (verified absent)

1. **Per-user / per-credential ACL within an org.** Scopes attach to tokens,
   not to users; any `write` token can publish anywhere in its org. No user
   model exists (`auth.ts` has no user entity; audit `actor` is the token's
   `publishedBy`/subject string).
2. **Signature verification on pull.** Publish-side signing exists, but
   `pull`/fetch paths verify only the content hash against stored metadata —
   there is no end-to-end consumer-side signature verification flow
   documented or implemented.
3. **Development-time dependency scanning / SBOM.** No `dependabot.yml`,
   `codeql.yml`, or audit step in `ci.yml` (`.github/` listing verified).
   SBOMs are release-time only. The zero-dependency runtime posture limits
   exposure, but devDependencies (typescript, eslint, next, vitest) are
   unscanned.
4. **Org isolation stress tests** beyond the hardening suite —
   `hardening-auth.test.ts` and `hardening-server.test.ts` cover cross-tenant
   404 and auth failures, but there is no fuzz/property campaign against the
   service routes (the fuzz harness covers the compiler only).
5. **Dashboard auth/session model** (see above) — including CSRF posture for
   the future live write paths.
6. **Secrets management for deployments** — `.env.example` covers local dev;
   no documented production secret rotation policy (the worklog incident
   makes this concrete).

## 3. Risk register (prioritized)

| # | Risk | Likelihood × Impact | Evidence | Mitigation direction |
| --- | --- | --- | --- | --- |
| S1 | Dashboard deployed live without an auth gate (until #163) leaks contract metadata | M × M | `next.config.ts` comment; absent `src/lib/auth/` | Ship the gate before any live-mode deployment; keep demo baked in until then (current state) |
| S2 | Static-token bootstrap in real deployments (no expiry/rotation) | M × H | `auth.ts` header; `TokenTable` only issuance path | Token issuance CLI with expiry + rotation + audit identity |
| S3 | Generated Rust code not enforcing `@pattern` narrows validation guarantees silently | M × M | IDL_REFERENCE declared limitation | Fail generation or warn loudly on `@pattern` + rust |
| S4 | Unrotated `DATABASE_URL` from the archive incident | L × H (if real) | `worklog.md` Task 2 note | Owner rotates the credential; confirm in a follow-up |
| S5 | CI not executing (#127 billing lock) — security-relevant gates (Postgres integration, hardening suites) are laptop-dependent | M × M | ROADMAP Phase 1 note | Unlock Actions; interim: run `scripts/verify-all.sh` pre-release |
| S6 | Supply-chain blind spot on devDependencies | M × L | no dependabot/codeql configs | Enable Dependabot + CodeQL (config-only) |

## 4. Bottom line

The service-level security engineering is unusually deep for the repo's
stage — org-bound fail-closed auth, dual-tier rate limiting, canonical-JSON
signing with a versioned envelope, and an append-only audit log are all real,
tested (`auth.test.ts`, `hardening-auth.test.ts`, `hardening-server.test.ts`,
`postgres.test.ts`) and documented. The gaps are exactly where a young
platform is weakest: identity (users vs tokens), consumer-side verification,
and the dashboard gate. None of the gaps invalidates the design; all of them
block a *public, hosted* 1.0.
