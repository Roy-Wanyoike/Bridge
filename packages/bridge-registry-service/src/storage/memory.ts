/**
 * In-memory {@link StorageDriver} — the service default.
 *
 * Mirrors `@bridge/registry`'s store semantics exactly, per (org, project)
 * namespace:
 * - identity is `hashPackage(ir)` (SHA-256 of canonical JSON);
 * - republishing identical content is an idempotent replay returning the
 *   ORIGINAL stored meta (versions are immutable — later metadata is
 *   ignored);
 * - republishing different content under an existing (base, version) throws
 *   `'immutable'`;
 * - every pull re-hashes the stored IR and throws `'corrupt'` on mismatch.
 *
 * Audit entries live in a bounded ring shared with the driver's lifetime.
 * All state is process-local; nothing survives a restart (that is what the
 * PostgreSQL driver is for).
 */

import { hashPackage } from '@bridge/core';
import { RegistryError, compareVersions, normalizeVersion, splitPackageVersion } from '@bridge/registry';
import { assertOrgOrProject, isValidContractName } from '../validation';
import type { PublishMeta } from '../types';
import type {
  AuditEntry,
  AuditFilter,
  ContractMeta,
  PublishInput,
  PublishResult,
  StorageDriver,
  StoredContract,
} from '../types';
import { applyAuditFilter, MEMORY_SINK_CAPACITY } from '../audit';
import { isValidOrgOrProject } from '../validation';
import { assertCoordinates, baseOfContract, buildMeta, requireLookupCoordinates } from './driver';

interface Entry {
  meta: ContractMeta;
  ir: unknown;
}

type ProjectState = Map<string, Map<string, Entry>>; // base → version → entry

function assertPublishMeta(meta: PublishMeta): void {
  if (meta === undefined || meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    throw new TypeError('publish(): meta must be an object');
  }
  for (const field of ['description', 'repository'] as const) {
    const value = meta[field];
    if (value !== undefined && typeof value !== 'string') {
      throw new TypeError(`publish(): meta.${field} must be a string when provided`);
    }
  }
  if (meta.languages !== undefined) {
    if (!Array.isArray(meta.languages) || meta.languages.some((l) => typeof l !== 'string')) {
      throw new TypeError('publish(): meta.languages must be an array of strings when provided');
    }
  }
}

export class InMemoryDriver implements StorageDriver {
  public readonly kind = 'memory' as const;
  private readonly orgs = new Map<string, Map<string, ProjectState>>();
  private readonly audit: AuditEntry[] = [];
  private readonly auditCapacity: number;

  public constructor(auditCapacity: number = MEMORY_SINK_CAPACITY) {
    this.auditCapacity = auditCapacity;
  }

  public async init(): Promise<void> {
    /* nothing to prepare */
  }

  public async close(): Promise<void> {
    this.orgs.clear();
    this.audit.length = 0;
  }

  // ------------------------------------------------------------------ publish

  public async publish(input: PublishInput): Promise<PublishResult> {
    const { org, project } = assertCoordinates(input.org, input.project);
    if (typeof input.publishedBy !== 'string' || input.publishedBy.length === 0) {
      throw new TypeError('publish(): publishedBy is required');
    }
    assertPublishMeta(input.meta);
    if (input.publishTime !== undefined) {
      const t = Date.parse(input.publishTime);
      if (!Number.isFinite(t)) {
        throw new RegistryError('invalid-version', 'publish(): publishTime must be an ISO-8601 timestamp');
      }
    }
    const ir = input.ir;
    if (typeof ir !== 'object' || ir === null || Array.isArray(ir)) {
      throw new RegistryError('invalid-name', 'publish(): ir must be an IRPackage object');
    }
    if (typeof ir.name !== 'string' || !isValidContractName(ir.name)) {
      throw new RegistryError('invalid-name', `publish(): invalid package name ${JSON.stringify(ir.name)}`);
    }
    if (!Array.isArray(ir.imports) || !ir.imports.every((x) => typeof x === 'string')) {
      throw new RegistryError('invalid-name', "publish(): ir.imports must be an array of strings");
    }

    const { base, version: derived } = splitPackageVersion(ir.name);
    let version: string;
    if (derived !== '') {
      if (input.version !== undefined && normalizeVersion(input.version) !== derived) {
        throw new RegistryError(
          'invalid-version',
          `opts.version ${JSON.stringify(normalizeVersion(input.version))} does not match the version ` +
            `${JSON.stringify(derived)} derived from package name '${ir.name}'`,
        );
      }
      version = derived;
    } else {
      if (input.version === undefined) {
        throw new RegistryError(
          'invalid-version',
          `Package name '${ir.name}' has no version segment; supply an explicit version`,
        );
      }
      version = normalizeVersion(input.version);
    }

    const hash = hashPackage(ir);
    const projects = this.orgs.get(org);
    const state = projects?.get(project);
    const existing = state?.get(base)?.get(version);
    if (existing !== undefined) {
      if (existing.meta.hash !== hash) {
        throw new RegistryError(
          'immutable',
          `${base}@${version} is already published with different content ` +
            `(stored ${existing.meta.hash}, incoming ${hash}). Published versions are immutable — ` +
            'publish a new version instead.',
        );
      }
      return { outcome: 'replayed', meta: existing.meta };
    }

    const meta = buildMeta(input, base, version, hash);
    if (state === undefined) {
      const projectState: ProjectState = new Map([[base, new Map([[version, { meta, ir }]])]]);
      if (projects === undefined) {
        this.orgs.set(org, new Map([[project, projectState]]));
      } else {
        projects.set(project, projectState);
      }
    } else {
      const byBase = state.get(base);
      if (byBase === undefined) state.set(base, new Map([[version, { meta, ir }]]));
      else byBase.set(version, { meta, ir });
    }
    return { outcome: 'created', meta };
  }

