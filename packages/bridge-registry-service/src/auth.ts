/**
 * Authentication: static bearer tokens and OIDC JWTs.
 *
 * Two mechanisms, configurable together (static table consulted first, then
 * JWT verification):
 *
 * - **Static tokens** — a `TokenTable` of raw bearer tokens. This is the
 *   test/dev injection point: no cryptography, roles map 1:1 to scope
 *   levels. Not a production mechanism.
 * - **OIDC** — RS256/ES256 JWTs verified against a JWKS (fetched from the
 *   issuer and cached per `kid`, or injected statically for tests).
 *   Issuer, audience, expiry (`exp`, with leeway), `nbf`/`iat` sanity and
 *   scope claims are all enforced; any failure is 401 (fail closed). A
 *   valid token without an `org` claim is rejected with 403 on every /v1
 *   route — org binding is how tenancy is decided.
 *
 * Scopes: `registry:read` (1) < `registry:publish` (2) < `registry:admin` (3).
 */

import { createPublicKey, verify as cryptoVerify, type JsonWebKey, type KeyObject } from 'node:crypto';
import { ServiceError } from './errors';
import { isValidOrgOrProject } from './validation';
import {
  SCOPES,
  type AccessLevel,
  type AuthConfig,
  type Jwk,
  type JwksDocument,
  type OidcConfig,
  type Principal,
  type RegistryRole,
  type RegistryTokenInfo,
  type TokenTable,
} from './types';

/** Numeric rank of static-token roles; compare against AccessLevel. */
export const ROLE_RANK: Record<RegistryRole, AccessLevel> = { read: 1, write: 2, admin: 3 };

/** Required access levels for endpoint families. */
export const Levels = {
  /** Any authenticated principal. */
  read: 1 as AccessLevel,
  /** Publish contracts. */
  publish: 2 as AccessLevel,
  /** Read/query the audit log. */
  admin: 3 as AccessLevel,
} as const;

const ALL_ROLES: readonly string[] = ['read', 'write', 'admin'];

/**
 * Minimum accepted static-token length in characters (issue #120 item 7).
 *
 * The constant-time note in {@link authenticateStaticToken} leans on tokens
 * carrying ≥128 bits of entropy — 32 characters is the documented floor
 * (32 hex chars = 128 bits; longer base64/base62 secrets exceed it). Enforced
 * at startup by {@link assertTokenEntropy}; never per request.
 */
export const TOKEN_MIN_LENGTH = 32;

/** Options for {@link assertTokenEntropy}. Kept local to this module. */
export interface TokenEntropyOptions {
  /**
   * `true` (production profile): a short token is a hard `TypeError` that
   * aborts startup. `false`/`undefined` (default profile): a loud
   * `console.warn` on stderr and the service still boots (dev/test convenience).
   */
  production?: boolean;
}

/**
 * Enforce the documented static-token entropy floor (issue #120 item 7):
 * every static token shorter than {@link TOKEN_MIN_LENGTH} characters is
 * refused at startup — hard error under the production profile, loud stderr
 * warning otherwise.
 *
 * The message identifies the offending entry by its positional index and the
 * OWNER (tenant) only. The raw token material is NEVER echoed — not in the
 * error, not in the warning.
 *
 * Called from the CLI options builder (`buildOptions` in
 * `bin/bridge-registry-service.ts`) with the profile flag. Library consumers
 * that build `RegistryServiceOptions` by hand should call it themselves
 * before serving traffic.
 */
export function assertTokenEntropy(tokens: TokenTable, opts: TokenEntropyOptions = {}): void {
  let index = 0;
  for (const [token, info] of Object.entries(tokens)) {
    const owner =
      typeof info === 'object' && info !== null && typeof (info as RegistryTokenInfo).tenant === 'string'
        ? (info as RegistryTokenInfo).tenant
        : 'unknown owner';
    if (token.length < TOKEN_MIN_LENGTH) {
      const where = `static token #${index + 1} (owner '${owner}')`;
      if (opts.production === true) {
        throw new TypeError(
          `auth: ${where} is ${token.length} character(s), below the documented minimum of ` +
            `${TOKEN_MIN_LENGTH} characters (~128 bits of entropy). Generate secrets with ` +
            `'openssl rand -hex 32' (or 24+ base64url characters). Refusing to start in the production profile.`,
        );
      }
      console.warn(
        `[bridge-registry-service] WARNING: ${where} is only ${token.length} character(s), below the ` +
          `${TOKEN_MIN_LENGTH}-character (~128-bit) minimum. Such tokens are guessable at the auth rate ` +
          'limit (120 capacity @ 30/s per IP). Rotate it before exposing this service.',
      );
    }
    index += 1;
  }
}

