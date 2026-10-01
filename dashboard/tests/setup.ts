import type { ReactNode } from 'react';
import { vi } from 'vitest';

/**
 * Global test setup (issue #123).
 *
 * The route pages are async server components rendered here as plain
 * functions, outside the Next runtime. Two Next client-side modules are
 * mocked at the module boundary so page renders stay deterministic:
 *
 * - `next/link`: rendered as a plain anchor carrying `href` plus passthrough
 *   props — href assertions below still cover the central URL builders.
 * - `next/navigation`: `useRouter`/`usePathname`/`useSearchParams` return
 *   inert stubs (client components like the version picker render without an
 *   app-router provider); `notFound` reproduces the real contract by throwing
 *   the canonical 404 digest, so pages' "unknown coordinate must 404"
 *   behavior is assertable.
 */

vi.mock('next/link', async () => {
  const { createElement } = await import('react');
  function MockLink(props: { href?: string; children?: ReactNode } & Record<string, unknown>) {
    const { href, children, ...rest } = props;
    return createElement('a', { href: href ?? undefined, ...rest }, children);
  }
  MockLink.displayName = 'MockLink';
  return { default: MockLink };
});

vi.mock('next/navigation', async () => {
  const { vi: v } = await import('vitest');
  const notFoundError = () =>
    Object.assign(new Error('NEXT_HTTP_ERROR_FALLBACK;404'), {
      digest: 'NEXT_HTTP_ERROR_FALLBACK;404',
    });
  return {
    useRouter: () => ({
      push: v.fn(),
      replace: v.fn(),
      back: v.fn(),
      forward: v.fn(),
      refresh: v.fn(),
      prefetch: v.fn(),
    }),
    usePathname: () => '/',
    useSearchParams: () => new URLSearchParams(),
    notFound: () => {
      throw notFoundError();
    },
    redirect: () => {
      throw new Error('NEXT_REDIRECT');
    },
  };
});
