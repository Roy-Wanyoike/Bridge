import { ArrowRight } from 'lucide-react';
import { DASHBOARD_URL } from '@/lib/dashboard-url';

function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

export function Hero() {
  return (
    <section id="top" className="relative overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-[radial-gradient(ellipse_at_top,rgba(52,211,153,0.09),transparent_65%)]"
      />
      <div className="mx-auto max-w-6xl px-4 pb-20 pt-16 sm:px-6 sm:pb-28 sm:pt-24">
        <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-safe" aria-hidden />
          Polyglot Contract Infrastructure · v0.2.1 · MIT
        </p>

        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/logo/bridge-lockup-dark.svg"
          alt="bridge — one contract, every language"
          className="mb-8 h-14 w-auto sm:h-16"
          width={330}
          height={64}
        />

        <h1 className="max-w-3xl text-4xl font-semibold leading-tight tracking-tight text-foreground sm:text-5xl sm:leading-tight">
          One contract. Every language.{' '}
          <span className="text-safe">Zero interoperability drift.</span>
        </h1>

        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted-foreground">
          Bridge is a polyglot contract compiler and compatibility platform. Define a data or
          service contract once, and the compiler generates idiomatic, validated code for six
          languages, classifies every change{' '}
          <span className="font-mono text-sm text-safe">SAFE</span> /{' '}
          <span className="font-mono text-sm text-warning">WARNING</span> /{' '}
          <span className="font-mono text-sm text-breaking">BREAKING</span> /{' '}
          <span className="font-mono text-sm text-unknown">UNKNOWN</span> before it merges, and
          tracks who consumes what in a content-addressed registry.
        </p>

        <div className="mt-9 flex flex-wrap items-center gap-3">
          <a
            href={DASHBOARD_URL}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-3 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            Open Console
            <ArrowRight className="h-4 w-4" aria-hidden />
          </a>
          <a
            href="https://github.com/Roy-Wanyoike/bridge"
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-5 py-3 text-sm font-medium text-foreground transition-colors hover:bg-secondary"
          >
            <GithubMark className="h-4 w-4" />
            Star on GitHub
          </a>
          <a
            href="#demo"
            className="inline-flex items-center gap-2 rounded-lg px-5 py-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            See it in 30 seconds
          </a>
        </div>
      </div>
    </section>
  );
}
