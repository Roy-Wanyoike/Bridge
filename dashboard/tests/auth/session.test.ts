import { describe, expect, test } from 'vitest';
import { createPkcePair, randomToken } from '@/lib/auth/oidc';
import {
  SESSION_COOKIE,
  sessionCookieOptions,
  signSession,
  verifySessionToken,
} from '@/lib/auth/session';

const SECRET = 'session-secret-'.repeat(5); // > 32 chars
const NOW = 1_700_000_000;

describe('signed session cookie (issue #163 acceptance 2)', () => {
  test('sign → verify round-trips the identity', async () => {
    const token = await signSession({ sub: 'user-123', name: 'Ada', email: 'ada@example.com' }, SECRET, NOW, 3600);
    const claims = await verifySessionToken(token, SECRET, NOW + 10);
    expect(claims).not.toBeNull();
    expect(claims?.sub).toBe('user-123');
    expect(claims?.name).toBe('Ada');
    expect(claims?.email).toBe('ada@example.com');
    expect(claims?.iat).toBe(NOW);
    expect(claims?.exp).toBe(NOW + 3600);
  });

  test('tampered payload is rejected', async () => {
    const token = await signSession({ sub: 'user-123' }, SECRET, NOW, 3600);
    const [v1, payload, sig] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ sub: 'admin', iat: NOW, exp: NOW + 99999 }),
    ).toString('base64url');
    expect(await verifySessionToken(`${v1}.${forged}.${sig}`, SECRET, NOW)).toBeNull();
    void payload;
  });

  test('re-signed payload under a different secret is rejected (wrong SECRET)', async () => {
    const token = await signSession({ sub: 'user-123' }, SECRET, NOW, 3600);
    expect(await verifySessionToken(token, 'other-secret'.repeat(4), NOW)).toBeNull();
  });

  test('expired sessions are unauthenticated, not errors', async () => {
    const token = await signSession({ sub: 'user-123' }, SECRET, NOW, 3600);
    expect(await verifySessionToken(token, SECRET, NOW + 3601)).toBeNull();
  });

  test('garbage tokens never throw — any failure is just null', async () => {
    for (const garbage of ['', 'v1', 'v1.abc', 'v1.abc.def.ghi', 'v2.abc.def', 'v1.!!!.???', 'null']) {
      expect(await verifySessionToken(garbage, SECRET, NOW)).toBeNull();
    }
  });

  test('optional claims stay optional; unknown shapes are rejected', async () => {
    const minimal = await signSession({ sub: 'user-123' }, SECRET, NOW, 3600);
    const claims = await verifySessionToken(minimal, SECRET, NOW);
    expect(claims?.name).toBeUndefined();
    expect(claims?.email).toBeUndefined();

    // Hand-forge a payload with wrong-typed fields.
    const forge = async (payload: object) => {
      const { encodeBase64Url } = await import('@/lib/auth/base64url');
      const { utf8Bytes } = await import('@/lib/auth/base64url');
      const payloadB64 = encodeBase64Url(utf8Bytes(JSON.stringify(payload)));
      return signSession({ sub: 'x' }, SECRET, NOW, 3600).then((t) => {
        const sig = t.split('.')[2];
        return `v1.${payloadB64}.${sig}`;
      });
    };
    expect(await verifySessionToken(await forge({ sub: 'x', iat: 'now', exp: NOW + 100 }), SECRET, NOW)).toBeNull();
    expect(await verifySessionToken(await forge({ sub: 'x', iat: NOW, exp: NOW + 100, name: 42 }), SECRET, NOW)).toBeNull();
  });

  test('PKCE pairs satisfy the S256 binding', async () => {
    const { verifier, challenge } = await createPkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    expect(challenge).toBe(btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
    const second = await createPkcePair();
    expect(second.verifier).not.toBe(verifier);
  });

  test('randomToken produces distinct url-safe values', () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  test('cookie options are httpOnly + Lax + path=/ with the given TTL', () => {
    expect(sessionCookieOptions(3600, true)).toEqual({
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      path: '/',
      maxAge: 3600,
    });
    expect(sessionCookieOptions(60, false).secure).toBe(false);
    expect(SESSION_COOKIE).toBe('bridge_console_session');
  });
});
