import { Menu } from 'lucide-react';
import { DASHBOARD_URL } from '@/lib/dashboard-url';

const LINKS = [
  { href: '#demo', label: 'Demo' },
  { href: '#problem', label: 'Problem' },
  { href: '#moat', label: 'Why Bridge' },
  { href: '#languages', label: 'Languages' },
  { href: '#videos', label: 'Videos' },
  { href: '#docs', label: 'Docs' },
];

export function Nav() {
  return (
    <header className="sticky top-0 z-50 border-b border-border bg-background/85 backdrop-blur">
      <nav
        aria-label="Main"
        className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6"
      >
        <a href="#top" className="flex items-center gap-2 rounded-md" aria-label="Bridge — back to top">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo/bridge-lockup-dark.svg"
            alt="bridge — one contract, every language"
            className="h-7 w-auto"
            width={148}
            height={28}
          />
        </a>

        <ul className="hidden items-center gap-1 md:flex">
          {LINKS.map((l) => (
            <li key={l.href}>
              <a
                href={l.href}
                className="rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                {l.label}
              </a>
            </li>
          ))}
        </ul>

        <div className="flex items-center gap-2">
          <a
            href={DASHBOARD_URL}
            className="hidden rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90 sm:inline-flex"
          >
            Open Console
          </a>
          <details className="relative md:hidden">
            <summary
              className="flex h-9 w-9 cursor-pointer list-none items-center justify-center rounded-md border border-border text-muted-foreground [&::-webkit-details-marker]:hidden"
              aria-label="Open menu"
            >
              <Menu className="h-4.5 w-4.5" aria-hidden />
            </summary>
            <div className="absolute right-0 top-11 w-52 rounded-xl border border-border bg-card p-1.5 shadow-xl">
              {LINKS.map((l) => (
                <a
                  key={l.href}
                  href={l.href}
                  className="block rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-secondary hover:text-foreground"
                >
                  {l.label}
                </a>
              ))}
              <a
                href={DASHBOARD_URL}
                className="mt-1 block rounded-lg bg-primary px-3 py-2 text-center text-sm font-medium text-primary-foreground"
              >
                Open Console
              </a>
            </div>
          </details>
        </div>
      </nav>
    </header>
  );
}
