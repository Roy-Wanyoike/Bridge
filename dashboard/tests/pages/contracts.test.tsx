import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import ContractsPage from '@/app/contracts/page';
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

const paramsOf = (sp: Record<string, string>): ComponentProps<typeof ContractsPage> => ({
  searchParams: Promise.resolve(sp),
});

describe('route /contracts', () => {
  test('multi-version seed: lists every contract at its latest version', async () => {
    render(await ContractsPage(paramsOf({})));

    expect(screen.getByRole('heading', { name: 'Contracts' })).toBeTruthy();
    expect(document.querySelectorAll('tbody tr')).toHaveLength(11);

    // Row links go through contractHref — decoded, route-preserving URLs.
    const paymentsRow = screen
      .getAllByRole('link', { name: 'payments' })
      .find((a) => a.getAttribute('href') === '/contracts/acme/payments/payments');
    expect(paymentsRow).toBeTruthy();
  });

  test('org filter narrows to that org only', async () => {
    render(await ContractsPage(paramsOf({ org: 'globex' })));
    expect(document.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(
      screen.getAllByRole('link').some((a) => a.getAttribute('href') === '/contracts/globex/billing/billing'),
    ).toBe(true);
  });

  test('a no-match search renders the empty state, never a dereference crash', async () => {
    render(await ContractsPage(paramsOf({ q: 'zzz-no-such-contract' })));
    expect(screen.getByText('No contracts match')).toBeTruthy();
  });

  test('empty registry: honest empty state and zero-count copy', async () => {
    holder.current = staticRegistryClient();
    render(await ContractsPage(paramsOf({})));
    expect(screen.getByText('No contracts match')).toBeTruthy();
    expect(screen.getByText('0 contracts at their latest version.')).toBeTruthy();
  });
});
