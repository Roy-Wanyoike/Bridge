/**
 * PostgreSQL {@link StorageDriver}.
 *
 * Uses the zero-dependency wire-protocol client in `./wire` (protocol 3.0,
 * SCRAM-SHA-256 / MD5 / cleartext auth, extended query protocol with
 * text-format parameters) and applies SQL migrations from
 * `migrations/*.sql` via a small transactional runner (each file runs once,
 * tracked in `bridge_schema_migrations`).
 *
 * Semantics mirror the in-memory driver exactly: content-addressed identity
 * (`hashPackage`), idempotent identical republish, `'immutable'` conflict on
 * differing content, and hash re-verification on every pull.
 *
 * Integration is gated behind `PG_DSN` (no PostgreSQL server is available in
 * this environment); everything except the live path is unit-tested.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hashPackage } from '@bridge/core';
import { RegistryError, compareVersions, splitPackageVersion } from '@bridge/registry';
import type {
  AuditEntry,
  AuditFilter,
  ContractMeta,
  PublishInput,
  PublishResult,
  StorageDriver,
  StoredContract,
} from '../../types';
import { assertCoordinates, buildMeta, requireLookupCoordinates } from '../driver';
import { assertOrgOrProject } from '../../validation';
import { PgClient, PgError, parseDsn, type PgConnectOptions } from './wire';

export { PgClient, PgError, parseDsn };
export type { PgConnectOptions };

type Row = Record<string, string | null>;

function isPgError(err: unknown): err is PgError {
  return err instanceof PgError;
}

export interface PostgresDriverOptions {
  /** DSN (`postgres://user:pass@host:port/db?sslmode=…`) or parsed options. */
  dsn?: string;
  options?: PgConnectOptions;
  /** Migrations directory. Defaults to the package `migrations/` folder. */
  migrationsDir?: string;
  connectionTimeoutMs?: number;
  /**
   * Audit retention in days (issue #48): `bridge_audit` rows older than the
   * cutoff are deleted at boot and then swept every {@link RETENTION_SWEEP_INTERVAL_MS}.
   * `undefined` disables pruning (the table grows unbounded — not recommended
   * for long-lived deployments).
   */
  auditRetentionDays?: number;
}