/** Max accepted `Authorization` header length (bound parsing work). */
const MAX_AUTH_HEADER = 16 * 1024;
/** Default JWT time-claim leeway in seconds. */
const DEFAULT_LEEWAY_SEC = 60;
/** Default JWKS cache TTL in ms. */
const DEFAULT_CACHE_TTL_MS = 600_000;
/** Negative-cache TTL for unknown `kid`s (issue #48). */
const KID_MISS_TTL_MS = 60_000;
/** Upper bound on simultaneously negatively-cached kids (kid-spray defense). */
const MAX_KID_MISSES = 10_000;
/** Minimum interval between forced JWKS refreshes (unique-kid flood defense). */
const MIN_FORCED_REFRESH_INTERVAL_MS = 1_000;
/** Minimum RSA modulus size we accept: 2048 bits = 256 bytes. */
const MIN_RSA_MODULUS_BYTES = 256;

/** Exact failure message used to recognize an unknown-kid verification result. */
const UNKNOWN_KEY_MESSAGE = 'token signed by an unknown key (kid not in JWKS)';

function unauthenticated(message: string): ServiceError {
  return new ServiceError(401, 'unauthenticated', message);
}

/** Distinct failure used to trigger a one-shot JWKS refresh on unknown kids. */
function unknownKey(): ServiceError {
  return new ServiceError(401, 'unauthenticated', UNKNOWN_KEY_MESSAGE);
}

// ---------------------------------------------------------- static tokens

/**
 * Validate a token table eagerly (at `createServer` time): every entry must
 * carry a non-empty string `tenant` and a known `role`. Malformed tables are
 * programming errors → `TypeError`.
 *
 * Shape only: the entropy floor is a separate, profile-aware startup check
 * ({@link assertTokenEntropy}) so dev/test tables with short tokens keep
 * working here.
 */
export function assertTokenTable(tokens: TokenTable): TokenTable {
  for (const [token, info] of Object.entries(tokens)) {
    if (typeof token !== 'string' || token.length === 0) {
      throw new TypeError('tokens: token strings must be non-empty');
    }
    if (
      typeof info !== 'object' ||
      info === null ||
      typeof (info as RegistryTokenInfo).tenant !== 'string' ||
      (info as RegistryTokenInfo).tenant.length === 0 ||
      !ALL_ROLES.includes((info as RegistryTokenInfo).role)
    ) {
      throw new TypeError(
        `tokens[${JSON.stringify(token)}]: expected { tenant: string, role: 'read'|'write'|'admin' }`,
      );
    }
  }
  return tokens;
}

/**
 * Parse the `Authorization` header into its bearer token.
 * Throws 401 when the header is missing, malformed or oversized.
 */
export function extractBearerToken(authorization: string | undefined): string {
  if (typeof authorization !== 'string' || authorization.length > MAX_AUTH_HEADER) {
    throw unauthenticated('missing or invalid bearer token');
  }
  const space = authorization.indexOf(' ');
  if (space <= 0) throw unauthenticated('missing or invalid bearer token');
  const scheme = authorization.slice(0, space).toLowerCase();
  if (scheme !== 'bearer') throw unauthenticated('missing or invalid bearer token');
  const token = authorization.slice(space + 1).trim();
  if (token.length === 0) throw unauthenticated('missing or invalid bearer token');
  return token;
}

