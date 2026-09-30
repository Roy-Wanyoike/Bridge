/**
 * Token-bucket rate limiting.
 *
 * Two independent buckets guard the API:
 * - the **auth tier** — one token per request on every rate-limited /v1
 *   route, keyed by client IP (absorbs token-guessing floods);
 * - the **publish tier** — an extra token per publish request, keyed by
 *   `<principal>|<ip>` (a compromised credential cannot exhaust publishing
 *   for other principals from the same IP).
 *
 * Buckets refill continuously (`refillPerSecond` tokens per second up to
 * `capacity`). When a bucket is empty the caller receives 429 with a
 * `Retry-After` header of the whole seconds until one token is available.
 *
 * The clock is injectable (`now`) so tests can drive refills deterministically.
 * Stale buckets are swept two ways to bound memory (issue #120): lazily when
 * a `take` fails past {@link SWEEP_THRESHOLD}, and on a wall-clock timer
 * every {@link SWEEP_INTERVAL_MS} — lazily-only was not enough, because the
 * sweep used to run exclusively on FAILED takes, so fresh unique keys (IPv6
 * spray) allocated buckets that nothing ever visited again. A hard cap
 * ({@link MAX_BUCKETS}) with oldest-first eviction is the last-resort bound.
 */

import type { RateLimitConfig, RateLimitOptions } from './types';

export interface RateLimitDecision {
  ok: boolean;
  /** Seconds until one token is available (whole seconds, ≥ 1) when !ok. */
  retryAfterSeconds: number;
  /** Configured capacity of the bucket (for RateLimit-* headers). */
  limit: number;
  /** Tokens remaining after the decision (floor, ≥ 0). */
  remaining: number;
}

export type RateLimitTier = 'auth' | 'publish';

const DEFAULTS: Readonly<Record<RateLimitTier, RateLimitConfig>> = {
  auth: { capacity: 120, refillPerSecond: 30 },
  publish: { capacity: 30, refillPerSecond: 5 },
};

/** Buckets idle for longer than this are dropped by the sweep. */
export const SWEEP_IDLE_MS = 60 * 60 * 1000;
/** Sweep threshold (number of tracked buckets) that triggers a lazy sweep. */
const SWEEP_THRESHOLD = 10_000;
/**
 * Wall-clock interval between background sweeps (issue #120). The timer is
 * `unref()`-ed so it never keeps a process alive; 60s bounds worst-case
 * memory growth (≈30 refills/s × unique keys) without meaningful cost.
 */
export const SWEEP_INTERVAL_MS = 60_000;
/**
 * Hard cap on tracked buckets (issue #120). Reaching it first triggers an
 * idle sweep; if the cap is still exceeded, the OLDEST buckets (smallest
 * `lastMs`) are evicted until back under the cap.
 */
export const MAX_BUCKETS = 50_000;

interface Bucket {
  tokens: number;
  lastMs: number;
}

export class TokenBucketLimiter {
  private readonly auth: RateLimitConfig;
  private readonly publish: RateLimitConfig;
  private readonly enabled: boolean;
  private readonly now: () => number;
  private readonly buckets = new Map<string, Bucket>();
  private timer: NodeJS.Timeout | undefined;

  constructor(options: RateLimitOptions = {}) {
    this.enabled = options.enabled !== false;
    this.now = options.now ?? (() => Date.now());
    this.auth = normalize(options.auth ?? DEFAULTS.auth, DEFAULTS.auth);
    this.publish = normalize(options.publish ?? DEFAULTS.publish, DEFAULTS.publish);
    // Timer-based sweep (issue #120): buckets are created for every fresh
    // key that passes a `take`, including keys that never fail, so the old
    // failed-take-only lazy sweep let IPv6-spray style floods grow the map
    // unboundedly. Disabled limiters never allocate buckets → no timer.
    if (this.enabled) {
      this.timer = setInterval(() => {
        this.sweepAt(this.now());
      }, SWEEP_INTERVAL_MS);
      this.timer.unref();
    }
  }

