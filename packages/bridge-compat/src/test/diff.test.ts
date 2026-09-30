/**
 * Detection-rule tests for the Bridge compatibility engine: one focused
 * case per classification rule, plus determinism guarantees. Fixtures are
 * canonical IR literals (see ./fixtures.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IRPackage, IRTypeDefinition, TypeRef } from '@bridge/core';
import { diffPackages } from '../diff';
import type { Change, ChangeKind, CompatReport } from '../types';
import {
  aliasType,
  constraint,
  enumType,
  event,
  field,
  listOf,
  makeIr,
  mapType,
  method,
  named,
  prim,
  reversed,
  service,
  struct,
  unionType,
} from './fixtures';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Assert the diff between old and new contains EXACTLY one change, of `kind`. */
function oneChange(oldIr: IRPackage, newIr: IRPackage, kind: ChangeKind, options?: Parameters<typeof diffPackages>[2]): Change {
  const report = diffPackages(oldIr, newIr, options);
  assert.equal(
    report.changes.length,
    1,
    `expected exactly one change of kind ${kind}, got: ${JSON.stringify(report.changes, null, 2)}`,
  );
  const change = report.changes[0] as Change;
  assert.equal(change.kind, kind, `expected kind ${kind}, got ${change.kind}`);
  return change;
}

/** Replace the `Payment` struct in a package with the given definition. */
function withPayment(ir: IRPackage, payment: IRTypeDefinition): IRPackage {
  return { ...ir, types: [...ir.types.filter((t) => t.name !== 'Payment'), payment] };
}

// ---------------------------------------------------------------------------
// Package envelope
// ---------------------------------------------------------------------------

test('identical packages produce an empty SAFE report', () => {
  const report = diffPackages(makeIr(), makeIr());
  assert.deepEqual(report.changes, []);
  assert.equal(report.verdict, 'SAFE');
  assert.equal(report.packageName, 'payments.v1');
  assert.deepEqual(report.summary, { safe: 0, warning: 0, breaking: 0, unknown: 0 });
});

test('package rename is BREAKING by default', () => {
  const c = oneChange(makeIr(), makeIr({ name: 'payments.v2' }), 'package-renamed');
  assert.equal(c.classification, 'BREAKING');
  assert.equal(c.message, 'package renamed payments.v1 → payments.v2');
  assert.equal(c.old, 'payments.v1');
  assert.equal(c.new, 'payments.v2');
});

test('package rename downgrades to WARNING with packageRenameBreaking:false', () => {
  const c = oneChange(makeIr(), makeIr({ name: 'payments.v2' }), 'package-renamed', {
    packageRenameBreaking: false,
  });
  assert.equal(c.classification, 'WARNING');
});

test('import changes are SAFE in both directions', () => {
  const report = diffPackages(makeIr({ imports: ['legacy.v1'] }), makeIr({ imports: ['money.v1'] }));
  assert.deepEqual(
    report.changes.map((c) => [c.kind, c.path, c.classification]),
    [
      ['import-removed', 'imports.legacy.v1', 'SAFE'],
      ['import-added', 'imports.money.v1', 'SAFE'],
    ],
  );
  assert.equal(report.verdict, 'SAFE');
});

// ---------------------------------------------------------------------------
// Types and aliases
// ---------------------------------------------------------------------------

test('type-added: new struct is SAFE', () => {
  const oldIr = makeIr();
  const newIr = makeIr({ types: [...oldIr.types, struct('Refund', [field('id', prim('uuid'))])] });
  const c = oneChange(oldIr, newIr, 'type-added');
  assert.equal(c.classification, 'SAFE');
  assert.equal(c.path, 'Refund');
});

test('alias-added: new alias is SAFE with its own kind', () => {
  const oldIr = makeIr();
  const newIr = makeIr({ types: [...oldIr.types, aliasType('CustomerId', prim('uuid'))] });
  const c = oneChange(oldIr, newIr, 'alias-added');
  assert.equal(c.classification, 'SAFE');
});

test('type-removed: deleted struct is BREAKING', () => {
  const oldIr = makeIr();
  const newIr = makeIr({ types: oldIr.types.filter((t) => t.name !== 'Money') });
  const c = oneChange(oldIr, newIr, 'type-removed');
  assert.equal(c.classification, 'BREAKING');
  assert.equal(c.path, 'Money');
});

