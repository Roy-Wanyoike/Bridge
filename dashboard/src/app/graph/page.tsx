import Link from 'next/link';
import { Waypoints } from 'lucide-react';
import { CompatGraph, GraphLegend } from '@/components/compat-graph';
import { VerdictBadge } from '@/components/classification-badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { getRegistryClient } from '@/lib/registry-client';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Dependency graph',
  description:
    'Who consumes whom: layered dependency graph, most-consumed contracts and node census across the registry.',
};

type SP = Promise<{ org?: string }>;

export default async function GraphPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const org = sp.org ?? '';
  const client = getRegistryClient();
  // Graph, full contract list and org tabs are independent — one batched
  // round instead of a serial cascade.
  const [graph, contracts, orgs] = await Promise.all([
    client.getGraph(org || undefined),
    client.listAllContracts(),
    client.listOrgs(),
  ]);
  // Key by the fully-qualified storage key — duplicate bases across orgs
  // must not collide.
  const byBase = new Map(contracts.map((c) => [`${c.org}/${c.project}/${c.base}`, c]));

  const scoped = org ? contracts.filter((c) => c.org === org) : contracts;
  const consumerRows = scoped
    .filter((c) => c.consumers > 0)
    .sort((a, b) => b.consumers - a.consumers);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dependency graph</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Who consumes whom. Deterministic layered layout; click a node to open its contract page.
          </p>
        </div>
        <nav aria-label="Org scope" className="flex items-center gap-1 rounded-lg border border-border bg-secondary/50 p-1">
          {[{ key: '', label: 'All orgs' }, ...orgs.map((o) => ({ key: o.org, label: o.org }))].map(
            (tab) => (
              <Link
                key={tab.key}
                href={tab.key ? `/graph?org=${encodeURIComponent(tab.key)}` : '/graph'}
                aria-current={org === tab.key ? 'page' : undefined}
                className={cn(
                  'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                  org === tab.key
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {tab.label}
              </Link>
            ),
          )}
        </nav>
      </header>

      <Card className="p-4">
        <CompatGraph data={graph} />
        <div className="mt-4 border-t border-border pt-4">
          <GraphLegend />
        </div>
      </Card>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Waypoints className="h-4 w-4 text-primary" aria-hidden="true" />
              Most consumed contracts
            </CardTitle>
            <CardDescription>Direct dependents per contract in this scope.</CardDescription>
          </CardHeader>
          <CardContent>
            {consumerRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">No dependency edges in this scope.</p>
            ) : (
              <Table>
                <caption className="sr-only">
                  Contracts ranked by number of direct dependents in this scope
                </caption>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Contract</TableHead>
                    <TableHead>Latest</TableHead>
                    <TableHead className="text-center">Consumers</TableHead>
                    <TableHead>Latest verdict</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {consumerRows.map((c) => (
                    <TableRow key={`${c.org}/${c.project}/${c.base}`}>
                      <TableCell>
                        <Link
                          href={`/contracts/${encodeURIComponent(c.org)}/${encodeURIComponent(c.project)}/${encodeURIComponent(c.base)}`}
                          className="font-mono text-[13px] hover:text-primary"
                        >
                          {c.base}
                        </Link>
                        <div className="text-[11px] text-muted-foreground/80">
                          {c.org} / {c.project}
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-[13px]">{c.latestVersion}</TableCell>
                      <TableCell className="text-center tabular-nums">{c.consumers}</TableCell>
                      <TableCell>
                        <VerdictBadge verdict={c.latestVerdict} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Node census</CardTitle>
            <CardDescription>Every contract appearing in the graph above.</CardDescription>
          </CardHeader>
          <CardContent className="max-h-96 overflow-y-auto">
            <Table>
              <caption className="sr-only">
                Every contract appearing in the dependency graph, with consumer count and verdict
              </caption>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Contract</TableHead>
                  <TableHead>Org / Project</TableHead>
                  <TableHead className="text-center">Consumers</TableHead>
                  <TableHead>Verdict</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {graph.nodes.map((n) => (
                  <TableRow key={n.id}>
                    <TableCell>
                      <Link
                        href={`/contracts/${encodeURIComponent(n.org)}/${encodeURIComponent(n.project)}/${encodeURIComponent(n.base)}`}
                        className="font-mono text-[13px] hover:text-primary"
                      >
                        {n.base}
                      </Link>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {n.org} / {n.project}
                    </TableCell>
                    <TableCell className="text-center tabular-nums">{n.consumers}</TableCell>
                    <TableCell>
                      <VerdictBadge verdict={byBase.get(`${n.org}/${n.project}/${n.base}`)?.latestVerdict} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
