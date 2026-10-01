import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { demoListAudit } from '@/lib/demo-data';
import {
  DemoRegistryClient,
  RegistryError,
  RestRegistryClient,
  isDemoMode,
  isNotFound,
  mapBounded,
  parseOrgsConfig,
  registryBaseUrl,
} from '@/lib/registry-client';
import type { AuditFilters, RegistryClient } from '@/lib/types';
import { REGISTRY_BASE, installFakeRegistry, jsonResponse } from './helpers/fake-registry-server';

/**
 * Registry client tests (issue #123 item a).
 *
 * The `sharedClientContract` suite runs BOTH clients (DemoRegistryClient and
 * RestRegistryClient against a fake in-test registry serving the same demo
 * seed over the documented wire) through identical expectations:
 * listContracts projection, listVersions' honest VersionRef shape, getDiff
 * validation, listAudit limit semantics and overview counters. Everything
 * else is client-specific wire behavior (error mapping, schema-drift
 * detection, credential handling) or the bounded fan-out helper.
 */

// The org surface a live deployment would declare (mirrors the demo seed).
const ORGS_ENV = 'acme:payments,acme:commerce,globex:billing';

function restClient(): RegistryClient {
  return new RestRegistryClient(REGISTRY_BASE, 'test-token');
}

async function expectRegistryError(p: Promise<unknown>, status: number, messagePart: string) {
  try {
    await p;
    expect.unreachable('expected the promise to reject with RegistryError');
  } catch (err) {
    expect(err).toBeInstanceOf(RegistryError);
    const registryError = err as RegistryError;
    expect(registryError.status).toBe(status);
    expect(registryError.message).toContain(messagePart);
  }
}

/** Canonical audit tuple list from the shared fixture, for cross-client parity. */
function auditTuples(filters?: AuditFilters): string[] {
  return demoListAudit(filters).map(
    (e) => `${e.at}|${e.action}|${e.actor}|${e.org}|${e.project}|${e.contract}|${e.version ?? ''}`,
  );
}

function clientTuples(entries: { at: string; action: string; actor: string; org: string; project: string; contract: string; version?: string }[]): string[] {
  return entries.map(
    (e) => `${e.at}|${e.action}|${e.actor}|${e.org}|${e.project}|${e.contract}|${e.version ?? ''}`,
  );
}

