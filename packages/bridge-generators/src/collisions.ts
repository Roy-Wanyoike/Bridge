/**
 * Post-normalization collision detection for the Bridge generators (issue
 * #116).
 *
 * Legal Bridge contracts can contain names that are DISTINCT on the wire
 * but COLLAPSE into one identifier once a language's naming rules are
 * applied (case folding, keyword escaping, generated runtime symbols).
 * Emitting them anyway produces non-compiling or self-shadowing code, so
 * the TARGET language of a `generate` call goes through two checks BEFORE
 * any file is rendered (and only that language: a name that collapses in
 * Go but not in TypeScript must not block TypeScript generation, and every
 * diagnostic names the language whose generator actually failed):
 *
 * 1. Duplicate-render detection — two distinct IR fields/variants/methods
 *    that render to the same identifier in one scope fail generation with
 *    an actionable diagnostic naming the contract, the scope, both source
 *    names and the colliding rendered name. There is no order-independent
 *    way to pick a "winner" for the clean identifier, and auto-renaming one
 *    side would fragment the API differently per language, so these FAIL.
 *
 * 2. Reserved-runtime-symbol handling — user declarations named like the
 *    symbols the generator itself emits (`Set`, `BridgeJson`,
 *    `BridgeRpcError`, `BridgeEventMeta`, ...) fail generation with a
 *    suggestion to rename. The IR has no type-level rename mechanism (the
 *    #115 member tables only cover struct/event FIELDS), so these FAIL too.
 *
 * Member-level collisions against generated per-type methods (Go Validate,
 * Java toDict/..., C# ToDict/...) are handled by the reserved-member tables
 * in naming.ts instead: a single identifier vs a generated method has a
 * well-defined, order-independent trailing-underscore escape that preserves
 * the wire name, so those auto-rename rather than fail.
 */

import type { IRField, IRPackage } from '@bridge/core';
import { sortedEvents, sortedServices, sortedTypes, usesConstraint, usesSets } from './analysis';
import type { GeneratorInput } from './gen/input';
import type { TargetLanguage } from './mappings';
import {
  camelToLowerSnake,
  csharpPropertyName,
  csharpSafeIdent,
  goExportedName,
  goSafeIdent,
  javaFieldName,
  javaGetterCollidesWithObjectOrKeyword,
  javaGetterName,
  javaPascal,
  javaSafeIdent,
  pascalFromScreaming,
  pascalToCamel,
  pythonEnumMemberName,
  pythonFieldName,
  pythonUnionVariantMethod,
  rustFieldName,
  rustVariantName,
  tsFieldName,
} from './naming';

/** Thrown when a legal-looking contract would render non-compiling code. */
export class GenerationCollisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GenerationCollisionError';
  }
}

/** One scope entry: the declared (wire) source name and its rendered identifier. */
interface RenderedName {
  readonly source: string;
  readonly rendered: string;
}

/**
 * Fails when two distinct sources render to the same identifier in one
 * scope. The diagnostic names the contract (package), the scope, both
 * source names and the rendered identifier; the pair is sorted so the
 * message itself is deterministic regardless of IR array order.
 */
function checkScope(packageName: string, language: TargetLanguage, scope: string, names: readonly RenderedName[]): void {
  const seen = new Map<string, string>();
  for (const { source, rendered } of names) {
    const previous = seen.get(rendered);
    if (previous !== undefined && previous !== source) {
      const [a, b] = [previous, source].sort();
      throw new GenerationCollisionError(
        `${packageName}: ${language} generator: identifier collision in ${scope}: '${a}' and '${b}' ` +
          `both render to '${rendered}'. The two names are distinct in the Bridge contract but collapse ` +
          `into one ${language} identifier. Rename one of them in the contract; generation failed instead ` +
          `of emitting non-compiling ${language} code.`,
      );
    }
    seen.set(rendered, source);
  }
}

/** struct '<Name>' / event '<Name>' scope label. */
function memberScope(kind: 'struct' | 'event', name: string): string {
  return `${kind} '${name}' (field name)`;
}

/* ------------------------------------------------------------------ */
/* Per-language render functions (mirror the generator emission sites) */
/* ------------------------------------------------------------------ */

function renderFieldName(language: TargetLanguage, name: string): string {
  switch (language) {
    case 'go':
      return goExportedName(name);
    case 'rust':
      return rustFieldName(name).name;
    case 'typescript':
      return tsFieldName(name).name;
    case 'python':
      return pythonFieldName(name).name;
    case 'java':
      return javaFieldName(name).name;
    case 'csharp':
      return csharpPropertyName(name).name;
  }
}

