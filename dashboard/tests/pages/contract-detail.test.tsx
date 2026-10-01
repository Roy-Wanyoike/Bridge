import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ContractDetailPage from '@/app/contracts/[org]/[project]/[contract]/page';
import { holder } from '../helpers/client-holder';
import { staticRegistryClient, summaryOf } from '../helpers/static-registry';

vi.mock('@/lib/registry-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/registry-client')>();
  const { holder: h } = await import('../helpers/client-holder');
  return {
    ...actual,
    getRegistryClient: () => h.current ?? new actual.DemoRegistryClient(),
  };
});

beforeEach(() => {
  holder.current = null;
});

afterEach(() => {
  holder.current = null;
  cleanup();
});

const paramsOf = (org: string, project: string, contract: string): ComponentProps<typeof ContractDetailPage> => ({
  params: Promise.resolve({ org, project, contract }),
});

describe('route /contracts/[org]/[project]/[contract]', () => {
  test('multi-version seed: renders the version timeline with adjacent diff links', async () => {
    render(await ContractDetailPage(paramsOf('acme', 'payments', 'payments')));

    expect(screen.getByRole('heading', { name: 'payments' })).toBeTruthy();

    // Timeline lists all versions newest-first with the latest marker...
    expect(screen.getAllByText('latest')).toHaveLength(1);
    for (const v of ['v1', 'v2', 'v3']) {
      expect(screen.getAllByText(v).length).toBeGreaterThan(0);
    }
    // ...and each adjacent pair deep-links through contractDiffHref.
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/contracts/acme/payments/payments/diff?from=v2&to=v3');
    expect(hrefs).toContain('/contracts/acme/payments/payments/diff?from=v1&to=v2');
    // Breadcrumb org/project links come from contractsHref.
    expect(hrefs).toContain('/contracts?org=acme&project=payments');
  });

  test('single-version seed: no diff links; consumers tab shows the honest empty state', async () => {
    render(await ContractDetailPage(paramsOf('acme', 'commerce', 'checkout')));

    // One published version -> nothing to diff against, so no diff links.
    expect(screen.queryAllByText('latest')).toHaveLength(1);
    expect(
      screen.queryAllByRole('link').filter((a) => (a.getAttribute('href') ?? '').includes('/diff?')),
    ).toHaveLength(0);

    fireEvent.click(screen.getByRole('tab', { name: 'Consumers' }));
    expect(screen.getByText('No consumers found')).toBeTruthy();
  });

  test('crash class (#132): VersionRef without pullable metadata renders a sparse row', async () => {
    // The list route serves bare {version} refs; when the per-version pull
    // comes back empty the timeline must degrade to honest copy — never
    // dereference publishedAt/hash off a VersionRef.
    holder.current = staticRegistryClient({
      contracts: [summaryOf({ org: 'acme', project: 'payments', base: 'payments' })],
      versions: { 'acme/payments/payments': [{ version: 'v1' }, { version: 'v2' }] },
    });
    render(await ContractDetailPage(paramsOf('acme', 'payments', 'payments')));

    const sparse = screen.getAllByText('Metadata for this version is unavailable from the registry.');
    expect(sparse).toHaveLength(2);
    expect(screen.getAllByText('v2').length).toBeGreaterThan(0);
  });

  test('unknown contract: notFound (404), never an empty page', async () => {
    await expect(
      ContractDetailPage(paramsOf('acme', 'payments', 'does-not-exist')),
    ).rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
  });
});