/** Static-token lookup → {@link Principal}. Throws 401 when unknown. */
export function authenticateStaticToken(tokens: TokenTable, authorization: string | undefined): Principal {
  const token = extractBearerToken(authorization);
  // Own-property lookup only (issue #48): `tokens[token]` walks the
  // prototype chain, so a bearer token spelled `constructor`/`toString`
  // resolved to an inherited value and produced a principal with an
  // undefined org (it failed closed downstream, but only after noise).
  //
  // Constant-time note: a keyed map lookup is not constant-time. That is
  // acceptable here because bearer tokens must be high-entropy secrets
  // (≥128 bits) — a startup floor (TOKEN_MIN_LENGTH / assertTokenEntropy,
  // issue #120) keeps degenerate secrets out of real deployments — so
  // timing signals on the table index are then impractical to exploit. A
  // truly constant-time comparison over a token TABLE would require HMAC-ing
  // every candidate key; use the OIDC mechanism for production fleets.
  if (!Object.prototype.hasOwnProperty.call(tokens, token)) {
    throw unauthenticated('missing or invalid bearer token');
  }
  const info = tokens[token];
  if (info === undefined || info === null) throw unauthenticated('missing or invalid bearer token');
  return {
    kind: 'token',
    subject: `token:${info.tenant}`,
    org: info.tenant,
    level: ROLE_RANK[info.role],
    scopes: [`role:${info.role}`],
  };
}

/**
 * Require a minimum access level; throws 403 `forbidden` when the
 * principal's level ranks below it.
 */
export function requireLevel(principal: Principal, needed: AccessLevel): void {
  if (principal.level < needed) {
    throw new ServiceError(
      403,
      'forbidden',
      `credentials '${principal.scopes.join(', ')}' are not permitted for this operation ` +
        `(requires ${needed === Levels.read ? SCOPES.read : needed === Levels.publish ? SCOPES.publish : SCOPES.admin})`,
    );
  }
}

// ------------------------------------------------------------------- JWKs

function b64urlToBuffer(value: string, at: string): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError(`${at}: not a base64url string`);
  }
  return Buffer.from(value, 'base64url');
}

/** Validate one JWK for verification use and import it as a `KeyObject`. */
export function jwkToPublicKey(jwk: Jwk, at: string): KeyObject {
  if (jwk['use'] !== undefined && jwk['use'] !== 'sig') {
    throw new TypeError(`${at}: JWK use must be 'sig'`);
  }
  const ops = jwk['key_ops'];
  if (Array.isArray(ops) && !ops.includes('verify')) {
    throw new TypeError(`${at}: JWK key_ops does not include 'verify'`);
  }
  const expectedAlg = jwk['kty'] === 'RSA' ? 'RS256' : jwk['kty'] === 'EC' ? 'ES256' : undefined;
  if (jwk['alg'] !== undefined && jwk['alg'] !== expectedAlg) {
    throw new TypeError(`${at}: JWK alg ${JSON.stringify(jwk['alg'])} is not supported`);
  }
  if (typeof jwk['kid'] !== 'string' || jwk['kid'].length === 0 || jwk['kid'].length > 256) {
    throw new TypeError(`${at}: JWK kid must be a non-empty string (max 256 chars)`);
  }
  try {
    if (jwk['kty'] === 'RSA') {
      const n = b64urlToBuffer(jwk['n'] as string, `${at}.n`);
      if (n.length < MIN_RSA_MODULUS_BYTES) {
        throw new TypeError(`${at}: RSA modulus smaller than 2048 bits`);
      }
      b64urlToBuffer(jwk['e'] as string, `${at}.e`);
      return createPublicKey({ key: jwk as unknown as JsonWebKey, format: 'jwk' });
    }
    if (jwk['kty'] === 'EC') {
      if (jwk['crv'] !== 'P-256') throw new TypeError(`${at}: EC crv must be P-256 (ES256)`);
      if (b64urlToBuffer(jwk['x'] as string, `${at}.x`).length !== 32) {
        throw new TypeError(`${at}: EC x coordinate must be 32 bytes`);
      }
      if (b64urlToBuffer(jwk['y'] as string, `${at}.y`).length !== 32) {
        throw new TypeError(`${at}: EC y coordinate must be 32 bytes`);
      }
      return createPublicKey({ key: jwk as unknown as JsonWebKey, format: 'jwk' });
    }
  } catch (err) {
    if (err instanceof TypeError) throw err;
    throw new TypeError(`${at}: invalid JWK: ${(err as Error).message}`);
  }
  throw new TypeError(`${at}: JWK kty must be 'RSA' (RS256) or 'EC' (ES256, P-256)`);
}