test('alias-removed: deleted alias is BREAKING with its own kind', () => {
  const oldIr = makeIr({ types: [...makeIr().types, aliasType('CustomerId', prim('uuid'))] });
  const newIr = makeIr();
  const c = oneChange(oldIr, newIr, 'alias-removed');
  assert.equal(c.classification, 'BREAKING');
});

test('type-kind-changed: struct → enum is BREAKING', () => {
  const oldIr = makeIr();
  const newIr = makeIr({
    types: oldIr.types.map((t) => (t.name === 'Money' ? enumType('Money', ['USD', 'EUR']) : t)),
  });
  const c = oneChange(oldIr, newIr, 'type-kind-changed');
  assert.equal(c.classification, 'BREAKING');
  assert.match(c.message, /Type kind changed: Money \(struct → enum\)/);
});

test('alias-target-changed is BREAKING even for widening primitives', () => {
  const oldIr = makeIr({ types: [...makeIr().types, aliasType('CustomerId', prim('int32'))] });
  const newTypes = oldIr.types.map((t) => (t.name === 'CustomerId' ? aliasType('CustomerId', prim('int64')) : t));
  const c = oneChange(oldIr, makeIr({ types: newTypes }), 'alias-target-changed');
  assert.equal(c.classification, 'BREAKING');
  assert.equal(c.old, 'int32');
  assert.equal(c.new, 'int64');
});

// ---------------------------------------------------------------------------
// Struct fields: additions, removals, renames
// ---------------------------------------------------------------------------

test('field-added optional is SAFE', () => {
  const oldIr = makeIr();
  const newIr = withPayment(oldIr, struct('Payment', [
    field('id', prim('uuid')),
    field('amount', prim('int32')),
    field('currency', prim('string')),
    field('reference', prim('string'), { optional: true }),
  ]));
  const c = oneChange(oldIr, newIr, 'field-added');
  assert.equal(c.classification, 'SAFE');
  assert.equal(c.path, 'Payment.reference');
  assert.match(c.message, /Added optional field: Payment\.reference/);
});

test('field-added required is WARNING', () => {
  const oldIr = makeIr();
  const newIr = withPayment(oldIr, struct('Payment', [
    field('id', prim('uuid')),
    field('amount', prim('int32')),
    field('currency', prim('string')),
    field('reference', prim('string')),
  ]));
  const c = oneChange(oldIr, newIr, 'field-added');
  assert.equal(c.classification, 'WARNING');
  assert.match(c.message, /Added required field: Payment\.reference/);
});

test('field-removed is BREAKING', () => {
  const oldIr = makeIr();
  const newIr = withPayment(oldIr, struct('Payment', [field('id', prim('uuid')), field('amount', prim('int32'))]));
  const c = oneChange(oldIr, newIr, 'field-removed');
  assert.equal(c.classification, 'BREAKING');
  assert.equal(c.path, 'Payment.currency');
  assert.equal(c.message, 'Payment.currency removed');
});

test('field-renamed: single removal + addition with equal types synthesizes one rename', () => {
  const oldIr = makeIr();
  const newIr = withPayment(oldIr, struct('Payment', [
    field('id', prim('uuid')),
    field('amount', prim('int32')),
    field('currencyCode', prim('string')),
  ]));
  const report = diffPackages(oldIr, newIr);
  assert.equal(report.changes.length, 1, JSON.stringify(report.changes));
  const c = report.changes[0] as Change;
  assert.equal(c.kind, 'field-renamed');
  assert.equal(c.classification, 'BREAKING');
  assert.equal(c.path, 'Payment.currencyCode');
  assert.equal(c.old, 'currency');
  assert.equal(c.new, 'currencyCode');
  assert.match(c.message, /Field renamed: Payment\.currency → Payment\.currencyCode/);
  assert.equal(report.verdict, 'BREAKING');
});

test('field-renamed is NOT synthesized when the types differ', () => {
  const oldIr = makeIr();
  const newIr = withPayment(oldIr, struct('Payment', [
    field('id', prim('uuid')),
    field('amount', prim('int32')),
    field('currencyCode', prim('uuid')),
  ]));
  const report = diffPackages(oldIr, newIr);
  assert.deepEqual(
    report.changes.map((c) => c.kind).sort(),
    ['field-added', 'field-removed'],
  );
});

