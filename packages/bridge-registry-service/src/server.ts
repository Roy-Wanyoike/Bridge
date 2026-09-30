/**
 * `@bridge/registry-service` — dependency-free HTTP layer over a
 * {@link StorageDriver}.
 *
 * JSON over HTTP with org/project tenancy, OIDC (or static-token)
 * authentication, ed25519 artifact-signature verification on publish, an
 * append-only audit log and token-bucket rate limiting. Every error
 * response uses the envelope `{"error": {"code": ..., "message": ...}}`.
 * `RegistryError` codes from the storage layer map to HTTP statuses
 * (`not-found` 404, `hash-conflict`/`immutable` 409, `invalid-name`/
 * `invalid-version` 400, `corrupt`/`io` 500).
 *
 * Cross-tenant access ALWAYS returns 404 (never 403) so the service does
 * not leak the existence of other tenants' resources.
 *
 * No top-level side effects: `createServer` returns a plain `http.Server`
 * (bind it yourself, e.g. `listen(0)` in tests); `start` is the
 * convenience wrapper that binds and prints the bound port.
 */

import { createServer as nodeCreateServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { hashPackage } from '@bridge/core';
import { diffPackages } from '@bridge/compat';
import { RegistryError, splitPackageVersion } from '@bridge/registry';
import { AuthFailureAuditGate, DriverAuditBackend, clampLimit } from './audit';
import { createAuthenticator, extractBearerToken, requireLevel } from './auth';
import type { RequestAuthenticator } from './auth';
import { Levels } from './auth';
import { ServiceError, statusForRegistryError } from './errors';
import { TokenBucketLimiter } from './ratelimit';
import { MAX_CANONICAL_DEPTH, assertContentHash, effectiveSigningMode, verifyPublishSignature } from './signing';
import type { PublishCoordinates } from './signing';
import { assertContractName, assertIsoTimestamp, isPlainObject, validateIRPackage } from './validation';
import { openApiDocument } from './openapi';
import type {
  AuditBackend,
  AuditEntry,
  ContractMeta,
  Principal,
  PublishMeta,
  RegistryServiceOptions,
  StorageDriver,
} from './types';

/** Hard cap on request body size (8 MiB — generous for IR documents). */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

interface Deps {
  driver: StorageDriver;
  auth: RequestAuthenticator;
  limiter: TokenBucketLimiter;
  audit: AuditBackend;
  signing?: RegistryServiceOptions['signing'];
  /** Audit-failure policy (issue #120): 'fail' rejects the request, 'best-effort' logs and continues. */
  auditFailureMode: 'fail' | 'best-effort';
  /** Per-IP cap on persisted failed-auth audit entries (issue #120). */
  authFailureGate: AuthFailureAuditGate;
}

/**
 * A response held back until the audit decision has been made (issue #120):
 * in the default fail-closed audit mode no byte of a response may be
 * written before the audit append for the request has succeeded.
 */
interface PendingResponse {
  status: number;
  body: string;
}

interface RequestContext {
  /** Attempted operation; `null` for /healthz, openapi.json and unknown routes. */
  action: 'publish' | 'read' | 'search' | 'audit' | 'auth' | null;
  org: string | null;
  project: string | null;
  /** Route contract base when the route had one. */
  contract: string | null;
  /** Resolved version when known. */
  version: string | null;
  subject: string | null;
  /**
   * Audit hygiene (issue #48): `true` when the request must NOT be
   * persisted to the audit log (pre-auth noise, rate-limited floods).
   */
  skipAudit: boolean;
  /** Buffered response; written by `flush` after the audit decision. */
  response: PendingResponse | null;
  /** 413 follow-up: destroy the socket once the buffered response flushed. */
  discardAfterFlush: boolean;
}

// ---------------------------------------------------------------- factories

/**
 * Create the HTTP server.
 *
 * Returns the unstarted `http.Server` so callers control binding (tests
 * use `server.listen(0)`). Options are validated eagerly — a service
 * without auth configured fails at construction (fail closed), never
 * silently at request time.
 */
export function createServer(options: RegistryServiceOptions): Server {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('createServer: options object is required');
  }
  const driver: StorageDriver | undefined = options.driver;
  if (typeof driver !== 'object' || driver === null || typeof driver.publish !== 'function') {
    throw new TypeError('createServer: options.driver must be a StorageDriver');
  }
  const auth = createAuthenticator(options.auth);
  // Rate limiting defaults to ON with the conservative DEFAULTS buckets
  // (issue #48 — matches "Defaults to on" in the option docs): a naive
  // deployment must not ship unthrottled against token guessing and publish
  // floods. Pass `{ enabled: false }` explicitly to opt out (tests).
  const limiter = new TokenBucketLimiter(options.rateLimit ?? {});
  if (options.rateLimit === undefined) {
    console.log(
      '[bridge-registry-service] rate limiting enabled by default ' +
        '(auth bucket: 120 capacity @ 30/s per IP, publish: 30 @ 5/s per principal)',
    );
  }
  // Loud boot warning when publishes are silently unsigned-accepted
  // (issue #48): signing is only enforced when keys are configured AND mode
  // is not explicitly 'optional'.
  if (effectiveSigningMode(options.signing) === 'optional') {
    console.warn(
      '[bridge-registry-service] WARNING: artifact signing is NOT required — ' +
        'unsigned publishes are accepted. Configure signing.keys (mode defaults to "required") ' +
        'or start with --production-profile.',
    );
  }
  const audit: AuditBackend = options.audit ?? new DriverAuditBackend(driver);
  // Audit-failure policy (issue #120): fail closed by default — a request
  // whose audit append failed is answered with a 5xx envelope instead of
  // silently going unaudited. 'best-effort' restores the legacy behavior.
  const auditFailureMode = options.auditFailureMode ?? 'fail';
  if (auditFailureMode !== 'fail' && auditFailureMode !== 'best-effort') {
    throw new TypeError("createServer: options.auditFailureMode must be 'fail' or 'best-effort'");
  }
  // Auth-flood ring protection (issue #120): per-IP cap on persisted
  // failed-auth audit entries (60s window, 20 entries) so a well-formed-
  // bearer flood cannot evict legitimate history from the bounded ring.
  const authFailureGate = new AuthFailureAuditGate();
  const deps: Deps = {
    driver,
    auth,
    limiter,
    audit,
    signing: options.signing,
    auditFailureMode,
    authFailureGate,
  };
  const server = nodeCreateServer((req, res) => {
    void handle(req, res, deps);
  });
  // Explicit timeout hygiene (issue #48): Node's defaults are generous
  // (300s request, 60s headers). keepAliveTimeout pins Node's 5s default so
  // a runtime default change cannot silently loosen it.
  server.headersTimeout = 15_000;
  server.requestTimeout = 120_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

/**
 * Convenience starter: creates the server, binds it (default port 0 —
 * auto-assigned) and prints `bridge-registry-service listening on port N`
 * once bound. Returns the server.
 */
export function start(options: RegistryServiceOptions, port = 0): Server {
  const server = createServer(options);
  server.listen(port, options.host);
  server.on('listening', () => {
    const address = server.address();
    const bound = typeof address === 'object' && address !== null ? address.port : port;
    console.log(`bridge-registry-service listening on port ${bound}`);
  });
  return server;
}

// ------------------------------------------------------------- entry points

async function handle(req: IncomingMessage, res: ServerResponse, deps: Deps): Promise<void> {
  const startedAt = new Date();
  const ctx: RequestContext = {
    action: null,
    org: null,
    project: null,
    contract: null,
    version: null,
    subject: null,
    skipAudit: false,
    response: null,
    discardAfterFlush: false,
  };
  res.on('error', () => {
    /* socket-level noise (client aborts) is not an application error */
  });
  try {
    // The response is BUFFERED in `ctx.response`, never written inline: the
    // audit decision below must happen first so that fail-closed auditing
    // (issue #120) can replace an unaudited response with a 5xx envelope.
    await routeRequest(req, res, ctx, deps);
  } catch (err) {
    ctx.response = errorResponse(err);
    if (ctx.response.status === 413) {
      // 413 ordering (issue #48): the envelope is flushed FIRST (below),
      // the connection is destroyed only after it has flushed.
      ctx.discardAfterFlush = true;
    }
  }
  if (ctx.response === null) {
    // Defensive: a routing path that neither responded nor threw.
    ctx.response = errorResponse(new ServiceError(500, 'internal', 'internal error'));
  }
  let status = ctx.response.status;

  // One audit entry per /v1 request (success or failure), except for the
  // hygiene classes flagged in `ctx.skipAudit` (issue #48): rate-limited
  // floods and requests that never presented usable credentials must not
  // evict legitimate history from the ring. Fail-closed (issue #120): a
  // failed append rejects the request with a 5xx envelope unless the
  // operator opted into `auditFailureMode: 'best-effort'`.
  if (ctx.action !== null && !ctx.skipAudit) {
    const entry: AuditEntry = {
      time: startedAt.toISOString(),
      org: ctx.org,
      project: ctx.project,
      actor: ctx.subject,
      action: ctx.action,
      contract: ctx.contract,
      version: ctx.version,
      ok: status < 400,
      status,
      ip: clientIp(req),
    };
    // Ring protection (issue #120): a per-IP window cap bounds how many
    // failed-auth entries one source can persist; excess entries are
    // dropped (the 401 response itself is unaffected — they are redundant
    // security noise from the same source).
    const persistEntry =
      entry.action !== 'auth' ||
      entry.ok ||
      deps.authFailureGate.allow(entry.ip ?? 'unknown');
    if (persistEntry) {
      try {
        await deps.audit.append(entry);
      } catch (err) {
        if (deps.auditFailureMode === 'best-effort') {
          console.error('audit.dropped', (err as Error).message);
        } else {
          ctx.response = errorResponse(
            new ServiceError(
              500,
              'internal',
              'audit append failed; the request is rejected because auditing is enforced (auditFailureMode=fail)',
            ),
          );
          status = ctx.response.status;
        }
      }
    }
  }
  flush(res, ctx.response);
  if (ctx.discardAfterFlush) discardOversizedRequest(req, res);
}

async function routeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: Deps,
): Promise<number> {
  const method = (req.method ?? 'GET').toUpperCase();
  const url = new URL(req.url ?? '/', 'http://bridge.local');

  let segments: string[];
  try {
    segments = url.pathname
      .split('/')
      .filter((segment) => segment !== '')
      .map(decodeSegment);
  } catch {
    throw new ServiceError(400, 'invalid_argument', 'malformed percent-encoding in request path');
  }

  // GET /healthz — unauthenticated liveness probe (not rate-limited).
  if (segments.length === 1 && segments[0] === 'healthz') {
    requireMethod(method, 'GET', '/healthz');
    ctx.action = null;
    sendJson(ctx, 200, { ok: true });
    return 200;
  }

  if (segments[0] !== 'v1') {
    throw new ServiceError(404, 'not-found', `unknown route ${url.pathname}`);
  }

  ctx.action = 'read';
  ctx.subject = null;

  // Rate limit: one auth-tier token per /v1 request, keyed by client IP.
  const ip = clientIp(req) ?? 'unknown';
  const authDecision = deps.limiter.take('auth', ip);
  if (!authDecision.ok) {
    // Audit hygiene (issue #48): rate-limited requests are NOT persisted —
    // an unauthenticated flood must not evict legitimate audit history.
    ctx.skipAudit = true;
    res.setHeader('Retry-After', String(authDecision.retryAfterSeconds));
    throw new ServiceError(429, 'rate-limited', 'too many requests: slow down and retry');
  }

  // GET /v1/openapi.json — static public API document, no auth. Served
  // BELOW the limiter (issue #48: it used to bypass it, contradicting the
  // old comment; static-doc floods must be throttled like any other /v1
  // traffic). Not audited at all: it is static and pre-auth.
  if (segments.length === 2 && segments[1] === 'openapi.json') {
    requireMethod(method, 'GET', '/v1/openapi.json');
    ctx.action = null;
    sendJson(ctx, 200, openApiDocument());
    return 200;
  }

  // Authentication covers every remaining /v1 route.
  let principal;
  try {
    principal = await deps.auth.authenticate(req.headers.authorization);
  } catch (err) {
    // Audit hygiene policy (issue #48), applied coherently:
    // - Requests that never presented a well-formed bearer token (missing
    //   header, wrong scheme, empty token) are PRE-AUTH noise — skipped,
    //   because unauthenticated floods would otherwise evict the ring.
    // - A well-formed bearer token that failed verification is a real
    //   security event (possible credential misuse / probing) and IS
    //   persisted, with action 'auth': authentication failed before any
    //   route was selected, so the attempted operation is unknowable.
    // - Authorization failures (403) after successful authn keep the
    //   attempted operation as their action and stay recorded.
    ctx.action = 'auth';
    if (!hasWellFormedBearer(req.headers.authorization)) ctx.skipAudit = true;
    throw err;
  }
  ctx.subject = principal.subject;
  ctx.action = 'read';

  const rest = segments.slice(1);

  // GET /v1/search?q=... — scoped to the caller's org.
  if (rest.length === 1 && rest[0] === 'search') {
    requireMethod(method, 'GET', '/v1/search');
    requireLevel(principal, Levels.read);
    ctx.org = principal.org;
    const query = (url.searchParams.get('q') ?? '').slice(0, 256);
    const results = await deps.driver.search(principal.org, null, query);
    sendJson(ctx, 200, { query, results });
    return 200;
  }

  // GET /v1/audit — admin-only, filterable, newest first.
  if (rest.length === 1 && rest[0] === 'audit') {
    ctx.action = 'audit'; // attempted op first, so 403s record 'audit'
    requireMethod(method, 'GET', '/v1/audit');
    requireLevel(principal, Levels.admin);
    ctx.org = principal.org;
    // Tenancy (issue #47): audit reads are FORCE-SCOPED to the principal's
    // own org, mirroring /v1/search. The Principal model has no cross-org
    // role — `org` is the tenancy binding of every credential (static-token
    // tenant or OIDC `org` claim) and `registry:admin` grants audit access
    // within that org, never across tenants. An explicit foreign org filter
    // is indistinguishable from an unknown route (404 — never 403 — so the
    // existence of other tenants is not leaked).
    const requestedOrg = url.searchParams.get('org');
    const orgFilter =
      requestedOrg === null || requestedOrg.length === 0 ? undefined : requestedOrg;
    if (orgFilter !== undefined && orgFilter !== principal.org) {
      throw new ServiceError(404, 'not-found', `unknown route ${url.pathname}`);
    }
    const entries = await deps.audit.query({
      org: principal.org,
      project: url.searchParams.get('project') ?? undefined,
      actor: url.searchParams.get('actor') ?? undefined,
      action: url.searchParams.get('action') ?? undefined,
      contract: url.searchParams.get('contract') ?? undefined,
      // Time bounds are validated (issue #48): they compare lexicographically
      // against stored ISO-8601 strings, so garbage bounds silently matched
      // nothing (or everything) before.
      from: withIsoParam(url, 'from'),
      to: withIsoParam(url, 'to'),
      limit: clampLimit(limitParam(url)),
    });
    sendJson(ctx, 200, { entries });
    return 200;
  }

  // /v1/orgs/{org}/projects/{project}/...
  if (rest[0] !== 'orgs' || rest[2] !== 'projects' || rest.length < 4) {
    throw new ServiceError(404, 'not-found', `unknown route ${url.pathname}`);
  }
  const org = rest[1]!;
  const project = rest[3]!;
  // Tenancy: another org's resources are indistinguishable from unknown
  // ones (404 — never 403 — so existence is not leaked).
  if (principal.org !== org) {
    throw new ServiceError(404, 'not-found', `unknown route ${url.pathname}`);
  }
  ctx.org = org;
  ctx.project = project;

  const tail = rest.slice(4);
  // /v1/orgs/{org}/projects/{project} → project-level routes
  if (tail.length === 0) {
    requireMethod(method, 'GET', `/v1/orgs/${org}/projects/${project}`);
    requireLevel(principal, Levels.read);
    const contracts = await deps.driver.list(org, project);
    sendJson(ctx, 200, { contracts });
    return 200;
  }

  if (tail[0] !== 'contracts') {
    throw new ServiceError(404, 'not-found', `unknown route ${url.pathname}`);
  }

  if (tail.length === 1) {
    // GET list is project-level (handled above); a bare /contracts POST
    // is a project-scoped publish with the package name inside the body.
    if (method === 'POST' || method === 'PUT') {
      ctx.action = 'publish';
      requireLevel(principal, Levels.publish);
      requireJsonContentType(req);
      const body = await readJsonBody(req);
      const name = body['packageName'];
      if (typeof name !== 'string') {
        throw new ServiceError(400, 'invalid_argument', 'body.packageName is required');
      }
      const contract = assertContractName(name);
      ctx.contract = splitPackageVersion(contract).base;
      // Project-scoped publish: the contract name comes from the BODY, so
      // there is no URL contract to bind against (routeContract = null).
      return publish(req, res, ctx, deps, org, project, contract, body, null);
    }
    requireMethod(method, 'GET', `/v1/orgs/${org}/projects/${project}/contracts`);
    const contracts = await deps.driver.list(org, project);
    sendJson(ctx, 200, { contracts });
    return 200;
  }

  const contract = assertContractName(tail[1]!);
  ctx.contract = splitPackageVersion(contract).base;

  // PUT/POST /v1/orgs/{org}/projects/{project}/contracts/{contract} — publish
  if (tail.length === 2 && (method === 'PUT' || method === 'POST')) {
    ctx.action = 'publish';
    requireLevel(principal, Levels.publish);
    requireJsonContentType(req);
    const body = await readJsonBody(req);
    // URL-embedded publish: the route contract is authoritative (issue #120)
    // — publish() rejects a body that names a different contract.
    return publish(req, res, ctx, deps, org, project, contract, body, contract);
  }

  requireMethod(method, 'GET', `/v1/orgs/${org}/projects/${project}/contracts/${contract}`);

  if (tail.length === 2) {
    // Latest version (or the version embedded in the route name).
    ctx.action = 'read';
    requireLevel(principal, Levels.read);
    const { base, version } = splitPackageVersion(contract);
    ctx.contract = base;
    const target = version ?? (await deps.driver.latest(org, project, base)).version;
    ctx.version = target;
    const { ir, meta } = await deps.driver.pull(org, project, base, target);
    sendJson(ctx, 200, { ir, meta });
    return 200;
  }

  if (tail.length === 3 && tail[2] === 'versions') {
    ctx.action = 'read';
    requireLevel(principal, Levels.read);
    const base = splitPackageVersion(contract).base;
    const versions = await deps.driver.versions(org, project, base);
    sendJson(ctx, 200, { contract: base, versions });
    return 200;
  }

  if (tail.length === 4 && tail[2] === 'versions') {
    ctx.action = 'read';
    requireLevel(principal, Levels.read);
    const base = splitPackageVersion(contract).base;
    const version = normalizeVersionParam(tail[3]!);
    ctx.version = version;
    const { ir, meta } = await deps.driver.pull(org, project, base, version);
    sendJson(ctx, 200, { ir, meta });
    return 200;
  }

  if (tail.length === 5 && tail[2] === 'versions' && tail[4] === 'consumers') {
    ctx.action = 'read';
    requireLevel(principal, Levels.read);
    const base = splitPackageVersion(contract).base;
    const version = normalizeVersionParam(tail[3]!);
    ctx.version = version;
    const consumers = await deps.driver.dependents(org, project, base);
    sendJson(ctx, 200, { contract: base, version, consumers });
    return 200;
  }

  if (tail.length === 3 && tail[2] === 'diff') {
    ctx.action = 'read';
    requireLevel(principal, Levels.read);
    const base = splitPackageVersion(contract).base;
    const from = normalizeVersionParam(url.searchParams.get('from') ?? '');
    const to = normalizeVersionParam(url.searchParams.get('to') ?? '');
    ctx.version = to;
    const oldIr = (await deps.driver.pull(org, project, base, from)).ir;
    const newIr = (await deps.driver.pull(org, project, base, to)).ir;
    const report = diffPackages(oldIr, newIr);
    sendJson(ctx, 200, {
      contract: base,
      from,
      to,
      verdict: report.verdict,
      summary: report.summary,
      changes: report.changes,
    });
    return 200;
  }

  if (tail.length === 3 && tail[2] === 'graph') {
    ctx.action = 'read';
    requireLevel(principal, Levels.read);
    const base = splitPackageVersion(contract).base;
    const meta = await deps.driver.latest(org, project, base);
    ctx.version = meta.version;
    const deps_closure = await deps.driver.dependencies(org, project, base);
    const nodes = [
      { name: meta.packageName, version: meta.version, hash: meta.hash },
      ...deps_closure.map((name) => ({ name })),
    ];
    const edges = deps_closure.map((dep) => ({ from: meta.packageName, to: dep }));
    sendJson(ctx, 200, { contract: base, version: meta.version, nodes, edges });
    return 200;
  }

  throw new ServiceError(404, 'not-found', `unknown route ${url.pathname}`);
}

