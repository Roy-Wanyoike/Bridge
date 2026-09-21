/**
 * Public types of the registry service.
 *
 * The service is a dependency-free `node:http` layer over a
 * {@link StorageDriver}: it adds org/project tenancy, OIDC (or static-token)
 * authentication, ed25519 artifact-signature verification, an append-only
 * audit log, rate limiting and stable JSON error envelopes.
 */

import type { IRPackage } from '@bridge/core';

// ------------------------------------------------------------------ tenancy

/**
 * An org/project namespace. Org identifiers are lowercase URL-safe slugs
 * (`/^[a-z0-9][a-z0-9-]{0,62}$/`); project identifiers follow the same rule.
 */
export type OrgId = string;
export type ProjectId = string;

// -------------------------------------------------------------- principals

/** Access level carried by a credential. Higher levels imply lower ones. */
export type AccessLevel = 1 | 2 | 3;

/** OAuth2/OIDC scopes understood by the service. */
export const SCOPES = {
  read: 'registry:read',
  publish: 'registry:publish',
  admin: 'registry:admin',
} as const;

/** Legacy role names accepted on static tokens (map 1:1 to scope levels). */
export type RegistryRole = 'read' | 'write' | 'admin';

/** Parsed credential attached to one static bearer token. */
export interface RegistryTokenInfo {
  /**
   * Org the token belongs to. Every org-scoped request made with this token
   * is confined to this org; publishing records it as the contract owner.
   */
  tenant: string;
  role: RegistryRole;
}

/** Static token table: raw bearer token → credentials. */
export type TokenTable = Readonly<Record<string, RegistryTokenInfo>>;

/**
 * The authenticated caller. Produced by static-token lookup or OIDC JWT
 * verification; consumed by authorization checks and the audit log.
 */
export interface Principal {
  /** `'token'` for static tokens, `'oidc'` for verified JWTs. */
  kind: 'token' | 'oidc';
  /** Stable identity: `sub` claim (OIDC) or `token:<tenant>` (static). */
  subject: string;
  /** Org binding — every org-scoped request must target this org. */
  org: string;
  /** Highest scope level held (1 read, 2 publish, 3 admin). */
  level: AccessLevel;
  /** Scopes/roles held, verbatim (e.g. `['registry:read']`). */
  scopes: string[];
  /** JWT id (`jti`) when present; undefined for static tokens. */
  tokenId?: string;
}

// --------------------------------------------------------------------- auth

/** RS256/ES256 JSON Web Key (subset of RFC 7517 needed for verification). */
export interface Jwk {
  kty?: unknown;
  kid?: unknown;
  alg?: unknown;
  use?: unknown;
  key_ops?: unknown;
  n?: unknown;
  e?: unknown;
  crv?: unknown;
  x?: unknown;
  y?: unknown;
}

/** A JWKS document (RFC 7517 §5). */
export interface JwksDocument {
  keys?: unknown;
}

/**
 * OIDC configuration. When set, `Authorization: Bearer <jwt>` tokens are
 * verified against the configured keys.
 *
 * Keys come from `jwks` (static injection — tests, air-gapped deployments)
 * or are fetched from `jwksUrl` (default `<issuer>/.well-known/jwks.json`)
 * and cached per `kid` for `cacheTtlMs`. An unknown `kid` triggers a
 * single-flight re-fetch (rate-limited); misses are negatively cached for a
 * short TTL so repeated garbage tokens never cause per-request fetches
 * (issue #48).
 */
export interface OidcConfig {
  /** Expected `iss` claim (exact string match). */
  issuer: string;
  /** Expected `aud` claim (string or list membership). */
  audience: string;
  /** Explicit JWKS URL. Defaults to `<issuer>/.well-known/jwks.json`. */
  jwksUrl?: string;
  /** Static JWKS document; when set no network fetch is performed. */
  jwks?: JwksDocument;
  /** Pluggable JWKS fetcher (tests); defaults to `globalThis.fetch`. */
  fetchJwks?: (url: string) => Promise<JwksDocument>;
  /** JWKS cache TTL in ms. Default 600000 (10 min). */
  cacheTtlMs?: number;
  /** Clock skew allowance for `exp`/`nbf`/`iat`, in seconds. Default 60. */
  leewaySec?: number;
  /**
   * Require an `org` claim binding the token to one org. Default `true`;
   * tokens without it are rejected with 403 on every /v1 route.
   */
  requireOrgClaim?: boolean;
  /** Injectable clock (ms since epoch) for tests. */
  now?: () => number;
}

