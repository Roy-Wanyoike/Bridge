# Engineering Audit — Feature Matrix

Evidence-based inventory of what Bridge actually implements. Verified against
the working tree; tests counts are from a measured run (see
[testing-audit](./testing-audit.md)). Legend: ✅ supported · 🟡 partial /
constrained · ❌ missing.

## 1. IDL language features

Spec: [IDL_REFERENCE](../IDL_REFERENCE.md). Implementation: `@bridge/core`
(`lexer.ts`, `parser.ts`, `semantic.ts`, `compiler/compile.ts`).

| Feature | Status | Evidence |
| --- | --- | --- |
| `package` / `import` headers | ✅ | `parser.ts`; `BR2007`/`BR2008`/`BR2006`; `compilePackage` deps map |
| `type` (struct) + fields | ✅ | `lowerField` in `compiler/compile.ts` L181 |
| `enum` (variants, deprecation) | ✅ | `lowerBody` case `enum` |
| `union` (tagged sum) | ✅ | `lowerBody` case `union`; variants are field-shaped |
| `alias` | ✅ | `lowerBody` case `alias`; compat treats target change as BREAKING |
| `service` + methods | ✅ | `lowerService`; struct-only signatures (`BR2010`) |
| `event` declarations | ✅ | `lowerEvent`; envelope helpers in generators |
| Optional fields (`T?` / `name?`) | ✅ | `lowerField` L183-184; `BR2104` redundant-marker warning in `parser.ts` L71 |
| Defaults (`= literal`) | ✅ | `lowerDefaultValue` — strings keep quoting in IR |
| Constraints `@min @max @length @email @url @pattern @uuid` | ✅ | `lowerConstraint` L213-236; applicability `BR2013`, arity `BR2016` |
| Custom constraint messages (trailing string) | ✅ | IR `IRConstraint.message`; travels into validators |
| `@deprecated` (+ reason) on types/fields/variants/methods | ✅ | IR `deprecated`; surfaced in generated code + compat reports |
| `///` doc comments into IR + generated docs | ✅ | `docs?` on every IR node; `docsLines`/`pythonDocstring` in generators |
| 13 primitives incl. `bytes uuid timestamp decimal json` | ✅ | `IDL_REFERENCE` mapping table; `mappings.ts` |
| `list<T>` / `set<T>` / `map<K,V>` | ✅ | `lowerType`; set-element hashability `BR2019`, map-key `BR2011` |
| Cross-package references | 🟡 | Compiles + validates via deps; generated code renders **opaque aliases** (`json.RawMessage`/`serde_json::Value`/`unknown`/`Any`) by design |
| Recursive types through optional/list/set/map | ✅ | Direct recursion rejected `BR2017` |
| `@pattern` RE2-only | 🟡 | Enforced `BR2018`; generated **Rust validators do not evaluate `@pattern`** (declared v1 limitation, IDL_REFERENCE constraints table) |
| Style warnings (PascalCase / SCREAMING_SNAKE / snake_case) | ✅ | `BR2101`-`BR2103` in `semantic.ts` L87-89 |
| Diagnostic codes `BR1001`–`BR2999` | ✅ | `semantic.ts` L67-90, `parser.ts`, `lexer.ts`; `formatDiagnostic` rendering |
| Comments preserved in IR | ❌ (by design) | `//` dropped; only `///` docs survive |
| Annotations beyond `@deprecated` / custom options | ❌ | No extension mechanism in grammar |
| Streaming / paginated methods, method options | ❌ | Unary struct→struct methods only (`BR2010`) |
| Generics / templates | ❌ | Not in grammar |
| AI-native emission (tool-call/MCP schemas) | ❌ | Open roadmap item (ROADMAP Phase 3, last row) |

## 2. Generator targets × capabilities

`@bridge/generators` — `generate(ir, {language})`, six targets
(`src/gen/*.ts`), `GENERATOR_VERSION = '0.2.1'`. Capability evidence: file
lists in committed snapshots (`src/test/__snapshots__/`), `docs/RPC.md` table,
`docs/EVENTS.md`.