// ------------------------------------------------------------------ publish

/**
 * Publish flow: signature verification → IR validation → route/body
 * coordinate binding → content-hash tripwire → driver publish (immutability
 * enforced below the driver).
 *
 * `routeContract` is the contract name embedded in the URL, or `null` for
 * the project-scoped `POST .../contracts` form (where the name comes from
 * the body). When set, the body must name THE SAME contract (issue #120):
 * `body.packageName` (when present) and `ir.name` must both match, so a
 * captured/rewritten payload cannot be published into a different slot.
 */
async function publish(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: Deps,
  org: string,
  project: string,
  contract: string,
  body: unknown,
  routeContract: string | null,
): Promise<number> {
  const ip = clientIp(req) ?? 'unknown';
  const publishDecision = deps.limiter.take('publish', `${ctx.subject ?? ''}|${ip}`);
  if (!publishDecision.ok) {
    res.setHeader('Retry-After', String(publishDecision.retryAfterSeconds));
    throw new ServiceError(429, 'rate-limited', 'publish rate limit exceeded');
  }

  const routeParts = splitPackageVersion(contract);
  // Signature verification happens BEFORE any parsing of the payload so a
  // tampered body can never reach storage. The v2 envelope (issue #120)
  // additionally binds the signature to these route coordinates; the legacy
  // body-only format is still accepted (the CLI signs that way today).
  const coordinates: PublishCoordinates = {
    org,
    project,
    contract,
    version: routeParts.version === '' ? null : routeParts.version,
  };
  verifyPublishSignature(body, req.headers, deps.signing, coordinates);

  if (!isPlainObject(body)) {
    throw new ServiceError(400, 'invalid_argument', 'request body must be a JSON object');
  }
  const rawIr = body['ir'];
  if (!isPlainObject(rawIr)) {
    throw new ServiceError(400, 'invalid_argument', 'body.ir is required');
  }
  const validated = validateIRPackage(rawIr);
  if (!validated.ok) {
    throw new ServiceError(400, 'invalid_contract', 'contract failed validation', {
      errors: validated.errors.slice(0, 50),
    });
  }
  const ir = validated.ir;

  // URL/body coordinate binding (issue #120): the URL contract name is
  // authoritative for URL-embedded publishes.
  if (routeContract !== null) {
    assertNameMatchesRoute(body['packageName'], routeContract, 'body.packageName');
    assertNameMatchesRoute(ir.name, routeContract, 'ir.name');
  }

  const actualHash = hashWithDepthCap(ir);
  assertContentHash(body, actualHash);

  const embedded = routeParts.version;
  const explicitVersion =
    typeof body['version'] === 'string' && body['version'].length > 0
      ? body['version']
      : undefined;
  const version = embedded !== '' ? embedded : (explicitVersion ?? 'v1');

  const metaRaw = isPlainObject(body['meta']) ? body['meta'] : {};
  const meta: PublishMeta = {};
  if (typeof metaRaw['description'] === 'string') meta.description = metaRaw['description'].slice(0, 2048);
  if (typeof metaRaw['repository'] === 'string') meta.repository = metaRaw['repository'].slice(0, 2048);
  const languages = normalizeLanguages(metaRaw['languages']);
  if (languages !== undefined) meta.languages = languages;

  const publishTime =
    typeof body['publishTime'] === 'string' && body['publishTime'].length > 0
      ? assertIsoTimestamp(body['publishTime'], 'body.publishTime')
      : undefined;

  const result = await deps.driver.publish({
    org,
    project,
    ir,
    meta,
    version,
    publishTime,
    publishedBy: ctx.subject ?? 'unknown',
  });
  ctx.version = result.meta.version;
  // Audit truth (issue #120): the contract field of the audit entry comes
  // from the STORED meta (derived from ir.name), never from the URL or the
  // body-declared package name, so the log reflects what was actually
  // persisted.
  ctx.contract = result.meta.base;

  const status = result.outcome === 'created' ? 201 : 200;
  sendJson(ctx, status, { outcome: result.outcome, meta: result.meta });
  return status;
}

