/**
 * Data types shared between the registry REST API, the typed client and the
 * dashboard UI. The shapes mirror `@bridge/registry` `ContractMeta` and
 * `@bridge/compat` `CompatReport`/`Change`, extended with presentation-only
 * fields (org/project scope, generated languages, schema summaries).
 */

/** Severity classification assigned to every detected change (see `@bridge/compat`). */
export type Classification = 'SAFE' | 'WARNING' | 'BREAKING' | 'UNKNOWN';

/** The four languages the BRIDGE generators currently emit. */
export const LANGUAGES = ['typescript', 'go', 'rust', 'python'] as const;
export type Language = (typeof LANGUAGES)[number];

/** A single detected difference between two versions of a package. */
export interface Change {
  /** Dotted location of the change, e.g. `Payment.currency`. */
  path: string;
  /** Machine-readable kind, e.g. `field-removed`. */
  kind: string;
  classification: Classification;
  message: string;
  old?: string;
  new?: string;
}

/** Count of changes per classification. */
export interface DiffSummary {
  safe: number;
  warning: number;
  breaking: number;
  unknown: number;
}

/** How a change was determined to reach a consumer (see `@bridge/compat`). */
export type ContactReason =
  | 'direct-type'
  | 'through'
  | 'event'
  | 'package-renamed'
  | 'unscannable'
  | 'unaffected';

/** One discovered consumer contract and how the change reaches it. */
export interface AffectedConsumer {
  packageName: string;
  version: string;
  org: string;
  project: string;
  /** BFS depth from the changed package: 1 = direct dependent. */
  depth: number;
  /** Worst classification among the changes that reach this consumer. */
  severity: Classification;
  reason: ContactReason;
  /** Type names through which the change reaches this consumer. */
  viaTypes: string[];
  owner?: string;
}

/** Consumer impact roll-up attached to every diff report. */
export interface ConsumerImpact {
  /** Transitive dependents discovered for the changed contract. */
  dependents: number;
  /** Dependents touched by at least one non-SAFE change. */
  affected: number;
  /** Dependents touched by at least one BREAKING change. */
  breakingAffected: number;
  consumers: AffectedConsumer[];
}

/** Compatibility report for a version pair. */
export interface DiffReport {
  org: string;
  project: string;
  /** Storage base of the contract, e.g. `payments`. */
  contract: string;
  /** Full package name of the target (new) version, e.g. `payments.v3`. */
  packageName: string;
  from: string;
  to: string;
  /** Worst classification across all changes. */
  verdict: Classification;
  summary: DiffSummary;
  /** Changes in canonical order: BREAKING, UNKNOWN, WARNING, SAFE. */
  changes: Change[];
  impact: ConsumerImpact;
}

/** Names declared by a contract version, straight from the compiled IR. */
export interface SchemaSummary {
  types: string[];
  enums: string[];
  services: string[];
  events: string[];
  aliases: string[];
}

/** Public metadata for one immutable, published contract version. */
export interface VersionMeta {
  /** Full dotted package name as published, e.g. `payments.v1`. */
  packageName: string;
  /** Storage base derived from the name, e.g. `payments`. */
  base: string;
  /** Normalized version, e.g. `v1`. */
  version: string;
  /** SHA-256 (hex) of the canonical JSON of the IR - the content address. */
  hash: string;
  /** First 12 characters of `hash`, for display. */
  shortHash: string;
  /** Dependencies of this contract as recorded from `ir.imports`. */
  imports: string[];
  /** ISO8601 publication timestamp. */
  publishedAt: string;
  /** Actor that published this version. */
  publisher: string;
  /** Owning team, e.g. `team-payments`. */
  owner: string;
  repository?: string;
  /** Languages this version has generated bindings for. */
  languages: Language[];
}

/** A version plus its declared schema summary. */
export interface VersionDetail extends VersionMeta {
  schema: SchemaSummary;
}

/** Row of the contracts list: a base contract at its latest version. */
export interface ContractSummary {
  org: string;
  project: string;
  /** Storage base, e.g. `payments`. */
  base: string;
  packageName: string;
  latestVersion: string;
  latestHash: string;
  latestShortHash: string;
  owner: string;
  description?: string;
  repository?: string;
  versionCount: number;
  firstPublishedAt: string;
  updatedAt: string;
  /** Direct dependents (contracts importing this one). */
  consumers: number;
  /** Union of generated languages across all versions. */
  languages: Language[];
  /** Verdict of the most recent adjacent-version diff, when one exists. */
  latestVerdict?: Classification;
}

/** A dependent contract, as listed on the consumers tab. */
export interface ConsumerRef {
  packageName: string;
  /** Storage base of the consumer, e.g. `fraud`. */
  base: string;
  org: string;
  project: string;
  version: string;
  owner?: string;
  /** BFS depth from this contract: 1 = direct dependent. */
  depth: number;
  /** Worst-severity change reaching this consumer in the latest diff. */
  severity?: Classification;
}

/** Node of the dependency graph (one per contract, at its latest version). */
export interface GraphNode {
  /** Stable unique key: `org/project/base` (base names can repeat across orgs). */
  id: string;
  org: string;
  project: string;
  base: string;
  version: string;
  consumers: number;
  verdict?: Classification;
}

/** Directed dependency edge: `from` imports `to`. */
export interface GraphEdge {
  from: string;
  to: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Audit trail entry recorded by the registry service. */
export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: 'publish' | 'pull' | 'compat-check';
  org: string;
  project: string;
  contract: string;
  version?: string;
  detail: string;
  verdict?: Classification;
}

export interface AuditFilters {
  action?: string;
  actor?: string;
  contract?: string;
  org?: string;
}

export interface OrgInfo {
  org: string;
  projects: string[];
}

/** Aggregated numbers for the overview page. */
export interface OverviewData {
  contracts: number;
  versions: number;
  orgs: number;
  projects: number;
  /** Directed consumer links across all latest versions. */
  consumerLinks: number;
  latestVerdicts: { base: string; org: string; project: string; verdict: Classification }[];
  recentPublishes: (VersionMeta & { org: string; project: string })[];
  recentBreaking: DiffReport[];
  lastPublishAt?: string;
}

/** Typed surface both the REST client and the demo provider implement. */
export interface RegistryClient {
  listOrgs(): Promise<OrgInfo[]>;
  listContracts(org: string, project: string): Promise<ContractSummary[]>;
  listAllContracts(org?: string): Promise<ContractSummary[]>;
  getContract(org: string, project: string, base: string): Promise<ContractSummary | null>;
  listVersions(org: string, project: string, base: string): Promise<VersionMeta[]>;
  getVersion(
    org: string,
    project: string,
    base: string,
    version: string,
  ): Promise<VersionDetail | null>;
  listConsumers(org: string, project: string, base: string, version: string): Promise<ConsumerRef[]>;
  getDiff(
    org: string,
    project: string,
    base: string,
    from: string,
    to: string,
  ): Promise<DiffReport | null>;
  getGraph(org?: string): Promise<GraphData>;
  listAudit(filters?: AuditFilters): Promise<AuditEntry[]>;
  getOverview(): Promise<OverviewData>;
}
