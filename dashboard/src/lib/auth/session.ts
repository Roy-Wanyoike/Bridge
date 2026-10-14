/**
 * Signed session cookie (issue #163).
 *
 * The console keeps no server-side session store: the session is a compact
 * signed token (HMAC-SHA256 over a base64url JSON payload) held in an
 * httpOnly cookie. Rationale:
 *
 * - Stateless fits the deployment model (single Vercel project, no shared
 *   store); the tradeoff — no server-side revocation — is acceptable
 *   because the session is short-lived (default 8h) and the only privilege
 *   it grants is "may view the console", with registry reads still done
 *   through the server-side token.
 * - `tampered cookie -> treated as unauthenticated` is the acceptance
 *   criterion: signature + expiry are checked on every request; any
 *   failure yields `null` and the caller redirects to /login.
 *
 * Wire format: `v1.<payload-b64url>.<sig-b64url>` where the signature is
 * HMAC-SHA256 over the literal `v1.<payload-b64url>` string. Comparisons
 * are constant-time over the encoded digests.
 */

import { decodeBase64, encodeBase64Url, utf8Bytes, utf8Text } from './base64url';

export const SESSION_COOKIE = 'bridge_console_session';
export const SESSION_COOKIE_MAX_AGE_DEFAULT = 8 * 60 * 60;

export interface SessionClaims {
  /** Provider subject id. */
  sub: string;
  /** Display name, when the provider supplies one. */
  name?: string;
  /** Email, when the provider supplies one. */
  email?: string;
  /** Issued-at, epoch seconds. */
  iat: number;
  /** Expiry, epoch seconds. */
  exp: number;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    utf8Bytes(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, utf8Bytes(value));
  return encodeBase64Url(new Uint8Array(sig));
}

/** Signs claims into the `v1.<payload>.<sig>` token. */
export async function signSession(
  claims: Omit<SessionClaims, 'iat' | 'exp'> & { iat?: number; exp?: number },
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  ttlSeconds: number = SESSION_COOKIE_MAX_AGE_DEFAULT,
): Promise<string> {
  const payload: SessionClaims = {
    sub: claims.sub,
    ...(claims.name !== undefined ? { name: claims.name } : {}),
    ...(claims.email !== undefined ? { email: claims.email } : {}),
    iat: claims.iat ?? nowSeconds,
    exp: claims.exp ?? nowSeconds + ttlSeconds,
  };
  const payloadB64 = encodeBase64Url(utf8Bytes(JSON.stringify(payload)));
  const signingValue = `v1.${payloadB64}`;
  const sig = await hmac(secret, signingValue);
  return `${signingValue}.${sig}`;
}

/**
 * Verifies signature + expiry. Returns the claims, or null for ANY failure
 * (wrong version, malformed base64/JSON, bad signature, expired) — callers
 * treat null as "no session".
 */
export async function verifySessionToken(
  token: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<SessionClaims | null> {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const [, payloadB64, sig] = parts;
  if (!payloadB64 || !sig) return null;

  const expected = await hmac(secret, `v1.${payloadB64}`);
  if (!constantTimeEqual(expected, sig)) return null;

  const raw = decodeBase64(payloadB64);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Text(raw));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const c = parsed as Record<string, unknown>;
  if (typeof c.sub !== 'string' || c.sub === '') return null;
  if (typeof c.iat !== 'number' || !Number.isFinite(c.iat)) return null;
  if (typeof c.exp !== 'number' || !Number.isFinite(c.exp)) return null;
  if (c.exp <= nowSeconds) return null;
  if (c.name !== undefined && typeof c.name !== 'string') return null;
  if (c.email !== undefined && typeof c.email !== 'string') return null;

  return { sub: c.sub, name: c.name, email: c.email, iat: c.iat, exp: c.exp };
}

/**
 * Cookie attributes for the session. `secure` must be true behind TLS
 * (production); tests/local http use false. SameSite=Lax survives the OIDC
 * redirect round-trip (top-level GET navigations carry Lax cookies both
 * ways) while never leaking the cookie on cross-site subresource requests.
 */
export function sessionCookieOptions(
  ttlSeconds: number,
  secure: boolean,
): { httpOnly: true; sameSite: 'lax'; secure: boolean; path: '/'; maxAge: number } {
  return { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: ttlSeconds };
}
