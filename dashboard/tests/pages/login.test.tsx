import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import LoginPage from '@/app/(auth)/login/page';

/**
 * /login renders for unauthenticated visitors only — the proxy sends every
 * unauthenticated console request here. Assertions follow the issue's
 * visual requirements: dark theme classes, human-readable error states
 * (icon + text, never color-only), and the sign-in control carrying the
 * sanitized returnTo.
 */

async function renderLogin(searchParams: Record<string, string> = {}) {
  // Pages are async server components; render the awaited JSX exactly like
  // the other page tests (tests/pages/README convention in vitest.config).
  const jsx = await LoginPage({ searchParams: Promise.resolve(searchParams) });
  return render(jsx);
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('login page (issue #163 visual + functional requirements)', () => {
  test('configured deployment: sign-in card with SSO control and provider hint', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('OIDC_ISSUER', 'https://id.example.com/');
    vi.stubEnv('OIDC_CLIENT_ID', 'bridge-console');
    vi.stubEnv('OIDC_CLIENT_SECRET', 'x'.repeat(20));
    vi.stubEnv('SESSION_SECRET', 's'.repeat(64));
    await renderLogin();
    expect(screen.getByRole('heading', { name: /sign in to the console/i })).toBeDefined();
    const link = screen.getByRole('link', { name: /sign in with sso/i });
    expect(link.getAttribute('href')).toBe('/api/auth/login');
    expect(screen.getByText('id.example.com')).toBeDefined();
  });

  test('returnTo is carried into the sign-in control and announced', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('OIDC_ISSUER', 'https://id.example.com/');
    vi.stubEnv('OIDC_CLIENT_ID', 'bridge-console');
    vi.stubEnv('OIDC_CLIENT_SECRET', 'x'.repeat(20));
    vi.stubEnv('SESSION_SECRET', 's'.repeat(64));
    await renderLogin({ returnTo: '/contracts?org=acme' });
    const link = screen.getByRole('link', { name: /sign in with sso/i });
    expect(link.getAttribute('href')).toBe(`/api/auth/login?returnTo=${encodeURIComponent('/contracts?org=acme')}`);
    expect(screen.getByText('/contracts?org=acme')).toBeDefined();
  });

  test('expired/tampered sessions get the human explanation, not a digest', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('OIDC_ISSUER', 'https://id.example.com/');
    vi.stubEnv('OIDC_CLIENT_ID', 'bridge-console');
    vi.stubEnv('OIDC_CLIENT_SECRET', 'x'.repeat(20));
    vi.stubEnv('SESSION_SECRET', 's'.repeat(64));
    await renderLogin({ error: 'session_expired', returnTo: '/graph' });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Your session has expired');
    expect(alert.textContent).toContain('Sign in again');
    // never color-only: the alert carries an icon + text
    expect(alert.querySelector('svg')).not.toBeNull();
  });

  test('provider errors map to readable titles for every code the flows emit', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('OIDC_ISSUER', 'https://id.example.com/');
    vi.stubEnv('OIDC_CLIENT_ID', 'bridge-console');
    vi.stubEnv('OIDC_CLIENT_SECRET', 'x'.repeat(20));
    vi.stubEnv('SESSION_SECRET', 's'.repeat(64));
    for (const code of ['state_mismatch', 'provider_error', 'provider_unavailable', 'id_token_invalid']) {
      cleanup();
      await renderLogin({ error: code });
      expect(screen.getByRole('alert'), `error code ${code}`).toBeDefined();
    }
  });

  test('signed-out notice is a status, not an alert', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('OIDC_ISSUER', 'https://id.example.com/');
    vi.stubEnv('OIDC_CLIENT_ID', 'bridge-console');
    vi.stubEnv('OIDC_CLIENT_SECRET', 'x'.repeat(20));
    vi.stubEnv('SESSION_SECRET', 's'.repeat(64));
    await renderLogin({ notice: 'signed_out' });
    expect(screen.getByRole('status').textContent).toContain('You have signed out');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('unconfigured production deployments list the missing variables and the fix', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    delete process.env.OIDC_ISSUER;
    delete process.env.OIDC_CLIENT_ID;
    delete process.env.OIDC_CLIENT_SECRET;
    delete process.env.SESSION_SECRET;
    await renderLogin();
    expect(screen.getByRole('alert').textContent).toContain('authentication is not configured');
    for (const name of ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'SESSION_SECRET']) {
      expect(screen.getByText(name)).toBeDefined();
    }
    expect(screen.getByText('AUTH_DISABLED=true')).toBeDefined();
    // No sign-in control while unconfigured.
    expect(screen.queryByRole('link', { name: /sign in with sso/i })).toBeNull();
  });
});
