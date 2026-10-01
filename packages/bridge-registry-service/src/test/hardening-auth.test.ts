/**
 * Hardening tests for issue #120 (registry-service, part B):
 *
 * - item 6: loopback default bind + loud non-loopback bind warning
 * - item 7: static-token entropy floor wired through the CLI options builder
 * - item 8: postgres audit retention ON by default (PG-gated integration)
 *
 * Unit coverage for the library-level pieces lives next to the existing
 * suites (auth.test.ts, validation.test.ts, driver.test.ts); this file owns
 * the bin-level wiring and the PG-gated integration case, following the same
 * env-gating pattern as postgres.test.ts (skipped without PG_DSN).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BIND_HOST,
  buildOptions,
  isLoopbackHost,
  parseArgs,
  warnNonLoopbackBind,
} from '../bin/bridge-registry-service';
import type { Config } from '../bin/bridge-registry-service';
import { DEFAULT_AUDIT_RETENTION_DAYS, PostgresDriver } from '../storage/postgres/driver';

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    driver: 'memory',
    tokens: {},
    signingKeys: {},
    signingOptional: false,
    productionProfile: false,
    ...overrides,
  };
}

// ------------------------------------------------- item 6: loopback default

test('loopback default bind: the default host is 127.0.0.1 (issue #120)', () => {
  assert.equal(DEFAULT_BIND_HOST, '127.0.0.1');
  // The CLI defaults to loopback; only an explicit --host changes it.
  assert.equal(parseArgs([]).host, DEFAULT_BIND_HOST);
  assert.equal(parseArgs(['--host', '0.0.0.0']).host, '0.0.0.0');
  // The programmatic options builder applies the same default.
  assert.equal(buildOptions(baseConfig()).host, DEFAULT_BIND_HOST);
});

test('loopback default bind: isLoopbackHost recognizes loopback targets only (issue #120)', () => {
  for (const host of ['localhost', '127.0.0.1', '127.8.8.8', '::1', '[::1]']) {
    assert.equal(isLoopbackHost(host), true, `${host} is loopback`);
  }
  for (const host of ['0.0.0.0', '::', '192.168.1.10', '10.0.0.7', 'example.com', '']) {
    assert.equal(isLoopbackHost(host), false, `${host} is not loopback`);
  }
});

test('loopback default bind: non-loopback bind logs a loud stderr warning (issue #120)', () => {
  const lines: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: Uint8Array | string): boolean => {
    lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as unknown as typeof process.stderr.write;
  try {
    // Explicit non-loopback host: warned.
    assert.equal(warnNonLoopbackBind('0.0.0.0'), true);
    // Loopback / default: silent.
    assert.equal(warnNonLoopbackBind('127.0.0.1'), false);
    assert.equal(warnNonLoopbackBind('localhost'), false);
    assert.equal(warnNonLoopbackBind(undefined), false);
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.equal(lines.length, 1, 'exactly one warning for the 0.0.0.0 bind');
  assert.match(lines[0]!, /SECURITY WARNING/);
  assert.match(lines[0]!, /0\.0\.0\.0/);
});

// --------------------------------------------- item 7: token entropy floor

test('token entropy floor: buildOptions hard-fails in production, warns by default (issue #120)', () => {
  const short = { 'short-secret': { tenant: 'acme', role: 'write' as const } };

  // Production profile: startup error before anything is built; the message
  // names the owner, never the token.
  assert.throws(
    () =>
      buildOptions(baseConfig({ tokens: short, productionProfile: true, signingKeys: { k1: 'pem' } })),
    (err: unknown) => {
      assert.ok(err instanceof TypeError);
      assert.match(err.message, /acme/);
      assert.equal(err.message.includes('short-secret'), false, 'raw token must never appear in the error');
      return true;
    },
  );

  // Default profile: loud warning, options still build.
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.join(' '));
  };
  let driverKind: string | undefined;
  try {
    driverKind = buildOptions(baseConfig({ tokens: short })).driver.kind;
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /WARNING/);
  assert.match(warnings[0]!, /acme/);
  assert.equal(warnings[0]!.includes('short-secret'), false);
  assert.equal(driverKind, 'memory');

  // Long tokens: silent in both profiles.
  const longSecret = 'x'.repeat(32);
  const long = { [longSecret]: { tenant: 'acme', role: 'write' as const } };
  let warned = 0;
  console.warn = (): void => {
    warned += 1;
  };
  try {
    buildOptions(baseConfig({ tokens: long }));
    buildOptions(baseConfig({ tokens: long, productionProfile: true, signingKeys: { k1: 'pem' } }));
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warned, 0, 'tokens at the 32-character floor must not trip the check');
});

// ------------------------------- item 8: postgres audit retention (gated)

const PG_DSN = process.env['PG_DSN'];

if (PG_DSN === undefined) {
  test('postgres audit retention default: skipped (PG_DSN not set)', () => {
    // Integration coverage runs when a postgres server is available (same
    // gating pattern as postgres.test.ts; CI once the Actions billing lock
    // is lifted and a service container exists).
  });
} else {
  test('postgres audit retention default: a default-built driver prunes rows older than 30 days (issue #120)', async (t) => {
    const driver = new PostgresDriver({ dsn: PG_DSN });
    assert.equal(driver.auditRetentionDays, DEFAULT_AUDIT_RETENTION_DAYS);
    await driver.init();
    t.after(() => driver.close());

    const base = {
      org: 'acme',
      project: 'payments',
      actor: 'ci',
      action: 'publish',
      contract: 'payments',
      version: 'v1',
      ok: true,
      status: 201,
      ip: '127.0.0.1',
    };
    await driver.appendAudit({
      ...base,
      time: new Date(Date.now() - 90 * 86_400_000).toISOString(),
      actor: 'ancient',
    });
    await driver.appendAudit({ ...base, time: new Date().toISOString() });

    const pruned = await driver.pruneAudit();
    if (pruned < 1) throw new Error('default retention did not prune the 90-day-old row');
    const survivors = await driver.queryAudit({ actor: 'ancient' });
    if (survivors.length !== 0) throw new Error('ancient row survived the default retention window');
  });
}