  // ------------------------------------------------------------------- reads

  public async pull(org: string, project: string, contract: string, version: string): Promise<StoredContract> {
    const { base, version: ver } = requireLookupCoordinates(org, project, contract, version);
    const entry = this.requireEntry(org, project, base, ver!);
    this.assertIntegrity(entry);
    return { ir: entry.ir as never, meta: entry.meta };
  }

  public async inspect(org: string, project: string, contract: string, version: string): Promise<ContractMeta> {
    const { base, version: ver } = requireLookupCoordinates(org, project, contract, version);
    return this.requireEntry(org, project, base, ver!).meta;
  }

  public async latest(org: string, project: string, contract: string): Promise<ContractMeta> {
    const { base } = requireLookupCoordinates(org, project, contract);
    const versions = await this.versions(org, project, base);
    const newest = versions.at(-1);
    if (newest === undefined) {
      throw new RegistryError('not-found', `No versions published for contract '${contract}'`);
    }
    return this.requireEntry(org, project, base, newest).meta;
  }

  public async versions(org: string, project: string, contract: string): Promise<string[]> {
    const { base } = requireLookupCoordinates(org, project, contract);
    const state = this.orgs.get(org)?.get(project)?.get(base);
    if (state === undefined) return [];
    return [...state.keys()].sort(compareVersions);
  }

  public async list(org: string, project: string): Promise<ContractMeta[]> {
    assertCoordinates(org, project);
    const state = this.orgs.get(org)?.get(project);
    if (state === undefined) return [];
    const latestByBase: ContractMeta[] = [];
    for (const [base, byVersion] of state) {
      const versions = [...byVersion.keys()].sort(compareVersions);
      const newest = versions.at(-1);
      if (newest === undefined) continue;
      latestByBase.push(byVersion.get(newest)!.meta);
    }
    latestByBase.sort((a, b) => (a.base < b.base ? -1 : a.base > b.base ? 1 : 0));
    return latestByBase;
  }

  public async search(org: string | null, project: string | null, query: string): Promise<ContractMeta[]> {
    if (org !== null) assertOrgOrProject(org, 'org');
    if (project !== null) assertOrgOrProject(project, 'project');
    if (typeof query !== 'string') throw new TypeError('search(): query must be a string');
    const q = query.toLowerCase();
    const out: ContractMeta[] = [];
    for (const [o, projects] of this.orgs) {
      if (org !== null && o !== org) continue;
      for (const [p, state] of projects) {
        if (project !== null && p !== project) continue;
        for (const byVersion of state.values()) {
          for (const entry of byVersion.values()) {
            if (matches(entry.meta, q)) out.push(entry.meta);
          }
        }
      }
    }
    out.sort((a, b) =>
      a.org !== b.org
        ? a.org < b.org
          ? -1
          : 1
        : a.base !== b.base
          ? a.base < b.base
            ? -1
            : 1
          : compareVersions(a.version, b.version),
    );
    return out;
  }

  // ------------------------------------------------------------------- graph