/** Validate a JWKS document shape and import every usable key. */
export function parseJwks(doc: JwksDocument): Map<string, KeyObject> {
  if (typeof doc !== 'object' || doc === null || !Array.isArray((doc as JwksDocument).keys)) {
    throw new TypeError('JWKS document must be an object with a "keys" array');
  }
  const out = new Map<string, KeyObject>();
  const keys = (doc as { keys?: unknown }).keys as unknown;
  const list = Array.isArray(keys) ? keys : [];
  for (let i = 0; i < list.length; i++) {
    const jwk = list[i] as Jwk;
    if (typeof jwk !== 'object' || jwk === null) continue;
    try {
      const key = jwkToPublicKey(jwk, `keys[${i}]`);
      out.set(jwk['kid'] as string, key);
    } catch {
      // Unusable keys are skipped (e.g. different alg); JWKS is a set.
    }
  }
  return out;
}

// --------------------------------------------------------------- JWT core

interface JwtHeader {
  alg: string;
  kid?: string;
}

interface JwtClaims {
  iss?: unknown;
  sub?: unknown;
  aud?: unknown;
  exp?: unknown;
  nbf?: unknown;
  iat?: unknown;
  jti?: unknown;
  scope?: unknown;
  scp?: unknown;
  org?: unknown;
}

