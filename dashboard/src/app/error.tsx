'use client';

import * as React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Stable message prefixes thrown by the registry data layer
 * (`src/lib/registry-client.ts`). Server components serialize thrown errors
 * to plain objects before they reach this boundary, so `instanceof
 * RegistryError` is always false here — the failure kind (including the
 * HTTP status class) is carried in the message prefix instead.
 */
const REGISTRY_FAILURES: { prefix: string; title: string; detail: string }[] = [
  {
    prefix: 'RegistryMisconfigured:',
    title: 'Registry not configured',
    detail:
      'The dashboard is running live without complete registry configuration. Check NEXT_PUBLIC_REGISTRY_URL, REGISTRY_TOKEN and REGISTRY_ORGS (server-side), then retry.',
  },
  {
    prefix: 'RegistryRejected:',
    title: 'Registry rejected the request',
    detail:
      'The registry answered with a client error (4xx) — usually a credential, permission or URL problem rather than an outage. Check NEXT_PUBLIC_REGISTRY_URL, REGISTRY_TOKEN and REGISTRY_ORGS (server-side), then retry.',
  },
  {
    prefix: 'RegistryInvalidResponse:',
    title: 'Registry sent an unexpected response',
    detail:
      'The registry is reachable, but its payload does not match the expected API schema. Retrying will not help until the registry service is updated.',
  },
  {
    prefix: 'RegistryUnreachable:',
    title: 'Could not reach the registry',
    detail:
      'The registry service is unreachable or failing (network error, timeout, or 5xx). Check NEXT_PUBLIC_REGISTRY_URL and that the service is running, then try again.',
  },
];

function registryFailureOf(message: string) {
  return REGISTRY_FAILURES.find((f) => message.startsWith(f.prefix));
}

/**
 * Route-level error boundary. Every failure is logged (with the Next.js
 * digest so it can be correlated server-side) and rendered with a Retry.
 * Registry failures get copy that matches the failure class (config error,
 * 4xx rejection, schema drift, or unreachable) instead of one message for
 * everything; render bugs no longer masquerade as "registry unreachable".
 */
export default function PageError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    console.error('[dashboard] route error:', error);
  }, [error]);

  const registryFailure = registryFailureOf(error.message);

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
      <AlertTriangle className="h-10 w-10 text-[var(--warning)]" aria-hidden="true" />
      <h1 className="text-lg font-semibold">
        {registryFailure ? registryFailure.title : 'Something went wrong'}
      </h1>
      <p className="max-w-md text-sm text-muted-foreground">
        {registryFailure
          ? registryFailure.detail
          : 'An unexpected error occurred while rendering this page. Retry, or reload the console.'}
      </p>
      {registryFailure && (
        <p className="max-w-md font-mono text-xs text-muted-foreground/80">
          {error.message}
        </p>
      )}
      {error.digest && (
        <p className="text-xs text-muted-foreground">
          error digest: <span className="font-mono text-foreground">{error.digest}</span>
        </p>
      )}
      <Button variant="outline" className="mt-2" onClick={() => reset()}>
        Retry
      </Button>
    </div>
  );
}
