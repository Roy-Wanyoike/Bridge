## Summary
The CLI's registry commands now talk to a running `bridge-registry-service` over HTTP — closing the loop between the three shipped surfaces (CLI ⇄ registry service ⇄ dashboard). `publish`, `pull`, `versions`, `inspect` and `search` accept `--registry http://…` / `https://…` alongside the existing filesystem root, with bearer-token auth and explicit tenancy coordinates.

```
bridge publish payments.bridge \
  --registry https://registry.example.com \
  --org acme --project payments --token <tok>
```

## Why
The registry service ships a complete REST API and the dashboard consumes it in live mode — but no first-party CLI path could write to it (the only publisher was in-process test helpers). The canonical user journey — *publish from CLI, view in the live dashboard* — was impossible. This also upgrades the #90 URL-rejection defect into real support for the five registry verbs, while keeping the rejection for filesystem-only commands (`doctor`, `check --against`, `impact`).

## Implementation
- **New `packages/bridge-cli/src/registry-http.ts`**: resolves `--registry` (flag > `BRIDGE_REGISTRY`) into a filesystem-or-HTTP target; validates HTTP requirements **loudly before any I/O** (token via `--token`/`BRIDGE_TOKEN`; `--org`/`--project` via flags/`BRIDGE_ORG`/`BRIDGE_PROJECT` for coordinate-scoped verbs; `--owner` rejected for HTTP — the service stamps `publishedBy` from the credential). Requests carry `Authorization: Bearer …` (the token is never logged or echoed), 30 s timeout, and server error envelopes map onto `RegistryError` codes where they match the store union (404 `not-found`, 409 `immutable` → existing friendly hints) or `CliError`s otherwise (401/403/429/network/timeout). Publish sends `contentHash: hashPackage(ir)` so the service's tamper assertion engages.
- **Commands became async** (`main` now awaits; the bin catches internal-only rejections); each branches once on the target kind and keeps its existing output format — remote metadata renders `registry: <url> (org X, project Y)` and `publishedBy: …` in place of the filesystem `owner`.
- **Filesystem behavior unchanged** for every command; `doctor`/`check`/`impact` keep rejecting URL registries (issue #90 invariant, still tested).
- **Help text** for the five commands documents the HTTP form, required env vars, and the `--owner`/HTTP split.
- `@bridge/registry-service` added as a **devDependency** (integration tests boot the real server; the CLI keeps zero runtime deps beyond `@bridge/*`).

## Testing
- **New integration suite** `packages/bridge-cli/src/test/registry-http.test.ts` boots the real service (in-memory driver, ephemeral port) and covers: the full publish → versions → inspect → search → pull loop; **cross-process byte-identical IR round-trip** (HTTP-published IR == filesystem-published IR, canonical JSON); idempotent republish reported as identical; immutability on changed content (409 → friendly hint); v2 publish + explicit version pull; wrong token → actionable auth error with **no token echo**; cross-tenant reads indistinguishable from unknown routes (404, no leak); unreachable service → typed loud failure; empty search exit 0; env-var forms.
- **Usage-error tests** in `registry.test.ts`: HTTP without token (exit 2, no directory created), HTTP without coordinates, `--owner` rejection, plus the #90 invariant for `doctor`/`check`.
- Full workspace: build ✓, lint **0 warnings** ✓, **699/699 tests pass** (691 + 9 new integration − 1 superseded), e2e gate **25/25 PASS** ✓.

## Runtime Validation
Executed the flagship journey end to end in the running application: booted `bridge-registry-service` on localhost → `bridge publish /tmp/rt-payments.bridge --registry http://127.0.0.1:4430 --token … --org acme --project payments` → `✓ published payments.v1@v1 (hash 64591bf1a792) … publishedBy: token:acme` → `bridge versions` listed v1 (latest). Separately reproduced the (pre-existing, separately-tracked) dashboard live-mode fetch failure — see the follow-up issue.

## Security
- Bearer token sent only in the `Authorization` header; never logged, never echoed in errors (asserted by test).
- Publish sends a `contentHash` so the service's tamper check can reject modified payloads.
- No new runtime dependencies; auth requirements are validated before any request or filesystem write.

## Breaking Changes
None. `--registry` remains fully backwards-compatible; HTTP targets previously hit the #90 silent-directory defect and now either work (with credentials) or fail loudly without them.

## Acceptance Criteria (issue #91)
- [x] All five commands work against a live in-memory service on localhost (integration test asserts it)
- [x] Publish over HTTP then pull from a different process returns byte-identical IR
- [x] Auth failures surface as actionable CLI errors without leaking the token
- [x] `--registry` remains backwards-compatible for filesystem roots
- [x] Unit/integration tests cover mocked success and failure paths
- [x] Documentation updated (README quick start + command help text)

## Related Issue
Closes #91
