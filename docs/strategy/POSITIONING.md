# Bridge — Positioning & Strategy

*Strategy doc · maintained on `main` under `docs/strategy/` · companion to [MARKET_ANALYSIS](./MARKET_ANALYSIS.md).*

---

## 1. One-line positioning

> **Bridge is polyglot contract infrastructure: define a data or service contract once, and the compiler generates idiomatic, validated code for every language, detects breaking changes before they merge, and governs contracts in a registry that knows who consumes what.**

Short forms, by context:

- **Tagline (public):** One contract. Every language. Zero interoperability drift.
- **Category (internal):** Polyglot Contract Infrastructure.
- **For a slide:** The compiler + registry + CI gate for every contract your services, events, and AI agents share.

## 2. Category creation: "Polyglot Contract Infrastructure"

Existing categories each govern one format: *Schema Registry* (Kafka serialization), *API gateway/management* (HTTP traffic), *API design tooling* (spec authoring), *contract testing* (interaction verification). None of them is the layer where a *contract* — language-neutral, transport-neutral, owned, versioned, and consumer-tracked — lives.

Bridge's category claim: **Polyglot Contract Infrastructure** is the layer between "teams agree on shapes" and "every runtime enforces them." Its three primitives:

1. **The compiler** — contracts in, canonical deterministic IR, validated code out (Go/Rust/TypeScript/Python).
2. **The registry** — the system of record: content-addressed, immutable, with a dependency graph (dependents/consumers).
3. **The gate** — compatibility classification and consumer-aware impact enforced in CI, before merge.

We deliberately avoid competing inside existing categories' home turf ("a better Avro registry", "a better OpenAPI linter"). We sit above all of them and treat them as producers and consumers of contracts.

## 3. Elevator pitches

**The 30-second recruiter version.**
Bridge is an open-source platform that solves a problem every senior engineer has lived: the same data contract gets re-implemented in Go, Rust, TypeScript, Python, Java, and C#, and then silently breaks. We built a compiler for contracts — you write the contract once, it generates idiomatic, validated code for all six languages, detects breaking changes in CI before they merge, and tracks who depends on what in a versioned registry. The roadmap through the platform era is shipped and tested: nine packages, 831 green tests (plus a 94-test dashboard suite), eight runnable examples, a multi-tenant registry service, and consumer-aware impact analysis. What's next: contracts for AI-agent tool surfaces (tool-call/MCP schema emission). If you like compilers, deterministic systems, and infrastructure that engineering orgs depend on daily, this is the project to work on.

**The 30-second engineer version.**
Every contract you maintain twice is a bug factory. Bridge gives you one IDL: enums, unions, services, events, constraints (`@min`, `@length`, `@email`). `bridge generate` emits byte-deterministic Go/Rust/TS/Python/Java/C# with runtime validators for every constraint — no plugins, no drift. `bridge diff` classifies every change SAFE/WARNING/BREAKING/UNKNOWN against the canonical IR (not your formatting); `bridge check` fails the pipeline on breaking or undecidable changes. `bridge publish` puts contracts in a content-addressed registry — SHA-256 identity, immutable versions, tamper detection, `dependents()` for impact — and `bridge impact` walks that graph to tell you which consumers a change reaches. Everything is thin wrappers over nine auditable packages with a frozen IR contract. 831 tests green; the generated code round-trips and type-checks — Go, Rust, Java and C# are compile-verified in CI, TypeScript and Python via local scripts.

**The 30-second investor version.**
Polyglot orgs re-implement every data contract three to five times and break them silently — and there is no tool anywhere that answers "which consumers does this contract change affect?" AI-agent platforms are now hitting the same problem at machine speed with tool-calling contracts. Bridge compiles one contract into validated code for every language, classifies breaking changes in CI, and tracks the consumer graph in an immutable registry. The platform — compiler, registry service, impact gate, and the release pipeline — is shipped and tested (831 tests); the moat compounds from the deterministic IR, the contract graph's network effects, and CI governance lock-in. We are consolidating several proven point solutions (schema registries, diff tools, SDK generators) into one infrastructure layer that has no incumbent owner.

**The 30-second CTO/platform-lead version.**
Your platform team owns SDK generation, schema governance, and API compatibility review — all hand-built, all drifting. Bridge replaces that accreted glue with one pipeline: contracts compile to a canonical IR, code and validators generate for every language deterministically, breaking changes fail CI with an honest classification, and the registry answers "who consumes this contract?" before you merge. It is self-hostable, has no runtime dependencies, and its audit trail (immutable, hash-addressed contract versions with diff reports) is exactly what your compliance reviewers ask for. Adopt it per-repo with `bridge check` in CI; grow it into org-wide governance when you are ready.

## 4. Product principles

