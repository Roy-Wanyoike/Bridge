/**
 * Gate-decision (`check`), rendering (`formatReport`) and serialization
 * (`toJson`) tests for the Bridge compatibility engine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check, diffPackages, formatReport, toJson } from '../index';
import type { CompatReport, IRPackage } from '../index';
import { constraint, enumType, field, makeIr, prim, service, struct } from './fixtures';

// ---------------------------------------------------------------------------
// Fixtures for this suite
// ---------------------------------------------------------------------------

/** Old package: baseline. */
function oldPkg(): IRPackage {
  return makeIr();
}

/** New package with a BREAKING change (field removed). */
function breakingPkg(): IRPackage {
  const base = makeIr();
  return {
    ...base,
    types: base.types.map((t) =>
      t.name === 'Payment' ? struct('Payment', [field('id', prim('uuid')), field('amount', prim('int32'))]) : t,
    ),
  };
}

/** New package with only a WARNING change (widening int32 → int64). */
function warningPkg(): IRPackage {
  const base = makeIr();
  return {
    ...base,
    types: base.types.map((t) =>
      t.name === 'Money' ? struct('Money', [field('amount', prim('int64')), field('currency', prim('string'))]) : t,
    ),
  };
}

/** New package with only an UNKNOWN change (string → json). */
function unknownPkg(): IRPackage {
  const base = makeIr();
  return {
    ...base,
    types: base.types.map((t) =>
      t.name === 'Payment'
        ? struct('Payment', [field('id', prim('uuid')), field('amount', prim('int32')), field('currency', prim('json'))])
        : t,
    ),
  };
}

// ---------------------------------------------------------------------------
// check(): gate decisions
// ---------------------------------------------------------------------------

test('check strict: BREAKING fails', () => {
  const { passed, report } = check(oldPkg(), breakingPkg());
  assert.equal(passed, false);
  assert.equal(report.verdict, 'BREAKING');
});

test('check strict: UNKNOWN fails', () => {
  const { passed, report } = check(oldPkg(), unknownPkg());
  assert.equal(passed, false);
  assert.equal(report.verdict, 'UNKNOWN');
});

test('check strict: WARNING passes', () => {
  const { passed, report } = check(oldPkg(), warningPkg());
  assert.equal(passed, true);
  assert.equal(report.verdict, 'WARNING');
});

test('check strict: SAFE passes', () => {
  const { passed, report } = check(oldPkg(), oldPkg());
  assert.equal(passed, true);
  assert.equal(report.verdict, 'SAFE');
});

test('check compatible: BREAKING still fails', () => {
  const { passed } = check(oldPkg(), breakingPkg(), { mode: 'compatible' });
  assert.equal(passed, false);
});

test('check compatible: UNKNOWN passes', () => {
  const { passed } = check(oldPkg(), unknownPkg(), { mode: 'compatible' });
  assert.equal(passed, true);
});

test('check compatible: WARNING passes', () => {
  const { passed } = check(oldPkg(), warningPkg(), { mode: 'compatible' });
  assert.equal(passed, true);
});

test('check respects packageRenameBreaking option', () => {
  const strictRenamed = check(oldPkg(), makeIr({ name: 'payments.v2' }));
  assert.equal(strictRenamed.passed, false);
  const lenientRenamed = check(oldPkg(), makeIr({ name: 'payments.v2' }), { packageRenameBreaking: false });
  assert.equal(lenientRenamed.passed, true);
});

// ---------------------------------------------------------------------------
// formatReport()
// ---------------------------------------------------------------------------

/** Build a mixed report: breaking + unknown + warning + safe changes. */
function mixedReport(): CompatReport {
  const oldIr = makeIr({ imports: ['legacy.v1'] });
  const newIr = makeIr({
    name: 'payments.v2',
    imports: ['money.v1'],
    types: [
      struct('Money', [field('amount', prim('int64'), { constraints: [constraint('min', ['1'])] }), field('currency', prim('string'))]),
      struct('Payment', [field('id', prim('uuid')), field('amount', prim('int32')), field('currency', prim('json'))]),
      enumType('PaymentStatus', ['PENDING', 'CAPTURED', 'FAILED', 'REFUNDED']),
      struct('Receipt', [field('paymentId', prim('uuid')), field('note', prim('string'), { optional: true })]),
    ],
  });
  return diffPackages(oldIr, newIr);
}

test('formatReport renders header, sorted groups and verdict lines', () => {
  const text = formatReport(mixedReport());
  const lines = text.split('\n');

  assert.equal(lines[0], 'BRIDGE COMPATIBILITY REPORT');
  assert.equal(lines[1], 'package: payments.v2');

  // Contains the required symbol lines.
  assert.ok(lines.some((l) => l.startsWith('❌ Breaking: ')), text);
  assert.ok(lines.some((l) => l.startsWith('? ')), `unknown line missing:\n${text}`);
  assert.ok(lines.some((l) => l.startsWith('⚠ ')), text);
  assert.ok(lines.some((l) => l.startsWith('✓ ')), text);

  // Sorted: first ❌ line appears before the first ?, ⚠ and ✓ lines.
  const firstOf = (prefix: string): number => lines.findIndex((l) => l.startsWith(prefix));
  const breaking = firstOf('❌');
  const unknown = firstOf('? ');
  const warning = firstOf('⚠ ');
  const safe = firstOf('✓ ');
  assert.ok(breaking !== -1 && breaking < unknown && unknown < warning && warning < safe, text);

  // Summary, verdict label and gate line.
  const summary = lines.find((l) => l.startsWith('Summary: '));
  assert.ok(summary !== undefined, text);
  assert.match(summary as string, /(\d+) safe, (\d+) warnings, (\d+) breaking, (\d+) unknown/);
  assert.ok(lines.includes('Verdict: BREAKING'), text);
  assert.ok(lines.includes('Compatibility: FAILED'), text);
});

