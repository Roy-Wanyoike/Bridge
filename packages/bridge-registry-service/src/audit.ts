/**
 * Audit backends.
 *
 * The audit log is append-only and queryable. The server records one entry
 * per rate-limited API request (action reflects the attempted operation;
 * failed authentication/authorization attempts are recorded with
 * `action: 'auth'`), publishing, pulling, admin access — everything.
 *
 * Backends:
 * - {@link DriverAuditBackend} — rows live in the storage driver (in-memory
 *   ring or PostgreSQL), so audit data shares the driver's durability. This
 *   is the server default.
 * - {@link MemoryAuditSink} — standalone ring buffer (bounded).
 * - {@link FileAuditSink} — append-only JSONL file; the file is the source
 *   of truth and entries survive restarts.
 *
 * `query` returns entries newest → oldest. A torn final line in a file
 * (crash mid-append) is skipped on read, never surfaced as an error.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AuditBackend, AuditEntry, AuditFilter, StorageDriver } from './types';

/** Default number of entries returned by a query. */
export const DEFAULT_AUDIT_LIMIT = 100;
/** Upper bound for the `limit` filter. */
export const MAX_AUDIT_LIMIT = 10_000;
/** Ring capacity of the in-memory sink. */
export const MEMORY_SINK_CAPACITY = 10_000;

/** Clamp a requested limit into `[0, MAX_AUDIT_LIMIT]`. */
export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_AUDIT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 0), MAX_AUDIT_LIMIT);
}

/** ISO-8601 UTC `now` in the exact format stored in audit entries. */
export function auditTimestamp(date: Date = new Date()): string {
  return date.toISOString();
}

/** Validate `from`/`to` bounds are ISO-8601; they compare lexicographically. */
function inRange(time: string, filter: AuditFilter): boolean {
  if (filter.from !== undefined && time < filter.from) return false;
  if (filter.to !== undefined && time > filter.to) return false;
  return true;
}

/** Pure filter application over an in-memory entry list (newest → oldest). */
export function applyAuditFilter(entries: readonly AuditEntry[], filter: AuditFilter): AuditEntry[] {
  const limit = clampLimit(filter.limit);
  const out: AuditEntry[] = [];
  for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) {
    const entry = entries[i] as AuditEntry;
    if (filter.actor !== undefined && entry.actor !== filter.actor) continue;
    if (filter.action !== undefined && entry.action !== filter.action) continue;
    if (filter.contract !== undefined && entry.contract !== filter.contract) continue;
    if (filter.org !== undefined && entry.org !== filter.org) {
      // Failed authentications (issue #48) carry no tenant attribution yet —
      // the org is genuinely unknowable before the credential resolves — so
      // they are stored with `org: null` and action 'auth'. They are global
      // security events and stay visible to every admin's org-scoped query;
      // nothing about ANOTHER tenant is revealed (there is no tenant on the
      // row to reveal).
      if (!(entry.org === null && entry.action === 'auth')) continue;
    }
    if (filter.project !== undefined && entry.project !== filter.project) continue;
    if (!inRange(entry.time, filter)) continue;
    out.push(entry);
  }
  return out;
}

/** Audit storage backed by the service's {@link StorageDriver}. */
export class DriverAuditBackend implements AuditBackend {
  public constructor(private readonly driver: StorageDriver) {}

  public append(entry: AuditEntry): void | Promise<void> {
    return this.driver.appendAudit(entry);
  }

  public query(filter: AuditFilter): Promise<AuditEntry[]> {
    return this.driver.queryAudit(filter);
  }
}

/** Bounded in-memory ring (the standalone default). */
export class MemoryAuditSink implements AuditBackend {
  private readonly entries: AuditEntry[] = [];

  public constructor(private readonly capacity: number = MEMORY_SINK_CAPACITY) {}

  public append(entry: AuditEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
  }

  /** Newest → oldest. */
  public async query(filter: AuditFilter): Promise<AuditEntry[]> {
    return applyAuditFilter(this.entries, filter);
  }

  /** All entries in append order (oldest → newest); for tests/introspection. */
  public snapshot(): AuditEntry[] {
    return [...this.entries];
  }
}

