import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Dashboard test runner (issue #123).
 *
 * One jsdom environment serves both layers:
 * - client tests (registry clients, hrefs) are pure logic and run fine in
 *   jsdom — a second node environment would split the suite for no speed win;
 * - page tests render the route components with @testing-library/react.
 *
 * Pages are async server components; tests call them as functions with
 * hand-built `params`/`searchParams` promises and render the awaited JSX, so
 * no Next runtime (router, headers, build pipeline) is involved. The oxc
 * transform applies tsconfig's automatic JSX runtime, so components render
 * exactly as Next compiles them.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
  },
});