test('formatReport counts match report summary', () => {
  const report = mixedReport();
  const text = formatReport(report);
  const perClass = (prefix: string): number => text.split('\n').filter((l) => l.startsWith(prefix)).length;
  assert.equal(perClass('❌'), report.summary.breaking);
  assert.equal(perClass('⚠ '), report.summary.warning);
  assert.equal(perClass('✓ '), report.summary.safe);
  assert.equal(perClass('? '), report.summary.unknown);
});

test('formatReport prints PASSED for warnings-only (strict gate passes WARNING)', () => {
  const oldIr = makeIr();
  const newIr = makeIr({
    types: oldIr.types.map((t) =>
      t.name === 'Money' ? struct('Money', [field('amount', prim('int64')), field('currency', prim('string'))]) : t,
    ),
  });
  const report = diffPackages(oldIr, newIr);
  assert.equal(report.verdict, 'WARNING');
  const text = formatReport(report);
  assert.ok(text.includes('Verdict: WARNING'), text);
  assert.ok(text.includes('Compatibility: PASSED'), text);
});

test('formatReport prints PASSED for an empty (SAFE) report', () => {
  const report = diffPackages(makeIr(), makeIr());
  const text = formatReport(report);
  assert.ok(text.includes('Summary: 0 safe, 0 warnings, 0 breaking, 0 unknown'), text);
  assert.ok(text.includes('Verdict: SAFE'), text);
  assert.ok(text.includes('Compatibility: PASSED'), text);
});

test('formatReport keeps breaking lines first and path-sorted within groups', () => {
  const oldIr = makeIr();
  const newIr = makeIr({ services: [] }); // removes the service and its only method
  const text = formatReport(diffPackages(oldIr, newIr));
  const breakingLines = text
    .split('\n')
    .filter((l) => l.startsWith('❌'))
    .map((l) => l.replace('❌ Breaking: ', ''));
  assert.deepEqual(breakingLines, ['Service removed: Payments', 'Method removed: Payments.CreatePayment']);
});

test('formatReport renders service-added as a SAFE line and passes the gate', () => {
  const oldIr = makeIr({ services: [] });
  const newIr = makeIr({ services: [service('Search', [])] });
  const report = diffPackages(oldIr, newIr);
  assert.equal(report.verdict, 'SAFE');
  const text = formatReport(report);
  assert.ok(text.includes('✓ Service added: Search'), text);
  assert.ok(text.includes('Summary: 1 safe, 0 warnings, 0 breaking, 0 unknown'), text);
  assert.ok(text.includes('Verdict: SAFE'), text);
  assert.ok(text.includes('Compatibility: PASSED'), text);
});

test('formatReport renders service-removed as a breaking line and fails the gate', () => {
  const oldIr = makeIr({ services: [service('Search', [])] });
  const newIr = makeIr({ services: [] });
  const report = diffPackages(oldIr, newIr);
  assert.equal(report.verdict, 'BREAKING');
  const text = formatReport(report);
  assert.ok(text.includes('❌ Breaking: Service removed: Search'), text);
  assert.ok(text.includes('Summary: 0 safe, 0 warnings, 1 breaking, 0 unknown'), text);
  assert.ok(text.includes('Verdict: BREAKING'), text);
  assert.ok(text.includes('Compatibility: FAILED'), text);
});

// ---------------------------------------------------------------------------
// toJson()
// ---------------------------------------------------------------------------

test('toJson round-trips through JSON.parse preserving counts and changes', () => {
  const report = mixedReport();
  const parsed = JSON.parse(toJson(report)) as CompatReport;
  assert.equal(parsed.packageName, report.packageName);
  assert.equal(parsed.verdict, report.verdict);
  assert.deepEqual(parsed.summary, report.summary);
  assert.equal(parsed.changes.length, report.changes.length);
  assert.deepEqual(parsed.changes, report.changes);
});

test('toJson emits deterministic key order and omits absent old/new', () => {
  const oldIr = makeIr();
  const newIr = makeIr({
    types: [
      struct('Money', [field('amount', prim('int32')), field('currency', prim('string'), { default: 'USD' })]),
      struct('Payment', [field('id', prim('uuid')), field('amount', prim('int32'))]),
      enumType('PaymentStatus', ['PENDING', 'CAPTURED', 'FAILED']),
    ],
  });
  const json = toJson(diffPackages(oldIr, newIr));
  const parsed = JSON.parse(json) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), ['packageName', 'changes', 'verdict', 'summary']);
  const firstChange = (parsed['changes'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
  const keySet = Object.keys(firstChange);
  for (const key of keySet) assert.ok(['path', 'kind', 'classification', 'message', 'old', 'new'].includes(key));
  assert.equal(keySet[0], 'path');
  // package-renamed style changes carry both old and new; removals carry old only.
  const removal = (parsed['changes'] as Array<Record<string, unknown>>).find((c) => c['kind'] === 'field-removed');
  assert.ok(removal !== undefined);
  assert.equal(removal?.['old'], 'string');
  assert.equal('new' in (removal as Record<string, unknown>), false);
});
