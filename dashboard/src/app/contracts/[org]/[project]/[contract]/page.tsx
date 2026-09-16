import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ChevronRight,
  CircleDot,
  Download,
  ExternalLink,
  Fingerprint,
  Layers3,
  RadioTower,
  Users,
} from 'lucide-react';
import { ClassificationBadge, VerdictBadge } from '@/components/classification-badge';
import { CodeSnippet } from '@/components/code-snippet';
import { CopyButton } from '@/components/copy-button';
import { EmptyState } from '@/components/empty-state';
import { LanguageBadges } from '@/components/language-badges';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatDateTime, LANGUAGE_LABELS } from '@/lib/format';
import { getRegistryClient } from '@/lib/registry-client';
import type { Classification, VersionMeta } from '@/lib/types';

export const dynamic = 'force-dynamic';

type Params = Promise<{ org: string; project: string; contract: string }>;

export async function generateMetadata({ params }: { params: Params }) {
  const { org, project, contract } = await params;
  return {
    title: `${contract} (${org}/${project})`,
    description: `Versions, consumers, producers and schema of the ${contract} contract in ${org}/${project}.`,
  };
}

export default async function ContractDetailPage({ params }: { params: Params }) {
  const { org, project, contract } = await params;
  const client = getRegistryClient();

  const summary = await client.getContract(org, project, contract);
  if (!summary) notFound();

  // API order is not guaranteed: index everything by publication time so
  // "latest" and adjacent-diff windows are chronological.
  const versions = (await client.listVersions(org, project, contract)).sort((a, b) =>
    a.publishedAt.localeCompare(b.publishedAt),
  );
  const latest = versions[versions.length - 1];

  // Latest detail, consumers of the latest version, and every adjacent-pair
  // diff verdict are independent — one batched round instead of N−1 serial
  // registry round-trips (19 awaited sequentially for 20 versions before).
  const [latestDetail, consumers, verdictByVersion] = await Promise.all([
    latest ? client.getVersion(org, project, contract, latest.version) : Promise.resolve(null),
    latest ? client.listConsumers(org, project, contract, latest.version) : Promise.resolve([]),
    (async () => {
      const pairs = versions.slice(1).map((v, i) => ({ from: versions[i].version, to: v.version }));
      const reports = await Promise.all(
        pairs.map((p) => client.getDiff(org, project, contract, p.from, p.to)),
      );
      const map = new Map<string, { from: string; verdict: Classification }>();
      pairs.forEach((p, i) => {
        const report = reports[i];
        if (report) map.set(p.to, { from: p.from, verdict: report.verdict });
      });
      return map;
    })(),
  ]);

  const publishers = publisherRollup(versions);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-sm text-muted-foreground">
        <Link href="/contracts" className="hover:text-foreground">
          Contracts
        </Link>
        <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        <Link href={`/contracts?org=${encodeURIComponent(org)}`} className="hover:text-foreground">
          {org}
        </Link>
        <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        <Link
          href={`/contracts?org=${encodeURIComponent(org)}&project=${encodeURIComponent(project)}`}
          className="hover:text-foreground"
        >
          {project}
        </Link>
        <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="font-mono text-foreground">{contract}</span>
      </nav>

      {/* Header */}
      <header className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-mono text-2xl font-semibold tracking-tight">{contract}</h1>
          <Badge variant="secondary" className="font-mono">
            {summary.latestVersion}
          </Badge>
          <VerdictBadge verdict={summary.latestVerdict} />
        </div>
        {summary.description && (
          <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
            {summary.description}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-muted-foreground">
          <span>
            Owner <span className="text-foreground">{summary.owner}</span>
          </span>
          {summary.repository && (
            <span className="inline-flex items-center gap-1.5">
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="font-mono text-[13px]">{summary.repository}</span>
            </span>
          )}
          <span className="inline-flex items-center gap-1.5">
            <Fingerprint className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="font-mono text-[13px] text-zinc-400">{summary.latestShortHash}</span>
            <CopyButton value={summary.latestHash} label="Copy hash" className="h-6 px-1.5" />
          </span>
          <span className="inline-flex items-center gap-2">
            Generated for <LanguageBadges languages={summary.languages} />
          </span>
        </div>
      </header>

      {/* Pull / generate snippet */}
      <Card className="p-5">
        <div className="mb-3 flex items-center gap-2">
          <Download className="h-4 w-4 text-primary" aria-hidden="true" />
          <CardTitle>Pull and generate</CardTitle>
        </div>
        <div className="flex flex-col gap-2">
          <CodeSnippet
            command={`bridge pull ${org}/${project}/${contract}@${summary.latestVersion}`}
            label="Pull command"
          />
          <CodeSnippet
            command={`bridge generate ${org}/${project}/${contract}@${summary.latestVersion} --lang typescript`}
            label="Generate command"
          />
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          The version is content-addressed by the SHA-256 of its canonical IR; republishing
          different content under {contract}@{summary.latestVersion} is rejected.
        </p>
      </Card>

      {/* Tabs */}
      <Tabs defaultValue="versions">
        <TabsList aria-label="Contract sections">
          <TabsTrigger value="versions">Versions</TabsTrigger>
          <TabsTrigger value="consumers">Consumers</TabsTrigger>
          <TabsTrigger value="producers">Producers</TabsTrigger>
          <TabsTrigger value="schema">Schema</TabsTrigger>
        </TabsList>

        {/* Versions timeline */}
        <TabsContent value="versions">
          {versions.length === 0 ? (
            <EmptyState
              icon={CircleDot}
              title="No versions published"
              description="This contract is registered but has no published versions yet. Publish one with `bridge publish` to start the timeline."
            />
          ) : (
            <ol className="relative flex flex-col gap-6 border-l border-border pl-6">
            {[...versions].reverse().map((v, idx) => {
              const vd = verdictByVersion.get(v.version);
              return (
                <li key={v.version} className="relative">
                  <CircleDot
                    className="absolute -left-[31px] top-1 h-3.5 w-3.5 text-primary"
                    aria-hidden="true"
                  />
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <Badge variant="secondary" className="font-mono text-[13px]">
                      {v.version}
                    </Badge>
                    {idx === 0 && (
                      <Badge variant="default" className="text-[10px] uppercase tracking-wider">
                        latest
                      </Badge>
                    )}
                    {vd && (
                      <Link
                        href={`/contracts/${encodeURIComponent(org)}/${encodeURIComponent(project)}/${encodeURIComponent(contract)}/diff?from=${encodeURIComponent(vd.from)}&to=${encodeURIComponent(v.version)}`}
                        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                      >
                        diff {vd.from} → {v.version}
                        <ClassificationBadge classification={vd.verdict} withDot={false} />
                      </Link>
                    )}
                  </div>
                  <div className="mt-2 grid gap-x-8 gap-y-1 text-sm text-muted-foreground sm:grid-cols-2">
                    <span>
                      Published by <span className="text-foreground">{v.publisher}</span>
                    </span>
                    <span>{formatDateTime(v.publishedAt)}</span>
                    <span className="inline-flex items-center gap-1 font-mono text-[12px] text-zinc-400">
                      sha256:{v.shortHash}
                      <CopyButton value={v.hash} label="Copy hash" className="h-6 px-1.5" />
                    </span>
                    <span className="inline-flex items-center gap-2">
                      languages <LanguageBadges languages={v.languages} />
                    </span>
                    {v.imports.length > 0 && (
                      <span className="sm:col-span-2">
                        imports{' '}
                        {v.imports.map((imp) => (
                          <span
                            key={imp}
                            className="mr-1.5 inline-block rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-secondary-foreground"
                          >
                            {imp}
                          </span>
                        ))}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
          )}
        </TabsContent>

        {/* Consumers */}
        <TabsContent value="consumers">
          {consumers.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No consumers found"
              description="No published contract imports this one yet. Consumer discovery walks the registry's dependents graph."
            />
          ) : (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Users className="h-4 w-4 text-primary" aria-hidden="true" />
                  Dependent contracts
                </CardTitle>
                <CardDescription>
                  Discovered by walking imports transitively from {contract}@{summary.latestVersion}.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <caption className="sr-only">
                    Contracts that depend on {contract}, with dependency depth and severity
                  </caption>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Consumer</TableHead>
                      <TableHead>Owner</TableHead>
                      <TableHead>Depth</TableHead>
                      <TableHead>Latest reach</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {consumers.map((c) => (
                      <TableRow key={c.packageName}>
                        <TableCell>
                          <Link
                            href={`/contracts/${encodeURIComponent(c.org)}/${encodeURIComponent(c.project)}/${encodeURIComponent(c.base)}`}
                            className="font-mono text-[13px] hover:text-primary"
                          >
                            {c.packageName}
                          </Link>
                          <div className="text-[11px] text-muted-foreground/80">
                            {c.org} / {c.project}
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground">{c.owner ?? '-'}</TableCell>
                        <TableCell>
                          <Badge variant={c.depth === 1 ? 'secondary' : 'outline'} className="font-mono">
                            {c.depth === 1 ? 'direct' : `depth ${c.depth}`}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {c.severity ? <ClassificationBadge classification={c.severity} /> : '-'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Producers */}
        <TabsContent value="producers">
          <div className="grid gap-6 xl:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <RadioTower className="h-4 w-4 text-primary" aria-hidden="true" />
                  Declared interface
                </CardTitle>
                <CardDescription>
                  Services and events this contract exposes — the producing side of the wire.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <ProducerChips label="Services" items={latestDetail?.schema.services ?? []} />
                <ProducerChips label="Events" items={latestDetail?.schema.events ?? []} />
                <ProducerChips label="Enums" items={latestDetail?.schema.enums ?? []} />
                <ProducerChips label="Types" items={latestDetail?.schema.types ?? []} />
                <ProducerChips label="Aliases" items={latestDetail?.schema.aliases ?? []} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Layers3 className="h-4 w-4 text-primary" aria-hidden="true" />
                  Publishers
                </CardTitle>
                <CardDescription>Actors that published versions of this contract.</CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <caption className="sr-only">
                    Actors that published versions of {contract}
                  </caption>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Actor</TableHead>
                      <TableHead className="text-center">Versions</TableHead>
                      <TableHead className="text-right">Last publish</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {publishers.map((p) => (
                      <TableRow key={p.actor}>
                        <TableCell className="text-foreground">{p.actor}</TableCell>
                        <TableCell className="text-center font-mono text-[13px]">
                          {p.versions.join(', ')}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right text-xs text-muted-foreground">
                          {formatDateTime(p.lastAt)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Schema */}
        <TabsContent value="schema">
          <Card>
            <CardHeader>
              <CardTitle>
                Schema of {contract}@{summary.latestVersion}
              </CardTitle>
              <CardDescription>
                Declared names, compiled to the canonical IR and addressed as{' '}
                <span className="font-mono">{summary.latestShortHash}</span>.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <ProducerChips label="Services" items={latestDetail?.schema.services ?? []} mono />
              <ProducerChips label="Events" items={latestDetail?.schema.events ?? []} mono />
              <ProducerChips label="Enums" items={latestDetail?.schema.enums ?? []} mono />
              <ProducerChips label="Types" items={latestDetail?.schema.types ?? []} mono />
              <ProducerChips label="Aliases" items={latestDetail?.schema.aliases ?? []} mono />
              {latestDetail && (
                <p className="text-xs text-muted-foreground">
                  Generated bindings:{' '}
                  {latestDetail.languages.map((l) => LANGUAGE_LABELS[l] ?? l).join(', ')}
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ProducerChips({
  label,
  items,
  mono = true,
}: {
  label: string;
  items: string[];
  mono?: boolean;
}) {
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      {items.length === 0 ? (
        <div className="text-sm text-muted-foreground/80">none</div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {items.map((item) => (
            <Badge
              key={item}
              variant="secondary"
              className={mono ? 'font-mono text-[12px]' : undefined}
            >
              {item}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

function publisherRollup(versions: VersionMeta[]) {
  const map = new Map<string, { actor: string; versions: string[]; lastAt: string }>();
  for (const v of versions) {
    const entry = map.get(v.publisher) ?? { actor: v.publisher, versions: [], lastAt: v.publishedAt };
    entry.versions.push(v.version);
    if (v.publishedAt > entry.lastAt) entry.lastAt = v.publishedAt;
    map.set(v.publisher, entry);
  }
  return [...map.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}
