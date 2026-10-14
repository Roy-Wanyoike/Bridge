import { DASHBOARD_URL } from '@/lib/dashboard-url';

export function Footer() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 sm:px-6 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo/bridge-lockup-dark.svg"
            alt="bridge"
            className="h-6 w-auto"
            width={126}
            height={24}
          />
          <p className="text-xs text-muted-foreground">
            MIT licensed · 831 + 94 tests green · v0.2.1
          </p>
        </div>

        <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <a
            href="https://github.com/Roy-Wanyoike/bridge"
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            GitHub
          </a>
          <a
            href="https://github.com/Roy-Wanyoike/bridge/issues"
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            Issues
          </a>
          <a
            href="https://github.com/Roy-Wanyoike/bridge/releases"
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            Releases
          </a>
          <a
            href={DASHBOARD_URL}
            className="font-medium text-safe transition-colors hover:opacity-90"
          >
            Open Console
          </a>
        </nav>
      </div>
    </footer>
  );
}
