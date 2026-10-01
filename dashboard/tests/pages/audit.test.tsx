import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import AuditPage from '@/app/audit/page';
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

const propsOf = (sp: { action?: string; actor?: string; contract?: string }): ComponentProps<typeof AuditPage> => ({
  searchParams: Promise.resolve(sp),
});

const tableRows = () => document.querySelectorAll('tbody tr');

describe('route /audit', () => {
  test('multi-version seed: one bounded fetch serves the full newest-first trail', async () => {
    render(await AuditPage(propsOf({})));

    expect(screen.getByRole('heading', { name: 'Audit log' })).toBeTruthy();
    // 21 publishes + 5 compat-checks + 6 pulls in the seed.
    expect(tableRows()).toHaveLength(32);
    expect(screen.getByText('32 entries recorded by the registry service.')).toBeTruthy();
    // Newest first: the trail's newest rows concern the orders v3 publish.
    expect(tableRows()[0]!.textContent).toContain('orders');
    // Rows deep-link through contractHref with the row's own scope.
    expect(
      screen.getAllByRole('link').some((a) => a.getAttribute('href') === '/contracts/acme/commerce/orders'),
    ).toBe(true);
  });

  test('action filter narrows to publishes only', async () => {
    render(await AuditPage(propsOf({ action: 'publish' })));
    expect(tableRows()).toHaveLength(21);
  });

  test('a no-match filter renders the empty state', async () => {
    render(await AuditPage(propsOf({ contract: 'zzz-no-such-contract' })));
    expect(screen.getByText('No audit entries match')).toBeTruthy();
  });

  test('empty registry: honest empty state', async () => {
    holder.current = staticRegistryClient();
    render(await AuditPage(propsOf({})));
    expect(screen.getByText('No audit entries match')).toBeTruthy();
    expect(screen.getByText('0 entries recorded by the registry service.')).toBeTruthy();
  });
});