function sharedClientContract(name: string, makeClient: () => RegistryClient) {
  describe(`${name} — shared registry contract (same fixture)`, () => {
    test('listOrgs declares the configured org/project surface', async () => {
      await expect(makeClient().listOrgs()).resolves.toEqual([
        { org: 'acme', projects: ['payments', 'commerce'] },
        { org: 'globex', projects: ['billing'] },
      ]);
    });

    test('listContracts projects latest-version summaries with derived verdict and consumers', async () => {
      const rows = await makeClient().listContracts('acme', 'payments');
      expect(rows.map((r) => r.base)).toEqual(['fraud', 'payments', 'risk-engine']);
      const payments = rows.find((r) => r.base === 'payments')!;
      expect(payments.org).toBe('acme');
      expect(payments.project).toBe('payments');
      expect(payments.packageName).toBe('payments.v3');
      expect(payments.latestVersion).toBe('v3');
      expect(payments.versionCount).toBe(3);
      expect(payments.consumers).toBe(2);
      expect(payments.latestVerdict).toBe('BREAKING');
      expect(payments.latestHash).toMatch(/^[0-9a-f]{64}$/);
      expect(payments.latestShortHash).toBe(payments.latestHash.slice(0, 12));
      expect(payments.languages.length).toBeGreaterThan(0);
    });

    test('listContracts: multi-version verdicts differ per contract (v2→v3 stored diffs)', async () => {
      const rows = await makeClient().listContracts('acme', 'payments');
      const byBase = new Map(rows.map((r) => [r.base, r]));
      expect(byBase.get('fraud')!.latestVerdict).toBe('SAFE');
      expect(byBase.get('risk-engine')!.latestVerdict).toBe('SAFE');
    });

    test('listVersions returns bare VersionRef rows — exactly {version}, no metadata', async () => {
      const refs = await makeClient().listVersions('acme', 'payments', 'payments');
      expect(refs.map((r) => r.version)).toEqual(['v1', 'v2', 'v3']);
      for (const ref of refs) {
        // THE regression shape (issues #121/#132): the list route serves plain
        // version ids; any stubbed metadata behind an `as VersionMeta[]` cast
        // would surface here as extra keys.
        expect(Object.keys(ref).sort()).toEqual(['version']);
        expect(ref.version.length).toBeGreaterThan(0);
      }
    });

    test('listVersions: single-version contract lists exactly one ref', async () => {
      const refs = await makeClient().listVersions('acme', 'commerce', 'checkout');
      expect(refs).toEqual([{ version: 'v1' }]);
    });

    test('getVersion enriches one ref with honest pull metadata', async () => {
      const detail = await makeClient().getVersion('acme', 'payments', 'payments', 'v3');
      expect(detail).not.toBeNull();
      expect(detail!.packageName).toBe('payments.v3');
      expect(detail!.publisher).toBe('jonas@acme.dev');
      expect(detail!.publishedAt).toBe('2026-08-21T11:42:30Z');
      expect(detail!.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(detail!.imports).toEqual([]);
      expect(detail!.schema.types).toContain('Payment');
      expect(detail!.schema.services).toContain('Payments');
      expect(detail!.languages).toContain('typescript');
    });

    test('getVersion returns null for an unknown version', async () => {
      await expect(
        makeClient().getVersion('acme', 'payments', 'payments', 'v999'),
      ).resolves.toBeNull();
    });

    test('getDiff validates and projects the stored breaking pair', async () => {
      const report = await makeClient().getDiff('acme', 'payments', 'payments', 'v2', 'v3');
      expect(report).not.toBeNull();
      expect(report!.verdict).toBe('BREAKING');
      expect(report!.summary.breaking).toBe(1);
      expect(report!.changes).toHaveLength(1);
      expect(report!.changes[0]!.path).toBe('Payment.currency');
      expect(report!.changes[0]!.classification).toBe('BREAKING');
      expect(report!.from).toBe('v2');
      expect(report!.to).toBe('v3');
      expect(report!.contract).toBe('payments');
    });

    test('getDiff returns null for an unknown contract (404, never a fabricated report)', async () => {
      await expect(
        makeClient().getDiff('acme', 'payments', 'does-not-exist', 'v1', 'v2'),
      ).resolves.toBeNull();
    });

    test('listAudit returns the newest-first trail covering the seed', async () => {
      const entries = await makeClient().listAudit();
      expect(entries).toHaveLength(demoListAudit().length);
      const times = entries.map((e) => e.at);
      expect([...times].sort().reverse()).toEqual(times);
      expect(clientTuples(entries)).toEqual(auditTuples());
    });

    test(
      'listAudit limit semantics: cap, clamp to 0, huge cap, and filters '
        + 'match the service contract (default 100, [0, 10000])',
      async () => {
        const client = makeClient();
        const cases: Array<[AuditFilters, number]> = [
          [{ limit: 5 }, 5],
          [{ limit: 0 }, 0],
          [{ limit: -10 }, 0],
          [{ limit: 100_000 }, demoListAudit().length],
          [{ action: 'publish', limit: 3 }, 3],
          [{ action: 'publish' }, demoListAudit({ action: 'publish' }).length],
          [{ actor: 'ci-bot@acme.dev' }, demoListAudit({ actor: 'ci-bot@acme.dev' }).length],
          [{ contract: 'pay' }, demoListAudit({ contract: 'pay' }).length],
        ];
        for (const [filters, expectedLength] of cases) {
          const entries = await client.listAudit(filters);
          expect(entries).toHaveLength(expectedLength);
          // Whatever slice comes back must be a prefix of the newest-first trail.
          expect(clientTuples(entries)).toEqual(auditTuples(filters).slice(0, expectedLength));
        }
      },
    );

    test('getOverview derives the same registry counters from the shared fixture', async () => {
      const overview = await makeClient().getOverview();
      expect(overview.contracts).toBe(11);
      expect(overview.versions).toBe(21);
      expect(overview.orgs).toBe(2);
      expect(overview.projects).toBe(3);
      expect(overview.consumerLinks).toBe(9);
      expect(overview.latestVerdicts).toHaveLength(8);
      expect(
        overview.latestVerdicts.find((v) => v.base === 'payments' && v.org === 'acme')!.verdict,
      ).toBe('BREAKING');
    });

    test('getOverview: recent publishes are the 8 newest versions, newest first', async () => {
      const overview = await makeClient().getOverview();
      expect(
        overview.recentPublishes.map((p) => `${p.org}/${p.project}/${p.base}@${p.version}`),
      ).toEqual([
        'acme/commerce/orders@v3',
        'acme/payments/risk-engine@v2',
        'acme/commerce/store@v2',
        'acme/payments/payments@v3',
        'globex/billing/reporting@v1',
        'acme/commerce/storefront@v2',
        'globex/billing/billing@v2',
        'acme/payments/fraud@v2',
      ]);
      expect(overview.lastPublishAt).toBe('2026-08-30T17:26:12Z');
      for (const p of overview.recentPublishes) {
        expect(p.publishedAt.length).toBeGreaterThan(0);
        expect(p.packageName).toBe(`${p.base}.${p.version}`);
      }
      expect(overview.recentPublishes[0]!.publisher).toBe('jonas@acme.dev');
    });
  });
}

describe('registry clients (issue #123 item a)', () => {
  let calls: ReturnType<typeof installFakeRegistry>['calls'];

  beforeEach(() => {
    const fake = installFakeRegistry();
    calls = fake.calls;
    vi.stubEnv('REGISTRY_ORGS', ORGS_ENV);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  sharedClientContract('DemoRegistryClient', () => new DemoRegistryClient());
  sharedClientContract('RestRegistryClient', restClient);

  describe('cross-client graph parity (same fixture)', () => {
    test('unscoped getGraph yields identical node and edge sets', async () => {
      const demo = await new DemoRegistryClient().getGraph();
      const rest = await restClient().getGraph();
      const key = (g: { nodes: { id: string }[]; edges: { from: string; to: string }[] }) =>
        JSON.stringify({
          nodes: g.nodes.map((n) => n.id).sort(),
          edges: g.edges.map((e) => `${e.from}=>${e.to}`).sort(),
        });
      expect(key(rest)).toBe(key(demo));
      expect(demo.nodes).toHaveLength(11);
      expect(demo.edges.length).toBeGreaterThan(0);
    });

    test('getGraph(org) with knownContracts stays org-scoped like the demo provider', async () => {
      const all = await restClient().listAllContracts();
      const scoped = await restClient().getGraph('acme', all);
      expect(scoped.nodes.every((n) => n.org === 'acme')).toBe(true);
      expect(scoped.nodes).toHaveLength(8);
      // ids are the fully-qualified storage keys so duplicate bases across
      // orgs can never collide.
      expect(scoped.nodes.map((n) => n.id).sort()).toEqual(
        [
          'acme/payments/fraud',
          'acme/payments/payments',
          'acme/payments/risk-engine',
          'acme/commerce/catalog',
          'acme/commerce/checkout',
          'acme/commerce/orders',
          'acme/commerce/store',
          'acme/commerce/storefront',
        ].sort(),
      );
    });
  });

  describe('RestRegistryClient wire behavior', () => {
    test('sends the bearer credential on every request', async () => {
      await restClient().listContracts('acme', 'payments');
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.auth).toBe('Bearer test-token');
        expect(call.path.startsWith('/v1/')).toBe(true);
      }
    });

    test('omits the credential entirely when no token is configured', async () => {
      await expectRegistryError(
        new RestRegistryClient(REGISTRY_BASE).listContracts('acme', 'payments'),
        401,
        'RegistryRejected',
      );
      expect(calls[0]!.auth).toBeUndefined();
    });

    test('maps 404 to typed not-found (isNotFound)', async () => {
      // getVersion resolves null on a 404 (shared contract above); the typed
      // 404 surfaces on the calls that do not swallow it — listVersions on an
      // unknown contract rejects with it.
      const err = await restClient().listVersions('acme', 'payments', 'does-not-exist').then(
        () => null,
        (e: unknown) => e,
      );
      expect(isNotFound(err)).toBe(true);
    });

    test('maps 5xx to RegistryUnreachable with the numeric status preserved', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(503, { error: 'unavailable' })));
      await expectRegistryError(
        new RestRegistryClient(REGISTRY_BASE, 't').listContracts('acme', 'payments'),
        503,
        'RegistryUnreachable',
      );
    });

    test('maps connection failure to status 0 RegistryUnreachable', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => {
        throw new TypeError('fetch failed');
      }));
      await expectRegistryError(
        new RestRegistryClient(REGISTRY_BASE, 't').listVersions('acme', 'payments', 'payments'),
        0,
        'RegistryUnreachable',
      );
    });

    test('listVersions rejects schema drift: response without the versions array', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { nope: [] })));
      await expectRegistryError(
        new RestRegistryClient(REGISTRY_BASE, 't').listVersions('acme', 'payments', 'payments'),
        0,
        'none of the expected array keys',
      );
    });

    test('listVersions rejects schema drift: non-string version entries', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { versions: ['v1', 7] })));
      await expectRegistryError(
        new RestRegistryClient(REGISTRY_BASE, 't').listVersions('acme', 'payments', 'payments'),
        0,
        'non-string version entry',
      );
    });

    test('listVersions forwards the clamped limit-less audit-free query and encodes path segments', async () => {
      // The fake 404s the (tenant-unknown) org after recording the request;
      // what we assert here is the URL the client built, not the response.
      await new RestRegistryClient(REGISTRY_BASE, 'test-token')
        .listVersions('a/b', 'p', 'c')
        .catch(() => undefined);
      expect(calls[0]!.path).toBe('/v1/orgs/a%2Fb/projects/p/contracts/c/versions');
    });

    test('listAudit forwards the limit param as a clamped integer', async () => {
      const client = new RestRegistryClient(REGISTRY_BASE, 'test-token');
      await client.listAudit({ limit: 5 });
      expect(calls.at(-1)!.path).toBe('/v1/audit?limit=5');
      await client.listAudit({ limit: -7 });
      expect(calls.at(-1)!.path).toBe('/v1/audit?limit=0');
      await client.listAudit();
      expect(calls.at(-1)!.path).toBe('/v1/audit');
    });

    test('getDiff rejects a drifted verdict / summary / change row loudly', async () => {
      const client = new RestRegistryClient(REGISTRY_BASE, 't');
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      fetchMock.mockImplementationOnce(async () =>
        jsonResponse(200, { verdict: 'NOPE', summary: { safe: 0, warning: 0, breaking: 0, unknown: 0 }, changes: [] }));
      await expectRegistryError(client.getDiff('o', 'p', 'b', 'v1', 'v2'), 0, 'no valid verdict');

      fetchMock.mockImplementationOnce(async () =>
        jsonResponse(200, { verdict: 'SAFE', summary: { safe: 'many' }, changes: [] }));
      await expectRegistryError(client.getDiff('o', 'p', 'b', 'v1', 'v2'), 0, 'invalid summary');

      fetchMock.mockImplementationOnce(async () =>
        jsonResponse(200, {
          verdict: 'SAFE',
          summary: { safe: 0, warning: 0, breaking: 0, unknown: 0 },
          changes: [{ classification: 'SAFE', message: 'x' }],
        }));
      await expectRegistryError(client.getDiff('o', 'p', 'b', 'v1', 'v2'), 0, 'malformed change row');

      fetchMock.mockImplementationOnce(async () =>
        jsonResponse(200, {
          verdict: 'SAFE',
          summary: { safe: 0, warning: 0, breaking: 0, unknown: 0 },
          changes: [],
          impact: { dependents: 'many', affected: 0, breakingAffected: 0, consumers: [] },
        }));
      await expectRegistryError(client.getDiff('o', 'p', 'b', 'v1', 'v2'), 0, 'malformed impact');
    });

    test('getDiff keeps impact optional-and-validated, and undefined when the wire omits it', async () => {
      const client = new RestRegistryClient(REGISTRY_BASE, 't');
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      fetchMock.mockImplementationOnce(async () =>
        jsonResponse(200, {
          verdict: 'WARNING',
          summary: { safe: 1, warning: 1, breaking: 0, unknown: 0 },
          changes: [
            { path: 'Payment.reference', kind: 'field-added', classification: 'SAFE', message: 'm' },
          ],
          impact: {
            dependents: 1,
            affected: 1,
            breakingAffected: 0,
            consumers: [
              {
                packageName: 'fraud.v2',
                version: 'v2',
                org: 'acme',
                project: 'payments',
                depth: 1,
                severity: 'WARNING',
                reason: 'direct-type',
                viaTypes: ['Payment'],
              },
            ],
          },
        }));
      const withImpact = await client.getDiff('o', 'p', 'b', 'v1', 'v2');
      expect(withImpact!.impact!.affected).toBe(1);
      expect(withImpact!.impact!.consumers[0]!.viaTypes).toEqual(['Payment']);

      fetchMock.mockImplementationOnce(async () =>
        jsonResponse(200, {
          verdict: 'SAFE',
          summary: { safe: 0, warning: 0, breaking: 0, unknown: 0 },
          changes: [],
        }));
      const withoutImpact = await client.getDiff('o', 'p', 'b', 'v1', 'v2');
      expect(withoutImpact!.impact).toBeUndefined();
    });

    test('getVersion projects the ir block into schema names; enums/aliases stay honest-empty', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          jsonResponse(200, {
            meta: {
              org: 'acme',
              project: 'payments',
              packageName: 'payments.v3',
              base: 'payments',
              version: 'v3',
              hash: 'a'.repeat(64),
              shortHash: 'a'.repeat(12),
              imports: [],
              publishedAt: '2026-08-21T11:42:30Z',
              publishedBy: 'jonas@acme.dev',
              languages: ['typescript', 'go'],
            },
            ir: {
              types: [{ name: 'Payment' }, { name: 'Money' }],
              enums: [{ name: 'PaymentStatus' }],
              services: [{ name: 'Payments' }],
              events: [],
            },
          }),
        ),
      );
      const detail = await new RestRegistryClient(REGISTRY_BASE, 't').getVersion(
        'acme',
        'payments',
        'payments',
        'v3',
      );
      expect(detail!.schema.types).toEqual(['Payment', 'Money']);
      expect(detail!.schema.services).toEqual(['Payments']);
      expect(detail!.schema.events).toEqual([]);
      expect(detail!.languages).toEqual(['typescript', 'go']);
    });

    test('getContract/latest pull rejects a meta-less payload as schema drift', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { ir: {} })));
      await expectRegistryError(
        new RestRegistryClient(REGISTRY_BASE, 't').getContract('acme', 'payments', 'payments'),
        0,
        'unexpected shape',
      );
    });

    test('listConsumers rejects malformed dependent rows as schema drift', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse(200, { contract: 'b', version: 'v1', consumers: [{ packageName: 'x' }] })),
      );
      await expectRegistryError(
        new RestRegistryClient(REGISTRY_BASE, 't').listConsumers('acme', 'payments', 'payments', 'v3'),
        0,
        'consumer row with an unexpected shape',
      );
    });
  });

  describe('RestRegistryClient — unknown coordinates (wire 404 vs demo empty lists)', () => {
    test('listVersions on an unknown contract throws typed 404 (demo returns [])', async () => {
      // 4xx is a bad-coordinate rejection (same prefix family as the 401
      // credential test above), not an outage — only 5xx/transport failures
      // are RegistryUnreachable.
      await expectRegistryError(
        restClient().listVersions('acme', 'payments', 'does-not-exist'),
        404,
        'RegistryRejected',
      );
      await expect(
        new DemoRegistryClient().listVersions('acme', 'payments', 'does-not-exist'),
      ).resolves.toEqual([]);
    });

    test('getContract on an unknown contract resolves null in both clients', async () => {
      await expect(restClient().getContract('acme', 'payments', 'does-not-exist')).resolves.toBeNull();
      await expect(
        new DemoRegistryClient().getContract('acme', 'payments', 'does-not-exist'),
      ).resolves.toBeNull();
    });
  });

  describe('mapBounded (bounded fan-out discipline)', () => {
    test('preserves input order regardless of completion order', async () => {
      const items = Array.from({ length: 24 }, (_, i) => i);
      const out = await mapBounded(items, 4, async (n) => {
        await new Promise((r) => setTimeout(r, (n % 5)));
        return n * 2;
      });
      expect(out).toEqual(items.map((n) => n * 2));
    });

    test('never exceeds the concurrency limit', async () => {
      let inFlight = 0;
      let maxInFlight = 0;
      const items = Array.from({ length: 20 }, (_, i) => i);
      await mapBounded(items, 4, async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 0));
        inFlight -= 1;
      });
      expect(maxInFlight).toBeLessThanOrEqual(4);
      expect(maxInFlight).toBeGreaterThan(1);
    });

    test('empty input resolves to an empty result', async () => {
      await expect(mapBounded([], 4, async (x: never) => x)).resolves.toEqual([]);
    });
  });

  describe('deployment config helpers', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    test('parseOrgsConfig splits, dedupes and orders org:project pairs', () => {
      expect(parseOrgsConfig(undefined)).toBeNull();
      expect(parseOrgsConfig('   ')).toBeNull();
      expect(parseOrgsConfig('acme:payments, acme:commerce;;  globex:billing')).toEqual([
        { org: 'acme', projects: ['payments', 'commerce'] },
        { org: 'globex', projects: ['billing'] },
      ]);
      expect(parseOrgsConfig('a:p1, a:p1, a:p2')).toEqual([{ org: 'a', projects: ['p1', 'p2'] }]);
    });

    test('parseOrgsConfig rejects bare org names loudly (silent-empty pages are worse)', () => {
      expect(() => parseOrgsConfig('acme')).toThrow(/RegistryMisconfigured/);
      expect(() => parseOrgsConfig('acme:payments,acme')).toThrow(/RegistryMisconfigured/);
    });

    test('isDemoMode: explicit values only, no loose boolean coercion', () => {
      vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'true');
      expect(isDemoMode()).toBe(true);
      vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', '1');
      expect(isDemoMode()).toBe(true);
      vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'false');
      expect(isDemoMode()).toBe(false);
      vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', '0');
      expect(isDemoMode()).toBe(false);
    });

    test('isDemoMode: unrecognized values warn and keep the environment default', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'FALSE');
        expect(isDemoMode()).toBe(true); // test env is not production -> demo default
        expect(warn).toHaveBeenCalledOnce();
      } finally {
        warn.mockRestore();
      }
    });

    test('isDemoMode: production default is live (DEMO_MODE_DEFAULT = false)', () => {
      // vi.stubEnv (not a direct assignment — `NODE_ENV` is read-only in the
      // type system) flips the default-decision input only for this test.
      vi.stubEnv('NODE_ENV', 'production');
      try {
        expect(isDemoMode()).toBe(false);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    test('registryBaseUrl: null in demo, env value or documented fallback in live mode', () => {
      expect(registryBaseUrl()).toBeNull();
      vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'false');
      vi.stubEnv('NEXT_PUBLIC_REGISTRY_URL', 'http://registry.example');
      expect(registryBaseUrl()).toBe('http://registry.example');
      vi.stubEnv('NEXT_PUBLIC_REGISTRY_URL', '');
      expect(registryBaseUrl()).toBe('http://localhost:4350');
    });
  });
});
