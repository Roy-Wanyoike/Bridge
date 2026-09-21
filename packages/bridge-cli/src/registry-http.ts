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
 */
import { RegistryError } from '@bridge/registry';
import type { IRPackage } from '@bridge/core';
import * as path from 'node:path';
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
): Promise<ServiceResponse> {
  let response: Response;
  try {
    response = await fetch(`${target.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${target.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
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
): Promise<{ outcome: string; meta: RemoteContractMeta }> {
  const coords = `/v1/orgs/${encodeURIComponent(target.org as string)}/projects/${encodeURIComponent(
    target.project as string,
  )}`;
  const body: Record<string, unknown> = { packageName, ir, contentHash };
  if (version !== undefined) body['version'] = version;
  if (meta.description !== undefined || meta.repository !== undefined) {
    body['meta'] = meta;
  }
  const response = await request(target, 'POST', `${coords}/contracts/${encodeURIComponent(packageName)}`, body);
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
