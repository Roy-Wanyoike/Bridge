import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronRight, ListTree, ShieldCheck, ShieldX, Users } from 'lucide-react';
import { ClassificationBadge } from '@/components/classification-badge';
import { DiffVersionPicker } from '@/components/diff-version-picker';
import { EmptyState } from '@/components/empty-state';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatDateTime, kindLabel, suggestedAction } from '@/lib/format';
import { getRegistryClient } from '@/lib/registry-client';
import type { Change, Classification } from '@/lib/types';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

type Params = Promise<{ org: string; project: string; contract: string }>;
type SP = Promise<{ from?: string; to?: string }>;

export async function generateMetadata({ params }: { params: Params }) {
  const { org, project, contract } = await params;
  return {
    title: `Compatibility: ${contract} (${org}/${project})`,
    description: `Classified compatibility report between versions of ${contract} in ${org}/${project}, with consumer impact.`,
  };
}

const VERDICT_BANNER: Record<Classification, { border: string; bg: string; text: string }> = {
  SAFE: { border: 'border-[var(--safe)]/40', bg: 'bg-[var(--safe-soft)]', text: 'text-[var(--safe)]' },
  WARNING: { border: 'border-[var(--warning)]/40', bg: 'bg-[var(--warning-soft)]', text: 'text-[var(--warning)]' },
  BREAKING: { border: 'border-[var(--breaking)]/40', bg: 'bg-[var(--breaking-soft)]', text: 'text-[var(--breaking)]' },
  UNKNOWN: { border: 'border-[var(--unknown)]/40', bg: 'bg-[var(--unknown-soft)]', text: 'text-[var(--unknown)]' },
};

const VERDICT_COPY: Record<Classification, { title: string; gate: string; detail: string }> = {
  SAFE: {
    title: 'Compatible',
    gate: 'strict gate: PASSED',
    detail: 'Every detected change is provably harmless to all consumers.',
  },
  WARNING: {
    title: 'Review advised',
    gate: 'strict gate: PASSED',
    detail: 'Visible changes that well-behaved consumers tolerate; strict readers or exhaustive switches may not.',
  },
  BREAKING: {
    title: 'Breaking change',
    gate: 'strict gate: FAILED',
    detail: 'This diff guarantees at least one class of consumers breaks. Migrate consumers before shipping.',
  },
  UNKNOWN: {
    title: 'Undecidable',
    gate: 'strict gate: FAILED',
    detail: 'The engine could not decide confidently and never downgrades silently. Review manually.',
  },
};

