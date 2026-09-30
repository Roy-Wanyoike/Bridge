import Link from 'next/link';
import { SearchX } from 'lucide-react';
import { AuditDetailDialog } from '@/components/audit-detail-dialog';
import { ClassificationBadge } from '@/components/classification-badge';
import { EmptyState } from '@/components/empty-state';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDateTime } from '@/lib/format';
import { contractHref } from '@/lib/hrefs';
import { AUDIT_FETCH_LIMIT, getRegistryClient } from '@/lib/registry-client';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Audit log',
  description: 'Publishes, pulls and compatibility checks recorded by the registry service.',
};

const ACTIONS = [
  { value: '', label: 'All actions' },
  { value: 'publish', label: 'publish' },
  { value: 'pull', label: 'pull' },
  { value: 'compat-check', label: 'compat-check' },
];

const ACTION_VARIANT: Record<string, 'default' | 'secondary' | 'outline'> = {
  publish: 'default',
  pull: 'secondary',
  'compat-check': 'outline',
};

type SP = Promise<{ action?: string; actor?: string; contract?: string }>;

export default async function AuditPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const action = sp.action ?? '';
  const actor = sp.actor ?? '';
  const contract = sp.contract ?? '';

  const client = getRegistryClient();
  // ONE bounded fetch serves the whole view. The action/actor filters are
  // exact-match, so applying them client-side over the fetched rows is
  // semantically identical to the API's server-side filtering — and the
  // actor dropdown derives from the very same rows, so the old pattern of
  // pulling the (implicit-default-capped) log twice per request is gone.
  // The contract filter stays client-side because the view matches
  // substrings, which the API does not. The fetch is capped at
  // AUDIT_FETCH_LIMIT (newest-first per the service contract) so a long
  // trail can never bloat the request or the render.
  const allEntries = await client.listAudit({ limit: AUDIT_FETCH_LIMIT });
  const actors = [...new Set(allEntries.map((e) => e.actor))].sort();
  const entries = allEntries.filter((e) => {
    if (action && e.action !== action) return false;
    if (actor && e.actor !== actor) return false;
    if (contract && !e.contract.toLowerCase().includes(contract.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {entries.length} entr{entries.length === 1 ? 'y' : 'ies'} recorded by the registry
            service.
          </p>
        </div>
      </header>

      <Card className="p-4">
        <form method="GET" action="/audit" className="grid gap-3 md:grid-cols-[1fr_auto]">
          <div className="grid gap-3 sm:grid-cols-3">
            <label>
              <span className="sr-only">Action</span>
              <Select name="action" defaultValue={action} aria-label="Filter by action">
                {ACTIONS.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </Select>
            </label>
            <label>
              <span className="sr-only">Actor</span>
              <Select name="actor" defaultValue={actor} aria-label="Filter by actor">
                <option value="">All actors</option>
                {actors.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </Select>
            </label>
            <label>
              <span className="sr-only">Contract</span>
              <Input name="contract" defaultValue={sp.contract ?? ''} placeholder="Contract contains..." />
            </label>
          </div>
          <div className="flex items-center gap-2 md:justify-end">
            <button type="submit" className={cn(buttonVariants({ size: 'sm' }), 'h-9')}>
              Apply
            </button>
            <Link href="/audit" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
              Reset
            </Link>
          </div>
        </form>
      </Card>

      {entries.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title="No audit entries match"
          description="Loosen the filters to see more of the audit trail."
        />
      ) : (
        <Card className="overflow-hidden">
          <Table>
            <caption className="sr-only">
              Audit trail: time, action, actor, contract and recorded detail
            </caption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Time</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Contract</TableHead>
                <TableHead>Detail</TableHead>
                <TableHead className="text-right">Record</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {formatDateTime(e.at)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={ACTION_VARIANT[e.action] ?? 'secondary'} className="font-mono">
                      {e.action}
                    </Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{e.actor}</TableCell>
                  <TableCell>
                    <Link
                      href={contractHref(e.org, e.project, e.contract)}
                      className="font-mono text-[13px] hover:text-primary"
                    >
                      {e.contract}
                      {e.version ? (
                        <span className="text-muted-foreground">@{e.version}</span>
                      ) : null}
                    </Link>
                    <div className="text-[11px] text-muted-foreground/80">
                      {e.org} / {e.project}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-80 text-xs text-muted-foreground">
                    <span className="line-clamp-2">{e.detail}</span>
                    {e.verdict && (
                      <span className="mt-1 inline-block">
                        <ClassificationBadge classification={e.verdict} withDot={false} />
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <AuditDetailDialog entry={e} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
