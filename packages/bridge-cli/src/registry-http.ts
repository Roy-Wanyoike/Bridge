/**
 * HTTP(S) registry transport for the CLI (issue #91).
 *
 * Lets `bridge publish/pull/versions/inspect/search` talk to a running
 * `bridge-registry-service` — the same REST contract its dashboard uses —
 * instead of a filesystem registry root:
 *
 *   bridge publish payments.bridge \
 *     --registry https://registry.example.com --org acme --project payments
 *
 * Authentication is a bearer token (`--token` or `BRIDGE_TOKEN`); the service
 * fails closed without auth, so an HTTP target without a usable token is a
 * usage error before any request is made. Tokens are only ever sent in the
 * `Authorization` header — never logged, never echoed in errors.
 *
 * Server error envelopes (`{"error":{"code","message"}}`) whose codes match
 * the store's `RegistryError` union (not-found, immutable, …) are mapped
 * onto those errors so the existing `registryCliError()` hints apply;
 * service-level failures (auth, rate limits, tampering) become `CliError`s
 * with actionable messages.
 *
 * Artifact signing (issue #103): when the service runs with ed25519
 * signing `required`, publishes must carry `x-bridge-key-id` and
 * `x-bridge-signature` headers — an ed25519 signature over the canonical
 * JSON of the request body, verified by the service against the public
 * half configured for that key id. The CLI loads the private key from
 * `--signing-key-file` (or `BRIDGE_SIGNING_KEY`) and names it with
 * `--signing-key-id` (or `BRIDGE_SIGNING_KEY_ID`). Both halves are
 * required together; unsigned publishes to optional-mode services remain
 * valid and pass the signature when signed.
 */
import { createPrivateKey, sign as cryptoSign, type KeyObject } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalJson, type IRPackage } from '@bridge/core';
import { RegistryError } from '@bridge/registry';
import { ParsedArgs } from './args';
import { CliError } from './errors';

/** How long one HTTP request may take before it is abandoned. */
const REQUEST_TIMEOUT_MS = 30_000;

/** A resolved registry target: a filesystem root or a remote service. */
export type RegistryTarget =
  | { kind: 'dir'; root: string }
  | { kind: 'http'; baseUrl: string; token: string; org?: string; project?: string };

/** True when the value denotes a remote registry rather than a directory. */
export function isHttpRegistryTarget(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

interface HttpOptions {
  readonly command: string;
  /** Commands whose HTTP form needs org+project coordinates. */
  readonly requireOrgProject?: boolean;
  /** Commands whose HTTP form must NOT receive --owner (publish). */
  readonly rejectOwner?: boolean;
}

/** ed25519 signing material for publishes (issue #103). */
export interface SigningMaterial {
  /** Key id configured in the service's `signing.keys`. */
  readonly keyId: string;
  /** PEM-encoded ed25519 private key (PKCS#8 or SEC1). */
  readonly privateKeyPem: string;
}

const ENV_SIGNING_KEY = 'BRIDGE_SIGNING_KEY';
const ENV_SIGNING_KEY_ID = 'BRIDGE_SIGNING_KEY_ID';

/**
 * Resolve optional publish-signing material: `--signing-key-file` (PEM path)
 * or `BRIDGE_SIGNING_KEY` (PEM inline), named by `--signing-key-id` or
 * `BRIDGE_SIGNING_KEY_ID`. Key and key id are required together — a lone
 * half is a usage error before any request is made. Returns `undefined`
 * when the caller asked for neither.
 */
export function resolveSigningMaterial(args: ParsedArgs): SigningMaterial | undefined {
  const keyFile = args.values.get('--signing-key-file');
  const keyId = args.values.get('--signing-key-id') ?? process.env[ENV_SIGNING_KEY_ID];

  let pem: string | undefined;
  if (keyFile !== undefined) {
    let raw: Buffer;
    try {
      raw = fs.readFileSync(keyFile);
    } catch (e) {
      throw new CliError(
        `registry: cannot read --signing-key-file '${keyFile}': ${(e as Error).message}`,
        2,
      );
    }
    pem = raw.toString('utf8');
  } else {
    const envKey = process.env[ENV_SIGNING_KEY];
    if (envKey !== undefined && envKey.length > 0) pem = envKey;
  }

  if (pem === undefined && keyId === undefined) return undefined;
  if (pem === undefined) {
    throw new CliError(
      `registry: a signing key id was given ('${keyId}') but no private key — ` +
        `pass --signing-key-file <pem-path> or set ${ENV_SIGNING_KEY}`,
      2,
    );
  }
  if (keyId === undefined || keyId.length === 0) {
    throw new CliError(
      `registry: a signing key was given but no key id — pass --signing-key-id <id> ` +
        `or set ${ENV_SIGNING_KEY_ID} (the id must match a key configured on the service)`,
      2,
    );
  }
  const material: SigningMaterial = { keyId, privateKeyPem: pem };
  // Fail fast on an unreadable or non-ed25519 key — a usage error (exit 2)
  // raised before any request is made, not a mid-publish failure.
  loadEd25519PrivateKey(material);
  return material;
}

/** Load the PEM into an ed25519 KeyObject or fail with an actionable error. */
function loadEd25519PrivateKey(material: SigningMaterial): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(material.privateKeyPem);
  } catch (e) {
    throw new CliError(
      `registry: --signing-key-file does not contain a readable private key: ${(e as Error).message}`,
      2,
    );
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new CliError(
      `registry: signing key for '${material.keyId}' is ${String(key.asymmetricKeyType)}, ` +
        'but the registry service verifies ed25519 signatures only — generate one with `openssl genpkey -algorithm ed25519`',
      2,
    );
  }
  return key;
}

