import type { NextRequest } from 'next/server';
import { resolveAuthConfig } from '@/lib/auth/config';
import { startLoginFlow } from '@/lib/auth/flows';
import { flowResponse } from '@/lib/auth/http';

/**
 * GET /api/auth/login — starts the OIDC authorization-code + PKCE flow
 * (issue #163). Always a 302: either to the provider's authorization
 * endpoint, or back to /login with a readable error.
 */
export const dynamic = 'force-dynamic';

function originOf(request: NextRequest): string {
  // Behind TLS terminators (Vercel, reverse proxies) the forwarded headers
  // carry the public origin; trust them like Next itself does for
  // x-forwarded-host, then fall back to the parsed request URL.
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  if (host) return `${proto ?? 'https'}://${host}`;
  return request.nextUrl.origin;
}

export async function GET(request: NextRequest): Promise<Response> {
  const auth = resolveAuthConfig();
  if (auth.mode !== 'enforced') {
    // Nothing to start: the gate is off or unconfigured. /login explains.
    return Response.redirect(new URL('/login', originOf(request)), 302);
  }
  const result = await startLoginFlow(
    { auth, origin: originOf(request) },
    request.nextUrl.searchParams.get('returnTo') ?? undefined,
  );
  return flowResponse(result);
}
