# Engineering Audit — Architecture

Part of the production-readiness audit suite (`docs/engineering/`). Every claim
below was verified against the working tree on the audit date; evidence is
cited as file paths and, where relevant, measured line/test counts. See
[ARCHITECTURE](../ARCHITECTURE.md) for the normative design description — this
document audits how closely the *implemented* repository matches it.

## 1. Actual monorepo layout

npm workspaces (`package.json` → `workspaces: ["packages/*"]`), Node >= 22,
TypeScript 5.9 project references (`tsconfig.base.json`), zero runtime
framework dependencies anywhere (each package's only dependency is another
`@bridge/*` workspace package or `@types/node`).

```
bridge/
├── package.json                 # workspaces root; build/lint/test scripts
├── tsconfig.base.json           # strict, NodeNext, declaration: true
├── .github/workflows/           # ci.yml, release.yml, bridge-governance.yml.example
├── packages/                    # 9 workspaces (the product)
│   ├── bridge-core/             # @bridge/core        ~4.9k src LOC — lexer→parser→semantic→IR, hash, fmt, cache, fuzz
│   ├── bridge-generators/       # @bridge/generators ~11.9k src LOC — go/rust/typescript/python/java/csharp
│   ├── bridge-compat/           # @bridge/compat      ~2.5k src LOC — diff/check/report + impact analysis
│   ├── bridge-serialization/    # @bridge/serialization ~1.4k src LOC — canonical JSON, MessagePack, CBOR, golden vectors
│   ├── bridge-registry/         # @bridge/registry    ~1.0k src LOC — content-addressed local store
│   ├── bridge-registry-service/ # @bridge/registry-service ~6.4k src LOC — HTTP API: auth, signing, audit, rate limits, memory+postgres
│   ├── bridge-cli/              # @bridge/cli         ~2.7k src LOC — 16-command `bridge` CLI
│   ├── bridge-ffi/              # @bridge/ffi         ~1.3k src LOC — rust-ffi / go-ffi / wasm glue generators
│   └── bridge-lsp/              # @bridge/lsp         ~1.3k src LOC — JSON-RPC language server over stdio
├── dashboard/                   # Next.js console (separate lockfile, vitest, 100 tests)
├── website/                     # Next.js static marketing site (separate lockfile)
├── marketing/                   # logo/video/image assets + generation tools
├── docs/                        # 10 normative docs + strategy/ (docs-facts-checked in CI)
├── examples/                    # 8 runnable examples, each with demo.mjs
├── scripts/                     # verify-*.sh gates, e2e-gate.sh, release-rehearsal.sh, check-docs-facts.mjs
├── docker/                      # bridge-entrypoint.sh (CLI vs `service` routing)
├── homebrew/                    # bridge.rb formula (release gate refuses :no_check digests)
├── Dockerfile                   # multi-stage: builds workspace, ships CLI + registry service
└── SECURITY.md, RELEASE.md, CONTRIBUTING.md, CODE_OF_CONDUCT.md, CHANGELOG.md
```

Source LOC (non-test `.ts`, measured): core 4,936 · generators 11,853 ·
compat 2,538 · serialization 1,417 · registry 1,049 · registry-service 6,354 ·
cli 2,671 · ffi 1,262 · lsp 1,329 — ≈ 33.4k lines of product TypeScript, plus
~1.5k lines of committed generator snapshots and the two Next.js apps.

## 2. The compiler pipeline as implemented

`packages/bridge-core/src/compiler/compile.ts` is the real pipeline; the
diagram below reflects the code, not the aspiration:

```
                    compileSource(text, path) / compilePackage(text, path, deps)
                                              │
  ┌───────────────────────────────────────────▼─────────────────────────────┐
  │ packages/bridge-core/src/compiler/compile.ts  (runPipeline, L84-116)    │
  │                                                                         │
  │  lexer.ts (347)      parser.ts (1,203)      semantic.ts (1,218)         │
  │  tokenize()    ──►   parse()           ──►   analyzeFile()              │
  │  BR1001-BR1003      AST (ast.ts 353)        BR2001-BR2019,              │
  │  recoverable        1-based line/col        BR2101-BR2103;              │
  │                     BR1004, BR1005          deps-resolved refs          │
  │                          │                        │                     │
  │                          └────── lowerPackage() ◄┘   (compile.ts L122+) │
  │                                   │                                     │
  │                                   ▼                                     │
  │                       IRPackage (ir/types.ts 167, marked FROZEN)        │
  │                       types sorted by name; imports sorted + deduped    │
  │                                   │                                     │
  │                 hashPackage(ir) = SHA-256(canonicalJson(ir))            │
  │                              (ir/hash.ts 69)                            │
  └─────────────────────────────────────────────────────────────────────────┘
            │ ok:false ⇒ { diagnostics } only — the pipeline never throws
            │ (unexpected state is reported as BR2999, compile.ts L100-115)
            ▼
  IRPackage ───► generators (6 langs) ───► GeneratedFile[] (byte-deterministic)
       ├────────► compat (diffPackages/check/impact) ───► CompatReport
       ├────────► registry (hash = content address) ───► .bridge-registry/
       └────────► serialization / ffi / lsp / cli (thin wrappers)
```

Verified behaviors that matter downstream: compile results are deterministic
(`cache.ts` + property tests prove identical IR/hash for identical input);
formatting is a fixpoint (`format.ts`, property-tested); a compile cache
exists as a library but is **not wired into the CLI** (`docs/TESTING.md`
declares this as a tracked follow-up).

