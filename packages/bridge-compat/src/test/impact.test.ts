/**
 * Consumer-aware impact analysis tests: transitive dependents walk,
 * type-reference reachability filtering, stats roll-up, suggested actions,
 * renderer determinism and graceful registry handling.
 *
 * The registry is a deterministic in-memory fake implementing the
 * structural `ImpactRegistry` interface (`RegistryStore` satisfies it
 * as-is; the real store path is exercised end-to-end by the CLI suite).
 * Fixture graph:
 *
 *   payments.v1  ←  fraud.v2  ←  orders.v1      (transitive chain)
 *        ↑  ↑  ↑
 *        |  |  └── ghost.v1   (dependent whose IR cannot be pulled)
 *        |  └──── a.v1  ↔  b.v1                (cycle-safe pair)
 *        └─────── catalog.v3                   (dependent, but references
 *                                               only unchanged types)
 *   standalone.v1                               (no imports — invisible)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeImpact,
  formatImpactJson,
  formatImpactMarkdown,
  formatImpactText,
  ImpactError,
  type AffectedConsumer,
  type ContractMetaLike,
  type ImpactRegistry,
  type IRField,
  type IRPackage,
} from '../index';
import { enumType, event, field, listOf, named, optType, prim, reversed, service, struct, method } from './fixtures';

// ---------------------------------------------------------------------------
// IR fixtures
// ---------------------------------------------------------------------------

function paymentsV1(): IRPackage {
  return {
    name: 'payments.v1',
    imports: [],
    types: [
      struct('Money', [field('amount', prim('int32')), field('currency', prim('string'))]),
      struct('Payment', [
        field('id', prim('uuid')),
        field('amount', named('Money')),
        field('currency', prim('string')),
      ]),
      enumType('PaymentStatus', ['PENDING', 'CAPTURED', 'FAILED']),
      struct('CreatePaymentRequest', [field('customer_id', prim('uuid')), field('amount', named('Money'))]),
    ],
    services: [service('Payments', [method('CreatePayment', named('CreatePaymentRequest'), named('Payment'))])],
    events: [event('PaymentCaptured', [field('paymentId', prim('uuid')), field('amount', prim('int32'))])],
  };
}

/** Candidate: widening WARNING (Money), removal BREAKING (currency), optional add SAFE. */
function paymentsV2(): IRPackage {
  const base = paymentsV1();
  return {
    ...base,
    name: 'payments.v1',
    types: base.types.map((t) => {
      if (t.name === 'Money') {
        return struct('Money', [field('amount', prim('int64')), field('currency', prim('string'))]);
      }
      if (t.name === 'Payment') {
        return struct('Payment', [
          field('id', prim('uuid')),
          field('amount', named('Money')),
          field('reference', optType(prim('string')), { optional: true }),
        ]);
      }
      return t;
    }),
  };
}

function fraudV2(): IRPackage {
  return {
    name: 'fraud.v2',
    imports: ['payments.v1'],
    types: [
      struct('FraudCheck', [
        field('payment', named('Payment', 'payments.v1')),
        field('amount', named('Money', 'payments.v1')),
        field('score', prim('int32')),
      ]),
    ],
    services: [],
    events: [],
  };
}

function ordersV1(): IRPackage {
  return {
    name: 'orders.v1',
    imports: ['fraud.v2'],
    types: [struct('Order', [field('id', prim('uuid')), field('check', named('FraudCheck', 'fraud.v2'))])],
    services: [],
    events: [],
  };
}

function catalogV3(): IRPackage {
  return {
    name: 'catalog.v3',
    imports: ['payments.v1'],
    types: [struct('CatalogEntry', [field('title', prim('string')), field('status', named('PaymentStatus', 'payments.v1'))])],
    services: [],
    events: [],
  };
}

/** Cycle pair: a imports payments + b; b imports a (a ↔ b cycle). */
function aV1(): IRPackage {
  return {
    name: 'a.v1',
    imports: ['payments.v1', 'b.v1'],
    types: [struct('AReport', [field('money', named('Money', 'payments.v1')), field('link', listOf(named('BView', 'b.v1')))])],
    services: [],
    events: [],
  };
}

function bV1(): IRPackage {
  return {
    name: 'b.v1',
    imports: ['a.v1'],
    types: [struct('BView', [field('report', named('AReport', 'a.v1'))])],
    services: [],
    events: [],
  };
}

