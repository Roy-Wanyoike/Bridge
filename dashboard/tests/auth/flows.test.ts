import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { EnforcedAuthConfig } from '@/lib/auth/config';
import { FLOW_COOKIE, handleCallbackFlow, startLoginFlow, type FlowContext } from '@/lib/auth/flows';
import { clearOidcDiscoveryCache } from '@/lib/auth/oidc';
import { SESSION_COOKIE } from '@/lib/auth/session';

const AUTH: EnforcedAuthConfig = {
  mode: 'enforced',
  issuer: 'https://id.example.com/',
  clientId: 'bridge-console',
  clientSecret: 'client-secret-value',
  sessionSecret: 's'.repeat(64),
  sessionTtlSeconds: 28_800,
};

const NOW_MS = 1_700_000_000_000;

// Discovery is module-cached per issuer; each test starts clean so stubs are
// actually exercised.
beforeEach(() => {
  clearOidcDiscoveryCache();
});

function ctx(overrides: Partial<FlowContext> = {}): FlowContext {
  return {
    auth: AUTH,
    origin: 'https://console.example',
    nowMs: NOW_MS,
    ...overrides,
  };
}

interface StubProviderOptions {
  /** Nonce from the flow cookie — the token must echo it to pass validation. */
  nonce?: string;
  idTokenClaims?: Record<string, unknown>;
  tokenStatus?: number;
  tokenBody?: unknown;
}

const DISCOVERY_STUB = {
  issuer: AUTH.issuer,
  authorization_endpoint: 'https://id.example.com/authorize',
  token_endpoint: 'https://id.example.com/token',
  token_endpoint_auth_methods_supported: ['client_secret_post'],
};

/** Stubs discovery + token endpoints; returns the fetch impl and captured requests. */
function stubProvider(opts: StubProviderOptions = {}) {
  const idToken = (() => {
    const enc = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const claims = {
      iss: AUTH.issuer,
      aud: AUTH.clientId,
      sub: 'user-123',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      exp: Math.floor(NOW_MS / 1000) + 600,
      iat: Math.floor(NOW_MS / 1000),
      ...(opts.nonce !== undefined ? { nonce: opts.nonce } : {}),
      ...(opts.idTokenClaims ?? {}),
    };
    return `${enc({ alg: 'RS256' })}.${enc(claims)}.sig`;
  })();
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('openid-configuration')) {
      return Response.json(DISCOVERY_STUB);
    }
    if (url === DISCOVERY_STUB.token_endpoint) {
      if (opts.tokenStatus) return new Response(JSON.stringify(opts.tokenBody ?? {}), { status: opts.tokenStatus });
      return Response.json({ id_token: idToken, access_token: 'at' });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls: fetchImpl.mock.calls };
}

function parseFlowCookie(cookieValue: string): Record<string, string> {
  return JSON.parse(decodeURIComponent(cookieValue));
}

/** Starts a sign-in against a discovery-only stub and hands back the flow state. */
async function startAndReturnFlow(returnTo = '/contracts') {
  const discoveryOnly = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('openid-configuration')) return Response.json(DISCOVERY_STUB);
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
  const started = await startLoginFlow(ctx({ fetchImpl: discoveryOnly }), returnTo);
  const flow = parseFlowCookie(started.cookies[0].value);
  return { flow };
}

