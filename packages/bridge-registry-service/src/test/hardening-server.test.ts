/**
 * Issue #120 hardening tests (W2-120a):
 * 1. audit append failures fail the request by default (`auditFailureMode`),
 *    `best-effort` logs `audit.dropped` and serves the response;
 * 2. per-IP cap on persisted failed-auth audit entries protects the ring;
 * 3. rate limiter: timer/lazy sweep (`sweepNow`) + hard bucket cap with
 *    oldest-first eviction;
 * 4. publish coordinate binding: URL contract vs body/ir.name (400), audit
 *    contract from stored meta, v2 signed envelope binding route coordinates;
 * 5. security headers on every response + 415 for non-JSON publishes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { canonicalJson } from '@bridge/core';
import type { AddressInfo } from 'node:net';
import { InMemoryDriver } from '../storage/memory';
import { createServer as serviceCreateServer } from '../server';
import { MAX_BUCKETS, SWEEP_IDLE_MS, SWEEP_INTERVAL_MS, TokenBucketLimiter } from '../ratelimit';
import { SIGNED_ENVELOPE_KEY } from '../signing';
import type { AuditBackend, AuditEntry, RegistryServiceOptions } from '../types';
import { makeIR, request } from './helpers';

const READ = 'read-token';
const WRITE = 'write-token';
const ADMIN = 'admin-token';

interface TestCtx {
  url: string;
  driver: InMemoryDriver;
  close: () => Promise<void>;
}

async function withServer(
  extra: Record<string, unknown> = {},
  fn: (ctx: TestCtx) => Promise<void>,
): Promise<void> {
  const driver = new InMemoryDriver();
  await driver.init();
  const server = serviceCreateServer({
    driver,
    auth: {
      tokens: {
        [READ]: { tenant: 'acme', role: 'read' },
        [WRITE]: { tenant: 'acme', role: 'write' },
        [ADMIN]: { tenant: 'acme', role: 'admin' },
      },
    },
    rateLimit: { enabled: false },
    ...extra,
  } as never);
  server.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;
  await fn({
    url,
    driver,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Audit backend whose appends always fail (driver outage simulation). */
class FailingAuditBackend implements AuditBackend {
  public append(_entry: AuditEntry): void {
    throw new Error('audit disk unavailable');
  }

  public async query(): Promise<AuditEntry[]> {
    return [];
  }
}

// --------------------------------------------------- 1: audit fail-closed

test('audit append failure fails the request (auditFailureMode=fail default, issue #120)', async () => {
  await withServer({ audit: new FailingAuditBackend() }, async ({ url }) => {
    // An audited /v1 route that would otherwise succeed (200) is rejected.
    const search = await request(url, 'GET', '/v1/search?q=x', { token: READ });
    assert.equal(search.status, 500);
    assert.equal(search.json.error.code, 'internal');
    assert.match(search.json.error.message, /audit append failed/);

    // Routes that are not audited at all still work (fail-closed scope).
    const health = await request(url, 'GET', '/healthz');
    assert.equal(health.status, 200);
  });
});

test('auditFailureMode=best-effort serves the response and logs audit.dropped (issue #120)', async () => {
  const recorded: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    recorded.push(args);
  };
  try {
    await withServer(
      { audit: new FailingAuditBackend(), auditFailureMode: 'best-effort' },
      async ({ url }) => {
        const search = await request(url, 'GET', '/v1/search?q=x', { token: READ });
        assert.equal(search.status, 200);
        assert.deepEqual(search.json.results, []);
      },
    );
  } finally {
    console.error = original;
  }
  assert.ok(
    recorded.some((args) => args[0] === 'audit.dropped'),
    'expected a stderr line starting with audit.dropped',
  );
});

// ------------------------------------------- 2: auth-flood ring protection

