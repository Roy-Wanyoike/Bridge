## Summary
The dashboard's **live mode** — the production default — now actually works against a running `bridge-registry-service`, verified in the browser. It previously failed on every page: the REST client was written against a spec, not the shipped service.

## Why
Three contract breaks, all verified at runtime before this fix (boot service → `bridge publish` over HTTP succeeded → every dashboard page landed in the error boundary):

1. **Auth**: the client sent no `Authorization` header; the service fails closed (every `/v1` read 401s).
2. **Discovery**: the client called `GET /v1/orgs` and `GET /v1/orgs/{org}/projects` — routes the service **intentionally does not have** (cross-tenant existence is never leaked; each credential is bound to one org).
3. **Data shape**: the list route serves storage-level `ContractMeta`; the client blind-cast it to the rich `ContractSummary` — hence `NaN` consumer counts and `Cannot read properties of undefined (reading 'length')` crashes (tracked in #97's evidence).

## Implementation
- **Server-side credential**: `RestRegistryClient` sends `Authorization: Bearer ${REGISTRY_TOKEN}`. `REGISTRY_TOKEN` is server-side only (no `NEXT_PUBLIC_` prefix — it cannot reach the browser bundle). Live mode **fails fast at startup** with an actionable `RegistryMisconfigured` error when the URL, token or discovery config is missing — never a silent demo fallback, never a bare digest.
- **Discovery per the tenancy model**: `REGISTRY_ORGS="acme:payments,acme:commerce"` (`org:project` pairs). The service deliberately exposes no cross-tenant listing, so the operator declares the surface. A bare org name is a configuration error, not an empty page.
- **Honest projection layer** (no fabrication):
  - `versionCount` / `latestVerdict` derived from the real versions + diff routes with bounded concurrency (8 in flight — same discipline as the overview)
  - `consumers` counted from the real dependents route
  - `languages` left empty (the service does not record generated languages); `owner` mapped from `publishedBy`
  - `getGraph` composed client-side from contracts + dependents (the service's graph route is a per-contract import closure, not a global graph)
  - `listVersions`/`getVersion`/`getDiff`/`listConsumers`/`listAudit` all map the service's actual response shapes; pre-auth null audit rows render honest placeholders
- **Docs + hints**: dashboard README's "Going live" rewritten (real config, admin-role requirement for `/v1/audit`, token secrecy note); the error boundary and demo-disclosure hints now name all three live-mode variables.
- **Bonus**: fixed a pre-existing lint warning in the dashboard's own ESLint config (anonymous default export) that would have failed CI's warnings gate had CI ever been able to run.

## Testing
- Dashboard: `tsc --noEmit` ✓, `eslint .` **0 warnings** ✓, production build ✓.
- Workspace regression: build ✓, **699/699 tests** ✓, lint ✓, e2e gate **25/25** ✓.

## Runtime Validation (browser, against a live service)
Boot `bridge-registry-service --token …` → publish two contracts via the CLI over HTTP → live-mode production build → `next start` with `REGISTRY_TOKEN` + `REGISTRY_ORGS`:
- **`/` Overview**: `CONTRACTS 2`, truthful `CONSUMER LINKS 0`, latest adjacent diffs computed live (verdicts via the diff route)
- **`/contracts`**: real contract rows (orders, payments) with correct coordinates
- **`/graph`**: renders with the honest "No dependency edges in this scope" state (no imports in these contracts)
- **`/audit`**: real publish entries with working filters
- No error digests anywhere; all four surfaces previously dead now render.

## Security
- `REGISTRY_TOKEN` is server-side only; it is never shipped to the client (it lives in server-only `process.env` reads inside server components/route handlers).
- No new runtime dependencies; the tenancy no-leak design (404, never 403, for foreign orgs) is preserved — discovery is config-declared, not enumerated.

## Breaking Changes
Deployment config addition for live mode: `REGISTRY_TOKEN` + `REGISTRY_ORGS` are now required (previously "required" in effect — live mode simply didn't work). Demo mode unchanged.

## Acceptance Criteria (issue #97)
- [x] Live-mode production build against a real service renders contracts list, contract detail path, diff verdicts, graph, audit — browser-verified (not mock-fetch)
- [x] Full journey works end to end: `bridge publish` (HTTP, #91) → contracts visible in the live dashboard
- [x] Missing `REGISTRY_TOKEN`/`REGISTRY_ORGS` produces the honest, actionable misconfiguration error (never silent demo, never a bare digest)
- [x] The token is server-side only by construction (no `NEXT_PUBLIC_` exposure path)
- [x] Demo mode remains fully functional (demo suite untouched; e2e gate 25/25)

## Related Issue
Closes #97
