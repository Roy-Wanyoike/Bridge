import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import GraphPage from '@/app/graph/page';
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

const propsOf = (org?: string): ComponentProps<typeof GraphPage> => ({
  searchParams: Promise.resolve(org ? { org } : {}),
});

const tableRows = () => document.querySelectorAll('tbody tr');

describe('route /graph', () => {
  test('multi-version seed: graph, most-consumed ranking and full node census', async () => {
    render(await GraphPage(propsOf()));

    expect(screen.getByRole('heading', { name: 'Dependency graph' })).toBeTruthy();
    // The SVG census: one node per contract, aria-labelled for consumers.
    expect(screen.getAllByRole('group', { name: /Contract dependency graph/ })).toHaveLength(1);
    expect(screen.getByRole('group', { name: /Contract dependency graph/ }).querySelectorAll('g[role="link"]'))
      .toHaveLength(11);

    // Most-consumed ranking: 5 contracts have direct dependents; payments
    // leads with 2.
    expect(screen.getByText('Most consumed contracts')).toBeTruthy();
    expect(tableRows()[0]!.textContent).toContain('2');

    // Node census table lists every contract in the graph.
    expect(screen.getByText('Node census')).toBeTruthy();
    expect(tableRows()).toHaveLength(5 + 11); // two tables: ranking rows + census rows

    // Org scope tabs deep-link through graphHref.
    expect(screen.getAllByRole('link').some((a) => a.getAttribute('href') === '/graph?org=acme')).toBe(true);
  });

  test('org-scoped census: payments org keeps its 8 contracts', async () => {
    render(await GraphPage(propsOf('acme')));
    expect(screen.getByRole('group', { name: /Contract dependency graph/ }).querySelectorAll('g[role="link"]'))
      .toHaveLength(8);
  });

  test('unknown org: empty-state census and edges, never a dereference crash', async () => {
    holder.current = staticRegistryClient();
    render(await GraphPage(propsOf('does-not-exist')));

    expect(screen.getByText('No nodes in this scope')).toBeTruthy();
    expect(screen.getByText('No dependency edges in this scope.')).toBeTruthy();
    expect(screen.getByText('No contracts in this scope.')).toBeTruthy();
  });
});
