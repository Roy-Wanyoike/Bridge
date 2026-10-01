import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DiffVersionPicker } from '@/components/diff-version-picker';

/**
 * Component-level render test for the picker on the compatibility page
 * (issue #123 item b). `next/navigation` is mocked per file with a stable
 * `push` spy (overriding the inert stub from tests/setup.ts) so navigation
 * is assertable without an app-router provider; everything else renders for
 * real in jsdom.
 */

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

beforeEach(() => {
  pushMock.mockClear();
});

afterEach(() => {
  cleanup();
});

function propsOf(
  overrides: Partial<ComponentProps<typeof DiffVersionPicker>> = {},
): ComponentProps<typeof DiffVersionPicker> {
  return {
    basePath: '/contracts/acme/payments/payments',
    versions: [{ version: 'v1' }, { version: 'v2' }, { version: 'v3' }],
    from: 'v1',
    to: 'v3',
    ...overrides,
  };
}

describe('DiffVersionPicker', () => {
  test('orders options chronologically by publishedAt when the timestamps exist', () => {
    render(
      <DiffVersionPicker
        {...propsOf({
          versions: [
            { version: 'v3', publishedAt: '2026-03-01T00:00:00Z' },
            { version: 'v1', publishedAt: '2026-01-01T00:00:00Z' },
            { version: 'v2', publishedAt: '2026-02-01T00:00:00Z' },
          ],
        })}
      />,
    );
    const [fromSelect, toSelect] = screen.getAllByRole('combobox') as HTMLSelectElement[];
    expect([...fromSelect.options].map((o) => o.value)).toEqual(['v1', 'v2', 'v3']);
    expect([...toSelect.options].map((o) => o.value)).toEqual(['v1', 'v2', 'v3']);
  });

  test('entries without publishedAt keep registry order (stable sort, live-mode shape)', () => {
    render(
      <DiffVersionPicker
        {...propsOf({
          versions: [{ version: 'v2' }, { version: 'v1', publishedAt: '2026-01-01T00:00:00Z' }],
          from: 'v2',
        })}
      />,
    );
    const [fromSelect] = screen.getAllByRole('combobox') as HTMLSelectElement[];
    // The timestamped entry must not leapfrog the metadata-less one.
    expect([...fromSelect.options].map((o) => o.value)).toEqual(['v2', 'v1']);
  });

  test('options that would produce an inverted or empty diff are disabled', () => {
    render(<DiffVersionPicker {...propsOf({ from: 'v1', to: 'v3' })} />);
    const [fromSelect, toSelect] = screen.getAllByRole('combobox') as HTMLSelectElement[];
    // from-select: v3 is >= the selected target, so it may not be chosen.
    expect([...fromSelect.options].map((o) => o.disabled)).toEqual([false, false, true]);
    // to-select: v1 is <= the selected base, so it may not be chosen.
    expect([...toSelect.options].map((o) => o.disabled)).toEqual([true, false, false]);
  });

  test('selecting a version navigates to the same page with the new pair', () => {
    render(<DiffVersionPicker {...propsOf({ from: 'v1', to: 'v3' })} />);
    const [fromSelect] = screen.getAllByRole('combobox') as HTMLSelectElement[];
    fireEvent.change(fromSelect, { target: { value: 'v2' } });
    expect(pushMock).toHaveBeenCalledWith('/contracts/acme/payments/payments/diff?from=v2&to=v3');
  });

  test('version ids are encoded into the query params on navigation', () => {
    render(
      <DiffVersionPicker
        {...propsOf({
          versions: [{ version: 'v 1' }, { version: 'v#2' }],
          from: 'v 1',
          to: 'v#2',
        })}
      />,
    );
    const [, toSelect] = screen.getAllByRole('combobox') as HTMLSelectElement[];
    fireEvent.change(toSelect, { target: { value: 'v#2' } });
    expect(pushMock).toHaveBeenCalledWith('/contracts/acme/payments/payments/diff?from=v%201&to=v%232');
  });
});
