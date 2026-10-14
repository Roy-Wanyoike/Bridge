/**
 * Authentication configuration resolution (issue #163).
 *
 * The console has exactly one authentication posture per process, derived
 * from the environment. The modes are deliberately explicit — the gate must
 * fail closed in production the same way live registry mode does (a
 * forgotten variable must yield an actionable error, never an authless
 * deployment):
 *
 * - `enforced`      — full OIDC gate; every console route needs a session.
 * - `disabled`      — `AUTH_DISABLED=true|1` explicitly turns the gate off.
 *                     Public demo deployments use this; a loud warning is
 *                     logged so the state is never silent.
 * - `unconfigured`  — production build without OIDC config: fail closed,
 *                     every route answers with an actionable 503 page.
 * - `dev-open`      — `next dev` without config stays usable for local
 *                     development (demo data, localhost bind). Mirrors the
 *                     registry-client precedent ("demo in dev, live in
 *                     production") and is logged loudly.
 *
 * Required variables for enforcement: `OIDC_ISSUER`, `OIDC_CLIENT_ID`,
 * `OIDC_CLIENT_SECRET`, `SESSION_SECRET`. `OIDC_REDIRECT_URI` is optional —
 * when absent the callback is derived from the incoming request origin
 * (`<origin>/api/auth/callback`), which is correct for single-origin
 * deployments behind Vercel or a TLS-terminating reverse proxy.
 */

export interface EnforcedAuthConfig {
  mode: 'enforced';
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** HMAC secret for the signed session cookie (never leaves the server). */
  sessionSecret: string;
  /** Session lifetime in seconds. Default 8h; clamped to [5m, 7d]. */
  sessionTtlSeconds: number;
  /** Optional fixed callback URL; derived from the request origin when absent. */
  redirectUri?: string;
}

export type AuthConfig =
  | EnforcedAuthConfig
  | { mode: 'disabled' }
  | { mode: 'unconfigured'; missing: string[] }
  | { mode: 'dev-open'; missing: string[] };

const SESSION_TTL_DEFAULT = 8 * 60 * 60;
const SESSION_TTL_MIN = 5 * 60;
const SESSION_TTL_MAX = 7 * 24 * 60 * 60;

/** Human-readable names for the required variables (used in error pages). */
export const REQUIRED_AUTH_VARS = [
  { name: 'OIDC_ISSUER', what: 'OIDC provider issuer URL, e.g. https://id.example.com' },
  { name: 'OIDC_CLIENT_ID', what: 'client id registered with the provider' },
  { name: 'OIDC_CLIENT_SECRET', what: 'client secret registered with the provider' },
  { name: 'SESSION_SECRET', what: 'random 32+ byte secret signing the session cookie (openssl rand -hex 32)' },
] as const;

function parseSessionTtl(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return SESSION_TTL_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return SESSION_TTL_DEFAULT;
  return Math.min(Math.max(Math.trunc(n), SESSION_TTL_MIN), SESSION_TTL_MAX);
}

function issuerLooksValid(issuer: string): boolean {
  try {
    const u = new URL(issuer);
    return (u.protocol === 'https:' || u.hostname === 'localhost' || u.hostname === '127.0.0.1') && issuer.endsWith('/');
  } catch {
    return false;
  }
}

export type EnvLike = Record<string, string | undefined>;

/**
 * Default env snapshot using *literal* member expressions on `process.env`.
 *
 * Next.js inlines `process.env.<NAME>` references at build time when the
 * name is defined in `next.config.ts`'s `env` map — that is how the
 * vercel.json demo pin (`AUTH_DISABLED=true` in the buildCommand) reaches
 * the proxy at runtime, where vercel.json-provided env otherwise does not
 * exist. Dynamic access (`env.AUTH_DISABLED` off a whole-object default)
 * would defeat that inlining, so the literals live here.
 */
function defaultAuthEnv(): EnvLike {
  return {
    NODE_ENV: process.env.NODE_ENV,
    AUTH_DISABLED: process.env.AUTH_DISABLED,
    OIDC_ISSUER: process.env.OIDC_ISSUER,
    OIDC_CLIENT_ID: process.env.OIDC_CLIENT_ID,
    OIDC_CLIENT_SECRET: process.env.OIDC_CLIENT_SECRET,
    OIDC_REDIRECT_URI: process.env.OIDC_REDIRECT_URI,
    SESSION_SECRET: process.env.SESSION_SECRET,
    SESSION_TTL_SECONDS: process.env.SESSION_TTL_SECONDS,
  };
}

/**
 * Resolves the auth posture from an env map (default: literal snapshot of
 * `process.env`, so tests can pass a plain object). No caching: env is
 * static per process and this keeps the function trivially testable.
 */
export function resolveAuthConfig(env: EnvLike = defaultAuthEnv()): AuthConfig {
  if (env.AUTH_DISABLED === 'true' || env.AUTH_DISABLED === '1') {
    return { mode: 'disabled' };
  }

  const missing: string[] = [];
  const issuer = env.OIDC_ISSUER ?? '';
  if (!issuer) missing.push('OIDC_ISSUER');
  const clientId = env.OIDC_CLIENT_ID ?? '';
  if (!clientId) missing.push('OIDC_CLIENT_ID');
  const clientSecret = env.OIDC_CLIENT_SECRET ?? '';
  if (!clientSecret) missing.push('OIDC_CLIENT_SECRET');
  const sessionSecret = env.SESSION_SECRET ?? '';
  if (!sessionSecret) missing.push('SESSION_SECRET');

  if (missing.length > 0) {
    return env.NODE_ENV === 'production'
      ? { mode: 'unconfigured', missing }
      : { mode: 'dev-open', missing };
  }

  // Normalize the issuer to have a trailing slash: discovery URLs are
  // issuer + '/.well-known/openid-configuration' and the provider's
  // discovery document echoes the issuer back — a trailing-slash mismatch
  // is the single most common OIDC misconfiguration.
  const normalizedIssuer = issuer.endsWith('/') ? issuer : `${issuer}/`;

  return {
    mode: 'enforced',
    issuer: normalizedIssuer,
    clientId,
    clientSecret,
    sessionSecret,
    sessionTtlSeconds: parseSessionTtl(env.SESSION_TTL_SECONDS),
    redirectUri: env.OIDC_REDIRECT_URI || undefined,
  };
}

/** True when the config is malformed in a way that would break the flow. */
export function authConfigProblems(config: AuthConfig): string[] {
  if (config.mode !== 'enforced') return [];
  const problems: string[] = [];
  if (!issuerLooksValid(config.issuer)) {
    problems.push(`OIDC_ISSUER must be an https URL ending with "/" (got ${JSON.stringify(config.issuer)}; use http only for a localhost issuer)`);
  }
  if (config.clientSecret.length < 8) {
    problems.push('OIDC_CLIENT_SECRET looks too short to be a real client secret');
  }
  if (config.sessionSecret.length < 32) {
    problems.push('SESSION_SECRET must be at least 32 characters (openssl rand -hex 32)');
  }
  if (config.redirectUri) {
    try {
      const u = new URL(config.redirectUri);
      if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
        problems.push('OIDC_REDIRECT_URI must be an https URL (http only for localhost)');
      }
      if (!u.pathname.endsWith('/api/auth/callback')) {
        problems.push('OIDC_REDIRECT_URI path must end with /api/auth/callback');
      }
    } catch {
      problems.push('OIDC_REDIRECT_URI is not a valid URL');
    }
  }
  return problems;
}
