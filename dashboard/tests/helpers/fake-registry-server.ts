import { vi } from 'vitest';
import {
  demoGetContract,
  demoGetDiff,
  demoGetVersion,
  demoListAudit,
  demoListContracts,
  demoListConsumers,
  demoListOrgs,
  demoListVersions,
} from '@/lib/demo-data';

/**
 * Minimal in-test fake of the registry service wire (issue #123).
 *
 * It implements the documented service routes (see
 * `packages/bridge-registry-service/src/server.ts`, read-only reference)
 * on top of the DEMO SEED, so the REST client and the demo client face the
 * same underlying fixture and the shared expectations in
 * `registry-client.test.ts` are genuinely "same data, both clients".
 *
 * Wire shapes served (matching the live service):
 * - `GET /v1/audit?action&actor&contract&org&limit` -> `{ entries }` with
 *   time/status/ok rows and the service's limit semantics (default 100,
 *   clamp into [0, 10000], newest first).
 * - `GET /v1/orgs/{org}/projects` -> `{ projects: { project }[] }`.
 * - `GET /v1/orgs/{org}/projects/{project}/contracts` -> `{ contracts }` of
 *   storage-level meta rows.
 * - `GET .../contracts/{base}` -> `{ ir, meta }` (latest).
 * - `GET .../contracts/{base}/versions` -> `{ contract, versions: string[] }`
 *   — plain version strings, no metadata.
 * - `GET .../contracts/{base}/versions/{version}` -> `{ ir, meta }`.
 * - `GET .../contracts/{base}/versions/{version}/consumers` -> `{ contract, version, consumers }`.
 * - `GET .../contracts/{base}/versions/{to}/diff?from={from}` -> `{ contract, from, to, verdict, summary, changes }`
 *   (no impact — the live diff route does not serve it).
 * Unknown orgs/contracts/versions are 404 (never leaked as empty lists).
 */

export const REGISTRY_BASE = 'http://registry.test';

export interface FakeCall {
  path: string;
  auth?: string;
}

/** Minimal Response stand-in for the client's `ok`/`status`/`json` usage. */
export function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function notFound(path: string): Response {
  return jsonResponse(404, { error: 'not-found', path });
}

/** IR block as the publish route records it: named rows per schema category. */
function wireIr(detail: { imports: string[]; schema: { types: string[]; enums: string[]; services: string[]; events: string[]; aliases: string[] } }): Record<string, unknown> {
  const names = (rows: string[]) => rows.map((name) => ({ name }));
  return {
    imports: detail.imports,
    types: names(detail.schema.types),
    enums: names(detail.schema.enums),
    services: names(detail.schema.services),
    events: names(detail.schema.events),
    aliases: names(detail.schema.aliases),
  };
}

interface WireMeta {
  org: string;
  project: string;
  packageName: string;
  base: string;
  version: string;
  hash: string;
  shortHash: string;
  imports: string[];
  publishedAt: string;
  publishedBy: string;
  description?: string;
  repository?: string;
  languages: string[];
}

/** Storage-level meta row for one version, as the service's storage drivers record it. */
function wireMeta(
  org: string,
  project: string,
  base: string,
  version?: string,
): WireMeta | null {
  const summary = demoGetContract(org, project, base);
  const latest = version ?? demoListVersions(org, project, base).at(-1)?.version;
  if (!summary || !latest) return null;
  const detail = demoGetVersion(org, project, base, latest);
  if (!detail) return null;
  return {
    org,
    project,
    packageName: detail.packageName,
    base: detail.base,
    version: detail.version,
    hash: detail.hash,
    shortHash: detail.shortHash,
    imports: detail.imports,
    publishedAt: detail.publishedAt,
    publishedBy: detail.publisher,
    description: summary.description,
    repository: detail.repository,
    languages: detail.languages,
  };
}

/** The `{ ir, meta }` pull-route body, or `null` for unknown coordinates. */
function wirePull(
  org: string,
  project: string,
  base: string,
  version?: string,
): { ir: Record<string, unknown>; meta: WireMeta } | null {
  const meta = wireMeta(org, project, base, version);
  return meta ? { ir: wireIr(detailOf(meta)), meta } : null;
}

function detailOf(meta: WireMeta): {
  imports: string[];
  schema: { types: string[]; enums: string[]; services: string[]; events: string[]; aliases: string[] };
} {
  const detail = demoGetVersion(meta.org, meta.project, meta.base, meta.version);
  if (!detail) throw new Error(`fake registry: meta without detail for ${meta.base}@${meta.version}`);
  return detail;
}