test('auth flood cannot evict pre-seeded audit history (issue #120)', async () => {
  await withServer({}, async ({ url, driver }) => {
    const seed: AuditEntry = {
      time: new Date().toISOString(),
      org: 'acme',
      project: 'payments',
      actor: 'token:acme',
      action: 'read',
      contract: 'payments',
      version: 'v1',
      ok: true,
      status: 200,
      ip: '10.0.0.1',
    };
    await driver.appendAudit(seed);

    // 25 failed auths WITH well-formed bearer tokens from one IP (the
    // per-IP window cap is 20) — previously all 25 would be persisted.
    for (let i = 0; i < 25; i++) {
      const r = await request(url, 'GET', '/v1/search?q=x', { token: `wrong-token-${i}` });
      assert.equal(r.status, 401);
    }
    // Pre-auth noise (no header) is skipped entirely, gate or not.
    const noHeader = await request(url, 'GET', '/v1/search?q=x');
    assert.equal(noHeader.status, 401);

    const entries = await request(url, 'GET', '/v1/audit?limit=10000', { token: ADMIN });
    assert.equal(entries.status, 200);
    const rows = entries.json.entries as AuditEntry[];
    const authRows = rows.filter((e) => e.action === 'auth');
    assert.equal(authRows.length, 20, 'the per-IP window cap bounds persisted auth failures');
    assert.ok(authRows.every((e) => e.status === 401 && e.ok === false));
    assert.ok(
      rows.some((e) => e.action === 'read' && e.ok === true && e.ip === '10.0.0.1'),
      'the pre-seeded legitimate entry survived the flood',
    );
  });
});

// ------------------------------------------------ 3: rate limiter sweeping

test('limiter: sweepNow evicts idle buckets (issue #120)', () => {
  let t = 0;
  const limiter = new TokenBucketLimiter({ enabled: true, now: () => t });
  try {
    assert.equal(SWEEP_INTERVAL_MS, 60_000);
    limiter.take('auth', 'idle');
    t = SWEEP_IDLE_MS + 1;
    limiter.take('auth', 'fresh');
    const removed = limiter.sweepNow();
    assert.equal(removed, 1);
    assert.equal(limiter.hasBucket('idle'), false);
    assert.equal(limiter.hasBucket('fresh'), true);
    assert.equal(limiter.sweepNow(), 0, 'a second sweep finds nothing left to drop');
  } finally {
    limiter.dispose();
  }
});

test('limiter: hard bucket cap evicts the oldest buckets (issue #120)', () => {
  let t = 0;
  const limiter = new TokenBucketLimiter({ enabled: true, now: () => t });
  try {
    for (let i = 0; i < MAX_BUCKETS; i++) {
      t = i; // every bucket gets a distinct, strictly increasing lastMs
      limiter.take('auth', `k${i}`);
    }
    assert.equal(limiter.bucketCount, MAX_BUCKETS);
    t = MAX_BUCKETS;
    limiter.take('auth', `k${MAX_BUCKETS}`); // one over the cap
    assert.equal(limiter.bucketCount, MAX_BUCKETS, 'the cap is enforced');
    assert.equal(limiter.hasBucket('k0'), false, 'the OLDEST bucket was evicted');
    assert.equal(limiter.hasBucket(`k${MAX_BUCKETS - 1}`), true);
    assert.equal(limiter.hasBucket(`k${MAX_BUCKETS}`), true, 'the newest bucket survives');
  } finally {
    limiter.dispose();
  }
});

// ------------------------------------------- 4: publish coordinate binding

test('URL-embedded publish rejects bodies naming a different contract (issue #120)', async () => {
  await withServer({}, async ({ url }) => {
    // ir.name disagrees with the URL contract.
    const irMismatch = await request(url, 'PUT', '/v1/orgs/acme/projects/payments/contracts/other.v1', {
      token: WRITE,
      body: { ir: makeIR() },
    });
    assert.equal(irMismatch.status, 400);
    assert.match(irMismatch.json.error.message, /does not match the URL contract/);

    // body.packageName disagrees with the URL contract.
    const pkgMismatch = await request(url, 'PUT', '/v1/orgs/acme/projects/payments/contracts/payments.v1', {
      token: WRITE,
      body: { packageName: 'other.v1', ir: makeIR() },
    });
    assert.equal(pkgMismatch.status, 400);
    assert.match(pkgMismatch.json.error.message, /body\.packageName/);

    // A captured payments.v1 body replayed into the v2 slot is rejected.
    const slotReplay = await request(url, 'PUT', '/v1/orgs/acme/projects/payments/contracts/payments.v2', {
      token: WRITE,
      body: { ir: makeIR() },
    });
    assert.equal(slotReplay.status, 400);
    assert.match(slotReplay.json.error.message, /does not match the URL contract/);

    // Matching bodies keep working, including versionless route names.
    const ok = await request(url, 'PUT', '/v1/orgs/acme/projects/payments/contracts/payments.v1', {
      token: WRITE,
      body: { ir: makeIR() },
    });
    assert.equal(ok.status, 201);
    const versionless = await request(url, 'PUT', '/v1/orgs/acme/projects/payments/contracts/payments', {
      token: WRITE,
      body: { ir: makeIR() },
    });
    assert.ok([200, 201].includes(versionless.status));
  });
});

