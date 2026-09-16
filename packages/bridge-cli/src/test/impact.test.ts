/**
 * E2E tests: `bridge impact` and the extended `bridge check` (--against,
 * --strict, --format) against real RegistryStores rooted in temp dirs.
 *
 * Fixture graph (published via the CLI itself):
 *   payments.v1@v1  ←  fraud.v2  ←  orders.v1    (transitive chain)
 *         ↑ catalog.v1                            (references unchanged types)
 *   payments.v2                                   (renamed safe evolution)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { PAYMENTS_SAFE, PAYMENTS_V1, PAYMENTS_V2, run, tmpdir, writeFile } from './helpers';

const tempRoots: string[] = [];
function fresh(label: string): string {
  const dir = tmpdir(label);
  tempRoots.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Breaking candidate (same package name): Money.currency removed + widened. */
const PAYMENTS_CANDIDATE = `package payments.v1

type Money {
    amount: int64
}

enum PaymentStatus {
    PENDING
    COMPLETED
    FAILED
    REFUNDED
}

type Payment {
    id: uuid
    customer_id: uuid
    amount: Money
    status: PaymentStatus
    created_at: timestamp
}

type CreatePaymentRequest {
    customer_id: uuid
    amount: Money
}

type GetPaymentRequest {
    id: uuid
}

service Payments {
    CreatePayment(CreatePaymentRequest) -> Payment
    GetPayment(GetPaymentRequest) -> Payment
}
`;

/** Warning-level evolution of PAYMENTS_V1: a new enum variant (WARNING). */
const PAYMENTS_WARNY = `package payments.v1

type Money {
    amount: int64
    currency: string @length(3)
}

enum PaymentStatus {
    PENDING
    COMPLETED
    FAILED
    REFUNDED
    CHARGEBACK
}

type Payment {
    id: uuid
    customer_id: uuid
    amount: Money
    status: PaymentStatus
    created_at: timestamp
    reference: string
}

type CreatePaymentRequest {
    customer_id: uuid
    amount: Money
}

type GetPaymentRequest {
    id: uuid
}

service Payments {
    CreatePayment(CreatePaymentRequest) -> Payment
    GetPayment(GetPaymentRequest) -> Payment
}
`;

const FRAUD_V2 = `package fraud.v2

import payments.v1

type FraudCheck {
    payment: payments.v1.Payment
    amount: payments.v1.Money
    score: int32
}
`;

const ORDERS_V1 = `package orders.v1

import fraud.v2

type Order {
    id: uuid
    check: fraud.v2.FraudCheck
}
`;

const CATALOG_V1 = `package catalog.v1

import payments.v1

type CatalogEntry {
    title: string
    status: payments.v1.PaymentStatus
}
`;

interface Graph {
  /** Directory holding the fixture files. */
  dir: string;
  /** Registry root with payments.v1@v1, fraud.v2, orders.v1, catalog.v1, payments.v2. */
  registry: string;
  candidate: string;
  warny: string;
}

/** Build the full fixture graph by driving the real CLI publish command. */
function setupGraph(label: string): Graph {
  const dir = fresh(label);
  const registry = path.join(dir, 'registry');
  const pub = (name: string, content: string, extra: string[] = []): void => {
    const file = writeFile(dir, name, content);
    const r = run(['publish', file, '--registry', registry, ...extra]);
    assert.equal(r.status, 0, `setup publish of ${name} failed: ${r.all}`);
  };
  pub('payments.bridge', PAYMENTS_V1, ['--owner', 'payments-team']);
  pub('fraud.bridge', FRAUD_V2, ['--owner', 'fraud-team']);
  pub('orders.bridge', ORDERS_V1);
  pub('catalog.bridge', CATALOG_V1);
  pub('payments-v2.bridge', PAYMENTS_V2);
  const candidate = writeFile(dir, 'candidate.bridge', PAYMENTS_CANDIDATE);
  const warny = writeFile(dir, 'warny.bridge', PAYMENTS_WARNY);
  return { dir, registry, candidate, warny };
}

// ---------------------------------------------------------------------------
// impact: table (default)
// ---------------------------------------------------------------------------

test('impact table: transitive consumers with depth, reason and exit 0 (advisory)', () => {
  const g = setupGraph('impact-table');
  const r = run(['impact', 'payments.v1', '--to', g.candidate, '--registry', g.registry]);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.startsWith('BRIDGE IMPACT REPORT'));
  assert.match(r.stdout, /^contract: payments\.v1$/m);
  assert.match(r.stdout, /^change: payments\.v1@v1 → .+candidate\.bridge$/m);
  assert.match(r.stdout, /^Consumers: 3 discovered, 2 affected \(breaking 2, unknown 0, warning 0, safe 1\)$/m);
  assert.match(r.stdout, /❌ fraud\.v2@v2 — depth 1 — BREAKING — references Money$/m);
  assert.match(r.stdout, /❌ orders\.v1@v1 — depth 2 — BREAKING — through `fraud\.v2` \(FraudCheck\)$/m);
  assert.match(r.stdout, /✓ catalog\.v1@v1 — depth 1 — SAFE — no changed type is referenced$/m);
  // Suggested actions list the consumers to migrate first.
  assert.match(r.stdout, /Consumers to migrate first: fraud\.v2, orders\.v1/);
  assert.match(r.stderr, /^$/);
});