/**
 * Sign the canonical JSON of the publish body (issue #103): the exact
 * message the service verifies — `@bridge/registry`'s re-export of
 * `canonicalJson` over the body object as sent. Returns the base64
 * signature for the `x-bridge-signature` header.
 */
export function signPublishBody(material: SigningMaterial, body: unknown): string {
  const key = loadEd25519PrivateKey(material);
  const message = Buffer.from(canonicalJson(body), 'utf8');
  return cryptoSign(null, message, key).toString('base64');
}

/**
 * Resolve `--registry` (then `BRIDGE_REGISTRY`) into a concrete target.
 * Filesystem targets behave exactly as before; HTTP targets additionally
 * need a bearer token and — for coordinate-scoped commands — org/project.
 */
export function resolveRegistryTarget(args: ParsedArgs, opts: HttpOptions): RegistryTarget {
  const flag = args.values.get('--registry');
  const env = process.env['BRIDGE_REGISTRY'];
  const raw = flag ?? (env !== undefined && env.length > 0 ? env : undefined);

  if (raw === undefined) {
    return { kind: 'dir', root: path.join(process.cwd(), '.bridge-registry') };
  }

  if (!isHttpRegistryTarget(raw)) {
    return { kind: 'dir', root: raw };
  }

  // ---- HTTP target validation (loud, before any I/O) ----------------
  if (opts.rejectOwner && args.values.has('--owner')) {
    throw new CliError(
      `registry: --owner applies to filesystem registries only — the HTTP ` +
        `registry records who published from your credential ('publishedBy')`,
      2,
    );
  }

  const token = args.values.get('--token') ?? process.env['BRIDGE_TOKEN'];
  if (token === undefined || token.length === 0) {
    throw new CliError(
      `registry: '${raw}' is an HTTP(S) registry — authentication is required. ` +
        `Pass --token <token> or set BRIDGE_TOKEN`,
      2,
    );
  }

  const org = args.values.get('--org') ?? process.env['BRIDGE_ORG'];
  const project = args.values.get('--project') ?? process.env['BRIDGE_PROJECT'];
  if (opts.requireOrgProject === true && (org === undefined || org.length === 0 || project === undefined || project.length === 0)) {
    throw new CliError(
      `registry: '${raw}' is an HTTP(S) registry — this command needs tenancy ` +
        `coordinates. Pass --org <org> --project <project> (or set ` +
        `BRIDGE_ORG / BRIDGE_PROJECT)`,
      2,
    );
  }

  return {
    kind: 'http',
    baseUrl: raw.replace(/\/+$/, ''),
    token,
    org,
    project,
  };
}

