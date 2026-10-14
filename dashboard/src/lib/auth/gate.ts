/**
 * The authentication gate decision matrix (issue #163).
 *
 * Pure function: no Next runtime, no cookies API, no fetch — the proxy in
 * `src/proxy.ts` adapts requests into this input shape and maps the
 * decision onto responses. Every cell of the redirect matrix in the issue's
 * acceptance criteria is decided here and unit-tested directly:
 *
 * | path                       | valid session | no/invalid session            |
 * |----------------------------|---------------|-------------------------------|
 * | console page               | next          | redirect /login (+returnTo)   |
 * | /login                     | redirect /    | next (renders sign-in card)   |
 * | /api/auth/*, /logout       | next          | next (the flow itself)        |
 * | /api/* (data)              | next          | 401 JSON                      |
 * | anything, auth disabled    | next          | next                          |
 * | anything, unconfigured prod| 503 page      | 503 page                      |
 *
 * "Present but invalid" (tampered/expired) additionally sets
 * `error=session_expired` so /login explains what happened instead of
 * silently showing a fresh sign-in form.
 */

import type { AuthConfig } from './config';
import { safeReturnTo } from './return-to';
import { SESSION_COOKIE } from './session';

export type GateDecision =
  | { type: 'next' }
  | { type: 'redirect'; location: string }
  | { type: 'not-authorized'; status: 401 | 503; message: string; missing?: string[] };

export interface GateInput {
  /** URL pathname, e.g. `/contracts`. */
  path: string;
  /** URL search string (`?a=b`) or empty. */
  search: string;
  /** Whether the session cookie is present at all (even if invalid). */
  sessionCookiePresent: boolean;
  /** Whether the session cookie verified successfully. */
  sessionValid: boolean;
  auth: AuthConfig;
}

export const LOGOUT_PATH = '/logout';
export const LOGIN_PATH = '/login';

function isAuthFlowPath(path: string): boolean {
  return path === LOGIN_PATH || path.startsWith('/api/auth/') || path === LOGOUT_PATH;
}

/** Builds `/login?error=…&returnTo=…`, keeping a valid same-origin returnTo. */
function loginRedirect(reason: 'session_expired' | null, pathWithSearch: string): GateDecision {
  const params = new URLSearchParams();
  if (reason) params.set('error', reason);
  params.set('returnTo', safeReturnTo(pathWithSearch));
  const qs = params.toString();
  return { type: 'redirect', location: qs ? `${LOGIN_PATH}?${qs}` : LOGIN_PATH };
}

export function decideGate(input: GateInput): GateDecision {
  const { path, search, sessionCookiePresent, sessionValid, auth } = input;
  const pathWithSearch = `${path}${search}`;

  if (auth.mode === 'disabled') return { type: 'next' };

  if (auth.mode === 'dev-open') {
    // Local development without OIDC config stays browsable (see config.ts);
    // the loud warning is logged by the proxy, not here (per-request noise).
    return { type: 'next' };
  }

  if (auth.mode === 'unconfigured') {
    // Fail closed — but the flow paths must stay reachable so /login can
    // render the actionable configuration error instead of a redirect loop.
    if (isAuthFlowPath(path)) return { type: 'next' };
    return {
      type: 'not-authorized',
      status: 503,
      message:
        'Authentication is required but not configured. The console runs with a server-side registry credential, so unauthenticated access is refused.',
      missing: auth.missing,
    };
  }

  // ---- enforced ----
  if (isAuthFlowPath(path)) {
    if (path === LOGIN_PATH && sessionValid) {
      return { type: 'redirect', location: '/' };
    }
    return { type: 'next' };
  }

  if (sessionValid) return { type: 'next' };

  if (path.startsWith('/api/')) {
    return {
      type: 'not-authorized',
      status: 401,
      message: `Unauthenticated: this API requires a valid ${SESSION_COOKIE} session cookie. Sign in at ${LOGIN_PATH}.`,
    };
  }

  return loginRedirect(sessionCookiePresent ? 'session_expired' : null, pathWithSearch);
}
