import Link from 'next/link';
import {
  ArrowUpRight,
  Boxes,
  Database,
  FileWarning,
  GitCommitVertical,
  Layers,
  Network,
  ShieldCheck,
} from 'lucide-react';
import { ClassificationBadge } from '@/components/classification-badge';
import { EmptyState } from '@/components/empty-state';
import { LanguageBadges } from '@/components/language-badges';
import { StatCard } from '@/components/stat-card';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDate, formatDateTime } from '@/lib/format';
import { auditHref, contractDiffHref, contractHref } from '@/lib/hrefs';
import { getRegistryClient } from '@/lib/registry-client';
import type { Classification } from '@/lib/types';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Overview',
  description:
    'Registry-wide state: contracts, versions, compatibility verdicts, recent publishes and breaking-change attention list.',
};

const VERDICT_LABEL: Record<Classification, string> = {
  SAFE: 'Compatible',
  WARNING: 'Review advised',
  BREAKING: 'Action required',
  UNKNOWN: 'Undecidable',
};

const VERDICT_CARD: Record<Classification, string> = {
  SAFE: 'border-[var(--safe)]/30 bg-[var(--safe-soft)]',
  WARNING: 'border-[var(--warning)]/30 bg-[var(--warning-soft)]',
  BREAKING: 'border-[var(--breaking)]/30 bg-[var(--breaking-soft)]',
  UNKNOWN: 'border-[var(--unknown)]/30 bg-[var(--unknown-soft)]',
};

