import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import DiffPage from '@/app/contracts/[org]/[project]/[contract]/diff/page';
import { holder } from '../helpers/client-holder';

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

const propsOf = (
  contract: string,
  sp: { from?: string; to?: string } = {},
  org = 'acme',
  project = 'payments',
): ComponentProps<typeof DiffPage> => ({
  params: Promise.resolve({ org, project, contract }),
  searchParams: Promise.resolve(sp),
});

describe('route /contracts/[org]/[project]/[contract]/diff', () => {
  test('multi-version seed: breaking report renders the failed-gate banner and changes', async () => {
    render(await DiffPage(propsOf('payments', { from: 'v2', to: 'v3' })));

    expect(screen.getByRole('heading', { name: 'Compatibility report' })).toBeTruthy();
    expect(screen.getByText('Breaking change')).toBeTruthy();
    expect(screen.getByText('strict gate: FAILED')).toBeTruthy();
    expect(screen.getByText('Payment.currency')).toBeTruthy();
    // kindLabel capitalizes every word of the kind (`field-removed` ->
    // `Field Removed`) — pin the shipped copy.
    expect(screen.getByText('Field Removed')).toBeTruthy();
    // The demo provider serves the impact roll-up the live wire omits.
    expect(screen.getByText('transitive dependents in the registry')).toBeTruthy();
  });

  test('defaults to the latest adjacent pair when from/to are omitted', async () => {
    render(await DiffPage(propsOf('payments')));
    expect(screen.getByText('Breaking change')).toBeTruthy();
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    expect(selects[0]!.value).toBe('v2');
    expect(selects[1]!.value).toBe('v3');
  });

  test('explicit from with defaulted to resolves the requested pair (v1 → v3)', async () => {
    render(await DiffPage(propsOf('payments', { from: 'v1' })));
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    expect(selects[0]!.value).toBe('v1');
    expect(selects[1]!.value).toBe('v3');
  });

  test('single-version contract: empty state instead of a from === to report (#121)', async () => {
    render(await DiffPage(propsOf('checkout', {}, 'acme', 'commerce')));
    expect(screen.getByText('No adjacent version to diff against')).toBeTruthy();
    expect(screen.getByText(/single published version \(v1\)/)).toBeTruthy();
  });

  test('unknown from/to in a deep link: notFound (404), never a different report', async () => {
    await expect(DiffPage(propsOf('payments', { from: 'v9' }))).rejects.toMatchObject({
      digest: 'NEXT_HTTP_ERROR_FALLBACK;404',
    });
  });

  test('unknown contract: notFound (404)', async () => {
    await expect(DiffPage(propsOf('does-not-exist'))).rejects.toMatchObject({
      digest: 'NEXT_HTTP_ERROR_FALLBACK;404',
    });
  });
});
