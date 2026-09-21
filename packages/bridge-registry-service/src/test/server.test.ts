/**
 * Integration tests: the HTTP surface end to end (auth, tenancy, publish,
 * pull, versions, diff, graph, consumers, search, audit, rate limits,
 * error envelopes, OpenAPI document).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import http, { Agent } from 'node:http';
import { canonicalJson } from '@bridge/core';
import type { AddressInfo } from 'node:net';
import { InMemoryDriver } from '../storage/memory';
import { createServer as serviceCreateServer } from '../server';
import { generateSigningKey, makeFullIR, makeIR, mintJwt, request, startTestServer } from './helpers';

const READ = 'read-token';
const WRITE = 'write-token';
const ADMIN = 'admin-token';

interface TestCtx {
  url: string;
  close: () => Promise<void>;
  driver: InMemoryDriver;
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
        'other-write': { tenant: 'other', role: 'write' },
      },
    },
    rateLimit: { enabled: false },
    ...extra,
  } as never);
  server.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;
  try {
    await fn({
      url,
      driver,
      close: () =>
        new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('healthz + openapi are reachable', async () => {
  await withServer({}, async ({ url }) => {
    const health = await request(url, 'GET', '/healthz');
    assert.equal(health.status, 200);
    assert.equal(health.json.ok, true);

    const doc = await request(url, 'GET', '/v1/openapi.json');
    assert.equal(doc.status, 200);
    assert.equal(doc.json.openapi, '3.1.0');
    assert.ok(doc.json.paths['/v1/orgs/{org}/projects/{project}/contracts/{contract}']);
  });
});

test('auth is required on every /v1 route', async () => {
  await withServer({}, async ({ url }) => {
    const noToken = await request(url, 'GET', '/v1/orgs/acme/projects/payments/contracts');
    assert.equal(noToken.status, 401);
    assert.equal(noToken.json.error.code, 'unauthenticated');
    const badToken = await request(url, 'GET', '/v1/search?q=x', { token: 'wrong' });
    assert.equal(badToken.status, 401);
  });
});

test('cross-tenant access responds 404 (no existence leak)', async () => {
  await withServer({}, async ({ url }) => {
    const response = await request(url, 'GET', '/v1/orgs/other/projects/payments/contracts', { token: WRITE });
    assert.equal(response.status, 404);
    const publish = await request(url, 'PUT', '/v1/orgs/other/projects/payments/contracts/payments.v1', {
      token: 'other-write',
      body: { ir: makeIR() },
    });
    // Publishing into ANOTHER org from the caller's own token fails with
    // 404 as well (the token is bound to org 'other' — route org 'other'
    // matches, so this is actually allowed; assert 201/400 depending on
    // validation). The strict tenancy check is the one above.
    assert.ok([201, 200, 400].includes(publish.status));
  });
});

test('publish → created, replayed, immutable-conflict, then read back', async () => {
  await withServer({}, async ({ url, driver }) => {
    const path = '/v1/orgs/acme/projects/payments/contracts/payments.v1';
    const created = await request(url, 'PUT', path, { token: WRITE, body: { ir: makeIR() } });
    assert.equal(created.status, 201);
    assert.equal(created.json.outcome, 'created');
    assert.equal(created.json.meta.version, 'v1');
    assert.equal(created.json.meta.publishedBy, 'token:acme');

    const replayed = await request(url, 'PUT', path, { token: WRITE, body: { ir: makeIR() } });
    assert.equal(replayed.status, 200);
    assert.equal(replayed.json.outcome, 'replayed');

    const changed = makeIR() as Record<string, unknown>;
    (changed['types'] as unknown[])[0] = {
      name: 'Money',
      kind: 'struct',
      fields: [
        { name: 'amount', type: { kind: 'primitive', primitive: 'int32' }, optional: false, constraints: [] },
      ],
    };
    const conflict = await request(url, 'PUT', path, { token: WRITE, body: { ir: changed } });
    assert.equal(conflict.status, 409);

    const pulled = await request(url, 'GET', path, { token: READ });
    assert.equal(pulled.status, 200);
    assert.equal(pulled.json.ir.name, 'payments.v1');
    assert.equal(pulled.json.meta.hash.length, 64);
    assert.ok(driver);
  });
});

test('publish enforces the publish scope (read token → 403)', async () => {
  await withServer({}, async ({ url }) => {
    const response = await request(url, 'PUT', '/v1/orgs/acme/projects/payments/contracts/payments.v1', {
      token: READ,
      body: { ir: makeIR() },
    });
    assert.equal(response.status, 403);
    assert.equal(response.json.error.code, 'forbidden');
  });
});

test('invalid contract content is rejected with details', async () => {
  await withServer({}, async ({ url }) => {
    const response = await request(url, 'PUT', '/v1/orgs/acme/projects/payments/contracts/payments.v1', {
      token: WRITE,
      body: { ir: { hello: 'world' } },
    });
    assert.equal(response.status, 400);
    assert.equal(response.json.error.code, 'invalid_contract');
    assert.ok(Array.isArray(response.json.error.details.errors));
  });
});

test('contentHash tripwire rejects a declared-but-tampered payload', async () => {
  await withServer({}, async ({ url }) => {
    const response = await request(url, 'PUT', '/v1/orgs/acme/projects/payments/contracts/payments.v1', {
      token: WRITE,
      body: { ir: makeIR(), contentHash: 'a'.repeat(64) },
    });
    assert.equal(response.status, 400);
    assert.equal(response.json.error.code, 'hash-mismatch');
  });
});

test('signed publishes verify; unknown key ids do not', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  await withServer(
    { signing: { keys: { k1: pem } } },
    async ({ url }) => {
      const path = '/v1/orgs/acme/projects/payments/contracts/payments.v1';
      // Unsigned → signature-required.
      const unsigned = await request(url, 'PUT', path, { token: WRITE, body: { ir: makeIR() } });
      assert.equal(unsigned.status, 401);
      assert.equal(unsigned.json.error.code, 'signature-required');

      // Signed → 201.
      const body = { ir: makeIR() };
      const signature = cryptoSign(null, Buffer.from(canonicalJson(body), 'utf8'), privateKey);
      const signed = await request(url, 'PUT', path, {
        token: WRITE,
        body,
        headers: { 'x-bridge-key-id': 'k1', 'x-bridge-signature': signature.toString('base64') },
      });
      assert.equal(signed.status, 201);

      // Unknown kid → invalid-signature.
      const unknownKid = await request(url, 'PUT', '/v1/orgs/acme/projects/payments/contracts/other.v1', {
        token: WRITE,
        body: { ir: makeFullIR('other.v1') },
        headers: { 'x-bridge-key-id': 'nope', 'x-bridge-signature': signature.toString('base64') },
      });
      assert.equal(unknownKid.status, 401);
      assert.equal(unknownKid.json.error.code, 'invalid-signature');
    },
  );
});

test('versions, latest pull, versioned pull and consumers', async () => {
  await withServer({}, async ({ url }) => {
    await request(url, 'PUT', '/v1/orgs/acme/projects/payments/contracts/payments.v1', {
      token: WRITE,
      body: { ir: makeIR() },
    });
    const versions = await request(url, 'GET', '/v1/orgs/acme/projects/payments/contracts/payments/versions', {
      token: READ,
    });
    assert.deepEqual(versions.json.versions, ['v1']);

    const one = await request(url, 'GET', '/v1/orgs/acme/projects/payments/contracts/payments/versions/v1', {
      token: READ,
    });
    assert.equal(one.status, 200);
    assert.equal(one.json.meta.version, 'v1');

    const consumers = await request(
      url,
      'GET',
      '/v1/orgs/acme/projects/payments/contracts/payments/versions/v1/consumers',
      { token: READ },
    );
    assert.equal(consumers.status, 200);
    assert.deepEqual(consumers.json.consumers, []);

    const missing = await request(url, 'GET', '/v1/orgs/acme/projects/payments/contracts/payments/versions/v9', {
      token: READ,
    });
    assert.equal(missing.status, 404);
  });
});

test('diff classifies changes between two versions', async () => {
  await withServer({}, async ({ url }) => {
    await request(url, 'PUT', '/v1/orgs/acme/projects/orders/contracts/orders.v1', {
      token: WRITE,
      body: { ir: makeFullIR('orders.v1') },
    });
    // v2 removes the service → breaking.
    const v2 = makeFullIR('orders.v2') as Record<string, unknown>;
    v2['services'] = [];
    await request(url, 'PUT', '/v1/orgs/acme/projects/orders/contracts/orders.v2', {
      token: WRITE,
      body: { ir: v2 },
    });
    const diff = await request(url, 'GET', '/v1/orgs/acme/projects/orders/contracts/orders/diff?from=v1&to=v2', {
      token: READ,
    });
    assert.equal(diff.status, 200);
    assert.equal(diff.json.verdict, 'BREAKING');
    assert.ok(diff.json.summary.breaking >= 1);
  });
});

test('graph returns the dependency closure', async () => {
  await withServer({}, async ({ url }) => {
    await request(url, 'PUT', '/v1/orgs/acme/projects/payments/contracts/payments.v1', {
      token: WRITE,
      body: { ir: makeIR() },
    });
    const orders = makeFullIR('orders.v2') as Record<string, unknown>;
    orders['imports'] = ['payments.v1'];
    await request(url, 'PUT', '/v1/orgs/acme/projects/orders/contracts/orders.v2', {
      token: WRITE,
      body: { ir: orders },
    });
    const graph = await request(url, 'GET', '/v1/orgs/acme/projects/orders/contracts/orders/graph', {
      token: READ,
    });
    assert.equal(graph.status, 200);
    assert.equal(graph.json.version, 'v2');
    assert.ok(graph.json.edges.some((e: { to: string }) => e.to === 'payments.v1'));
  });
});

test('search is org-scoped and returns matches', async () => {
  await withServer({}, async ({ url }) => {
    await request(url, 'PUT', '/v1/orgs/acme/projects/payments/contracts/payments.v1', {
      token: WRITE,
      body: { ir: makeIR() },
    });
    const hits = await request(url, 'GET', '/v1/search?q=pay', { token: READ });
    assert.equal(hits.status, 200);
    assert.equal(hits.json.results.length, 1);
  });
});

test('audit endpoint requires admin and records publishes', async () => {
  await withServer({}, async ({ url }) => {
    await request(url, 'PUT', '/v1/orgs/acme/projects/payments/contracts/payments.v1', {
      token: WRITE,
      body: { ir: makeIR() },
    });
    const forbidden = await request(url, 'GET', '/v1/audit', { token: READ });
    assert.equal(forbidden.status, 403);
    const entries = await request(url, 'GET', '/v1/audit?actor=token%3Aacme', { token: ADMIN });
    assert.equal(entries.status, 200);
    const publishEntry = entries.json.entries.find(
      (e: { action: string; status: number }) => e.action === 'publish' && e.status === 201,
    );
    assert.ok(publishEntry, 'publish should be audited');
    assert.equal(publishEntry.org, 'acme');
  });
});

test('audit reads are force-scoped to the principal org (issue #47)', async () => {
  await withServer({}, async ({ url }) => {
    // Two tenants publish; both events land in the shared audit backend.
    const acmePublish = await request(url, 'PUT', '/v1/orgs/acme/projects/payments/contracts/payments.v1', {
      token: WRITE,
      body: { ir: makeIR() },
    });
    assert.equal(acmePublish.status, 201);
    const otherPublish = await request(url, 'PUT', '/v1/orgs/other/projects/payments/contracts/payments.v1', {
      token: 'other-write',
      body: { ir: makeIR() },
    });
    assert.equal(otherPublish.status, 201);

    // Explicit foreign org filter → 404 (no existence leak), never rows.
    const foreign = await request(url, 'GET', '/v1/audit?org=other', { token: ADMIN });
    assert.equal(foreign.status, 404);
    assert.equal(foreign.json.error.code, 'not-found');

    // No org filter → ONLY the caller's own org is returned (before the fix
    // the driver returned every tenant's entries here).
    const own = await request(url, 'GET', '/v1/audit?limit=10000', { token: ADMIN });
    assert.equal(own.status, 200);
    assert.ok(own.json.entries.length > 0);
    for (const entry of own.json.entries) {
      assert.equal(entry.org, 'acme', `audit row leaked a foreign org: ${JSON.stringify(entry.org)}`);
    }

    // An explicit own-org filter still works.
    const explicitOwn = await request(url, 'GET', '/v1/audit?org=acme&limit=10000', { token: ADMIN });
    assert.equal(explicitOwn.status, 200);
    assert.ok(explicitOwn.json.entries.some((e: { action: string; status: number }) => e.action === 'publish'));
  });
});

test('OIDC tokens authenticate over HTTP', async () => {
  const { mint, key } = generateSigningKey('RS256');
  await withServer(
    {
      auth: {
        oidc: {
          issuer: 'https://issuer.example.com',
          audience: 'bridge-registry',
          jwks: { keys: [mint.jwk] },
        },
      },
    },
    async ({ url }) => {
      const claims = {
        iss: 'https://issuer.example.com',
        sub: 'user-123',
        aud: 'bridge-registry',
        exp: Math.floor(Date.now() / 1000) + 600,
        scope: 'registry:admin',
        org: 'acme',
      };
      const token = mintJwt(key, 'RS256', mint.kid, claims);
      const response = await request(url, 'GET', '/v1/orgs/acme/projects/payments/contracts', { token });
      assert.equal(response.status, 200);
      assert.deepEqual(response.json.contracts, []);
    },
  );
});

test('rate limiting returns 429 with Retry-After', async () => {
  await withServer(
    {
      rateLimit: {
        enabled: true,
        auth: { capacity: 2, refillPerSecond: 0.001 },
      },
    },
    async ({ url }) => {
      const first = await request(url, 'GET', '/v1/search?q=x', { token: READ });
      assert.equal(first.status, 200);
      const second = await request(url, 'GET', '/v1/search?q=x', { token: READ });
      assert.equal(second.status, 200);
      const third = await request(url, 'GET', '/v1/search?q=x', { token: READ });
      assert.equal(third.status, 429);
      assert.equal(third.json.error.code, 'rate-limited');
      assert.ok(Number(third.headers['retry-after']) >= 1);
    },
  );
});

test('malformed JSON and oversized bodies are rejected', async () => {
  await withServer({}, async ({ url }) => {
    const response = await fetch(`${url}/v1/orgs/acme/projects/payments/contracts/payments.v1`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${WRITE}`, 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(response.status, 400);
    const json = (await response.json()) as { error: { code: string } };
    assert.equal(json.error.code, 'invalid_argument');
  });
});

test('startTestServer helper binds and closes cleanly', async () => {
  const driver = new InMemoryDriver();
  await driver.init();
  const handle = startTestServer({
    driver,
    auth: { tokens: { t: { tenant: 'acme', role: 'read' } } },
  } as never);
  const health = await request(handle.url, 'GET', '/healthz');
  assert.equal(health.status, 200);
  await handle.close();
});

// --------------------------------------------- issue #48: hardened defaults

test('server pins explicit timeouts (issue #48)', () => {
  const driver = new InMemoryDriver();
  const server = serviceCreateServer({
    driver,
    auth: { tokens: { t: { tenant: 'acme', role: 'read' } } },
    rateLimit: { enabled: false },
  } as never);
  assert.equal(server.requestTimeout, 120_000);
  assert.equal(server.headersTimeout, 15_000);
  assert.equal(server.keepAliveTimeout, 5_000);
  return new Promise<void>((resolve) => server.close(() => resolve()));
});

test('rate limiting is ON by default and openapi.json sits below the limiter (issue #48)', async () => {
  // `rateLimit: undefined` overrides withServer's explicit-off default so the
  // options object reaching createServer has NO rateLimit key at all — the
  // shipped CLI situation before the fix.
  await withServer({ rateLimit: undefined }, async ({ url }) => {
    const responses = await Promise.all(
      Array.from({ length: 200 }, () => fetch(`${url}/v1/openapi.json`)),
    );
    const statuses = responses.map((r) => r.status);
    assert.ok(statuses.includes(429), 'a burst must hit the default-enabled limiter');
    assert.ok(statuses.includes(200), 'part of the burst must still be served');
    // /healthz is deliberately outside the limiter.
    const health = await request(url, 'GET', '/healthz');
    assert.equal(health.status, 200);
  });
});

test('413: the envelope is delivered before the connection is destroyed (issue #48)', async () => {
  await withServer({}, async ({ url }) => {
    const oversized = Buffer.alloc(8 * 1024 * 1024 + 1, 0x61);
    const response = await fetch(`${url}/v1/orgs/acme/projects/payments/contracts/payments.v1`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${WRITE}`, 'content-type': 'application/json' },
      body: oversized,
    });
    assert.equal(response.status, 413);
    // The regression: the socket used to be destroyed mid-upload, so clients
    // got ECONNRESET instead of this envelope.
    const json = (await response.json()) as { error: { code: string } };
    assert.equal(json.error.code, 'payload-too-large');
  });
});

test('graceful shutdown: closeIdleConnections unblocks close() on idle keep-alive sockets (issue #48)', async () => {
  const driver = new InMemoryDriver();
  await driver.init();
  const server = serviceCreateServer({
    driver,
    auth: { tokens: { [READ]: { tenant: 'acme', role: 'read' } } },
    rateLimit: { enabled: false },
  } as never);
  server.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  try {
    // Park one idle keep-alive socket in the agent pool.
    await new Promise<void>((resolve, reject) => {
      const req = http.get(`${url}/healthz`, { agent }, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 50)); // socket back to the pool
    const started = Date.now();
    const elapsed = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server.close() hung on an idle keep-alive socket')), 2_500);
      server.closeIdleConnections();
      server.close(() => {
        clearTimeout(timer);
        resolve(Date.now() - started);
      });
    });
    assert.ok(elapsed < 2_000, `close() took ${elapsed}ms — it waited on the idle socket`);
  } catch (err) {
    server.closeAllConnections();
    throw err;
  } finally {
    agent.destroy();
  }
});

test('audit hygiene: pre-auth noise is skipped, failed bearer tokens record action auth (issue #48)', async () => {
  await withServer({}, async ({ url }) => {
    // Missing header → pre-auth noise, NOT stored.
    const noToken = await request(url, 'GET', '/v1/search?q=x');
    assert.equal(noToken.status, 401);
    // Wrong scheme → pre-auth noise, NOT stored.
    const wrongScheme = await fetch(`${url}/v1/search?q=x`, {
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });
    assert.equal(wrongScheme.status, 401);
    // A well-formed but wrong bearer token IS a security event → stored.
    const badToken = await request(url, 'GET', '/v1/search?q=x', { token: 'wrong' });
    assert.equal(badToken.status, 401);

    const entries = await request(url, 'GET', '/v1/audit?action=auth', { token: ADMIN });
    assert.equal(entries.status, 200);
    assert.equal(entries.json.entries.length, 1, 'exactly the failed bearer attempt is stored');
    assert.equal(entries.json.entries[0].action, 'auth');
    assert.equal(entries.json.entries[0].status, 401);
    assert.equal(entries.json.entries[0].ok, false);
  });
});

test('audit hygiene: rate-limited requests are not persisted (issue #48)', async () => {
  await withServer(
    { rateLimit: { enabled: true, auth: { capacity: 2, refillPerSecond: 1 } } },
    async ({ url }) => {
      assert.equal((await request(url, 'GET', '/v1/search?q=x', { token: READ })).status, 200);
      assert.equal((await request(url, 'GET', '/v1/search?q=x', { token: READ })).status, 200);
      assert.equal((await request(url, 'GET', '/v1/search?q=x', { token: READ })).status, 429);
      // Let one token refill, then inspect the ring as admin.
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const entries = await request(url, 'GET', '/v1/audit', { token: ADMIN });
      assert.equal(entries.status, 200);
      const statuses = entries.json.entries.map((e: { status: number }) => e.status);
      assert.ok(!statuses.includes(429), '429s must not pollute the audit ring');
      assert.ok(statuses.includes(200), 'legitimate traffic stays recorded');
    },
  );
});

test('publishTime must be a valid ISO-8601 timestamp (issue #48)', async () => {
  await withServer({}, async ({ url }) => {
    const bad = await request(url, 'PUT', '/v1/orgs/acme/projects/payments/contracts/payments.v1', {
      token: WRITE,
      body: { ir: makeIR(), publishTime: 'last tuesday' },
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'invalid_argument');
    assert.match(bad.json.error.message, /publishTime/);

    const good = await request(url, 'PUT', '/v1/orgs/acme/projects/payments/contracts/payments.v1', {
      token: WRITE,
      body: { ir: makeIR(), publishTime: new Date().toISOString() },
    });
    assert.equal(good.status, 201);
  });
});

test('audit from/to bounds must be valid ISO-8601 (issue #48)', async () => {
  await withServer({}, async ({ url }) => {
    const bad = await request(url, 'GET', '/v1/audit?from=not-a-date', { token: ADMIN });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'invalid_argument');
    const ok = await request(
      url,
      'GET',
      `/v1/audit?from=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}`,
      { token: ADMIN },
    );
    assert.equal(ok.status, 200);
  });
});

// ---------------------------------------------------------------------------
// Publish meta languages (issue #104): recorded, normalized, validated.
// ---------------------------------------------------------------------------

test('publish records normalized meta.languages and echoes them on reads', async () => {
  await withServer({}, async ({ url }) => {
    const path = '/v1/orgs/acme/projects/payments/contracts/payments.v1';
    const created = await request(url, 'PUT', path, {
      token: WRITE,
      body: { ir: makeIR(), meta: { languages: ['Go', ' TypeScript ', 'go', 'python'] } },
    });
    assert.equal(created.status, 201);
    assert.deepEqual(created.json.meta.languages, ['go', 'typescript', 'python']);

    const pulled = await request(url, 'GET', path, { token: READ });
    assert.equal(pulled.status, 200);
    assert.deepEqual(pulled.json.meta.languages, ['go', 'typescript', 'python']);

    // Replay (same IR) keeps the recorded languages from the first publish.
    const replayed = await request(url, 'PUT', path, {
      token: WRITE,
      body: { ir: makeIR(), meta: { languages: ['rust'] } },
    });
    assert.equal(replayed.status, 200);
    assert.equal(replayed.json.outcome, 'replayed');
    assert.deepEqual(replayed.json.meta.languages, ['go', 'typescript', 'python']);
  });
});

test('publish without meta.languages omits the field entirely', async () => {
  await withServer({}, async ({ url }) => {
    const path = '/v1/orgs/acme/projects/payments/contracts/bare.v1';
    const created = await request(url, 'PUT', path, { token: WRITE, body: { ir: makeIR('bare.v1') } });
    assert.equal(created.status, 201);
    assert.equal(created.json.meta.languages, undefined);
    assert.ok(!('languages' in created.json.meta));
  });
});

test('publish rejects malformed meta.languages shapes with 400', async () => {
  await withServer({}, async ({ url }) => {
    const path = '/v1/orgs/acme/projects/payments/contracts/bad.v1';
    const cases: unknown[] = [
      'go,typescript',              // string, not array
      [42],                          // non-string entry
      ['Go TS'],                     // space not allowed by the identifier pattern
      ['-leading-dash'],             // must start with a letter
      Array.from({ length: 17 }, (_, i) => `lang${i}`), // over the cap
    ];
    for (const languages of cases) {
      const r = await request(url, 'PUT', path, { token: WRITE, body: { ir: makeIR('bad.v1'), meta: { languages } } });
      assert.equal(r.status, 400, `expected 400 for languages=${JSON.stringify(languages)}, got ${r.status}`);
      assert.equal(r.json.error.code, 'invalid_argument');
    }
  });
});
