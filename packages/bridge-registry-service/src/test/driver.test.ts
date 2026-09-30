/**
 * Unit tests: the in-memory storage driver (publish/immutability/pull/
 * search/graph) and the token-bucket rate limiter.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPackage } from '@bridge/core';
import { InMemoryDriver } from '../storage/memory';
import { DEFAULT_AUDIT_RETENTION_DAYS, PostgresDriver } from '../storage/postgres/driver';
import { TokenBucketLimiter } from '../ratelimit';
import { makeFullIR, makeIR } from './helpers';
import type { PublishInput } from '../types';

function publishInput(overrides: Partial<PublishInput> = {}): PublishInput {
  return {
    org: 'acme',
    project: 'payments',
    ir: makeIR() as never,
    meta: {},
    publishedBy: 'user-1',
    ...overrides,
  };
}

test('driver: publish creates a version and returns full meta', async () => {
  const driver = new InMemoryDriver();
  await driver.init();
  const result = await driver.publish(publishInput());
  assert.equal(result.outcome, 'created');
  assert.equal(result.meta.org, 'acme');
  assert.equal(result.meta.project, 'payments');
  assert.equal(result.meta.base, 'payments');
  assert.equal(result.meta.version, 'v1');
  assert.equal(result.meta.hash, hashPackage(makeIR() as never));
  assert.equal(result.meta.publishedBy, 'user-1');
  await driver.close();
});

test('driver: identical republish replays; different content conflicts', async () => {
  const driver = new InMemoryDriver();
  await driver.init();
  const first = await driver.publish(publishInput());
  assert.equal(first.outcome, 'created');

  // Identical content → idempotent replay.
  const replay = await driver.publish(publishInput());
  assert.equal(replay.outcome, 'replayed');
  assert.equal(replay.meta.hash, first.meta.hash);

  // Different content, same version → immutability conflict.
  const changed = makeIR() as Record<string, unknown>;
  (changed['types'] as unknown[])[0] = {
    name: 'Money',
    kind: 'struct',
    fields: [
      { name: 'amount', type: { kind: 'primitive', primitive: 'int32' }, optional: false, constraints: [] },
    ],
  };
  await assert.rejects(
    () => driver.publish(publishInput({ ir: changed as never })),
    /immutable/i,
  );
  await driver.close();
});

test('driver: pull re-verifies integrity and returns ir + meta', async () => {
  const driver = new InMemoryDriver();
  await driver.init();
  await driver.publish(publishInput());
  const stored = await driver.pull('acme', 'payments', 'payments', 'v1');
  assert.equal(stored.meta.version, 'v1');
  assert.equal((stored.ir as { name: string }).name, 'payments.v1');
  await assert.rejects(
    () => driver.pull('acme', 'payments', 'payments', 'v2'),
    (err: { code?: string }) => err.code === 'not-found',
  );
  await driver.close();
});

test('driver: versions/latest/list/search are org-scoped', async () => {
  const driver = new InMemoryDriver();
  await driver.init();
  await driver.publish(publishInput());
  await driver.publish(publishInput({ ir: makeFullIR('orders.v1') as never, project: 'orders' }));

  assert.deepEqual(await driver.versions('acme', 'payments', 'payments'), ['v1']);
  const latest = await driver.latest('acme', 'orders', 'orders');
  assert.equal(latest.packageName, 'orders.v1');
  assert.equal((await driver.list('acme', 'payments')).length, 1);
  // Another org sees nothing.
  assert.equal((await driver.list('other', 'payments')).length, 0);
  const hits = await driver.search('acme', null, 'orders');
  assert.equal(hits.length, 1);
  await driver.close();
});

test('driver: dependents + dependency closure (BFS, cycle-safe)', async () => {
  const driver = new InMemoryDriver();
  await driver.init();
  // Same-project imports: orders.v2 imports payments.v1 (published in the
  // same project, which is the scope the dependency graph traverses).
  const ordersV2 = makeFullIR('orders.v2') as Record<string, unknown>;
  ordersV2['imports'] = ['payments.v1'];
  await driver.publish(publishInput({ project: 'orders', ir: makeFullIR('orders.v1') as never }));
  await driver.publish(publishInput({ project: 'orders', ir: ordersV2 as never, version: 'v2' }));
  await driver.publish(publishInput({ project: 'orders' }));

  const dependents = await driver.dependents('acme', 'orders', 'payments');
  assert.equal(dependents.length, 1); // only orders.v2 imports payments.
  const closure = await driver.dependencies('acme', 'orders', 'orders', 'v2');
  assert.ok(closure.includes('payments.v1'));
  await driver.close();
});

test('driver: audit entries append and query with filters', async () => {
  const driver = new InMemoryDriver();
  await driver.init();
  await driver.appendAudit({
    time: new Date().toISOString(),
    org: 'acme',
    project: 'payments',
    actor: 'user-1',
    action: 'publish',
    contract: 'payments',
    version: 'v1',
    ok: true,
    status: 201,
    ip: '127.0.0.1',
  });
  const all = await driver.queryAudit({});
  assert.equal(all.length, 1);
  const byActor = await driver.queryAudit({ actor: 'nobody' });
  assert.equal(byActor.length, 0);
  await driver.close();
});

test('postgres driver: auditRetentionDays is validated eagerly, no connection (issue #48)', () => {
  assert.throws(() => new PostgresDriver({ dsn: 'postgres://u:p@h/db', auditRetentionDays: 0 }), /auditRetentionDays/);
  assert.throws(
    () => new PostgresDriver({ dsn: 'postgres://u:p@h/db', auditRetentionDays: 1.5 }),
    /auditRetentionDays/,
  );
  assert.doesNotThrow(() => new PostgresDriver({ dsn: 'postgres://u:p@h/db', auditRetentionDays: 30 }));
});

test('postgres driver: audit retention defaults ON at 30 days, overridable (issue #120)', () => {
  assert.equal(DEFAULT_AUDIT_RETENTION_DAYS, 30);
  // No option → the documented default applies (previously: pruning off).
  const defaulted = new PostgresDriver({ dsn: 'postgres://u:p@h/db' });
  assert.equal(defaulted.auditRetentionDays, 30);
  // An explicit window overrides the default; eager validation is unchanged.
  const tuned = new PostgresDriver({ dsn: 'postgres://u:p@h/db', auditRetentionDays: 7 });
  assert.equal(tuned.auditRetentionDays, 7);
  assert.throws(() => new PostgresDriver({ dsn: 'postgres://u:p@h/db', auditRetentionDays: 0 }), /auditRetentionDays/);
});

// ------------------------------------------------------------ rate limiter

test('rate limiter: tokens deplete, then 429 with Retry-After', () => {
  let now = 1_000_000;
  const limiter = new TokenBucketLimiter({
    enabled: true,
    auth: { capacity: 3, refillPerSecond: 1 },
    now: () => now,
  });
  assert.equal(limiter.take('auth', 'ip-1').ok, true);
  assert.equal(limiter.take('auth', 'ip-1').ok, true);
  const third = limiter.take('auth', 'ip-1');
  assert.equal(third.ok, true);
  const fourth = limiter.take('auth', 'ip-1');
  assert.equal(fourth.ok, false);
  assert.ok(fourth.retryAfterSeconds >= 1);

  // After 5 seconds one token refilled → allowed again.
  now += 5_000;
  assert.equal(limiter.take('auth', 'ip-1').ok, true);
});

test('rate limiter: separate buckets per key and tier', () => {
  const limiter = new TokenBucketLimiter({
    enabled: true,
    auth: { capacity: 1, refillPerSecond: 1 },
    publish: { capacity: 1, refillPerSecond: 1 },
    now: () => 1_000_000,
  });
  assert.equal(limiter.take('auth', 'ip-a').ok, true);
  assert.equal(limiter.take('auth', 'ip-b').ok, true); // other bucket
  assert.equal(limiter.take('auth', 'ip-a').ok, false);
  assert.equal(limiter.take('publish', 'user-1|ip-a').ok, true); // other tier
});

test('rate limiter: disabled limiter always allows', () => {
  const limiter = new TokenBucketLimiter({ enabled: false });
  for (let i = 0; i < 100; i++) {
    assert.equal(limiter.take('auth', 'ip').ok, true);
  }
});