test('impact --strict: exits 1 when a BREAKING change is detected', () => {
  const g = setupGraph('impact-strict-breaking');
  const r = run(['impact', 'payments.v1', '--to', g.candidate, '--registry', g.registry, '--strict']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /impact gate failed \(strict\): 1 breaking change\(s\) reach 2 consumer contract\(s\)/);
});

test('impact --strict: exits 0 when changes are advisory only', () => {
  const g = setupGraph('impact-strict-safe');
  const safe = writeFile(g.dir, 'safe.bridge', PAYMENTS_SAFE);
  const r = run(['impact', 'payments.v1', '--to', safe, '--registry', g.registry, '--strict']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^Verdict: SAFE$/m);
});

// ---------------------------------------------------------------------------
// impact: json + markdown
// ---------------------------------------------------------------------------

test('impact json: deterministic bytes and correct stats roll-up', () => {
  const g = setupGraph('impact-json');
  const argv = ['impact', 'payments.v1', '--to', g.candidate, '--registry', g.registry, '--format', 'json'];
  const r1 = run(argv);
  assert.equal(r1.status, 0);
  const r2 = run(argv);
  assert.equal(r1.stdout, r2.stdout, 'identical runs must produce byte-identical JSON');
  const parsed = JSON.parse(r1.stdout) as {
    contract: string;
    fromRef: string;
    toRef: string;
    stats: { total: number; breaking: number; warning: number; safe: number; unknown: number; consumersAffected: number; consumersBreakingAffected: number };
    affectedConsumers: Array<{ packageName: string; depth: number; severity: string; reason: string; viaTypes: string[] }>;
    suggestedActions: Array<{ path: string; reaches: string[] }>;
    analysis: { graphTraversed: boolean; method: string };
  };
  assert.equal(parsed.contract, 'payments.v1');
  assert.equal(parsed.fromRef, 'payments.v1@v1');
  assert.match(parsed.toRef, /candidate\.bridge$/);
  // The candidate removes Money.currency — one BREAKING change.
  assert.deepEqual(parsed.stats, {
    total: 1,
    breaking: 1,
    warning: 0,
    safe: 0,
    unknown: 0,
    consumersAffected: 2,
    consumersBreakingAffected: 2,
  });
  assert.equal(parsed.affectedConsumers.length, 3);
  const orders = parsed.affectedConsumers.find((c) => c.packageName === 'orders.v1');
  assert.ok(orders !== undefined);
  assert.equal(orders.depth, 2);
  assert.equal(orders.reason, 'through');
  assert.deepEqual(orders.viaTypes, ['FraudCheck']);
  const removal = parsed.suggestedActions.find((a) => a.path === 'Money.currency');
  assert.ok(removal !== undefined);
  assert.deepEqual(removal.reaches, ['fraud.v2', 'orders.v1']);
  assert.equal(parsed.analysis.graphTraversed, true);
  assert.equal(parsed.analysis.method, 'type-reference-reachability');
});

test('impact markdown: PR-comment structure with consumer tables', () => {
  const g = setupGraph('impact-markdown');
  const r = run(['impact', 'payments.v1', '--to', g.candidate, '--registry', g.registry, '--format', 'markdown']);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.startsWith('## Bridge impact report: `payments.v1`'));
  assert.match(r.stdout, /^\| Breaking-affected \| 2 \|$/m);
  assert.match(r.stdout, /^### Affected consumers \(2\)$/m);
  assert.match(r.stdout, /\| `fraud\.v2@v2` · owner: fraud-team \|/);
  assert.match(r.stdout, /<details><summary>Unaffected consumers \(1\)<\/summary>/);
  assert.match(r.stdout, /Coverage note/);
});

test('impact markdown: --strict still exits 1 (gate is format-independent)', () => {
  const g = setupGraph('impact-markdown-strict');
  const r = run([
    'impact', 'payments.v1', '--to', g.candidate, '--registry', g.registry, '--format', 'markdown', '--strict',
  ]);
  assert.equal(r.status, 1);
  assert.ok(r.stdout.startsWith('## Bridge impact report'));
});

// ---------------------------------------------------------------------------
// impact: reference resolution and failure modes
// ---------------------------------------------------------------------------

test('impact: version-segment evolution flags the rename and all dependents', () => {
  const g = setupGraph('impact-rename');
  const r = run(['impact', 'payments.v1', '--to', 'payments.v2', '--registry', g.registry]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^change: payments\.v1@v1 → payments\.v2@v2$/m);
  assert.match(r.stdout, /package renamed payments\.v1 → payments\.v2/);
  assert.match(r.stdout, /the package was renamed/);
  assert.match(r.stdout, /^Consumers: 3 discovered, 3 affected/m);
  // Advisory by default; the same report gates under --strict.
  const strict = run(['impact', 'payments.v1', '--to', 'payments.v2', '--registry', g.registry, '--strict']);
  assert.equal(strict.status, 1);
});

