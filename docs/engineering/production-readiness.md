# Engineering Audit — Production Readiness

Gate table for a public 1.0. Verdicts are honest, not generous:
**PASS** = implemented, tested, and its declared verification path is
plausible today; **PARTIAL** = real and useful but with named holes;
**MISSING** = not present. Evidence lines cite files and, where measured,
test counts (see [testing-audit](./testing-audit.md) for the full run:
831 workspace tests + 100 dashboard tests, 0 failures).

## 1. Gate table

| Area | Verdict | One-line evidence |
| --- | --- | --- |
| Compiler (lexer→parser→semantic→IR) | **PASS** | 172 core tests + property + fuzz harness asserting the never-throw contract (`bridge-core/src/fuzz/fuzz.ts`); stable `BR1xxx/BR2xxx` diagnostics |
| IDL (v1 grammar) | **PASS** | Full spec in `docs/IDL_REFERENCE.md` implemented — declarations, constraints, defaults, deprecation, imports; declared v1 limits only (`@pattern` RE2-only, no annotations) |
| Canonical IR + hashing | **PASS** | Frozen types (`ir/types.ts`), sorted canonical output, SHA-256 over canonical JSON (`ir/hash.ts`); determinism property-tested |
| Go generator | **PASS** | Full emit (types/validate/services/events/round-trip test); CI job `go-generator-verify` + adversarial `go build` gate |
| Rust generator | **PASS*** | Full emit; CI job + snapshots; *validators skip `@pattern` (documented v1 limitation) — the one asterisk |
| TypeScript generator | **PASS** | Full emit; `ts.createProgram` type-check gate that never skips (`ts-program-check.ts`) |
| Python generator | **PARTIAL** | Full emit + snapshots; compile/exec gate (`verify-python.sh`, adversarial python3 gate) is **local-only** — no CI job compiles generated Python |
| Java generator | **PARTIAL** | Complete emit incl. `BridgeJson`/`BridgeValidation`/clients/servers + CI job defined (`verify-java.sh`, temurin 21) — but CI is not running (#127) and javac/dotnet gates skip locally |
| C# generator | **PARTIAL** | Same shape as Java: emit complete, CI job defined, not executing |
| Serialization | **PASS** | Canonical JSON + MessagePack + CBOR, 112 tests, 4-language golden-vector matrix CI-gated (`serialization-matrix`) |
| RPC | **PARTIAL** | Typed JSON-over-HTTP clients + server adapters in all 6 langs with canonical error table (`wire.ts`); no gRPC/Connect, no streaming; `verify-events-rpc.sh` not CI-wired |
| Events | **PASS** | CloudEvents-style envelope, publishers/consumers per language, determinism rule (caller-supplied id/time) |
| FFI (Go↔Rust) | **PARTIAL** | C-ABI cdylib + cgo client genuinely verified end-to-end by `scripts/verify-ffi.sh` — local-only, never CI-wired |
| WASM | **PARTIAL** | wasm-bindgen crate + TS wrappers generated (`bridge-ffi/src/wasm.ts`); compile-checked only when a local `wasm32` target exists; nothing published/consumable |
| Compatibility engine | **PASS** | 31 change kinds → SAFE/WARNING/BREAKING/UNKNOWN with rename synthesis and strict/compatible gates (109 tests + property suite) |
| Impact analysis | **PASS** | `bridge impact` walks the registry dependent graph with reachability reasons (`docs/IMPACT.md`); PR-comment workflow shipped as an example (`bridge-governance.yml.example`) |
| Local registry | **PASS** | Content-addressed, immutable, tamper-detecting, dependents graph (65 tests) |
| Registry service | **PASS** | Multi-tenant HTTP API: OIDC/static auth, signing (v1+v2 envelope), audit, dual-tier rate limits, memory+PostgreSQL drivers, OpenAPI 3.1 (101 tests incl. hardening suites) |
| CLI | **PASS** | All 16 commands exist and are tested (136 tests); exit-code contract; local + HTTP registries; publish signing flags |
| LSP | **PARTIAL** | Diagnostics/hover/completion/formatting over stdio (38 tests); no definition/references/rename, full-document sync only |
| Dashboard | **PARTIAL** | 6 routes, demo+live modes, security headers, 100 vitest tests — but **no auth gate** (issue #163 not started in-tree) |
| Security | **PARTIAL** | Service controls strong (org-bound fail-closed auth, signing, audit, rate limits, body caps); gaps: per-user ACL, consumer-side signature verification, dev-time dependency scanning, dashboard gate — see [security-audit](./security-audit.md) |
| Observability | **MISSING** | `/healthz` only; no metrics endpoint, no structured logging, no tracing (`server.ts`, `bin/bridge-registry-service.ts`) |
| Performance / benchmarks | **MISSING** | No benchmark suite anywhere in the repo; determinism is proven, speed is unmeasured |
| CI/CD | **PARTIAL** | `ci.yml` (7 jobs) + `release.yml` (version guard → binaries → checksums/SBOM/cosign → release → multi-arch container → npm) are complete and well-designed — but **no run has ever executed** (Actions billing lock, #127; no tag cut) |
| Documentation | **PASS** | 10 normative docs + strategy notes, all cross-linked and mechanically fact-checked in CI (`scripts/check-docs-facts.mjs`); two stale test-count figures found (dashboard 94→100) |
| Community readiness | **PARTIAL** | LICENSE/CONTRIBUTING/CODE_OF_CONDUCT/SECURITY/CHANGELOG/ROADMAP + issue templates present; no governance/maintainer model, single-maintainer bus factor, first release uncut |

## 2. What stands between the repo and a public 1.0

In order of leverage:

1. **Make CI actually run** (issue #127). The repo's whole verification story
   — four generator-verify jobs, the PostgreSQL integration, the
   serialization matrix — is written but has never executed remotely. Until
   it runs, every PASS above rests on local discipline. (Cost: an Actions
   billing decision; benefit: everything else becomes verifiable.)
2. **Dashboard OIDC gate** (issue #163, not started in-tree). The console has
   security headers and a demo-mode stopgap but no login. This is the single
   blocking item for pointing a public URL at a live registry.
3. **Cut the first release end-to-end.** `release.yml` has never run: run
   `scripts/release-rehearsal.sh`, pin the Homebrew digests (the guard
   refuses `sha256 :no_check`), verify cosign signatures and the multi-arch
   manifest on real infrastructure.
4. **Close the local-only verification gap.** Wire `verify-ts.sh`,
   `verify-python.sh`, `verify-ffi.sh`, `verify-events-rpc.sh` into CI (or
   accept and document them as release-checklist steps). Java/C#/Python
   generator gates currently skip on bare machines.
5. **Fix the Rust `@pattern` asymmetry** — either enforce it in generated
   Rust validators or refuse/warn at generation time. Silent enforcement
   differences between languages are the kind of thing the project's own
   promise says should never happen.
6. **Registry identity story for real teams**: token issuance/rotation with
   expiry (static `TokenTable` is dev-grade), and — post-1.0 — per-user ACL.
7. **Minimum observability for the service**: a `/metrics` endpoint and
   structured logs; hosted operation without them is flying blind.
8. **Housekeeping before the tag**: update the stale 94-test dashboard
   figure in `docs/TESTING.md`/`docs/ROADMAP.md`, confirm the `DATABASE_URL`
   rotation noted in the worklog, and wire the compile cache or remove it
   from the docs as a shipped feature.

What is *not* on the list: the compiler, IR, compat engine, local registry,
Go/Rust/TS generators, serialization, CLI, and docs are genuinely 1.0-grade —
tested, deterministic, and consistent with their documentation. The AI-native
tooling roadmap item (tool-call/MCP emission) and gRPC/Connect transports are
post-1.0 product decisions, not readiness gaps.

## 3. Verdict

**Conditional GO.** As a self-hosted, source-consumed toolkit today, the
repo is production-usable and unusually internally consistent. As a *public
1.0 product* it is gated on items 1–3 above (CI executing, dashboard auth,
first release), all of which are operational rather than architectural — the
hard engineering is done; the shipping engineering is not.
