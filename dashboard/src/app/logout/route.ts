import type { NextRequest } from 'next/server';
import { logoutCookies } from '@/lib/auth/flows';
import { flowResponse } from '@/lib/auth/http';

/**
 * GET /logout — clears the console session (issue #163).
 *
 * A GET route on purpose: the header's Sign out control is a plain anchor,
 * so logout works from any console page without JavaScript. Logout-CSRF via
 * cross-site top-level navigation is a nuisance-level concern only (the
 * worst outcome is a forced re-login) and the session cookie is SameSite=Lax
 * httpOnly, so the cookie value itself never leaks. If the provider exposes
 * an end-session endpoint, browsers complete it at the next sign-in;
 * clearing the console side is what protects registry data.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<Response> {
  const secure = (() => {
    const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
    if (proto) return proto === 'https';
    try {
      return new URL(request.nextUrl.origin).protocol === 'https:';
    } catch {
      return true;
    }
  })();
  return flowResponse({
    status: 302,
    redirect: '/login?notice=signed_out',
    cookies: logoutCookies(secure),
  });
}