test('field-renamed is NOT synthesized with 2 removals and 1 addition', () => {
  const oldIr = makeIr();
  const newIr = withPayment(oldIr, struct('Payment', [
    field('amount', prim('int32')),
    field('currencyA', prim('string')),
  ]));
  const report = diffPackages(oldIr, newIr);
  const kinds = report.changes.map((c) => c.kind).sort();
  assert.deepEqual(kinds, ['field-added', 'field-removed', 'field-removed']);
});

// ---------------------------------------------------------------------------
// Struct fields: type changes
// ---------------------------------------------------------------------------

function paymentWithAmountType(type: TypeRef): IRPackage {
  return withPayment(makeIr(), struct('Payment', [field('id', prim('uuid')), field('amount', type)]));
}

test('widening int32 → int64 is WARNING', () => {
  const c = oneChange(paymentWithAmountType(prim('int32')), paymentWithAmountType(prim('int64')), 'field-type-changed');
  assert.equal(c.classification, 'WARNING');
  assert.equal(c.old, 'int32');
  assert.equal(c.new, 'int64');
});

test('widening float32 → float64 is WARNING', () => {
  const c = oneChange(
    paymentWithAmountType(prim('float32')),
    paymentWithAmountType(prim('float64')),
    'field-type-changed',
  );
  assert.equal(c.classification, 'WARNING');
});

test('widening uint32 → uint64 is WARNING', () => {
  const c = oneChange(
    paymentWithAmountType(prim('uint32')),
    paymentWithAmountType(prim('uint64')),
    'field-type-changed',
  );
  assert.equal(c.classification, 'WARNING');
});

test('narrowing int64 → int32 is BREAKING', () => {
  const c = oneChange(
    paymentWithAmountType(prim('int64')),
    paymentWithAmountType(prim('int32')),
    'field-type-changed',
  );
  assert.equal(c.classification, 'BREAKING');
});

test('string → int32 is BREAKING', () => {
  const c = oneChange(
    paymentWithAmountType(prim('string')),
    paymentWithAmountType(prim('int32')),
    'field-type-changed',
  );
  assert.equal(c.classification, 'BREAKING');
});

test('named → different named type is BREAKING', () => {
  const oldIr = makeIr();
  const newIr = withPayment(oldIr, struct('Payment', [
    field('id', prim('uuid')),
    field('amount', prim('int32')),
    field('currency', named('CurrencyCode', 'money.v1')),
  ]));
  const c = oneChange(oldIr, newIr, 'field-type-changed');
  assert.equal(c.classification, 'BREAKING');
});

test('json-involved type changes classify UNKNOWN (string → json)', () => {
  const oldIr = makeIr();
  const newIr = withPayment(oldIr, struct('Payment', [
    field('id', prim('uuid')),
    field('amount', prim('int32')),
    field('currency', prim('json')),
  ]));
  const c = oneChange(oldIr, newIr, 'field-type-changed');
  assert.equal(c.classification, 'UNKNOWN');
  assert.match(c.message, /undecidable/);
});

test('json-involved type changes classify UNKNOWN (json → list<int32>)', () => {
  const oldIr = withPayment(makeIr(), struct('Payment', [
    field('id', prim('uuid')),
    field('amount', prim('int32')),
    field('metadata', prim('json')),
  ]));
  const newIr = withPayment(oldIr, struct('Payment', [
    field('id', prim('uuid')),
    field('amount', prim('int32')),
    field('metadata', listOf(prim('int32'))),
  ]));
  const c = oneChange(oldIr, newIr, 'field-type-changed');
  assert.equal(c.classification, 'UNKNOWN');
});

test('json → json is no change at all', () => {
  const ir = withPayment(makeIr(), struct('Payment', [
    field('id', prim('uuid')),
    field('amount', prim('int32')),
    field('metadata', prim('json')),
  ]));
  const report = diffPackages(ir, ir);
  assert.deepEqual(report.changes, []);
});

test('identical named refs (deep, incl. nested map/list) produce no change', () => {
  const t = mapType(prim('string'), listOf(named('Money')));
  const ir = withPayment(makeIr(), struct('Payment', [field('ledger', t)]));
  const report = diffPackages(ir, ir);
  assert.deepEqual(report.changes, []);
});

// ---------------------------------------------------------------------------
// Struct fields: optionality, defaults, constraints, deprecation
// ---------------------------------------------------------------------------

