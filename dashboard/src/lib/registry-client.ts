import type {
  AuditEntry,
  AuditFilters,
  Classification,
  ConsumerRef,
  ContractSummary,
  DiffReport,
  GraphData,
  Language,
  OrgInfo,
  OverviewData,
  RegistryClient,
  VersionDetail,
  VersionMeta,
} from './types';
import {
  DEMO_MODE_DEFAULT,
  demoGetContract,
  demoGetDiff,
  demoGetGraph,
  demoGetOverview,
  demoGetVersion,
  demoListAudit,
  demoListConsumers,
  demoListContracts,
  demoListOrgs,
  demoListVersions,
} from './demo-data';

/**
 * Reads the demo/live switches.
 *
 * Defaults:
 * - production builds start in LIVE mode (never serve fabricated data to real
 *   users just because an env var was forgotten); set
 *   `NEXT_PUBLIC_DEMO_MODE=true` explicitly if a prod deployment wants demo.
 * - `next dev` keeps demo mode as the zero-setup default.
 *
 * `NEXT_PUBLIC_DEMO_MODE` set to exactly `false` or `0` always forces live;
 * exactly `true` or `1` always forces demo. Anything else keeps the default
 * and warns — booleans are never coerced loosely (`'FALSE'` does not count).
 */
export function isDemoMode(): boolean {
  const raw = process.env.NEXT_PUBLIC_DEMO_MODE;
  if (raw === undefined || raw === '') {
    return process.env.NODE_ENV === 'production' ? DEMO_MODE_DEFAULT : true;
  }
  if (raw === 'false' || raw === '0') return false;
  if (raw !== 'true' && raw !== '1') {
    console.warn(
      `[dashboard] NEXT_PUBLIC_DEMO_MODE=${JSON.stringify(raw)} is not a recognized boolean (true/false/1/0); keeping the default. Set it to exactly "false" or "0" to go live.`,
    );
    return process.env.NODE_ENV === 'production' ? DEMO_MODE_DEFAULT : true;
  }
  return true;
}

/**
 * The registry service base URL for live mode, or `null` in demo mode.
 * Falls back to the documented local port when the env var is unset.
 */
export function registryBaseUrl(): string | null {
  if (isDemoMode()) return null;
  return process.env.NEXT_PUBLIC_REGISTRY_URL ?? 'http://localhost:4350';
}

/**
 * Parses `REGISTRY_ORGS` — the live-mode discovery source.
 *
 * The registry service intentionally exposes **no cross-tenant discovery
 * route** (another org's resources are indistinguishable from unknown ones —
 * 404, never leaked), and every credential is bound to exactly one org. So
 * the deployment declares what it serves:
 *
 *     REGISTRY_ORGS="acme:payments,acme:commerce"
 *
 * `org:project` pairs separated by commas, semicolons or whitespace.
 * Duplicate pairs collapse; order is preserved. Every org must declare at
 * least one project — a bare org name is a configuration error, not an
 * empty page. Returns `null` when the variable is unset/blank.
 */
