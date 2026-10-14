import { Boxes, GitBranch, Network } from 'lucide-react';

const MOATS = [
  {
    icon: Boxes,
    title: 'The compiler is the moat',
    body: 'Compatibility is computed in the compiler against a canonical, hashable IR — not bolted onto a spec parser. That is years of compiler work a spec-linter cannot retrofit. Generated output is byte-deterministic: regenerating never produces diff churn.',
  },
  {
    icon: GitBranch,
    title: 'The registry is the lock-in',
    body: 'Content-addressed identity (SHA-256), immutable versions, tamper detection, and a real dependency graph. Every published contract makes bridge impact more valuable and switching costlier.',
  },
  {
    icon: Network,
    title: 'The AI-agent era multiplies demand',
    body: 'Tool-calling surfaces, MCP servers, and multi-agent systems generate machine-to-machine contracts faster than hand-maintained bindings can track. They need exactly what Bridge enforces: one source of truth, validators in every runtime, a gate that stops breaking changes.',
  },
];

export function Moat() {
  return (
    <section id="moat" aria-labelledby="moat-heading" className="border-t border-border">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <h2 id="moat-heading" className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Why this wins
        </h2>
        <p className="mt-3 max-w-2xl text-muted-foreground">
          The category does not exist yet, and the pieces that pretend to are format-bound: Buf
          lints protos, Confluent checks Avro subjects, OpenAPI differs check specs. Each guards a
          single format — none can answer the question every polyglot org asks weekly.
        </p>

        <div className="mt-10 grid gap-5 md:grid-cols-3">
          {MOATS.map(({ icon: Icon, title, body }) => (
            <article key={title} className="rounded-xl border border-border bg-card p-6">
              <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-safe-soft text-safe">
                <Icon className="h-5 w-5" aria-hidden />
              </div>
              <h3 className="font-semibold text-foreground">{title}</h3>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