function handle(pathWithQuery: string, auth: string | undefined): Response {
  const [rawPath, rawQuery = ''] = pathWithQuery.split('?');
  const segments = (rawPath ?? '').split('/').filter(Boolean);
  const query = new URLSearchParams(rawQuery);
  const ok = auth !== undefined && auth !== '' && auth === 'Bearer test-token';

  // /v1/audit — admin-only in the real service; the fake only checks that a
  // bearer token was attached (credential handling is client behavior).
  if (segments.length === 2 && segments[0] === 'v1' && segments[1] === 'audit') {
    if (!ok) return jsonResponse(401, { error: 'unauthorized' });
    const limitRaw = query.get('limit');
    const entries = demoListAudit({
      action: query.get('action') ?? undefined,
      actor: query.get('actor') ?? undefined,
      contract: query.get('contract') ?? undefined,
      org: query.get('org') ?? undefined,
      limit: limitRaw === null ? undefined : Number(limitRaw),
    }).map((e) => ({
      id: e.id,
      time: e.at,
      actor: e.actor,
      action: e.action,
      org: e.org,
      project: e.project,
      contract: e.contract,
      version: e.version ?? null,
      ok: true,
      status: 200,
      ip: '127.0.0.1',
    }));
    return jsonResponse(200, { entries });
  }

  // /v1/orgs/{org}/projects — projects-list route (listAllContracts walks it
  // when an org declares no projects in REGISTRY_ORGS). Serves
  // `{ project: string }` rows, matching the client's projection.
  if (
    segments.length === 4 &&
    segments[0] === 'v1' &&
    segments[1] === 'orgs' &&
    segments[3] === 'projects'
  ) {
    if (!ok) return jsonResponse(401, { error: 'unauthorized' });
    const org = segments[2]!;
    if (!demoListOrgs().some((o) => o.org === org)) return notFound(rawPath ?? '');
    return jsonResponse(200, {
      projects: (demoListOrgs().find((o) => o.org === org)?.projects ?? []).map((p) => ({
        project: p,
      })),
    });
  }

  // /v1/orgs/{org}/projects/{project}/contracts[...]
  if (
    segments.length >= 6 &&
    segments[0] === 'v1' &&
    segments[1] === 'orgs' &&
    segments[3] === 'projects'
  ) {
    const org = segments[2]!;
    const project = segments[4]!;
    if (!ok) return jsonResponse(401, { error: 'unauthorized' });
    if (!demoListOrgs().some((o) => o.org === org)) return notFound(rawPath ?? '');

    // .../contracts — the list route: storage-level meta rows.
    if (segments.length === 6 && segments[5] === 'contracts') {
      const rows = demoListContracts(org, project)
        .map((c) => wireMeta(org, project, c.base))
        .filter((m) => m !== null);
      return jsonResponse(200, { contracts: rows });
    }

    if (segments.length < 7 || segments[5] !== 'contracts') return notFound(rawPath ?? '');

    const base = segments[6]!;
    if (demoGetContract(org, project, base) === null) return notFound(rawPath ?? '');
    const tail = segments.slice(7);

    // .../contracts/{base} — the latest pull: `{ ir, meta }`.
    if (tail.length === 0) {
      const body = wirePull(org, project, base);
      return body ? jsonResponse(200, body) : notFound(rawPath ?? '');
    }
    if (tail.length === 1 && tail[0] === 'versions') {
      return jsonResponse(200, {
        contract: base,
        versions: demoListVersions(org, project, base).map((r) => r.version),
      });
    }
    if (tail.length === 2 && tail[0] === 'versions') {
      const body = wirePull(org, project, base, tail[1]);
      return body ? jsonResponse(200, body) : notFound(rawPath ?? '');
    }
    if (tail.length === 3 && tail[0] === 'versions' && tail[2] === 'consumers') {
      return jsonResponse(200, {
        contract: base,
        version: tail[1],
        consumers: demoListConsumers(org, project, base, tail[1]!),
      });
    }
    if (tail.length === 3 && tail[0] === 'versions' && tail[2] === 'diff') {
      const from = query.get('from') ?? '';
      const to = tail[1]!;
      const report = demoGetDiff(org, project, base, from, to);
      if (report === null) return notFound(rawPath ?? '');
      // Mirror the live diff route: no impact roll-up on the wire.
      return jsonResponse(200, {
        contract: base,
        from,
        to,
        verdict: report.verdict,
        summary: report.summary,
        changes: report.changes,
      });
    }
    return notFound(rawPath ?? '');
  }

  return notFound(rawPath ?? '');
}

/**
 * Installs the fake as the global `fetch` and returns the call log. Every
 * request must present `Bearer test-token` — asserted once below to pin the
 * client's credential handling.
 */
export function installFakeRegistry() {
  const calls: FakeCall[] = [];
  const fetchMock = vi.fn(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const pathWithQuery = url.startsWith(REGISTRY_BASE) ? url.slice(REGISTRY_BASE.length) : url;
      const headers = (init?.headers ?? {}) as Record<string, string | undefined>;
      const auth = headers['authorization'];
      calls.push({ path: pathWithQuery, auth });
      return handle(pathWithQuery, auth);
    },
  );
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}