// ------------------------------------------------------------------ helpers

/** Bounds for the publish meta languages list (issue #104). */
const MAX_LANGUAGES = 16;
const MAX_LANGUAGE_LENGTH = 32;
const LANGUAGE_PATTERN = /^[a-z][a-z0-9+#.-]*$/;

/**
 * Validate and normalize the publish meta languages list: trimmed,
 * lowercased, deduped (first occurrence wins), bounded. Returns `undefined`
 * when the field is absent so storage stays minimal for publishers that
 * don't track languages.
 */
export function normalizeLanguages(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new ServiceError(400, 'invalid_argument', 'body.meta.languages must be an array of strings');
  }
  if (raw.length > MAX_LANGUAGES) {
    throw new ServiceError(400, 'invalid_argument', `body.meta.languages must have at most ${MAX_LANGUAGES} entries`);
  }
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      throw new ServiceError(400, 'invalid_argument', 'body.meta.languages must be an array of strings');
    }
    const lang = entry.trim().toLowerCase();
    if (
      lang.length === 0 || lang.length > MAX_LANGUAGE_LENGTH || !LANGUAGE_PATTERN.test(lang)
    ) {
      throw new ServiceError(
        400,
        'invalid_argument',
        `body.meta.languages entries must be lowercase identifiers of at most ${MAX_LANGUAGE_LENGTH} ` +
          `characters matching ${LANGUAGE_PATTERN.source} (got ${JSON.stringify(entry)})`,
      );
    }
    if (!out.includes(lang)) out.push(lang);
  }
  return out;
}

