import { cookies } from 'next/headers';
import { AppShell } from '@/components/app-shell';
import { resolveAuthConfig } from '@/lib/auth/config';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/session';
import { getRegistryClient, isDemoMode } from '@/lib/registry-client';

/**
 * Console shell layout — only reachable with a valid session in enforced
 * mode (the proxy gate guarantees it; this layout never renders the
 * org-populated shell for unauthenticated requests, see issue #163).
 *
 * The session claim read here is display-only (name/email chip + Sign out
 * anchor); every privilege still flows through the server-side registry
 * client, exactly as before the gate existed.
 */
export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const auth = resolveAuthConfig();

  let session: { name?: string; email?: string; sub: string } | null = null;
  if (auth.mode === 'enforced') {
    const jar = await cookies();
    const raw = jar.get(SESSION_COOKIE)?.value;
    if (raw) {
      const claims = await verifySessionToken(raw, auth.sessionSecret);
      if (claims) {
        session = { sub: claims.sub, ...(claims.name !== undefined ? { name: claims.name } : {}), ...(claims.email !== undefined ? { email: claims.email } : {}) };
      }
    }
  }

  let orgs: Awaited<ReturnType<typeof getOrgs>> = [];
  try {
    orgs = await getOrgs();
  } catch (err) {
    // The shell still renders (pages surface the error via their boundary);
    // the failure is logged so the sidebar silently losing org scope is
    // diagnosable from server logs.
    console.error('[dashboard] layout: failed to load orgs for the shell:', err);
    orgs = [];
  }

  return (
    <AppShell orgs={orgs} demoMode={isDemoMode()} authEnabled={auth.mode === 'enforced'} session={session}>
      {children}
    </AppShell>
  );
}

async function getOrgs() {
  const client = getRegistryClient();
  return client.listOrgs();
}
