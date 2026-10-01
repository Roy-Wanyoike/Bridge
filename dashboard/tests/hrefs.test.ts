import { describe, expect, test } from 'vitest';
import {
  auditHref,
  contractDiffHref,
  contractHref,
  contractsHref,
  graphHref,
  parseScopeOptionValue,
  scopeOptionValue,
} from '@/lib/hrefs';

/**
 * URL-encoding regression tests (issues #122/#137, #123 item c).
 *
 * Identifiers are data, not syntax: names containing `/`, `#`, `%`, `?` must
 * round-trip through the central builders instead of silently changing the
 * route structure or addressing the wrong resource.
 */

function pathSegments(url: string): string[] {
  return new URL(url, 'http://console.test').pathname.split('/').filter(Boolean).map(decodeURIComponent);
}

describe('contractHref', () => {
  test('encodes every segment individually — org containing / and #', () => {
    const url = contractHref('a/b', 'c#d', 'e?f');
    expect(url).toBe('/contracts/a%2Fb/c%23d/e%3Ff');
    // The route structure survives: 4 path segments, each decoding to the input.
    expect(pathSegments(url)).toEqual(['contracts', 'a/b', 'c#d', 'e?f']);
  });

  test('encodes % and + and space so no re-parsing can corrupt them', () => {
    const url = contractHref('100%pct', 'plus+plus', 'two spaces');
    expect(url).toBe('/contracts/100%25pct/plus%2Bplus/two%20spaces');
    expect(pathSegments(url)).toEqual(['contracts', '100%pct', 'plus+plus', 'two spaces']);
  });

  test('appends extra path segments (e.g. diff) with the same encoding', () => {
    const url = contractHref('a/b', 'p', 'base', 'diff');
    expect(url).toBe('/contracts/a%2Fb/p/base/diff');
  });
});

describe('contractDiffHref', () => {
  test('keeps # in query values from cutting off the params', () => {
    const url = contractDiffHref('a/b', 'p', 'base', 'v#1', 'v/2');
    const parsed = new URL(url, 'http://console.test');
    expect(parsed.pathname).toBe('/contracts/a%2Fb/p/base/diff');
    expect(parsed.searchParams.get('from')).toBe('v#1');
    expect(parsed.searchParams.get('to')).toBe('v/2');
    expect(url).toBe('/contracts/a%2Fb/p/base/diff?from=v%231&to=v%2F2');
  });

  test('round-trips spaces and plus signs in version ids', () => {
    const parsed = new URL(contractDiffHref('o', 'p', 'b', 'v 1', 'v+2'), 'http://console.test');
    expect(parsed.searchParams.get('from')).toBe('v 1');
    expect(parsed.searchParams.get('to')).toBe('v+2');
  });
});

describe('contractsHref', () => {
  test('bare call has no dangling query', () => {
    expect(contractsHref()).toBe('/contracts');
  });

  test('org/project become query params that decode back', () => {
    const url = contractsHref('a/b', 'p#q');
    const parsed = new URL(url, 'http://console.test');
    expect(parsed.pathname).toBe('/contracts');
    expect(parsed.searchParams.get('org')).toBe('a/b');
    expect(parsed.searchParams.get('project')).toBe('p#q');
  });

  test('skips empty values instead of emitting org=', () => {
    expect(contractsHref('', 'p')).toBe('/contracts?project=p');
    expect(contractsHref('acme', '')).toBe('/contracts?org=acme');
  });
});

describe('graphHref / auditHref', () => {
  test('optional scope params follow the same skip-empty rule', () => {
    expect(graphHref()).toBe('/graph');
    expect(graphHref('a/b')).toBe('/graph?org=a%2Fb');
    expect(auditHref()).toBe('/audit');
    expect(new URL(auditHref('compat-check'), 'http://x').searchParams.get('action')).toBe(
      'compat-check',
    );
  });
});

describe('scopeOptionValue / parseScopeOptionValue', () => {
  test('plain org/project pair round-trips', () => {
    const value = scopeOptionValue('acme', 'payments');
    expect(value).toBe('acme/payments');
    expect(parseScopeOptionValue(value)).toEqual({ org: 'acme', project: 'payments' });
  });

  test('org containing / keeps its slash across the round trip (no fake project)', () => {
    const value = scopeOptionValue('a/b');
    expect(value).toBe('a%2Fb');
    const parsed = parseScopeOptionValue(value);
    expect(parsed).toEqual({ org: 'a/b' });
    expect(parsed?.project).toBeUndefined();
  });

  test('org containing # and project containing / round-trip unambiguously', () => {
    const value = scopeOptionValue('a#b', 'p/q');
    expect(value).toBe('a%23b/p%2Fq');
    expect(parseScopeOptionValue(value)).toEqual({ org: 'a#b', project: 'p/q' });
  });

  test('all sentinel and empty values parse to null', () => {
    expect(parseScopeOptionValue('all')).toBeNull();
    expect(parseScopeOptionValue('')).toBeNull();
  });
});
