import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import OverviewPage from '@/app/page';
import { holder } from '../helpers/client-holder';
import { staticRegistryClient } from '../helpers/static-registry';

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

describe('route / (overview)', () => {
  test('multi-version seed: renders totals, recent publishes and the attention list', async () => {
    render(await OverviewPage());

    expect(screen.getByRole('heading', { name: 'Overview' })).toBeTruthy();
    expect(screen.getByText('Recent publishes')).toBeTruthy();

    // Recent publishes rows deep-link through contractHref.
    const paymentsLinks = screen.getAllByRole('link', { name: 'payments' });
    expect(paymentsLinks.some((a) => a.getAttribute('href') === '/contracts/acme/payments/payments'))
      .toBe(true);

    // The stored breaking pair (payments v2→v3) is on the attention list and
    // links through contractDiffHref (orders has a v2→v3 pair as well).
    expect(screen.getAllByText('v2 → v3').length).toBeGreaterThanOrEqual(1);
    const diffLink = screen
      .getAllByRole('link')
      .find((a) => a.getAttribute('href') === '/contracts/acme/payments/payments/diff?from=v2&to=v3');
    expect(diffLink).toBeTruthy();
    expect(screen.getAllByText('BREAKING').length).toBeGreaterThan(0);
  });

  test('empty registry: honest empty states instead of dereferenced metadata', async () => {
    holder.current = staticRegistryClient();
    render(await OverviewPage());

    expect(screen.getByText('No publishes recorded')).toBeTruthy();
    expect(screen.getByText('no publishes recorded')).toBeTruthy();
    expect(screen.getByText('All recorded diffs are classified SAFE.')).toBeTruthy();
  });
});
