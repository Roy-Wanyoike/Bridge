/**
 * Unit tests: authentication (static tokens + OIDC JWT verification) and
 * artifact signing (ed25519 over canonical publish bodies).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { canonicalJson } from '@bridge/core';
import {
  Levels,
  assertTokenEntropy,
  assertTokenTable,
  authenticateStaticToken,
  createAuthenticator,
  extractBearerToken,
  OidcAuthenticator,
  parseJwks,
  requireLevel,
  scopesToLevel,
  verifyJwt,
} from '../auth';
import { ServiceError } from '../errors';
import { generateSigningKey, mintJwt } from './helpers';
import { verifyPublishSignature } from '../signing';
import type { OidcConfig } from '../types';

test('static tokens: table validation', () => {
  assert.throws(() => assertTokenTable({ '': { tenant: 'acme', role: 'read' } }));
  assert.doesNotThrow(() => assertTokenTable({ t: { tenant: 'any non-empty tenant', role: 'read' } }));
  assert.throws(() => assertTokenTable({ t: { tenant: 'acme', role: 'owner' as never } }));
  assert.doesNotThrow(() => assertTokenTable({ secret: { tenant: 'acme', role: 'write' } }));
});

test('static tokens: bearer extraction and lookup', () => {
  assert.equal(extractBearerToken('Bearer abc'), 'abc');
  assert.throws(() => extractBearerToken('Basic abc'), /Bearer/i);
  assert.throws(() => extractBearerToken(undefined), /Bearer/i);

  const principal = authenticateStaticToken({ s: { tenant: 'acme', role: 'write' } }, 'Bearer s');
  assert.equal(principal.org, 'acme');
  assert.equal(principal.level, 2);
  assert.throws(() => authenticateStaticToken({ s: { tenant: 'acme', role: 'write' } }, 'Bearer wrong'));
});

test('static tokens: prototype-chain names never authenticate (issue #48)', () => {
  // The old `tokens[token]` lookup walked the prototype chain, so bearers
  // spelled like inherited Object properties resolved (fail-closed, but to a
  // nonsense principal). Own-property lookup only now.
  const tokens = { 'real-secret': { tenant: 'acme', role: 'write' as const } };
  for (const trick of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
    assert.throws(
      () => authenticateStaticToken(tokens, `Bearer ${trick}`),
      /missing or invalid bearer token/,
      `bearer '${trick}' must not authenticate`,
    );
  }
  // The real token still works and the table stays untouched.
  assert.equal(authenticateStaticToken(tokens, 'Bearer real-secret').org, 'acme');
});

test('static tokens: entropy floor — production hard-fails, default warns (issue #120)', () => {
  const short = { 'short-secret': { tenant: 'acme', role: 'read' as const } };

  // Production profile: hard startup error. It names the owner and the
  // documented minimum but NEVER the raw token material.
  assert.throws(
    () => assertTokenEntropy(short, { production: true }),
    (err: unknown) => {
      assert.ok(err instanceof TypeError);
      assert.match(err.message, /acme/);
      assert.match(err.message, /32/);
      assert.equal(err.message.includes('short-secret'), false, 'raw token must never appear in the error');
      return true;
    },
  );

  // Default profile: loud stderr warning, startup proceeds.
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.join(' '));
  };
  try {
    assert.doesNotThrow(() => assertTokenEntropy(short));
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /acme/);
  assert.match(warnings[0]!, /WARNING/);
  assert.equal(warnings[0]!.includes('short-secret'), false, 'raw token must never appear in the warning');

  // Tokens at/above the floor are unaffected in BOTH profiles.
  const longSecret = 'a'.repeat(32);
  const long = { [longSecret]: { tenant: 'acme', role: 'write' as const } };
  let warned = 0;
  console.warn = (): void => {
    warned += 1;
  };
  try {
    assert.doesNotThrow(() => assertTokenEntropy(long));
    assert.doesNotThrow(() => assertTokenEntropy(long, { production: true }));
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warned, 0, 'a 32-character token must not trip the floor');
});

test('levels: requireLevel enforces the scope hierarchy', () => {
  const reader = {
    kind: 'token' as const,
    subject: 'token:acme',
    org: 'acme',
    level: 1 as const,
    scopes: ['registry:read'],
  };
  requireLevel(reader, Levels.read); // ok
  assert.throws(() => requireLevel(reader, Levels.publish), /not permitted/);
  const admin = {
    kind: 'token' as const,
    subject: 'token:acme',
    org: 'acme',
    level: 3 as const,
    scopes: ['registry:admin'],
  };
  requireLevel(admin, Levels.publish); // admin implies publish
});

test('scopes: admin > publish > read mapping', () => {
  assert.equal(scopesToLevel(['registry:read']), 1);
  assert.equal(scopesToLevel(['registry:publish']), 2);
  assert.equal(scopesToLevel(['registry:admin']), 3);
  assert.equal(scopesToLevel([]), 1);
});

// ------------------------------------------------------------------- OIDC

function baseClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: 'https://issuer.example.com',
    sub: 'user-123',
    aud: 'bridge-registry',
    exp: Math.floor(Date.now() / 1000) + 600,
    iat: Math.floor(Date.now() / 1000),
    scope: 'registry:read registry:publish',
    org: 'acme',
    ...overrides,
  };
}

function oidcConfig(jwks: { keys: unknown[] }, overrides: Partial<OidcConfig> = {}): OidcConfig {
  return {
    issuer: 'https://issuer.example.com',
    audience: 'bridge-registry',
    jwks: { keys: jwks.keys },
    ...overrides,
  };
}

test('OIDC: a valid RS256 token authenticates', () => {
  const { mint, key } = generateSigningKey('RS256');
  const cfg = oidcConfig({ keys: [mint.jwk] });
  const keys = parseJwks(cfg.jwks!);
  const token = mintJwt(key, 'RS256', mint.kid, baseClaims());
  const claims = verifyJwt(token, cfg, keys);
  assert.equal(claims['sub'], 'user-123');
});

test('OIDC: a valid ES256 token authenticates', () => {
  const { mint, key } = generateSigningKey('ES256');
  const cfg = oidcConfig({ keys: [mint.jwk] });
  const keys = parseJwks(cfg.jwks!);
  const token = mintJwt(key, 'ES256', mint.kid, baseClaims());
  const claims = verifyJwt(token, cfg, keys);
  assert.equal(claims['sub'], 'user-123');
});

test('OIDC: tampered payload is rejected', () => {
  const { mint, key } = generateSigningKey('RS256');
  const cfg = oidcConfig({ keys: [mint.jwk] });
  const keys = parseJwks(cfg.jwks!);
  const token = mintJwt(key, 'RS256', mint.kid, baseClaims());
  const [h, , s] = token.split('.');
  const forged = `${h}.${Buffer.from(JSON.stringify(baseClaims({ sub: 'admin' }))).toString('base64url')}.${s}`;
  assert.throws(() => verifyJwt(forged, cfg, keys), /signature|malformed/i);
});

test('OIDC: expired token is rejected', () => {
  const { mint, key } = generateSigningKey('RS256');
  const cfg = oidcConfig({ keys: [mint.jwk] });
  const keys = parseJwks(cfg.jwks!);
  const token = mintJwt(key, 'RS256', mint.kid, baseClaims({ exp: Math.floor(Date.now() / 1000) - 3600 }));
  assert.throws(() => verifyJwt(token, cfg, keys), /expired/);
});

test('OIDC: wrong issuer/audience is rejected', () => {
  const { mint, key } = generateSigningKey('RS256');
  const cfg = oidcConfig({ keys: [mint.jwk] });
  const keys = parseJwks(cfg.jwks!);
  assert.throws(
    () => verifyJwt(mintJwt(key, 'RS256', mint.kid, baseClaims({ iss: 'https://evil.example.com' })), cfg, keys),
    /iss/,
  );
  assert.throws(
    () => verifyJwt(mintJwt(key, 'RS256', mint.kid, baseClaims({ aud: 'other' })), cfg, keys),
    /aud/,
  );
});

test('OIDC: none-alg and unknown-kid tokens are rejected', () => {
  const { mint, key } = generateSigningKey('RS256');
  const cfg = oidcConfig({ keys: [mint.jwk] });
  const keys = parseJwks(cfg.jwks!);
  assert.throws(
    () => verifyJwt(mintJwt(key, 'RS256', mint.kid, baseClaims(), { alg: 'none' }), cfg, keys),
    /alg/,
  );
  assert.throws(
    () => verifyJwt(mintJwt(key, 'RS256', 'other-kid', baseClaims()), cfg, keys),
    /kid|key/i,
  );
});

test('OIDC: missing org claim is rejected by the authenticator', async () => {
  const { mint, key } = generateSigningKey('RS256');
  const claims: Record<string, unknown> = baseClaims();
  delete claims['org'];
  const authenticator = createAuthenticator({ oidc: oidcConfig({ keys: [mint.jwk] }) });
  await assert.rejects(
    () => authenticator.authenticate(`Bearer ${mintJwt(key, 'RS256', mint.kid, claims)}`),
    /org/,
  );
});

test('OIDC: an authenticator with no mechanisms fails closed', () => {
  assert.throws(() => createAuthenticator(undefined), /at least one mechanism/);
  assert.throws(() => createAuthenticator({}), /at least one mechanism/);
});

test('OIDC: unknown-kid misses are negatively cached, briefly (issue #48)', async () => {
  const { mint, key } = generateSigningKey('RS256');
  let clock = Date.now();
  let fetches = 0;
  const authenticator = new OidcAuthenticator({
    issuer: 'https://issuer.example.com',
    audience: 'bridge-registry',
    jwksUrl: 'https://issuer.example.com/jwks.json',
    fetchJwks: async () => {
      fetches += 1;
      return { keys: [mint.jwk] };
    },
    now: () => clock,
  });

  // Warm the cache: one fetch.
  const good = `Bearer ${mintJwt(key, 'RS256', mint.kid, baseClaims())}`;
  assert.equal((await authenticator.authenticate(good)).org, 'acme');
  assert.equal(fetches, 1);

  const bad = `Bearer ${mintJwt(key, 'RS256', 'ghost-kid', baseClaims())}`;
  await assert.rejects(() => authenticator.authenticate(bad), /unknown key/);
  assert.equal(fetches, 2, 'the first unknown kid forces exactly one refresh');

  await assert.rejects(() => authenticator.authenticate(bad), /unknown key/);
  await assert.rejects(() => authenticator.authenticate(bad), /unknown key/);
  assert.equal(fetches, 2, 'the negative cache answers repeats without fetching');

  // After the miss TTL lapses exactly one re-check is allowed — and it may
  // not turn the service into a per-request fetch amplifier.
  clock += 61_000;
  await assert.rejects(() => authenticator.authenticate(bad), /unknown key/);
  assert.equal(fetches, 3, 'an expired negative entry allows a single re-check');
  await assert.rejects(() => authenticator.authenticate(bad), /unknown key/);
  assert.equal(fetches, 3, 'the re-checked miss is negatively cached again');
});

test('OIDC: concurrent unknown-kid misses share one refresh (single-flight, issue #48)', async () => {
  const { mint, key } = generateSigningKey('RS256');
  let fetches = 0;
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const authenticator = new OidcAuthenticator({
    issuer: 'https://issuer.example.com',
    audience: 'bridge-registry',
    fetchJwks: async () => {
      fetches += 1;
      if (fetches === 1) return { keys: [mint.jwk] }; // warm-up
      await gate; // hold the forced refresh open
      return { keys: [mint.jwk] };
    },
  });

  const good = `Bearer ${mintJwt(key, 'RS256', mint.kid, baseClaims())}`;
  assert.equal((await authenticator.authenticate(good)).org, 'acme');
  assert.equal(fetches, 1);

  const bad = `Bearer ${mintJwt(key, 'RS256', 'flood-kid', baseClaims())}`;
  const attempts = Array.from({ length: 5 }, () =>
    authenticator.authenticate(bad).then(
      () => 'authenticated',
      (err: Error) => err.message,
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 25)); // let them pile up
  assert.equal(fetches, 2, 'the burst must be inside a single in-flight refresh');

  releaseGate();
  const outcomes = await Promise.all(attempts);
  assert.equal(fetches, 2, 'no caller may trigger an extra fetch');
  for (const message of outcomes) {
    assert.match(message, /unknown key/);
  }
  // The shared refresh confirmed the miss → negatively cached afterwards.
  await assert.rejects(() => authenticator.authenticate(bad), /unknown key/);
  assert.equal(fetches, 2);
});

test('OIDC: JWKS fetch failures never disclose the URL to clients (issue #48)', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('boom', { status: 500 })) as typeof fetch;
  try {
    const authenticator = new OidcAuthenticator({
      issuer: 'https://secret-idp.example.test',
      audience: 'bridge-registry',
      jwksUrl: 'https://secret-idp.example.test/internal-keys',
    });
    await assert.rejects(
      () => authenticator.authenticate('Bearer aaa.bbb.ccc'),
      (err: Error) =>
        /temporarily unavailable/.test(err.message) && !err.message.includes('secret-idp.example.test'),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OIDC: end-to-end authentication via createAuthenticator', async () => {
  const { mint, key } = generateSigningKey('RS256');
  const authenticator = createAuthenticator({
    oidc: oidcConfig({ keys: [mint.jwk] }),
  });
  const principal = await authenticator.authenticate(`Bearer ${mintJwt(key, 'RS256', mint.kid, baseClaims())}`);
  assert.equal(principal.kind, 'oidc');
  assert.equal(principal.org, 'acme');
  assert.equal(principal.level, 2);
});

// ---------------------------------------------------------------- signing

test('signing: a signed publish verifies and a tampered one does not', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const body = { ir: makeIrBody(), meta: {} };
  const message = Buffer.from(canonicalJson(body), 'utf8');
  const signature = cryptoSign(null, message, privateKey);

  const result = verifyPublishSignature(
    body,
    { 'x-bridge-key-id': 'k1', 'x-bridge-signature': signature.toString('base64') },
    { keys: { k1: pem } },
  );
  assert.equal(result.signed, true);

  const tampered = { ...body, ir: { ...makeIrBody(), name: 'other.v1' } };
  assert.throws(() =>
    verifyPublishSignature(
      tampered,
      { 'x-bridge-key-id': 'k1', 'x-bridge-signature': signature.toString('base64') },
      { keys: { k1: pem } },
    ),
  );
});

test('signing: unsigned publish is rejected in required mode', () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  assert.throws(
    () => verifyPublishSignature({ ir: makeIrBody() }, {}, { keys: { k1: pem } }),
    /signature-required|must be signed|signed/i,
  );
});

test('signing: unsigned publish passes in optional mode', () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const result = verifyPublishSignature({ ir: makeIrBody() }, {}, { keys: { k1: pem }, mode: 'optional' });
  assert.equal(result.signed, false);
});

test('signing: bodies beyond the canonical-JSON depth cap are a 400, not a 500 (issue #48)', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  // The CLIENT canonicalizes uncapped, so it can legitimately sign a deep
  // body; the server must answer 400 instead of dying on a RangeError.
  let deep: Record<string, unknown> = { leaf: true };
  for (let i = 0; i < 600; i++) deep = { nested: deep };
  const body = { ir: makeIrBody(), pad: deep };
  const signature = cryptoSign(null, Buffer.from(canonicalJson(body), 'utf8'), privateKey);
  assert.throws(
    () =>
      verifyPublishSignature(
        body,
        { 'x-bridge-key-id': 'k1', 'x-bridge-signature': signature.toString('base64') },
        { keys: { k1: pem } },
      ),
    (err: unknown) =>
      err instanceof ServiceError && err.status === 400 && /canonical-JSON depth/.test(err.message),
  );
  // A shallow body still verifies fine.
  const shallow = { ir: makeIrBody() };
  const okSignature = cryptoSign(null, Buffer.from(canonicalJson(shallow), 'utf8'), privateKey);
  const result = verifyPublishSignature(
    shallow,
    { 'x-bridge-key-id': 'k1', 'x-bridge-signature': okSignature.toString('base64') },
    { keys: { k1: pem } },
  );
  assert.equal(result.signed, true);
});

function makeIrBody(): Record<string, unknown> {
  return { name: 'payments.v1', imports: [], types: [], services: [], events: [] };
}