1. **Compatibility is a compiler feature.** Breaking-change detection is built on the same IR as codegen — deterministic, testable, conservative. Undecidable changes are reported as UNKNOWN, never silently passed.
2. **One source of truth, idiomatic everywhere.** Generated code should look like a senior engineer in that language wrote it — dataclasses in Python, serde in Rust, structs in Go. Bindings-shaped code is a bug we have not shipped yet.
3. **Determinism is a feature, not an implementation detail.** Identical input → identical IR, identical hash, identical bytes out. CI regeneration never produces churn; a hash is an identity.
4. **Validate everywhere the contract travels.** A constraint declared once is enforced in every generated runtime. Validation drift between languages is the silent killer; parity is the product.
5. **Honesty in classification and docs.** SAFE means provably safe; UNKNOWN means we could not decide. Marketing claims and status tables distinguish shipped from planned, always.
6. **Boring, auditable technology.** No magic, no runtime agents, no lock-in formats. The registry is files and hashes; the compiler is pure functions; everything is thin wrappers over auditable packages.
7. **The consumer is a first-class entity.** Contracts exist because consumers depend on them; the system of record must know who they are (impact analysis, [#19](https://github.com/Roy-Wanyoike/bridge/issues/19)).
8. **AI-era contracts are contracts.** Tool schemas consumed by LLMs and agents get the same identity, validation, and evolution governance as service-to-service contracts.

## 5. Three-horizon roadmap narrative

### Horizon 1 — Now: the compiler era (shipped)

**What exists:** the Bridge IDL (lexer → parser → semantic analysis → canonical IR, recoverable diagnostics), deterministic SHA-256 contract hashing, canonical formatter, the compatibility engine with four-level classification and strict/compatible CI gates, generators for Go/Rust/TypeScript/Python (joined by Java/C# in horizon 3 — types, enums, tagged unions, aliases, validators, service clients/traits, event envelopes), a 16-command CLI, and an immutable content-addressed local registry. 831 tests across nine packages; eight runnable examples; Go/Rust/Java/C# round-trips compile-verified in CI (TypeScript and Python verified by local scripts).

**Why it matters:** this horizon proves the two claims everything else rests on — that one IR can serve every language faithfully, and that compatibility can be a deterministic compiler output. Nothing later in the roadmap required revisiting it.

**Shipped on top of it:** cross-language serialization round-trip proof ([#15](https://github.com/Roy-Wanyoike/bridge/issues/15)), event + RPC transports ([#16](https://github.com/Roy-Wanyoike/bridge/issues/16), [#17](https://github.com/Roy-Wanyoike/bridge/issues/17)), consumer-aware impact analysis ([#19](https://github.com/Roy-Wanyoike/bridge/issues/19)) — the feature that turns the registry into the only tool that answers "17 consumers affected."

### Horizon 2 — Next: the governance era (shipped)

**What shipped:** the registry became a service ([#18](https://github.com/Roy-Wanyoike/bridge/issues/18)) — networked API, OIDC auth, multi-tenancy, audit logs, signing, rate limits, in-memory + PostgreSQL drivers; the dashboard ([#20](https://github.com/Roy-Wanyoike/bridge/issues/20)) makes the contract graph visible (contracts, versions, consumers, compatibility history); governance is enforceable in CI (`bridge check --against`, `bridge impact --strict`, plus a copy-pasteable governance workflow); release engineering ([#24](https://github.com/Roy-Wanyoike/bridge/issues/24)) makes Bridge itself a product (binaries, Homebrew, Docker, SBOM, signing — the pipeline is complete; the first release cut waits on the CI billing unlock).

**Why it matters:** this is where Bridge stops being a tool a team adopts and starts being infrastructure an org runs. The audit trail + policy gates combination is the wedge for regulated industries, and the dashboard is what makes contract ownership legible to humans.

### Horizon 3 — Later: the platform & AI-native era (shipped, except AI-native tooling)

**What shipped:** an LSP for the IDL ([#21](https://github.com/Roy-Wanyoike/bridge/issues/21)) making contracts a first-class editor experience; Java/C# generators ([#25](https://github.com/Roy-Wanyoike/bridge/issues/25)) widening polyglot coverage to six languages; Go↔Rust FFI and a WASM target ([#22](https://github.com/Roy-Wanyoike/bridge/issues/22)) so the *same contract* can carry a function across a language boundary, not just data; and property-based testing and deterministic caching ([#23](https://github.com/Roy-Wanyoike/bridge/issues/23)) hardening correctness at scale.

**What remains:** AI-native tooling — emitting agent/tool contract artifacts (JSON Schema for tool calling, MCP tool surfaces) from the IR, so agent ecosystems get verified, evolving contracts from the same governance plane as services.

**Why it matters:** horizon 3 converts Bridge from "the contract layer for your services" into "the contract layer for everything that speaks a shape" — including non-human consumers. That is the surface where adoption compounds fastest in the current market (see MARKET_ANALYSIS §6, "Why now").

---

## 6. Messaging guardrails

- Never claim "revolutionary" or "first ever" — claim **specific, testable** properties (deterministic output, four-level classification, immutable registry, 831 tests).
- Never bury the distinction between shipped and planned. The README status table is the canonical shipped/pending record; strategy docs link to it rather than duplicating it.
- Respect incumbents by name and strength; compete on the gaps (MARKET_ANALYSIS §2, §4.2), never on strawmen.
- Numbers are labeled: test counts and shipped features are facts; market sizes are **estimates**; forecasts are narratives, not promises.