/** How often the retention sweep re-runs while the process is up. */
export const RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Advisory-lock key around the migration runner (issue #48): 'brid' as a
 * 32-bit int (0x62726964). Two instances booting against the same database
 * serialize instead of racing their DDL.
 */
export const MIGRATION_ADVISORY_LOCK_KEY = 0x6272_6964;
export const MIGRATION_ADVISORY_LOCK_SQL = `SELECT pg_advisory_lock(${MIGRATION_ADVISORY_LOCK_KEY})`;
export const MIGRATION_ADVISORY_UNLOCK_SQL = `SELECT pg_advisory_unlock(${MIGRATION_ADVISORY_LOCK_KEY})`;

export class PostgresDriver implements StorageDriver {
  public readonly kind = 'postgres' as const;
  private readonly connectOptions: PgConnectOptions;
  private readonly migrationsDir: string;
  private readonly auditRetentionDays: number | undefined;
  private client: PgClient | null = null;
  private connecting: Promise<PgClient> | null = null;
  private retentionTimer: NodeJS.Timeout | null = null;

  public constructor(opts: PostgresDriverOptions = {}) {
    if (opts.dsn !== undefined) {
      const parsed = parseDsn(opts.dsn);
      if (parsed.sslDefaulted) {
        console.warn(
          '[bridge-registry-service] PG_DSN has no sslmode; defaulting to sslmode=prefer ' +
            '(TLS when the server supports it). Set sslmode=require for production.',
        );
      }
      this.connectOptions = { ...parsed, connectionTimeoutMs: opts.connectionTimeoutMs };
    } else if (opts.options !== undefined) {
      this.connectOptions = { ...opts.options, connectionTimeoutMs: opts.connectionTimeoutMs };
    } else {
      throw new TypeError('PostgresDriver: dsn or options is required');
    }
    this.migrationsDir = opts.migrationsDir ?? resolve(__dirname, '..', '..', '..', 'migrations');
    if (opts.auditRetentionDays !== undefined) {
      if (!Number.isInteger(opts.auditRetentionDays) || opts.auditRetentionDays < 1) {
        throw new TypeError('PostgresDriver: auditRetentionDays must be an integer >= 1');
      }
    }
    this.auditRetentionDays = opts.auditRetentionDays;
  }

  /** Lazily open (or reuse) the single connection used by the driver. */
  private async conn(): Promise<PgClient> {
    if (this.client !== null) return this.client;
    if (this.connecting === null) {
      this.connecting = PgClient.connect(this.connectOptions)
        .then((client) => {
          this.client = client;
          this.connecting = null;
          return client;
        })
        .catch((err) => {
          this.connecting = null;
          throw err instanceof PgError
            ? err
            : new RegistryError('io', `postgres: could not connect: ${(err as Error).message}`);
        });
    }
    return this.connecting;
  }

  // ------------------------------------------------------------- migrations

  /** Apply any unapplied `migrations/*.sql` files, each in its own transaction. */
  public async init(): Promise<void> {
    const client = await this.conn();
    // Advisory lock (issue #48): serialize concurrent boots against the same
    // database so two instances cannot race the DDL. The lock is session-
    // scoped and released in `finally` (a dead connection releases it too).
    await client.query(MIGRATION_ADVISORY_LOCK_SQL);
    try {
      await this.runMigrations(client);
    } finally {
      try {
        await client.query(MIGRATION_ADVISORY_UNLOCK_SQL);
      } catch {
        /* connection may already be gone — session locks die with it */
      }
    }
    if (this.auditRetentionDays !== undefined) {
      // Retention (issue #48): a first sweep right after boot, then a
      // periodic one for long-lived processes. Never fails the boot.
      try {
        const deleted = await this.pruneAudit();
        if (deleted > 0) console.log(`[bridge-registry-service] audit retention: pruned ${deleted} row(s) older than ${this.auditRetentionDays}d`);
      } catch (err) {
        console.error(`[bridge-registry-service] audit retention sweep failed: ${(err as Error).message}`);
      }
      if (this.retentionTimer === null) {
        this.retentionTimer = setInterval(() => {
          this.pruneAudit().catch((err: unknown) => {
            console.error(`[bridge-registry-service] audit retention sweep failed: ${(err as Error).message}`);
          });
        }, RETENTION_SWEEP_INTERVAL_MS);
        this.retentionTimer.unref();
      }
    }
  }

  /** Migration body; caller holds the advisory lock. */
  private async runMigrations(client: PgClient): Promise<void> {
    await client.simpleQuery(
      'CREATE TABLE IF NOT EXISTS bridge_schema_migrations (' +
        'name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const appliedRows = await client.query('SELECT name FROM bridge_schema_migrations');
    const applied = new Set(appliedRows.rows.map((row) => row['name']));
    const files = readdirSync(this.migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(join(this.migrationsDir, file), 'utf8');
      try {
        await client.simpleQuery('BEGIN');
        await client.simpleQuery(sql);
        await client.query('INSERT INTO bridge_schema_migrations (name) VALUES ($1)', [file]);
        await client.simpleQuery('COMMIT');
      } catch (err) {
        try {
          await client.simpleQuery('ROLLBACK');
        } catch {
          /* connection may already be gone */
        }
        throw err;
      }
    }
  }

  public async close(): Promise<void> {
    if (this.retentionTimer !== null) {
      clearInterval(this.retentionTimer);
      this.retentionTimer = null;
    }
    if (this.client !== null) {
      const client = this.client;
      this.client = null;
      await client.close();
    }
  }

  /**
   * Delete audit rows older than `auditRetentionDays` (issue #48 retention).
   * Returns the number of rows deleted. Throws when no retention window is
   * configured.
   */
  public async pruneAudit(): Promise<number> {
    if (this.auditRetentionDays === undefined) {
      throw new TypeError('PostgresDriver: pruneAudit() requires auditRetentionDays to be configured');
    }
    const cutoff = new Date(Date.now() - this.auditRetentionDays * 86_400_000).toISOString();
    const client = await this.conn();
    // `time` is ISO-8601 UTC text — lexicographic comparison is chronological
    // (see 0001_init.sql), same convention the audit query filters use.
    const result = await client.query('DELETE FROM bridge_audit WHERE time < $1', [cutoff]);
    return result.rowCount ?? 0;
  }

  // ----------------------------------------------------------------- publish

  public async publish(input: PublishInput): Promise<PublishResult> {
    const { org, project } = assertCoordinates(input.org, input.project);
    const client = await this.conn();
    const ir = input.ir;
    if (typeof ir?.name !== 'string') {
      throw new RegistryError('invalid-name', 'publish(): ir.name must be a string');
    }
    const { base, version: derived } = splitPackageVersion(ir.name);
    let version: string;
    if (derived !== '') {
      if (input.version !== undefined) version = requireVersionMatch(input.version, derived);
      else version = derived;
    } else if (input.version !== undefined) {
      version = normalizeVersionText(input.version);
    } else {
      throw new RegistryError(
        'invalid-version',
        `Package name '${ir.name}' has no version segment; supply an explicit version`,
      );
    }

    const existing = await this.findByExactKey(org, project, base, version);
    if (existing !== null) {
      if (existing.hash !== hashPackage(ir)) {
        throw new RegistryError(
          'immutable',
          `${base}@${version} is already published with different content ` +
            `(stored ${existing.hash}, incoming ${hashPackage(ir)}). Published versions are immutable.`,
        );
      }
      return { outcome: 'replayed', meta: existing };
    }

    const hash = hashPackage(ir);
    const meta = buildMeta(input, base, version, hash);
    try {
      await client.query(
        'INSERT INTO bridge_contracts ' +
          '(org, project, base, version, package_name, hash, ir, meta, imports, published_at, published_by) ' +
          'VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11)',
        [
          org,
          project,
          base,
          version,
          ir.name,
          hash,
          JSON.stringify(ir),
          JSON.stringify({ description: meta.description, repository: meta.repository }),
          JSON.stringify(meta.imports),
          meta.publishedAt,
          meta.publishedBy ?? null,
        ],
      );
      return { outcome: 'created', meta };
    } catch (err) {
      // Unique-violation: a concurrent publish landed first; resolve like the
      // pre-check would have (identical → replay, differing → immutable).
      if (isPgError(err) && err.code === '23505') {
        const raced = await this.findByExactKey(org, project, base, version);
        if (raced !== null && raced.hash === hash) return { outcome: 'replayed', meta: raced };
        throw new RegistryError(
          'immutable',
          `${base}@${version} is already published with different content. Published versions are immutable.`,
        );
      }
      throw err;
    }
  }

  // ------------------------------------------------------------------- reads

  public async pull(org: string, project: string, contract: string, version: string): Promise<StoredContract> {
    const coords = requireLookupCoordinates(org, project, contract, version);
    const row = await this.requireRow(coords.org, coords.project, coords.base, coords.version!);
    const meta = rowToMeta(row, coords.org, coords.project);
    const ir = parseIr(row['ir'] ?? null, meta);
    return { ir, meta };
  }

  public async inspect(org: string, project: string, contract: string, version: string): Promise<ContractMeta> {
    const coords = requireLookupCoordinates(org, project, contract, version);
    const row = await this.requireRow(coords.org, coords.project, coords.base, coords.version!);
    return rowToMeta(row, coords.org, coords.project);
  }

  public async latest(org: string, project: string, contract: string): Promise<ContractMeta> {
    const coords = requireLookupCoordinates(org, project, contract);
    const row = await this.latestRow(coords.org, coords.project, coords.base);
    if (row === null) {
      throw new RegistryError('not-found', `No versions published for contract '${contract}'`);
    }
    return rowToMeta(row, coords.org, coords.project);
  }

  public async versions(org: string, project: string, contract: string): Promise<string[]> {
    const coords = requireLookupCoordinates(org, project, contract);
    const client = await this.conn();
    const result = await client.query(
      'SELECT version FROM bridge_contracts WHERE org = $1 AND project = $2 AND base = $3 ' +
        'ORDER BY (substring(version from 2))::bigint ASC',
      [coords.org, coords.project, coords.base],
    );
    return result.rows.map((row) => row['version'] as string);
  }

  public async list(org: string, project: string): Promise<ContractMeta[]> {
    assertCoordinates(org, project);
    const client = await this.conn();
    const result = await client.query(
      'SELECT DISTINCT ON (base) org, project, base, version, package_name, hash, meta, imports, published_at, published_by ' +
        'FROM bridge_contracts WHERE org = $1 AND project = $2 ' +
        'ORDER BY base, (substring(version from 2))::bigint DESC',
      [org, project],
    );
    const out = result.rows.map((row) => rowToMeta(row, org, project));
    out.sort((a, b) => (a.base < b.base ? -1 : a.base > b.base ? 1 : 0));
    return out;
  }

  public async search(org: string | null, project: string | null, query: string): Promise<ContractMeta[]> {
    if (org !== null) assertOrgOrProject(org, 'org');
    if (project !== null) assertOrgOrProject(project, 'project');
    if (typeof query !== 'string') throw new TypeError('search(): query must be a string');
    const client = await this.conn();
    const like = `%${query.replace(/([\\%_])/g, '\\$1')}%`;
    const result = await client.query(
      'SELECT org, project, base, version, package_name, hash, meta, imports, published_at, published_by ' +
        'FROM bridge_contracts ' +
        'WHERE ($1::text IS NULL OR org = $1) AND ($2::text IS NULL OR project = $2) ' +
        'AND (package_name ILIKE $3 OR base ILIKE $3 ' +
        "     OR meta->>'description' ILIKE $3 OR meta->>'repository' ILIKE $3) " +
        'ORDER BY org, base, (substring(version from 2))::bigint',
      [org, project, like],
    );
    return result.rows.map((row) => rowToMeta(row, row['org'] as string, row['project'] as string));
  }

  // ------------------------------------------------------------------- graph

  public async dependents(org: string, project: string, contract: string): Promise<ContractMeta[]> {
    const coords = requireLookupCoordinates(org, project, contract);
    const client = await this.conn();
    // Imports are full package names ('payments.v1'); the base-vs-full-name
    // match is done in JS so both spellings are covered.
    const result = await client.query(
      'SELECT org, project, base, version, package_name, hash, meta, imports, published_at, published_by ' +
        'FROM bridge_contracts ' +
        'WHERE org = $1 AND project = $2 AND base <> $3 ' +
        'ORDER BY base, (substring(version from 2))::bigint',
      [coords.org, coords.project, coords.base],
    );
    return result.rows
      .filter((row) => {
        const imports = row['imports'];
        if (typeof imports !== 'string') return false;
        let parsed: unknown;
        try {
          parsed = JSON.parse(imports);
        } catch {
          return false;
        }
        if (!Array.isArray(parsed)) return false;
        return parsed.some(
          (imp) =>
            imp === contract ||
            (typeof imp === 'string' && splitPackageVersion(imp).base === coords.base),
        );
      })
      .map((row) => rowToMeta(row, coords.org, coords.project));
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
    const row = await this.requireRow(coords.org, coords.project, coords.base, rootVersion);
    const rootMeta = rowToMeta(row, coords.org, coords.project);

    const seenNames = new Set<string>([rootMeta.packageName, rootMeta.base]);
    const seenKeys = new Set<string>([`${coords.base}@${rootVersion}`]);
    const result: string[] = [];
    const queue: string[] = [...rootMeta.imports];
    while (queue.length > 0) {
      const name = queue.shift();
      if (name === undefined || name === '') break;
      if (seenNames.has(name)) continue;
      seenNames.add(name);
      result.push(name);
      const dep = await this.findImport(coords.org, coords.project, name);
      if (dep === null) continue;
      if (seenKeys.has(`${dep.base}@${dep.version}`)) continue;
      seenKeys.add(`${dep.base}@${dep.version}`);
      for (const imp of dep.imports) {
        if (!seenNames.has(imp)) queue.push(imp);
      }
    }
    return result;
  }

  // ------------------------------------------------------------------- audit

  public async appendAudit(entry: AuditEntry): Promise<void> {
    const client = await this.conn();
    const result = await client.query(
      'INSERT INTO bridge_audit (time, org, project, actor, action, contract, version, ok, status, ip, details) ' +
        'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb) RETURNING id',
      [
        entry.time,
        entry.org,
        entry.project,
        entry.actor,
        entry.action,
        entry.contract,
        entry.version,
        entry.ok,
        entry.status,
        entry.ip,
        JSON.stringify(entry.details ?? null),
      ],
    );
    const id = result.rows[0]?.['id'];
    if (typeof id === 'string' && /^\d+$/.test(id)) entry.id = Number(id);
  }

  public async queryAudit(filter: AuditFilter): Promise<AuditEntry[]> {
    const client = await this.conn();
    const clauses: string[] = [];
    const params: unknown[] = [];
    const add = (clause: string, value: unknown): void => {
      params.push(value);
      clauses.push(clause.replace('$?', `$${params.length}`));
    };
    if (filter.actor !== undefined) add('actor = $?', filter.actor);
    if (filter.action !== undefined) add('action = $?', filter.action);
    if (filter.contract !== undefined) add('contract = $?', filter.contract);
    if (filter.org !== undefined) {
      // Failed authentications (issue #48) are stored with org NULL (the
      // tenant is unknowable before the credential resolves) and stay
      // visible inside every org-scoped query as global security events.
      // Mirrors the in-memory filter in audit.ts.
      add("(org = $? OR (org IS NULL AND action = 'auth'))", filter.org);
    }
    if (filter.project !== undefined) add('project = $?', filter.project);
    if (filter.from !== undefined) add('time >= $?', filter.from);
    if (filter.to !== undefined) add('time <= $?', filter.to);

    const limit = Math.min(
      Math.max(Math.trunc(Number.isFinite(filter.limit ?? NaN) ? (filter.limit as number) : 100), 0),
      10_000,
    );
    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await client.query(
      `SELECT id, time, org, project, actor, action, contract, version, ok, status, ip, details ` +
        `FROM bridge_audit ${whereSql} ORDER BY time DESC, id DESC LIMIT ${limit}`,
      params,
    );
    return result.rows.map(rowToAuditEntry);
  }

  // ----------------------------------------------------------------- private

  private async findByExactKey(
    org: string,
    project: string,
    base: string,
    version: string,
  ): Promise<ContractMeta | null> {
    const client = await this.conn();
    const result = await client.query(
      'SELECT org, project, base, version, package_name, hash, meta, imports, published_at, published_by ' +
        'FROM bridge_contracts WHERE org = $1 AND project = $2 AND base = $3 AND version = $4',
      [org, project, base, version],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToMeta(row, org, project);
  }

  private async requireRow(
    org: string,
    project: string,
    base: string,
    version: string,
  ): Promise<Row> {
    const client = await this.conn();
    const result = await client.query(
      'SELECT ir, meta, package_name, hash, base, version, published_at, published_by ' +
        'FROM bridge_contracts WHERE org = $1 AND project = $2 AND base = $3 AND version = $4',
      [org, project, base, version],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new RegistryError('not-found', `No contract '${base}' at version '${version}' in ${org}/${project}`);
    }
    return row;
  }

  private async latestRow(org: string, project: string, base: string): Promise<Row | null> {
    const client = await this.conn();
    const result = await client.query(
      'SELECT DISTINCT ON (base) ir, meta, package_name, hash, base, version, published_at, published_by ' +
        'FROM bridge_contracts WHERE org = $1 AND project = $2 AND base = $3 ' +
        'ORDER BY base, (substring(version from 2))::bigint DESC',
      [org, project, base],
    );
    return result.rows[0] ?? null;
  }

  /** Resolve an import reference (full name or bare base) to its meta. */
  private async findImport(
    org: string,
    project: string,
    name: string,
  ): Promise<{ base: string; version: string; imports: string[] } | null> {
    const client = await this.conn();
    const result = await client.query(
      'SELECT DISTINCT ON (base) base, version, imports FROM bridge_contracts ' +
        'WHERE org = $1 AND project = $2 AND (package_name = $3 OR base = $3) ' +
        'ORDER BY base, (substring(version from 2))::bigint DESC',
      [org, project, name],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      base: row['base'] as string,
      version: row['version'] as string,
      imports: JSON.parse(row['imports'] as string) as string[],
    };
  }
}

// ------------------------------------------------------------------ helpers

function normalizeVersionText(version: string): string {
  const normalized = `v${version.replace(/^v?(\d+)$/i, '$1')}`;
  if (!/^v\d+$/.test(normalized)) {
    throw new RegistryError('invalid-version', `Invalid version ${JSON.stringify(version)}`);
  }
  return normalized;
}

function requireVersionMatch(given: string, derived: string): string {
  const normalized = normalizeVersionText(given);
  if (normalized !== derived) {
    throw new RegistryError(
      'invalid-version',
      `opts.version ${JSON.stringify(normalized)} does not match the version ${JSON.stringify(derived)} from the package name`,
    );
  }
  return derived;
}

function rowToMeta(row: Row, org: string, project: string): ContractMeta {
  const hash = row['hash'] as string;
  const extras = JSON.parse(row['meta'] ?? '{}') as { description?: string; repository?: string };
  const meta: ContractMeta = {
    org,
    project,
    packageName: row['package_name'] as string,
    base: row['base'] as string,
    version: row['version'] as string,
    hash,
    shortHash: hash.slice(0, 12),
    imports: JSON.parse(row['imports'] ?? '[]') as string[],
    publishedAt: row['published_at'] as string,
  };
  if (typeof row['published_by'] === 'string') meta.publishedBy = row['published_by'];
  if (extras.description !== undefined) meta.description = extras.description;
  if (extras.repository !== undefined) meta.repository = extras.repository;
  return meta;
}

/** Parse stored IR text and verify content integrity (tamper detection). */
function parseIr(text: string | null, meta: ContractMeta): never | import('@bridge/core').IRPackage {
  if (text === null) {
    throw new RegistryError('corrupt', `stored IR for ${meta.packageName}@${meta.version} is NULL`);
  }
  let ir: unknown;
  try {
    ir = JSON.parse(text);
  } catch {
    throw new RegistryError('corrupt', `stored IR for ${meta.packageName}@${meta.version} is not valid JSON`);
  }
  if (typeof ir !== 'object' || ir === null) {
    throw new RegistryError('corrupt', `stored IR for ${meta.packageName}@${meta.version} is not an object`);
  }
  const actual = hashPackage(ir as never);
  if (actual !== meta.hash) {
    throw new RegistryError(
      'corrupt',
      `stored content hash ${actual} does not match recorded hash ${meta.hash} — stored data was tampered with`,
    );
  }
  return ir as never;
}

function rowToAuditEntry(row: Row): AuditEntry {
  const detailsRaw = row['details'];
  const entry: AuditEntry = {
    id: row['id'] !== null && /^\d+$/.test(row['id'] as string) ? Number(row['id']) : undefined,
    time: row['time'] as string,
    org: row['org'] ?? null,
    project: row['project'] ?? null,
    actor: row['actor'] ?? null,
    action: row['action'] as string,
    contract: row['contract'] ?? null,
    version: row['version'] ?? null,
    ok: row['ok'] === 't',
    status: Number(row['status']),
    ip: row['ip'] ?? null,
  };
  if (detailsRaw !== null && detailsRaw !== undefined) {
    const parsed: unknown = JSON.parse(detailsRaw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      entry.details = parsed as Record<string, unknown>;
    }
  }
  return entry;
}