function decodeSegment(segment: string, at: string): Record<string, unknown> {
  if (segment.length === 0 || segment.length > 64 * 1024 || !/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw unauthenticated(`malformed token: ${at}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw unauthenticated(`malformed token: ${at} is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw unauthenticated(`malformed token: ${at} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** Verify one signature (`RS256` or `ES256`); returns false on any mismatch. */
export function verifyJwtSignature(
  signingInput: string,
  signature: Buffer,
  header: JwtHeader,
  key: KeyObject,
): boolean {
  if (header.alg === 'RS256') {
    if (key.asymmetricKeyType !== 'rsa') return false;
    return cryptoVerify('sha256', Buffer.from(signingInput, 'ascii'), key, signature);
  }
  if (header.alg === 'ES256') {
    if (key.asymmetricKeyType !== 'ec') return false;
    if (signature.length !== 64) return false; // JWS raw r||s
    return cryptoVerify('sha256', Buffer.from(signingInput, 'ascii'), { key, dsaEncoding: 'ieee-p1363' }, signature);
  }
  return false;
}

/**
 * Verify the signature and standard claims of a compact JWT and return the
 * decoded payload. Throws 401 on every failure (fail closed).
 */
export function verifyJwt(token: string, cfg: OidcConfig, keys: Map<string, KeyObject>): JwtClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw unauthenticated('malformed token: expected a compact JWT');
  const [h, p, s] = parts as [string, string, string];
  const header = decodeSegment(h, 'header');
  const payload = decodeSegment(p, 'payload');

  const alg = header['alg'];
  if (alg !== 'RS256' && alg !== 'ES256') {
    throw unauthenticated(`token alg ${JSON.stringify(alg)} is not allowed (RS256/ES256 only)`);
  }
  const kid = header['kid'];
  if (typeof kid !== 'string' || kid.length === 0 || kid.length > 256) {
    throw unauthenticated('malformed token: header.kid must be a non-empty string');
  }
  const key = keys.get(kid);
  if (key === undefined) throw unknownKey();
  let signature: Buffer;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error('charset');
    signature = Buffer.from(s, 'base64url');
  } catch {
    throw unauthenticated('malformed token: signature is not base64url');
  }
  const signingInput = `${h}.${p}`;
  if (!verifyJwtSignature(signingInput, signature, { alg, kid }, key)) {
    throw unauthenticated('token signature verification failed');
  }

  const now = (cfg.now ?? (() => Date.now()))() / 1000;
  const leeway = cfg.leewaySec ?? DEFAULT_LEEWAY_SEC;

  const exp = payload['exp'];
  if (typeof exp !== 'number' || !Number.isFinite(exp)) {
    throw unauthenticated('token rejected: exp claim is required');
  }
  if (now > exp + leeway) throw unauthenticated('token expired');

  const nbf = payload['nbf'];
  if (nbf !== undefined && (typeof nbf !== 'number' || !Number.isFinite(nbf) || now < nbf - leeway)) {
    throw unauthenticated('token not yet valid (nbf)');
  }
  const iat = payload['iat'];
  if (iat !== undefined && (typeof iat !== 'number' || !Number.isFinite(iat) || now < iat - leeway)) {
    throw unauthenticated('token issued in the future (iat)');
  }

  if (payload['iss'] !== cfg.issuer) throw unauthenticated('token issuer (iss) mismatch');
  const aud = payload['aud'];
  const audOk =
    typeof aud === 'string'
      ? aud === cfg.audience
      : Array.isArray(aud) && aud.some((a) => a === cfg.audience);
  if (!audOk) throw unauthenticated('token audience (aud) mismatch');

  const sub = payload['sub'];
  if (typeof sub !== 'string' || sub.length === 0 || sub.length > 256) {
    throw unauthenticated('token rejected: sub claim is required');
  }
  return payload as JwtClaims;
}

/** Map `scope`/`scp` claims to the highest held access level. */
export function scopesToLevel(scopes: readonly string[]): AccessLevel {
  let level: AccessLevel = 1;
  if (scopes.includes(SCOPES.admin)) level = 3;
  else if (scopes.includes(SCOPES.publish)) level = 2;
  return level;
}

function parseScopeClaim(payload: JwtClaims): string[] {
  const scp = payload['scp'];
  if (Array.isArray(scp)) {
    return scp.filter((s): s is string => typeof s === 'string');
  }
  const scope = typeof payload['scope'] === 'string' ? payload['scope'] : '';
  return scope.split(/\s+/).filter((s) => s.length > 0);
}

// ---------------------------------------------------------- authenticator

export interface RequestAuthenticator {
  authenticate(authorization: string | undefined): Promise<Principal>;
}

/** OIDC authenticator: verifies JWTs against a cached JWKS. */
export class OidcAuthenticator implements RequestAuthenticator {
  private readonly cfg: OidcConfig;
  private readonly fetchJwks: (url: string) => Promise<JwksDocument>;
  private readonly ttlMs: number;
  private cache: Map<string, KeyObject> = new Map();
  private fetchedAt = -Infinity;
  /** kid → miss expiry (ms, injectable clock). Negative cache (issue #48). */
  private readonly kidMisses = new Map<string, number>();
  /** In-flight forced refresh — concurrent misses share one fetch. */
  private refreshing: Promise<Map<string, KeyObject>> | null = null;
  /** Clock of the last forced refresh (throttles unique-kid floods). */
  private lastForcedRefreshAt = -Infinity;

  constructor(cfg: OidcConfig) {
    if (typeof cfg.issuer !== 'string' || cfg.issuer.length === 0) {
      throw new TypeError('OidcAuthenticator: issuer is required');
    }
    if (typeof cfg.audience !== 'string' || cfg.audience.length === 0) {
      throw new TypeError('OidcAuthenticator: audience is required');
    }
    this.cfg = cfg;
    this.fetchJwks = cfg.fetchJwks ?? defaultFetchJwks;
    this.ttlMs = cfg.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    if (cfg.jwks !== undefined) {
      this.cache = parseJwks(cfg.jwks);
      this.fetchedAt = this.now();
    }
  }

  private now(): number {
    return (this.cfg.now ?? (() => Date.now()))();
  }

  private jwksUrl(): string {
    return this.cfg.jwksUrl ?? `${this.cfg.issuer.replace(/\/$/, '')}/.well-known/jwks.json`;
  }

  private async loadKeys(force: boolean): Promise<Map<string, KeyObject>> {
    const stale = this.now() - this.fetchedAt > this.ttlMs;
    if (!force && this.cache.size > 0 && !stale) return this.cache;
    if (this.cfg.jwks !== undefined) return this.cache; // static injection: never re-fetch
    const doc = await this.fetchJwks(this.jwksUrl());
    const keys = parseJwks(doc);
    if (keys.size === 0) throw unauthenticated('token rejected: JWKS contains no usable keys');
    this.cache = keys;
    this.fetchedAt = this.now();
    return this.cache;
  }

  /** True while `kid` is negatively cached (recently confirmed missing). */
  private isKidNegative(kid: string): boolean {
    const expires = this.kidMisses.get(kid);
    if (expires === undefined) return false;
    if (expires <= this.now()) {
      this.kidMisses.delete(kid);
      return false;
    }
    return true;
  }

  /** Record a confirmed kid miss for {@link KID_MISS_TTL_MS}, bounded. */
  private markKidNegative(kid: string): void {
    if (this.kidMisses.size >= MAX_KID_MISSES) {
      const nowMs = this.now();
      for (const [k, exp] of this.kidMisses) {
        if (exp <= nowMs) this.kidMisses.delete(k);
      }
      while (this.kidMisses.size >= MAX_KID_MISSES) {
        const oldest = this.kidMisses.keys().next().value;
        if (oldest === undefined) break;
        this.kidMisses.delete(oldest);
      }
    }
    this.kidMisses.set(kid, this.now() + KID_MISS_TTL_MS);
  }

  /**
   * Single-flight forced refresh (key rotation must not wait out the TTL):
   * concurrent callers share one fetch, and refreshes are throttled to at
   * most one per {@link MIN_FORCED_REFRESH_INTERVAL_MS} so a spray of
   * unique garbage kids cannot turn the service into a per-request fetch
   * amplifier against the IdP (issue #48). When the throttle skips the
   * fetch the CURRENT cache is returned (stale-serve semantics) and
   * `fetched` is false, so the result cannot poison the negative cache.
   */
  private async refreshKeys(): Promise<{ keys: Map<string, KeyObject>; fetched: boolean }> {
    if (this.cfg.jwks !== undefined) return { keys: this.cache, fetched: false }; // static injection
    if (this.now() - this.lastForcedRefreshAt < MIN_FORCED_REFRESH_INTERVAL_MS) {
      return { keys: this.cache, fetched: false };
    }
    if (this.refreshing === null) {
      this.lastForcedRefreshAt = this.now();
      this.refreshing = this.loadKeys(true).finally(() => {
        this.refreshing = null;
      });
    }
    const keys = await this.refreshing;
    return { keys, fetched: true };
  }

  /** Verify the bearer JWT and produce a {@link Principal}. */
  public async authenticate(authorization: string | undefined): Promise<Principal> {
    const token = extractBearerToken(authorization);
    let keys = await this.loadKeys(false);
    let claims: JwtClaims;
    try {
      claims = verifyJwt(token, this.cfg, keys);
    } catch (err) {
      if (!isUnknownKeyError(err)) throw err;
      const kid = peekKid(token);
      // Negative cache (issue #48): a kid confirmed missing within the TTL
      // is answered immediately — never with a per-request fetch.
      if (kid !== null && this.isKidNegative(kid)) {
        throw unknownKey();
      }
      // Single-flight refresh, serving STALE keys when it fails so an IdP
      // outage degrades instead of amplifying.
      let refreshFetched = false;
      try {
        const refreshed = await this.refreshKeys();
        keys = refreshed.keys;
        refreshFetched = refreshed.fetched;
      } catch (refreshErr) {
        console.error(
          `[bridge-registry-service] JWKS refresh failed (${(refreshErr as Error).message}); serving ${this.cache.size} stale key(s)`,
        );
        if (this.cache.size === 0) {
          throw unauthenticated('token rejected: the authentication key set is temporarily unavailable');
        }
        keys = this.cache;
      }
      try {
        claims = verifyJwt(token, this.cfg, keys);
      } catch (secondErr) {
        // Only a refresh that actually Fetched may poison the negative
        // cache: a throttled skip or failed refresh proves nothing about
        // the kid's existence.
        if (refreshFetched && kid !== null && isUnknownKeyError(secondErr)) {
          this.markKidNegative(kid);
        }
        throw secondErr;
      }
    }

    const scopes = parseScopeClaim(claims);
    const level = scopesToLevel(scopes);
    const org = claims['org'];
    if (org === undefined && this.cfg.requireOrgClaim === false) {
      // Org-less tokens stay authenticated but are rejected by org-scoped routes.
    } else if (typeof org !== 'string' || org.length === 0) {
      throw new ServiceError(403, 'missing-org-claim', 'token is valid but carries no org claim');
    } else if (!isValidOrgOrProject(org)) {
      throw new ServiceError(403, 'forbidden', 'token org claim is malformed');
    }

    return {
      kind: 'oidc',
      subject: claims['sub'] as string,
      org: typeof org === 'string' ? org : '',
      level,
      scopes: scopes.length > 0 ? scopes : ['(none)'],
      tokenId: typeof claims['jti'] === 'string' ? claims['jti'] : undefined,
    };
  }
}

/**
 * Best-effort `kid` extraction from a compact JWT header (no verification,
 * no throw — used only to key the negative cache).
 */
function peekKid(token: string): string | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(token.slice(0, dot), 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const kid = (parsed as Record<string, unknown>)['kid'];
    return typeof kid === 'string' && kid.length > 0 && kid.length <= 256 ? kid : null;
  } catch {
    return null;
  }
}

function isUnknownKeyError(err: unknown): boolean {
  return err instanceof ServiceError && err.message === UNKNOWN_KEY_MESSAGE;
}

/** Default JWKS fetcher: `fetch` with a hard 10s timeout. */
async function defaultFetchJwks(url: string): Promise<JwksDocument> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
  } catch (err) {
    // Generic to clients (issue #48): the JWKS URL is server configuration
    // and must never be disclosed to unauthenticated callers. Real detail
    // goes to the log only.
    console.error(`[bridge-registry-service] JWKS fetch failed for ${url}: ${(err as Error).name}`);
    throw unauthenticated('token rejected: the authentication key set is temporarily unavailable');
  }
  if (!response.ok) {
    console.error(`[bridge-registry-service] JWKS endpoint responded ${response.status} for ${url}`);
    throw unauthenticated('token rejected: the authentication key set is temporarily unavailable');
  }
  try {
    return (await response.json()) as JwksDocument;
  } catch {
    console.error(`[bridge-registry-service] JWKS endpoint returned invalid JSON for ${url}`);
    throw unauthenticated('token rejected: the authentication key set returned invalid data');
  }
}

/**
 * Build the request authenticator from {@link AuthConfig}.
 *
 * Fails closed: with neither static tokens nor OIDC configured it throws
 * `TypeError` at construction time, so a service that would accept
 * anonymous requests can never be created.
 *
 * When both are configured, static tokens are consulted first (exact match),
 * and non-matching tokens fall through to JWT verification.
 */
export function createAuthenticator(auth: AuthConfig | undefined): RequestAuthenticator {
  const hasTokens = auth !== undefined && auth.tokens !== undefined && Object.keys(auth.tokens).length > 0;
  const hasOidc = auth !== undefined && auth.oidc !== undefined;
  if (!hasTokens && !hasOidc) {
    throw new TypeError(
      'auth: at least one mechanism is required (tokens or oidc) — the service refuses to start unauthenticated',
    );
  }
  if (hasTokens) assertTokenTable(auth!.tokens!);
  const oidc = hasOidc ? new OidcAuthenticator(auth!.oidc!) : undefined;
  const tokens = hasTokens ? auth!.tokens! : undefined;

  if (tokens !== undefined && oidc === undefined) {
    return { authenticate: (authorization) => Promise.resolve(authenticateStaticToken(tokens, authorization)) };
  }
  if (tokens === undefined && oidc !== undefined) {
    return oidc;
  }
  return {
    authenticate: async (authorization) => {
      try {
        return authenticateStaticToken(tokens!, authorization);
      } catch {
        return oidc!.authenticate(authorization);
      }
    },
  };
}