| Capability | Go | Rust | TypeScript | Python | Java | C# |
| --- | --- | --- | --- | --- | --- | --- |
| Types (structs, enums, unions, aliases) | ✅ | ✅ | ✅ | ✅ | ✅¹ | ✅¹ |
| Field validation from constraints | ✅ `validate.go` | ✅ `validate.rs`² | ✅ `validate.ts` | ✅ `validation.py` | ✅ `BridgeValidation.java` | ✅ `Validation.cs` |
| Canonical JSON wire codec (incl. bytes base64, sets as arrays) | ✅ | ✅ serde | ✅ | ✅ `to_dict/from_dict` | ✅ `BridgeJson.java` | ✅ in `Models.cs` |
| RPC client (JSON over HTTP POST) | ✅ `New<Service>JSONClient` | ✅ stdlib TCP | ✅ fetch | ✅ urllib | ✅ `java.net.http` | ✅ `HttpClient` |
| RPC server adapter | ✅ `http.Handler` | ✅ `TcpListener` | ✅ node:http listener | ✅ `http.server` | ✅ JDK `com.sun.net.httpserver` | ✅ `HttpListener` |
| Event publishers/consumers (CloudEvents-style envelope) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Round-trip test emitted with project | ✅ | ✅ `tests/roundtrip.rs` | — (external `verify-ts.sh`) | — (`verify-python.sh`) | ✅ `RoundTripTest.java` | ✅ `RoundTripTest.cs` |
| Project scaffolding (manifest) | ✅ `go.mod` | ✅ `Cargo.toml` | ✅ `package.json`+`tsconfig.json` | ✅ `pyproject.toml` | ✅ `pom.xml` | ✅ `.csproj` |
| Compile-verified | ✅ CI job + adversarial test | ✅ CI job + adversarial test | ✅ in-suite `ts.createProgram` (never skipped) | 🟡 skip-gated locally; runtime exercised by serialization matrix | 🟡 CI job defined; ECJ/dotnet absent locally → skips | 🟡 CI job defined; same caveat |
| Deterministic byte output | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

¹ Java/C# have no alias declarations — generators substitute the underlying
type everywhere (`localAliasTargets`, `src/index.ts` L93-99).
² Generated Rust validators do not evaluate `@pattern` (documented v1
limitation).

