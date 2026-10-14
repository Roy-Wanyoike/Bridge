import { ArrowUpRight, BookOpen, FileCode, ShieldCheck, Terminal } from 'lucide-react';
import { DASHBOARD_URL } from '@/lib/dashboard-url';

const DOCS = [
  {
    icon: Terminal,
    title: 'Quickstart',
    body: 'From an empty directory to generated, verified code.',
    href: 'https://github.com/Roy-Wanyoike/bridge/blob/main/docs/QUICKSTART.md',
  },
  {
    icon: FileCode,
    title: 'IDL reference',
    body: 'Enums, unions, services, events, constraints.',
    href: 'https://github.com/Roy-Wanyoike/bridge/blob/main/docs/IDL_REFERENCE.md',
  },
  {
    icon: ShieldCheck,
    title: 'Compatibility guide',
    body: 'The classification matrix and the CI gate recipe.',
    href: 'https://github.com/Roy-Wanyoike/bridge/blob/main/docs/COMPATIBILITY.md',
  },
  {
    icon: BookOpen,
    title: 'Strategy',
    body: 'Market analysis and positioning for the category.',
    href: 'https://github.com/Roy-Wanyoike/bridge/tree/main/docs/strategy',
  },
];

export function Resources() {
  return (
    <section id="docs" aria-labelledby="docs-heading" className="border-t border-border">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 id="docs-heading" className="text-2xl font-semibold tracking-tight sm:text-3xl">
              Start building
            </h2>
            <p className="mt-3 max-w-2xl text-muted-foreground">
              Clone the repo, scaffold a contract, generate code for your stack. The docs walk the
              whole path — including the CI gate recipe.
            </p>
          </div>
          <a
            href={DASHBOARD_URL}
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-secondary"
          >
            Open Console
            <ArrowUpRight className="h-4 w-4" aria-hidden />
          </a>
        </div>

        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {DOCS.map(({ icon: Icon, title, body, href }) => (
            <a
              key={title}
              href={href}
              className="group rounded-xl border border-border bg-card p-5 transition-colors hover:bg-secondary"
            >
              <Icon className="h-5 w-5 text-safe" aria-hidden />
              <h3 className="mt-3 flex items-center gap-1.5 font-semibold text-foreground">
                {title}
                <ArrowUpRight
                  className="h-3.5 w-3.5 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
                  aria-hidden
                />
              </h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{body}</p>
            </a>
          ))}
        </div>

        <div className="mt-12 overflow-x-auto rounded-xl border border-border bg-card">
          <pre className="min-w-max p-5 font-mono text-[13px] leading-relaxed sm:p-6">
            <code>
              <span className="text-muted-foreground"># requires Node.js &gt;= 22</span>
              {'\n'}
              <span className="text-safe">$ </span>
              git clone https://github.com/Roy-Wanyoike/bridge.git{'\n'}
              <span className="text-safe">$ </span>
              cd bridge && npm install && npm run build{'\n'}
              <span className="text-safe">$ </span>
              bridge init payments-service && cd payments-service{'\n'}
              <span className="text-safe">$ </span>
              bridge generate --language go{' '}
              <span className="text-muted-foreground"># also: rust | typescript | python | java | csharp</span>
            </code>
          </pre>
        </div>
      </div>
    </section>
  );
}