function standaloneV1(): IRPackage {
  return {
    name: 'standalone.v1',
    imports: [],
    types: [struct('Island', [field('label', prim('string'))])],
    services: [],
    events: [],
  };
}

/** Event-only evolution: PaymentCaptured.amount widened (event-field-changed, WARNING). */
function paymentsV2Event(): IRPackage {
  const base = paymentsV1();
  return {
    ...base,
    events: base.events.map((e) =>
      e.name === 'PaymentCaptured'
        ? event('PaymentCaptured', [field('paymentId', prim('uuid')), field('amount', prim('int64'))])
        : e,
    ),
  };
}

// ---------------------------------------------------------------------------
// In-memory ImpactRegistry fake (mirrors RegistryStore semantics)
// ---------------------------------------------------------------------------

interface Entry {
  readonly packageName: string;
  readonly base: string;
  readonly version: string;
  readonly imports: readonly string[];
  readonly ir?: IRPackage;
  readonly owner?: string;
}

const SEGMENT = /^(?:v\d+|\d+)$/;
function baseOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot > 0 && SEGMENT.test(name.slice(dot + 1))) return name.slice(0, dot);
  return name;
}

function fakeRegistry(entries: readonly Entry[], failPull: ReadonlySet<string> = new Set()): ImpactRegistry & { entries: readonly Entry[] } {
  const metas: ContractMetaLike[] = entries.map((e) => ({
    packageName: e.packageName,
    base: e.base,
    version: e.version,
    imports: e.imports,
    ...(e.owner !== undefined ? { owner: e.owner } : {}),
  }));
  return {
    entries,
    dependents(packageName: string): ContractMetaLike[] {
      const base = baseOf(packageName);
      return metas.filter(
        (m) => m.packageName !== packageName && (m.imports.includes(packageName) || m.imports.includes(base)),
      );
    },
    pull(packageName: string, version: string): { ir: IRPackage; meta: ContractMetaLike } {
      if (failPull.has(packageName)) throw new Error(`simulated pull failure for ${packageName}`);
      const idx = entries.findIndex((e) => e.packageName === packageName && e.version === version);
      if (idx < 0) throw new Error(`not stored: ${packageName}@${version}`);
      const e = entries[idx] as Entry;
      if (e.ir === undefined) throw new Error(`no IR stored for ${packageName}`);
      return { ir: e.ir, meta: metas[idx] as ContractMetaLike };
    },
    latest(packageName: string): ContractMetaLike {
      const base = baseOf(packageName);
      const candidates = entries
        .map((e, i) => ({ e, meta: metas[i] as ContractMetaLike }))
        .filter((x) => x.e.base === base)
        .sort((x, y) => Number(x.e.version.slice(1)) - Number(y.e.version.slice(1)));
      const last = candidates.at(-1);
      if (last === undefined) throw new Error(`not stored: ${packageName}`);
      return last.meta;
    },
  };
}

/** The full fixture graph as registry entries. */
function graphEntries(): Entry[] {
  return [
    { packageName: 'payments.v1', base: 'payments', version: 'v1', imports: [], ir: paymentsV1() },
    { packageName: 'payments.v1', base: 'payments', version: 'v2', imports: [], ir: paymentsV2() },
    { packageName: 'fraud.v2', base: 'fraud', version: 'v2', imports: ['payments.v1'], ir: fraudV2(), owner: 'risk-team' },
    { packageName: 'orders.v1', base: 'orders', version: 'v1', imports: ['fraud.v2'], ir: ordersV1() },
    { packageName: 'catalog.v3', base: 'catalog', version: 'v3', imports: ['payments.v1'], ir: catalogV3() },
    { packageName: 'a.v1', base: 'a', version: 'v1', imports: ['payments.v1', 'b.v1'], ir: aV1() },
    { packageName: 'b.v1', base: 'b', version: 'v1', imports: ['a.v1'], ir: bV1() },
    { packageName: 'standalone.v1', base: 'standalone', version: 'v1', imports: [], ir: standaloneV1() },
    { packageName: 'ghost.v1', base: 'ghost', version: 'v1', imports: ['payments.v1'] }, // no IR stored
  ];
}

const LABELS = { from: 'payments.v1@v1', to: 'payments.v1@v2' };

