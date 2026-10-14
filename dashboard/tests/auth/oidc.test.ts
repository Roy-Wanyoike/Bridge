import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  buildAuthorizeUrl,
  clearOidcDiscoveryCache,
  discoverOidc,
  exchangeAuthorizationCode,
  OidcError,
  validateIdToken,
  type OidcDiscovery,
} from '@/lib/auth/oidc';

const ISSUER = 'https://id.example.com/';
const DISCOVERY: OidcDiscovery = {
  issuer: ISSUER,
  authorization_endpoint: 'https://id.example.com/authorize',
  token_endpoint: 'https://id.example.com/token',
  token_endpoint_auth_methods_supported: ['client_secret_post'],
};

/** Builds a JWT whose payload decodes to `claims` (signature unchecked by design — code flow over TLS). */
function fakeIdToken(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc(claims)}.sig`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  clearOidcDiscoveryCache();
  vi.unstubAllGlobals();
});

describe('OIDC discovery (issue #163 acceptance 5)', () => {
  test('fetches, issuer-matches and caches the discovery document', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(DISCOVERY));
    const first = await discoverOidc(ISSUER, fetchImpl as unknown as typeof fetch);
    expect(first.token_endpoint).toBe(DISCOVERY.token_endpoint);
    const second = await discoverOidc(ISSUER, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(fetchImpl.mock.calls[0][0]).toBe(`${ISSUER}.well-known/openid-configuration`);
  });

  test('issuer mismatch is a hard failure (hostile discovery doc)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ...DISCOVERY, issuer: 'https://other.example/' }));
    await expect(discoverOidc(ISSUER, fetchImpl as unknown as typeof fetch)).rejects.toMatchObject({
      code: 'provider_invalid',
    });
  });

  test('missing endpoints and non-200 are structured errors, not crashes', async () => {
    const noToken = vi.fn().mockResolvedValue(jsonResponse({ issuer: ISSUER, authorization_endpoint: 'https://x' }));
    await expect(discoverOidc(ISSUER, noToken as unknown as typeof fetch)).rejects.toMatchObject({
      code: 'provider_invalid',
    });
    const failing = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }));
    await expect(discoverOidc(ISSUER, failing as unknown as typeof fetch)).rejects.toMatchObject({
      code: 'provider_unavailable',
    });
    const networkDown = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(discoverOidc(ISSUER, networkDown as unknown as typeof fetch)).rejects.toMatchObject({
      code: 'provider_unavailable',
    });
  });

  test('plaintext endpoints on non-local issuers are refused', async () => {
    const insecure = {
      ...DISCOVERY,
      token_endpoint: 'http://id.example.com/token',
      token_endpoint_auth_methods_supported: undefined,
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(insecure));
    await expect(discoverOidc(ISSUER, fetchImpl as unknown as typeof fetch)).rejects.toMatchObject({
      code: 'provider_insecure',
    });
  });
});

describe('authorization request (issue #163 acceptance 3)', () => {
  test('authorize URL carries response_type=code, S256 challenge, state and nonce', () => {
    const url = new URL(
      buildAuthorizeUrl(DISCOVERY, {
        clientId: 'bridge-console',
        redirectUri: 'https://console.example/api/auth/callback',
        state: 'state-1',
        nonce: 'nonce-1',
        challenge: 'challenge-1',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://id.example.com/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('bridge-console');
    expect(url.searchParams.get('redirect_uri')).toBe('https://console.example/api/auth/callback');
    expect(url.searchParams.get('scope')).toBe('openid profile email');
    expect(url.searchParams.get('state')).toBe('state-1');
    expect(url.searchParams.get('nonce')).toBe('nonce-1');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-1');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });
});

describe('token exchange (issue #163)', () => {
  const params = {
    code: 'auth-code-1',
    verifier: 'verifier-1',
    clientId: 'bridge-console',
    clientSecret: 'client-secret-value',
    redirectUri: 'https://console.example/api/auth/callback',
  };

  test('posts the code + verifier with client_secret_post by default', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id_token: 'header.payload.sig' }));
    await exchangeAuthorizationCode(DISCOVERY, params, fetchImpl as unknown as typeof fetch);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(DISCOVERY.token_endpoint);
    expect(init.method).toBe('POST');
    const body = new URLSearchParams(String(init.body));
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('auth-code-1');
    expect(body.get('code_verifier')).toBe('verifier-1');
    expect(body.get('client_id')).toBe('bridge-console');
    expect(body.get('client_secret')).toBe('client-secret-value');
  });

  test('falls back to client_secret_basic when post is not supported', async () => {
    const basic: OidcDiscovery = {
      ...DISCOVERY,
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'none'],
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id_token: 'h.p.s' }));
    await exchangeAuthorizationCode(basic, params, fetchImpl as unknown as typeof fetch);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^Basic /);
    expect(atob(headers.authorization.slice(6))).toBe('bridge-console:client-secret-value');
    const body = new URLSearchParams(String(init.body));
    expect(body.get('client_secret')).toBeNull();
  });

  test('unsupported provider auth methods are a structured error', async () => {
    const strict: OidcDiscovery = {
      ...DISCOVERY,
      token_endpoint_auth_methods_supported: ['private_key_jwt'],
    };
    await expect(exchangeAuthorizationCode(strict, params, vi.fn() as unknown as typeof fetch)).rejects.toMatchObject({
      code: 'provider_invalid',
    });
  });

  test('provider rejections and non-JSON bodies surface as provider errors', async () => {
    const rejected = vi.fn().mockResolvedValue(jsonResponse({ error: 'invalid_grant', error_description: 'code expired' }, 400));
    await expect(exchangeAuthorizationCode(DISCOVERY, params, rejected as unknown as typeof fetch)).rejects.toMatchObject({
      code: 'provider_error',
      message: expect.stringContaining('invalid_grant'),
    });
    const garbage = vi.fn().mockResolvedValue(new Response('<html>', { status: 200 }));
    await expect(exchangeAuthorizationCode(DISCOVERY, params, garbage as unknown as typeof fetch)).rejects.toMatchObject({
      code: 'provider_invalid',
    });
    const noToken = vi.fn().mockResolvedValue(jsonResponse({ access_token: 'x' }));
    await expect(exchangeAuthorizationCode(DISCOVERY, params, noToken as unknown as typeof fetch)).rejects.toMatchObject({
      code: 'provider_invalid',
    });
  });
});

describe('ID token validation (issue #163 acceptance 3)', () => {
  const base = {
    iss: ISSUER,
    aud: 'bridge-console',
    sub: 'user-123',
    exp: 1_700_001_000,
    iat: 1_700_000_000,
    nonce: 'nonce-1',
  };
  const expected = { issuer: ISSUER, clientId: 'bridge-console', nonce: 'nonce-1', nowSeconds: 1_700_000_000 };

  test('accepts a conformant token and extracts the identity', () => {
    const claims = validateIdToken(fakeIdToken(base), expected);
    expect(claims.sub).toBe('user-123');
  });

  test('rejects wrong issuer, audience, nonce, expiry and future iat', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...base, iss: 'https://attacker.example/' }, 'id_token_issuer'],
      [{ ...base, aud: 'other-client' }, 'id_token_audience'],
      [{ ...base, nonce: 'wrong' }, 'id_token_nonce'],
      [{ ...base, exp: 1_699_999_000 }, 'id_token_expired'],
      [{ ...base, iat: 1_700_000_500 }, 'id_token_invalid'],
      [{ ...base, sub: '' }, 'id_token_invalid'],
      [{ ...base, aud: ['bridge-console', 'second'], azp: 'other' }, 'id_token_audience'],
    ];
    for (const [claims, code] of cases) {
      try {
        validateIdToken(fakeIdToken(claims), expected);
        expect.unreachable(`expected ${code}`);
      } catch (err) {
        expect(err).toBeInstanceOf(OidcError);
        expect((err as OidcError).code).toBe(code);
      }
    }
  });

  test('multi-audience tokens pass when azp names this client', () => {
    const claims = validateIdToken(fakeIdToken({ ...base, aud: ['bridge-console', 'second'], azp: 'bridge-console' }), expected);
    expect(claims.sub).toBe('user-123');
  });

  test('malformed JWTs are rejected without throwing raw parse errors', () => {
    for (const bad of ['', 'a.b', 'h.p.s.extra', 'h.!!!.s']) {
      try {
        validateIdToken(bad, expected);
        expect.unreachable();
      } catch (err) {
        expect((err as OidcError).code).toBe('id_token_invalid');
      }
    }
  });
});
