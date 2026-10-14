# Engineering Audit — Testing

Runner: Node's built-in `node --test` over compiled `dist/` for all nine
workspace packages (`"test": "tsc -p . && node --test …"` in each
`package.json`); vitest (jsdom) for the dashboard. All counts below were
**measured by executing the suites** on the audit date, not taken from docs.

## 1. Measured per-package inventory

| Package | Test files¹ | Tests | Pass | Fail | Skipped | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| bridge-core | 11 (3 property) | 172 | 172 | 0 | 0 | lexer/parser/semantic/ir/hash/format/errors/example + property (core, cache, fuzz) |
| bridge-generators | 6 | 86 | 82 | 0 | **4** | skips are the toolchain-gated adversarial compile gates (go/cargo/javac/dotnet absent locally) — loud, `STRICT_SKIP=1` turns them into failures |
| bridge-compat | 4 (1 property) | 109 | 109 | 0 | 0 | diff/report/impact + compat property suite |
| bridge-registry | 2 | 65 | 65 | 0 | 0 | store + versioning |
| bridge-serialization | 6 (1 property) | 112 | 112 | 0 | 0 | canonical/cbor/msgpack/timestamp/vectors + roundtrip property |
| bridge-registry-service | 9 | 101 | 101 | 0 | 0 | server/auth/hardening-auth/hardening-server/postgres/driver/validation/wire/bin |
| bridge-cli | 6 | 136 | 136 | 0 | 0 | basics/pipeline/impact/registry/registry-http/hardening |
| bridge-ffi | 1 | 12 | 12 | 0 | 0 | glue generation invariants incl. "no TODO in output" |
| bridge-lsp | 1 | 38 | 38 | 0 | 0 | full JSON-RPC duplex harness over in-memory transports |
| **Workspace total** | **46** | **831** | **827** | **0** | **4** | matches the ROADMAP's "831 tests across nine packages" exactly |
| dashboard (vitest) | 18 | **167** | 167 | 0 | 0 | pages, components, registry client, hrefs; suite grew to 167 with the OIDC-gate tests (#163) |

¹ `.test.ts` files under `src/test/`; property files counted separately.

Reproduction: `npm test --workspaces --if-present` at the repo root (node
v24.21.0 used for the audit run); dashboard via `cd dashboard && npm test`.

## 2. Test layers in place

| Layer | Implementation | Evidence |
| --- | --- | --- |
| Unit / functional | Every package; node:test, no external assertion lib | `packages/*/src/test/*.test.ts` |
| Property-based | **Hand-rolled seeded harness** — mulberry32 PRNG, committed base seed + iteration counts, `BRIDGE_PROPERTY_SEED/CASE/ITERATIONS` overrides for reproduction; *not* fast-check (zero deps) | `bridge-core/src/test/property/harness.ts` L109+; docs/TESTING.md property list (core: parse-ability, fmt fixpoint, determinism, cache identity; compat: purity, removing-required= BREAKING, adding-optional=SAFE; serialization: encode→decode→encode byte-identity, hostile-byte decoder stability) |
| Fuzzing | Structure-aware mutator over valid corpora (delete/insert/duplicate/swap/truncate + hostile bytes); asserts never-throw + never-BR2999 + no hangs (deadline + child-process timeout); fully replayable (`--seed/--case`) | `bridge-core/src/fuzz/fuzz.ts` (502 LOC), `bin/bridge-fuzz.js`, `npm run fuzz --workspace @bridge/core` |
| Golden vectors | Committed hex fixtures verified byte-identically across 4 runtimes | `bridge-serialization/vectors/vectors.json` + `runtimes/{go,rust,python}` + `scripts/verify-serialization.sh` (CI `serialization-matrix` job) |
| Snapshot (byte-level) | Generator output committed per language, incl. emitted test files | `bridge-generators/src/test/__snapshots__/` (go/rust/typescript/python/java/csharp) |
| Adversarial compile gates | Generated code for a hostile fixture is actually *compiled/executed* per toolchain: python3 ast+import+roundtrip, `go build`, `cargo build`, `javac --release 17`, `dotnet build`; loud skip without toolchain; `STRICT_SKIP=1` fails instead | `bridge-generators/src/test/adversarial-compile-gates.test.ts`; `ts.createProgram` TS gate never skips |
| Cross-language interop (generated code) | `scripts/verify-go.sh` (vet+test), `verify-rust.sh` (check+clippy+test), `verify-java.sh` (javac+round-trip), `verify-csharp.sh` (dotnet+round-trip) — **CI jobs exist for all four**; `verify-ts.sh` (workspace tsc, strict) and `verify-python.sh` (round-trip) are local-only | `.github/workflows/ci.yml` L50-119; docs/TESTING.md local-only list |
| Service integration | Full HTTP server tests over in-memory driver; PostgreSQL driver exercised against a real PG 16 service container in CI; CLI tests spin the service via `InMemoryDriver` | `ci.yml` L145-175; `bridge-cli/src/test/registry-http.test.ts` L14 |
| End-to-end acceptance | 25-step `scripts/e2e-gate.sh` against the built workspace (CLI front door → registry → governance → release binary smoke); `STRICT_SKIP=1` for CI contexts | `scripts/e2e-gate.sh` |
| Docs-facts guard | `scripts/check-docs-facts.mjs` fails CI on stale counts / dropped canonical facts | `ci.yml` L44-45 |

## 3. Cross-language interop reality

- **Wire interop (serialization)** is the strongest layer: 4-language matrix
  (TS + Go + Rust + Python) over committed golden vectors, CI-gated
  (`serialization-matrix`), plus property tests for decoder robustness.
- **Generated-code interop (RPC/events)** is verified by the events-rpc
  script (`scripts/verify-events-rpc.sh`) and per-language round-trip tests,
  but that gate is **local-only** — no CI workflow invokes it (declared in
  the script and docs/TESTING.md; confirmed by inspecting `ci.yml`).
- **FFI interop** (Go calling the built Rust cdylib over the C ABI) is real
  and scripted (`scripts/verify-ffi.sh` builds the cdylib and runs the cgo
  client's tests against it) — also local-only.
- Caveat on all CI claims: runs are currently blocked by the Actions billing
  lock (ROADMAP, issue #127), so CI-gated layers were validated by *workflow
  definition* plus local runs during development, not by green runs on the
  audit date.

## 4. Coverage gaps

1. **No coverage instrumentation** — no `c8`/`nyc`/istanbul in any
   `package.json`; node:test supports `--experimental-test-coverage` unused.
   Unmeasured regions likely include `cache.ts` (no production consumer) and
   error paths of the service bin.
2. **No property/fuzz campaign for the registry service** — hardening suites
   are example-driven; only the compiler has a fuzz harness.
3. **Dashboard E2E** — vitest renders server components in jsdom; there is no
   browser-run test of the built app (demo-live parity is a script,
   `demo-live-parity.mjs`, not wired into CI).
4. **LSP tested over in-memory transports only** — no smoke test launching
   the real stdio bin.
5. **Generators**: 4 of 5 non-TS adversarial gates skip without toolchains —
   on a bare machine, Rust/Java/C# output is snapshot-verified but not
   compile-verified.
6. **No performance tests** — determinism is proven, latency/throughput is
   unmeasured (no benchmark files anywhere).

## 5. Recommendations (ordered)

1. Unlock CI (#127) — every layer above is already wired or one job away.
2. Add `verify-ts.sh` + `verify-python.sh` to the `build-test` job (both are
   fast and dependency-light) and a `verify-ffi` job (go + rust setup) —
   this closes the local-only gap for the highest-risk layers.
3. Turn on `node --test --experimental-test-coverage` report-only in CI; set
   a soft floor per package.
4. Wire `dashboard npm run parity` into the dashboard job.
5. Add a service-level property/fuzz pass (route fuzzing over the in-memory
   driver) reusing the existing seeded-harness pattern.
6. Fix the stale dashboard count (94 → 167) — done in the #163 wave in `docs/TESTING.md` +
   `docs/ROADMAP.md` and teach `check-docs-facts.mjs` to pin it.
