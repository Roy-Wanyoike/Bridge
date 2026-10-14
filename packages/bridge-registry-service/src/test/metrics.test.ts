/**
 * /metrics endpoint tests (audit item R3): the Prometheus text exposition is
 * parseable, counters track real traffic (requests by route+status, auth
 * failures, rate-limit rejections, audit writes), route labels are
 * normalized templates (never raw paths) and /metrics itself is
 * unauthenticated and NOT rate-limited.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createServer as serviceCreateServer } from '../server';
import { InMemoryDriver } from '../storage/memory';
import { makeIR, request } from './helpers';

const READ = 'read-token';
const WRITE = 'write-token';
const ADMIN = 'admin-token';

interface TestCtx {
  url: string;
  close: () => Promise<void>;
}

async function withServer(
  extra: Record<string, unknown> = {},
  fn: (ctx: TestCtx) => Promise<void>,
): Promise<void> {
  const driver = new InMemoryDriver();
  await driver.init();
  const server = serviceCreateServer({
    driver,
    auth: {
      tokens: {
        [READ]: { tenant: 'acme', role: 'read' },
        [WRITE]: { tenant: 'acme', role: 'write' },
        [ADMIN]: { tenant: 'acme', role: 'admin' },
      },
    },
    rateLimit: { enabled: false },
    ...extra,
  } as never);
  server.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;
  try {
    await fn({
      url,
      close: () =>
        new Promise<void>((resolve, reject) => {
          server.closeIdleConnections();
          server.close((err) => (err ? reject(err) : resolve()));
        }),
    });
  } finally {
    // Cleanup must survive a failing assertion: a server left listening
    // keeps the event loop alive and the whole test file never exits.
    await new Promise<void>((resolve) => {
      server.closeIdleConnections();
      server.close(() => resolve());
    });
  }
}

/** Minimal Prometheus text parser: series → value, plus the TYPE lines. */
function parsePrometheus(text: string): { samples: Map<string, number>; types: Set<string> } {
  const samples = new Map<string, number>();
  const types = new Set<string>();
  for (const line of text.split('\n')) {
    if (line.startsWith('# TYPE ')) {
      types.add(line.split(' ')[2]!);
      continue;
    }
    if (line === '' || line.startsWith('#')) continue;
    const space = line.lastIndexOf(' ');
    assert.ok(space > 0, `sample line has a value: '${line}'`);
    const key = line.slice(0, space);
    const value = Number(line.slice(space + 1));
    assert.ok(Number.isFinite(value) && value >= 0, `sample value is a non-negative number: '${line}'`);
    samples.set(key, value);
  }
  return { samples, types };
}

test('/metrics is unauthenticated and serves parseable Prometheus text', async () => {
  await withServer({}, async ({ url }) => {
    // One request first: the scrape's own response is rendered before its
    // counter increments, so a fresh server's first scrape carries no
    // series — /healthz seeds one.
    await request(url, 'GET', '/healthz');
    const response = await fetch(`${url}/metrics`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/plain/);
    const raw = await response.text();
    const { samples, types } = parsePrometheus(raw);
    for (const name of [
      'bridge_registry_requests_total',
      'bridge_registry_auth_failures_total',
      'bridge_registry_rate_limited_total',
      'bridge_registry_audit_writes_total',
    ]) {
      assert.ok(types.has(name), `# TYPE declared for ${name}`);
    }
    assert.ok(samples.size >= 1, 'observed series are rendered');
  });
});

test('counters track requests by normalized route + method + status', async () => {
  await withServer({}, async ({ url }) => {
    await request(url, 'GET', '/healthz');
    await request(url, 'GET', '/v1/search?q=x', { token: READ });
    await request(url, 'GET', '/v1/search?q=x', { token: READ });
    await request(url, 'PUT', '/v1/orgs/acme/projects/payments/contracts/payments.v1', {
      token: WRITE,
      body: { ir: makeIR() },
    });

    const raw = await fetch(`${url}/metrics`).then((r) => r.text());
    const { samples } = parsePrometheus(raw);
    const key = (route: string, method: string, status: number): string =>
      `bridge_registry_requests_total{route="${route}",method="${method}",status="${status}"}`;
    assert.equal(samples.get(key('/healthz', 'GET', 200)), 1);
    assert.equal(samples.get(key('/v1/search', 'GET', 200)), 2);
    assert.equal(samples.get(key('/v1/orgs/{org}/projects/{project}/contracts/{contract}', 'PUT', 201)), 1);

    // Route labels are TEMPLATES: no raw org/project/contract names leak in.
    assert.equal(raw.includes('payments.v1'), false);
    assert.equal(raw.includes('/orgs/acme'), false);
  });
});

