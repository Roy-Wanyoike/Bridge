# Testing Bridge

How Bridge tests itself, and how to reproduce any failure deterministically.

## Layers

| Layer | What it proves | Where |
| ----- | -------------- | ----- |
| Unit + functional suites | Every package behaves to spec (831 tests across nine packages: CLI 136, compat 109, core 172, FFI 12, generators 86, LSP 38, registry 65, registry-service 101, serialization 112) | `packages/*/src/test/` |
| Dashboard suite | The registry console's clients, pages and routing behave to spec (94 tests — a separate app, run via `cd dashboard && npm test`) | `dashboard/tests/` |
| Golden vectors | 4 languages agree byte-for-byte on the wire | `packages/bridge-serialization/vectors/` + `scripts/verify-serialization.sh` |
| Property-based tests | Invariants hold over hundreds of seeded generated inputs | `packages/*/src/test/property/` |
| Fuzz harness | The parser and decoders never crash on hostile input | `packages/bridge-core/src/fuzz/` + `bin/bridge-fuzz` |
| Cross-language examples | Generated code really runs | `scripts/verify-*.sh`, `examples/` |

The `scripts/verify-*.sh` gates are local-first: Go, Rust, Java and C#
generated code is additionally compile-verified by dedicated CI jobs, while
`verify-ts.sh`, `verify-python.sh`, `verify-ffi.sh` and
`verify-events-rpc.sh` currently run locally only (no CI workflow invokes
them). Generators also carry committed byte-level snapshot tests plus
toolchain-gated adversarial compile checks that skip loudly without a local
toolchain — the same output the CI generator-verify jobs enforce.

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