function renderEnumVariant(language: TargetLanguage, enumName: string, variant: string): string {
  switch (language) {
    case 'go':
      // goConstName: `<Enum><PascalVariant>` constants.
      return `${enumName}${pascalFromScreaming(variant)}`;
    case 'rust':
      return rustVariantName(variant);
    case 'typescript':
      // As-const wire-value object key.
      return pascalFromScreaming(variant);
    case 'python':
      return pythonEnumMemberName(variant).name;
    case 'java':
      return javaSafeIdent(variant);
    case 'csharp':
      return csharpSafeIdent(csPascal(variant));
  }
}

/**
 * EVERY identifier a union variant participates in for one language
 * (factory/constructor, typed accessor, enum-style variant). A pair of
 * variants that collides in ANY of these spaces is a generation failure,
 * even when the other spaces stay distinct (Java `RateLimit`/`rate_limit`
 * factories are distinct but both accessors render `asRateLimit`).
 */
function renderUnionVariant(language: TargetLanguage, variant: string): string[] {
  switch (language) {
    case 'go':
      // New<Union><Variant> / As<Variant> constructor and accessor names
      // share the goExportedName stem.
      return [goExportedName(variant)];
    case 'rust':
      // Enum variant + new_<snake>/as_<snake> constructor/accessor names.
      return [rustVariantName(variant), `new_${camelToLowerSnake(variant)}`, `as_${camelToLowerSnake(variant)}`];
    case 'typescript':
      return [variant]; // inline { kind, value } members; no per-variant identifiers
    case 'python':
      return [pythonUnionVariantMethod(variant)];
    case 'java':
      // static <snake> factory + as<Pascal> accessor.
      return [javaSafeIdent(variant.toLowerCase()), `as${javaPascal(variant)}`];
    case 'csharp':
      // static <Pascal> factory + As<Pascal> accessor share the stem.
      return [csharpSafeIdent(csPascal(variant))];
  }
}

function renderServiceMethod(language: TargetLanguage, method: string): string {
  switch (language) {
    case 'go':
      return goSafeIdent(method);
    case 'rust':
      return camelToLowerSnake(method);
    case 'typescript':
      return pascalToCamel(method);
    case 'python':
      return camelToLowerSnake(method);
    case 'java':
      // camelToLowerSnakeJava: first character lowercased, rest verbatim.
      return method.charAt(0).toLowerCase() + method.slice(1);
    case 'csharp':
      return camelToPascal(method);
  }
}

/**
 * C# PascalCase identifier that preserves existing camel humps
 * (`CreatePayment` stays `CreatePayment`; `create_payment` becomes
 * `CreatePayment`) — mirrors csharp.ts.
 */
function camelToPascal(name: string): string {
  return csPascal(name.replace(/([a-z0-9])([A-Z])/g, '$1_$2'));
}

