/**
 * Minimal OIDC client primitives (issue #163).
 *
 * Scope: authorization-code flow with PKCE (S256) for a *confidential*
 * client, against any conformant provider via discovery. Deliberately not a
 * general OIDC library — the console needs one flow, done correctly:
 *
 * - Discovery is fetched from `<issuer>/.well-known/openid-configuration`,
 *   issuer-matched, https-enforced (localhost exempt for local Keycloak/
 *   Dex-style testing) and cached for an hour.
 * - The ID token received at the token endpoint is validated for iss/aud/
 *   exp/iat/nonce. Its signature is *not* re-verified: the token is fetched
 *   server-side directly from the token endpoint over TLS with the client
 *   secret (OIDC Core §3.1.3.7 permits skipping signature checks in this
 *   exact configuration — every other validation still applies). This
 *   avoids pulling a JWKS stack + crypto dependencies for a flow that
 *   cannot receive a forged ID token without also breaking TLS.
 * - No third-party dependencies: crypto.subtle + fetch only, so the same
 *   code runs in the proxy runtime, route handlers and tests.
 */

import { decodeBase64, encodeBase64Standard, encodeBase64Url, utf8Bytes, utf8Text } from './base64url';

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  end_session_endpoint?: string;
  token_endpoint_auth_methods_supported?: string[];
}

export interface IdTokenClaims {
  sub: string;
  name?: string;
  email?: string;
  iss?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  nonce?: string;
  azp?: string;
}

export class OidcError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'OidcError';
    this.code = code;
  }
}

const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const CLOCK_LEEWAY_SECONDS = 60;

const discoveryCache = new Map<string, { discovery: OidcDiscovery; expiresAt: number }>();

export function clearOidcDiscoveryCache(): void {
  discoveryCache.clear();
}

function assertHttps(url: URL, what: string): void {
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  if (url.protocol !== 'https:' && !isLocal) {
    throw new OidcError('provider_insecure', `${what} must be https (non-local issuer): ${url.href}`);
  }
}