test('project-scoped publish audit records the contract from stored meta (issue #120)', async () => {
  await withServer({}, async ({ url }) => {
    // The body-declared packageName ('wrapper') disagrees with ir.name
    // ('payments.v1'); the driver stores under the IR-derived base, and the
    // audit entry must reflect the STORED truth, not the declared name.
    const created = await request(url, 'POST', '/v1/orgs/acme/projects/payments/contracts', {
      token: WRITE,
      body: { packageName: 'wrapper', ir: makeIR() },
    });
    assert.equal(created.status, 201);
    assert.equal(created.json.meta.packageName, 'payments.v1');

    const entries = await request(url, 'GET', '/v1/audit?action=publish&status=201', { token: ADMIN });
    assert.equal(entries.status, 200);
    const publishEntries = entries.json.entries as AuditEntry[];
    assert.equal(publishEntries.length, 1);
    assert.equal(publishEntries[0]!.contract, 'payments', 'audit contract comes from stored meta.base');
    assert.equal(publishEntries[0]!.version, 'v1');
  });
});

test('v2 signature envelope binds the publish to the route coordinates (issue #120)', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const sign = (payload: unknown): string =>
    cryptoSign(null, Buffer.from(canonicalJson(payload), 'utf8'), privateKey).toString('base64');
  const envelopeHeaders = (payload: unknown): Record<string, string> => ({
    'x-bridge-key-id': 'k1',
    'x-bridge-signature': sign(payload),
  });

  await withServer({ signing: { keys: { k1: pem } } }, async ({ url }) => {
    // Legacy body-only format (the CLI's current format) still works.
    const legacyBody = { ir: makeIR('legacy.v1') };
    const legacy = await request(url, 'PUT', '/v1/orgs/acme/projects/payments/contracts/legacy.v1', {
      token: WRITE,
      body: legacyBody,
      headers: envelopeHeaders(legacyBody),
    });
    assert.equal(legacy.status, 201);

    // V2 envelope: sign the coordinates + body hash, embed under the
    // reserved key, send the usual headers.
    const body: Record<string, unknown> = { packageName: 'payments.v1', ir: makeIR() };
    const envelope = {
      version: 2,
      org: 'acme',
      project: 'payments',
      contract: 'payments.v1',
      contractVersion: 'v1',
      bodyHash: createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex'),
    };
    const v2 = await request(url, 'PUT', '/v1/orgs/acme/projects/payments/contracts/payments.v1', {
      token: WRITE,
      body: { ...body, [SIGNED_ENVELOPE_KEY]: envelope },
      headers: envelopeHeaders(envelope),
    });
    assert.equal(v2.status, 201);
    assert.equal(v2.json.meta.packageName, 'payments.v1');

    // Versionless route: contractVersion null is accepted on a bare URL.
    const bareBody: Record<string, unknown> = { ir: makeIR('slate.v1') };
    const bareEnvelope = {
      version: 2,
      org: 'acme',
      project: 'payments',
      contract: 'slate',
      contractVersion: null,
      bodyHash: createHash('sha256').update(canonicalJson(bareBody), 'utf8').digest('hex'),
    };
    const bare = await request(url, 'PUT', '/v1/orgs/acme/projects/payments/contracts/slate', {
      token: WRITE,
      body: { ...bareBody, [SIGNED_ENVELOPE_KEY]: bareEnvelope },
      headers: envelopeHeaders(bareEnvelope),
    });
    assert.equal(bare.status, 201);
  });
});

