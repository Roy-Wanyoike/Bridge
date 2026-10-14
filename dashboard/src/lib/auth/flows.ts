/**
 * OIDC flow orchestration (issue #163): sign-in start, callback, logout.
 *
 * Route handlers under `src/app/api/auth/*` stay thin adapters; the logic
 * lives here with injectable `fetch` and clock so the full round-trip is
 * unit-tested against a stubbed provider (acceptance criterion 6).
 *
 * State handling: one short-lived httpOnly cookie (`bridge_oidc_flow`)
 * carries the CSRF `state`, the PKCE verifier, the expected nonce and the
 * sanitized `returnTo` as a JSON blob. One cookie instead of four keeps the
 * browser contract small and makes "state cookie missing" and "state
 * mismatched" the same recoverable failure: back to /login with a readable
 * error, nothing half-authenticated.
 */

import type { EnforcedAuthConfig } from './config';
import {
  buildAuthorizeUrl,
  createPkcePair,
  discoverOidc,
  exchangeAuthorizationCode,
  OidcError,
  randomToken,
  validateIdToken,
} from './oidc';
import { safeReturnTo } from './return-to';
import { SESSION_COOKIE } from './session';

export const FLOW_COOKIE = 'bridge_oidc_flow';
/** Flow lifetime: sign-in must complete within 10 minutes of starting. */
export const FLOW_COOKIE_MAX_AGE = 600;

export interface CookieDirective {
  name: string;
  value: string;
  /** Lifetime in seconds; omitted for clear directives. */
  maxAge?: number;
  /** Clear directive: Max-Age=0 + empty value. */
  clear?: boolean;
  /** Defaults: set → httpOnly; clear keeps attributes so the browser drops it. */
  httpOnly?: boolean;
  secure?: boolean;
}

export interface FlowResult {
  status: number;
  /** App-relative or absolute redirect target. */
  redirect?: string;
  cookies: CookieDirective[];
  /** One-line server-log hint for operators debugging a failed sign-in. */
  log?: string;
}

export interface FlowContext {
  auth: EnforcedAuthConfig;
  /** Request origin, used to derive the callback URL when OIDC_REDIRECT_URI is unset. */
  origin: string;
  fetchImpl?: typeof fetch;
  /** Injectable clock (epoch ms) for deterministic tests. */
  nowMs?: number;
}

function secureFor(origin: string): boolean {
  try {
    return new URL(origin).protocol === 'https:';
  } catch {
    return true;
  }
}

function callbackUri(ctx: FlowContext): string {
  return ctx.auth.redirectUri ?? `${ctx.origin}/api/auth/callback`;
}

interface FlowState {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
}

function encodeFlowState(s: FlowState): string {
  return encodeURIComponent(JSON.stringify(s));
}

function decodeFlowState(raw: string | undefined): FlowState | null {
  if (!raw) return null;
  const attempt = (text: string): FlowState | null => {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null) return null;
      const s = parsed as Record<string, unknown>;
      if (
        typeof s.state !== 'string' ||
        typeof s.nonce !== 'string' ||
        typeof s.verifier !== 'string' ||
        typeof s.returnTo !== 'string'
      ) {
        return null;
      }
      return { state: s.state, nonce: s.nonce, verifier: s.verifier, returnTo: safeReturnTo(s.returnTo) };
    } catch {
      return null;
    }
  };
  // Cookie jars differ: Next's cookie parser URI-decodes values, some test
  // stubs pass the encoded form straight through — try both.
  return attempt(raw) ?? attempt(decodeURIComponent(raw));
}

function flowCookie(value: string, secure: boolean, maxAge?: number): CookieDirective {
  return { name: FLOW_COOKIE, value, secure, ...(maxAge !== undefined ? { maxAge } : { clear: true }) };
}

function errorRedirect(error: string, log?: string): FlowResult {
  return { status: 302, redirect: `/login?error=${encodeURIComponent(error)}`, cookies: [], log };
}

