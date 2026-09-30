/**
 * Central route builders for the console (issue #122).
 *
 * Route parameters are data, not syntax: an org named `a/b` or a contract
 * base containing `%`, `?` or `#` must round-trip through URLs instead of
 * silently addressing the wrong route (or corrupting the path structure).
 * Every builder here encodes each segment individually with
 * `encodeURIComponent` — never a whole path — and assembles the result.
 * Pages and client components build contract URLs through these helpers
 * instead of interpolating raw values into template literals.
 */

function enc(segment: string): string {
  return encodeURIComponent(segment);
}

/** Querystring assembler that skips empty values (no dangling `org=`). */
function withParams(path: string, params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') qs.set(key, value);
  }
  const s = qs.toString();
  return s === '' ? path : `${path}?${s}`;
}

/**
 * `/contracts`, optionally scoped: `contractsHref()`, `contractsHref(org)`,
 * `contractsHref(org, project)`. Used by breadcrumbs, filter reset links and
 * the app shell's scope switcher.
 */
export function contractsHref(org?: string, project?: string): string {
  return withParams('/contracts', { org, project });
}

/**
 * `/contracts/{org}/{project}/{base}` plus any extra path segments (e.g.
 * `diff`). Each segment is encoded individually, so values containing `/`,
 * `%`, `?` or `#` cannot change the route structure.
 */
export function contractHref(
  org: string,
  project: string,
  base: string,
  ...rest: string[]
): string {
  return ['/contracts', org, project, base, ...rest].map(enc).join('/');
}

/**
 * Compatibility-report URL for one contract version pair:
 * `/contracts/{org}/{project}/{base}/diff?from={from}&to={to}`.
 */
export function contractDiffHref(
  org: string,
  project: string,
  base: string,
  from: string,
  to: string,
): string {
  return `${contractHref(org, project, base, 'diff')}?from=${enc(from)}&to=${enc(to)}`;
}

/** `/graph`, optionally scoped to one org. */
export function graphHref(org?: string): string {
  return withParams('/graph', { org });
}

/** `/audit`, optionally filtered by action. */
export function auditHref(action?: string): string {
  return withParams('/audit', { action });
}

/**
 * DOM-safe `<option>` value for the app shell's scope switcher:
 * `enc(org)/enc(project)` (or just `enc(org)` when no project is given).
 * Encoding the segments *inside* the value keeps the later `split('/')`
 * unambiguous even when an org or project name itself contains a slash —
 * the raw `${org}/${project}` interpolation used before did not.
 */
export function scopeOptionValue(org: string, project?: string): string {
  return project === undefined ? enc(org) : `${enc(org)}/${enc(project)}`;
}

/**
 * Inverse of {@link scopeOptionValue}. Returns `null` for the `all` sentinel
 * (and for empty values), so the caller can navigate back to the unscoped
 * list. Only ever fed values this module produced, so `decodeURIComponent`
 * cannot throw on malformed escapes in practice.
 */
export function parseScopeOptionValue(value: string): { org: string; project?: string } | null {
  if (value === '' || value === 'all') return null;
  const sep = value.indexOf('/');
  if (sep === -1) return { org: decodeURIComponent(value) };
  return {
    org: decodeURIComponent(value.slice(0, sep)),
    project: decodeURIComponent(value.slice(sep + 1)),
  };
}