/**
 * Append-only JSONL audit file. Appends use `fs.appendFileSync` — no fsync,
 * so a hard crash can lose the tail of the log but never corrupts earlier
 * lines (appends of <4KiB are effectively atomic on local POSIX
 * filesystems). The file is the source of truth: `query` re-reads it, so
 * entries survive restarts.
 */
export class FileAuditSink implements AuditBackend {
  public constructor(public readonly filePath: string) {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new TypeError('FileAuditSink: filePath must be a non-empty string');
    }
    mkdirSync(dirname(filePath), { recursive: true });
  }

  public append(entry: AuditEntry): void {
    appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  /** Newest → oldest, filtered. */
  public async query(filter: AuditFilter): Promise<AuditEntry[]> {
    if (!existsSync(this.filePath)) return [];
    const raw = readFileSync(this.filePath, 'utf8');
    const entries: AuditEntry[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        entries.push(JSON.parse(line) as AuditEntry);
      } catch {
        // Torn line from a crash mid-append: skip, never fail the read.
      }
    }
    return applyAuditFilter(entries, filter);
  }
}

// ------------------------------------------------- auth-flood ring protection

/**
 * Sliding protection for the audit ring against auth floods (issue #120):
 * failed authentications that presented a WELL-FORMED bearer token are
 * persisted as `action: 'auth'` security events, so an unauthenticated
 * flood of garbage-but-well-formed tokens can evict real history from the
 * bounded ring (10k entries). The gate caps how many failed-auth entries
 * ONE client IP may persist per time window; beyond the cap the entry is
 * dropped before it reaches the backend (the HTTP response is unaffected).
 *
 * Design choice — a small dedicated fixed-window map rather than reusing
 * {@link TokenBucketLimiter}: the limiter answers a different question
 * ("may this REQUEST run?") and is globally disable-able via
 * `rateLimit.enabled: false`, which must not disable audit hygiene; its
 * refill semantics (429 + Retry-After) are meaningless for persistence
 * gating, and its buckets are keyed per tier. A fixed window (count
 * failures since the first failure of the current window) is deliberately
 * coarse: the gate bounds ring pollution, it does not need smooth fairness.
 *
 * Memory is bounded twice over: counters expire with their window, and the
 * map is pruned (expired first, then oldest-inserted) when it tracks more
 * than {@link MAX_TRACKED_AUTH_FAILURE_IPS} IPs.
 */
/** Length of one gate window. */
export const AUTH_FAILURE_WINDOW_MS = 60_000;
/** Persisted failed-auth audit entries allowed per IP per window. */
export const AUTH_FAILURE_MAX_PER_WINDOW = 20;
/** Upper bound on IPs tracked simultaneously (memory bound, not policy). */
export const MAX_TRACKED_AUTH_FAILURE_IPS = 10_000;

export class AuthFailureAuditGate {
  private readonly windows = new Map<string, { start: number; count: number }>();

  public constructor(
    /** Injectable clock (ms since epoch) for tests. */
    private readonly now: () => number = () => Date.now(),
    private readonly windowMs: number = AUTH_FAILURE_WINDOW_MS,
    private readonly maxPerWindow: number = AUTH_FAILURE_MAX_PER_WINDOW,
  ) {}

  /**
   * Account one failed-auth audit entry for `ip`; `true` when it may be
   * persisted, `false` when the per-IP window budget is exhausted (drop it).
   */
  public allow(ip: string): boolean {
    const t = this.now();
    if (this.windows.size >= MAX_TRACKED_AUTH_FAILURE_IPS) this.prune(t);
    const window = this.windows.get(ip);
    if (window === undefined || t - window.start >= this.windowMs) {
      // Map insertion order ≈ arrival order, so a forced prune below
      // evicts the least recently active IPs first.
      if (this.windows.size >= MAX_TRACKED_AUTH_FAILURE_IPS) this.windows.delete(this.windows.keys().next().value as string);
      this.windows.set(ip, { start: t, count: 1 });
      return true;
    }
    if (window.count >= this.maxPerWindow) return false;
    window.count += 1;
    return true;
  }

  /** IPs currently tracked (tests/introspection). */
  public get trackedIps(): number {
    return this.windows.size;
  }

  /** Drop expired windows; keep counting when still inside the window. */
  private prune(t: number): void {
    for (const [ip, window] of this.windows) {
      if (t - window.start >= this.windowMs) this.windows.delete(ip);
    }
  }
}