/** GET /api/auth/login — starts the authorization-code + PKCE round-trip. */
export async function startLoginFlow(ctx: FlowContext, rawReturnTo: string | undefined): Promise<FlowResult> {
  const returnTo = safeReturnTo(rawReturnTo);
  const secure = secureFor(ctx.origin);

  let discovery;
  try {
    discovery = await discoverOidc(ctx.auth.issuer, ctx.fetchImpl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 302,
      redirect: '/login?error=provider_unavailable',
      cookies: [],
      log: `[auth] discovery failed for ${ctx.auth.issuer}: ${message}`,
    };
  }

  const pkce = await createPkcePair();
  const state = randomToken();
  const nonce = randomToken();

  const authorizeUrl = buildAuthorizeUrl(discovery, {
    clientId: ctx.auth.clientId,
    redirectUri: callbackUri(ctx),
    state,
    nonce,
    challenge: pkce.challenge,
  });

  return {
    status: 302,
    redirect: authorizeUrl,
    cookies: [flowCookie(encodeFlowState({ state, nonce, verifier: pkce.verifier, returnTo }), secure, FLOW_COOKIE_MAX_AGE)],
  };
}

/** GET /api/auth/callback — completes the round-trip and issues the session. */
export async function handleCallbackFlow(
  ctx: FlowContext,
  input: {
    url: URL;
    /** Cookie jar accessor for the flow cookie. */
    getCookie: (name: string) => string | undefined;
  },
): Promise<FlowResult> {
  const nowSeconds = Math.floor((ctx.nowMs ?? Date.now()) / 1000);
  const secure = secureFor(ctx.origin);

  const providerError = input.url.searchParams.get('error');
  if (providerError) {
    const detail = input.url.searchParams.get('error_description') ?? '';
    return {
      ...errorRedirect('provider_error'),
      log: `[auth] provider returned error at callback: ${providerError}${detail ? ` (${detail})` : ''}`,
    };
  }

  const flow = decodeFlowState(input.getCookie(FLOW_COOKIE));
  const returnedState = input.url.searchParams.get('state');
  if (!flow || !returnedState || returnedState !== flow.state) {
    return errorRedirect(
      'state_mismatch',
      `[auth] callback state mismatch (flow cookie ${flow ? 'present' : 'missing'}, state param ${returnedState ? 'present' : 'missing'})`,
    );
  }

  const code = input.url.searchParams.get('code');
  if (!code) {
    return errorRedirect('state_mismatch', '[auth] callback carried no code parameter');
  }

  try {
    const discovery = await discoverOidc(ctx.auth.issuer, ctx.fetchImpl);
    const { idToken } = await exchangeAuthorizationCode(
      discovery,
      {
        code,
        verifier: flow.verifier,
        clientId: ctx.auth.clientId,
        clientSecret: ctx.auth.clientSecret,
        redirectUri: callbackUri(ctx),
      },
      ctx.fetchImpl,
    );
    const claims = validateIdToken(idToken, {
      issuer: discovery.issuer,
      clientId: ctx.auth.clientId,
      nonce: flow.nonce,
      nowSeconds,
    });

    const session = await import('./session');
    const token = await session.signSession(
      {
        sub: claims.sub,
        ...(claims.name !== undefined ? { name: claims.name } : {}),
        ...(claims.email !== undefined ? { email: claims.email } : {}),
      },
      ctx.auth.sessionSecret,
      nowSeconds,
      ctx.auth.sessionTtlSeconds,
    );

    return {
      status: 302,
      redirect: flow.returnTo,
      cookies: [
        { name: SESSION_COOKIE, value: token, maxAge: ctx.auth.sessionTtlSeconds, secure },
        flowCookie('', secure),
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof OidcError && err.code.startsWith('id_token_')) {
      return errorRedirect('id_token_invalid', `[auth] ID token rejected: ${message}`);
    }
    if (err instanceof OidcError && err.code === 'provider_unavailable') {
      return errorRedirect('provider_unavailable', `[auth] callback failed: ${message}`);
    }
    return errorRedirect('provider_error', `[auth] callback failed: ${message}`);
  }
}

/** Set-Cookie directives for clearing the session (GET /logout). */
export function logoutCookies(secure: boolean): CookieDirective[] {
  return [flowCookie('', secure), { name: SESSION_COOKIE, value: '', clear: true, secure }];
}
