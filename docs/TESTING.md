# Testing Bridge

How Bridge tests itself, and how to reproduce any failure deterministically.

## Layers

| Layer | What it proves | Where |
| ----- | -------------- | ----- |
| Unit + functional suites | Every package behaves to spec (831 tests across nine packages: CLI 136, compat 109, core 172, FFI 12, generators 86, LSP 38, registry 65, registry-service 101, serialization 112) | `packages/*/src/test/` |
| Dashboard suite | The registry console's clients, pages and routing behave to spec (167 tests — a separate app, run via `cd dashboard && npm test`) | `dashboard/tests/` |
| Golden vectors | 4 languages agree byte-for-byte on the wire | `packages/bridge-serialization/vectors/` + `scripts/verify-serialization.sh` |
| Property-based tests | Invariants hold over hundreds of seeded generated inputs | `packages/*/src/test/property/` |
| Fuzz harness | The parser and decoders never crash on hostile input | `packages/bridge-core/src/fuzz/` + `bin/bridge-fuzz` |
| Cross-language examples | Generated code really runs | `scripts/verify-*.sh`, `examples/` |

The `scripts/verify-*.sh` gates are local-first and CI-enforced: Go, Rust,
Java and C# generated code is compile-verified by dedicated generator-verify
jobs; `verify-ts.sh` and `verify-python.sh` run in the build-test job after
the Test step; `verify-ffi.sh` runs in a dedicated `verify-ffi` job (Go 1.23
+ stable Rust, mirroring the Go/Rust generator-verify setup — the wasm
crate check self-skips unless the `wasm32-unknown-unknown` rustup target is
installed). Only `verify-events-rpc.sh` remains local-only (no CI workflow
invokes it yet). Generators also carry committed byte-level snapshot tests
plus toolchain-gated adversarial compile checks that skip loudly without a
local toolchain — the same output the CI generator-verify jobs enforce.

The dashboard job runs `npm run parity`
(dashboard/scripts/demo-live-parity.mjs) right after `next build`, so the
demo dataset can no longer drift from the live REST wire shapes unnoticed.

## Property-based testing

A tiny seeded runner (`packages/bridge-core/src/test/property/harness.ts`)
drives every property. No framework dependency: a fixed-seed PRNG
(mulberry32), committed iteration counts, and environment-variable overrides
for reproduction.

Current properties:

- **core** (`bridge-core`): generated contracts always parse; formatting is a
  fixpoint (`fmt(fmt(x)) == fmt(x)`); compilation is deterministic (identical
  IR and hash for identical input); the compilation cache returns
  byte-identical results to fresh compiles; the fuzz harness never crashes.
- **compat** (`bridge-compat`): `diffPackages` is a pure function of the IR
  pair (repeat runs → identical reports and markdown); removing a required
  field is always BREAKING; adding an optional field is always SAFE; the
  verdict always equals the worst change classification.
- **serialization** (`bridge-serialization`): encode→decode→encode is
  byte-identical for both wire formats over generated value trees; decoders
  never throw non-Error values on mutated/truncated/spliced bytes and stay
  stable (decode→encode→decode).

### Reproducing a failure

Every property prints its committed seed and case count. To re-run a single
case of a failing property:

```sh
BRIDGE_PROPERTY_SEED=20260912 BRIDGE_PROPERTY_CASE=137 \
  npm test --workspace @bridge/serialization
```

`BRIDGE_PROPERTY_ITERATIONS=N` raises the iteration count for a deeper run.

## Coverage

Report-only, zero new dependencies. All nine workspace packages run their
tests on Node's built-in runner (`node --test` over compiled `dist/test`),
so the build-test CI job adds a second, instrumented pass that prints the
per-file line/branch/function table into the job log:

```sh
node --test --experimental-test-coverage packages/*/dist/test/*.test.js \
  packages/*/dist/test/property/*.test.js
```

Nothing gates on the numbers — they exist to be eyeballed in CI logs. The
dashboard suite runs on vitest, where coverage would require adding a new
dependency, so it is intentionally out of scope for now.

## CI supply-chain scanning

`.github/dependabot.yml` watches three manifest roots weekly — the root npm
workspace, the dashboard's separate npm app, and the GitHub Actions pins in
`.github/workflows` — with minor+patch npm updates grouped into single PRs
and `open-pull-requests-limit: 5` per ecosystem.
`.github/workflows/codeql.yml` scans the JavaScript/TypeScript surface on
pushes/PRs to main plus a weekly schedule. NOTE (issue #127): GitHub
Actions is billing-locked, so none of this has executed remotely yet; both
activate when Actions runs are re-enabled.

## Fuzzing the IDL parser

The fuzz harness (`packages/bridge-core/src/fuzz/`) mutates valid contracts —
character and block deletions, insertions, duplications — and asserts the
parser always finishes with clean diagnostics or a thrown `Error`, never a
process crash, never a hang.

```sh
node packages/bridge-core/bin/bridge-fuzz.js --iterations 1000 --seed 42
# bridge-fuzz: iterations=1000 seed=42 executed=1000 crashes=0 clean=124 diagnostics=1876 stoppedEarly=false elapsedMs=155
```

Any failure prints the seed and case index; re-run with `--seed` to reproduce.
Run it as part of a change review for parser-touching PRs:

```sh
npm run fuzz --workspace @bridge/core
```

## Deterministic compilation cache

`packages/bridge-core/src/cache.ts` ships a content-addressed compile cache:
keyed by (source, file path, compiler version), storing the serialized
`CompileResult`. Property tests prove hits are byte-identical to fresh
compiles — including failed compiles. It is a library today; wiring it into
the CLI is a tracked follow-up so `bridge generate` can skip recompilation
when the contract hash and compiler version are unchanged.
