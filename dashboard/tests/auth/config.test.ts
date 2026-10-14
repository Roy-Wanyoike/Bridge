import { describe, expect, test } from 'vitest';
import { authConfigProblems, resolveAuthConfig, REQUIRED_AUTH_VARS } from '@/lib/auth/config';

const ENFORCED_ENV = {
  NODE_ENV: 'production',
  OIDC_ISSUER: 'https://id.example.com/',
  OIDC_CLIENT_ID: 'bridge-console',
  OIDC_CLIENT_SECRET: 'client-secret-value',
  SESSION_SECRET: 's'.repeat(64),
};

describe('auth configuration resolution (issue #163)', () => {
  test('AUTH_DISABLED=true|1 disables the gate explicitly', () => {
    expect(resolveAuthConfig({ ...ENFORCED_ENV, AUTH_DISABLED: 'true' }).mode).toBe('disabled');
    expect(resolveAuthConfig({ ...ENFORCED_ENV, AUTH_DISABLED: '1' }).mode).toBe('disabled');
    // Loose values must NOT disable anything (booleans never coerced loosely).
    expect(resolveAuthConfig({ ...ENFORCED_ENV, AUTH_DISABLED: 'TRUE' }).mode).toBe('enforced');
    expect(resolveAuthConfig({ ...ENFORCED_ENV, AUTH_DISABLED: 'yes' }).mode).toBe('enforced');
    expect(resolveAuthConfig({ ...ENFORCED_ENV, AUTH_DISABLED: '' }).mode).toBe('enforced');
  });

  test('full config in production resolves to enforced', () => {
    const config = resolveAuthConfig(ENFORCED_ENV);
    expect(config.mode).toBe('enforced');
    if (config.mode !== 'enforced') return;
    expect(config.issuer).toBe('https://id.example.com/');
    expect(config.sessionTtlSeconds).toBe(8 * 60 * 60);
  });

  test('issuer gains the canonical trailing slash', () => {
    const config = resolveAuthConfig({ ...ENFORCED_ENV, OIDC_ISSUER: 'https://id.example.com' });
    if (config.mode !== 'enforced') throw new Error('expected enforced');
    expect(config.issuer).toBe('https://id.example.com/');
  });

  test('production without config fails closed and names the missing variables', () => {
    const config = resolveAuthConfig({ NODE_ENV: 'production' });
    expect(config.mode).toBe('unconfigured');
    if (config.mode !== 'unconfigured') return;
    expect(config.missing).toEqual(['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'SESSION_SECRET']);
  });

  test('non-production without config stays open for local development', () => {
    expect(resolveAuthConfig({ NODE_ENV: 'development' }).mode).toBe('dev-open');
    expect(resolveAuthConfig({}).mode).toBe('dev-open');
  });

  test('partial config still fails closed in production', () => {
    const config = resolveAuthConfig({ ...ENFORCED_ENV, SESSION_SECRET: undefined });
    expect(config.mode).toBe('unconfigured');
    if (config.mode !== 'unconfigured') return;
    expect(config.missing).toEqual(['SESSION_SECRET']);
  });

  test('session TTL parses and clamps', () => {
    const at = (v: string | undefined) => {
      const c = resolveAuthConfig({ ...ENFORCED_ENV, SESSION_TTL_SECONDS: v });
      return c.mode === 'enforced' ? c.sessionTtlSeconds : -1;
    };
    expect(at(undefined)).toBe(8 * 60 * 60);
    expect(at('900')).toBe(900);
    expect(at('10')).toBe(5 * 60); // below 5m floor
    expect(at('99999999')).toBe(7 * 24 * 60 * 60); // above 7d ceiling
    expect(at('not-a-number')).toBe(8 * 60 * 60);
  });

  test('config problems flag weak secrets and bad issuers, only in enforced mode', () => {
    expect(authConfigProblems(resolveAuthConfig({ NODE_ENV: 'development' }))).toEqual([]);
    const good = resolveAuthConfig(ENFORCED_ENV);
    expect(authConfigProblems(good)).toEqual([]);
    const weak = resolveAuthConfig({ ...ENFORCED_ENV, SESSION_SECRET: 'short', OIDC_ISSUER: 'http://id.example.com' });
    const problems = authConfigProblems(weak);
    expect(problems.some((p) => p.startsWith('SESSION_SECRET'))).toBe(true);
    expect(problems.some((p) => p.startsWith('OIDC_ISSUER'))).toBe(true);
    const badRedirect = resolveAuthConfig({ ...ENFORCED_ENV, OIDC_REDIRECT_URI: 'https://x.example/other' });
    expect(authConfigProblems(badRedirect).some((p) => p.startsWith('OIDC_REDIRECT_URI'))).toBe(true);
  });

  test('required var catalog covers exactly the gate variables', () => {
    expect(REQUIRED_AUTH_VARS.map((v) => v.name)).toEqual([
      'OIDC_ISSUER',
      'OIDC_CLIENT_ID',
      'OIDC_CLIENT_SECRET',
      'SESSION_SECRET',
    ]);
  });
});