test('required → optional is SAFE', () => {
  const oldIr = makeIr();
  const newIr = withPayment(oldIr, struct('Payment', [
    field('id', prim('uuid')),
    field('amount', prim('int32')),
    field('currency', prim('string'), { optional: true }),
  ]));
  const c = oneChange(oldIr, newIr, 'field-optional-changed');
  assert.equal(c.classification, 'SAFE');
  assert.equal(c.old, 'required');
  assert.equal(c.new, 'optional');
});

test('optional → required is BREAKING', () => {
  const base = withPayment(makeIr(), struct('Payment', [
    field('id', prim('uuid')),
    field('amount', prim('int32')),
    field('currency', prim('string'), { optional: true }),
  ]));
  const newIr = withPayment(base, struct('Payment', [
    field('id', prim('uuid')),
    field('amount', prim('int32')),
    field('currency', prim('string')),
  ]));
  const c = oneChange(base, newIr, 'field-optional-changed');
  assert.equal(c.classification, 'BREAKING');
  assert.equal(c.old, 'optional');
  assert.equal(c.new, 'required');
});

test('field-default-changed is WARNING', () => {
  const oldIr = withPayment(makeIr(), struct('Payment', [
    field('id', prim('uuid')),
    field('amount', prim('int32')),
    field('currency', prim('string'), { default: 'USD' }),
  ]));
  const newIr = withPayment(oldIr, struct('Payment', [
    field('id', prim('uuid')),
    field('amount', prim('int32')),
    field('currency', prim('string'), { default: 'EUR' }),
  ]));
  const c = oneChange(oldIr, newIr, 'field-default-changed');
  assert.equal(c.classification, 'WARNING');
  assert.equal(c.old, 'USD');
  assert.equal(c.new, 'EUR');
  assert.match(c.message, /Default changed: Payment\.currency \(USD → EUR\)/);
});

test('field-default-added is WARNING with old omitted', () => {
  const oldIr = withPayment(makeIr(), struct('Payment', [
    field('id', prim('uuid')),
    field('amount', prim('int32')),
    field('currency', prim('string')),
  ]));
  const newIr = withPayment(oldIr, struct('Payment', [
    field('id', prim('uuid')),
    field('amount', prim('int32')),
    field('currency', prim('string'), { default: 'USD' }),
  ]));
  const c = oneChange(oldIr, newIr, 'field-default-changed');
  assert.equal(c.classification, 'WARNING');
  assert.equal(c.old, undefined);
  assert.equal(c.new, 'USD');
  assert.ok(!('old' in c), 'old key must be absent when no old default existed');
});

test('constraint added is WARNING', () => {
  const oldIr = makeIr();
  const newIr = makeIr({
    types: oldIr.types.map((t) =>
      t.name === 'Money'
        ? struct('Money', [field('amount', prim('int32'), { constraints: [constraint('min', ['0'])] }), field('currency', prim('string'))])
        : t,
    ),
  });
  const c = oneChange(oldIr, newIr, 'field-constraint-changed');
  assert.equal(c.classification, 'WARNING');
  assert.equal(c.path, 'Money.amount');
  assert.match(c.message, /Constraint added: Money\.amount \(min 0\)/);
});

test('constraint removed is WARNING', () => {
  const oldIr = makeIr({
    types: makeIr().types.map((t) =>
      t.name === 'Money'
        ? struct('Money', [field('amount', prim('int32'), { constraints: [constraint('min', ['0'])] }), field('currency', prim('string'))])
        : t,
    ),
  });
  const c = oneChange(oldIr, makeIr(), 'field-constraint-changed');
  assert.equal(c.classification, 'WARNING');
  assert.match(c.message, /Constraint removed: Money\.amount \(min 0\)/);
});

test('constraint arg changed is WARNING (min 0 → min 1)', () => {
  const oldIr = makeIr({
    types: makeIr().types.map((t) =>
      t.name === 'Money'
        ? struct('Money', [field('amount', prim('int32'), { constraints: [constraint('min', ['0'])] }), field('currency', prim('string'))])
        : t,
    ),
  });
  const newIr = makeIr({
    types: oldIr.types.map((t) =>
      t.name === 'Money'
        ? struct('Money', [field('amount', prim('int32'), { constraints: [constraint('min', ['1'])] }), field('currency', prim('string'))])
        : t,
    ),
  });
  const c = oneChange(oldIr, newIr, 'field-constraint-changed');
  assert.equal(c.classification, 'WARNING');
  assert.equal(c.old, 'min 0');
  assert.equal(c.new, 'min 1');
  assert.match(c.message, /Constraint changed: Money\.amount \(min 0 → min 1\)/);
});