function analyze(registry: ImpactRegistry = fakeRegistry(graphEntries())) {
  return computeImpact({ oldIR: paymentsV1(), newIR: paymentsV2(), registry, labels: LABELS });
}

function byName(report: { affectedConsumers: AffectedConsumer[] }, name: string): AffectedConsumer {
  const c = report.affectedConsumers.find((x) => x.packageName === name);
  assert.ok(c !== undefined, `expected consumer ${name} in the report`);
  return c;
}

// ---------------------------------------------------------------------------
// Transitive walk
// ---------------------------------------------------------------------------

test('impact: discovers the full transitive dependent graph (BFS, cycle-safe)', () => {
  const report = analyze();
  assert.deepEqual(
    report.affectedConsumers.map((c) => `${c.packageName}@${c.version}@d${c.depth}`),
    [
      'a.v1@v1@d1',
      'b.v1@v1@d2',
      'catalog.v3@v3@d1',
      'fraud.v2@v2@d1',
      'ghost.v1@v1@d1',
      'orders.v1@v1@d2',
    ],
  );
});

test('impact: never reports the anchor itself and terminates on a↔b cycles', () => {
  const report = analyze();
  assert.ok(!report.affectedConsumers.some((c) => c.packageName === 'payments.v1'));
  // The a↔b cycle resolved with finite depths instead of hanging or growing.
  assert.equal(report.affectedConsumers.length, 6);
});

test('impact: standalone contracts outside the import graph are invisible', () => {
  const report = analyze();
  assert.ok(!report.affectedConsumers.some((c) => c.packageName === 'standalone.v1'));
});

// ---------------------------------------------------------------------------
// Reachability refinement
// ---------------------------------------------------------------------------

test('impact: reachability filtering — direct dependent referencing changed types', () => {
  const fraud = byName(analyze(), 'fraud.v2');
  assert.equal(fraud.reason, 'direct-type');
  assert.equal(fraud.severity, 'BREAKING');
  assert.deepEqual(fraud.viaTypes, ['Money', 'Payment']);
  assert.deepEqual(fraud.viaPackages, ['payments.v1', 'fraud.v2']);
  assert.equal(fraud.scanned, true);
  assert.equal(fraud.owner, 'risk-team');
  assert.equal(fraud.repository, undefined);
});

test('impact: taint flows through intermediate contracts (orders via fraud)', () => {
  const orders = byName(analyze(), 'orders.v1');
  assert.equal(orders.reason, 'through');
  assert.equal(orders.severity, 'BREAKING');
  assert.equal(orders.depth, 2);
  assert.deepEqual(orders.viaTypes, ['FraudCheck']);
  assert.deepEqual(orders.viaPackages, ['payments.v1', 'fraud.v2', 'orders.v1']);
});

test('impact: multi-hop taint — b.v1 is affected through a.v1 (WARNING widening only)', () => {
  const report = analyze();
  const a = byName(report, 'a.v1');
  assert.equal(a.reason, 'direct-type');
  assert.equal(a.severity, 'WARNING');
  // a references b.BView (a↔b cycle) and BView is tainted through AReport —
  // the fixed-point honestly reports both contact names.
  assert.deepEqual(a.viaTypes, ['BView', 'Money']);
  const b = byName(report, 'b.v1');
  assert.equal(b.reason, 'through');
  assert.equal(b.severity, 'WARNING');
  assert.deepEqual(b.viaTypes, ['AReport']);
});

test('impact: dependent referencing only unchanged types is scanned and cleared', () => {
  const catalog = byName(analyze(), 'catalog.v3');
  assert.equal(catalog.reason, 'unaffected');
  assert.equal(catalog.severity, 'SAFE');
  assert.deepEqual(catalog.viaTypes, []);
  assert.equal(catalog.scanned, true);
});

test('impact: consumer whose IR cannot be pulled is conservatively affected', () => {
  const report = analyze();
  const ghost = byName(report, 'ghost.v1');
  assert.equal(ghost.reason, 'unscannable');
  assert.equal(ghost.severity, 'UNKNOWN');
  assert.equal(ghost.scanned, false);
  assert.ok(report.analysis.notes.some((n) => n.includes('ghost.v1')));
});

// ---------------------------------------------------------------------------
// Taint fixed-point: value-only growth (regressions for GitHub #111)
// ---------------------------------------------------------------------------

