import Link from 'next/link';
import { ArrowDownWideNarrow, Boxes, Search } from 'lucide-react';
import { VerdictBadge } from '@/components/classification-badge';
import { EmptyState } from '@/components/empty-state';
import { LanguageBadges } from '@/components/language-badges';
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
import { formatDate } from '@/lib/format';
import { getRegistryClient } from '@/lib/registry-client';
import type { ContractSummary } from '@/lib/types';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Contracts',
  description: 'Browse every published contract at its latest version: owners, verdicts, consumers and generated languages.',
};

const SORTS: Record<string, string> = {
  name: 'Name (A-Z)',
  '-name': 'Name (Z-A)',
  versions: 'Most versions',
  consumers: 'Most consumers',
  updated: 'Recently updated',
};

type SearchParams = Promise<{
  q?: string;
  org?: string;
  project?: string;
  owner?: string;
  sort?: string;
}>;

export default async function ContractsPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const q = sp.q?.trim().toLowerCase() ?? '';
  const org = sp.org ?? '';
  const project = sp.project ?? '';
  const owner = sp.owner ?? '';
  const sort = sp.sort && SORTS[sp.sort] ? sp.sort : 'name';

  const client = getRegistryClient();
  const allContracts = await client.listAllContracts();
  let contracts = allContracts;
  if (org) contracts = contracts.filter((c) => c.org === org);
  if (project) contracts = contracts.filter((c) => c.project === project);
  if (owner) contracts = contracts.filter((c) => c.owner === owner);
  if (q) {
    contracts = contracts.filter(
      (c) =>
        c.base.toLowerCase().includes(q) ||
        c.packageName.toLowerCase().includes(q) ||
        c.owner.toLowerCase().includes(q) ||
        (c.description ?? '').toLowerCase().includes(q),
    );
  }
  contracts = sortContracts(contracts, sort);

  const orgs = await client.listOrgs();
  // Project options follow the selected org — listing every org's projects
  // lets org+project mismatches silently yield empty results.
  const projects = [
    ...new Set(allContracts.filter((c) => !org || c.org === org).map((c) => c.project)),
  ].sort();
  const owners = [...new Set(allContracts.map((c) => c.owner))].sort();

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Contracts</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {contracts.length} contract{contracts.length === 1 ? '' : 's'} at their latest version.
          </p>
        </div>
      </header>

      {/* Filter bar */}
      <Card className="p-4">
        <form method="GET" action="/contracts" className="grid gap-3 md:grid-cols-[1fr_auto]">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="relative block">
              <span className="sr-only">Search contracts</span>
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                name="q"
                defaultValue={sp.q ?? ''}
                placeholder="Search name, owner, description"
                className="pl-8"
              />
            </label>
            <label>
              <span className="sr-only">Org</span>
              <Select name="org" defaultValue={org} aria-label="Filter by org">
                <option value="">All orgs</option>
                {orgs.map((o) => (
                  <option key={o.org} value={o.org}>
                    {o.org}
                  </option>
                ))}
              </Select>
            </label>
            <label>
              <span className="sr-only">Project</span>
              <Select name="project" defaultValue={project} aria-label="Filter by project">
                <option value="">All projects</option>
                {projects.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </Select>
            </label>
            <label>
              <span className="sr-only">Owner</span>
              <Select name="owner" defaultValue={owner} aria-label="Filter by owner">
                <option value="">All owners</option>
                {owners.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </Select>
            </label>
          </div>
          <div className="flex items-center gap-2 md:justify-end">
            <label className="flex items-center gap-2">
              <span className="sr-only">Sort</span>
              <ArrowDownWideNarrow className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <Select name="sort" defaultValue={sort} aria-label="Sort contracts" className="w-40">
                {Object.entries(SORTS).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </Select>
            </label>
            <button type="submit" className={cn(buttonVariants({ size: 'sm' }), 'h-9')}>
              Apply
            </button>
            <Link href="/contracts" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
              Reset
            </Link>
          </div>
        </form>
      </Card>

      {contracts.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title="No contracts match"
          description="Adjust the search or filters to see more of the registry."
        />
      ) : (
        <Card className="overflow-hidden">
          <Table>
            <caption className="sr-only">
              Contracts at their latest version with owner, verdict, consumer count and languages
            </caption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Contract</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Latest</TableHead>
                <TableHead className="text-center">Versions</TableHead>
                <TableHead className="text-center">Consumers</TableHead>
                <TableHead>Languages</TableHead>
                <TableHead className="text-right">Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {contracts.map((c) => (
                <TableRow key={`${c.org}/${c.project}/${c.base}`}>
                  <TableCell className="max-w-72">
                    <Link
                      href={`/contracts/${c.org}/${c.project}/${c.base}`}
                      className="font-mono text-[13px] font-medium text-foreground hover:text-primary"
                    >
                      {c.base}
                    </Link>
                    <div className="truncate text-xs text-muted-foreground" title={c.description}>
                      {c.description}
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground/80">
                      {c.org} / {c.project}
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{c.owner}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className="font-mono">
                        {c.latestVersion}
                      </Badge>
                      <VerdictBadge verdict={c.latestVerdict} />
                    </div>
                    <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                      {c.latestShortHash}
                    </div>
                  </TableCell>
                  <TableCell className="text-center tabular-nums">{c.versionCount}</TableCell>
                  <TableCell className="text-center tabular-nums">
                    {c.consumers > 0 ? c.consumers : <span className="text-muted-foreground">-</span>}
                  </TableCell>
                  <TableCell>
                    <LanguageBadges languages={c.languages} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right text-xs text-muted-foreground">
                    {formatDate(c.updatedAt)}
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

function sortContracts(contracts: ContractSummary[], sort: string): ContractSummary[] {
  const cmpName = (a: ContractSummary, b: ContractSummary) => (a.base < b.base ? -1 : 1);
  switch (sort) {
    case '-name':
      return [...contracts].sort((a, b) => -cmpName(a, b));
    case 'versions':
      return [...contracts].sort((a, b) => b.versionCount - a.versionCount || cmpName(a, b));
    case 'consumers':
      return [...contracts].sort((a, b) => b.consumers - a.consumers || cmpName(a, b));
    case 'updated':
      return [...contracts].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    default:
      return [...contracts].sort(cmpName);
  }
}