test('constraint message-only change is SAFE', () => {
  const oldIr = makeIr({
    types: makeIr().types.map((t) =>
      t.name === 'Money'
        ? struct('Money', [field('amount', prim('int32'), { constraints: [constraint('min', ['0'])] }), field('currency', prim('string'))])
        : t,
    ),
  });
  const newIr = makeIr({
    types: oldIr.types.map((t) =>
      t.name === 'Money'
        ? struct('Money', [
            field('amount', prim('int32'), { constraints: [constraint('min', ['0'], 'Amount must be positive')] }),
            field('currency', prim('string')),
          ])
        : t,
    ),
  });
  const c = oneChange(oldIr, newIr, 'field-constraint-changed');
  assert.equal(c.classification, 'SAFE');
  assert.equal(c.old, undefined);
  assert.equal(c.new, 'Amount must be positive');
  assert.match(c.message, /Constraint message changed: Money\.amount \(min\)/);
});

test('constraint arg AND message changed together is WARNING (args dominate)', () => {
  const oldIr = makeIr();
  const newIr = makeIr({
    types: oldIr.types.map((t) =>
      t.name === 'Money'
        ? struct('Money', [
            field('amount', prim('int32'), { constraints: [constraint('min', ['1'], 'new message')] }),
            field('currency', prim('string')),
          ])
        : t,
    ),
  });
  const c = oneChange(oldIr, newIr, 'field-constraint-changed');
  assert.equal(c.classification, 'WARNING');
});

test('field-deprecated is SAFE', () => {
  const oldIr = makeIr();
  const newIr = withPayment(oldIr, struct('Payment', [
    field('id', prim('uuid')),
    field('amount', prim('int32')),
    field('currency', prim('string'), { deprecated: 'use currencyCode instead' }),
  ]));
  const c = oneChange(oldIr, newIr, 'field-deprecated');
  assert.equal(c.classification, 'SAFE');
  assert.equal(c.new, 'use currencyCode instead');
});

test('field-deprecation-removed is WARNING', () => {
  const oldIr = withPayment(makeIr(), struct('Payment', [
    field('id', prim('uuid')),
    field('amount', prim('int32')),
    field('currency', prim('string'), { deprecated: true }),
  ]));
  const newIr = withPayment(oldIr, struct('Payment', [
    field('id', prim('uuid')),
    field('amount', prim('int32')),
    field('currency', prim('string')),
  ]));
  const c = oneChange(oldIr, newIr, 'field-deprecation-removed');
  assert.equal(c.classification, 'WARNING');
  assert.equal(c.old, 'true');
});

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

test('enum-value-added is WARNING', () => {
  const oldIr = makeIr();
  const newIr = makeIr({ types: oldIr.types.map((t) => (t.name === 'PaymentStatus' ? enumType('PaymentStatus', ['PENDING', 'CAPTURED', 'FAILED', 'REFUNDED']) : t)) });
  const c = oneChange(oldIr, newIr, 'enum-value-added');
  assert.equal(c.classification, 'WARNING');
  assert.equal(c.path, 'PaymentStatus.REFUNDED');
});

test('enum-value-removed is BREAKING', () => {
  const oldIr = makeIr();
  const newIr = makeIr({ types: oldIr.types.map((t) => (t.name === 'PaymentStatus' ? enumType('PaymentStatus', ['PENDING', 'CAPTURED']) : t)) });
  const c = oneChange(oldIr, newIr, 'enum-value-removed');
  assert.equal(c.classification, 'BREAKING');
  assert.equal(c.path, 'PaymentStatus.FAILED');
  assert.equal(c.message, 'PaymentStatus.FAILED removed');
});

// ---------------------------------------------------------------------------
// Unions
// ---------------------------------------------------------------------------

function resultUnion(variants: ReturnType<typeof field>[]): IRPackage {
  return makeIr({ types: [...makeIr().types, unionType('Result', variants)] });
}

test('union-variant-added is WARNING', () => {
  const oldIr = resultUnion([field('ok', named('Payment')), field('error', prim('string'))]);
  const newIr = resultUnion([field('ok', named('Payment')), field('error', prim('string')), field('pending', named('Receipt'))]);
  const c = oneChange(oldIr, newIr, 'union-variant-added');
  assert.equal(c.classification, 'WARNING');
  assert.equal(c.path, 'Result.pending');
});

