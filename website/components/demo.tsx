function Prompt({ children }: { children: string }) {
  return (
    <p className="flex flex-wrap items-start gap-2">
      <span className="select-none text-safe" aria-hidden>
        $
      </span>
      <span className="break-all text-foreground">{children}</span>
    </p>
  );
}

function Out({ children, tone }: { children: string; tone?: 'breaking' | 'warning' | 'muted' }) {
  const toneClass =
    tone === 'breaking'
      ? 'text-breaking'
      : tone === 'warning'
        ? 'text-warning'
        : 'text-muted-foreground';
  return <p className={`whitespace-pre-wrap break-all pl-6 ${toneClass}`}>{children}</p>;
}

/**
 * Real commands, real output — the same transcript verified by the runnable
 * examples in the repo (README "See it in 30 seconds").
 */
export function Demo() {
  return (
    <section id="demo" aria-labelledby="demo-heading" className="border-t border-border">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <h2 id="demo-heading" className="text-2xl font-semibold tracking-tight sm:text-3xl">
          See it in 30 seconds
        </h2>
        <p className="mt-3 max-w-2xl text-muted-foreground">
          Real commands, real output — from the runnable examples in the repo. The rename a code
          reviewer would wave through fails the report, and{' '}
          <code className="font-mono text-sm text-foreground">bridge check</code> exits non-zero so
          it never merges.
        </p>

        <div
          className="mt-8 overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
          role="img"
          aria-label="Terminal session: bridge validate, bridge generate, and bridge diff showing a breaking change"
        >
          <div className="flex items-center gap-1.5 border-b border-border px-4 py-3" aria-hidden>
            <span className="h-3 w-3 rounded-full bg-breaking/70" />
            <span className="h-3 w-3 rounded-full bg-warning/70" />
            <span className="h-3 w-3 rounded-full bg-safe/70" />
            <span className="ml-3 font-mono text-xs text-muted-foreground">
              payments-service — bridge
            </span>
          </div>
          <div
            className="space-y-4 overflow-x-auto p-5 font-mono text-[13px] leading-relaxed sm:p-6"
          >
            <Prompt>bridge validate payments.bridge</Prompt>
            <Out>✓ payments.bridge ok (package payments.v1, hash 1f7292582f39)</Out>

            <Prompt>bridge generate payments.bridge --language go</Prompt>
            <Out>✓ wrote generated/go/enums.go</Out>
            <Out>✓ wrote generated/go/types.go</Out>
            <Out>✓ wrote generated/go/validate.go</Out>
            <Out>6 file(s) written to generated/go (go)</Out>

            <Prompt>bridge diff v1.payments.bridge v2.payments.bridge</Prompt>
            <Out>BRIDGE COMPATIBILITY REPORT</Out>
            <Out>package: payments.v1</Out>
            <Out tone="breaking">❌ Breaking: Field renamed: Payment.currency → Payment.reference</Out>
            <Out tone="warning">⚠ Added enum value: PaymentStatus.REFUNDED</Out>
            <Out>&nbsp;</Out>
            <Out>Summary: 0 safe, 1 warnings, 1 breaking, 0 unknown</Out>
            <Out tone="breaking">Verdict: BREAKING</Out>
            <Out tone="breaking">Compatibility: FAILED</Out>
          </div>
        </div>
      </div>
    </section>
  );
}