export default async function OverviewPage() {
  const client = getRegistryClient();
  const data = await client.getOverview();

  const counts: Record<Classification, number> = { SAFE: 0, WARNING: 0, BREAKING: 0, UNKNOWN: 0 };
  for (const v of data.latestVerdicts) counts[v.verdict] += 1;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Registry-wide state across every org and project.
          </p>
        </div>
        <Link href="/contracts" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>
          Browse contracts
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      </header>

      {/* Totals */}
      <section aria-label="Registry totals" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={Boxes} value={data.contracts} label="Contracts" href="/contracts" />
        <StatCard icon={Layers} value={data.versions} label="Versions" footnote="immutable, content-addressed" />
        <StatCard
          icon={Network}
          value={data.consumerLinks}
          label="Consumer links"
          href="/graph"
          footnote="dependency edges between contracts"
        />
        <StatCard
          icon={Database}
          value={`${data.orgs} / ${data.projects}`}
          label="Orgs / Projects"
          footnote="across the registry"
        />
      </section>

      {/* Health-style status cards */}
      <section aria-label="Compatibility health" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {(['SAFE', 'WARNING', 'BREAKING', 'UNKNOWN'] as Classification[]).map((verdict) => (
          <Card key={verdict} className={cn('p-5', VERDICT_CARD[verdict])}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {VERDICT_LABEL[verdict]}
                </div>
                <div className="mt-2 text-3xl font-semibold tabular-nums tracking-tight">
                  {counts[verdict]}
                </div>
              </div>
              <ClassificationBadge classification={verdict} withDot={false} />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {verdict === 'SAFE' && 'latest adjacent diff proved harmless for all consumers'}
              {verdict === 'WARNING' && 'visible change; well-behaved consumers tolerate it'}
              {verdict === 'BREAKING' && 'at least one class of consumers will break'}
              {verdict === 'UNKNOWN' && 'engine could not decide; fails the strict gate'}
            </p>
          </Card>
        ))}
      </section>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-5">
        {/* Recent publishes */}
        <Card className="xl:col-span-3">
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div className="space-y-1.5">
              <CardTitle className="flex items-center gap-2">
                <GitCommitVertical className="h-4 w-4 text-primary" aria-hidden="true" />
                Recent publishes
              </CardTitle>
              <CardDescription>
                {data.lastPublishAt
                  ? `last publish ${formatDateTime(data.lastPublishAt)}`
                  : 'no publishes recorded'}
              </CardDescription>
            </div>
            <Link href={auditHref('publish')} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
              View audit
            </Link>
          </CardHeader>
          <CardContent>
            {data.recentPublishes.length === 0 ? (
              <EmptyState
                icon={GitCommitVertical}
                title="No publishes recorded"
                description="Publish a contract with `bridge publish` and it will appear here. The audit log keeps every attempt."
                className="border-none bg-transparent px-2 py-10"
              />
            ) : (
            <Table>
              <caption className="sr-only">
                Most recently published contract versions, with publisher and languages
              </caption>
              <TableHeader>
                <TableRow>
                  <TableHead>Contract</TableHead>
                  <TableHead>Version</TableHead>
                  {/* Responsive column priority (issue #153): the card gets
                      ~3/5 of the content column at xl, and Contract + Version
                      + Languages + Published already need that width. The
                      publisher rides along only from 2xl up — the audit log
                      remains the precision record for who published what. */}
                  <TableHead className="hidden 2xl:table-cell">Publisher</TableHead>
                  <TableHead>Languages</TableHead>
                  <TableHead className="text-right">Published</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.recentPublishes.map((p) => (
                  <TableRow key={`${p.org}/${p.project}/${p.base}/${p.version}`}>
                    <TableCell>
                      <Link
                        href={contractHref(p.org, p.project, p.base)}
                        className="font-mono text-[13px] text-foreground hover:text-primary"
                      >
                        {p.base}
                      </Link>
                      <div className="text-xs text-muted-foreground">
                        {p.org} / {p.project}
                      </div>
                    </TableCell>
                    <TableCell>
                      {p.version ? (
                        <Badge variant="secondary" className="font-mono">
                          {p.version}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground 2xl:table-cell">{p.publisher}</TableCell>
                    <TableCell>
                      <LanguageBadges languages={p.languages} />
                    </TableCell>
                    <TableCell
                      className="whitespace-nowrap text-right text-xs text-muted-foreground"
                      title={p.publishedAt ? formatDateTime(p.publishedAt) : undefined}
                    >
                      {/* Compact date: this table ranks recency; the full
                          timestamp stays in the tooltip and the audit log
                          (issue #153). */}
                      {formatDate(p.publishedAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            )}
          </CardContent>
        </Card>

        {/* Attention list */}
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileWarning className="h-4 w-4 text-[var(--warning)]" aria-hidden="true" />
              Needs attention
            </CardTitle>
            <CardDescription>
              Latest adjacent-version diffs classified WARNING or worse.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {data.recentBreaking.length === 0 && (
              <div className="flex items-center gap-2 rounded-md border border-border bg-secondary/40 p-3 text-sm text-muted-foreground">
                <ShieldCheck className="h-4 w-4 text-primary" aria-hidden="true" />
                All recorded diffs are classified SAFE.
              </div>
            )}
            {data.recentBreaking.map((r) => (
              <Link
                key={`${r.contract}-${r.from}-${r.to}`}
                href={contractDiffHref(r.org, r.project, r.contract, r.from, r.to)}
                className="group rounded-md border border-border bg-secondary/30 p-3 transition-colors hover:border-primary/40 hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[13px]">
                    {r.contract} <span className="text-muted-foreground">{r.from} → {r.to}</span>
                  </span>
                  <ClassificationBadge classification={r.verdict} />
                </div>
                <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                  {r.changes[0]?.message ?? 'No recorded changes.'}
                </p>
                <div className="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground">
                  <span>
                    {r.summary.breaking > 0 && (
                      <span className="text-[var(--breaking)]">{r.summary.breaking} breaking</span>
                    )}
                    {r.summary.breaking > 0 && r.summary.unknown > 0 && ' · '}
                    {r.summary.unknown > 0 && (
                      <span className="text-[var(--unknown)]">{r.summary.unknown} unknown</span>
                    )}
                    {r.summary.breaking === 0 && r.summary.unknown === 0 && r.summary.warning > 0 && (
                      <span className="text-[var(--warning)]">{r.summary.warning} warnings</span>
                    )}
                  </span>
                  <span>
                    {r.impact
                      ? `${r.impact.affected}/${r.impact.dependents} consumers affected`
                      : 'consumer impact unavailable'}
                  </span>
                </div>
              </Link>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