/**
 * Graph for the two #111 regressions. Every consumer sits at depth 1 and its
 * name sorts BEFORE the name of the package it reads from, so within one
 * fixed-point round each consumer is processed before its source and reads
 * the source's PREVIOUS-round taint. The anchor diff carries two changes:
 * `St` gains a required field (WARNING — reaches everyone in round 0 through
 * the anchor's complete marks) and `Tu` loses a field (BREAKING — must hop
 * zed → slow → mid → aaa, one round per hop, because each hop reads the
 * previous round). The last hop lands as pure VALUE growth: no taint KEY is
 * added anywhere in that round, so a key-count termination check stops the
 * loop early and the top consumer is mis-reported WARNING/through instead of
 * BREAKING (consumersBreakingAffected under-counts by one).
 */
function baseV111(): IRPackage {
  return {
    name: 'base.v1',
    imports: [],
    types: [struct('St', [field('keep', prim('int32'))]), struct('Tu', [field('old', prim('string'))])],
    services: [],
    events: [],
  };
}

function baseV111Candidate(): IRPackage {
  return {
    name: 'base.v1',
    imports: [],
    types: [
      struct('St', [field('keep', prim('int32')), field('extra', prim('string'))]), // required add → WARNING
      struct('Tu', []), // 'old' removed → BREAKING
    ],
    services: [],
    events: [],
  };
}

function zedV111(): IRPackage {
  return {
    name: 'zed.v1',
    imports: ['base.v1'],
    types: [struct('Z', [field('p', named('Tu', 'base.v1'))])],
    services: [],
    events: [],
  };
}

function slowV111(): IRPackage {
  return {
    name: 'slow.v1',
    imports: ['base.v1', 'zed.v1'],
    types: [struct('J', [field('z', named('Z', 'zed.v1'))])],
    services: [],
    events: [],
  };
}

function midV111(): IRPackage {
  return {
    name: 'mid.v1',
    imports: ['base.v1', 'slow.v1'],
    types: [struct('St', [field('s', named('St', 'base.v1')), field('j', named('J', 'slow.v1'))])],
    services: [],
    events: [],
  };
}

/** Top consumer reading only the intermediate (`mid.v1#St`). */
function aaaV111(): IRPackage {
  return {
    name: 'aaa.v1',
    imports: ['base.v1', 'mid.v1'],
    types: [struct('W', [field('w', named('St', 'mid.v1'))])],
    services: [],
    events: [],
  };
}

/**
 * Variant top consumer that ALSO references the anchor's `St` directly: its
 * local taint key exists from round 0 carrying only the WARNING index, and
 * the BREAKING index must reach it later THROUGH that existing key.
 */
function aaaDirectV111(): IRPackage {
  return {
    name: 'aaa.v1',
    imports: ['base.v1', 'mid.v1'],
    types: [struct('W', [field('direct', named('St', 'base.v1')), field('relay', named('St', 'mid.v1'))])],
    services: [],
    events: [],
  };
}

function chainV111Entries(aaa: IRPackage = aaaV111()): Entry[] {
  return [
    { packageName: 'base.v1', base: 'base', version: 'v1', imports: [], ir: baseV111() },
    { packageName: 'aaa.v1', base: 'aaa', version: 'v1', imports: ['base.v1', 'mid.v1'], ir: aaa },
    { packageName: 'mid.v1', base: 'mid', version: 'v1', imports: ['base.v1', 'slow.v1'], ir: midV111() },
    { packageName: 'slow.v1', base: 'slow', version: 'v1', imports: ['base.v1', 'zed.v1'], ir: slowV111() },
    { packageName: 'zed.v1', base: 'zed', version: 'v1', imports: ['base.v1'], ir: zedV111() },
  ];
}

function analyzeV111(aaa: IRPackage = aaaV111()): ReturnType<typeof computeImpact> {
  return computeImpact({
    oldIR: baseV111(),
    newIR: baseV111Candidate(),
    registry: fakeRegistry(chainV111Entries(aaa)),
    labels: { from: 'base.v1@v1', to: 'base.v1@v2' },
  });
}

