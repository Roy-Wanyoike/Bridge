# Bridge Roadmap

A three-phase public roadmap — shipped through Phase 3, with one AI-native item still open. Every item links to a tracked [GitHub issue](https://github.com/Roy-Wanyoike/bridge/issues) — subscribe there for progress and design discussion. The strategy behind the sequence is in [docs/strategy/MARKET_ANALYSIS.md](strategy/MARKET_ANALYSIS.md) and [docs/strategy/POSITIONING.md](strategy/POSITIONING.md).

Legend: 🔲 planned · 🟡 in progress · ✅ done

## Phase 1 — The compiler era (shipped)

One IDL → one deterministic IR → validated code in four languages, with compatibility checking and an immutable registry. Shipped with 355+ tests across five packages; the full suite now stands at 831 tests across nine packages (CLI 136, compat 109, core 172, FFI 12, generators 86, LSP 38, registry 65, registry-service 101, serialization 112), plus a separate 94-test dashboard suite (`cd dashboard && npm test`).

| Capability | Status | Notes |
|------------|--------|-------|
| Bridge IDL grammar + lexer | ✅ | Primitives, structs, enums, unions, aliases, imports, packages, constraints, defaults, deprecation |
| Parser + AST with source locations | ✅ | Recoverable errors, did-you-mean hints |
| Semantic analysis + type resolution | ✅ | Reference checking, duplicate detection, constraint applicability (`BR1xxx`–`BR2xxx` diagnostics) |
| Canonical IR (deterministic, hashable) | ✅ | Stable ordering, SHA-256 over canonical JSON, frozen contract |
| Canonical formatter (`bridge fmt`) | ✅ | Idempotent, meaning-preserving |
| Compatibility engine (`bridge diff` / `check`) | ✅ | SAFE / WARNING / BREAKING / UNKNOWN; rename synthesis; strict + compatible gates |
| Go, Rust, TypeScript, Python generators | ✅ | Types, enums, tagged unions, aliases, validators, service clients/traits, event envelopes; byte-deterministic output |
| CLI (16 commands) | ✅ | `init` `validate` `fmt` `lint` `generate` `diff` `check` `impact` `publish` `pull` `versions` `inspect` `search` `doctor` `version` `help` |
| Local registry | ✅ | Content-addressed, immutable, tamper detection, `dependents`/`dependencies` graph |
| Examples + verification scripts + docs | ✅ | Eight runnable examples (seven with verified `demo.mjs` runs; `events-rpc` is verified by `scripts/verify-events-rpc.sh` — a local gate, not wired into any CI workflow); generated-code type-check and round-trip verification (Go/Rust/Java/C# compile-verified in CI; TypeScript and Python via local scripts) |
| CI: build, test matrix, generated-code verification | ✅ | GitHub Actions: Node 22/24 build+test matrix (with a docs-facts check), Go/Rust/Java/C# generator-verify jobs, cross-language serialization matrix, registry-service PostgreSQL integration job, dashboard lint/typecheck/build/test. The workflow definition is valid — runs are currently blocked by the Actions billing lock ([#127](https://github.com/Roy-Wanyoike/bridge/issues/127)); local gates are the validation of record until then |

## Phase 2 — The governance era (shipped)

Prove wire-level correctness across languages, then turn the registry into the place where "who is affected?" is answerable — and make it a service.

| Capability | Status | Issue | Notes |
|------------|--------|-------|-------|
| Cross-language serialization round-trip matrix (Go↔Rust↔TS↔Python) | ✅ | [#15](https://github.com/Roy-Wanyoike/bridge/issues/15) | Golden vectors + property tests in `@bridge/serialization` |
| Event contracts: transports + generated publishers/consumers | ✅ | [#16](https://github.com/Roy-Wanyoike/bridge/issues/16) | CloudEvents-style envelopes + in-memory bus in every language |
| RPC transports beyond JSON clients (HTTP shapes, gRPC, Connect) | ✅ | [#17](https://github.com/Roy-Wanyoike/bridge/issues/17) | Typed HTTP clients + server adapters in every language |
| Consumer-aware impact analysis + CI governance | ✅ | [#19](https://github.com/Roy-Wanyoike/bridge/issues/19) | "17 consumers affected" — diff × registry graph, enforced in CI |
| Registry service: server, OIDC auth, multi-tenancy, audit logs | ✅ | [#18](https://github.com/Roy-Wanyoike/bridge/issues/18) | `@bridge/registry-service`: OpenAPI, signing, rate limits, in-memory + PostgreSQL |
| Dashboard (Next.js): contracts, versions, consumers, dependency graph | ✅ | [#20](https://github.com/Roy-Wanyoike/bridge/issues/20) | `dashboard/` — demo mode, SVG dependency graph, diff reports |
| Release engineering: binaries, package managers, containers, SBOM | ✅ | [#24](https://github.com/Roy-Wanyoike/bridge/issues/24) | Bun-compiled binaries, cosign signing, SPDX/CycloneDX SBOMs, multi-arch images, npm — see [RELEASE.md](../RELEASE.md). Pipeline shipped; the first release is not yet cut (Actions billing lock — the workflow runs once CI is unlocked) |
| Property-based + fuzz harness expansion, deterministic caching | ✅ | [#23](https://github.com/Roy-Wanyoike/bridge/issues/23) | Parser/compat fuzzing; cache keyed on schema hash |

## Phase 3 — The platform & AI-native era (shipped, except AI-native tooling)

Widen the languages, lower the friction, and carry contracts across language boundaries — including to non-human consumers.

| Capability | Status | Issue | Notes |
|------------|--------|-------|-------|
| LSP server for the Bridge IDL | ✅ | [#21](https://github.com/Roy-Wanyoike/bridge/issues/21) | JSON-RPC over stdio (`@bridge/lsp`) |
| Go ↔ Rust FFI (C ABI, safe wrappers) + WASM target | ✅ | [#22](https://github.com/Roy-Wanyoike/bridge/issues/22) | Verified end to end: Go calls the built Rust cdylib — see [FFI.md](FFI.md) |
| Java + C# generators | ✅ | [#25](https://github.com/Roy-Wanyoike/bridge/issues/25) | Compile-verified against every example (ECJ / dotnet in CI) |
| AI-native tooling: tool-call/MCP schema emission from the IR | 🔲 | tracked under [#19](https://github.com/Roy-Wanyoike/bridge/issues/19) + [#22](https://github.com/Roy-Wanyoike/bridge/issues/22) discussion | Agent-facing contracts get the same governance plane (see [strategy](strategy/MARKET_ANALYSIS.md), Gap 6) |

**Status: every phase is shipped except AI-native tooling (Phase 3, last row).** What's next: AI-native tooling (tool-call/MCP schema emission), gRPC/Connect transports, and consumer registry federation.

Sequencing principle: every phase ships standalone value — the compiler, the gate, the registry, then the service — so no phase depends on a later one to be useful. Issues are the source of truth for scope; this file is the map.
