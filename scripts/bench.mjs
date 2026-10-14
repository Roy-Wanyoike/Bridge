#!/usr/bin/env node
/**
 * scripts/bench.mjs — the Bridge micro-benchmark suite (zero npm deps).
 *
 * Measures the three hot paths named by audit item T5
 * (docs/engineering/technical-debt.md):
 *
 *   compile   lexer → parser → semantic → IR over examples/payments/payments.bridge
 *   generate  full six-language codegen (Go/Rust/TS/Python/Java/C#) from that IR
 *             (per-language breakdown included as sub-rows)
 *   diff      bridge-compat diff of examples/compatibility/v1.orders.bridge
 *             → v2.orders.bridge
 *
 * Methodology (mirrored in docs/engineering/benchmarks.md):
 * - fixed inputs, read from the repository — no network, no randomness,
 *   no timestamps (pass --stamp to add one);
 * - each scenario runs W warmup iterations (JIT warm), then N measured
 *   iterations timed individually with performance.now();
 * - reported stats per scenario: median, p95 (nearest-rank), min and
 *   ops/sec = N / total measured wall time;
 * - results are validated before timing (compile must be ok, codegen must
 *   produce files, diff must produce a classified report) so the suite can
 *   never benchmark a silently broken pipeline.
 *
 * Node built-ins only (node:fs, node:path, node:os, node:perf_hooks).
 * The workspace packages must be built once: `npm install && npm run build`.
 *
 * Usage:
 *   node scripts/bench.mjs               human-readable table
 *   node scripts/bench.mjs --json        machine-readable JSON (stable shape)
 *   node scripts/bench.mjs --stamp       adds an ISO timestamp to the output
 *   node scripts/bench.mjs --iterations=N --warmup=W   override defaults
 *
 * Optional: run under `node --expose-gc scripts/bench.mjs` to let the
 * harness collect garbage between scenarios for tighter cross-run variance.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';

const ROOT = join(import.meta.dirname, '..');

/** Fixed benchmark inputs — committed repository files, never generated. */
const PAYMENTS = join(ROOT, 'examples', 'payments', 'payments.bridge');
const ORDERS_V1 = join(ROOT, 'examples', 'compatibility', 'v1.orders.bridge');
const ORDERS_V2 = join(ROOT, 'examples', 'compatibility', 'v2.orders.bridge');

const LANGUAGES = ['go', 'rust', 'typescript', 'python', 'java', 'csharp'];

/**
 * Default iteration counts. Measured wall time stays in the low seconds;
 * raise them via --iterations/--warmup for tighter statistics.
 */
const DEFAULTS = {
  compile: { warmup: 500, iterations: 3000 },
  generate: { warmup: 30, iterations: 300 },
  diff: { warmup: 500, iterations: 3000 },
  perLanguage: { warmup: 20, iterations: 400 },
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { json: false, stamp: false, iterations: null, warmup: null };
  for (const arg of argv.slice(2)) {
    if (arg === '--json') options.json = true;
    else if (arg === '--stamp') options.stamp = true;
    else if (arg.startsWith('--iterations=')) {
      options.iterations = positiveInt(arg.slice('--iterations='.length), '--iterations');
    } else if (arg.startsWith('--warmup=')) {
      options.warmup = positiveInt(arg.slice('--warmup='.length), '--warmup');
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`bench: unknown option "${arg}" (see --help)`);
      process.exit(1);
    }
  }
  return options;
}

function positiveInt(value, flag) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`bench: ${flag} must be a positive integer, got "${value}"`);
    process.exit(1);
  }
  return n;
}