// ---------------------------------------------------------------------------
// Low-level request plumbing
// ---------------------------------------------------------------------------

/** One parsed server response. */
interface ServiceResponse {
  status: number;
  // The service's response bodies are intentionally loose here — each
  // operation validates its own shape before use.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  retryAfter?: string;
}

async function request(
  target: Extract<RegistryTarget, { kind: 'http' }>,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<ServiceResponse> {
  let response: Response;
  try {
    response = await fetch(`${target.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${target.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(extraHeaders ?? {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    const cause = e instanceof Error ? e : undefined;
    const timedOut = cause?.name === 'TimeoutError' || cause?.name === 'AbortError';
    throw new CliError(
      timedOut
        ? `registry request to ${target.baseUrl}${path} timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
        : `registry request to ${target.baseUrl}${path} failed: ${cause?.message ?? 'network error'}`,
    );
  }

  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return {
    status: response.status,
    body: parsed,
    retryAfter: response.headers.get('retry-after') ?? undefined,
  };
}

/** Server error codes for artifact-signature failures (distinct from auth). */
const SIGNATURE_ERROR_CODES = new Set(['signature-required', 'invalid-signature']);

/** Server error codes shared 1:1 with the store's RegistryError union. */
const STORE_ERROR_CODES = new Set(['not-found', 'immutable', 'hash-conflict', 'invalid-name', 'invalid-version', 'corrupt']);

/** Throw for a non-2xx response, preserving the friendliest available shape. */
function assertOk(response: ServiceResponse, context: string): void {
  if (response.status >= 200 && response.status < 300) return;

  const err =
    response.body !== null && typeof response.body === 'object'
      ? (response.body as { error?: { code?: unknown; message?: unknown } }).error
      : undefined;
  const serverCode = typeof err?.code === 'string' ? err.code : undefined;
  const serverMessage = typeof err?.message === 'string' ? err.message : `HTTP ${response.status}`;

  if (response.status === 401 && serverCode !== undefined && SIGNATURE_ERROR_CODES.has(serverCode)) {
    throw new CliError(
      `registry: publish rejected for ${context} — ${serverMessage}. ` +
        'Sign the publish with an ed25519 key: pass --signing-key-id <id> and ' +
        '--signing-key-file <pem> (or BRIDGE_SIGNING_KEY_ID / BRIDGE_SIGNING_KEY) ' +
        'where <id> is configured on the service',
    );
  }

  switch (response.status) {
    case 401:
      throw new CliError(
        `registry: authentication failed for ${context} — check --token / BRIDGE_TOKEN`,
      );
    case 403:
      throw new CliError(`registry: not permitted for ${context}: ${serverMessage}`);
    case 429:
      throw new CliError(
        `registry: rate limited for ${context} — slow down and retry` +
          (response.retryAfter !== undefined ? ` (Retry-After: ${response.retryAfter}s)` : ''),
      );
    default:
      break;
  }

  if (serverCode !== undefined && STORE_ERROR_CODES.has(serverCode)) {
    // Feeds the existing registryCliError() hints (search hint, bump-the-
    // version hint, …). The membership check above narrows the literal.
    const storeCode =
      serverCode === 'not-found' ||
      serverCode === 'immutable' ||
      serverCode === 'hash-conflict' ||
      serverCode === 'invalid-name' ||
      serverCode === 'invalid-version' ||
      serverCode === 'corrupt'
        ? serverCode
        : 'io';
    throw new RegistryError(storeCode, `registry: ${serverMessage}`);
  }
  throw new CliError(`registry: ${context} failed: ${serverMessage}`);
}

// ---------------------------------------------------------------------------
// Operations (one per CLI verb)
// ---------------------------------------------------------------------------

/** Metadata returned by the service for one published version. */
export interface RemoteContractMeta {
  org: string;
  project: string;
  packageName: string;
  base: string;
  version: string;
  hash: string;
  shortHash: string;
  imports: string[];
  publishedAt: string;
  description?: string;
  repository?: string;
  publishedBy?: string;
}

/** `bridge publish` over HTTP. */
export async function httpPublish(
  target: Extract<RegistryTarget, { kind: 'http' }>,
  packageName: string,
  ir: IRPackage,
  meta: { description?: string; repository?: string },
  version: string | undefined,
  contentHash: string,
  signing?: SigningMaterial,
): Promise<{ outcome: string; meta: RemoteContractMeta }> {
  const coords = `/v1/orgs/${encodeURIComponent(target.org as string)}/projects/${encodeURIComponent(
    target.project as string,
  )}`;
  const body: Record<string, unknown> = { packageName, ir, contentHash };
  if (version !== undefined) body['version'] = version;
  if (meta.description !== undefined || meta.repository !== undefined) {
    body['meta'] = meta;
  }
  // Sign the body exactly as it will be sent (issue #103): the service
  // canonicalizes the parsed request body, so the signature covers the
  // same semantic JSON regardless of serialization details.
  const headers = signing === undefined ? undefined : {
    'x-bridge-key-id': signing.keyId,
    'x-bridge-signature': signPublishBody(signing, body),
  };
  const response = await request(
    target, 'POST', `${coords}/contracts/${encodeURIComponent(packageName)}`, body, headers,
  );
  assertOk(response, `publishing ${packageName}`);
  if (response.body === null || typeof response.body !== 'object' || typeof response.body['meta'] !== 'object') {
    throw new CliError(`registry: publish response for ${packageName} had an unexpected shape`);
  }
  return response.body;
}

/** `bridge versions` over HTTP. */
export async function httpVersions(
  target: Extract<RegistryTarget, { kind: 'http' }>,
  packageName: string,
): Promise<string[]> {
  const coords = `/v1/orgs/${encodeURIComponent(target.org as string)}/projects/${encodeURIComponent(
    target.project as string,
  )}`;
  const response = await request(target, 'GET', `${coords}/contracts/${encodeURIComponent(packageName)}/versions`);
  assertOk(response, `listing versions of ${packageName}`);
  const versions = response.body?.['versions'];
  if (!Array.isArray(versions)) {
    throw new CliError(`registry: versions response for ${packageName} had an unexpected shape`);
  }
  return versions;
}

/** `bridge inspect` / `bridge pull` over HTTP: `{ ir, meta }`. */
export async function httpPull(
  target: Extract<RegistryTarget, { kind: 'http' }>,
  packageName: string,
  version: string | undefined,
): Promise<{ ir: IRPackage; meta: RemoteContractMeta }> {
  const coords = `/v1/orgs/${encodeURIComponent(target.org as string)}/projects/${encodeURIComponent(
    target.project as string,
  )}`;
  const base = `${coords}/contracts/${encodeURIComponent(packageName)}`;
  const fetchPath = version !== undefined ? `${base}/versions/${encodeURIComponent(version)}` : base;
  const response = await request(target, 'GET', fetchPath);
  assertOk(response, `pulling ${packageName}${version !== undefined ? `@${version}` : ''}`);
  if (response.body === null || typeof response.body !== 'object' || response.body['ir'] === undefined || response.body['meta'] === undefined) {
    throw new CliError(`registry: pull response for ${packageName} had an unexpected shape`);
  }
  return response.body;
}

/** `bridge search` over HTTP (org-scoped server-side by the credential). */
export async function httpSearch(
  target: Extract<RegistryTarget, { kind: 'http' }>,
  query: string,
): Promise<RemoteContractMeta[]> {
  const response = await request(target, 'GET', `/v1/search?q=${encodeURIComponent(query)}`);
  assertOk(response, `searching for '${query}'`);
  const results = response.body?.['results'];
  if (!Array.isArray(results)) {
    throw new CliError(`registry: search response for '${query}' had an unexpected shape`);
  }
  return results;
}