test('union-variant-removed is BREAKING', () => {
  const oldIr = resultUnion([field('ok', named('Payment')), field('error', prim('string'))]);
  const newIr = resultUnion([field('ok', named('Payment'))]);
  const c = oneChange(oldIr, newIr, 'union-variant-removed');
  assert.equal(c.classification, 'BREAKING');
  assert.equal(c.path, 'Result.error');
});

test('union-variant type change is BREAKING (even a widening)', () => {
  const oldIr = resultUnion([field('ok', named('Payment')), field('error', prim('string'))]);
  const newIr = resultUnion([field('ok', named('Payment')), field('error', named('ErrorInfo'))]);
  const c = oneChange(oldIr, newIr, 'union-variant-changed');
  assert.equal(c.classification, 'BREAKING');
  assert.equal(c.old, 'string');
  assert.equal(c.new, 'ErrorInfo');
});

// ---------------------------------------------------------------------------
// Services and methods
// ---------------------------------------------------------------------------

test('method-added is SAFE', () => {
  const oldIr = makeIr();
  const newIr = makeIr({
    services: [service('Payments', [method('CreatePayment', named('CreatePaymentRequest'), named('Payment')), method('Refund', named('RefundRequest'), named('Receipt'))])],
  });
  const c = oneChange(oldIr, newIr, 'method-added');
  assert.equal(c.classification, 'SAFE');
  assert.equal(c.path, 'Payments.Refund');
});

test('method-removed is BREAKING', () => {
  const oldIr = makeIr();
  const newIr = makeIr({ services: [service('Payments', [])] });
  const c = oneChange(oldIr, newIr, 'method-removed');
  assert.equal(c.classification, 'BREAKING');
  assert.equal(c.path, 'Payments.CreatePayment');
});

test('removed service surfaces as service-removed plus per-method entries', () => {
  const report = diffPackages(makeIr(), makeIr({ services: [] }));
  assert.deepEqual(report.changes.map((c) => [c.kind, c.path]), [
    ['service-removed', 'Payments'],
    ['method-removed', 'Payments.CreatePayment'],
  ]);
  assert.equal(report.verdict, 'BREAKING');
});

test('service-added: empty service is SAFE with exactly one entry', () => {
  const oldIr = makeIr();
  const newIr = makeIr({ services: [...oldIr.services, service('Search', [])] });
  const report = diffPackages(oldIr, newIr);
  assert.deepEqual(report.changes.map((c) => [c.kind, c.path]), [['service-added', 'Search']]);
  const c = report.changes[0] as Change;
  assert.equal(c.classification, 'SAFE');
  assert.equal(c.message, 'Service added: Search');
  assert.equal(report.verdict, 'SAFE');
});

test('service-removed: empty service is BREAKING with exactly one entry', () => {
  const base = makeIr();
  const oldIr = makeIr({ services: [...base.services, service('Search', [])] });
  const report = diffPackages(oldIr, base);
  assert.deepEqual(report.changes.map((c) => [c.kind, c.path]), [['service-removed', 'Search']]);
  const c = report.changes[0] as Change;
  assert.equal(c.classification, 'BREAKING');
  assert.equal(c.message, 'Service removed: Search');
  assert.equal(report.verdict, 'BREAKING');
});

test('removed non-empty service emits envelope plus per-method entries without duplicate paths', () => {
  const oldIr = makeIr({
    services: [
      service('Payments', [
        method('CreatePayment', named('CreatePaymentRequest'), named('Payment')),
        method('Refund', named('RefundRequest'), named('Receipt')),
      ]),
    ],
  });
  const report = diffPackages(oldIr, makeIr({ services: [] }));
  const paths = report.changes.map((c) => c.path);
  assert.equal(new Set(paths).size, paths.length, `duplicate paths: ${JSON.stringify(paths)}`);
  assert.deepEqual(report.changes.map((c) => [c.kind, c.path]), [
    ['service-removed', 'Payments'],
    ['method-removed', 'Payments.CreatePayment'],
    ['method-removed', 'Payments.Refund'],
  ]);
  assert.equal(report.verdict, 'BREAKING');
});

