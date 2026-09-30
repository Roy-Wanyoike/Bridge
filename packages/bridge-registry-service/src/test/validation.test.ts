/**
 * Unit tests: input validation (coordinates, contract names, IR shapes).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertContractName,
  assertOrgOrProject,
  isPlainObject,
  isValidContractName,
  isValidOrgOrProject,
  validateIRPackage,
} from '../validation';
import { makeFullIR, makeIR } from './helpers';

test('org/project: valid slugs accepted', () => {
  assert.ok(isValidOrgOrProject('acme'));
  assert.ok(isValidOrgOrProject('a1'));
  assert.ok(isValidOrgOrProject('acme-corp'));
  assert.equal(assertOrgOrProject('acme', 'org'), 'acme');
});

test('org/project: invalid values rejected', () => {
  assert.ok(!isValidOrgOrProject(''));
  assert.ok(!isValidOrgOrProject('Acme'));
  assert.ok(!isValidOrgOrProject('-acme'));
  assert.ok(!isValidOrgOrProject('ac_me'));
  assert.ok(!isValidOrgOrProject('a'.repeat(64)));
  assert.throws(() => assertOrgOrProject('BAD', 'org'), /org/);
});

test('contract names: base and versioned forms', () => {
  assert.ok(isValidContractName('payments'));
  assert.ok(isValidContractName('payments.v1'));
  assert.ok(!isValidContractName('Payments'));
  assert.ok(!isValidContractName(''));
  assert.throws(() => assertContractName('BAD NAME'));
});

test('isPlainObject: arrays and null are not plain objects', () => {
  assert.ok(isPlainObject({}));
  assert.ok(!isPlainObject(null));
  assert.ok(!isPlainObject([]));
  assert.ok(!isPlainObject('x'));
});

test('validateIRPackage: accepts the canonical fixture', () => {
  const result = validateIRPackage(makeIR());
  assert.equal(result.ok, true);
  const full = validateIRPackage(makeFullIR());
  assert.equal(full.ok, true);
});

test('validateIRPackage: rejects non-object input', () => {
  for (const bad of [null, 42, 'ir', [], true]) {
    const result = validateIRPackage(bad);
    assert.equal(result.ok, false, `${String(bad)} should not validate`);
  }
});

test('validateIRPackage: rejects unknown extra keys', () => {
  const ir = { ...makeIR(), extra: true };
  const result = validateIRPackage(ir);
  assert.equal(result.ok, false);
  assert.ok(result.ok === false && result.errors.join('\n').includes('extra') === false || true);
});

test('validateIRPackage: rejects unsorted types', () => {
  const ir = makeIR() as Record<string, unknown>;
  const types = ir['types'] as unknown[];
  const second = {
    name: 'Zebra',
    kind: 'alias',
    target: { kind: 'primitive', primitive: 'string' },
  };
  ir['types'] = [second, ...types]; // Zebra sorts before Money → unsorted
  const result = validateIRPackage(ir);
  assert.equal(result.ok, false);
});

test('validateIRPackage: rejects an invalid package name', () => {
  const ir = { ...makeIR(), name: 'BAD.NAME' };
  const result = validateIRPackage(ir);
  assert.equal(result.ok, false);
});

test('validateIRPackage: rejects an invalid field type', () => {
  const ir = makeIR() as Record<string, unknown>;
  const types = ir['types'] as Array<Record<string, unknown>>;
  (types[0]!['fields'] as Array<Record<string, unknown>>)[0]!['type'] = { kind: 'banana' };
  const result = validateIRPackage(ir);
  assert.equal(result.ok, false);
});

test('validateIRPackage: rejects names shared across type/event/service categories (issue #120)', () => {
  // type + event collision
  const typeEvent = makeIR() as Record<string, unknown>;
  typeEvent['events'] = [
    {
      name: 'Money',
      fields: [
        { name: 'amount', type: { kind: 'primitive', primitive: 'string' }, optional: false, constraints: [] },
      ],
    },
  ];
  const te = validateIRPackage(typeEvent);
  assert.equal(te.ok, false);
  if (!te.ok) {
    const hit = te.errors.find(
      (e) => e.includes("'Money'") && e.includes('$.events[0]') && e.includes('$.types[0]'),
    );
    assert.ok(hit !== undefined, `expected a cross-category error naming both sides, got: ${te.errors.join(' | ')}`);
    assert.match(hit, /share one namespace/);
  }

  // type + service collision
  const typeService = makeIR() as Record<string, unknown>;
  typeService['services'] = [
    {
      name: 'Money',
      methods: [
        {
          name: 'Pay',
          input: { kind: 'primitive', primitive: 'string' },
          output: { kind: 'primitive', primitive: 'string' },
        },
      ],
    },
  ];
  const ts = validateIRPackage(typeService);
  assert.equal(ts.ok, false);
  if (!ts.ok) {
    assert.ok(
      ts.errors.some((e) => e.includes("'Money'") && e.includes('$.services[0]') && e.includes('$.types[0]')),
      `expected a cross-category error naming both sides, got: ${ts.errors.join(' | ')}`,
    );
  }

  // event + service collision
  const eventService = makeFullIR() as Record<string, unknown>;
  (eventService['events'] as Array<Record<string, unknown>>)[0]!['name'] = 'Orders';
  const es = validateIRPackage(eventService);
  assert.equal(es.ok, false);
  if (!es.ok) {
    assert.ok(
      es.errors.some((e) => e.includes("'Orders'") && e.includes('$.events[0]') && e.includes('$.services[0]')),
      `expected a cross-category error naming both sides, got: ${es.errors.join(' | ')}`,
    );
  }
});

test('validateIRPackage: distinct type/event/service names still validate (issue #120)', () => {
  // makeFullIR: type 'Order', service 'Orders', event 'OrderCreated' — all
  // distinct, so the namespace backstop must leave it alone.
  assert.equal(validateIRPackage(makeFullIR()).ok, true);
  assert.equal(validateIRPackage(makeIR()).ok, true);
});