test('impact regression #111: consumer sorting before its source still absorbs the late BREAKING change', () => {
  const report = analyzeV111();
  assert.equal(report.changes.length, 2); // St field-added (WARNING) + Tu field-removed (BREAKING)
  const aaa = byName(report, 'aaa.v1');
  assert.equal(aaa.severity, 'BREAKING');
  assert.equal(aaa.reason, 'through');
  assert.deepEqual(aaa.viaTypes, ['St']);
  for (const name of ['mid.v1', 'slow.v1', 'zed.v1']) {
    assert.equal(byName(report, name).severity, 'BREAKING');
  }
  assert.equal(report.stats.consumersAffected, 4);
  assert.equal(report.stats.consumersBreakingAffected, 4);
  const removal = report.suggestedActions.find((a) => a.kind === 'field-removed');
  assert.ok(removal !== undefined);
  assert.equal(removal.classification, 'BREAKING');
  assert.deepEqual(removal.reaches, ['aaa.v1', 'mid.v1', 'slow.v1', 'zed.v1']);
});

test('impact regression #111: value-only taint growth reaches through an existing key', () => {
  const report = analyzeV111(aaaDirectV111());
  const aaa = byName(report, 'aaa.v1');
  assert.equal(aaa.severity, 'BREAKING'); // key W existed with the WARNING only; BREAKING arrived later
  assert.equal(aaa.reason, 'direct-type');
  assert.deepEqual(aaa.viaTypes, ['St']);
  assert.equal(report.stats.consumersAffected, 4);
  assert.equal(report.stats.consumersBreakingAffected, 4);
  const removal = report.suggestedActions.find((a) => a.kind === 'field-removed');
  assert.ok(removal !== undefined);
  assert.ok(removal.reaches.includes('aaa.v1'));
});

// ---------------------------------------------------------------------------
// Stats roll-up
// ---------------------------------------------------------------------------

test('impact: stats roll up change counts and consumer counts', () => {
  const { stats, changes, affectedConsumers } = analyze();
  // Changes: Money widening (WARNING), Payment.currency removed (BREAKING),
  // Payment.reference added optional (SAFE).
  assert.equal(stats.total, changes.length);
  assert.equal(stats.total, 3);
  assert.equal(stats.breaking, 1);
  assert.equal(stats.warning, 1);
  assert.equal(stats.safe, 1);
  assert.equal(stats.unknown, 0);
  assert.equal(affectedConsumers.length, 6);
  assert.equal(stats.consumersAffected, 5); // all but catalog.v3
  assert.equal(stats.consumersBreakingAffected, 2); // fraud.v2 + orders.v1
});

test('impact: stats agree with the per-consumer census', () => {
  const { stats, affectedConsumers } = analyze();
  assert.equal(affectedConsumers.filter((c) => c.severity !== 'SAFE').length, stats.consumersAffected);
  assert.equal(affectedConsumers.filter((c) => c.severity === 'BREAKING').length, stats.consumersBreakingAffected);
});

// ---------------------------------------------------------------------------
// Suggested actions
// ---------------------------------------------------------------------------

test('impact: one action per change, index-aligned, with concrete guidance', () => {
  const report = analyze();
  assert.equal(report.suggestedActions.length, report.changes.length);
  const removal = report.suggestedActions.find((a) => a.kind === 'field-removed');
  assert.ok(removal !== undefined);
  assert.equal(removal.classification, 'BREAKING');
  assert.ok(removal.action.startsWith('Deprecate the field first'));
  assert.deepEqual(removal.reaches, ['fraud.v2', 'ghost.v1', 'orders.v1']);
});

test('impact: reaching consumers are listed per change and include ghost for non-SAFE only', () => {
  const report = analyze();
  const widening = report.suggestedActions.find((a) => a.kind === 'field-type-changed');
  assert.ok(widening !== undefined);
  assert.deepEqual(widening.reaches, ['a.v1', 'b.v1', 'fraud.v2', 'ghost.v1', 'orders.v1']);
  const added = report.suggestedActions.find((a) => a.kind === 'field-added');
  assert.ok(added !== undefined);
  assert.equal(added.classification, 'SAFE');
  // SAFE changes never claim the unscannable consumer.
  assert.deepEqual(added.reaches, ['fraud.v2', 'orders.v1']);
});

// ---------------------------------------------------------------------------
// Renderers: determinism and structure
// ---------------------------------------------------------------------------