function clientIp(req: IncomingMessage): string | null {
  return req.socket.remoteAddress ?? null;
}

/**
 * Body-consuming routes (publish) must declare a JSON content type
 * (issue #120): a body sent as `text/plain` or with no Content-Type at all
 * is rejected with 415 before parsing. Media-type parameters
 * (`application/json; charset=utf-8`) are accepted.
 */
function requireJsonContentType(req: IncomingMessage): void {
  const raw = req.headers['content-type'];
  const mediaType = typeof raw === 'string' ? raw.split(';')[0]!.trim().toLowerCase() : '';
  if (mediaType !== 'application/json') {
    throw new ServiceError(
      415,
      'invalid_argument',
      `publish requires Content-Type: application/json (got ${
        typeof raw === 'string' && raw.length > 0 ? `'${mediaType}'` : 'no Content-Type'
      })`,
    );
  }
}

/**
 * URL/body coordinate binding (issue #120): `name` (a body-declared package
 * name or the validated `ir.name`) must denote the SAME contract as the
 * URL-embedded route name: same base, and — when the route embeds a version
 * segment — the same (normalized) version. Versionless route names accept
 * any version the body resolves to.
 */
function assertNameMatchesRoute(name: unknown, routeContract: string, field: string): void {
  if (typeof name !== 'string') return; // body.packageName is optional on URL-embedded routes
  const route = splitPackageVersion(routeContract);
  const candidate = splitPackageVersion(name);
  const versionMismatch = route.version !== '' && candidate.version !== route.version;
  if (candidate.base !== route.base || versionMismatch) {
    throw new ServiceError(
      400,
      'invalid_argument',
      `${field} '${name}' does not match the URL contract '${routeContract}': the publish route is ` +
        'authoritative, and publishing under a mismatched name is rejected (coordinate binding)',
    );
  }
}

