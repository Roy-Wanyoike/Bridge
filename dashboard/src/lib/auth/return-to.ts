/**
 * Open-redirect-safe `returnTo` handling (issue #163).
 *
 * After a successful OIDC round-trip the console sends the user back to the
 * route they originally requested. That requested path arrives from a URL
 * parameter, i.e. attacker-controlled data, so it must be a *path-only*,
 * same-origin string. Anything with a scheme, a protocol-relative prefix,
 * a backslash (browsers treat `\` like `/`), control characters or
 * suspicious whitespace falls back to `/`.
 */

const MAX_RETURN_TO_LENGTH = 2048;

/** Returns a safe in-app path (starts with exactly one "/"), or "/" when the input is not trustworthy. */
export function safeReturnTo(raw: string | undefined | null): string {
  if (typeof raw !== 'string') return '/';
  if (raw === '' || raw.length > MAX_RETURN_TO_LENGTH) return '/';

  const value = raw;
  // Accept a full same-origin URL only when it matches an expected origin;
  // callers pass just paths, so any absolute URL is rejected outright.
  if (value.startsWith('http://') || value.startsWith('https://')) return '/';

  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  if (value.includes('\\')) return '/';
  if (/%2f/i.test(value) && decodeSafe(value)?.toLowerCase().includes('//')) return '/';

  // Control characters and whitespace tricks (\n, \r, tab) can split
  // redirect handling in some clients — none of them are legitimate here.
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return '/';
  }
  return value;
}

function decodeSafe(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** Wraps a path into the `returnTo` query value for /login and the login-start route. */
export function returnToParam(path: string): string {
  return encodeURIComponent(safeReturnTo(path));
}