test('auth failures, rate-limit rejections and audit writes are counted', async () => {
  await withServer(
    // Capacity 3: the auth-tier limiter runs PRE-auth, so the 401 consumes
    // one token too — bad(3→2, 401) → read(2→1) → read(1→0) → read(429).
    // Exactly one 429, deterministically.
    { rateLimit: { enabled: true, auth: { capacity: 3, refillPerSecond: 0.001 } } },
    async ({ url }) => {
      const bad = await request(url, 'GET', '/v1/search?q=x', { token: 'wrong-token' });
      assert.equal(bad.status, 401);
      await request(url, 'GET', '/v1/search?q=x', { token: READ }); // auth bucket 2 left
      await request(url, 'GET', '/v1/search?q=x', { token: READ }); // auth bucket empty
      const limited = await request(url, 'GET', '/v1/search?q=x', { token: READ });
      assert.equal(limited.status, 429);

      const raw = await fetch(`${url}/metrics`).then((r) => r.text());
      const { samples } = parsePrometheus(raw);
      assert.ok(
        (samples.get('bridge_registry_auth_failures_total') ?? 0) >= 1,
        'the 401 is counted as an auth failure',
      );
      assert.equal(
        samples.get('bridge_registry_rate_limited_total{tier="auth"}'),
        1,
        'the 429 is counted with its limiter tier',
      );
      const okWrites = samples.get('bridge_registry_audit_writes_total{outcome="ok"}') ?? 0;
      assert.ok(okWrites >= 3, 'audited appends are counted (auth failures skip the ring by design)');
    },
  );
});

test('/metrics is not rate-limited even when the limiter is exhausted', async () => {
  await withServer(
    { rateLimit: { enabled: true, auth: { capacity: 1, refillPerSecond: 0.001 } } },
    async ({ url }) => {
      const first = await request(url, 'GET', '/v1/search?q=x', { token: READ });
      assert.equal(first.status, 200);
      const limited = await request(url, 'GET', '/v1/search?q=x', { token: READ });
      assert.equal(limited.status, 429, 'the auth bucket is drained');
      // /metrics is pre-auth and un-throttled: it answers 200 and reports
      // the rejection it just witnessed.
      const metricsResponse = await fetch(`${url}/metrics`);
      assert.equal(metricsResponse.status, 200, 'scrapes work while the API limiter is full');
      const raw = await metricsResponse.text();
      const { samples } = parsePrometheus(raw);
      assert.equal(
        samples.get('bridge_registry_rate_limited_total{tier="auth"}'),
        1,
        'the drained-bucket rejection is visible to the scrape',
      );
    },
  );
});

test('/metrics scrapes leave no audit entries', async () => {
  await withServer({}, async ({ url }) => {
    // /v1/audit reads audit THEMSELVES (action 'audit'), so compare the
    // non-audit entry counts before and after two scrapes: the delta must
    // be zero — a metrics scrape regression would show up as +2.
    const count = (entries: Array<{ action: string }>): number =>
      entries.filter((e) => e.action !== 'audit').length;
    const before = count((await request(url, 'GET', '/v1/audit', { token: ADMIN })).json.entries);
    await request(url, 'GET', '/metrics');
    await request(url, 'GET', '/metrics');
    const after = count((await request(url, 'GET', '/v1/audit', { token: ADMIN })).json.entries);
    assert.equal(after, before, '/metrics scrapes are never audited');
  });
});

test('audit write failures are visible in the metrics', async () => {
  class FailingAuditBackend {
    public append(): void {
      throw new Error('audit disk unavailable');
    }
    public async query(): Promise<never[]> {
      return [];
    }
  }
  await withServer({ audit: new FailingAuditBackend(), auditFailureMode: 'best-effort' }, async ({ url }) => {
    await request(url, 'GET', '/v1/search?q=x', { token: READ });
    const raw = await fetch(`${url}/metrics`).then((r) => r.text());
    const { samples } = parsePrometheus(raw);
    assert.ok(
      (samples.get('bridge_registry_audit_writes_total{outcome="failed"}') ?? 0) >= 1,
      'a failed append is counted as failed',
    );
  });
});
