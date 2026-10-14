/**
 * Issued-token lifecycle tests (audit item R1):
 * - crypto primitives: format, parse, salted-hash round trip, constant
 *   data (only `<salt>$<sha256>` at rest — plaintext never stored);
 * - HTTP lifecycle: create (org-scoped admin-gated, optional expiry/scope,
 *   plaintext shown EXACTLY ONCE) → use → revoke → use fails, plus expiry;
 * - issued tokens authenticate through the SAME fail-closed org-bound
 *   middleware as static tokens (401s, 404 cross-tenant, 403 scope).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createServer as serviceCreateServer } from '../server';
import { IssuedTokenAuthenticator } from '../auth';
import { InMemoryDriver } from '../storage/memory';
import {
  ISSUED_TOKEN_PREFIX,
  TOKEN_HASH_PATTERN,
  TOKEN_NAME_MAX_LENGTH,
  generateIssuedToken,
  hashIssuedToken,
  isTokenExpired,
  issuedTokenMeta,
  parseIssuedToken,
  scopeToAccessLevel,
  verifyIssuedTokenHash,
} from '../tokens';
import type { IssuedTokenRecord, RegistryServiceOptions } from '../types';
import { makeIR, request } from './helpers';

const READ = 'read-token';
const WRITE = 'write-token';
const ADMIN = 'admin-token';
const OTHER_ADMIN = 'other-admin-token';

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
        [OTHER_ADMIN]: { tenant: 'other', role: 'admin' },
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
        new Promise<void>((resolve, reject) => {
          server.closeIdleConnections();
          server.close((err) => (err ? reject(err) : resolve()));
        }),
    });
  } finally {
    // Cleanup must survive a failing assertion: a server left listening
    // keeps the event loop alive and the whole test file never exits.
    await new Promise<void>((resolve) => {
      server.closeIdleConnections();
      server.close(() => resolve());
    });
  }
}

// ------------------------------------------------------- crypto primitives

test('issued token format: prefix + uuid id + 32-byte secret', () => {
  const { plaintext, id } = generateIssuedToken();
  assert.ok(plaintext.startsWith(ISSUED_TOKEN_PREFIX));
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.ok(plaintext.startsWith(`${ISSUED_TOKEN_PREFIX}${id}_`));
  const secret = plaintext.slice(`${ISSUED_TOKEN_PREFIX}${id}_`.length);
  assert.ok(secret.length >= 40, 'the base64url secret carries 256 bits of entropy');
  const parsed = parseIssuedToken(plaintext);
  assert.deepEqual(parsed, { id, secret });
  assert.equal(parseIssuedToken('not-a-bridge-token'), null);
  assert.equal(parseIssuedToken(`${ISSUED_TOKEN_PREFIX}nounderscore`), null);
  assert.equal(parseIssuedToken(`${ISSUED_TOKEN_PREFIX}bad_id!_secret`), null);
  assert.equal(parseIssuedToken(''), null);
});

test('hashing: salted sha256 round trip, wrong secret never matches', () => {
  const { plaintext } = generateIssuedToken();
  const hash = hashIssuedToken(plaintext);
  assert.match(hash, TOKEN_HASH_PATTERN, 'stored form is <32-hex-salt>$<64-hex-digest>');
  assert.equal(verifyIssuedTokenHash(plaintext, hash), true);
  const tamperedSecret = `${plaintext.slice(0, -1)}A`;
  assert.equal(verifyIssuedTokenHash(tamperedSecret, hash), false);
  assert.equal(verifyIssuedTokenHash(plaintext, `${hash.slice(0, -1)}a`), false);
  assert.equal(verifyIssuedTokenHash(plaintext, 'garbage'), false);
  assert.equal(verifyIssuedTokenHash(plaintext, ''), false);
  // Two hashes of the same plaintext differ (fresh random salt) but both verify.
  const hash2 = hashIssuedToken(plaintext);
  assert.notEqual(hash, hash2);
  assert.equal(verifyIssuedTokenHash(plaintext, hash2), true);
});

test('metadata projection never carries the hash', () => {
  const { plaintext } = generateIssuedToken();
  const record: IssuedTokenRecord = {
    id: 'id-1',
    org: 'acme',
    name: 'ci',
    tokenHash: hashIssuedToken(plaintext),
    scope: 'registry:publish',
    createdBy: 'token:acme',
    createdAt: new Date().toISOString(),
    expiresAt: null,
    revokedAt: null,
  };
  const meta = issuedTokenMeta(record);
  assert.equal('tokenHash' in meta, false);
  assert.equal(meta.name, 'ci');
  assert.equal(meta.scope, 'registry:publish');
  const noName = issuedTokenMeta({ ...record, name: undefined });
  assert.equal('name' in noName, false);
});

test('scope→level and expiry helpers', () => {
  assert.equal(scopeToAccessLevel('registry:read'), 1);
  assert.equal(scopeToAccessLevel('registry:publish'), 2);
  assert.equal(scopeToAccessLevel('registry:admin'), 3);
  assert.equal(scopeToAccessLevel('nonsense'), 1);
  assert.equal(isTokenExpired(null, Number.MAX_SAFE_INTEGER), false);
  assert.equal(isTokenExpired('2020-01-01T00:00:00.000Z', Date.parse('2021-01-01T00:00:00.000Z')), true);
  assert.equal(isTokenExpired('2020-01-01T00:00:00.000Z', Date.parse('2019-01-01T00:00:00.000Z')), false);
});

// ------------------------------------------------------ authentication core

test('authenticator: expiry and revocation fail closed (injectable clock)', async () => {
  const driver = new InMemoryDriver();
  const plaintext = `${ISSUED_TOKEN_PREFIX}aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee_secret`;
  const record: IssuedTokenRecord = {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    org: 'acme',
    tokenHash: hashIssuedToken(plaintext),
    scope: 'registry:read',
    createdBy: 'token:acme',
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-06-01T00:00:00.000Z',
    revokedAt: null,
  };
  await driver.createIssuedToken(record);
  const auth = new IssuedTokenAuthenticator(driver);

  const fixed = (iso: string) => new IssuedTokenAuthenticator(driver, { now: () => Date.parse(iso) });
  await assert.rejects(
    fixed('2026-06-01T00:00:00.001Z').authenticate(`Bearer ${plaintext}`),
    /expired/,
    'expired tokens are rejected',
  );
  await assert.rejects(
    fixed('2026-07-01T00:00:00.000Z').authenticate(`Bearer ${plaintext}X`),
    /invalid bearer token/,
    'a wrong secret is rejected even inside the validity window',
  );
  await assert.rejects(
    fixed('2026-07-01T00:00:00.000Z').authenticate('Bearer bri_ffffffff-0000-0000-0000-000000000000_x'),
    /invalid bearer token/,
    'unknown ids fail closed',
  );

  // Live token verifies and carries the per-credential identity + org binding.
  const principal = await fixed('2026-03-01T00:00:00.000Z').authenticate(`Bearer ${plaintext}`);
  assert.equal(principal.org, 'acme');
  assert.equal(principal.level, 1);
  assert.equal(principal.tokenId, record.id);
  assert.equal(principal.subject, `token:acme/${record.id}`);

  // Revoked tokens are rejected (any clock).
  await driver.revokeIssuedToken('acme', record.id, '2026-02-01T00:00:00.000Z');
  await assert.rejects(
    fixed('2026-03-01T00:00:00.000Z').authenticate(`Bearer ${plaintext}`),
    /revoked/,
  );
});

// ------------------------------------------------------------ HTTP lifecycle

test('create → use → list (metadata only) → revoke → use fails', async () => {
  await withServer({}, async ({ url, driver }) => {
    const created = await request(url, 'POST', '/v1/orgs/acme/tokens', {
      token: ADMIN,
      body: { scope: 'registry:publish', name: 'ci-deploy' },
    });
    assert.equal(created.status, 201);
    const plaintext: string = created.json.token;
    assert.ok(plaintext.startsWith(ISSUED_TOKEN_PREFIX));
    assert.equal(created.json.meta.org, 'acme');
    assert.equal(created.json.meta.scope, 'registry:publish');
    assert.equal(created.json.meta.name, 'ci-deploy');
    assert.equal(created.json.meta.revokedAt, null);
    assert.equal(created.json.meta.expiresAt, null);
    assert.equal(created.json.meta.createdBy, 'token:acme');
    const tokenId = created.json.meta.id as string;

    // The plaintext WORKS through the regular middleware, at its scope level.
    const publish = await request(url, 'PUT', '/v1/orgs/acme/projects/payments/contracts/payments.v1', {
      token: plaintext,
      body: { ir: makeIR() },
    });
    assert.equal(publish.status, 201, 'a registry:publish token can publish');
    const search = await request(url, 'GET', '/v1/search?q=x', { token: plaintext });
    assert.equal(search.status, 200);
    const adminOp = await request(url, 'GET', '/v1/audit', { token: plaintext });
    assert.equal(adminOp.status, 403, 'a registry:publish token is not admin');

    // Listing is metadata-only: no plaintext, no hash material.
    const listed = await request(url, 'GET', '/v1/orgs/acme/tokens', { token: ADMIN });
    assert.equal(listed.status, 200);
    const rawList = JSON.stringify(listed.json);
    assert.equal(rawList.includes(plaintext), false, 'the plaintext never appears in listings');
    assert.equal(rawList.includes('tokenHash'), false, 'hashes never appear in listings');
    const entry = listed.json.tokens.find((t: { id: string }) => t.id === tokenId);
    assert.ok(entry, 'the created token is listed');
    assert.equal(entry.scope, 'registry:publish');
    assert.equal(entry.revokedAt, null);

    // Hash-only storage: the driver holds `<salt>$<sha256>` and nothing else.
    const records = await driver.listIssuedTokens('acme');
    assert.equal(records.length, 1);
    assert.match(records[0]!.tokenHash, TOKEN_HASH_PATTERN);
    assert.equal(JSON.stringify(records).includes(plaintext), false);
    assert.notEqual(records[0]!.tokenHash, plaintext);

    // Revoke → the SAME plaintext stops working (401), everywhere.
    const revoked = await request(url, 'DELETE', `/v1/orgs/acme/tokens/${tokenId}`, { token: ADMIN });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.json.revoked, true);
    const after = await request(url, 'GET', '/v1/search?q=x', { token: plaintext });
    assert.equal(after.status, 401);
    assert.match(after.json.error.message, /revoked/);
    const listedAgain = await request(url, 'GET', '/v1/orgs/acme/tokens', { token: ADMIN });
    const revokedEntry = listedAgain.json.tokens.find((t: { id: string }) => t.id === tokenId);
    assert.ok(revokedEntry.revokedAt, 'the list shows the revocation timestamp');

    // Revocation is idempotent; unknown ids are 404.
    const again = await request(url, 'DELETE', `/v1/orgs/acme/tokens/${tokenId}`, { token: ADMIN });
    assert.equal(again.status, 200);
    const unknown = await request(url, 'DELETE', '/v1/orgs/acme/tokens/00000000-0000-0000-0000-000000000000', {
      token: ADMIN,
    });
    assert.equal(unknown.status, 404);
  });
});

test('expiry: an expired token fails closed (end to end)', async () => {
  await withServer({}, async ({ url }) => {
    const created = await request(url, 'POST', '/v1/orgs/acme/tokens', {
      token: ADMIN,
      body: { expiresAt: new Date(Date.now() + 60).toISOString() },
    });
    assert.equal(created.status, 201);
    const plaintext: string = created.json.token;
    const ok = await request(url, 'GET', '/v1/search?q=x', { token: plaintext });
    assert.equal(ok.status, 200, 'the token works inside its validity window');
    await new Promise((resolve) => setTimeout(resolve, 150));
    const expired = await request(url, 'GET', '/v1/search?q=x', { token: plaintext });
    assert.equal(expired.status, 401);
    assert.match(expired.json.error.message, /expired/);
  });
});

test('create validates scope, expiry and name', async () => {
  await withServer({}, async ({ url }) => {
    const badScope = await request(url, 'POST', '/v1/orgs/acme/tokens', {
      token: ADMIN,
      body: { scope: 'registry:superuser' },
    });
    assert.equal(badScope.status, 400);
    const past = await request(url, 'POST', '/v1/orgs/acme/tokens', {
      token: ADMIN,
      body: { expiresAt: '2020-01-01T00:00:00.000Z' },
    });
    assert.equal(past.status, 400);
    assert.match(past.json.error.message, /future/);
    const malformed = await request(url, 'POST', '/v1/orgs/acme/tokens', {
      token: ADMIN,
      body: { expiresAt: 'not-a-date' },
    });
    assert.equal(malformed.status, 400);
    const both = await request(url, 'POST', '/v1/orgs/acme/tokens', {
      token: ADMIN,
      body: { expiresAt: '2030-01-01T00:00:00.000Z', expiresInDays: 7 },
    });
    assert.equal(both.status, 400);
    const badDays = await request(url, 'POST', '/v1/orgs/acme/tokens', {
      token: ADMIN,
      body: { expiresInDays: 0 },
    });
    assert.equal(badDays.status, 400);
    const badName = await request(url, 'POST', '/v1/orgs/acme/tokens', {
      token: ADMIN,
      body: { name: 'x'.repeat(TOKEN_NAME_MAX_LENGTH + 1) },
    });
    assert.equal(badName.status, 400);

    // Valid relative expiry works and lands in the metadata.
    const ok = await request(url, 'POST', '/v1/orgs/acme/tokens', {
      token: ADMIN,
      body: { expiresInDays: 7 },
    });
    assert.equal(ok.status, 201);
    assert.ok(typeof ok.json.meta.expiresAt === 'string');
  });
});

test('token endpoints are admin-only and org-bound (fail closed)', async () => {
  await withServer({}, async ({ url }) => {
    // Unauthenticated.
    const anon = await request(url, 'GET', '/v1/orgs/acme/tokens');
    assert.equal(anon.status, 401);
    // Below admin scope.
    for (const token of [READ, WRITE]) {
      const forbidden = await request(url, 'POST', '/v1/orgs/acme/tokens', { token, body: {} });
      assert.equal(forbidden.status, 403);
      const listForbidden = await request(url, 'GET', '/v1/orgs/acme/tokens', { token });
      assert.equal(listForbidden.status, 403);
    }
    // Cross-tenant: another org's admin sees 404, never 403 (no leak).
    const cross = await request(url, 'POST', '/v1/orgs/acme/tokens', { token: OTHER_ADMIN, body: {} });
    assert.equal(cross.status, 404);
    const crossList = await request(url, 'GET', '/v1/orgs/acme/tokens', { token: OTHER_ADMIN });
    assert.equal(crossList.status, 404);
    // A wrong-method request is 405 before anything else.
    const wrongMethod = await request(url, 'PUT', '/v1/orgs/acme/tokens', { token: ADMIN, body: {} });
    assert.equal(wrongMethod.status, 405);
    // POST requires JSON content type. Consume the body before asserting:
    // an unread response keeps the undici connection busy and would hang
    // server.close() on a non-idle keep-alive socket (issue #48).
    const raw = await fetch(`${url}/v1/orgs/acme/tokens`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN}` },
      body: '{}',
    });
    await raw.text();
    assert.equal(raw.status, 415);
    // Unknown subpath 404s.
    const unknown = await request(url, 'GET', '/v1/orgs/acme/tokens/extra/deep', { token: ADMIN });
    assert.equal(unknown.status, 404);
  });
});

test('an issued token with registry:admin can manage tokens (rotation without the bootstrap secret)', async () => {
  await withServer({}, async ({ url }) => {
    const first = await request(url, 'POST', '/v1/orgs/acme/tokens', {
      token: ADMIN,
      body: { scope: 'registry:admin', name: 'ops' },
    });
    assert.equal(first.status, 201);
    const ops: string = first.json.token;

    const rotated = await request(url, 'POST', '/v1/orgs/acme/tokens', {
      token: ops,
      body: { scope: 'registry:read', name: 'ci' },
    });
    assert.equal(rotated.status, 201, 'admin-scoped issued tokens can mint further tokens');
    assert.equal(rotated.json.meta.createdBy, `token:acme/${first.json.meta.id}`);
  });
});

test('issued-token requests are audited with per-credential identity', async () => {
  await withServer({}, async ({ url }) => {
    const created = await request(url, 'POST', '/v1/orgs/acme/tokens', { token: ADMIN, body: { name: 'ci' } });
    const plaintext: string = created.json.token;
    const tokenId: string = created.json.meta.id;
    await request(url, 'GET', '/v1/search?q=x', { token: plaintext });

    const entries = await request(url, 'GET', '/v1/audit?action=tokens', { token: ADMIN });
    assert.equal(entries.status, 200);
    const createEntry = entries.json.entries.find(
      (e: { contract: string | null; status: number }) => e.contract === null && e.status === 201,
    );
    assert.ok(createEntry, 'the create is audited under action=tokens');
    assert.equal(createEntry.actor, 'token:acme');

    const useEntries = await request(url, 'GET', '/v1/audit?action=read', { token: ADMIN });
    const issuedUse = useEntries.json.entries.find((e: { actor: string }) => e.actor === `token:acme/${tokenId}`);
    assert.ok(issuedUse, 'requests made WITH the issued token carry its per-credential identity');
  });
});

test('registry-service defaults wire issued-token auth without extra options', async () => {
  // createServer derives the TokenStore from options.driver automatically —
  // a service configured exactly like before R1 now authenticates issued
  // tokens too (same middleware, no opt-in flag to forget).
  const options: RegistryServiceOptions = {
    driver: new InMemoryDriver(),
    auth: { tokens: { [ADMIN]: { tenant: 'acme', role: 'admin' } } },
    rateLimit: { enabled: false },
  };
  const server = serviceCreateServer(options);
  server.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;
  try {
    const created = await request(url, 'POST', '/v1/orgs/acme/tokens', { token: ADMIN, body: {} });
    assert.equal(created.status, 201);
    const used = await request(url, 'GET', '/v1/orgs/acme/projects/x/contracts', { token: created.json.token });
    assert.equal(used.status, 200, 'issued tokens authenticate out of the box');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
