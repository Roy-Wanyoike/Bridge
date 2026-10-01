import type {
  AuditEntry,
  ConsumerRef,
  ContractSummary,
  DiffReport,
  GraphData,
  OrgInfo,
  OverviewData,
  RegistryClient,
  VersionDetail,
  VersionRef,
} from '@/lib/types';

/**
 * A fully configured {@link RegistryClient} for page-render scenarios the
 * demo seed cannot express (all-empty registry, versions without pullable
 * metadata). Everything defaults to an honest "nothing here" so a test only
 * states the rows it wants to see.
 */
export interface StaticFixture {
  orgs?: OrgInfo[];
  contracts?: ContractSummary[];
  /** Keyed `org/project/base`. */
  versions?: Record<string, VersionRef[]>;
  /** Keyed `org/project/base@version`. */
  details?: Record<string, VersionDetail | null>;
  /** Keyed `org/project/base@version`. */
  consumers?: Record<string, ConsumerRef[]>;
  /** Keyed `org/project/base@from..to`. */
  diffs?: Record<string, DiffReport | null>;
  audit?: AuditEntry[];
  graph?: GraphData;
  overview?: OverviewData;
}

const key3 = (org: string, project: string, base: string): string => `${org}/${project}/${base}`;
const keyDiff = (org: string, project: string, base: string, from: string, to: string): string =>
  `${key3(org, project, base)}@${from}..${to}`;

export function emptyOverview(): OverviewData {
  return {
    contracts: 0,
    versions: 0,
    orgs: 0,
    projects: 0,
    consumerLinks: 0,
    latestVerdicts: [],
    recentPublishes: [],
    recentBreaking: [],
  };
}

export function staticRegistryClient(fixture: StaticFixture = {}): RegistryClient {
  const contracts = fixture.contracts ?? [];
  const findContract = (org: string, project: string, base: string): ContractSummary | null =>
    contracts.find((c) => c.org === org && c.project === project && c.base === base) ?? null;
  return {
    listOrgs: () => Promise.resolve(fixture.orgs ?? []),
    listContracts: (org, project) =>
      Promise.resolve(contracts.filter((c) => c.org === org && c.project === project)),
    listAllContracts: (org) => Promise.resolve(contracts.filter((c) => !org || c.org === org)),
    getContract: (org, project, base) => Promise.resolve(findContract(org, project, base)),
    listVersions: (org, project, base) =>
      Promise.resolve(fixture.versions?.[key3(org, project, base)] ?? []),
    getVersion: (org, project, base, version) =>
      Promise.resolve(fixture.details?.[`${key3(org, project, base)}@${version}`] ?? null),
    listConsumers: (org, project, base, version) =>
      Promise.resolve(fixture.consumers?.[`${key3(org, project, base)}@${version}`] ?? []),
    getDiff: (org, project, base, from, to) =>
      Promise.resolve(fixture.diffs?.[keyDiff(org, project, base, from, to)] ?? null),
    getGraph: (org) => {
      // The static fixture serves one prebuilt graph; org scoping is the
      // caller's concern (only the unknown-org empty-state test uses this).
      void org;
      return Promise.resolve(fixture.graph ?? { nodes: [], edges: [] });
    },
    listAudit: () => Promise.resolve(fixture.audit ?? []),
    getOverview: () => Promise.resolve(fixture.overview ?? emptyOverview()),
  };
}

/** A minimal but complete ContractSummary row for static fixtures. */
export function summaryOf(overrides: Partial<ContractSummary> & { org: string; project: string; base: string }): ContractSummary {
  return {
    packageName: `${overrides.base}.v1`,
    latestVersion: 'v1',
    latestHash: '0'.repeat(64),
    latestShortHash: '0'.repeat(12),
    owner: 'team-x',
    versionCount: 1,
    firstPublishedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    consumers: 0,
    languages: [],
    ...overrides,
  };
}