## 3. Boundary discipline (measured, not asserted)

The architecture claim is that the IR is the only contract between packages.
Grep census of `from '@bridge/*'` imports across all non-test `src/` files:

| Package | Imports observed | Verdict |
| --- | --- | --- |
| `bridge-generators` | `@bridge/core` ×17 | clean — no parser/AST imports (grep `from '../|../../'` shows only intra-package modules) |
| `bridge-compat` | `@bridge/core` ×8 (+ 1 self-import for re-export) | clean |
| `bridge-serialization` | none (zero-dependency codecs + committed `vectors/vectors.json`) | clean |
| `bridge-registry` | `@bridge/core` ×6 (+1 self) | clean |
| `bridge-registry-service` | `@bridge/core` ×11, `@bridge/registry` ×5, `@bridge/compat` ×1 (diff endpoint) | clean — layered exactly as designed |
| `bridge-cli` | core ×11, registry ×10, generators ×4, compat ×4 | clean — `@bridge/registry-service` appears **only in a test** (`src/test/registry-http.test.ts` uses `InMemoryDriver`; it is a devDependency) |
| `bridge-ffi` | `@bridge/core` ×6, `@bridge/generators` ×2 (reuses Rust/Go type renderers) | clean — documented dependency |
| `bridge-lsp` | `@bridge/core` ×2 | clean |

No package reaches into another package's internals (no deep imports past a
package root were found). This matches the dependency table in
[ARCHITECTURE](../ARCHITECTURE.md) §table exactly.

### Dependency graph (implementation truth)

```
                 @bridge/core  (no deps)
                /   |    \     \
               /    |     \     \
     @bridge/   @bridge/  @bridge/  @bridge/lsp
     generators compat    registry      (core only)
      /    \        \        |
@bridge/   @bridge/  @bridge/serialization (no deps)
   ffi      cli ──────┤ (core+generators+compat+registry)
              |
     @bridge/registry-service (core+registry+compat)
```

## 4. What's clean

- **Package boundaries are real.** The import census above shows the IR as the
  sole cross-package channel; the CLI→registry-service edge exists only in
  tests.
- **Determinism is enforced, not aspirational.** Sorted IR arrays
  (`compile.ts` L133-135), defensive re-sorting in `generate()`
  (`generators/src/index.ts` L10-17), no timestamps in headers
  (`header.ts`), canonical ordering of compat changes (`report.ts`), and a
  committed-seed property harness (`bridge-core/src/test/property/harness.ts`).
- **Compiler discipline.** Never-throw contract with `BR2999` as the internal
  escape hatch, recoverable parse errors, stable diagnostic codes
  (`semantic.ts` L67-90), and a structure-aware fuzzer asserting the contract
  (`fuzz/fuzz.ts`).
- **Zero-dependency posture.** `bridge-serialization` and the registry service
  carry no third-party runtime deps (JWT/JWKS, ed25519, CBOR, MessagePack are
  hand-rolled on `node:crypto`/pure TS) — a small, auditable supply chain.
- **Docs are CI-checked.** `scripts/check-docs-facts.mjs` fails the build on
  stale counts/dropped canonical facts (wired into `ci.yml` L44-45).

## 5. What's duplicated

- **PRNG duplication by design, worth monitoring.** The mulberry32/splitmix
  harness is copied between `bridge-core/src/test/property/harness.ts` and
  `bridge-core/src/fuzz/fuzz.ts` (the latter's comment says "kept identical …
  so seeds mean the same thing"). A shared module would remove the drift risk;
  today it is documented, deliberate duplication.
- **Per-language emission logic is inherently parallel** (~11.9k LOC in
  generators). Shared modules exist (`mappings.ts`, `wire.ts`, `naming.ts`,
  `header.ts`, `docs.ts`, `analysis.ts`) and the cross-language constants
  (CloudEvents envelope, RPC error table) live in exactly one place
  (`wire.ts`), but six emitters remain six emitters — snapshot tests + the
  cross-language wire tests are the control that keeps them honest.
- **JSON-RPC/HTTP plumbing** is implemented twice: `bridge-lsp/src/jsonrpc.ts`
  (stdio) and `bridge-registry-service/src/server.ts` (HTTP). They solve
  different problems; no action needed, but they are the two largest "utility"
  modules in the repo.

## 6. What's missing vs the target architecture

- **No consumer of the compile cache** — `cache.ts` ships property-tested but
  nothing imports it in production code (docs/TESTING.md admits this).
- **No metrics/tracing surface** on the registry service (`/healthz` only;
  logging is `console.*` in `bin/bridge-registry-service.ts`) — fine for a
  self-hosted service, a gap for a hosted one.
- **No published npm consumption story exercised in CI** beyond the release
  workflow's dry-run (first release not yet cut — ROADMAP).
- **AI-native emission (tool-call/MCP schemas)** is the one open roadmap phase
  (`docs/ROADMAP.md` Phase 3 last row); it slots in as another `@bridge/*`
  consumer of the IR without architectural change.
- **Website/dashboard CI parity**: `ci.yml` gates the dashboard; the `website/`
  app has its own check script (`website/scripts/check-site.mjs`) but no CI
  workflow invokes it.

**Assessment:** the implemented architecture matches the documented one to an
unusual degree — boundaries, determinism and the never-throw contract are all
machine-checked. The remaining gaps are product-surface gaps (cache wiring,
observability, distribution), not structural debt.
