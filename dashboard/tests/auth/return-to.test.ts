import { describe, expect, test } from 'vitest';
import { safeReturnTo } from '@/lib/auth/return-to';

describe('safeReturnTo — open-redirect guard (issue #163 acceptance 3)', () => {
  test('accepts in-app paths, including querystrings and encoded segments', () => {
    expect(safeReturnTo('/')).toBe('/');
    expect(safeReturnTo('/contracts')).toBe('/contracts');
    expect(safeReturnTo('/contracts?org=acme&project=orders')).toBe('/contracts?org=acme&project=orders');
    expect(safeReturnTo('/contracts/acme/orders%2Fmain')).toBe('/contracts/acme/orders%2Fmain');
    expect(safeReturnTo('/contracts/acme/orders/versions/v2?tab=diff')).toBe(
      '/contracts/acme/orders/versions/v2?tab=diff',
    );
  });

  test('falls back to "/" for absolute and protocol-relative URLs', () => {
    expect(safeReturnTo('https://evil.example/steal')).toBe('/');
    expect(safeReturnTo('http://evil.example')).toBe('/');
    expect(safeReturnTo('//evil.example')).toBe('/');
    expect(safeReturnTo('/\\evil.example')).toBe('/');
  });

  test('falls back to "/" for schemes and trick encodings', () => {
    expect(safeReturnTo('javascript:alert(1)')).toBe('/');
    expect(safeReturnTo('data:text/html,hi')).toBe('/');
    expect(safeReturnTo('/%2f%2fevil.example')).toBe('/');
    expect(safeReturnTo('mailto:attacker@example.com')).toBe('/');
  });

  test('falls back to "/" for control characters and whitespace tricks', () => {
    expect(safeReturnTo('/contracts\nX-Injected: 1')).toBe('/');
    expect(safeReturnTo('/contracts\r\nSet-Cookie: x')).toBe('/');
    expect(safeReturnTo('/contracts\tx')).toBe('/');
    expect(safeReturnTo(' /contracts')).toBe('/');
  });

  test('falls back to "/" for garbage and oversize input', () => {
    expect(safeReturnTo(undefined)).toBe('/');
    expect(safeReturnTo(null)).toBe('/');
    expect(safeReturnTo('')).toBe('/');
    expect(safeReturnTo('contracts')).toBe('/');
    expect(safeReturnTo(`/${'a'.repeat(3000)}`)).toBe('/');
  });
});
