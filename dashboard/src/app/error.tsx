'use client';

import * as React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Stable message prefixes thrown by the registry data layer
 * (`src/lib/registry-client.ts`). Server components serialize thrown errors
 * to plain objects before they reach this boundary, so `instanceof
 * RegistryError` is always false here — the failure kind is carried in the
 * message prefix instead.
 */
const REGISTRY_PREFIXES = ['RegistryUnreachable:', 'RegistryMisconfigured:'];

function isRegistryFailure(message: string): boolean {
  return REGISTRY_PREFIXES.some((p) => message.startsWith(p));
}

/**
 * Route-level error boundary. Every failure is logged (with the Next.js
 * digest so it can be correlated server-side) and rendered with a Retry.
 * Registry failures get their specific copy; render bugs no longer masquerade
 * as "registry unreachable".
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

  const registryError = isRegistryFailure(error.message);

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
      <AlertTriangle className="h-10 w-10 text-[var(--warning)]" aria-hidden="true" />
      <h1 className="text-lg font-semibold">
        {registryError ? 'Could not reach the registry' : 'Something went wrong'}
      </h1>
      <p className="max-w-md text-sm text-muted-foreground">
        {registryError
          ? 'The registry service returned an error or is unreachable. Check NEXT_PUBLIC_REGISTRY_URL and try again.'
          : 'An unexpected error occurred while rendering this page. Retry, or reload the console.'}
      </p>
      {registryError && (
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