test('v2 envelope rejects tampered bodies and foreign route slots (issue #120)', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  await withServer({ signing: { keys: { k1: pem } } }, async ({ url }) => {
    const body: Record<string, unknown> = { ir: makeIR() };
    const envelope = {
      version: 2,
      org: 'acme',
      project: 'payments',
      contract: 'payments.v1',
      contractVersion: 'v1',
      bodyHash: createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex'),
    };
    const headers = {
      'x-bridge-key-id': 'k1',
      'x-bridge-signature': cryptoSign(
        null,
        Buffer.from(canonicalJson(envelope), 'utf8'),
        privateKey,
      ).toString('base64'),
    };

    // Tampered body: the body hash no longer matches.
    const tamperedBody = { ir: makeIR(), meta: { description: 'injected' } };
    const tampered = await request(url, 'PUT', '/v1/orgs/acme/projects/payments/contracts/payments.v1', {
      token: WRITE,
      body: { ...tamperedBody, [SIGNED_ENVELOPE_KEY]: envelope },
      headers,
    });
    assert.equal(tampered.status, 401);
    assert.equal(tampered.json.error.code, 'invalid-signature');

    // Captured (body, envelope) replayed into a different version slot.
    const replay = await request(url, 'PUT', '/v1/orgs/acme/projects/payments/contracts/payments.v2', {
      token: WRITE,
      body: { ...body, [SIGNED_ENVELOPE_KEY]: envelope },
      headers,
    });
    assert.equal(replay.status, 400);
    assert.match(replay.json.error.message, /do not match/);
  });
});

// ----------------------------------------- 5: security headers + 415

test('every response carries X-Content-Type-Options: nosniff and Cache-Control: no-store (issue #120)', async () => {
  await withServer({}, async ({ url }) => {
    const cases: Array<() => Promise<{ status: number; headers: Record<string, string | string[] | undefined> }>> = [
      () => request(url, 'GET', '/healthz'),
      () => request(url, 'GET', '/v1/search?q=x', { token: READ }),
      () => request(url, 'GET', '/v1/search?q=x'), // 401 error envelope
      () => request(url, 'GET', '/v1/orgs/acme/projects/payments/contracts/payments.v9', { token: READ }), // 404
      () =>
        request(url, 'PUT', '/v1/orgs/acme/projects/payments/contracts/payments.v1', {
          token: WRITE,
          body: { ir: makeIR() },
        }), // 201 success
    ];
    for (const run of cases) {
      const response = await run();
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assert.equal(response.headers['cache-control'], 'no-store');
    }
  });
});

test('publish requires application/json content type (415 otherwise, issue #120)', async () => {
  await withServer({}, async ({ url }) => {
    const path = `${url}/v1/orgs/acme/projects/payments/contracts/payments.v1`;
    const rawBody = JSON.stringify({ ir: makeIR() });

    const noType = await fetch(path, {
      method: 'PUT',
      headers: { authorization: `Bearer ${WRITE}` },
      body: rawBody,
    });
    assert.equal(noType.status, 415);
    assert.match(((await noType.json()) as { error: { message: string } }).error.message, /Content-Type/);

    const wrongType = await fetch(path, {
      method: 'PUT',
      headers: { authorization: `Bearer ${WRITE}`, 'content-type': 'text/plain' },
      body: rawBody,
    });
    assert.equal(wrongType.status, 415);

    // The project-scoped POST form enforces the same requirement.
    const barePost = await fetch(`${url}/v1/orgs/acme/projects/payments/contracts`, {
      method: 'POST',
      headers: { authorization: `Bearer ${WRITE}` },
      body: JSON.stringify({ packageName: 'payments.v1', ir: makeIR() }),
    });
    assert.equal(barePost.status, 415);

    const good = await fetch(path, {
      method: 'PUT',
      headers: { authorization: `Bearer ${WRITE}`, 'content-type': 'application/json; charset=utf-8' },
      body: rawBody,
    });
    assert.equal(good.status, 201);
  });
});
