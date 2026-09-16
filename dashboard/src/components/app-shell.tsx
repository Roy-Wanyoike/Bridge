'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  Activity,
  Boxes,
  GitBranch,
  LayoutDashboard,
  ScrollText,
  Waypoints,
} from 'lucide-react';
import type { OrgInfo } from '@/lib/types';
import { cn } from '@/lib/utils';

const NAV = [
  { href: '/', label: 'Overview', icon: LayoutDashboard },
  { href: '/contracts', label: 'Contracts', icon: Boxes },
  { href: '/graph', label: 'Dependency graph', icon: Waypoints },
  { href: '/audit', label: 'Audit log', icon: ScrollText },
] as const;

function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cn('h-7 w-7', className)}
    >
      <path
        d="M3 17 12 4l9 13"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3 17h18"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        opacity="0.55"
      />
      <circle cx="12" cy="13" r="2.2" fill="currentColor" />
    </svg>
  );
}

function NavLink({ href, label, icon: Icon, active }: { href: string; label: string; icon: typeof Boxes; active: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active
          ? 'bg-secondary text-foreground'
          : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
      )}
    >
      <Icon className={cn('h-4 w-4', active ? 'text-primary' : '')} aria-hidden="true" />
      {label}
    </Link>
  );
}

/**
 * Scope picker derived from the URL (controlled): reflects the org/project
 * query on /contracts so it never goes stale after navigation.
 */
function ScopeSwitcher({ orgs }: { orgs: OrgInfo[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const org = searchParams.get('org') ?? '';
  const project = searchParams.get('project') ?? '';
  const onContracts = pathname === '/contracts' || pathname.startsWith('/contracts/');
  const scopedOrg = onContracts && org ? org : '';
  const value = scopedOrg && project ? `${scopedOrg}/${project}` : scopedOrg || 'all';

  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="sr-only">Scope: org and project</span>
      <GitBranch className="h-3.5 w-3.5" aria-hidden="true" />
      <select
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          if (v === 'all') router.push('/contracts');
          else {
            const [nextOrg, nextProject] = v.split('/');
            router.push(
              `/contracts?org=${encodeURIComponent(nextOrg)}&project=${encodeURIComponent(nextProject)}`,
            );
          }
        }}
        className="h-8 appearance-none rounded-md border border-input bg-card px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <option value="all">All orgs</option>
        {scopedOrg && !project && <option value={scopedOrg}>{scopedOrg} / all projects</option>}
        {orgs.map((o) => (
          <optgroup key={o.org} label={o.org}>
            {o.projects.map((p) => (
              <option key={p} value={`${o.org}/${p}`}>
                {o.org} / {p}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

export function AppShell({
  orgs,
  demoMode,
  children,
}: {
  orgs: OrgInfo[];
  demoMode: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  const isActive = (href: string) => {
    if (href === '/') return pathname === '/';
    return pathname.startsWith(href);
  };

  const onContracts = pathname === '/contracts' || pathname.startsWith('/contracts/');

  return (
    <div id="app-shell-root" className="min-h-screen bg-background">
      {/* Skip link: first tab stop, visible on focus */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:text-sm focus:text-foreground focus:shadow-lg"
      >
        Skip to content
      </a>
      {/* Sidebar */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r border-border bg-[#0c0c0f] lg:flex">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <BrandMark className="text-primary" />
          <div>
            <div className="text-sm font-semibold tracking-[0.18em]">BRIDGE</div>
            <div className="text-[11px] text-muted-foreground">Registry Console</div>
          </div>
        </div>
        <nav aria-label="Primary" className="flex flex-1 flex-col gap-1 px-3">
          {NAV.map((item) => (
            <NavLink key={item.href} {...item} active={isActive(item.href)} />
          ))}
        </nav>
        <div className="m-3 rounded-md border border-border bg-card p-3">
          <div className="flex items-center gap-2 text-xs font-medium">
            <Activity
              className={cn('h-3.5 w-3.5', demoMode ? 'text-[var(--warning)]' : 'text-primary')}
              aria-hidden="true"
            />
            {demoMode ? 'Demo mode' : 'Live registry'}
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
            {demoMode
              ? 'Serving a deterministic seed dataset. Set NEXT_PUBLIC_DEMO_MODE=false and NEXT_PUBLIC_REGISTRY_URL to connect.'
              : 'Connected to the registry service.'}
          </p>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-h-screen flex-col lg:pl-60">
        <header className="sticky top-0 z-30 border-b border-border bg-background/90 backdrop-blur">
          <div className="flex h-14 items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
            <div className="flex items-center gap-2 lg:hidden">
              <BrandMark className="h-6 w-6 text-primary" />
              <span className="text-sm font-semibold tracking-[0.18em]">BRIDGE</span>
              {/* Demo/live disclosure must survive below lg — the sidebar card
                  carrying it is hidden on mobile, so a compact chip lives in
                  the header row instead. */}
              <span
                className={cn(
                  'ml-1 rounded-md border px-1.5 py-0.5 font-mono text-[10px] tracking-wider',
                  demoMode
                    ? 'border-[var(--warning)]/50 text-[var(--warning)]'
                    : 'border-primary/50 text-primary',
                )}
              >
                {demoMode ? 'DEMO' : 'LIVE'}
              </span>
            </div>
            <div className="hidden items-center gap-2 text-xs text-muted-foreground lg:flex">
              <span className="rounded-md border border-border bg-secondary/60 px-2 py-1 font-mono">
                {demoMode ? 'DEMO' : 'LIVE'}
              </span>
              <span>registry state: content-addressed, immutable versions</span>
            </div>
            {onContracts && (
              <React.Suspense fallback={null}>
                <ScopeSwitcher orgs={orgs} />
              </React.Suspense>
            )}
          </div>
          {/* compact nav for narrow viewports */}
          <nav aria-label="Primary" className="flex gap-1 overflow-x-auto px-4 pb-2 lg:hidden">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive(item.href) ? 'page' : undefined}
                className={cn(
                  'whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium',
                  isActive(item.href)
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
                )}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </header>

        <main id="main-content" tabIndex={-1} className="flex-1 px-4 py-6 sm:px-6 lg:px-8 focus:outline-none">
          {children}
        </main>

        <footer className="mt-auto border-t border-border px-4 py-4 text-xs text-muted-foreground sm:px-6 lg:px-8">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>BRIDGE Registry Console</span>
            <span className="font-mono">one IDL, one canonical IR, many languages</span>
          </div>
        </footer>
      </div>
    </div>
  );
}