export function parseOrgsConfig(raw: string | undefined | null): OrgInfo[] | null {
  if (raw === undefined || raw === null || raw.trim() === '') return null;
  const byOrg = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const piece of raw.split(/[,;\s]+/)) {
    if (piece === '') continue;
    const sep = piece.indexOf(':');
    const org = sep === -1 ? piece : piece.slice(0, sep);
    const project = sep === -1 ? '' : piece.slice(sep + 1);
    if (org === '' || project === '') {
      throw new Error(
        `RegistryMisconfigured: REGISTRY_ORGS entry '${piece}' is not an org:project pair — ` +
          `declare every project explicitly, e.g. REGISTRY_ORGS="acme:payments,acme:commerce". ` +
          `A bare org name would otherwise render as a silently empty page.`,
      );
    }
    const key = `${org}:${project}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const projects = byOrg.get(org) ?? [];
    projects.push(project);
    byOrg.set(org, projects);
  }
  if (byOrg.size === 0) return null;
  return Array.from(byOrg.entries(), ([org, projects]) => ({ org, projects }));
}

/* ------------------------------------------------------------------ */
/* REST client against the registry service                            */
/* ------------------------------------------------------------------ */

/** Hard ceiling for a single registry request, so a hung backend can never hang a render. */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Typed failure from the registry REST layer. Thrown for network failures,
 * timeouts and non-404 HTTP errors so React error boundaries handle them
 * (Retry UI) instead of pages silently rendering "not found".
 * `status === 0` means the request never got an HTTP response (timeout,
 * connection refused, DNS).
 */
export class RegistryError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(message: string, opts: { status: number; path: string; cause?: unknown }) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'RegistryError';
    this.status = opts.status;
    this.path = opts.path;
  }
}

/** True when `err` is a typed 404 from the registry (safe to render as "not found"). */
export function isNotFound(err: unknown): boolean {
  return err instanceof RegistryError && err.status === 404;
}

/**
 * Extracts an array field from a list response. If none of the expected keys
 * is present this throws a `RegistryError` — an array-shaped response without
 * the documented key means the API contract drifted, and silently rendering
 * an empty page ("No contracts match") would mask the bug.
 */
function pickArray(body: Record<string, unknown>, keys: string[], path: string): unknown[] {
  for (const k of keys) {
    const v = body[k];
    if (Array.isArray(v)) return v;
  }
  throw new RegistryError(
    `RegistryUnreachable: registry response for GET ${path} has none of the expected array keys [${keys.join(', ')}] — API schema drift`,
    { status: 0, path },
  );
}

/**
 * Encodes a path segment for interpolation into a registry URL. Identifiers
 * are data, not syntax: an org named `a/b` must round-trip instead of
 * silently addressing the wrong route.
 */
function enc(segment: string): string {
  return encodeURIComponent(segment);
}

/**
 * Maps `items` through an async `fn` with at most `limit` promises in flight
 * (worker-pool style, order-preserving). The overview used to fan out one
 * unbounded `Promise.all` per candidate contract — hundreds of sockets and a
 * hammered registry on large installations.
 */
async function mapBounded<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next;
      if (i >= items.length) return;
      next += 1;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}


/* ------------------------------------------------------------------ */
/* Live projections: the service serves raw ContractMeta + per-route    */
/* closures; the UI needs richer summaries. Everything below derives    */
/* what the service genuinely exposes and leaves what it does not       */
/* honestly empty — never fabricated.                                   */
/* ------------------------------------------------------------------ */

/** Shape returned by the service's list/pull routes (storage-level meta). */
interface ServiceContractMeta {
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
  /** Generated languages recorded at publish time (issue #104). */
  languages?: string[];
}

function isServiceContractMeta(v: unknown): v is ServiceContractMeta {
  return (
    typeof v === 'object' && v !== null &&
    typeof (v as ServiceContractMeta).packageName === 'string' &&
    typeof (v as ServiceContractMeta).version === 'string' &&
    typeof (v as ServiceContractMeta).hash === 'string'
  );
}

export class RestRegistryClient implements RegistryClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token?: string,
  ) {}

  private async get<T>(path: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        headers: {
          accept: 'application/json',
          // The registry service fails closed: every /v1 read requires a
          // bearer token. The credential is server-side (REGISTRY_TOKEN) —
          // it must never reach the browser bundle.
          ...(this.token !== undefined && this.token !== ''
            ? { authorization: `Bearer ${this.token}` }
            : {}),
        },
        cache: 'no-store',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      throw new RegistryError(
        timedOut
          ? `RegistryUnreachable: registry request timed out after ${FETCH_TIMEOUT_MS}ms on GET ${path}`
          : `RegistryUnreachable: registry unreachable on GET ${path}`,
        { status: 0, path, cause: err },
      );
    }
    if (!res.ok) {
      throw new RegistryError(`RegistryUnreachable: registry ${res.status} on GET ${path}`, {
        status: res.status,
        path,
      });
    }
    return (await res.json()) as T;
  }

  /**
   * Org discovery comes from the deployment's `REGISTRY_ORGS` config — the
   * service has no `GET /v1/orgs` route by design (tenancy: cross-org
   * existence is never leaked), so the operator declares the org/project
   * surface the dashboard serves.
   */
  async listOrgs(): Promise<OrgInfo[]> {
    const orgs = parseOrgsConfig(process.env['REGISTRY_ORGS']);
    if (orgs === null) {
      throw new RegistryError(
        'RegistryMisconfigured: live mode needs REGISTRY_ORGS (e.g. "acme:payments,acme:commerce") — ' +
          'the registry service exposes no cross-tenant discovery route, so the deployment must ' +
          'declare the org/project surface it serves',
        { status: 0, path: '/v1/orgs (discovery)' },
      );
    }
    return orgs;
  }

  async listContracts(org: string, project: string): Promise<ContractSummary[]> {
    const path = `/v1/orgs/${enc(org)}/projects/${enc(project)}/contracts`;
    const body = await this.get<Record<string, unknown>>(path);
    const metas = pickArray(body, ['contracts'], path).filter(isServiceContractMeta);
    // Derive the summary fields the service does not serve on the list
    // route (version count, direct dependents, latest verdict) with bounded
    // concurrency — the same discipline as the overview fan-out.
    return mapBounded(metas, 8, (m) => this.summarize(org, project, m));
  }

  /** One contract's latest version, fully projected. */
  private async latestSummary(org: string, project: string, base: string): Promise<ContractSummary | undefined> {
    const path = `/v1/orgs/${enc(org)}/projects/${enc(project)}/contracts/${enc(base)}`;
    let body: Record<string, unknown>;
    try {
      body = await this.get<Record<string, unknown>>(path);
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
    const meta = body['meta'];
    if (!isServiceContractMeta(meta)) {
      throw new RegistryError(
        `RegistryUnreachable: registry response for GET ${path} has an unexpected shape — API schema drift`,
        { status: 0, path },
      );
    }
    return this.summarize(org, project, meta);
  }

  /**
   * Project storage meta into the UI summary: derive versionCount,
   * direct-dependent count and the latest adjacent-version verdict from the
   * routes that genuinely serve them; take `languages` from the publish
   * metadata the service records (issue #104) and leave it empty for
   * contracts published without the field — never fabricated.
   */
  private async summarize(org: string, project: string, meta: ServiceContractMeta): Promise<ContractSummary> {
    let versionCount = 1;
    let latestVerdict: ContractSummary['latestVerdict'];
    const versionsPath = `/v1/orgs/${enc(org)}/projects/${enc(project)}/contracts/${enc(meta.base)}/versions`;
    try {
      const versions = pickArray(
        await this.get<Record<string, unknown>>(versionsPath),
        ['versions'],
        versionsPath,
      ).map(String);
      versionCount = versions.length;
      if (versions.length >= 2) {
        const target = versions[versions.length - 1]!;
        const previous = versions[versions.length - 2]!;
        const diff = await this.getDiff(org, project, meta.base, previous, target);
        latestVerdict = diff?.verdict;
      }
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    let consumers = 0;
    const consumersPath = `/v1/orgs/${enc(org)}/projects/${enc(project)}/contracts/${enc(meta.base)}/versions/${enc(meta.version)}/consumers`;
    try {
      const refs = pickArray(
        await this.get<Record<string, unknown>>(consumersPath),
        ['consumers'],
        consumersPath,
      );
      consumers = refs.length;
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    return {
      org,
      project,
      base: meta.base,
      packageName: meta.packageName,
      latestVersion: meta.version,
      latestHash: meta.hash,
      latestShortHash: meta.shortHash,
      owner: meta.publishedBy ?? '',
      description: meta.description,
      repository: meta.repository,
      versionCount,
      firstPublishedAt: meta.publishedAt,
      updatedAt: meta.publishedAt,
      consumers,
      // Languages recorded at publish time (issue #104); an empty array
      // stays honest for contracts published without the field.
      languages: Array.isArray(meta.languages)
        ? (meta.languages.filter((l): l is Language => typeof l === 'string') as Language[])
        : [],
      latestVerdict,
    };
  }

  async listAllContracts(org?: string): Promise<ContractSummary[]> {
    const orgInfos = org ? [{ org, projects: [] as string[] }] : await this.listOrgs();
    // Fan out per org, then per (org, project): the org→project→contracts
    // walk runs in parallel instead of a sequential N+1 cascade.
    const perOrg = await Promise.all(
      orgInfos.map(async (o) => {
        const projectsPath = `/v1/orgs/${enc(o.org)}/projects`;
        let projects = o.projects ?? [];
        if (projects.length === 0) {
          const body = await this.get<Record<string, unknown>>(projectsPath);
          projects = (pickArray(body, ['projects'], projectsPath) as { project: string }[]).map(
            (p) => p.project,
          );
        }
        const contractLists = await Promise.all(
          projects.map((project) => this.listContracts(o.org, project)),
        );
        return contractLists.flat();
      }),
    );
    return perOrg.flat();
  }

  async getContract(org: string, project: string, base: string): Promise<ContractSummary | null> {
    const latest = await this.latestSummary(org, project, base);
    return latest ?? null;
  }

  async listVersions(org: string, project: string, base: string): Promise<VersionMeta[]> {
    const path = `/v1/orgs/${enc(org)}/projects/${enc(project)}/contracts/${enc(base)}/versions`;
    const body = await this.get<Record<string, unknown>>(path);
    const versions = pickArray(body, ['versions'], path);
    // The service's versions route returns version strings; the per-version
    // metadata lives on the pull routes. getVersion()/latestSummary() enrich
    // where the UI needs it.
    return versions.map((v) => ({ version: String(v) })) as VersionMeta[];
  }

  async getVersion(
    org: string,
    project: string,
    base: string,
    version: string,
  ): Promise<VersionDetail | null> {
    const path = `/v1/orgs/${enc(org)}/projects/${enc(project)}/contracts/${enc(base)}/versions/${enc(version)}`;
    try {
      const body = await this.get<Record<string, unknown>>(path);
      const meta = body['meta'];
      const ir = body['ir'] as { imports?: string[]; types?: unknown[]; services?: unknown[]; events?: unknown[] } | undefined;
      if (!isServiceContractMeta(meta) || typeof ir !== 'object' || ir === null) {
        throw new RegistryError(
          `RegistryUnreachable: registry response for GET ${path} has an unexpected shape — API schema drift`,
          { status: 0, path },
        );
      }
      return {
        packageName: meta.packageName,
        base: meta.base,
        version: meta.version,
        hash: meta.hash,
        shortHash: meta.shortHash,
        imports: meta.imports,
        publishedAt: meta.publishedAt,
        publisher: meta.publishedBy ?? '',
        owner: '',
        repository: meta.repository,
        // Languages recorded at publish time (issue #104).
        languages: Array.isArray(meta.languages)
          ? (meta.languages.filter((l): l is Language => typeof l === 'string') as Language[])
          : [],
        schema: {
          types: Array.isArray(ir.types) ? (ir.types as { name?: unknown }[]).map((t) => String(t?.name ?? '')) : [],
          enums: [],
          services: Array.isArray(ir.services) ? (ir.services as { name?: unknown }[]).map((s) => String(s?.name ?? '')) : [],
          events: Array.isArray(ir.events) ? (ir.events as { name?: unknown }[]).map((e) => String(e?.name ?? '')) : [],
          aliases: [],
        },
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async listConsumers(
    org: string,
    project: string,
    base: string,
    version: string,
  ): Promise<ConsumerRef[]> {
    const path = `/v1/orgs/${enc(org)}/projects/${enc(project)}/contracts/${enc(base)}/versions/${enc(version)}/consumers`;
    const body = await this.get<Record<string, unknown>>(path);
    const consumers = pickArray(body, ['consumers'], path);
    // The service returns the dependents as ContractMeta[] — direct
    // dependents only (BFS depth 1). Project them into ConsumerRefs.
    return consumers.map((c) => {
      const m = c as ServiceContractMeta;
      return {
        packageName: m.packageName,
        base: m.base,
        org: m.org,
        project: m.project,
        version: m.version,
        depth: 1,
      } as ConsumerRef;
    });
  }

  async getDiff(
    org: string,
    project: string,
    base: string,
    from: string,
    to: string,
  ): Promise<DiffReport | null> {
    const path = `/v1/orgs/${enc(org)}/projects/${enc(project)}/contracts/${enc(base)}/versions/${enc(to)}/diff?from=${encodeURIComponent(from)}`;
    try {
      const body = await this.get<Record<string, unknown>>(path);
      // The service computes the report from the two stored IRs; its
      // response leaves the route coordinates implicit.
      return {
        org,
        project,
        contract: typeof body['contract'] === 'string' ? body['contract'] : base,
        packageName: `${base}.${to}`,
        from: typeof body['from'] === 'string' ? body['from'] : from,
        to: typeof body['to'] === 'string' ? body['to'] : to,
        verdict: body['verdict'] as DiffReport['verdict'],
        summary: body['summary'] as DiffReport['summary'],
        changes: (body['changes'] ?? []) as DiffReport['changes'],
        impact: body['impact'] as DiffReport['impact'],
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /**
   * The service has no global graph route (its per-contract graph is the
   * import closure of one contract). The console's dependency graph is
   * composed client-side: every published contract is a node; each
   * dependent reported by the service becomes a directed edge
   * consumer → provider.
   */
  async getGraph(org?: string): Promise<GraphData> {
    const contracts = await this.listAllContracts(org);
    const nodes: GraphData['nodes'] = contracts.map((c) => ({
      id: `${c.org}/${c.project}/${c.base}`,
      org: c.org,
      project: c.project,
      base: c.base,
      version: c.latestVersion,
      consumers: c.consumers,
      verdict: c.latestVerdict,
    }));
    const consumerLists = await mapBounded(contracts, 8, async (c) => {
      try {
        return await this.listConsumers(c.org, c.project, c.base, c.latestVersion);
      } catch (err) {
        if (isNotFound(err)) return [] as ConsumerRef[];
        throw err;
      }
    });
    const edges: GraphData['edges'] = [];
    for (let i = 0; i < contracts.length; i++) {
      const provider = contracts[i]!;
      for (const ref of consumerLists[i] ?? []) {
        edges.push({
          from: `${ref.org}/${ref.project}/${ref.base}`,
          to: `${provider.org}/${provider.project}/${provider.base}`,
        });
      }
    }
    return { nodes, edges };
  }

  async listAudit(filters?: AuditFilters): Promise<AuditEntry[]> {
    const qs = new URLSearchParams();
    if (filters?.action) qs.set('action', filters.action);
    if (filters?.actor) qs.set('actor', filters.actor);
    if (filters?.contract) qs.set('contract', filters.contract);
    if (filters?.org) qs.set('org', filters.org);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    const path = `/v1/audit${suffix}`;
    const body = await this.get<Record<string, unknown>>(path);
    const rows = pickArray(body, ['entries', 'audit'], path) as Record<string, unknown>[];
    // The service's audit rows carry time/status/ok; the UI's AuditEntry
    // renders at/actor/detail. Nulls (pre-auth rows) become honest
    // placeholders, never fabricated data.
    return rows.map((r, i) => ({
      id: r['id'] !== undefined ? String(r['id']) : `${i}`,
      at: String(r['time'] ?? ''),
      actor: typeof r['actor'] === 'string' && r['actor'] !== '' ? r['actor'] : 'unknown',
      action: String(r['action'] ?? 'unknown'),
      org: typeof r['org'] === 'string' ? r['org'] : '',
      project: typeof r['project'] === 'string' ? r['project'] : '',
      contract: typeof r['contract'] === 'string' ? r['contract'] : '',
      version: typeof r['version'] === 'string' ? r['version'] : undefined,
      detail: `status ${String(r['status'] ?? '?')}${r['ok'] === false ? ' (failed)' : ''}`,
      verdict: undefined,
    })) as AuditEntry[];
  }

  async getOverview(): Promise<OverviewData> {
    // Independent sources fetched concurrently, not back-to-back.
    const [contracts, orgs, audit] = await Promise.all([
      this.listAllContracts(),
      this.listOrgs(),
      this.listAudit(),
    ]);
    const publishes = audit.filter((e) => e.action === 'publish');
    const candidates = contracts.filter(
      (c) => c.latestVerdict && c.latestVerdict !== 'SAFE',
    );

    // All (versions → diff) lookups run with bounded concurrency (8 in
    // flight) so a large registry can never exhaust sockets or hammer the
    // service, and the attention list is ordered by the target version's
    // publish time — a lexicographic version sort puts 0.10.0 before 0.9.0.
    const verdicts = await mapBounded(candidates, 8, async (c) => {
      const versions = await this.listVersions(c.org, c.project, c.base);
      if (versions.length < 2) return null;
      const target = versions[versions.length - 1];
      const diff = await this.getDiff(
        c.org,
        c.project,
        c.base,
        versions[versions.length - 2].version,
        target.version,
      );
      if (!diff || diff.verdict === 'SAFE') return null;
      return { diff, publishedAt: target.publishedAt };
    });
    const recentBreaking = verdicts
      .filter((v): v is { diff: DiffReport; publishedAt: string } => v !== null)
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
      .map((v) => v.diff);
    return {
      contracts: contracts.length,
      versions: contracts.reduce((n, c) => n + c.versionCount, 0),
      orgs: orgs.length,
      projects: new Set(contracts.map((c) => `${c.org}/${c.project}`)).size,
      consumerLinks: contracts.reduce((n, c) => n + c.consumers, 0),
      latestVerdicts: contracts
        .filter((c) => c.latestVerdict)
        .map((c) => ({
          base: c.base,
          org: c.org,
          project: c.project,
          verdict: c.latestVerdict as Classification,
        })),
      recentPublishes: publishes.slice(0, 8).map((e) => {
        // Join the published contract's real metadata where we have it; never
        // fabricate languages or package names the audit entry doesn't carry.
        const summary = contracts.find(
          (c) => c.org === e.org && c.project === e.project && c.base === e.contract,
        );
        return {
          packageName: e.version ? `${e.contract}.${e.version}` : e.contract,
          base: e.contract,
          version: e.version ?? '',
          hash: summary?.latestHash ?? '',
          shortHash: summary?.latestShortHash ?? '',
          imports: [],
          publishedAt: e.at,
          publisher: e.actor,
          owner: summary?.owner ?? '',
          languages: summary?.languages ?? ([] as Language[]),
          org: e.org,
          project: e.project,
        };
      }),
      recentBreaking,
      lastPublishAt: publishes[0]?.at,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Demo client (zero backend)                                          */
/* ------------------------------------------------------------------ */

export class DemoRegistryClient implements RegistryClient {
  listOrgs(): Promise<OrgInfo[]> {
    return Promise.resolve(demoListOrgs());
  }
  listContracts(org: string, project: string): Promise<ContractSummary[]> {
    return Promise.resolve(demoListContracts(org, project));
  }
  listAllContracts(org?: string): Promise<ContractSummary[]> {
    return Promise.resolve(demoListContracts(org));
  }
  getContract(org: string, project: string, base: string): Promise<ContractSummary | null> {
    return Promise.resolve(demoGetContract(org, project, base));
  }
  listVersions(org: string, project: string, base: string): Promise<VersionMeta[]> {
    return Promise.resolve(demoListVersions(org, project, base));
  }
  getVersion(
    org: string,
    project: string,
    base: string,
    version: string,
  ): Promise<VersionDetail | null> {
    return Promise.resolve(demoGetVersion(org, project, base, version));
  }
  listConsumers(
    org: string,
    project: string,
    base: string,
    version: string,
  ): Promise<ConsumerRef[]> {
    return Promise.resolve(demoListConsumers(org, project, base, version));
  }
  getDiff(
    org: string,
    project: string,
    base: string,
    from: string,
    to: string,
  ): Promise<DiffReport | null> {
    return Promise.resolve(demoGetDiff(org, project, base, from, to));
  }
  getGraph(org?: string): Promise<GraphData> {
    return Promise.resolve(demoGetGraph(org));
  }
  listAudit(filters?: AuditFilters): Promise<AuditEntry[]> {
    return Promise.resolve(demoListAudit(filters));
  }
  getOverview(): Promise<OverviewData> {
    return Promise.resolve(demoGetOverview());
  }
}

let cached: RegistryClient | null = null;

/**
 * Returns the process-wide registry client (demo or REST, per env).
 *
 * Throws (never silently falls back to demo) when the deployment asks for
 * live mode but does not configure a registry URL — serving fabricated data
 * there would be worse than an honest, actionable error page.
 */
export function getRegistryClient(): RegistryClient {
  if (!cached) {
    if (isDemoMode()) {
      cached = new DemoRegistryClient();
    } else {
      const raw = process.env.NEXT_PUBLIC_REGISTRY_URL;
      if (raw === undefined || raw === '') {
        throw new Error(
          'RegistryMisconfigured: live mode is enabled but NEXT_PUBLIC_REGISTRY_URL is not set. Point it at the registry service (e.g. http://localhost:4350), or set NEXT_PUBLIC_DEMO_MODE=true for the zero-backend demo.',
        );
      }
      const token = process.env.REGISTRY_TOKEN;
      if (token === undefined || token === '') {
        throw new Error(
          'RegistryMisconfigured: live mode is enabled but REGISTRY_TOKEN is not set. The registry service fails closed — every /v1 read requires a bearer token. Set REGISTRY_TOKEN (server-side only; use an admin-role credential so the audit page can read /v1/audit), or set NEXT_PUBLIC_DEMO_MODE=true for the zero-backend demo.',
        );
      }
      if (parseOrgsConfig(process.env['REGISTRY_ORGS']) === null) {
        throw new Error(
          'RegistryMisconfigured: live mode is enabled but REGISTRY_ORGS is not set. The registry service exposes no cross-tenant discovery route, so declare the org/project surface the dashboard serves, e.g. REGISTRY_ORGS="acme:payments,acme:commerce". Or set NEXT_PUBLIC_DEMO_MODE=true for the zero-backend demo.',
        );
      }
      cached = new RestRegistryClient(raw, token);
    }
  }
  return cached;
}