test('added non-empty service emits envelope plus per-method entries without duplicate paths', () => {
  const newIr = makeIr({
    services: [
      service('Payments', [
        method('CreatePayment', named('CreatePaymentRequest'), named('Payment')),
        method('Refund', named('RefundRequest'), named('Receipt')),
      ]),
    ],
  });
  const report = diffPackages(makeIr({ services: [] }), newIr);
  const paths = report.changes.map((c) => c.path);
  assert.equal(new Set(paths).size, paths.length, `duplicate paths: ${JSON.stringify(paths)}`);
  assert.deepEqual(report.changes.map((c) => [c.kind, c.path]), [
    ['service-added', 'Payments'],
    ['method-added', 'Payments.CreatePayment'],
    ['method-added', 'Payments.Refund'],
  ]);
  assert.equal(report.verdict, 'SAFE');
});

test('method-signature-changed input is BREAKING', () => {
  const oldIr = makeIr();
  const newIr = makeIr({
    services: [service('Payments', [method('CreatePayment', named('CreatePaymentRequestV2'), named('Payment'))])],
  });
  const c = oneChange(oldIr, newIr, 'method-signature-changed');
  assert.equal(c.classification, 'BREAKING');
  assert.equal(c.path, 'Payments.CreatePayment.input');
  assert.equal(c.old, 'CreatePaymentRequest');
  assert.equal(c.new, 'CreatePaymentRequestV2');
});

test('method-signature-changed output is BREAKING', () => {
  const oldIr = makeIr();
  const newIr = makeIr({
    services: [service('Payments', [method('CreatePayment', named('CreatePaymentRequest'), named('PaymentReceipt'))])],
  });
  const c = oneChange(oldIr, newIr, 'method-signature-changed');
  assert.equal(c.classification, 'BREAKING');
  assert.equal(c.path, 'Payments.CreatePayment.output');
});