test('impact: markdown and json are byte-identical across runs and input orders', () => {
  const r1 = analyze();
  const r2 = computeImpact({
    oldIR: reversed(paymentsV1()),
    newIR: reversed(paymentsV2()),
    // Same graph, different discovery order in dependents().
    registry: fakeRegistry([...graphEntries()].reverse()),
    labels: LABELS,
  });
  assert.equal(formatImpactJson(r1), formatImpactJson(r2));
  assert.equal(formatImpactMarkdown(r1), formatImpactMarkdown(r2));
  assert.equal(formatImpactText(r1), formatImpactText(r2));
});

test('impact: markdown contains summary table, affected consumers and actions', () => {
  const md = formatImpactMarkdown(analyze());
  assert.ok(md.startsWith('## Bridge impact report: `payments.v1`'));
  assert.ok(md.includes('| Affected (non-safe) | 5 |'));
  assert.ok(md.includes('| Breaking-affected | 2 |'));
  assert.ok(md.includes('`fraud.v2@v2` · owner: risk-team'));
  assert.ok(md.includes('### Affected consumers (5)'));
  assert.ok(md.includes('<details><summary>Unaffected consumers (1)</summary>'));
  assert.ok(md.includes('Deprecate the field first'));
  assert.ok(md.includes('> **Coverage note**'));
});

test('impact: json round-trips to an equal report object', () => {
  const report = analyze();
  const parsed = JSON.parse(formatImpactJson(report)) as typeof report;
  assert.deepEqual(parsed, report);
  // Key order is construction-stable: contract is the first key.
  assert.equal(Object.keys(parsed)[0], 'contract');
});

test('impact: text renderer lists consumers and notes', () => {
  const text = formatImpactText(analyze());
  assert.ok(text.startsWith('BRIDGE IMPACT REPORT'));
  assert.ok(text.includes('Consumers: 6 discovered, 5 affected (breaking 2, unknown 1, warning 2, safe 1)'));
  assert.ok(text.includes('❌ fraud.v2@v2 — depth 1 — BREAKING — references Money, Payment'));
  assert.ok(text.includes('✓ catalog.v3@v3 — depth 1 — SAFE — no changed type is referenced'));
  assert.ok(text.includes('Notes:'));
});

// ---------------------------------------------------------------------------
// Registry-driven inputs and failure modes
// ---------------------------------------------------------------------------

test('impact: baseline and candidate can be pulled from the registry by name', () => {
  const registry = fakeRegistry(graphEntries());
  const report = computeImpact({ oldName: 'payments.v1@v1', newVersion: 'v2', registry });
  assert.equal(report.contract, 'payments.v1');
  assert.equal(report.fromRef, 'payments.v1@v1');
  assert.equal(report.toRef, 'payments.v1@v2');
  assert.equal(report.stats.consumersBreakingAffected, 2);
});

test('impact: oldName with @version pins the baseline; bare oldName uses latest', () => {
  const registry = fakeRegistry(graphEntries());
  const pinned = computeImpact({ oldName: 'payments.v1@v1', newVersion: 'v2', registry });
  assert.equal(pinned.fromRef, 'payments.v1@v1');
  const latest = computeImpact({ oldName: 'payments', newVersion: 'v2', registry });
  assert.equal(latest.fromRef, 'payments.v1@v2'); // latest of base 'payments' is v2
});

test('impact: without a registry the diff is still computed, gracefully', () => {
  const report = computeImpact({ oldIR: paymentsV1(), newIR: paymentsV2() });
  assert.equal(report.analysis.graphTraversed, false);
  assert.deepEqual(report.affectedConsumers, []);
  assert.equal(report.stats.consumersAffected, 0);
  assert.equal(report.stats.consumersBreakingAffected, 0);
  assert.equal(report.stats.total, 3);
  assert.equal(report.stats.breaking, 1);
  assert.deepEqual(report.suggestedActions.map((a) => a.reaches), [[], [], []]);
  assert.ok(report.analysis.notes.some((n) => n.includes('No registry provided')));
});

test('impact: invalid input combinations throw ImpactError(invalid-input)', () => {
  assert.throws(() => computeImpact({ newIR: paymentsV2() }), (e: unknown) => {
    assert.ok(e instanceof ImpactError);
    assert.equal((e as ImpactError).code, 'invalid-input');
    return true;
  });
  assert.throws(
    () => computeImpact({ oldName: 'payments.v1', newIR: paymentsV2() }),
    (e: unknown) => e instanceof ImpactError && (e as ImpactError).code === 'invalid-input',
  );
  assert.throws(
    () => computeImpact({ oldIR: paymentsV1() }),
    (e: unknown) => e instanceof ImpactError && (e as ImpactError).code === 'invalid-input',
  );
  assert.throws(
    () => computeImpact({ oldIR: paymentsV1(), newIR: paymentsV2(), newVersion: 'v2' }),
    (e: unknown) => e instanceof ImpactError && (e as ImpactError).code === 'invalid-input',
  );
  assert.throws(
    () => computeImpact({ oldName: 'payments.v1', newVersion: 'v2' }), // no registry
    (e: unknown) => e instanceof ImpactError && (e as ImpactError).code === 'invalid-input',
  );
});

