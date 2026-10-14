/**
 * Authentication gate for every console route (issue #163).
 *
 * This is Next.js 16's proxy (the middleware renamed). It is a thin adapter:
 * the decision matrix lives in `src/lib/auth/gate.ts` (pure, unit-tested),
 * this file only maps decisions onto responses:
 *
 * - `next`        → NextResponse.next()
 * - `redirect`    → 302 to the (already sanitized) app-relative location
 * - not-authorized → 401 JSON for /api/*, actionable 503 HTML page otherwise
 *
 * Static assets are excluded via the matcher (they cannot leak registry
 * data). The gate never reads the registry and never touches
 * REGISTRY_TOKEN — it only verifies the signed session cookie, so a
 * misconfigured auth layer cannot become a data-leak amplifier.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { resolveAuthConfig, REQUIRED_AUTH_VARS, type AuthConfig } from '@/lib/auth/config';
import { decideGate } from '@/lib/auth/gate';
import { verifySessionToken, SESSION_COOKIE } from '@/lib/auth/session';

let warnedDisabled = false;
let warnedDevOpen = false;

function warnOnce(config: AuthConfig): void {
  if (config.mode === 'disabled' && !warnedDisabled) {
    warnedDisabled = true;
    console.warn(
      '[dashboard] AUTH_DISABLED=true — the console is serving WITHOUT user authentication. Never expose this deployment publicly in live mode; the gate exists because the console holds a server-side registry credential.',
    );
  }
  if (config.mode === 'dev-open' && !warnedDevOpen) {
    warnedDevOpen = true;
    console.warn(
      '[dashboard] OIDC auth is not configured — the gate is open because this is a non-production build (set OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, SESSION_SECRET, or AUTH_DISABLED=true for public demo deployments). Production builds fail closed with an actionable error instead.',
    );
  }
}

function misconfiguredPage(missing: string[]): string {
  const rows = REQUIRED_AUTH_VARS.filter((v) => missing.includes(v.name))
    .map((v) => `<tr><td><code>${v.name}</code></td><td>${v.what}</td></tr>`)
    .join('');
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Console authentication not configured</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0a0c;color:#e4e4e7;font:14px/1.6 ui-sans-serif,system-ui,sans-serif;padding:24px}
  main{max-width:560px;width:100%}
  .card{border:1px solid #232329;border-radius:10px;background:#0c0c0f;padding:28px}
  h1{font-size:17px;margin:0 0 8px;color:#fafafa}
  p{margin:0 0 14px;color:#a1a1aa}
  table{width:100%;border-collapse:collapse;font-size:13px}
  td{border-top:1px solid #232329;padding:8px 8px 8px 0;vertical-align:top;color:#a1a1aa}
  td:first-child{white-space:nowrap;padding-right:16px}
  code{font-family:ui-monospace,SFMono-Regular,monospace;color:#34d399;font-size:12px}
  .fix{margin-top:16px;border-top:1px solid #232329;padding-top:14px}
</style></head>
<body><main><div class="card">
<h1>Console authentication is not configured</h1>
<p>This deployment runs in production mode without user authentication. Because the console performs registry reads with a server-side credential, it refuses to serve pages until the login gate is configured.</p>
<table>${rows}</table>
<div class="fix"><p>Set the variables above in the deployment environment and redeploy. For public demo deployments that must stay open, set <code>AUTH_DISABLED=true</code> explicitly — see the dashboard README’s deployment boundary section.</p></div>
</div></main></body></html>`;
}

export default async function proxy(request: NextRequest): Promise<NextResponse> {
  const auth = resolveAuthConfig();
  warnOnce(auth);

  let sessionValid = false;
  const sessionRaw = request.cookies.get(SESSION_COOKIE)?.value;
  if (sessionRaw && auth.mode === 'enforced') {
    sessionValid = (await verifySessionToken(sessionRaw, auth.sessionSecret)) !== null;
  }

  const decision = decideGate({
    path: request.nextUrl.pathname,
    search: request.nextUrl.search,
    sessionCookiePresent: sessionRaw !== undefined,
    sessionValid,
    auth,
  });

  switch (decision.type) {
    case 'next':
      return NextResponse.next();
    case 'redirect':
      // 302 per the issue's redirect contract (Next defaults to 307; the
      // gate's redirects are all GET navigations).
      return NextResponse.redirect(new URL(decision.location, request.nextUrl.origin), 302);
    case 'not-authorized': {
      if (request.nextUrl.pathname.startsWith('/api/')) {
        return NextResponse.json(
          {
            error: {
              code: decision.status === 401 ? 'unauthenticated' : 'auth_misconfigured',
              message: decision.message,
            },
          },
          { status: decision.status },
        );
      }
      const body = misconfiguredPage(decision.missing ?? []);
      return new NextResponse(body, {
        status: decision.status,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
  }
}

export const config = {
  matcher: [
    // Everything except Next internals and static assets (no registry data
    // can flow through them). Auth flow paths are handled inside the gate.
    '/((?!_next/static|_next/image|favicon.ico|icon.svg|robots.txt|sitemap.xml).*)',
  ],
};