test('equal named refs with cross-package qualifier produce no signature change', () => {
  const ir = makeIr({
    services: [service('Payments', [method('CreatePayment', named('Req', 'payments.v1'), named('Payment'))])],
  });
  const report = diffPackages(ir, ir);
  assert.deepEqual(report.changes, []);
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

test('event-added is SAFE and event-removed is BREAKING', () => {
  const oldIr = makeIr();
  const withMore = makeIr({ events: [...oldIr.events, event('PaymentRefunded', [field('paymentId', prim('uuid'))])] });
  const added = oneChange(oldIr, withMore, 'event-added');
  assert.equal(added.classification, 'SAFE');
  const removed = oneChange(withMore, oldIr, 'event-removed');
  assert.equal(removed.classification, 'BREAKING');
});

test('event field removal nests under EventName.field as event-field-changed', () => {
  const oldIr = makeIr({ events: [event('PaymentCaptured', [field('paymentId', prim('uuid')), field('amount', prim('int32'))])] });
  const newIr = makeIr({ events: [event('PaymentCaptured', [field('paymentId', prim('uuid'))])] });
  const c = oneChange(oldIr, newIr, 'event-field-changed');
  assert.equal(c.classification, 'BREAKING');
  assert.equal(c.path, 'PaymentCaptured.amount');
  assert.equal(c.message, 'PaymentCaptured.amount removed');
});

test('event field type change reuses field rules (widening → WARNING)', () => {
  const oldIr = makeIr({ events: [event('PaymentCaptured', [field('paymentId', prim('uuid')), field('amount', prim('int32'))])] });
  const newIr = makeIr({ events: [event('PaymentCaptured', [field('paymentId', prim('uuid')), field('amount', prim('int64'))])] });
  const c = oneChange(oldIr, newIr, 'event-field-changed');
  assert.equal(c.classification, 'WARNING');
  assert.equal(c.path, 'PaymentCaptured.amount');
  assert.match(c.message, /Type changed: PaymentCaptured\.amount \(int32 → int64\)/);
});

test('event field added required is WARNING under event-field-changed kind', () => {
  const oldIr = makeIr({ events: [event('PaymentCaptured', [field('paymentId', prim('uuid'))])] });
  const newIr = makeIr({ events: [event('PaymentCaptured', [field('paymentId', prim('uuid')), field('currency', prim('string'))])] });
  const c = oneChange(oldIr, newIr, 'event-field-changed');
  assert.equal(c.classification, 'WARNING');
  assert.match(c.message, /Added required field: PaymentCaptured\.currency/);
});

// ---------------------------------------------------------------------------
// Verdict aggregation
// ---------------------------------------------------------------------------

test('verdict aggregation: BREAKING dominates UNKNOWN, WARNING and SAFE', () => {
  const oldIr = makeIr();
  const newIr = makeIr({
    name: 'payments.v2',
    types: [...oldIr.types, struct('Extra', [field('note', prim('string'), { optional: true })])],
  });
  const report = diffPackages(oldIr, newIr);
  const classes = report.changes.map((c) => c.classification);
  assert.ok(classes.includes('BREAKING'), 'package rename is BREAKING');
  assert.ok(classes.includes('SAFE'), 'added type/optional field are SAFE');
  assert.equal(report.verdict, 'BREAKING');
});

test('verdict aggregation: UNKNOWN-only diff yields UNKNOWN verdict', () => {
  const oldIr = withPayment(makeIr(), struct('Payment', [field('id', prim('uuid')), field('amount', prim('int32')), field('currency', prim('json'))]));
  const newIr = withPayment(oldIr, struct('Payment', [field('id', prim('uuid')), field('amount', prim('int32')), field('currency', prim('string'))]));
  const report = diffPackages(oldIr, newIr);
  assert.equal(report.verdict, 'UNKNOWN');
  assert.deepEqual(report.summary, { safe: 0, warning: 0, breaking: 0, unknown: 1 });
});

test('verdict aggregation: WARNING-only diff yields WARNING verdict', () => {
  const oldIr = makeIr();
  const newIr = withPayment(oldIr, struct('Payment', [
    field('id', prim('uuid')),
    field('amount', prim('int64')),
    field('currency', prim('string')),
  ]));
  const report = diffPackages(oldIr, newIr);
  assert.equal(report.verdict, 'WARNING');
  assert.equal(report.summary.warning, 1);
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test('diffing the same inputs twice yields deep-equal reports', () => {
  const oldIr = makeIr({ imports: ['legacy.v1'] });
  const newIr = makeIr({
    name: 'payments.v2',
    imports: ['money.v1'],
    types: [
      struct('Money', [field('amount', prim('int64'), { constraints: [constraint('min', ['1'])] }), field('currency', prim('string'))]),
      unionType('Result', [field('ok', named('Payment')), field('error', prim('string'))]),
      aliasType('CustomerId', prim('int64')),
    ],
    events: [event('PaymentCaptured', [field('paymentId', prim('uuid')), field('amount', prim('int64'))])],
  });
  const r1: CompatReport = diffPackages(oldIr, newIr);
  const r2 = diffPackages(oldIr, newIr);
  assert.deepEqual(r1, r2);
  assert.ok(r1.changes.length >= 5, 'scenario must produce several changes');
});

test('reversed input array order produces the identical report', () => {
  const oldIr = makeIr({ imports: ['legacy.v1'] });
  const newIr = makeIr({
    types: [
      struct('Money', [field('amount', prim('int64')), field('currency', prim('string'))]),
      enumType('PaymentStatus', ['PENDING', 'CAPTURED', 'REFUNDED']),
      unionType('Result', [field('ok', named('Payment')), field('error', prim('string'))]),
    ],
    events: [event('PaymentCaptured', [field('paymentId', prim('uuid')), field('amount', prim('int64'))])],
  });
  const forward = diffPackages(oldIr, newIr);
  const backward = diffPackages(reversed(oldIr), reversed(newIr));
  assert.deepEqual(forward, backward);
});

test('report changes are canonically sorted: BREAKING first, path ascending', () => {
  const oldIr = makeIr();
  const newIr = makeIr({
    name: 'payments.v2',
    types: [
      struct('Money', [field('amount', prim('int64')), field('currency', prim('string'))]),
      struct('Payment', [field('id', prim('uuid')), field('amount', prim('int32')), field('extra', prim('string'))]),
    ],
  });
  const report = diffPackages(oldIr, newIr);
  const classes = report.changes.map((c) => c.classification);
  const firstWarning = classes.indexOf('WARNING');
  const firstBreaking = classes.indexOf('BREAKING');
  assert.ok(firstBreaking !== -1 && firstWarning !== -1);
  assert.ok(firstBreaking < firstWarning, `BREAKING must sort first: ${JSON.stringify(report.changes)}`);
  for (let i = 1; i < report.changes.length; i++) {
    const prev = report.changes[i - 1] as Change;
    const curr = report.changes[i] as Change;
    if (prev.classification === curr.classification && prev.path === curr.path) {
      assert.ok(prev.kind <= curr.kind, 'same path must be ordered by kind');
    }
  }
});