test('impact: unusable registries surface as ImpactError(registry)', () => {
  const brokenDependents = {
    dependents: () => {
      throw new Error('disk on fire');
    },
    pull: () => {
      throw new Error('disk on fire');
    },
    latest: () => {
      throw new Error('disk on fire');
    },
  };
  assert.throws(
    () => computeImpact({ oldIR: paymentsV1(), newIR: paymentsV2(), registry: brokenDependents }),
    (e: unknown) => {
      assert.ok(e instanceof ImpactError);
      assert.equal((e as ImpactError).code, 'registry');
      assert.ok((e as ImpactError).message.includes('dependents'));
      return true;
    },
  );
  const brokenPull = fakeRegistry(graphEntries().filter((e) => e.packageName !== 'payments.v1'));
  assert.throws(
    () => computeImpact({ oldName: 'payments.v1', newVersion: 'v2', registry: brokenPull }),
    (e: unknown) => e instanceof ImpactError && (e as ImpactError).code === 'registry',
  );
});

// ---------------------------------------------------------------------------
// Rename and event rules
// ---------------------------------------------------------------------------

test('impact: package rename conservatively flags every discovered dependent', () => {
  const renamed = paymentsV2();
  const report = computeImpact({
    oldIR: paymentsV1(),
    newIR: { ...renamed, name: 'payments.v2' },
    registry: fakeRegistry(graphEntries()),
    labels: LABELS,
  });
  assert.equal(report.contract, 'payments.v1'); // anchor keeps the OLD name
  const rename = report.changes.find((c) => c.kind === 'package-renamed');
  assert.ok(rename !== undefined);
  assert.equal(rename.classification, 'BREAKING');
  for (const c of report.affectedConsumers) {
    if (c.scanned) {
      assert.equal(c.reason, 'package-renamed');
      assert.equal(c.severity, 'BREAKING');
    } else {
      // ghost.v1 could not be scanned: stays conservatively 'unscannable'.
      assert.equal(c.reason, 'unscannable');
      assert.equal(c.severity, 'UNKNOWN');
    }
  }
  assert.ok(report.analysis.notes.some((n) => n.includes('renamed')));
});

test('impact: event changes reach direct dependents only', () => {
  const report = computeImpact({
    oldIR: paymentsV1(),
    newIR: paymentsV2Event(),
    registry: fakeRegistry(graphEntries()),
    labels: LABELS,
  });
  const fraud = byName(report, 'fraud.v2');
  assert.equal(fraud.reason, 'event');
  assert.equal(fraud.severity, 'WARNING');
  // catalog.v3 imports payments.v1 directly → also conservatively flagged.
  const catalog = byName(report, 'catalog.v3');
  assert.equal(catalog.reason, 'event');
  // Indirect dependents are NOT flagged: subscription edges are invisible.
  const orders = byName(report, 'orders.v1');
  assert.equal(orders.reason, 'unaffected');
  const b = byName(report, 'b.v1');
  assert.equal(b.reason, 'unaffected');
  assert.ok(report.analysis.notes.some((n) => n.includes('Event changes')));
});

// ---------------------------------------------------------------------------
// Static guard: fixtures stay in sync with the IR shape
// ---------------------------------------------------------------------------

test('impact: fixtures use qualified and unqualified named refs (both matched)', () => {
  // Money is referenced unqualified inside payments.v1 itself and qualified
  // by fraud.v2 — the engine must treat `payments.v1.Money` and `payments.Money`
  // alike. `listOf`/optional wrappers must be traversed too (a.v1 → b.v1 list).
  const fields: IRField[] = (aV1().types[0] as { fields: IRField[] }).fields;
  assert.equal(fields.length, 2);
  assert.equal((fields[1]?.type as { kind: string }).kind, 'list');
});