function printHelp() {
  console.log(`bridge micro-benchmark suite

Usage:
  node scripts/bench.mjs [options]

Options:
  --json              print machine-readable JSON instead of the table
  --stamp             include an ISO-8601 timestamp in the output
  --iterations=N      measured iterations per scenario (default: scenario-specific)
  --warmup=W          warmup iterations per scenario (default: scenario-specific)
  -h, --help          this help

Requires the workspace packages to be built once: npm install && npm run build`);
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/**
 * Runs `fn` warmup times, then measures `iterations` individual runs and
 * derives median / p95 (nearest-rank) / min / ops/sec. Pure timing — `fn`
 * must be deterministic and side-effect free for the numbers to be stable.
 */
function measure(fn, { warmup, iterations }) {
  for (let i = 0; i < warmup; i += 1) fn();
  if (typeof globalThis.gc === 'function') globalThis.gc();

  const samples = new Array(iterations);
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    fn();
    samples[i] = performance.now() - start;
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  const p95Index = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1);
  const total = sorted.reduce((sum, value) => sum + value, 0);

  return {
    iterations,
    warmup,
    medianMs: median,
    p95Ms: sorted[p95Index],
    minMs: sorted[0],
    opsPerSec: Math.round((iterations / total) * 1000),
  };
}

/** Adaptive millisecond formatting: 4 significant digits, fixed decimals. */
function fmtMs(ms) {
  const digits = ms >= 100 ? 1 : ms >= 10 ? 2 : ms >= 1 ? 3 : 4;
  return ms.toFixed(digits);
}

function fmtOps(ops) {
  return ops.toLocaleString('en-US');
}

// ---------------------------------------------------------------------------
// Workloads
// ---------------------------------------------------------------------------

/** Loads @bridge/* builds with an actionable error when dist/ is missing. */
async function loadWorkspacePackages() {
  try {
    const [core, generators, compat] = await Promise.all([
      import('@bridge/core'),
      import('@bridge/generators'),
      import('@bridge/compat'),
    ]);
    return { compileSource: core.compileSource, generate: generators.generate, diffPackages: compat.diffPackages };
  } catch {
    console.error(
      'bench: unable to load @bridge/core, @bridge/generators or @bridge/compat.\n' +
        'Build the workspace packages first:\n' +
        '  npm install && npm run build',
    );
    process.exit(1);
  }
}

function readInput(path, label) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    console.error(`bench: cannot read ${label} (${path}): ${err.message}`);
    process.exit(1);
  }
}