test('impact: pinning the baseline by version segment survives newer versions', () => {
  const g = setupGraph('impact-pinned');
  // payments.v2 exists in the registry; 'payments.v1' must still resolve to v1.
  const r = run(['impact', 'payments.v1', '--to', g.candidate, '--registry', g.registry]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^change: payments\.v1@v1 → /m);
});

test('impact: without a registry the diff still runs with a note (graceful)', () => {
  const dir = fresh('impact-no-registry');
  const oldFile = writeFile(dir, 'old.bridge', PAYMENTS_V1);
  const newFile = writeFile(dir, 'new.bridge', PAYMENTS_CANDIDATE);
  const r = run(['impact', oldFile, '--to', newFile], { cwd: dir });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^Verdict: BREAKING$/m);
  assert.match(r.stdout, /No registry provided: the consumer graph was not traversed/);
});

test('impact: unknown baseline name exits 1 with a search hint', () => {
  const g = setupGraph('impact-not-found');
  const r = run(['impact', 'nope.v9', '--to', g.candidate, '--registry', g.registry]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /No versions published for package 'nope\.v9'/);
  assert.match(r.stderr, /bridge search/);
});

test('impact: missing --to and unknown --format are usage errors (exit 2)', () => {
  const g = setupGraph('impact-usage');
  const missing = run(['impact', 'payments.v1', '--registry', g.registry]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /'--to <name@version\|file>' is missing/);
  const badFormat = run(['impact', 'payments.v1', '--to', g.candidate, '--registry', g.registry, '--format', 'yaml']);
  assert.equal(badFormat.status, 2);
  assert.match(badFormat.stderr, /unknown --format 'yaml'/);
});

// ---------------------------------------------------------------------------
// check: --against / --strict / --format
// ---------------------------------------------------------------------------

test('check --against <registry-ref>: gates against the published baseline', () => {
  const g = setupGraph('check-against-registry');
  const r = run(['check', g.candidate, '--against', 'payments.v1', '--registry', g.registry]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^baseline: payments\.v1@v1$/m);
  assert.match(r.stdout, /^mode: strict$/m);
  assert.match(r.stdout, /^verdict: BREAKING$/m);
  assert.match(r.stdout, /^passed: false$/m);
  assert.match(r.stderr, /compatibility gate failed \(strict mode\): 1 breaking, 0 unknown change\(s\)/);
});

test('check --against <file>: file baselines work without a registry', () => {
  const g = setupGraph('check-against-file');
  const base = writeFile(g.dir, 'base.bridge', PAYMENTS_V1);
  const r = run(['check', g.candidate, '--against', base]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, new RegExp(`^baseline: ${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
});

test('check --strict: WARNING verdict passes by default, fails with --strict', () => {
  const g = setupGraph('check-strict-warnings');
  const base = writeFile(g.dir, 'base.bridge', PAYMENTS_V1);
  const pass = run(['check', g.warny, '--against', base]);
  assert.equal(pass.status, 0);
  assert.match(pass.stdout, /^mode: strict$/m);
  assert.match(pass.stdout, /^verdict: WARNING$/m);
  assert.match(pass.stdout, /^passed: true$/m);
  const fail = run(['check', g.warny, '--against', base, '--strict']);
  assert.equal(fail.status, 1);
  assert.match(fail.stdout, /^mode: strict\+warnings$/m);
  assert.match(fail.stdout, /^passed: false$/m);
  assert.match(fail.stderr, /warnings gated\)/);
});

test('check --format markdown: PR-comment header and gate verdict', () => {
  const g = setupGraph('check-markdown');
  const base = writeFile(g.dir, 'base.bridge', PAYMENTS_V1);
  const r = run(['check', g.candidate, '--against', base, '--format', 'markdown']);
  assert.equal(r.status, 1);
  assert.ok(r.stdout.startsWith('### Compatibility: `payments.v1` — ❌ FAILED'));
  assert.match(r.stdout, /_Gate: strict mode\._/);
});

test('check: --compatible and --strict are mutually exclusive (exit 2)', () => {
  const g = setupGraph('check-mutually-exclusive');
  const base = writeFile(g.dir, 'base.bridge', PAYMENTS_V1);
  const r = run(['check', g.warny, '--against', base, '--compatible', '--strict']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /mutually exclusive/);
});

test('check: single file without --against is a usage error (exit 2)', () => {
  const g = setupGraph('check-missing-baseline');
  const r = run(['check', g.candidate]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--against/);
});

// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------

test('help: impact command is documented with its options', () => {
  const r = run(['help', 'impact']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /bridge impact <contract> --to <name@version\|file>/);
  assert.match(r.stdout, /--format <fmt>/);
  assert.match(r.stdout, /--strict/);
});

test('help: check documents --against and --strict', () => {
  const r = run(['help', 'check']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--against <ref-file\|name@version>/);
  assert.match(r.stdout, /--strict/);
});

test('help: general usage lists the impact command', () => {
  const r = run(['help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^ {2}impact <contract> --to <ref>/m);
});
