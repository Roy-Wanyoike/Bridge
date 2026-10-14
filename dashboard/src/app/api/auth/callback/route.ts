import type { NextRequest } from 'next/server';
import { resolveAuthConfig } from '@/lib/auth/config';
import { handleCallbackFlow } from '@/lib/auth/flows';
import { flowResponse } from '@/lib/auth/http';

/**
 * GET /api/auth/callback — the OIDC redirect_uri target (issue #163).
 * Validates state + PKCE + nonce, exchanges the code server-side with the
 * client secret, issues the signed session cookie and redirects to the
 * sanitized original destination. Every failure mode lands on /login with
 * a readable error code — never a bare error digest.
 */
export const dynamic = 'force-dynamic';

function originOf(request: NextRequest): string {
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  if (host) return `${proto ?? 'https'}://${host}`;
  return request.nextUrl.origin;
}

export async function GET(request: NextRequest): Promise<Response> {
  const auth = resolveAuthConfig();
  if (auth.mode !== 'enforced') {
    return Response.redirect(new URL('/login', originOf(request)), 302);
  }
  const result = await handleCallbackFlow({ auth, origin: originOf(request) }, {
    url: request.nextUrl,
    getCookie: (name) => request.cookies.get(name)?.value,
  });
  return flowResponse(result);
}