  /** Configured capacity for a tier (exposed for tests and headers). */
  public capacityFor(tier: RateLimitTier): number {
    return tier === 'auth' ? this.auth.capacity : this.publish.capacity;
  }

  /**
   * Consume one token from the tier bucket for `key`.
   * Always succeeds when the limiter is disabled.
   */
  public take(tier: RateLimitTier, key: string): RateLimitDecision {
    if (!this.enabled) return { ok: true, retryAfterSeconds: 0, limit: 0, remaining: 0 };
    const cfg = tier === 'auth' ? this.auth : this.publish;
    const t = this.now();
    const bucket = this.buckets.get(key);
    let tokens: number;
    let lastMs: number;
    if (bucket === undefined) {
      // Fresh bucket starts full; the first request still consumes a token.
      tokens = cfg.capacity;
      lastMs = t;
    } else {
      const elapsedSeconds = Math.max(0, (t - bucket.lastMs) / 1000);
      tokens = Math.min(cfg.capacity, bucket.tokens + elapsedSeconds * cfg.refillPerSecond);
      lastMs = t;
    }
    if (tokens >= 1) {
      tokens -= 1;
      const grew = bucket === undefined;
      this.buckets.set(key, { tokens, lastMs });
      if (grew && this.buckets.size > MAX_BUCKETS) this.enforceHardCap(t);
      return {
        ok: true,
        retryAfterSeconds: 0,
        limit: cfg.capacity,
        remaining: Math.max(0, Math.floor(tokens)),
      };
    }
    this.buckets.set(key, { tokens, lastMs });
    const deficit = 1 - tokens;
    const retryAfter = Math.max(1, Math.ceil(deficit / cfg.refillPerSecond));
    this.maybeSweep(t);
    return { ok: false, retryAfterSeconds: retryAfter, limit: cfg.capacity, remaining: 0 };
  }

  /**
   * Sweep idle buckets now (instead of waiting for the timer or a failed
   * take). Returns the number of buckets dropped (tests/introspection).
   */
  public sweepNow(): number {
    return this.sweepAt(this.now());
  }

  /** Buckets currently tracked (tests/introspection). */
  public get bucketCount(): number {
    return this.buckets.size;
  }

  /** Whether a bucket exists for `key` (tests/introspection). */
  public hasBucket(key: string): boolean {
    return this.buckets.has(key);
  }

  /** Stop the background sweep timer (tests; unnecessary for unref-ed timers). */
  public dispose(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Drop buckets idle for over an hour, relative to `t`. */
  private sweepAt(t: number): number {
    let removed = 0;
    for (const [key, bucket] of this.buckets) {
      if (t - bucket.lastMs > SWEEP_IDLE_MS) {
        this.buckets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** Drop buckets that have been idle for over an hour (lazy sweep). */
  private maybeSweep(t: number): void {
    if (this.buckets.size < SWEEP_THRESHOLD) return;
    this.sweepAt(t);
  }

  /**
   * Last-resort bound (issue #120): prefer evicting idle buckets, then the
   * OLDEST live buckets (smallest `lastMs`), until back under the cap.
   */
  private enforceHardCap(t: number): void {
    this.sweepAt(t);
    if (this.buckets.size <= MAX_BUCKETS) return;
    const excess = this.buckets.size - MAX_BUCKETS;
    const byAge = [...this.buckets.entries()].sort((a, b) => a[1].lastMs - b[1].lastMs);
    for (let i = 0; i < excess; i++) this.buckets.delete(byAge[i]![0]);
  }
}

function normalize(cfg: RateLimitConfig, fallback: RateLimitConfig): RateLimitConfig {
  const capacity = Number(cfg.capacity);
  const refillPerSecond = Number(cfg.refillPerSecond);
  return {
    capacity:
      Number.isFinite(capacity) && capacity >= 1
        ? Math.min(Math.trunc(capacity), Number.MAX_SAFE_INTEGER)
        : fallback.capacity,
    refillPerSecond:
      Number.isFinite(refillPerSecond) && refillPerSecond > 0
        ? Math.min(refillPerSecond, Number.MAX_SAFE_INTEGER)
        : fallback.refillPerSecond,
  };
}