/** True when the Authorization header carries a well-formed bearer token. */
function hasWellFormedBearer(authorization: string | undefined): boolean {
  try {
    extractBearerToken(authorization);
    return true;
  } catch {
    return false;
  }
}

/** Validated optional ISO-8601 query parameter (empty/absent → undefined). */
function withIsoParam(url: URL, name: string): string | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.length === 0) return undefined;
  return assertIsoTimestamp(raw, `audit.${name}`);
}

/**
 * Re-hash the validated IR with the canonical-JSON depth cap (issue #48):
 * the validator bounds IR shape, but the cap guarantees even a future
 * validation gap cannot turn recursion into a 500.
 */
function hashWithDepthCap(ir: Parameters<typeof hashPackage>[0]): string {
  try {
    return hashPackage(ir, MAX_CANONICAL_DEPTH);
  } catch (err) {
    if (err instanceof RangeError) {
      throw new ServiceError(
        400,
        'invalid_argument',
        `contract nesting exceeds the maximum supported canonical-JSON depth (${MAX_CANONICAL_DEPTH})`,
      );
    }
    throw err;
  }
}

/**
 * 413 follow-up (issue #48): discard the rest of the upload so the client
 * can finish sending and read the envelope, then destroy the socket once
 * the response has flushed. `sendError` has already written the envelope —
 * the destroy strictly follows it.
 */