export interface AuthConfig {
  /** Static bearer tokens (test/dev injection point). */
  tokens?: TokenTable;
  /** OIDC JWT verification. */
  oidc?: OidcConfig;
}

// ------------------------------------------------------------------ signing

/**
 * Artifact-signing configuration. Publish requests are signed with an
 * ed25519 key whose public half is configured here; the service verifies
 * the signature over the canonical JSON of the publish body before
 * persisting anything.
 */
export interface SigningConfig {
  /** key id → PEM (SPKI) or DER public key. ed25519 keys only. */
  keys: Record<string, string | Buffer>;
  /**
   * `'required'` (default when keys are configured): unsigned publishes are
   * rejected with 401. `'optional'`: unsigned publishes pass, invalid
   * signatures never do.
   */
  mode?: 'required' | 'optional';
}

// --------------------------------------------------------------- rate limit

/** Token-bucket parameters: `capacity` tokens, refilled at `refillPerSecond`. */
export interface RateLimitConfig {
  capacity: number;
  refillPerSecond: number;
}

export interface RateLimitOptions {
  /** Disable entirely (tests that don't exercise limits). */
  enabled?: boolean;
  /** Bucket guarding every rate-limited /v1 request, keyed by client IP. */
  auth?: RateLimitConfig;
  /** Additional bucket guarding publish, keyed by `<principal>|<ip>`. */
  publish?: RateLimitConfig;
  /** Injectable clock (ms) for tests. */
  now?: () => number;
}

// -------------------------------------------------------------------- audit

/**
 * One append-only audit record.
 *
 * `time` is an ISO-8601 UTC string; lexicographic comparison of the stored
 * form is chronologically correct, which is what time-range filters rely on.
 */
export interface AuditEntry {
  /** Storage-assigned sequence number, when the backend provides one. */
  id?: number;
  /** ISO-8601 UTC timestamp taken when the entry was appended. */
  time: string;
  /** Org under which the request was made, or `null` (pre-auth failures). */
  org: string | null;
  /** Project, or `null`. */
  project: string | null;
  /** Authenticated principal subject, or `null`. */
  actor: string | null;
  /** Attempted operation (e.g. `publish`, `pull`, `audit`, `auth`). */
  action: string;
  /** Contract base/name from the route, when it had one. */
  contract: string | null;
  /** Resolved version when known. */
  version: string | null;
  /** `true` when the response status was < 400. */
  ok: boolean;
  /** HTTP status served. */
  status: number;
  /** Client IP (socket address; no proxy header parsing). */
  ip: string | null;
  /** Small structured extras (e.g. error code). */
  details?: Record<string, unknown>;
}

/** Query filters for {@link AuditBackend.query}. All fields are optional ANDs. */
export interface AuditFilter {
  actor?: string;
  action?: string;
  contract?: string;
  org?: string;
  project?: string;
  /** ISO-8601 lower bound (inclusive): `entry.time >= from`. */
  from?: string;
  /** ISO-8601 upper bound (inclusive): `entry.time <= to`. */
  to?: string;
  /** Max entries returned (default 100, hard cap 10000). */
  limit?: number;
}

/**
 * Audit sink/storage. `append` must be loss-tolerant (the server logs and
 * continues when it throws); `query` returns entries newest → oldest.
 */
export interface AuditBackend {
  append(entry: AuditEntry): void | Promise<void>;
  query(filter: AuditFilter): Promise<AuditEntry[]>;
}

// ------------------------------------------------------------------ storage

/** Publish metadata supplied by the client (owner is service-controlled). */
export interface PublishMeta {
  description?: string;
  repository?: string;
  /**
   * Languages the published artifact was generated for (issue #104), e.g.
   * `['go', 'typescript']`. Normalized client-side/server-side: trimmed,
   * lowercased, deduped, bounded (16 entries, 32 chars each). Rendered by
   * the dashboard as language badges in live mode.
   */
  languages?: string[];
}

/**
 * Public metadata for one immutable published contract version. Extends the
 * `@bridge/registry` concepts with org/project coordinates and publisher.
 */
