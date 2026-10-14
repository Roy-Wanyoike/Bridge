/**
 * Web-standard response builder for flow results (issue #163).
 *
 * Route handlers return plain `Response` objects — no Next-specific cookie
 * API — so the auth flow stays testable without the Next runtime and
 * behaves identically in every runtime Next supports.
 */

import type { CookieDirective, FlowResult } from './flows';

function cookieString(c: CookieDirective): string {
  const parts = [`${c.name}=${c.value}`, 'Path=/', c.clear ? 'Max-Age=0' : `Max-Age=${c.maxAge ?? 0}`, 'SameSite=Lax'];
  if (c.httpOnly !== false) parts.push('HttpOnly');
  if (c.secure) parts.push('Secure');
  return parts.join('; ');
}

export function flowResponse(result: FlowResult): Response {
  const headers = new Headers();
  if (result.redirect) headers.set('location', result.redirect);
  for (const c of result.cookies) headers.append('set-cookie', cookieString(c));
  headers.set('cache-control', 'no-store');
  return new Response(null, { status: result.status, headers });
}
