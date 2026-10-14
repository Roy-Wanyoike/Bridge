const LANGUAGES = [
  { name: 'Go', note: 'stdlib only; encoding/json tags; validator methods' },
  { name: 'Rust', note: 'serde; @pattern limitations documented' },
  { name: 'TypeScript', note: 'strict types; documented int64 (2^53) caveat' },
  { name: 'Python', note: 'stdlib dataclasses; to_dict / from_dict round-trip' },
  { name: 'Java', note: 'JDK-only (zero deps, incl. a generated JSON runtime)' },
  { name: 'C#', note: 'System.Text.Json only; structural value equality' },
  { name: 'WASM', note: 'via @bridge/ffi — one contract, callable across languages' },
];

const SHIPPED = [
  'Bridge IDL (lexer, parser, semantic analysis)',
  'Canonical IR + deterministic hashing',
  'Compatibility engine (bridge diff)',
  'Registry (local + multi-tenant service)',
  'CLI (16 subcommands)',
  'LSP for the IDL',
  'FFI (Go ↔ Rust) + WASM target',
  'Cross-language serialization round-trips',
];

export function Languages() {
  return (
    <section id="languages" aria-labelledby="languages-heading" className="border-t border-border">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <h2 id="languages-heading" className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Every target, from the same IR
        </h2>
        <p className="mt-3 max-w-2xl text-muted-foreground">
          Types, enums, tagged unions, aliases, constraint validators, service clients, and event
          envelopes — generated from one canonical contract, with every constraint enforced in
          every runtime. Generated Go, Rust, Java and C# are compile-verified in CI.
        </p>

        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {LANGUAGES.map((l) => (
            <article
              key={l.name}
              className="flex items-start gap-3 rounded-xl border border-border bg-card p-5"
            >
              <span
                className="mt-0.5 inline-flex h-5 shrink-0 items-center rounded-full bg-safe-soft px-2 font-mono text-[11px] font-medium text-safe"
                aria-label="shipped"
              >
                ✓
              </span>
              <div>
                <h3 className="font-semibold text-foreground">{l.name}</h3>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{l.note}</p>
              </div>
            </article>
          ))}
        </div>

        <ul className="mt-10 flex flex-wrap gap-2">
          {SHIPPED.map((s) => (
            <li
              key={s}
              className="rounded-full border border-border bg-secondary px-3.5 py-1.5 text-xs text-muted-foreground"
            >
              {s}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
