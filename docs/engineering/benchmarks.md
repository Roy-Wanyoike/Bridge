# Engineering — Benchmarks

The Bridge compiler's *determinism* is proven by tests and property suites;
this document measures its *speed*. It closes audit item **T5**
([technical-debt](./technical-debt.md): "No performance/benchmark suite …
determinism is proven, speed is unmeasured") and the 1.0 bar it names: one
micro-bench (compile + generate over `payments.bridge`) with committed
baselines. The compatibility-diff scenario is included because `bridge diff`
is the CI gate contract evolution runs through.

## What is measured

`scripts/bench.mjs` (zero npm dependencies — Node built-ins only) runs three
fixed workloads over committed repository files:

| Scenario | Workload | Input |
| --- | --- | --- |
| `compile` | full pipeline: lexer → parser → semantic analysis → canonical IR (`compileSource` from `@bridge/core`) | `examples/payments/payments.bridge` |
| `generate` | one iteration = full six-language codegen (Go, Rust, TypeScript, Python, Java, C#) via `generate` from `@bridge/generators`; per-language medians reported as sub-rows | IR of `payments.bridge` (compiled once, reused) |
| `diff` | `diffPackages` from `@bridge/compat` (the SAFE/WARNING/BREAKING engine) | `examples/compatibility/v1.orders.bridge` → `v2.orders.bridge` |

Before timing, the harness validates each workload (compile must be `ok`,
codegen must emit files, diff must produce a classified report — the baseline
diff is `WARNING` with 2 changes) so it can never benchmark a silently broken
pipeline.

## Methodology

- **Fixed inputs.** The three `.bridge` files are read from the repository.
  No network, no randomness, no timestamps in the default output
  (`--stamp` opts into an ISO-8601 timestamp; `--json` output shape is stable
  for diffing).
- **Warmup, then measurement.** Each scenario runs warmup iterations to reach
  steady-state JIT, then measures N iterations individually with
  `performance.now()`. Defaults: compile 500 warmup / 3000 measured; diff
  500 / 3000; generate 30 / 300; per-language rows 20 / 400. Override with
  `--iterations=N --warmup=W`. The full default run takes ≈3 s.
- **Statistics.** Reported per scenario: **median** (primary), **p95**
  (nearest-rank), **min**, and **ops/sec** = measured iterations ÷ total
  measured wall time.
- **GC.** `global.gc` is invoked between scenarios when available. Under the
  default `node scripts/bench.mjs` V8 collects garbage *during* the measured
  loops, which is what the p95 tail (and the wobble in ops/sec) reflects;
  `node --expose-gc scripts/bench.mjs` gives slightly tighter p95s.

## Committed baseline

Measured 2026-10-14, single run with default flags
(`node scripts/bench.mjs`), on the development container:

- **Machine class:** shared container, **2 vCPU** Intel Xeon (x86_64), no CPU
  pinning, Debian 13, 3.9 GiB RAM.
- **Node:** v24.21.0.
- **Iterations:** compile 3000 · diff 3000 · generate 300 · per-language 400.

| Scenario | iters | median (ms) | p95 (ms) | min (ms) | ops/sec |
| --- | --- | --- | --- | --- | --- |
| compile `payments.bridge` → IR | 3000 | 0.0134 | 0.0301 | 0.0118 | 26,889 |
| generate 6 languages from IR | 300 | 1.306 | 5.511 | 0.8814 | 420 |
| ├ go | 400 | 0.0808 | 0.2967 | 0.0700 | 4,201 |
| ├ rust | 400 | 0.0627 | 0.0982 | 0.0560 | 5,430 |
| ├ typescript | 400 | 0.0694 | 0.1657 | 0.0610 | 7,963 |
| ├ python | 400 | 0.0755 | 0.1342 | 0.0669 | 5,599 |
| ├ java | 400 | 0.1589 | 0.3823 | 0.1330 | 3,261 |
| ├ csharp | 400 | 0.1339 | 0.3053 | 0.1147 | 4,452 |
| diff `v1.orders` → `v2.orders` | 3000 | 0.0034 | 0.0050 | 0.0028 | 60,175 |

Codegen evidence for this run: 43 files / 141.5 KB across the six languages
(package `payments.v1`); diff verdict `WARNING` with 2 changes (the optional
`Order.note` add + the `int32 → int64` widening — see
`examples/compatibility/`).

**Observed run-to-run variance** (7 consecutive default runs, same machine):
compile median 0.0128–0.0149 ms · generate median 1.13–1.34 ms · diff median
0.0031–0.0035 ms · min 0.0117 / 0.851 / 0.0028 ms. Medians and especially
**min** are stable to within a few percent; ops/sec swings far more
(compile 18k–35k) because a GC pause landing inside the measured loop changes
total wall time. On this unpinned container class, treat **median deltas
under ≈10% as noise**; `min` is the tightest cross-run comparator.

These numbers are indicative, not SLOs: absolute values shift with hardware.
The useful signal is the *delta* against this baseline on the same machine.

## Reproducing

```sh
npm install && npm run build   # once, to produce packages/*/dist
npm run bench                  # node scripts/bench.mjs — human-readable table
node scripts/bench.mjs --json  # machine-readable, stable shape
node scripts/bench.mjs --iterations=10000 --warmup=1000   # tighter stats
```

`--json` emits `{ meta: { scenarioDefaults, environment, timestamp? },
results: { compile, generate: { …, perLanguage }, diff } }` with raw numeric
fields (`medianMs`, `p95Ms`, `minMs`, `opsPerSec`, `iterations`, `warmup`),
so two runs can be diffed mechanically.

## Comparing across changes

1. Run the bench on the **base commit** and on your branch, back to back, on
   the same machine and Node version. Never compare a local run against
   numbers from a shared CI runner.
2. Compare **median first** (steady-state cost), then **min** (allocation /
   work lower bound — most stable), then p95 (tail; dominated by GC for the
   allocation-heavy generate scenario). Use ops/sec only as a sanity signal.
3. Judge against the variance band above: a median shift beyond ~10% on this
   machine class is a real change; within it, re-run before claiming a
   regression (or raise `--iterations`).
4. If a change intentionally makes things slower (e.g. added validation),
   update this table in the same PR and say so in the commit message — the
   committed baseline is meant to be moved deliberately, never silently.

Example comparison block for a PR description:

```text
scenario             base median → PR median     delta
compile              0.0134 ms  → 0.0131 ms      −2%  (noise)
generate (6 langs)   1.306 ms   → 1.289 ms       −1%  (noise)
diff                 0.0034 ms  → 0.0033 ms      −3%  (noise)
```

## Scope

This suite deliberately measures the compiler core, codegen and compat-diff —
the deterministic, CPU-bound paths. It is not a load or throughput harness
for `bridge-registry-service` (request auth, signing, rate limits, PostgreSQL
drivers); those remain unmeasured and are tracked by the audit as separate
work.