/** Fetches and validates the provider's discovery document (1h cache). */
export async function discoverOidc(issuer: string, fetchImpl: typeof fetch = fetch): Promise<OidcDiscovery> {
  const cached = discoveryCache.get(issuer);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.discovery;

  let doc: unknown;
  try {
    const res = await fetchImpl(`${issuer}.well-known/openid-configuration`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new OidcError(
        'provider_unavailable',
        `Discovery request failed: ${issuer}.well-known/openid-configuration answered ${res.status}`,
      );
    }
    doc = await res.json();
  } catch (err) {
    if (err instanceof OidcError) throw err;
    throw new OidcError(
      'provider_unavailable',
      `Discovery request failed for issuer ${JSON.stringify(issuer)}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (typeof doc !== 'object' || doc === null) {
    throw new OidcError('provider_invalid', 'Discovery document is not a JSON object');
  }
  const d = doc as Record<string, unknown>;
  for (const field of ['issuer', 'authorization_endpoint', 'token_endpoint'] as const) {
    if (typeof d[field] !== 'string' || (d[field] as string).length === 0) {
      throw new OidcError('provider_invalid', `Discovery document is missing ${field}`);
    }
  }
  // Exact issuer match (trailing-slash normalized) — otherwise a hostile
  // discovery doc could mix endpoints from a different deployment.
  const norm = (s: string) => (s.endsWith('/') ? s : `${s}/`);
  if (norm(String(d.issuer)) !== norm(issuer)) {
    throw new OidcError(
      'provider_invalid',
      `Discovery issuer mismatch: document says ${JSON.stringify(d.issuer)}, config says ${JSON.stringify(issuer)}`,
    );
  }
  let authorization: URL;
  let token: URL;
  try {
    authorization = new URL(String(d.authorization_endpoint));
    token = new URL(String(d.token_endpoint));
  } catch {
    throw new OidcError('provider_invalid', 'Discovery endpoints are not valid URLs');
  }
  assertHttps(authorization, 'authorization_endpoint');
  assertHttps(token, 'token_endpoint');

  const discovery: OidcDiscovery = {
    issuer: norm(String(d.issuer)),
    authorization_endpoint: authorization.href,
    token_endpoint: token.href,
    end_session_endpoint: typeof d.end_session_endpoint === 'string' ? d.end_session_endpoint : undefined,
    token_endpoint_auth_methods_supported: Array.isArray(d.token_endpoint_auth_methods_supported)
      ? (d.token_endpoint_auth_methods_supported as unknown[]).filter(
          (m): m is string => typeof m === 'string',
        )
      : undefined,
  };
  discoveryCache.set(issuer, { discovery, expiresAt: now + DISCOVERY_TTL_MS });
  return discovery;
}

/** 32 random bytes, base64url — 43-char unreserved string, per RFC 7636 §4.1. */
export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** PKCE S256 pair: challenge = BASE64URL(SHA256(ASCII(verifier))). */
export async function createPkcePair(): Promise<PkcePair> {
  const verifier = randomToken(32);
  const digest = await crypto.subtle.digest('SHA-256', utf8Bytes(verifier));
  return { verifier, challenge: encodeBase64Url(new Uint8Array(digest)) };
}

export interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  challenge: string;
}

/** Builds the authorization redirect (response_type=code, scope openid profile email). */
export function buildAuthorizeUrl(discovery: OidcDiscovery, p: AuthorizeParams): string {
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', p.clientId);
  url.searchParams.set('redirect_uri', p.redirectUri);
  url.searchParams.set('scope', 'openid profile email');
  url.searchParams.set('state', p.state);
  url.searchParams.set('nonce', p.nonce);
  url.searchParams.set('code_challenge', p.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.href;
}

/**
 * Chooses the token-endpoint auth method: `client_secret_post` by default,
 * falling back to `client_secret_basic` when the provider explicitly lists
 * supported methods and excludes post.
 */
function tokenAuthMethod(discovery: OidcDiscovery): 'post' | 'basic' {
  const supported = discovery.token_endpoint_auth_methods_supported;
  if (!supported || supported.length === 0) return 'post';
  if (supported.includes('client_secret_post')) return 'post';
  if (supported.includes('client_secret_basic')) return 'basic';
  // Provider wants something we do not implement (private_key_jwt, tls_client_auth…).
  throw new OidcError(
    'provider_invalid',
    `Provider token endpoint requires unsupported auth: ${supported.join(', ')}`,
  );
}

export interface ExchangeParams {
  code: string;
  verifier: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * Exchanges the authorization code for tokens at the token endpoint and
 * returns the ID token string (validation happens in validateIdToken).
 */
export async function exchangeAuthorizationCode(
  discovery: OidcDiscovery,
  p: ExchangeParams,
  fetchImpl: typeof fetch = fetch,
): Promise<{ idToken: string }> {
  const method = tokenAuthMethod(discovery);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: p.code,
    redirect_uri: p.redirectUri,
    code_verifier: p.verifier,
  });
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };
  if (method === 'post') {
    body.set('client_id', p.clientId);
    body.set('client_secret', p.clientSecret);
  } else {
    headers.authorization = `Basic ${encodeBase64Standard(utf8Bytes(`${p.clientId}:${p.clientSecret}`))}`;
  }

  let res: Response;
  try {
    res = await fetchImpl(discovery.token_endpoint, {
      method: 'POST',
      headers,
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new OidcError(
      'provider_unavailable',
      `Token endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new OidcError('provider_invalid', `Token endpoint answered ${res.status} with a non-JSON body`);
  }
  if (typeof payload !== 'object' || payload === null) {
    throw new OidcError('provider_invalid', 'Token endpoint response is not a JSON object');
  }
  const obj = payload as Record<string, unknown>;
  if (!res.ok) {
    const code = typeof obj.error === 'string' ? obj.error : 'token_request_rejected';
    const desc = typeof obj.error_description === 'string' ? `: ${obj.error_description}` : '';
    throw new OidcError('provider_error', `Token endpoint rejected the exchange (${code}${desc})`);
  }
  if (typeof obj.id_token !== 'string' || obj.id_token.length === 0) {
    throw new OidcError('provider_invalid', 'Token endpoint response has no id_token (scope openid required)');
  }
  return { idToken: obj.id_token };
}

function decodeJwtSegment(segment: string): Record<string, unknown> | null {
  const bytes = decodeBase64(segment);
  if (!bytes) return null;
  try {
    const parsed: unknown = JSON.parse(utf8Text(bytes));
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface IdTokenExpectations {
  issuer: string;
  clientId: string;
  nonce: string;
  nowSeconds: number;
}

/**
 * Validates an ID token's claims and returns the identity. Throws
 * OidcError('id_token_*') on any failure — callers translate that into a
 * redirect to /login with a human-readable error, never a bare digest.
 */
export function validateIdToken(idToken: string, expected: IdTokenExpectations): IdTokenClaims {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new OidcError('id_token_invalid', 'ID token is not a JWT');
  const claims = decodeJwtSegment(parts[1]);
  if (!claims) throw new OidcError('id_token_invalid', 'ID token payload is malformed');

  if (claims.iss !== expected.issuer && `${claims.iss}/` !== expected.issuer) {
    throw new OidcError('id_token_issuer', 'ID token issuer does not match the configured provider');
  }

  const audiences: string[] = Array.isArray(claims.aud)
    ? (claims.aud as unknown[]).filter((a): a is string => typeof a === 'string')
    : typeof claims.aud === 'string'
      ? [claims.aud]
      : [];
  if (!audiences.includes(expected.clientId)) {
    throw new OidcError('id_token_audience', 'ID token audience does not include this console’s client id');
  }
  if (audiences.length > 1 && claims.azp !== expected.clientId) {
    throw new OidcError('id_token_audience', 'ID token has multiple audiences without an azp for this client');
  }

  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_LEEWAY_SECONDS <= expected.nowSeconds) {
    throw new OidcError('id_token_expired', 'ID token has expired');
  }
  if (typeof claims.iat === 'number' && claims.iat - CLOCK_LEEWAY_SECONDS > expected.nowSeconds) {
    throw new OidcError('id_token_invalid', 'ID token issued in the future');
  }
  if (typeof claims.nonce !== 'string' || claims.nonce !== expected.nonce) {
    throw new OidcError('id_token_nonce', 'ID token nonce does not match the pending sign-in');
  }
  if (typeof claims.sub !== 'string' || claims.sub === '') {
    throw new OidcError('id_token_invalid', 'ID token has no subject');
  }

  return {
    sub: claims.sub,
    ...(typeof claims.name === 'string' && claims.name ? { name: claims.name } : {}),
    ...(typeof claims.email === 'string' && claims.email ? { email: claims.email } : {}),
  };
}
