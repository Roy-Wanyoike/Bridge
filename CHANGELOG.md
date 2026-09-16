# Changelog

All notable changes to Bridge are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] — production-readiness pass

### Fixed

- **Dashboard: live-by-default production builds** (#74): demo mode no
  longer serves fabricated registry data in production when
  `NEXT_PUBLIC_DEMO_MODE` is forgotten — prod starts live and fails loud
  with an actionable `RegistryMisconfigured` error; `next dev` keeps the
  zero-setup demo default.
- **Dashboard: demo disclosure on mobile** (#75): compact DEMO/LIVE chip
  in the header row below 1024px.
- **Dashboard: honest error boundary** (#76): registry failures are
  detected by stable message prefixes across the RSC serialization
  boundary — the tailored "check NEXT_PUBLIC_REGISTRY_URL" copy now
  actually renders.
- **Dashboard: data-layer performance** (#77): contract detail batches
  all adjacent-pair diffs in one round (was N−1 serial); overview fan-out
  capped at 8 in flight; graph page fetches parallelized; audit filters
  applied server-side.
- **Dashboard: URL correctness** (#78): every registry path segment and
  data-built link is percent-encoded; diff deep links with unknown
  versions return 404 instead of silently rendering a different diff.
- **Dashboard: trust batch** (#79): fabricated "objects in the store"
  metric removed; publish-time-ordered attention list; org-scoped
  project dropdown; scope switcher only on /contracts; live-mode default
  port corrected to 4350; repository link rendered as a real anchor;
  demo severity no longer inflates affected counts.
- **Dashboard: accessibility** (#80): dialog background made inert,
  visible tabpanel focus, verdict text in graph node labels, full
  language names in badge aria-labels, prefers-reduced-motion guard,
  skip-to-content link, no skipped heading levels, dead code removed.
- **Lint: zero warnings everywhere** (#81): the registry-service and
  generator warning sites fixed honestly — including a real latent bug
  where the Java sample value for a json-typed field emitted
  syntactically invalid Java; lint gate tightened to `--max-warnings 0`.

## [0.2.0] — the platform era

### Added

- **Java + C# generators** (#25): deterministic, zero-dependency output
  with full IR coverage (structs, enums, tagged unions, constraints,
  events, HTTP clients/servers); compile-verified per example (ECJ and
  dotnet), CI jobs wired; `bridge generate --language java|csharp`.
- **Registry service** (`@bridge/registry-service`, #18): multi-tenant
  HTTP API over a pluggable storage driver — org/project isolation,
  OIDC (RS256/ES256 via JWKS) or static tokens, ed25519 artifact
  signing with tamper detection, append-only filterable audit log,
  token-bucket rate limiting, OpenAPI 3.1 document; in-memory driver +
  PostgreSQL driver (dependency-free wire-protocol client, SCRAM-SHA-256,
  migrations). Cross-tenant access is indistinguishable from unknown (404).
- **Dashboard** (`dashboard/`, #20): Next.js console for the registry —
  overview, contract pages, compatibility reports, SVG dependency graph,
  audit log; typed client against the service API; demo mode with zero
  backend.
- **FFI** (`@bridge/ffi`, #22): one contract crosses language boundaries
  as functions — Rust C-ABI cdylib (handler registry, panic containment,
  single ownership rule, stable status codes) + Go cgo client sharing the
  same generated C header + wasm32/wasm-bindgen target with typed TS
  wrappers. Verified end to end: Go links the built Rust library and
  round-trips through C.
- **Release engineering** (#24): tag-to-release pipeline — bun-compiled
  CLI binaries for 5 platform targets, SHA-256 checksums, keyless cosign
  signing, SPDX/CycloneDX SBOMs, multi-arch container images, npm
  publishing, Homebrew formula (`RELEASE.md`).
- **LSP** (`@bridge/lsp`, #21) and **property/fuzz harnesses** (#23)
  shipped during the run-up to 0.2.0 (no 0.1.x releases were cut);
  the roadmap through Phase 3 is now complete.
- **Serialization matrix** (`@bridge/serialization`, #31): golden
  vectors + property tests proving byte-identical cross-language
  round-trips — 50 values × 2 wire formats (MessagePack + CBOR) × 2
  directions, plus reject vectors, verified in TypeScript, Go, Rust and
  Python (`scripts/verify-serialization.sh`, wired into CI).
- **Events + RPC** (#29): typed CloudEvents-style event
  publishers/consumers/dispatchers and JSON-over-HTTP RPC clients +
  server adapters generated in every language; cross-language pairing
  proven over real TCP loopback (`scripts/verify-events-rpc.sh`, the
  `examples/events-rpc` demo).
- **Consumer-aware impact analysis** (`bridge impact`, #28): walks the
  registry's dependency graph, reports which consumers a change reaches
  (and through what), and gates CI (`--strict`); `check --against` diffs
  against a published registry version. Markdown/JSON reports for PR
  comments and automation.
- **Audit-hardening wave**: a full-surface audit of the shipped code
  produced fixes across the stack — registry-service secure-by-default
  posture (rate limiting on, sane timeouts, stricter DSN/auth handling),
  compiler robustness and new diagnostics (`BR1005`, `BR2104`,
  `BR2016`–`BR2019`: constraint arity, recursive structs, RE2 `@pattern`,
  set element rules), generator fixes for generated code that failed to
  compile (Java/C# + CBOR timestamps), CLI correctness (git-conformant
  diff hunks, JSON output contract, arg parsing), and CI unmasking
  (generator-verify jobs no longer `continue-on-error`; dashboard and
  PostgreSQL jobs added; least-privilege workflow permissions).

### Changed

- README and roadmap updated to the shipped state; six target languages
  (Go, Rust, TypeScript, Python, Java, C#) plus WASM; nine packages.
- **CLI** gained `bridge impact` — the command surface is now 16 commands
  (`init` `validate` `fmt` `lint` `generate` `diff` `check` `impact`
  `publish` `pull` `versions` `inspect` `search` `doctor` `version`
  `help`).

## [0.1.0] — initial public pipeline

### Added

- **Compiler pipeline** (`@bridge/core`)
  - Bridge IDL: `package`, `import`, `type`, `enum`, `union`, `alias`,
    `service`, `event`; optional fields (`T?`), defaults, constraints
    (`@min`, `@max`, `@length`, `@email`, `@url`, `@pattern`, `@uuid`),
    deprecation, `///` doc comments.
  - 13 primitives (`string`, `bool`, `int32`, `int64`, `uint32`, `uint64`,
    `float32`, `float64`, `bytes`, `uuid`, `timestamp`, `decimal`, `json`)
    and composites (`list`, `set`, `map` with hashable-key rule).
  - Lexer → parser (AST with source locations) → semantic analysis →
    canonical IR; recoverable diagnostics with stable codes (`BR1001`–
    `BR2103`), did-you-mean hints and source-snippet rendering.
  - Canonical source formatter (`formatSource`, idempotent).
  - Deterministic content hashing: `hashPackage` = SHA-256 over canonical
    JSON (sorted keys); `shortHash` for display.
- **Compatibility engine** (`@bridge/compat`)
  - `diffPackages` / `check` comparing two package versions with
    classification into SAFE / WARNING / BREAKING / UNKNOWN, rename
    synthesis, strict + compatible gate modes, deterministic text and JSON
    reports.
- **Code generators** (`@bridge/generators`)
  - Go, Rust, TypeScript and Python targets from one IR package: types,
    enums, tagged unions, aliases, validators for constraints, service
    traits/clients and event envelopes.
  - Byte-deterministic output; `Code generated by bridge DO NOT EDIT.`
    headers without timestamps; documented type-mapping table (including
    the TS `int64` 2^53 caveat and the Rust `@pattern` limitation).
- **Local registry** (`@bridge/registry`)
  - Content-addressed, immutable contract store
    (`publish`/`pull`/`verify`/`inspect`/`latest`/`versions`/`list`/
    `search`/`dependents`/`dependencies`) with atomic writes, tamper
    detection and a rebuilt-on-publish index.
- **CLI** (`bridge-cli`): `init`, `validate`, `fmt`, `lint`, `generate`,
  `diff`, `check`, `publish`, `pull`, `versions`, `inspect`, `search`,
  `doctor`, `version`.
- **Examples** (`examples/`): seven runnable examples — payments,
  hello-world, versioning (BREAKING diff), compatibility (SAFE/WARNING
  diff), go-typescript, go-python (live generated-Python round-trip) and
  registry — each with a README containing exact commands and verbatim
  expected output, plus a verified `demo.mjs` per example.
- **Generated-code verification** (`scripts/`)
  - `generate-all.mjs` regenerates every example contract into all four
    languages; `verify-python.sh` (ast.parse + import + generic
    `to_dict`/`from_dict` round-trip), `verify-ts.sh` (workspace `tsc`,
    strict, 0 errors), `verify-go.sh` / `verify-rust.sh` (`go vet`/`build`,
    `cargo check`/`clippy` — graceful skips without local toolchains, CI
    enforces), and `verify-all.sh`.
- **CI**: build + test matrix, generated-code verification wired for
  toolchains unavailable locally.
- **Documentation** (`docs/`): [QUICKSTART](docs/QUICKSTART.md),
  [IDL_REFERENCE](docs/IDL_REFERENCE.md),
  [COMPATIBILITY](docs/COMPATIBILITY.md),
  [ARCHITECTURE](docs/ARCHITECTURE.md) — cross-linked and verified against
  the shipped APIs.

[0.2.0]: https://github.com/Roy-Wanyoike/bridge/releases/tag/v0.2.0
[0.1.0]: https://github.com/Roy-Wanyoike/bridge/releases/tag/v0.1.0
