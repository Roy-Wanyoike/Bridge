import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Route-level loading states, composed from the shared `Skeleton` primitive.
 * Rendered by Next.js automatically from each route's `loading.tsx` while
 * the server component tree awaits the registry client.
 */

function SkeletonTable({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="flex flex-col" aria-hidden="true">
      <div className="flex gap-4 border-b border-border px-3 py-3">
        {Array.from({ length: cols }, (_, i) => (
          <Skeleton key={i} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex items-center gap-4 border-b border-border px-3 py-4 last:border-0">
          {Array.from({ length: cols }, (_, i) => (
            <Skeleton key={i} className={i === 0 ? 'h-3.5 w-40' : 'h-3 flex-1'} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Overview (/): stat cards, verdict cards, recent publishes. */
export function OverviewSkeleton() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6" aria-busy="true" aria-label="Loading overview">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-44" />
          <Skeleton className="h-4 w-72" />
        </div>
        <Skeleton className="h-9 w-40" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Card key={i} className="p-5">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="mt-3 h-9 w-16" />
          </Card>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Card key={i} className="p-5">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="mt-3 h-8 w-12" />
            <Skeleton className="mt-3 h-3 w-full" />
          </Card>
        ))}
      </div>
      <Card className="p-6">
        <Skeleton className="h-4 w-40" />
        <div className="mt-4">
          <SkeletonTable rows={5} cols={5} />
        </div>
      </Card>
    </div>
  );
}

/** Contracts (/contracts) and audit (/audit): filter card + table. */
export function TableSkeleton({ label, cols = 6 }: { label: string; cols?: number }) {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6" aria-busy="true" aria-label={label}>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-44" />
        <Skeleton className="h-4 w-64" />
      </div>
      <Card className="p-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_auto]">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-9" />
            ))}
          </div>
          <Skeleton className="h-9 w-36" />
        </div>
      </Card>
      <Card className="overflow-hidden">
        <SkeletonTable rows={7} cols={cols} />
      </Card>
    </div>
  );
}

/** Contract detail (/contracts/[org]/[project]/[contract]): header, snippet, tabs. */
export function ContractDetailSkeleton() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6" aria-busy="true" aria-label="Loading contract">
      <Skeleton className="h-4 w-80" />
      <div className="flex flex-col gap-4">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-4 w-[28rem] max-w-full" />
        <div className="flex flex-wrap gap-6">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-4 w-36" />
          ))}
        </div>
      </div>
      <Card className="p-5">
        <Skeleton className="h-4 w-36" />
        <div className="mt-4 flex flex-col gap-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      </Card>
      <div>
        <Skeleton className="h-9 w-80" />
        <div className="mt-5 flex flex-col gap-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="flex flex-col gap-2">
              <Skeleton className="h-5 w-28" />
              <Skeleton className="h-4 w-64" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Diff (/contracts/.../diff): header, verdict banner, summary cards, changes. */
export function DiffSkeleton() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6" aria-busy="true" aria-label="Loading compatibility report">
      <Skeleton className="h-4 w-72" />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-4 w-64" />
        </div>
        <Skeleton className="h-8 w-52" />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border p-5">
        <div className="flex items-center gap-4">
          <Skeleton className="h-8 w-8 rounded-full" />
          <div className="flex flex-col gap-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-72" />
          </div>
        </div>
        <Skeleton className="h-6 w-44" />
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Card key={i} className="p-5">
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="mt-3 h-8 w-14" />
          </Card>
        ))}
      </div>
      <Card className="p-6">
        <Skeleton className="h-4 w-28" />
        <div className="mt-4 flex flex-col gap-3">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="rounded-md border border-border p-4">
              <Skeleton className="h-4 w-56" />
              <Skeleton className="mt-3 h-3.5 w-full" />
              <Skeleton className="mt-2 h-3.5 w-2/3" />
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

/** Graph (/graph): graph card + two tables. */
export function GraphSkeleton() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6" aria-busy="true" aria-label="Loading dependency graph">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-52" />
          <Skeleton className="h-4 w-80" />
        </div>
        <Skeleton className="h-9 w-64" />
      </div>
      <Card className="p-4">
        <Skeleton className="h-[28rem] w-full" />
        <div className="mt-4 border-t border-border pt-4">
          <div className="flex flex-wrap gap-6">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-3.5 w-40" />
            ))}
          </div>
        </div>
      </Card>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        {[0, 1].map((i) => (
          <Card key={i} className="p-6">
            <Skeleton className="h-4 w-44" />
            <div className="mt-4">
              <SkeletonTable rows={5} cols={4} />
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