export interface ContractMeta extends PublishMeta {
  org: string;
  project: string;
  /** Full dotted package name as published, e.g. `payments.v1`. */
  packageName: string;
  /** Storage base (name minus version segment), e.g. `payments`. */
  base: string;
  /** Normalized version, e.g. `v1`. */
  version: string;
  /** SHA-256 (hex) of the canonical JSON of the IR — the content address. */
  hash: string;
  /** First 12 characters of `hash`. */
  shortHash: string;
  /** Imports recorded from `ir.imports`. */
  imports: string[];
  /** ISO-8601 UTC publish timestamp (always set by the service). */
  publishedAt: string;
  /** Principal that published this version. */
  publishedBy?: string;
  /** Generated languages recorded at publish time (issue #104). */
  languages?: string[];
}

export interface PublishInput {
  org: string;
  project: string;
  ir: IRPackage;
  meta: PublishMeta;
  /** Explicit version for names without a version-shaped final segment. */
  version?: string;
  /** ISO-8601 publish time; defaults to "now" at the driver. */
  publishTime?: string;
  /** Publishing principal subject. */
  publishedBy: string;
}

export interface PublishResult {
  /** `created` for a new version, `replayed` for an identical republish. */
  outcome: 'created' | 'replayed';
  meta: ContractMeta;
}

export interface StoredContract {
  ir: IRPackage;
  meta: ContractMeta;
}

/**
 * Storage abstraction behind the HTTP layer. Two implementations ship:
 * {@link InMemoryDriver} (default, unit-tested) and {@link PostgresDriver}
 * (SQL migrations in `migrations/`, integration-gated on `PG_DSN`).
 *
 * All coordinates (org, project, package names, versions) MUST be validated
 * before they reach a driver; drivers additionally re-validate defensively.
 * Hash integrity (`hashPackage`) is re-verified on every `pull`.
 */
export interface StorageDriver {
  readonly kind: 'memory' | 'postgres';
  /** Prepare the backing store (no-op for memory, migrations for Postgres). */
  init(): Promise<void>;
  /** Release resources. */
  close(): Promise<void>;
  publish(input: PublishInput): Promise<PublishResult>;
  /** Fetch + hash-verify one version. Throws `not-found` when unknown. */
  pull(org: string, project: string, contract: string, version: string): Promise<StoredContract>;
  inspect(org: string, project: string, contract: string, version: string): Promise<ContractMeta>;
  latest(org: string, project: string, contract: string): Promise<ContractMeta>;
  versions(org: string, project: string, contract: string): Promise<string[]>;
  /** Latest meta per contract base, sorted by (base, version). */
  list(org: string, project: string): Promise<ContractMeta[]>;
  /**
   * Case-insensitive substring search over name/base/owner/description.
   * `null` org means "all orgs the caller may see"; `null` project likewise.
   */
  search(org: string | null, project: string | null, query: string): Promise<ContractMeta[]>;
  /** Contracts in the same project importing the given package (by name or base). */
  dependents(org: string, project: string, contract: string): Promise<ContractMeta[]>;
  /**
   * Transitive dependency closure (BFS over stored imports), mirroring
   * `@bridge/registry` semantics: bare-base imports resolve to the latest
   * version in the same project; unpublished imports are reported, not
   * traversed; cycle-safe.
   */
  dependencies(org: string, project: string, contract: string, version?: string): Promise<string[]>;
  appendAudit(entry: AuditEntry): Promise<void>;
  /** Newest → oldest. */
  queryAudit(filter: AuditFilter): Promise<AuditEntry[]>;
}

// ------------------------------------------------------------------ service

export interface RegistryServiceOptions {
  /** Backing storage driver (required). */
  driver: StorageDriver;
  /**
   * Auth mechanisms. At least one of `tokens` or `oidc` MUST be configured;
   * `createServer` fails closed (throws) when neither is present, so an
   * unauthenticated service can never come up by accident.
   */
  auth?: AuthConfig;
  /** ed25519 publish-signature verification (see {@link SigningConfig}). */
  signing?: SigningConfig;
  /** Rate limiting. Defaults to on with conservative buckets. */
  rateLimit?: RateLimitOptions;
  /**
   * Audit destination. Defaults to the driver (rows live next to contract
   * data). Pass a {@link AuditBackend} to fan out elsewhere.
   */
  audit?: AuditBackend;
  /** Bind host for {@link start}; defaults to all interfaces. */
  host?: string;
}