describe('startLoginFlow (issue #163)', () => {
  test('redirects to the provider with PKCE + state + nonce and plants the flow cookie', async () => {
    const { fetchImpl } = stubProvider();
    const result = await startLoginFlow(ctx({ fetchImpl }), '/contracts?org=acme');
    expect(result.status).toBe(302);
    const target = new URL(result.redirect as string);
    expect(target.origin + target.pathname).toBe('https://id.example.com/authorize');
    expect(target.searchParams.get('response_type')).toBe('code');
    expect(target.searchParams.get('client_id')).toBe('bridge-console');
    expect(target.searchParams.get('redirect_uri')).toBe('https://console.example/api/auth/callback');
    expect(target.searchParams.get('code_challenge_method')).toBe('S256');
    expect(target.searchParams.get('scope')).toBe('openid profile email');

    expect(result.cookies).toHaveLength(1);
    const cookie = result.cookies[0];
    expect(cookie.name).toBe(FLOW_COOKIE);
    expect(cookie.maxAge).toBe(600);
    expect(cookie.secure).toBe(true);
    const flow = parseFlowCookie(cookie.value);
    expect(flow.state).toBe(target.searchParams.get('state'));
    expect(flow.nonce).toBe(target.searchParams.get('nonce'));
    expect(flow.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(flow.returnTo).toBe('/contracts?org=acme');
  });

  test('unreachable provider sends the user back to /login with a readable error', async () => {
    const fetchImpl = vi.fn(async () => new Response('down', { status: 503 }));
    const result = await startLoginFlow(ctx({ fetchImpl }), '/');
    expect(result.redirect).toBe('/login?error=provider_unavailable');
    expect(result.cookies).toHaveLength(0);
    expect(result.log).toContain('discovery failed');
  });

  test('returnTo is sanitized before entering the flow cookie', async () => {
    const { fetchImpl } = stubProvider();
    const result = await startLoginFlow(ctx({ fetchImpl }), 'https://evil.example');
    const flow = parseFlowCookie(result.cookies[0].value);
    expect(flow.returnTo).toBe('/');
  });
});

describe('handleCallbackFlow (issue #163 acceptance 2, 3, 4, 6)', () => {
  test('happy path: exchanges the code, issues the session, clears the flow cookie, honors returnTo', async () => {
    const { flow } = await startAndReturnFlow('/audit');
    const { fetchImpl } = stubProvider({ nonce: flow.nonce });
    const callbackUrl = new URL(`https://console.example/api/auth/callback?code=abc&state=${flow.state}`);
    const result = await handleCallbackFlow(ctx({ fetchImpl }), {
      url: callbackUrl,
      getCookie: (name) => (name === FLOW_COOKIE ? encodeURIComponent(JSON.stringify(flow)) : undefined),
    });

    expect(result.status).toBe(302);
    expect(result.redirect).toBe('/audit');
    const sessionCookie = result.cookies.find((c) => c.name === SESSION_COOKIE);
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie?.value.startsWith('v1.')).toBe(true);
    expect(sessionCookie?.maxAge).toBe(AUTH.sessionTtlSeconds);
    expect(sessionCookie?.secure).toBe(true);
    const cleared = result.cookies.find((c) => c.name === FLOW_COOKIE);
    expect(cleared?.clear).toBe(true);
    expect(cleared?.value).toBe('');

    // Session verifies against the same secret.
    const { verifySessionToken } = await import('@/lib/auth/session');
    const claims = await verifySessionToken(sessionCookie!.value, AUTH.sessionSecret, Math.floor(NOW_MS / 1000));
    expect(claims?.sub).toBe('user-123');
    expect(claims?.email).toBe('ada@example.com');
  });

  test('state mismatch (missing cookie, wrong value, or missing param) fails closed to a readable error', async () => {
    const { flow } = await startAndReturnFlow();
    const { fetchImpl } = stubProvider({ nonce: flow.nonce });
    const noCookie = await handleCallbackFlow(ctx({ fetchImpl }), {
      url: new URL(`https://console.example/api/auth/callback?code=abc&state=${flow.state}`),
      getCookie: () => undefined,
    });
    expect(noCookie.redirect).toBe('/login?error=state_mismatch');

    const wrongState = await handleCallbackFlow(ctx({ fetchImpl }), {
      url: new URL('https://console.example/api/auth/callback?code=abc&state=WRONG'),
      getCookie: (name) => (name === FLOW_COOKIE ? encodeURIComponent(JSON.stringify(flow)) : undefined),
    });
    expect(wrongState.redirect).toBe('/login?error=state_mismatch');

    const noParam = await handleCallbackFlow(ctx({ fetchImpl }), {
      url: new URL('https://console.example/api/auth/callback?code=abc'),
      getCookie: (name) => (name === FLOW_COOKIE ? encodeURIComponent(JSON.stringify(flow)) : undefined),
    });
    expect(noParam.redirect).toBe('/login?error=state_mismatch');
  });

  test('provider error params land on /login with the provider_error code', async () => {
    const { flow } = await startAndReturnFlow();
    const { fetchImpl } = stubProvider({ nonce: flow.nonce });
    const result = await handleCallbackFlow(ctx({ fetchImpl }), {
      url: new URL('https://console.example/api/auth/callback?error=access_denied&error_description=user+denied'),
      getCookie: () => encodeURIComponent(JSON.stringify(flow)),
    });
    expect(result.redirect).toBe('/login?error=provider_error');
    expect(result.log).toContain('access_denied');
  });

  test('token exchange failures surface as provider errors, never half-sessions', async () => {
    const { flow } = await startAndReturnFlow();
    const { fetchImpl } = stubProvider({ nonce: flow.nonce, tokenStatus: 400, tokenBody: { error: 'invalid_grant' } });
    const result = await handleCallbackFlow(ctx({ fetchImpl }), {
      url: new URL(`https://console.example/api/auth/callback?code=abc&state=${flow.state}`),
      getCookie: (name) => (name === FLOW_COOKIE ? encodeURIComponent(JSON.stringify(flow)) : undefined),
    });
    expect(result.redirect).toBe('/login?error=provider_error');
    expect(result.cookies).toHaveLength(0);
  });

  test('nonce binding: an ID token minted for another sign-in is rejected', async () => {
    const { flow } = await startAndReturnFlow();
    const { fetchImpl } = stubProvider({ nonce: 'another-sign-in-nonce' });
    const result = await handleCallbackFlow(ctx({ fetchImpl }), {
      url: new URL(`https://console.example/api/auth/callback?code=abc&state=${flow.state}`),
      getCookie: (name) => (name === FLOW_COOKIE ? encodeURIComponent(JSON.stringify(flow)) : undefined),
    });
    expect(result.redirect).toBe('/login?error=id_token_invalid');
    expect(result.cookies).toHaveLength(0);
  });

  test('forged returnTo inside the flow cookie cannot redirect off-origin', async () => {
    const { flow } = await startAndReturnFlow();
    flow.returnTo = 'https://evil.example';
    const { fetchImpl } = stubProvider({ nonce: flow.nonce });
    const result = await handleCallbackFlow(ctx({ fetchImpl }), {
      url: new URL(`https://console.example/api/auth/callback?code=abc&state=${flow.state}`),
      getCookie: () => encodeURIComponent(JSON.stringify(flow)),
    });
    expect(result.redirect).toBe('/');
  });

  test('over-http origins issue non-Secure cookies (local provider round-trips)', async () => {
    const { flow } = await startAndReturnFlow();
    const { fetchImpl } = stubProvider({ nonce: flow.nonce });
    const result = await handleCallbackFlow(ctx({ origin: 'http://localhost:3000', fetchImpl }), {
      url: new URL(`http://localhost:3000/api/auth/callback?code=abc&state=${flow.state}`),
      getCookie: () => encodeURIComponent(JSON.stringify(flow)),
    });
    expect(result.cookies.find((c) => c.name === SESSION_COOKIE)?.secure).toBe(false);
  });
});

describe('logoutCookies', () => {
  test('clears both session and flow cookies', async () => {
    const { logoutCookies } = await import('@/lib/auth/flows');
    const cookies = logoutCookies(true);
    expect(cookies.map((c) => c.name)).toEqual([FLOW_COOKIE, SESSION_COOKIE]);
    expect(cookies.every((c) => c.clear && c.value === '')).toBe(true);
  });
});
