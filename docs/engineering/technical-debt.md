# Engineering Audit — Technical Debt

Categorized, evidence-cited inventory of debt and drift risk. Severity:
**H**igh (blocks a public 1.0 or misleads users) · **M**edium (slows work or
narrows guarantees) · **L**ow (polish). Each item names the fix.

## Census first: TODO / FIXME / HACK / XXX

`grep -rE "TODO|FIXME|HACK|XXX|unimplemented"` over `packages/**/src`:

| Pattern | Matches | Where |
| --- | --- | --- |
| `TODO` in source | **0** | only mention is the *test* asserting generated output contains none (`bridge-generators/src/test/generators.test.ts:35`, mirrored `bridge-ffi/src/test/ffi.test.ts:33`) |
| `FIXME` / `HACK` / `XXX` | **0** | — |
| `unimplemented` | 13 files | **not debt**: it is the canonical RPC 501 error code (`bridge-generators/src/wire.ts:57`), emitted into generated server tables and their snapshots; `dashboard/src` has zero matches |

A clean census is itself a finding: the repo carries its debt in docs and
issue numbers, not in comments. The debt below is therefore structural or
process debt, located by inspection.

## 1. Compiler (`@bridge/core`)

| # | What | Where | Impact | Remediation | Sev |
| --- | --- | --- | --- | --- | --- |
| C1 | Compile cache is dead code in production paths — property-tested (`cache.property.test.ts`) but nothing imports `cache.ts` outside tests | `packages/bridge-core/src/cache.ts` (174 LOC); `docs/TESTING.md` "Deterministic compilation cache" | Repeat `bridge generate` recompiles identical sources; the determinism guarantee the cache exists to speed up is paid for but unused | Wire into `bridge-cli/src/compile.ts` keyed on (source hash, compiler version); gate behind `--cache` first | **H** (declared follow-up, oldest drift risk) |
| C2 | `BR2104` lives in the parser, not the semantic `CODES` table — diagnostic-code provenance is split across two files | `bridge-core/src/parser.ts:71` vs `semantic.ts:67-90` | A future "list all codes" refactor can miss it; docs already list BR2104 with the semantic family | Move the constant into the shared `CODES` table (or a dedicated module both import) | L |
| C3 | Doc drift: `docs/TESTING.md` and `docs/ROADMAP.md` say the dashboard suite is 94 tests; measured run is **100** | `docs/TESTING.md:10`, `docs/ROADMAP.md:9` | `check-docs-facts.mjs` exists precisely to stop this; these two numbers predate the latest dashboard tests or aren't covered by it | Update both numbers; extend check-docs-facts to pin the dashboard count | M |
| C4 | Property harness + fuzz PRNG are copy-pasted twins that must never diverge (seeds share meaning) | `bridge-core/src/test/property/harness.ts:26-49` vs `bridge-core/src/fuzz/fuzz.ts:41-49` | A one-sided "fix" silently breaks cross-tool seed reproduction | Extract `src/testing/prng.ts` imported by both (test-only import keeps runtime dep graph clean) | L |

## 2. Generators (`@bridge/generators`)

| # | What | Where | Impact | Remediation | Sev |
| --- | --- | --- | --- | --- | --- |
| G1 | Generated **Rust validators skip `@pattern`** — the only constraint silently not enforced everywhere | `docs/IDL_REFERENCE.md` constraints table (declared); `gen/rust.ts` validate emission | A contract relying on `@pattern` is *less safe* in Rust than in Go/TS/Python/Java/C#; silent downgrading of a documented guarantee | Either emit a checked regex (RE2 semantics ≈ `regex` crate) or make generation fail/warn loudly when `@pattern` + rust target combine | **H** (correctness asymmetry, admitted but live) |
| G2 | Cross-package references generate opaque aliases (`json.RawMessage`/`unknown`/`Any`) | `analysis.ts crossPackageRefs` (used by every `gen/*.ts`); `docs/IDL_REFERENCE.md` "Cross-package references" | Type safety holes at org seams unless consumers generate the dependency too; a known, documented limitation rather than a bug | Multi-package generation mode (`generate(ir[], {language})`) that links imports — scaffolding exists (`scripts/generate-all.mjs`) | M |
| G3 | 4 of 6 adversarial compile gates skip when toolchains are missing locally | `gen/../test/adversarial-compile-gates.test.ts:161-231` (go/cargo/javac/dotnet skip-gated; TS never skips) | On a bare machine, Rust/Java/C# output correctness rests on committed snapshots + CI jobs that are **currently not running** (billing lock #127) | Keep `STRICT_SKIP=1` runs in any pre-release checklist; wire `verify-java.sh`/`verify-csharp.sh` equivalents into the adversarial suite as CI already does | M (until CI runs) |
| G4 | Six emitters share constants but not structure; per-language divergence bugs are found case-by-case | `gen/*.ts` (~11.9k LOC total), controlled by `wire.ts` + snapshots | Every new IR feature costs 6 implementations; the python-field-clobber bug class (`python-field-clobber.test.ts`) shows the failure mode | Already mitigated by snapshots + wire tests; consider a shared "emit plan" IR → per-language renderer split if a 7th target lands | L |

## 3. Registry & registry-service

