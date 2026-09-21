# Bridge

[![CI](https://github.com/Roy-Wanyoike/bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/Roy-Wanyoike/bridge/actions/workflows/ci.yml)

> **One contract. Every language. Zero interoperability drift.**

## The problem

If your stack spans more than one language, you live this: the same data contract — `Payment`, `PaymentStatus`, the rule that currency is exactly 3 characters — is hand-implemented in Go, re-implemented in TypeScript, re-implemented again in Python. Nothing keeps those copies in sync. A "harmless" field rename ships, and three weeks later a consumer in another runtime discovers it in production. Breaking-change checks, where they exist at all, are per-tool and per-format: a linter for your proto files, a differ for your OpenAPI specs — and nothing that knows *who consumes what*.

## The solution

Bridge is a polyglot contract compiler and compatibility platform. You define data and service contracts once in the Bridge IDL. The compiler produces a canonical, hashable IR and from it:

- **generates** idiomatic, dependency-free Go / Rust / TypeScript / Python / Java / C# — types, enums, tagged unions, service clients, event envelopes — with **runtime validators for every constraint**, so the same rules are enforced in every runtime, not just one;
- **detects breaking changes** before they ship: `bridge diff` classifies every change SAFE / WARNING / BREAKING / UNKNOWN against the IR, and `bridge check` fails your pipeline (strict mode fails undecidable changes too — never silently safe);
- **governs contracts** in a content-addressed registry: SHA-256 identity, immutable versions, tamper detection, and a dependency graph (`dependents`, `dependencies`) so impact analysis becomes a query, not archaeology.

## See it in 30 seconds

Real commands, real output — from the [runnable examples](examples/):

```console
$ bridge validate payments.bridge
✓ payments.bridge ok (package payments.v1, hash 1f7292582f39)

$ bridge generate payments.bridge --language go
✓ wrote generated/go/enums.go
✓ wrote generated/go/go.mod
✓ wrote generated/go/roundtrip_test.go
✓ wrote generated/go/services.go
✓ wrote generated/go/types.go
✓ wrote generated/go/validate.go
6 file(s) written to generated/go (go)

$ bridge diff v1.payments.bridge v2.payments.bridge
BRIDGE COMPATIBILITY REPORT
package: payments.v1

❌ Breaking: Field renamed: Payment.currency → Payment.reference
⚠ Added enum value: PaymentStatus.REFUNDED

Summary: 0 safe, 1 warnings, 1 breaking, 0 unknown
Verdict: BREAKING
Compatibility: FAILED
```

That last one is the point: the rename a code reviewer would wave through fails the report — and `bridge check` (the CI form) exits non-zero so it never merges. Generated output is byte-deterministic: regenerating never produces diff churn, and a contract's hash is its identity.

## Why it matters

- **One contract, N languages — by compiler, not by discipline.** Hand-maintained bindings and per-language validators are where drift enters. Bridge generates all six languages and the validators from one IR, so parity is enforced, not hoped for.
- **Breaking changes are caught at merge time, with honest classification.** Checks are built into the compiler (not bolted onto a spec parser), deterministic, and conservative — an undecidable change is reported as UNKNOWN and fails the default gate.
- **The registry answers the question no other tool can:** "who consumes this contract, and what does this change do to them?" Content-addressed, immutable, with a real dependency graph — one registry for your services, events, and APIs, not one per wire format.
- **Built for the AI-agent era.** Agents calling typed tools are just more consumers of contracts. Bridge's constraint parity, deterministic hashing, and compatibility gates apply to machine-to-machine and model-to-tool surfaces the same way they apply to your Go and Python services.

## Architecture

```
                    Contract / IDL  (.bridge)
                         │
                  Compiler → canonical IR (frozen, SHA-256 hashed)
                         │
    ┌──────────┬─────────┼─────────┬──────────┐
    ▼          ▼         ▼         ▼          ▼
   Go      Rust      TS     Python     Java      C#
    └──────────┴─────┼─────┴──────────┬──┘
                     │                │
                     │          FFI / WASM (one contract,
                     │          callable across languages)
                     ▼                ▼
          Compatibility Engine   Registry Service
    (SAFE / WARNING / BREAKING / UNKNOWN)  (OIDC, tenancy,
                     │                     signing, audit)
        Contract Graph → Registry → CI Governance
                     │
              Dashboard (Next.js)
```

The nine packages behind this diagram (`bridge-core`, `bridge-compat`,
`bridge-generators`, `bridge-registry`, `bridge-cli`, `bridge-lsp`,
`bridge-serialization`, `bridge-registry-service`, `bridge-ffi`)
communicate only through the frozen IR — details in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Language support

Every target below is generated from the same IR — types, enums, tagged unions, aliases, constraint validators, service clients/traits, and event envelopes:

| Language | Status | Notes |
|----------|--------|-------|
| Go       | ✅ Shipped | stdlib only; `encoding/json` tags; validator methods |
| Rust     | ✅ Shipped | serde; `@pattern` limitations documented |
| TypeScript | ✅ Shipped | strict types; documented `int64` (2^53) caveat |
| Python   | ✅ Shipped | stdlib dataclasses; `to_dict`/`from_dict` round-trip |
| Java     | ✅ Shipped | JDK-only (zero deps, incl. a generated JSON runtime); Maven project file |
| C#       | ✅ Shipped | System.Text.Json only; .csproj; structural value equality |
| WASM     | ✅ Shipped | via `@bridge/ffi` (`wasm32` cdylib + wasm-bindgen types with `fromJson`/`toJson`/`validate` from JS) — not a `bridge generate --language` target |

Every generated language is compile-verified in CI against the runnable
examples, and every generated package ships a round-trip test. The FFI
layer additionally carries **service methods** across the boundary —
see [docs/FFI.md](docs/FFI.md).

## Status

**Bridge 0.2.0 — the roadmap through Phase 3 is shipped and tested: 669 tests green across nine packages (CLI 98, compat 101, core 154, FFI 10, generators 18, LSP 33, registry 65, registry-service 78, serialization 112), every generated language compile-verified, and the Go↔Rust FFI proven end to end on real builds.** See the [roadmap](docs/ROADMAP.md) and [open issues](https://github.com/Roy-Wanyoike/bridge/issues) for what's next.

| Area | Status |
|------|--------|
| Bridge IDL (lexer, parser, AST, semantic analysis) | ✅ Shipped |
| Canonical IR + deterministic schema hashing | ✅ Shipped |
| Canonical formatter (`bridge fmt`) | ✅ Shipped |
| Compatibility engine (`bridge diff`) | ✅ Shipped |
| Generators (Go / Rust / TypeScript / Python / Java / C#) | ✅ Shipped |
| CLI (init/validate/fmt/lint/generate/diff/check/impact/publish/pull/versions/inspect/search/doctor/version) | ✅ Shipped |
| Local registry (immutable, content-addressed) | ✅ Shipped |
| Examples + docs + verification scripts | ✅ Shipped |
| Cross-language serialization round-trip matrix (Go↔Rust↔TS↔Python) | ✅ Shipped |
| Event contracts + typed RPC clients/servers (every language) | ✅ Shipped |
| Consumer-aware impact analysis + CI governance (`bridge impact`, `bridge check --against`) | ✅ Shipped |
| Property-based + fuzz harnesses, deterministic caching | ✅ Shipped |
| LSP for the Bridge IDL (JSON-RPC over stdio) | ✅ Shipped ([#21](https://github.com/Roy-Wanyoike/bridge/issues/21)) |
| Java + C# generators | ✅ Shipped ([#25](https://github.com/Roy-Wanyoike/bridge/issues/25)) |
| Registry service (OIDC auth, multi-tenancy, signing, audit, rate limits, in-memory + PostgreSQL) | ✅ Shipped ([#18](https://github.com/Roy-Wanyoike/bridge/issues/18)) |
| Dashboard (Next.js: contracts, diff reports, dependency graph, audit) | ✅ Shipped ([#20](https://github.com/Roy-Wanyoike/bridge/issues/20)) |
| FFI (Go ↔ Rust over C ABI) + WASM target | ✅ Shipped ([#22](https://github.com/Roy-Wanyoike/bridge/issues/22)) |
| Release engineering (binaries, containers, SBOM, signing, npm) | ✅ Pipeline shipped ([#24](https://github.com/Roy-Wanyoike/bridge/issues/24)) — first release not yet cut (CI blocked by an Actions billing issue, see [RELEASE.md](RELEASE.md)) |

## Quick start

```sh
git clone https://github.com/Roy-Wanyoike/bridge.git
cd bridge
npm install && npm run build
alias bridge="node $(pwd)/packages/bridge-cli/dist/bin/bridge.js"

bridge init payments-service
cd payments-service
bridge validate                # compile the scaffolded contract
bridge generate --language go  # also: rust | typescript | python | java | csharp
bridge doctor
```

### Publish to a registry

The CLI talks to both a local, content-addressed registry directory **and** a running [registry service](packages/bridge-registry-service) over HTTP:

```sh
# local registry (default ./.bridge-registry)
bridge publish payments.bridge --owner team-pay

# HTTP registry service (auth + tenancy)
bridge-registry-service --port 4350 --token devsecret=acme:admin &
bridge publish payments.bridge \
  --registry http://localhost:4350 \
  --org acme --project payments --token devsecret
bridge versions payments.v1 --registry http://localhost:4350 \
  --org acme --project payments --token devsecret
```

`bridge pull`, `versions`, `inspect` and `search` accept the same `--registry` form; see `bridge help publish`.

Requires Node.js >= 22.

Read the [Quickstart](docs/QUICKSTART.md), the [IDL reference](docs/IDL_REFERENCE.md), and the [compatibility guide](docs/COMPATIBILITY.md). Browse the [runnable examples](examples/) — including [versioning](examples/versioning), a complete BREAKING diff, and [go-python](examples/go-python), a live round-trip of generated code.

## Documentation

| Doc | What it covers |
|-----|----------------|
| [docs/QUICKSTART.md](docs/QUICKSTART.md) | From empty directory to generated, verified code |
| [docs/IDL_REFERENCE.md](docs/IDL_REFERENCE.md) | The full Bridge IDL: enums, unions, services, events, constraints |
| [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) | The classification matrix, CI gates, GitHub Actions recipe |
| [docs/IMPACT.md](docs/IMPACT.md) | Consumer-aware impact analysis + CI governance (`bridge impact`) |
| [docs/EVENTS.md](docs/EVENTS.md) | Event contracts: CloudEvents-style envelopes, publishers, dispatchers |
| [docs/RPC.md](docs/RPC.md) | Typed RPC clients + HTTP server adapters, error model |
| [docs/SERIALIZATION.md](docs/SERIALIZATION.md) | Golden vectors: byte-identical wire round-trips (MessagePack/CBOR) |
| [docs/TESTING.md](docs/TESTING.md) | Test layers, property-based testing, fuzzing, repro instructions |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | The pipeline, the frozen IR contract, determinism guarantees |
| [docs/FFI.md](docs/FFI.md) | Go↔Rust FFI over the C ABI + WASM: symbols, ownership, panic containment |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Three-phase public roadmap, linked to issues |
| [docs/strategy/MARKET_ANALYSIS.md](docs/strategy/MARKET_ANALYSIS.md) | Landscape, market gaps, competitive matrix, risks |
| [docs/strategy/POSITIONING.md](docs/strategy/POSITIONING.md) | Positioning, category, pitches, product principles |

## Repository layout

```
bridge/
├── packages/
│   ├── bridge-core/             # IDL lexer, parser, AST, semantic analysis, canonical IR
│   ├── bridge-generators/       # Code generators: Go, Rust, TypeScript, Python, Java, C#
│   ├── bridge-compat/           # Compatibility engine: diff, classification, impact
│   ├── bridge-serialization/    # Wire formats (MessagePack/CBOR) + golden vectors
│   ├── bridge-registry/         # Contract registry (local, content-addressed)
│   ├── bridge-registry-service/ # Multi-tenant registry HTTP service (OIDC, audit, signing)
│   ├── bridge-ffi/              # Cross-language FFI (C ABI) + WASM target
│   ├── bridge-lsp/              # Language server for the IDL (JSON-RPC over stdio)
│   └── bridge-cli/              # The `bridge` command line interface
├── examples/                # Eight complete, runnable examples (seven with verified demo runs)
├── dashboard/               # Next.js registry console (demo mode + live client)
└── docs/                    # Public documentation + strategy
```

## Development

```bash
git clone https://github.com/Roy-Wanyoike/bridge.git
cd bridge
npm install
npm run build
npm test
```

Requires Node.js >= 22. The test suite covers all nine packages (669 tests: compiler, generators, compat + impact, serialization, local registry, registry service, FFI, LSP, CLI); the `scripts/verify-*.sh` files additionally type-check and round-trip the generated code for every example, including the Java and C# targets.

## Contributing

Bridge is an open-source project and contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md). Good first issues are labeled [`good first issue`](https://github.com/Roy-Wanyoike/bridge/labels/good%20first%20issue), and the [roadmap issues](https://github.com/Roy-Wanyoike/bridge/issues) are the fastest way to see where help is needed.

## License

[MIT](LICENSE)
