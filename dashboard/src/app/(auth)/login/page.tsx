import { AlertTriangle, CheckCircle2, LogIn, Settings2 } from 'lucide-react';
import { redirect } from 'next/navigation';
import { authConfigProblems, REQUIRED_AUTH_VARS, resolveAuthConfig } from '@/lib/auth/config';
import { safeReturnTo } from '@/lib/auth/return-to';

/**
 * /login (issue #163).
 *
 * Server component. The proxy gate sends every unauthenticated console
 * request here with `returnTo`, and failed round-trips back with an
 * `error` code — every code maps to a human-readable explanation (never a
 * bare digest, acceptance criterion 4). When the deployment is
 * misconfigured (production, no OIDC env), the page renders the missing
 * variables and the fix — the actionable error the gate cannot render
 * itself.
 */

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Sign in',
  description: 'Sign in to the BRIDGE Registry Console.',
};

const ERROR_MESSAGES: Record<string, { title: string; detail: string }> = {
  session_expired: {
    title: 'Your session has expired',
    detail: 'Sign in again to continue where you left off.',
  },
  state_mismatch: {
    title: 'Sign-in could not be verified',
    detail:
      'The sign-in attempt was stale or incomplete (state check failed). Start again; if it keeps happening, your browser may be blocking cookies for this site.',
  },
  provider_error: {
    title: 'The identity provider reported a problem',
    detail:
      'The provider rejected or aborted the sign-in round-trip. Retry; if it persists, check the application logs at your provider.',
  },
  provider_unavailable: {
    title: 'Identity provider unreachable',
    detail:
      'The console could not fetch the provider’s discovery document. Check the issuer URL and the provider’s status page.',
  },
  id_token_invalid: {
    title: 'Sign-in response rejected',
    detail:
      'The identity token failed validation (issuer, audience, nonce or expiry). Start again; if it persists, the provider application configuration does not match the console’s environment.',
  },
  callback_failed: {
    title: 'Sign-in failed',
    detail: 'An unexpected failure occurred while completing sign-in. Retry from the button below.',
  },
};

const NOTICE_MESSAGES: Record<string, { title: string; detail: string }> = {
  signed_out: {
    title: 'You have signed out',
    detail: 'Your console session has ended. Sign in again when you need it.',
  },
};

function Banner({
  tone,
  title,
  detail,
}: {
  tone: 'error' | 'notice';
  title: string;
  detail: string;
}) {
  const Icon = tone === 'error' ? AlertTriangle : CheckCircle2;
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      aria-live="polite"
      className={
        tone === 'error'
          ? 'flex gap-3 rounded-md border border-[var(--breaking)]/40 bg-[var(--breaking-soft)] p-3'
          : 'flex gap-3 rounded-md border border-[var(--safe)]/40 bg-[var(--safe-soft)] p-3'
      }
    >
      <Icon
        aria-hidden="true"
        className={
          tone === 'error'
            ? 'mt-0.5 h-4 w-4 shrink-0 text-[var(--breaking)]'
            : 'mt-0.5 h-4 w-4 shrink-0 text-[var(--safe)]'
        }
      />
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string; returnTo?: string }>;
}) {
  const sp = await searchParams;
  const auth = resolveAuthConfig();

  if (auth.mode === 'disabled') {
    // No gate: /login has nothing to do. (The proxy also lets everything
    // through in this mode; this covers direct navigation.)
    redirect('/');
  }

  const returnTo = safeReturnTo(sp.returnTo);
  const signinHref =
    returnTo !== '/' ? `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}` : '/api/auth/login';

  const error = sp.error ? ERROR_MESSAGES[sp.error] : undefined;
  const notice = !error && sp.notice ? NOTICE_MESSAGES[sp.notice] : undefined;

  if (auth.mode === 'unconfigured' || auth.mode === 'dev-open') {
    const missingVars = REQUIRED_AUTH_VARS.filter((v) => auth.missing.includes(v.name));
    return (
      <div className="space-y-4">
        <Banner
          tone="error"
          title="Console authentication is not configured"
          detail="This deployment runs the console with a server-side registry credential, so a login gate is required before pages are served."
        />
        <div className="rounded-md border border-border bg-card p-4">
          <div className="mb-3 flex items-center gap-2">
            <Settings2 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-foreground">Required environment</h2>
          </div>
          <ul className="space-y-2.5">
            {(missingVars.length > 0 ? missingVars : REQUIRED_AUTH_VARS).map((v) => (
              <li key={v.name} className="text-xs text-muted-foreground">
                <code className="text-primary">{v.name}</code>
                <span className="mt-0.5 block">{v.what}</span>
              </li>
            ))}
          </ul>
          <p className="mt-4 border-t border-border pt-3 text-xs leading-relaxed text-muted-foreground">
            Set the variables and redeploy. Public demo deployments that must stay open can set{' '}
            <code className="text-primary">AUTH_DISABLED=true</code> explicitly — see the dashboard
            README’s deployment boundary section.
          </p>
        </div>
      </div>
    );
  }

  let issuerHost = '';
  try {
    issuerHost = new URL(auth.issuer).host;
  } catch {
    issuerHost = '';
  }
  const configProblems = authConfigProblems(auth);

  return (
    <div className="space-y-4">
      {error && <Banner tone="error" title={error.title} detail={error.detail} />}
      {!error && notice && <Banner tone="notice" title={notice.title} detail={notice.detail} />}

      <div className="rounded-md border border-border bg-card p-5">
        <h1 className="text-base font-semibold text-foreground">Sign in to the console</h1>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Browse contracts, versions, dependency graphs and the audit log. The console verifies
          your identity through the organization’s single sign-on provider
          {issuerHost ? (
            <>
              {' '}
              at <code className="text-primary">{issuerHost}</code>
            </>
          ) : null}
          .
        </p>
        <a
          href={signinHref}
          className="mt-4 flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <LogIn className="h-4 w-4" aria-hidden="true" />
          Sign in with SSO
        </a>
        {returnTo !== '/' && (
          <p className="mt-3 text-[11px] text-muted-foreground">
            After signing in you will return to <code className="font-mono">{returnTo}</code>.
          </p>
        )}
      </div>

      {configProblems.length > 0 && (
        <div className="rounded-md border border-[var(--warning)]/40 bg-[var(--warning-soft)] p-3">
          <p className="flex items-center gap-2 text-xs font-medium text-foreground">
            <AlertTriangle className="h-3.5 w-3.5 text-[var(--warning)]" aria-hidden="true" />
            Configuration warnings
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-[11px] leading-relaxed text-muted-foreground">
            {configProblems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
