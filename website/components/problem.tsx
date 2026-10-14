export function Problem() {
  return (
    <section id="problem" aria-labelledby="problem-heading" className="border-t border-border">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <h2 id="problem-heading" className="text-2xl font-semibold tracking-tight sm:text-3xl">
          The problem
        </h2>

        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          <div className="rounded-xl border border-border bg-card p-6">
            <p className="text-xs font-medium uppercase tracking-wider text-warning">
              In plain terms
            </p>
            <p className="mt-3 leading-relaxed text-muted-foreground">
              Imagine a company where the payments team writes Go, the web team uses TypeScript,
              and the data team uses Python. All three need to agree on what a{' '}
              <span className="font-mono text-sm text-foreground">Payment</span> looks like: an
              amount, a currency (exactly 3 letters), a status. Today, each team hand-writes their
              own copy of those rules — three copies, kept in sync by hope.
            </p>
            <p className="mt-4 leading-relaxed text-muted-foreground">
              Someone renames a field, nothing stops them, and weeks later the Python system
              crashes in production because its copy quietly no longer matches. Bridge kills the
              hand-copies: one agreement, translated to every language, refereed on every change.
            </p>
          </div>

          <div className="rounded-xl border border-border bg-card p-6">
            <p className="text-xs font-medium uppercase tracking-wider text-safe">
              For engineering teams
            </p>
            <p className="mt-3 leading-relaxed text-muted-foreground">
              The same contract —{' '}
              <span className="font-mono text-sm text-foreground">Payment</span>,{' '}
              <span className="font-mono text-sm text-foreground">PaymentStatus</span>, the rule
              that currency is exactly 3 characters — is hand-implemented in every runtime.
              Breaking-change checks, where they exist, are per-tool and per-format: a linter for
              protos, a differ for OpenAPI. Nothing knows{' '}
              <em className="text-foreground">who consumes what</em>.
            </p>
            <p className="mt-4 leading-relaxed text-muted-foreground">
              Bridge computes compatibility inside the compiler against a canonical, hashable IR —
              deterministic, conservative, and honest: an undecidable change is reported UNKNOWN
              and fails the default gate, never silently safe.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