  public async dependents(org: string, project: string, contract: string): Promise<ContractMeta[]> {
    const { base } = requireLookupCoordinates(org, project, contract);
    const state = this.orgs.get(org)?.get(project);
    if (state === undefined) return [];
    const out: ContractMeta[] = [];
    for (const [b, byVersion] of state) {
      if (b === base) continue; // a contract is never its own dependent
      for (const entry of byVersion.values()) {
        // Imports are recorded as full package names ('payments.v1'); a
        // dependency matches when the import equals the route name or its
        // base equals the route base.
        const matches = entry.meta.imports.some(
          (imp) => imp === contract || splitPackageVersion(imp).base === base,
        );
        if (matches) {
          out.push(entry.meta);
        }
      }
    }
    out.sort((a, b) =>
      a.base !== b.base ? (a.base < b.base ? -1 : 1) : compareVersions(a.version, b.version),
    );
    return out;
  }

  public async dependencies(
    org: string,
    project: string,
    contract: string,
    version?: string,
  ): Promise<string[]> {
    const coords = requireLookupCoordinates(org, project, contract, version);
    const rootVersion =
      coords.version ??
      (await (async () => {
        const versions = await this.versions(org, project, coords.base);
        const newest = versions.at(-1);
        if (newest === undefined) {
          throw new RegistryError('not-found', `No versions published for contract '${contract}'`);
        }
        return newest;
      })());
    const root = this.requireEntry(org, project, coords.base, rootVersion);

    const seenNames = new Set<string>([root.meta.packageName, root.meta.base]);
    const seenKeys = new Set<string>([`${coords.base}@${rootVersion}`]);
    const result: string[] = [];
    const queue: string[] = [...root.meta.imports];
    while (queue.length > 0) {
      const name = queue.shift();
      if (name === undefined || name === '') break;
      if (seenNames.has(name)) continue;
      seenNames.add(name);
      result.push(name);
      const dep = this.findImport(org, project, name);
      if (dep === null) continue; // unpublished dependency: report, don't traverse
      if (seenKeys.has(`${dep.base}@${dep.version}`)) continue;
      seenKeys.add(`${dep.base}@${dep.version}`);
      for (const imp of dep.entry.meta.imports) {
        if (!seenNames.has(imp)) queue.push(imp);
      }
    }
    return result;
  }

  // ------------------------------------------------------------------- audit

  public async appendAudit(entry: AuditEntry): Promise<void> {
    this.audit.push(entry);
    if (this.audit.length > this.auditCapacity) {
      this.audit.splice(0, this.audit.length - this.auditCapacity);
    }
  }

  public async queryAudit(filter: AuditFilter): Promise<AuditEntry[]> {
    return applyAuditFilter(this.audit, filter);
  }

  // ----------------------------------------------------------------- private

  private requireEntry(org: string, project: string, base: string, version: string): Entry {
    assertCoordinates(org, project);
    if (!isValidOrgOrProject(org) || !isValidOrgOrProject(project)) {
      throw new RegistryError('invalid-name', 'org and project must be lowercase slugs');
    }
    const entry = this.orgs.get(org)?.get(project)?.get(base)?.get(version);
    if (entry === undefined) {
      throw new RegistryError('not-found', `No contract '${base}' at version '${version}' in ${org}/${project}`);
    }
    return entry;
  }

  private assertIntegrity(entry: Entry): void {
    const actual = hashPackage(entry.ir as never);
    if (actual !== entry.meta.hash) {
      throw new RegistryError(
        'corrupt',
        `stored content hash ${actual} does not match recorded hash ${entry.meta.hash} — stored data was tampered with`,
      );
    }
  }

  /** Resolve an import reference (full name or bare base) to its entry. */
  private findImport(
    org: string,
    project: string,
    name: string,
  ): { base: string; version: string; entry: Entry } | null {
    const state = this.orgs.get(org)?.get(project);
    if (state === undefined) return null;
    const { base, version: derived } = splitPackageVersion(name);
    if (derived !== '') {
      const entry = state.get(base)?.get(derived);
      return entry === undefined ? null : { base, version: derived, entry };
    }
    const byVersion = state.get(base);
    if (byVersion === undefined || byVersion.size === 0) return null;
    const versions = [...byVersion.keys()].sort(compareVersions);
    const newest = versions.at(-1)!;
    return { base, version: newest, entry: byVersion.get(newest)! };
  }
}

function matches(meta: ContractMeta, q: string): boolean {
  if (meta.packageName.toLowerCase().includes(q)) return true;
  if (meta.base.toLowerCase().includes(q)) return true;
  if (meta.publishedBy !== undefined && meta.publishedBy.toLowerCase().includes(q)) return true;
  if (meta.description !== undefined && meta.description.toLowerCase().includes(q)) return true;
  if (meta.repository !== undefined && meta.repository.toLowerCase().includes(q)) return true;
  if (meta.publishedBy !== undefined && meta.publishedBy.toLowerCase().includes(q)) return true;
  return false;
}