export default async function DiffPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SP;
}) {
  const { org, project, contract } = await params;
  const sp = await searchParams;
  const client = getRegistryClient();

  const summary = await client.getContract(org, project, contract);
  if (!summary) notFound();

  // API order is not guaranteed: sort by publication time so "latest" and
  // the adjacent-version diff window are chronological.
  const versions = (await client.listVersions(org, project, contract)).sort((a, b) =>
    a.publishedAt.localeCompare(b.publishedAt),
  );
  if (versions.length === 0) notFound();

  // Explicit but unknown from/to in a shared deep link must 404 — silently
  // rendering a different diff than the link promised erodes trust.
  if (sp.from !== undefined && !versions.some((v) => v.version === sp.from)) notFound();
  if (sp.to !== undefined && !versions.some((v) => v.version === sp.to)) notFound();

  const from =
    sp.from ?? versions[versions.length - 2]?.version ?? versions[0].version;
  const to = sp.to ?? versions[versions.length - 1].version;

  const report = await client.getDiff(org, project, contract, from, to);
  if (!report) notFound();
  const toVersion = versions.find((v) => v.version === to) ?? versions[versions.length - 1];
  const banner = VERDICT_BANNER[report.verdict];
  const copy = VERDICT_COPY[report.verdict];

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-sm text-muted-foreground">
        <Link href="/contracts" className="hover:text-foreground">
          Contracts
        </Link>
        <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        <Link href={`/contracts/${encodeURIComponent(org)}/${encodeURIComponent(project)}/${encodeURIComponent(contract)}`} className="font-mono hover:text-foreground">
          {contract}
        </Link>
        <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        <span>compatibility</span>
      </nav>

      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Compatibility report</h1>
          <p className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
            <span className="font-mono text-foreground">{contract}</span>
            <span className="font-mono">{from}</span>
            <span aria-hidden="true">→</span>
            <span className="font-mono text-foreground">{to}</span>
            <span aria-hidden="true">·</span>
            <span>{formatDateTime(toVersion.publishedAt)}</span>
          </p>
        </div>
        <DiffVersionPicker basePath={`/contracts/${org}/${project}/${contract}`} versions={versions} from={from} to={to} />
      </header>

      {/* Verdict banner */}
      <section
        aria-label="Verdict"
        className={cn('flex flex-wrap items-center justify-between gap-4 rounded-lg border p-5', banner.border, banner.bg)}
      >
        <div className="flex items-center gap-4">
          {report.verdict === 'SAFE' ? (
            <ShieldCheck className="h-8 w-8 text-[var(--safe)]" aria-hidden="true" />
          ) : (
            <ShieldX className={cn('h-8 w-8', banner.text)} aria-hidden="true" />
          )}
          <div>
            <div className={cn('text-lg font-semibold', banner.text)}>{copy.title}</div>
            <div className="mt-0.5 text-sm text-muted-foreground">{copy.detail}</div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Badge variant="outline" className="font-mono">
            {copy.gate}
          </Badge>
          <ClassificationBadge classification={report.verdict} />
        </div>
      </section>

      {/* Summary + impact */}
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card className="p-5">
          <CardDescription>Verdict</CardDescription>
          <CardTitle className="mt-2 flex items-center gap-2">
            <ClassificationBadge classification={report.verdict} />
            <span className="text-sm font-normal text-muted-foreground">
              {report.summary.safe + report.summary.warning + report.summary.breaking + report.summary.unknown} changes
            </span>
          </CardTitle>
        </Card>
        <Card className="p-5">
          <CardDescription>Consumers discovered</CardDescription>
          <CardTitle className="mt-2 text-3xl tabular-nums">{report.impact.dependents}</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">transitive dependents in the registry</p>
        </Card>
        <Card className="p-5">
          <CardDescription>Consumers affected</CardDescription>
          <CardTitle className="mt-2 text-3xl tabular-nums text-[var(--warning)]">
            {report.impact.affected}
          </CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">reached by a non-SAFE change</p>
        </Card>
        <Card className="p-5">
          <CardDescription>Consumers breaking</CardDescription>
          <CardTitle className="mt-2 text-3xl tabular-nums text-[var(--breaking)]">
            {report.impact.breakingAffected}
          </CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">must migrate before this ships</p>
        </Card>
      </section>

      <div className="grid gap-6 xl:grid-cols-3">
        {/* Change list */}
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ListTree className="h-4 w-4 text-primary" aria-hidden="true" />
              Changes
            </CardTitle>
            <CardDescription>
              Canonical order: BREAKING first, then UNKNOWN, WARNING, SAFE.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {report.changes.length === 0 ? (
              <EmptyState
                icon={ShieldCheck}
                title="No differences detected"
                description={`The canonical IR of ${contract}@${from} and ${contract}@${to} is identical, or no changes were recorded for this pair.`}
              />
            ) : (
              <ol className="flex flex-col gap-3">
                {report.changes.map((change, idx) => (
                  <ChangeRow
                    key={`${idx}-${change.path}-${change.kind}`}
                    change={change}
                  />
                ))}
              </ol>
            )}
          </CardContent>
        </Card>

        {/* Consumer impact */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-4 w-4 text-primary" aria-hidden="true" />
              Consumer impact
            </CardTitle>
            <CardDescription>
              Reachability via type references over the dependents graph.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {report.impact.consumers.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No dependents discovered for this contract.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {report.impact.consumers.map((c) => (
                  <li
                    key={c.packageName}
                    className="rounded-md border border-border bg-secondary/30 p-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <Link
                        href={`/contracts/${encodeURIComponent(c.org ?? org)}/${encodeURIComponent(c.project ?? project)}/${encodeURIComponent(c.packageName.replace(/\.v\d+$/, ''))}`}
                        className="font-mono text-[13px] hover:text-primary"
                      >
                        {c.packageName}
                      </Link>
                      <ClassificationBadge classification={c.severity} />
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                      <Badge variant="outline" className="font-mono text-[10px]">
                        {c.depth === 1 ? 'direct' : `depth ${c.depth}`}
                      </Badge>
                      <span className="font-mono">{c.reason}</span>
                      {c.viaTypes.length > 0 && <span>via {c.viaTypes.join(', ')}</span>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

const STRIPE: Record<Classification, string> = {
  SAFE: 'border-l-[var(--safe)]',
  WARNING: 'border-l-[var(--warning)]',
  BREAKING: 'border-l-[var(--breaking)]',
  UNKNOWN: 'border-l-[var(--unknown)]',
};

function ChangeRow({ change }: { change: Change }) {
  return (
    <li
      className={cn(
        'rounded-md border border-l-4 border-border bg-secondary/30 p-4',
        STRIPE[change.classification],
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <ClassificationBadge classification={change.classification} />
        <span className="font-mono text-[13px] text-foreground">{change.path}</span>
        <Badge variant="outline" className="font-mono text-[10px]">
          {kindLabel(change.kind)}
        </Badge>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{change.message}</p>
      {(change.old || change.new) && (
        <p className="mt-2 flex flex-wrap items-center gap-2 font-mono text-[12px]">
          {change.old && <span className="rounded bg-[var(--breaking-soft)] px-1.5 py-0.5 text-[var(--breaking)] line-through">{change.old}</span>}
          {change.old && change.new && <span className="text-muted-foreground">→</span>}
          {change.new && <span className="rounded bg-[var(--safe-soft)] px-1.5 py-0.5 text-[var(--safe)]">{change.new}</span>}
        </p>
      )}
      <p className="mt-2 text-xs text-muted-foreground/80">
        <span className="font-medium text-muted-foreground">Suggested:</span>{' '}
        {suggestedAction(change.kind)}
      </p>
    </li>
  );
}
