import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import OverviewPage from '@/app/page';
import ContractsPage from '@/app/contracts/page';
import AuditPage from '@/app/audit/page';
import GraphPage from '@/app/graph/page';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

// The scope-switcher guard renders AppShell, whose ScopeSwitcher mounts only
// on /contracts — re-mock navigation (per-file, same shape as setup.ts) with
// that pathname.
vi.mock('next/navigation', async () => {
  const { vi: v } = await import('vitest');
  return {
    useRouter: () => ({ push: v.fn(), replace: v.fn(), back: v.fn(), forward: v.fn(), refresh: v.fn(), prefetch: v.fn() }),
    usePathname: () => '/contracts',
    useSearchParams: () => new URLSearchParams(),
  };
});

/**
 * Structural regression guards for issue #152.
 *
 * jsdom computes no layout, so page-level overflow cannot be asserted here —
 * the runtime truth is the Playwright measurement recorded on the issue
 * (scrollWidth === clientWidth at 320/375/390 on every route). These tests pin
 * the STRUCTURAL classes that carry the fix, so a refactor that drops the
 * base grid template (implicit tracks honor content min-width and re-open the
 * page-level overflow) or the TabsList width cap fails in CI instead of on a
 * phone.
 */

afterEach(() => {
  cleanup();
});

describe('responsive overflow guards (#152)', () => {
  test('overview grids declare an explicit base template so cards can shrink below content width', async () => {
    const { container } = render(await OverviewPage());
    const grids = container.querySelectorAll('.grid');
    expect(grids.length).toBeGreaterThanOrEqual(3);
    for (const g of grids) {
      // Every grid on the page must carry an explicit template at the base
      // breakpoint: grid-cols-1, or any grid-cols-* / md:grid-cols-[...]
      // variant declared in the className itself.
      const cls = g.className;
      expect(/(^|\s)grid-cols-\S/.test(cls) || /grid-cols-\[/.test(cls)).toBe(true);
    }
  });

  test('graph table grid declares an explicit base template', async () => {
    const { container } = render(await GraphPage({ searchParams: Promise.resolve({}) }));
    const grids = container.querySelectorAll('.grid');
    expect(grids.length).toBeGreaterThanOrEqual(1);
    for (const g of grids) {
      const cls = g.className;
      expect(/(^|\s)grid-cols-\S/.test(cls) || /grid-cols-\[/.test(cls)).toBe(true);
    }
  });

  test('filter-form grids declare an explicit base template (contracts + audit)', async () => {
    const pages = [
      { Page: ContractsPage, props: { searchParams: Promise.resolve({}) } },
      { Page: AuditPage, props: { searchParams: Promise.resolve({}) } },
    ];
    for (const { Page, props } of pages) {
      const { container } = render(await Page(props));
      const forms = container.querySelectorAll('form.grid');
      expect(forms.length).toBe(1);
      const cls = (forms[0] as HTMLElement).className;
      expect(/grid-cols-\[/.test(cls) || /(^|\s)grid-cols-\S/.test(cls)).toBe(true);
    }
  });

  test('TabsList caps its width and scrolls internally on narrow viewports', () => {
    function Harness() {
      return (
        <Tabs defaultValue="a">
          <TabsList aria-label="sections">
            <TabsTrigger value="a">Versions</TabsTrigger>
            <TabsTrigger value="b">Consumers</TabsTrigger>
            <TabsTrigger value="c">Producers</TabsTrigger>
            <TabsTrigger value="d">Schema</TabsTrigger>
          </TabsList>
          <TabsContent value="a">panel</TabsContent>
        </Tabs>
      );
    }
    const { getByRole } = render(<Harness />);
    const list = getByRole('tablist', { name: 'sections' });
    expect(list.className).toContain('max-w-full');
    expect(list.className).toContain('overflow-x-auto');
  });

  test('header scope switcher caps its width below sm (ultra-narrow header row)', async () => {
    const { AppShell } = await import('@/components/app-shell');
    const { getByLabelText } = render(
      <AppShell orgs={[]} demoMode={false}>
        <p>content</p>
      </AppShell>,
    );
    const select = getByLabelText('Scope: org and project');
    expect(select.className).toContain('max-w-[7.5rem]');
    expect(select.className).toContain('sm:max-w-none');
  });

  test('contracts filter action row wraps instead of pushing the page wider', async () => {
    const { container } = render(await ContractsPage({ searchParams: Promise.resolve({}) }));
    const row = container.querySelector('form.grid div.flex');
    expect(row).toBeTruthy();
    expect((row as HTMLElement).className).toContain('flex-wrap');
  });
});