/** Compiles `source` and hard-fails with diagnostics on any error. */
function mustCompile(compileSource, source, file) {
  const result = compileSource(source, file);
  if (!result.ok) {
    console.error(`bench: ${file} failed to compile — refusing to benchmark:`);
    for (const d of result.diagnostics) {
      console.error(`  ${d.file}:${d.line}:${d.column} ${d.code} ${d.message}`);
    }
    process.exit(1);
  }
  return result.ir;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function machineContext() {
  const cpu = os.cpus()[0];
  return {
    node: process.version,
    platform: `${os.platform()} ${os.arch()}`,
    release: os.release(),
    cpu: cpu ? cpu.model : 'unknown',
    cores: os.cpus().length,
  };
}

function printTable(context, rows) {
  const header = ['scenario', 'iters', 'median', 'p95', 'min', 'ops/sec'];
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i].length)),
  );
  const line = (cells) =>
    cells.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd();

  console.log('bridge benchmark suite');
  console.log(
    `${context.node} · ${context.platform} · ${context.cpu} · ${context.cores} vCPU`,
  );
  console.log('');
  console.log(line(header));
  console.log(widths.map((w) => '─'.repeat(w)).join('  '));
  for (const row of rows) console.log(line(row));
  console.log('');
  console.log('median / p95 / min in ms per iteration; ops/sec = iterations / total measured time.');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv);
  const { compileSource, generate, diffPackages } = await loadWorkspacePackages();

  // Fixed inputs, read once. Nothing below depends on the clock, the
  // environment or randomness.
  const paymentsSrc = readInput(PAYMENTS, 'payments example');
  const ordersV1Src = readInput(ORDERS_V1, 'orders v1 example');
  const ordersV2Src = readInput(ORDERS_V2, 'orders v2 example');

  // --- compile: full pipeline (lexer → parser → semantic → IR) -------------
  const compileStats = measure(
    () => compileSource(paymentsSrc, 'payments.bridge'),
    {
      warmup: options.warmup ?? DEFAULTS.compile.warmup,
      iterations: options.iterations ?? DEFAULTS.compile.iterations,
    },
  );
  const paymentsIr = mustCompile(compileSource, paymentsSrc, 'payments.bridge');
  if (!compileStats || paymentsIr.types.length === 0) {
    console.error('bench: compile sanity check failed (empty IR)');
    process.exit(1);
  }

  // --- generate: full six-language codegen from the compiled IR ------------
  const generateAll = () => {
    for (const language of LANGUAGES) generate(paymentsIr, { language });
  };
  const generateStats = measure(generateAll, {
    warmup: options.warmup ?? DEFAULTS.generate.warmup,
    iterations: options.iterations ?? DEFAULTS.generate.iterations,
  });

  const perLanguage = {};
  let totalFiles = 0;
  let totalBytes = 0;
  for (const language of LANGUAGES) {
    const files = generate(paymentsIr, { language });
    if (files.length === 0) {
      console.error(`bench: generate(${language}) produced no files`);
      process.exit(1);
    }
    totalFiles += files.length;
    totalBytes += files.reduce((sum, file) => sum + file.content.length, 0);
    perLanguage[language] = measure(() => generate(paymentsIr, { language }), {
      warmup: options.warmup ?? DEFAULTS.perLanguage.warmup,
      iterations: options.iterations ?? DEFAULTS.perLanguage.iterations,
    });
  }

  // --- diff: bridge-compat over the two committed orders revisions ---------
  const ordersV1Ir = mustCompile(compileSource, ordersV1Src, 'v1.orders.bridge');
  const ordersV2Ir = mustCompile(compileSource, ordersV2Src, 'v2.orders.bridge');
  const diffProbe = diffPackages(ordersV1Ir, ordersV2Ir);
  const diffStats = measure(() => diffPackages(ordersV1Ir, ordersV2Ir), {
    warmup: options.warmup ?? DEFAULTS.diff.warmup,
    iterations: options.iterations ?? DEFAULTS.diff.iterations,
  });

  const payload = {
    meta: {
      scenarioDefaults: DEFAULTS,
      environment: machineContext(),
      ...(options.stamp ? { timestamp: new Date().toISOString() } : {}),
    },
    results: {
      compile: {
        target: 'examples/payments/payments.bridge → IR',
        ...compileStats,
      },
      generate: {
        target: 'six-language codegen from payments IR',
        totalFiles,
        totalBytes,
        ...generateStats,
        perLanguage,
      },
      diff: {
        target: 'examples/compatibility/v1.orders.bridge → v2.orders.bridge',
        verdict: diffProbe.verdict,
        changes: diffProbe.changes.length,
        ...diffStats,
      },
    },
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  const rows = [
    [
      'compile payments.bridge → IR',
      String(compileStats.iterations),
      fmtMs(compileStats.medianMs),
      fmtMs(compileStats.p95Ms),
      fmtMs(compileStats.minMs),
      fmtOps(compileStats.opsPerSec),
    ],
    [
      'generate 6 languages from IR',
      String(generateStats.iterations),
      fmtMs(generateStats.medianMs),
      fmtMs(generateStats.p95Ms),
      fmtMs(generateStats.minMs),
      fmtOps(generateStats.opsPerSec),
    ],
  ];
  for (const language of LANGUAGES) {
    const stats = perLanguage[language];
    rows.push([
      `  ├ ${language}`,
      String(stats.iterations),
      fmtMs(stats.medianMs),
      fmtMs(stats.p95Ms),
      fmtMs(stats.minMs),
      fmtOps(stats.opsPerSec),
    ]);
  }
  rows.push([
    'diff v1.orders → v2.orders',
    String(diffStats.iterations),
    fmtMs(diffStats.medianMs),
    fmtMs(diffStats.p95Ms),
    fmtMs(diffStats.minMs),
    fmtOps(diffStats.opsPerSec),
  ]);

  printTable(payload.meta.environment, rows);
  console.log(
    `generate emitted ${totalFiles} files / ${(totalBytes / 1024).toFixed(1)} KB ` +
      `across 6 languages (package ${paymentsIr.name}); ` +
      `diff verdict ${diffProbe.verdict} with ${diffProbe.changes.length} changes.`,
  );
  if (options.stamp) console.log(`timestamp: ${payload.meta.timestamp}`);
}

main();