function discardOversizedRequest(req: IncomingMessage, res: ServerResponse): void {
  const destroy = (): void => {
    req.socket.destroy();
  };
  req.on('data', () => {}); // resume + discard the remaining upload
  req.resume();
  if (res.writableFinished) destroy();
  else res.once('finish', destroy);
}

function limitParam(url: URL): number | undefined {
  const raw = url.searchParams.get('limit');
  if (raw === null) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : undefined;
}

function normalizeVersionParam(value: string): string {
  if (value.length === 0 || value.length > 128) {
    throw new ServiceError(400, 'invalid_argument', 'invalid version parameter');
  }
  return value.startsWith('v') || /^v/i.test(value) ? `v${value.slice(1)}` : `v${value}`;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new ServiceError(400, 'invalid_argument', 'malformed percent-encoding in request path');
  }
}

function requireMethod(method: string, expected: string, route: string): void {
  if (method !== expected) {
    throw new ServiceError(405, 'method-not-allowed', `method ${method} is not allowed for ${route}`);
  }
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readRawBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    throw new ServiceError(400, 'invalid_argument', 'request body is not valid JSON');
  }
  if (!isPlainObject(parsed)) {
    throw new ServiceError(400, 'invalid_argument', 'request body must be a JSON object');
  }
  return parsed;
}

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return; // draining after a 413 decision — discard
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        settled = true;
        chunks.length = 0;
        // Do NOT destroy the socket here (issue #48): the 413 envelope must
        // be written first. Pause consumption; `handle` discards the rest
        // and destroys the connection after the response has flushed.
        req.pause();
        reject(new ServiceError(413, 'payload-too-large', `request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

/** Buffer a success response on the request context (flushed after audit). */
function sendJson(ctx: RequestContext, status: number, payload: unknown): void {
  if (ctx.response !== null) {
    throw new ServiceError(500, 'internal', 'internal error: response already produced for this request');
  }
  ctx.response = { status, body: JSON.stringify(payload) };
}

/**
 * Build the error envelope for `err` WITHOUT writing it (issue #120): the
 * response is flushed only after the audit decision. Unknown failures
 * never leak internals.
 */
function errorResponse(err: unknown): PendingResponse {
  let status = 500;
  let code: string = 'internal';
  let message = 'internal error';
  let details: unknown;

  if (err instanceof ServiceError) {
    status = err.status;
    code = err.code;
    message = err.message;
    details = err.details;
  } else if (err instanceof RegistryError) {
    status = statusForRegistryError(err.code);
    code = err.code;
    message = err.message;
    if (status >= 500) message = 'storage error';
  } else {
    console.error('registry-service internal error:', err);
  }

  const envelope: Record<string, unknown> = { error: { code, message } };
  if (details !== undefined) {
    (envelope['error'] as Record<string, unknown>)['details'] = details;
  }
  return { status, body: JSON.stringify(envelope) };
}

/**
 * Write the buffered response. THE single writeHead for every response the
 * service produces (successes and error envelopes alike), which is where
 * the security headers live (issue #120): `X-Content-Type-Options: nosniff`
 * and `Cache-Control: no-store` on everything, no exceptions.
 */
function flush(res: ServerResponse, pending: PendingResponse): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(pending.status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(pending.body),
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  });
  res.end(pending.body);
}