Name-collision hardening: `assertNoCollisions` (`collisions.ts`, issue #116)
fails generation when legal contract names collapse per language; reserved
words are auto-escaped in `naming.ts`. Snapshot corpus also asserts generated
output never contains `TODO` (`generators.test.ts` L35).

## 3. Serialization formats

`@bridge/serialization` (`src/{canonical,msgpack,cbor,tagged,types}.ts`;
112 tests, 0 deps).

| Format | Status | Evidence |
| --- | --- | --- |
| Canonical JSON (sorted keys, no insignificant whitespace) | ✅ | `canonical.ts`; `canonicalJson` reused by hashing + signing |
| MessagePack (pure TS encoder/decoder) | ✅ | `msgpack.ts`; `msgpack.test.ts` |
| CBOR (RFC 8949 subset) | ✅ | `cbor.ts`; `cbor.test.ts`; rejects NaN/Inf/unknown tags via golden vectors |
| Tagged value model (map/set/timestamp) | ✅ | `tagged.ts` |
| Golden vectors, cross-language | ✅ | `vectors/vectors.json` (committed hex); Go/Rust/Python runtimes in `runtimes/`; `scripts/verify-serialization.sh` = CI `serialization-matrix` job |
| Property tests (encode→decode→encode byte-identical; hostile-byte decoders) | ✅ | `src/test/property/roundtrip.property.test.ts` |
| Protobuf / gRPC wire | ❌ | Roadmap "what's next" |
| Avro / Parquet / schema-registry integration | ❌ | Not started |

## 4. RPC & event surface

| Feature | Status | Evidence |
| --- | --- | --- |
| Typed RPC clients, all 6 languages | ✅ | `docs/RPC.md` table; `services.*` snapshots |
| Server adapters + server-side validation before handler | ✅ | `docs/RPC.md` "What gets generated" |
| Canonical error-code → HTTP status table (13 codes + 500 fallback) | ✅ | `generators/src/wire.ts` `RPC_ERROR_STATUS` |
| CloudEvents-style event envelope (`specversion 1.0`) | ✅ | `wire.ts` `ENVELOPE_SPECVERSION`; caller supplies id/source/time (determinism) |
| In-memory event bus per language | ✅ | docs/EVENTS.md; issue #16 |
| gRPC / Connect transports | ❌ | Explicitly "what's next" in ROADMAP |
| Streaming RPC / subscriptions | ❌ | Unary only |

## 5. CLI commands

`@bridge/cli` — dispatch table `src/main.ts` L36-85; help text is the single
source of truth (`src/usage.ts`). All 16 commands in the roadmap exist; no
command is documented-but-missing.

| Command | Exists | Notes / evidence |
| --- | --- | --- |
| `init` | ✅ | `commands/init.ts`; `--minimal`; refuses overwrite |
| `validate` | ✅ | `--json` per-file entries |
| `fmt` | ✅ | `-w` in-place; diff mode exits 1 when unformatted |
| `lint` | ✅ | `--strict` |
| `generate` | ✅ | 6 languages; `--out/--package-name/--force` |
| `diff` / `check` | ✅ | strict/compatible gates; `--against name@version` pulls baseline from registry; `--format table\|json\|markdown` |
| `impact` | ✅ | consumer-aware reachability (`docs/IMPACT.md`) |
| `publish` / `pull` / `versions` / `inspect` / `search` | ✅ | filesystem registry **and** HTTP service (`--org/--project/--token`); publish signing via `--signing-key-id/--signing-key-file` |
| `doctor` / `version` / `help` | ✅ | environment smoke test incl. compile+generate |
| Compile-cache fast path in `generate` | ❌ | `cache.ts` is a library; CLI wiring is a declared follow-up (docs/TESTING.md) |

Exit-code contract (0/1/2) enforced centrally in `main.ts` `fail()`.

## 6. Registry features

| Feature | Local registry (`@bridge/registry`) | Service (`@bridge/registry-service`) |
| --- | --- | --- |
| Content-addressed immutable versions | ✅ `objects/<hash>.json` + `packages/<base>/<version>/` | ✅ same model via driver |
| Republish-same = no-op; republish-different = error | ✅ | ✅ 200 replay vs 409 immutable |
| Tamper detection (re-hash on read) | ✅ `verify()` | ✅ "integrity re-verified on every pull" (openapi.ts) |
| Search / versions / inspect / dependents graph | ✅ | ✅ `/v1/search`, `/versions`, `/consumers`, `/graph` |
| Diff between two published versions | ✅ (CLI `--against`) | ✅ `GET .../contracts/{c}/diff` |
| Multi-tenancy (org/project) | ❌ (single-root) | ✅ tokens bound to one org; cross-tenant = 404 |
| Auth | ❌ (filesystem trust) | ✅ static tokens (roles read/write/admin) + OIDC JWT RS256/ES256 via JWKS; `org` claim required; fail-closed (`auth.ts`) |
| Rate limiting | ❌ | ✅ two token-bucket tiers: auth 120@30/s per IP, publish 30@5/s per principal+IP (`ratelimit.ts`) |
| Audit log | ❌ | ✅ append-only, queryable, admin-only; driver, memory-ring, or JSONL-file backends (`audit.ts`); PG index migration `0002_audit_index.sql` |
| Publish signing (ed25519) | ❌ | ✅ legacy body signature + v2 envelope binding route coordinates; `contentHash` tripwire (`signing.ts`) |
| Storage drivers | filesystem | in-memory + PostgreSQL (`storage/postgres/driver.ts`, migrations) |
| OpenAPI 3.1 document | ❌ | ✅ hand-written, served at `/v1/openapi.json` (`openapi.ts`) |
| Metrics endpoint / tracing | ❌ | ❌ (`/healthz` only) |
| Per-user ACL inside an org | ❌ | ❌ scope is token-level only |

## 7. Dashboard routes (`dashboard/`)

| Route / area | Status | Evidence |
| --- | --- | --- |
| `/` overview (org stats, recent audit) | ✅ | `src/app/page.tsx`; tests/pages/overview.test.tsx |
| `/contracts` list | ✅ | `src/app/contracts/page.tsx` |
| `/contracts/[org]/[project]/[contract]` detail + versions | ✅ | detail page + loading skeleton |
| `.../diff` classified diff viewer | ✅ | `diff/page.tsx`; `diff-version-picker` |
| `/audit` log browser with filters + detail dialog | ✅ | `audit/page.tsx`; `audit-detail-dialog.tsx` |
| `/graph` SVG dependency graph | ✅ | `graph/page.tsx`; `compat-graph.tsx` |
| Demo / live data modes | ✅ | `registry-client.ts` `isDemoMode()` (strict boolean parsing; prod defaults live) |
| Security headers (DENY framing, nosniff, referrer, permissions-policy) | ✅ | `next.config.ts` SECURITY_HEADERS (issue #122) |
| OIDC login gate (`dashboard/src/lib/auth/`) | ❌ not yet | directory absent (verified); tracked as issue #163, flagged "next" in worklog |
| Tests | ✅ 100 vitest tests / 10 files | measured run |

## 8. LSP features (`@bridge/lsp`)

JSON-RPC over stdio (`server.ts` 586 LOC; 38 tests). Capabilities from
`protocol.ts` L177-191:

| Feature | Status |
| --- | --- |
| initialize/shutdown/exit lifecycle (LSP 3.17 discipline) | ✅ |
| Diagnostics (push `textDocument/publishDiagnostics` + pull `textDocument/diagnostic`) | ✅ |
| `didOpen/didChange/didSave/didClose` sync (full-document) | ✅ |
| Hover (type + docs for identifier under cursor) | ✅ |
| Completion (keywords, primitives, local types) | ✅ |
| Document formatting (canonical formatter) | ✅ |
| Incremental sync | ❌ (full-document sync only) |
| goto-definition / find-references / rename | ❌ |
| Semantic tokens / cross-file resolution | ❌ |

## 9. FFI & WASM (`@bridge/ffi`)

| Target | Status | Evidence |
| --- | --- | --- |
| `rust-ffi` cdylib (C-ABI, catch_unwind, status codes 0–5, `<pkg>_free` ownership rule) | ✅ generator | `rust-ffi.ts`, `abi.ts` |
| `go-ffi` cgo client sharing the same generated C header | ✅ generator | `go-ffi.ts`; build-tagged verify test |
| `wasm` wasm-bindgen crate + typed TS declarations + loader façade | ✅ generator | `wasm.ts` |
| Real end-to-end verification (build cdylib, run Go cgo tests against it) | 🟡 local-only | `scripts/verify-ffi.sh` — self-declared "not wired into any CI workflow" |
| wasm32 compile check | 🟡 conditional | `verify-ffi.sh` L47-56, only if rustup target installed |
| npm-published WASM package / playground | ❌ | not started |

## 10. Roadmap deltas (declared vs observed)

ROADMAP self-reports Phase 1–3 shipped except AI-native tooling; the audit
agrees with one nuance per row:

| Item | Roadmap says | Audit finding |
| --- | --- | --- |
| AI-native tooling (tool-call/MCP emission) | 🔲 open | Confirmed absent — no emission module anywhere |
| gRPC/Connect transports | "what's next" | Confirmed absent (JSON/HTTP only) |
| Consumer registry federation | "what's next" | Confirmed absent (single service, org-scoped) |
| CI runs | blocked by Actions billing lock (#127) | Consistent: workflows are complete; runs cannot be observed from the repo |
| `verify-ts.sh` / `verify-python.sh` / `verify-ffi.sh` / `verify-events-rpc.sh` in CI | local-only (TESTING.md) | Confirmed — `ci.yml` has no such jobs |
| Dashboard OIDC gate | issue #163 in flight | Not present in tree yet |
| Compile-cache CLI wiring | follow-up (TESTING.md) | Confirmed unwired |
| Test counts (831 + 94 dashboard) | ROADMAP | 831 verified exactly; dashboard now **100** (roadmap figure stale) |