| # | What | Where | Impact | Remediation | Sev |
| --- | --- | --- | --- | --- | --- |
| R1 | Static tokens are the primary documented bootstrap path; real deployments must self-host JWKS/OIDC to be production-shaped | `registry-service/src/auth.ts` header comment ("Not a production mechanism"), `TOKEN_MIN_LENGTH=32` entropy floor `auth.ts:59` | Static tokens have no expiry, rotation story, or per-credential audit identity beyond `publishedBy` | Ship a token-issuance CLI/API (`bridge-registry-service tokens create --org … --scope …`) with expiry + rotation | **H** for hosted use |
| R2 | In-memory driver's audit log is a bounded ring (10k) — restart loses history | `audit.ts` `MEMORY_SINK_CAPACITY = 10_000`; `FileAuditSink` exists as alternative | Compliance expectations ("who published what") silently degrade on the default driver | Default the bin to `FileAuditSink` when driver=memory unless explicitly disabled | M |
| R3 | No metrics endpoint (only `/healthz`), console-only logging | `server.ts:287` (`/healthz` "not rate-limited"), `bin/bridge-registry-service.ts` logging | Hosted operation can't see rate-limit pressure, auth failures, latencies | Expose a minimal `/metrics` (Prometheus text) fed by the counters the code already tracks (buckets, audit rows) | M |
| R4 | OpenAPI document duplicates route knowledge that also lives in `server.ts` routing (hand-written by intent) | `openapi.ts` vs `server.ts` | Route/param drift possible; a drift test exists only indirectly through server tests | Add a test asserting every route in `server.ts` appears in `openApiDocument()` paths | L |
| R5 | Local registry and service driver implement overlapping metadata validation | `bridge-registry/src/store.ts:56-70` (`assertMetaShape`) vs `registry-service/src/validation.ts` | Two validators can drift on what "valid meta" means | Extract shared meta-schema into `@bridge/registry` consumed by both | L |

## 4. Dashboard

| # | What | Where | Impact | Remediation | Sev |
| --- | --- | --- | --- | --- | --- |
| D1 | **No auth gate** — live mode renders registry data to anyone with the URL; the OIDC gate is not started in-tree | `dashboard/src/lib/` has no `auth/` (verified); next.config.ts comment defers auth to "deployment concern"; issue #163 | The console leaks contract metadata/diffs in live deployments unless network-isolated | Ship the `src/lib/auth/` middleware (OIDC code flow, session cookie) before any public live deployment; `vercel.json` currently bakes `NEXT_PUBLIC_DEMO_MODE=true`, which is the real stopgap | **H** (gating item for live mode) |
| D2 | Demo/live parity is script-checked, not CI-checked | `dashboard/scripts/demo-live-parity.mjs`; `ci.yml` dashboard job runs lint/typecheck/build/test only | Drift between fabricated demo data and real API shapes would pass CI | Add `npm run parity` to the dashboard CI job | M |
| D3 | `NEXT_PUBLIC_DEMO_MODE` boolean parsing warns but coerces unknown values to the default | `registry-client.ts:46-59` | A typo'd env var (`TRUE`) silently flips prod behavior toward the *safe* default (live) — safe direction, but surprising | Accept the current behavior; document in README (already partially) or fail the build on unrecognized values | L |

## 5. Tooling / CI / release

| # | What | Where | Impact | Remediation | Sev |
| --- | --- | --- | --- | --- | --- |
| T1 | **CI is not running** — workflows are complete but Actions is blocked by a billing lock | `docs/ROADMAP.md` Phase 1 table + issue #127; `.github/workflows/ci.yml` exists and is valid | Every "CI enforces X" claim above is currently enforced by local runs only; regression risk accumulates silently | Resolve #127; until then run `scripts/verify-all.sh` + `scripts/e2e-gate.sh` per tagged pre-release | **H** (meta-risk over everything else) |
| T2 | Four verification gates are local-only by declaration | `scripts/verify-ts.sh`, `verify-python.sh`, `verify-ffi.sh`, `verify-events-rpc.sh` (each states "not wired into any CI workflow"; TESTING.md agrees) | TS/Python/FFI/events regression coverage is laptop-dependent | Add `verify-ts`+`verify-python` to the build-test job (cheap), `verify-ffi` to a new job with go+rust setup | M |
| T3 | No dependency scanning / SBOM at *development* time | no `dependabot.yml`/`codeql.yml` under `.github/` (verified listing); SBOMs exist only in the release pipeline (`release.yml` anchore/sbom-action) | Supply-chain posture is strong for artifacts, blind for the repo itself | Enable Dependabot (npm + actions) and CodeQL; both are config-only | M |
| T4 | No code-coverage instrumentation anywhere | no `c8`/`nyc` in any `package.json` (verified); test counts are the only quality metric | Untested-region blind spots (e.g. `cache.ts` CLI paths) can't be seen | Add `node --test --experimental-test-coverage` (zero deps) to the build-test job, report-only | L |
| T5 | No performance/benchmark suite | repo-wide grep for benchmark/perf harnesses: none | "Deterministic" is proven; "fast" is not measured — the 8 MB body cap and rate limits are the only perf-adjacent numbers | One micro-bench (compile + generate over `payments.bridge`) with committed baselines is enough for 1.0 | L |
| T6 | Release pipeline never executed end-to-end (no tag has ever been cut) | `release.yml` untested in anger; ROADMAP: "the first release is not yet cut" | First real tag will be the first real test of guard/binaries/signing/manifest merge | `scripts/release-rehearsal.sh` exists — run it and record results before 1.0 | M |

## Priority order for remediation

1. T1 (unlock CI) — it converts every other "should hold" into "is held".
2. D1 (dashboard OIDC gate) + R1 (token issuance) — the two real security gaps.
3. G1 (Rust `@pattern` asymmetry) — a silent enforcement gap in generated code.
4. C1 (wire the compile cache) and T2 (local-only gates into CI).
5. Everything else as capacity allows; nothing else blocks a careful 1.0.