/** PascalCase from snake/SCREAMING (mirrors csharp.ts `pascal`). */
function csPascal(name: string): string {
  const parts = name.split(/[_\s]+/).filter((p) => p.length > 0);
  if (parts.length === 0) return 'Value';
  let out = '';
  for (const part of parts) {
    out += part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Duplicate-render detection                                          */
/* ------------------------------------------------------------------ */

/** Java struct/event member + getter collision checks for one class scope. */
function checkJavaMembers(packageName: string, scope: string, fields: readonly IRField[]): void {
  const members: RenderedName[] = [];
  const getters: RenderedName[] = [];
  for (const field of fields) {
    const member = javaFieldName(field.name).name;
    members.push({ source: field.name, rendered: member });
    const getter = javaGetterName(member);
    getters.push({ source: field.name, rendered: getter });
    if (javaGetterCollidesWithObjectOrKeyword(getter)) {
      throw new GenerationCollisionError(
        `${packageName}: java generator: identifier collision in ${scope}: field '${field.name}' derives the ` +
          `getter '${getter}', which overrides Object.getClass or is named after a Java keyword. Rename the ` +
          `field in the contract; generation failed instead of emitting a class that does not compile.`,
      );
    }
  }
  checkScope(packageName, 'java', `${scope} (member name)`, members);
  checkScope(packageName, 'java', `${scope} (getter name)`, getters);
}

/**
 * Runs every duplicate-render check for the TARGET language of the
 * `generate` call. Called from `generate` before any file is rendered, so
 * a colliding contract fails generation in full instead of emitting one
 * broken language, and the diagnostic always names the language that
 * actually failed (never a sibling language's check).
 */
export function assertNoRenderedCollisions(input: GeneratorInput): void {
  const pkg = input.packageName;
  const language = input.language;
  const types = sortedTypes(input.ir);
  const services = input.generateServices ? sortedServices(input.ir) : [];
  const events = input.generateEvents ? sortedEvents(input.ir) : [];

  for (const type of types) {
    switch (type.kind) {
      case 'struct':
        checkScope(
          pkg,
          language,
          memberScope('struct', type.name),
          type.fields.map((f) => ({ source: f.name, rendered: renderFieldName(language, f.name) })),
        );
        break;
      case 'enum':
        checkScope(
          pkg,
          language,
          `enum '${type.name}' (variant identifier)`,
          type.variants.map((v) => ({
            source: v.name,
            rendered: renderEnumVariant(language, type.name, v.name),
          })),
        );
        break;
      case 'union':
        checkScope(
          pkg,
          language,
          `union '${type.name}' (variant constructor/accessor)`,
          type.variants.flatMap((v) =>
            renderUnionVariant(language, v.name).map((rendered) => ({ source: v.name, rendered })),
          ),
        );
        break;
      case 'alias':
        break;
    }
  }
  for (const event of events) {
    checkScope(
      pkg,
      language,
      memberScope('event', event.name),
      event.fields.map((f) => ({ source: f.name, rendered: renderFieldName(language, f.name) })),
    );
  }
  for (const service of services) {
    checkScope(
      pkg,
      language,
      `service '${service.name}' (method name)`,
      service.methods.map((m) => ({ source: m.name, rendered: renderServiceMethod(language, m.name) })),
    );
  }

  // Java getters: derived from the escaped member name; one extra pass per
  // struct/event (issue #116 class 3). Java-only — no other backend derives
  // bean accessors, so the pass must not fire for sibling languages.
  if (language === 'java') {
    for (const type of types) {
      if (type.kind === 'struct') {
        checkJavaMembers(pkg, `struct '${type.name}'`, type.fields);
      }
    }
    for (const event of events) {
      checkJavaMembers(pkg, `event '${event.name}'`, event.fields);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Reserved runtime symbols                                            */
/* ------------------------------------------------------------------ */

interface RuntimeSymbol {
  readonly name: string;
  /** Where the generator emits it (for the actionable diagnostic). */
  readonly where: string;
}

const GO_SERVICES: readonly RuntimeSymbol[] = [
  { name: 'HTTPDoer', where: 'services.go (RPC block)' },
  { name: 'BridgeRPCError', where: 'services.go (RPC block)' },
  { name: 'BridgeStatusForCode', where: 'services.go (RPC block)' },
  { name: 'writeBridgeJSON', where: 'services.go (RPC block)' },
  { name: 'writeBridgeError', where: 'services.go (RPC block)' },
  { name: 'bridgeMaxBodyBytes', where: 'services.go (RPC block)' },
  { name: 'bridgeErrorFromBody', where: 'services.go (RPC block)' },
  { name: 'bridgeAssertErrorBody', where: 'roundtrip_test.go' },
];

const GO_SETS: readonly RuntimeSymbol[] = [
  { name: 'Set', where: 'types.go (set<T> support)' },
  { name: 'SetToSlice', where: 'types.go (set<T> support)' },
  { name: 'SliceToSet', where: 'types.go (set<T> support)' },
  { name: 'bridgeSetLess', where: 'types.go (canonical set order, #117)' },
];

const GO_EVENTS: readonly RuntimeSymbol[] = [
  { name: 'BridgeEventSpecversion', where: 'events.go (envelope)' },
  { name: 'BridgeEventMeta', where: 'events.go (envelope)' },
  { name: 'BridgeEventEnvelope', where: 'events.go (envelope)' },
  { name: 'DecodeBridgeEventEnvelope', where: 'events.go (envelope)' },
  { name: 'BridgeEventPublisher', where: 'events.go (envelope)' },
  { name: 'InMemoryEventBus', where: 'events.go (envelope)' },
  { name: 'BridgeEventDispatcher', where: 'events.go (envelope)' },
  { name: 'NewBridgeEventDispatcher', where: 'events.go (envelope)' },
  { name: 'bridgeEventSubscriber', where: 'events.go (envelope)' },
];

const RUST_STRUCTS: readonly RuntimeSymbol[] = [{ name: 'ValidationError', where: 'src/validate.rs' }];

const RUST_CONSTRAINTS: Readonly<Record<string, readonly RuntimeSymbol[]>> = {
  email: [{ name: 'is_bridge_email', where: 'src/validate.rs (@email helper)' }],
  url: [{ name: 'is_bridge_url', where: 'src/validate.rs (@url helper)' }],
  uuid: [{ name: 'is_bridge_uuid', where: 'src/validate.rs (@uuid helper)' }],
};

const RUST_SERVICES: readonly RuntimeSymbol[] = [
  { name: 'BridgeRpcError', where: 'src/services.rs (RPC block)' },
  { name: 'bridge_status_for_code', where: 'src/services.rs (RPC block)' },
  { name: 'bridge_error_from_body', where: 'src/services.rs (RPC block)' },
  { name: 'BridgeCallResult', where: 'src/services.rs (RPC block)' },
  { name: 'bridge_http_post_json', where: 'src/services.rs (RPC block)' },
  { name: 'serve_once', where: 'src/services.rs (server)' },
  { name: 'serve_forever', where: 'src/services.rs (server)' },
];

const RUST_EVENTS: readonly RuntimeSymbol[] = [
  { name: 'BRIDGE_EVENT_SPECVERSION', where: 'src/events.rs (envelope)' },
  { name: 'BridgeEventMeta', where: 'src/events.rs (envelope)' },
  { name: 'BridgeEventEnvelope', where: 'src/events.rs (envelope)' },
  { name: 'decode_bridge_event_envelope', where: 'src/events.rs (envelope)' },
  { name: 'EventPublisher', where: 'src/events.rs (envelope)' },
  { name: 'BridgeEventDispatcher', where: 'src/events.rs (envelope)' },
  { name: 'InMemoryEventBus', where: 'src/events.rs (envelope)' },
];

const TS_SERVICES: readonly RuntimeSymbol[] = [
  { name: 'FetchLike', where: 'src/services.ts (RPC block)' },
  { name: 'BridgeRpcError', where: 'src/services.ts (RPC block)' },
  { name: 'bridgeStatusForCode', where: 'src/services.ts (RPC block)' },
  { name: 'BridgeNodeHttpRequest', where: 'src/services.ts (RPC block)' },
  { name: 'BridgeNodeHttpResponse', where: 'src/services.ts (RPC block)' },
  { name: 'BridgeNodeRequestListener', where: 'src/services.ts (RPC block)' },
  { name: 'writeBridgeJson', where: 'src/services.ts (RPC block)' },
  { name: 'writeBridgeError', where: 'src/services.ts (RPC block)' },
  { name: 'bridgeErrorFromResponse', where: 'src/services.ts (RPC block)' },
  { name: 'readRequestBody', where: 'src/services.ts (RPC block)' },
];

const TS_SETS: readonly RuntimeSymbol[] = [
  { name: 'setToArray', where: 'src/types.ts (set<T> support)' },
  { name: 'arrayToSet', where: 'src/types.ts (set<T> support)' },
  { name: 'bridgeCompareSetElements', where: 'src/types.ts (canonical set order, #117)' },
  { name: 'bridgeCompareCodePoints', where: 'src/types.ts (canonical set order, #117)' },
];

const TS_EVENTS: readonly RuntimeSymbol[] = [
  { name: 'BRIDGE_EVENT_SPECVERSION', where: 'src/events.ts (envelope)' },
  { name: 'BridgeEventMeta', where: 'src/events.ts (envelope)' },
  { name: 'BridgeEventEnvelope', where: 'src/events.ts (envelope)' },
  { name: 'decodeBridgeEventEnvelope', where: 'src/events.ts (envelope)' },
  { name: 'EventPublisher', where: 'src/events.ts (envelope)' },
  { name: 'InMemoryEventBus', where: 'src/events.ts (envelope)' },
  { name: 'BridgeEventDispatcher', where: 'src/events.ts (envelope)' },
];

const PYTHON_SERVICES: readonly RuntimeSymbol[] = [
  { name: 'BridgeServiceError', where: 'services.py (client/runtime)' },
  { name: 'BridgeRpcError', where: 'services.py (server/runtime)' },
  { name: 'bridge_status_for_code', where: 'services.py (server/runtime)' },
  { name: 'BRIDGE_ERROR_STATUS', where: 'services.py (server/runtime)' },
];

const PYTHON_EVENTS: readonly RuntimeSymbol[] = [
  { name: 'BRIDGE_EVENT_SPECVERSION', where: 'events.py (envelope)' },
  { name: 'BridgeEventMeta', where: 'events.py (envelope)' },
  { name: 'decode_bridge_event_envelope', where: 'events.py (envelope)' },
  { name: 'EventPublisher', where: 'events.py (envelope)' },
  { name: 'InMemoryEventBus', where: 'events.py (envelope)' },
  { name: 'BridgeEventDispatcher', where: 'events.py (envelope)' },
];

/** Runtime symbols conditionally emitted for a language, given the package. */
function runtimeSymbols(language: TargetLanguage, ir: IRPackage, input: GeneratorInput): RuntimeSymbol[] {
  const structs = ir.types.some((t) => t.kind === 'struct');
  const composites = ir.types.some((t) => t.kind === 'struct' || t.kind === 'union');
  const hasServices = input.generateServices && ir.services.length > 0;
  const hasEvents = input.generateEvents && ir.events.length > 0;
  switch (language) {
    case 'go': {
      const out: RuntimeSymbol[] = [];
      if (usesSets(ir)) out.push(...GO_SETS);
      if (hasServices) out.push(...GO_SERVICES);
      if (hasEvents) out.push(...GO_EVENTS);
      return out;
    }
    case 'rust': {
      const out: RuntimeSymbol[] = [];
      if (structs) out.push(...RUST_STRUCTS);
      if (hasServices) out.push(...RUST_SERVICES);
      if (hasEvents) out.push(...RUST_EVENTS);
      for (const kind of ['email', 'url', 'uuid'] as const) {
        if (usesConstraint(ir, kind)) out.push(...RUST_CONSTRAINTS[kind]!);
      }
      return out;
    }
    case 'typescript': {
      const out: RuntimeSymbol[] = [];
      if (usesSets(ir)) out.push(...TS_SETS);
      if (hasServices) out.push(...TS_SERVICES);
      if (hasEvents) out.push(...TS_EVENTS);
      return out;
    }
    case 'python': {
      const out: RuntimeSymbol[] = [];
      if (hasServices) out.push(...PYTHON_SERVICES);
      if (hasEvents) out.push(...PYTHON_EVENTS);
      return out;
    }
    case 'java': {
      const out: RuntimeSymbol[] = [];
      if (composites) out.push({ name: 'BridgeJson', where: 'BridgeJson.java (JSON runtime)' });
      if (structs || hasEvents) {
        out.push({ name: 'BridgeValidation', where: 'BridgeValidation.java (validators)' });
      }
      if (structs) out.push({ name: 'RoundTripTest', where: 'src/test/.../RoundTripTest.java' });
      if (hasEvents) out.push({ name: 'BridgeEvents', where: 'BridgeEvents.java (envelope)' });
      return out;
    }
    case 'csharp': {
      const out: RuntimeSymbol[] = [];
      if (composites) out.push({ name: 'BridgeJson', where: 'Models.cs (JSON helpers)' });
      if (structs || hasEvents) {
        out.push({ name: 'BridgeValidation', where: 'Validation.cs (validators)' });
      }
      if (structs) out.push({ name: 'RoundTripTest', where: 'RoundTripTest.cs' });
      if (hasEvents) out.push({ name: 'BridgeEvents', where: 'Events.cs (envelope)' });
      return out;
    }
  }
}

/**
 * Fails when a USER type/event declaration is named like a symbol the
 * generator itself emits at package/module scope for the TARGET language.
 * Each language checks ONLY its own table (`BridgeJson` stays legal in the
 * backends that never emit that symbol); the IR has no type-level rename
 * mechanism, so the only safe fix is renaming the declaration in the
 * contract — the diagnostic says exactly that.
 */
export function assertNoRuntimeCollisions(input: GeneratorInput): void {
  const pkg = input.packageName;
  const ir = input.ir;
  const language = input.language;
  const declarations: { name: string; kind: string }[] = [
    ...ir.types.map((t) => ({ name: t.name, kind: 'type' })),
    ...(input.generateEvents ? ir.events.map((e) => ({ name: e.name, kind: 'event' })) : []),
  ];
  const declared = new Map<string, string>();
  for (const d of declarations) {
    if (!declared.has(d.name)) declared.set(d.name, d.kind);
  }
  if (declared.size === 0) return;

  for (const symbol of runtimeSymbols(language, ir, input)) {
    const kind = declared.get(symbol.name);
    if (kind === undefined) continue;
    throw new GenerationCollisionError(
      `${pkg}: ${language} generator: user ${kind} '${symbol.name}' collides with the reserved generated ` +
        `runtime symbol '${symbol.name}' (${symbol.where}). The generated ${language} output declares the ` +
        `same package-level name, which would shadow or duplicate it. Rename the ${kind} in the contract ` +
        `(the IR has no type-level rename mechanism); generation failed instead of emitting broken code.`,
    );
  }
}

/**
 * Entry point wired into `generate`: fails generation with an actionable
 * `GenerationCollisionError` for every collision class the naming tables
 * cannot resolve automatically, checked for the TARGET language only
 * (issue #116).
 */
export function assertNoCollisions(input: GeneratorInput): void {
  assertNoRuntimeCollisions(input);
  assertNoRenderedCollisions(input);
}
