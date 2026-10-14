import { describe, expect, test } from 'vitest';
import type { AuthConfig } from '@/lib/auth/config';
import { decideGate } from '@/lib/auth/gate';

const enforced: AuthConfig = {
  mode: 'enforced',
  issuer: 'https://id.example.com/',
  clientId: 'bridge-console',
  clientSecret: 'x'.repeat(16),
  sessionSecret: 's'.repeat(64),
  sessionTtlSeconds: 28_800,
};
const disabled: AuthConfig = { mode: 'disabled' };
const unconfigured: AuthConfig = { mode: 'unconfigured', missing: ['OIDC_ISSUER', 'SESSION_SECRET'] };
const devOpen: AuthConfig = { mode: 'dev-open', missing: ['OIDC_ISSUER'] };

function run(path: string, opts: Partial<{ search: string; present: boolean; valid: boolean; auth: AuthConfig }> = {}) {
  return decideGate({
    path,
    search: opts.search ?? '',
    sessionCookiePresent: opts.present ?? false,
    sessionValid: opts.valid ?? false,
    auth: opts.auth ?? enforced,
  });
}

describe('gate decision matrix (issue #163 acceptance 1 & 4)', () => {
  test('unauthenticated page requests redirect to /login carrying returnTo', () => {
    const d = run('/contracts');
    expect(d).toEqual({ type: 'redirect', location: '/login?returnTo=%2Fcontracts' });

    const withQuery = run('/contracts', { search: '?org=acme&project=orders' });
    expect(withQuery).toEqual({
      type: 'redirect',
      location: `/login?returnTo=${encodeURIComponent('/contracts?org=acme&project=orders')}`,
    });

    const root = run('/');
    expect(root).toEqual({ type: 'redirect', location: '/login?returnTo=%2F' });
  });

  test('authenticated page requests pass through', () => {
    expect(run('/contracts', { present: true, valid: true })).toEqual({ type: 'next' });
    expect(run('/', { present: true, valid: true })).toEqual({ type: 'next' });
    expect(run('/audit', { present: true, valid: true })).toEqual({ type: 'next' });
  });

  test('present-but-invalid (tampered/expired) sessions redirect with the expired explanation', () => {
    const d = run('/graph', { present: true, valid: false });
    expect(d).toEqual({
      type: 'redirect',
      location: `/login?error=session_expired&returnTo=${encodeURIComponent('/graph')}`,
    });
  });

  test('/login is reachable unauthenticated and bounces authenticated users home', () => {
    expect(run('/login')).toEqual({ type: 'next' });
    expect(run('/login', { present: true, valid: true })).toEqual({ type: 'redirect', location: '/' });
  });

  test('auth flow paths never gate themselves', () => {
    for (const path of ['/api/auth/login', '/api/auth/callback', '/logout']) {
      expect(run(path)).toEqual({ type: 'next' });
      expect(run(path, { present: true, valid: true })).toEqual({ type: 'next' });
    }
  });

  test('unauthenticated /api data requests get a 401 JSON decision', () => {
    expect(run('/api/something', { present: false })).toEqual({
      type: 'not-authorized',
      status: 401,
      message: expect.stringContaining('bridge_console_session'),
    });
    expect(run('/api/something', { present: true, valid: false })).toMatchObject({ status: 401 });
    expect(run('/api/something', { present: true, valid: true })).toEqual({ type: 'next' });
  });

  test('auth disabled lets everything through', () => {
    for (const path of ['/', '/contracts', '/api/data', '/login']) {
      expect(run(path, { auth: disabled })).toEqual({ type: 'next' });
      expect(run(path, { present: false, valid: false, auth: disabled })).toEqual({ type: 'next' });
    }
  });

  test('dev-open (local development without config) stays browsable', () => {
    expect(run('/', { auth: devOpen })).toEqual({ type: 'next' });
    expect(run('/contracts', { auth: devOpen })).toEqual({ type: 'next' });
  });

  test('unconfigured production fails closed with the missing variables — except the flow paths', () => {
    expect(run('/', { auth: unconfigured })).toEqual({
      type: 'not-authorized',
      status: 503,
      message: expect.stringContaining('Authentication is required but not configured'),
      missing: ['OIDC_ISSUER', 'SESSION_SECRET'],
    });
    expect(run('/contracts?org=acme', { auth: unconfigured })).toMatchObject({ status: 503 });
    // /login, /api/auth/*, /logout render/execute so the error page itself works.
    expect(run('/login', { auth: unconfigured })).toEqual({ type: 'next' });
    expect(run('/api/auth/callback', { auth: unconfigured })).toEqual({ type: 'next' });
    expect(run('/logout', { auth: unconfigured })).toEqual({ type: 'next' });
  });

  test('returnTo survives only as a safe same-origin path', () => {
    // The gate composes returnTo from path+search it derived itself, so this
    // is belt-and-braces — assert the guard is applied anyway.
    const d = run('/contracts', { search: '?org=//evil.example' });
    if (d.type !== 'redirect') throw new Error('expected redirect');
    expect(d.location).toContain(`returnTo=${encodeURIComponent('/contracts?org=//evil.example')}`);
  });
});
