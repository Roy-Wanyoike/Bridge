/**
 * Type mapping tables and reference rendering for the Bridge generators.
 *
 * The canonical Bridge -> target-language mapping is documented in the
 * {@link PRIMITIVE_MAPPINGS} table below. Highlights and deliberate
 * decisions (also surfaced in generated file headers/docs):
 *
 * - `int64`/`uint64` map to `number` in TypeScript: values above 2^53 lose
 *   precision (documented caveat in generated JSDoc). Go/Rust/Python keep
 *   full width (int64/i64/int). Java maps both to `long` (uint32 too: int
 *   cannot hold the full unsigned range; uint64 values are written/read via
 *   the unsigned helpers). C# maps int32/int64 to int/long and
 *   uint32/uint64 to uint/ulong (exact unsigned range; note these are
 *   non-CLS-compliant types, which the generated assemblies accept).
 * - `uuid`, `timestamp` and `decimal` map to strings everywhere. Java and
 *   C# deliberately keep `timestamp` as String/string (RFC 3339
 *   passthrough): a structured java.time.OffsetDateTime /
 *   System.DateTimeOffset would re-normalize the wire text (e.g. dropping
 *   zero seconds) and break byte-parity with the other targets. java.time
 *   is still used for RFC 3339 validation helpers in generated Java.
 *   Decimals are strings to avoid binary-float drift.
 * - `json` maps to `json.RawMessage` / `serde_json::Value` / `unknown` /
 *   `Any` / `Object` (Java) / `System.Text.Json.JsonElement` (C#).
 * - `bytes` maps to `[]byte` / `Vec<u8>` / `Uint8Array` / `bytes`. On the
 *   JSON wire, bytes are base64 strings; Python `from_dict`/`to_dict`
 *   convert, Go uses `[]byte`'s native base64 JSON encoding.
 * - `set<T>` maps to `Set[T]struct{}` (Go generic wrapper, marshals to a
 *   JSON array), `BTreeSet<T>` (serializes as an array), `Set<T>` (TS) and
 *   `set` (Python). The wire format is ALWAYS a JSON array; generated
 *   languages include `set_to_array`/`array_to_set` (and Go/TS/Rust
 *   equivalents) converters documented next to the types.
 * - `map<K,V>` maps to `map[K]V` / `BTreeMap<K,V>` / `Record<K,V>` /
 *   `dict`. Rust uses `BTreeMap` for deterministic key ordering.
 * - Cross-package named references become opaque aliases of the raw JSON
 *   shape with a doc comment "imported from <pkg>; regenerate with that
 *   package for full types" (Go `= json.RawMessage`, Rust
 *   `= serde_json::Value`, TS `= unknown`, Python `= Any`, Java `Object`,
 *   C# `JsonElement`). They always compile and keep output deterministic.
 *   Java/C# have no cross-file type aliases, so local alias declarations
 *   are substituted by their underlying type everywhere instead (see the
 *   per-generator headers).
 * - Optional fields map to `*T` / `Option<T>` / `field?: T` /
 *   `field: T | None = None` / `Optional<T>` (Java) / `T?` (C#).
 * - `@pattern` is compiled as a user regex in every backend: Go/TS/Python
 *   with the language's regex facility, Java/C# with per-field compiled
 *   constants, Rust with the `regex` crate (RE2-family, added to the
 *   generated Cargo.toml only when needed). A pattern the Rust regex crate
 *   cannot compile fails Rust generation with a BR2020 diagnostic — never
 *   a silent skip.
 */

import type { IRPackage, IRTypeDefinition, PrimitiveKind, TypeRef } from '@bridge/core';
import { csharpPropertyName, goExportedName, javaFieldName, rustFieldName, tsFieldName } from './naming';

/** The six supported target languages. */
export type TargetLanguage = 'go' | 'rust' | 'typescript' | 'python' | 'java' | 'csharp';

/** Rendering style for a field name in a given language. */
export interface FieldNameRender {
  /** Identifier to use in the generated declaration. */
  readonly name: string;
  /** Wire (JSON) name, always the declared snake_case name. */
  readonly wire: string;
  /** True when the identifier had to be escaped/renamed. */
  readonly escaped: boolean;
}

/** Renders a field name for the given language. */
export function renderFieldName(language: TargetLanguage, snake: string): FieldNameRender {
  switch (language) {
    case 'go':
      // Go exports fields; json tags keep the snake_case wire name.
      return { name: goExportedName(snake), wire: snake, escaped: false };
    case 'rust': {
      const rust = rustFieldName(snake);
      return { name: rust.name, wire: snake, escaped: rust.rename !== undefined };
    }
    case 'typescript': {
      const ts = tsFieldName(snake);
      return { name: ts.name, wire: ts.wire, escaped: ts.escaped };
    }
    case 'python': {
      // `type` and other builtins are legal field names in Python; only
      // true keywords need escaping.
      return { name: snake, wire: snake, escaped: false };
    }
    case 'java': {
      const java = javaFieldName(snake);
      return { name: java.name, wire: snake, escaped: java.escaped };
    }
    case 'csharp': {
      const cs = csharpPropertyName(snake);
      return { name: cs.name, wire: snake, escaped: cs.escaped };
    }
  }
}

/** How a primitive renders in each language, plus doc notes. */
export interface PrimitiveMapping {
  readonly go: string;
  readonly rust: string;
  readonly typescript: string;
  readonly python: string;
  readonly java: string;
  readonly csharp: string;
  /** Short human description used in generated docs. */
  readonly note: string;
}

/**
 * The canonical primitive mapping table. Order matches `PrimitiveKind`.
 */
export const PRIMITIVE_MAPPINGS: Readonly<Record<PrimitiveKind, PrimitiveMapping>> = {
  string: {
    go: 'string', rust: 'String', typescript: 'string', python: 'str',
    java: 'String', csharp: 'string',
    note: 'UTF-8 string',
  },
  bool: {
    go: 'bool', rust: 'bool', typescript: 'boolean', python: 'bool',
    java: 'boolean', csharp: 'bool',
    note: 'boolean',
  },
  int32: {
    go: 'int32', rust: 'i32', typescript: 'number', python: 'int',
    java: 'int', csharp: 'int',
    note: 'signed 32-bit integer',
  },
  int64: {
    go: 'int64', rust: 'i64', typescript: 'number', python: 'int',
    java: 'long', csharp: 'long',
    note: 'signed 64-bit integer; TS numbers lose precision above 2^53',
  },
  uint32: {
    go: 'uint32', rust: 'u32', typescript: 'number', python: 'int',
    java: 'long', csharp: 'uint',
    note: 'unsigned 32-bit integer (Java maps to long: int cannot hold the full unsigned range)',
  },
  uint64: {
    go: 'uint64', rust: 'u64', typescript: 'number', python: 'int',
    java: 'long', csharp: 'ulong',
    note: 'unsigned 64-bit integer; TS numbers lose precision above 2^53',
  },
  float32: {
    go: 'float32', rust: 'f32', typescript: 'number', python: 'float',
    java: 'float', csharp: 'float',
    note: '32-bit float',
  },
  float64: {
    go: 'float64', rust: 'f64', typescript: 'number', python: 'float',
    java: 'double', csharp: 'double',
    note: '64-bit float',
  },
  bytes: {
    go: '[]byte', rust: 'Vec<u8>', typescript: 'Uint8Array', python: 'bytes',
    java: 'byte[]', csharp: 'byte[]',
    note: 'binary; base64 string on the JSON wire',
  },
  uuid: {
    go: 'string', rust: 'String', typescript: 'string', python: 'str',
    java: 'String', csharp: 'string',
    note: 'UUID string (8-4-4-4-12 hex)',
  },
  timestamp: {
    go: 'string', rust: 'String', typescript: 'string', python: 'str',
    java: 'String', csharp: 'string',
    note: 'RFC 3339 timestamp string (no chrono/datetime dependency)',
  },
  decimal: {
    go: 'string', rust: 'String', typescript: 'string', python: 'str',
    java: 'String', csharp: 'string',
    note: 'decimal encoded as string to avoid float drift',
  },
  json: {
    go: 'json.RawMessage', rust: 'serde_json::Value', typescript: 'unknown', python: 'Any',
    java: 'Object', csharp: 'System.Text.Json.JsonElement',
    note: 'arbitrary JSON value',
  },
};

/** Primitive kinds that render as strings in every language. */
export const STRING_LIKE_PRIMITIVES: ReadonlySet<PrimitiveKind> = new Set([
  'string', 'uuid', 'timestamp', 'decimal',
]);

/** Primitive kinds that render as numbers in TS / numeric in Go+Rust. */
export const NUMERIC_PRIMITIVES: ReadonlySet<PrimitiveKind> = new Set([
  'int32', 'int64', 'uint32', 'uint64', 'float32', 'float64',
]);

/** Primitive kinds that render as integers (no fractional part). */
export const INTEGER_PRIMITIVES: ReadonlySet<PrimitiveKind> = new Set([
  'int32', 'int64', 'uint32', 'uint64',
]);

/** Context passed to the reference renderer. */
export interface RenderContext {
  readonly language: TargetLanguage;
  /** Dotted name of the package being generated. */
  readonly packageName: string;
  /** Local type names, used to resolve same-package references. */
  readonly localTypeNames: ReadonlySet<string>;
  /**
   * Local alias declarations (`type OrderId = uuid`). Languages without
   * type aliases (Java, C#) substitute the underlying type everywhere;
   * all other languages keep the alias as a real declaration and ignore
   * this table.
   */
  readonly aliasTargets?: ReadonlyMap<string, TypeRef>;
}

/**
 * Resolves a named reference. Local refs render as the type name;
 * cross-package refs render as the (aliased) type name as well — the
 * generator emits an opaque alias for every cross-package name that does
 * not collide with a local type, so both cases render identically here.
 *
 * In Java/C# local aliases do not exist as declarations: the underlying
 * target type is rendered instead (see {@link RenderContext.aliasTargets}).
 */
function namedRefName(ref: { name: string; package?: string }, ctx: RenderContext): string {
  if (ctx.aliasTargets !== undefined && (ctx.language === 'java' || ctx.language === 'csharp')) {
    const target = ctx.aliasTargets.get(ref.name);
    if (target !== undefined) return renderTypeRef(target, ctx);
    // Java/C# have no opaque alias declarations: cross-package references
    // become passthrough values (Object / JsonElement) instead.
    if (
      ref.package !== undefined &&
      ref.package !== ctx.packageName &&
      !ctx.localTypeNames.has(ref.name)
    ) {
      return ctx.language === 'java' ? 'Object' : 'System.Text.Json.JsonElement';
    }
  }
  // Same-package references and cross-package opaque aliases both render
  // as the bare type name. When a local type shares the name with a
  // cross-package reference, the local type wins (deterministic, and the
  // compiler rejects ambiguous contracts).
  return ref.name;
}

/**
 * True when the reference points at a type from another package (and that
 * name is not declared locally). Java/C# render such fields as opaque JSON
 * passthrough values (`Object` / `JsonElement`); Go/Rust/TS/Python emit
 * opaque alias declarations for them instead.
 */
export function isOpaqueCrossPackageRef(
  ref: TypeRef,
  ctx: RenderContext,
  ir: IRPackage,
): boolean {
  let inner = ref;
  if (inner.kind === 'optional') inner = inner.inner;
  if (inner.kind !== 'named') return false;
  if (inner.package === undefined || inner.package === ctx.packageName) return false;
  return !ir.types.some((t) => t.name === inner.name);
}

/** Renders a TypeRef for the target language. */
export function renderTypeRef(ref: TypeRef, ctx: RenderContext): string {
  switch (ref.kind) {
    case 'primitive':
      return primitiveType(ref.primitive, ctx.language);
    case 'named':
      return namedRefName(ref, ctx);
    case 'list':
      return listType(ref.element, ctx);
    case 'set':
      return setType(ref.element, ctx);
    case 'map':
      return mapType(ref.key, ref.value, ctx);
    case 'optional':
      return optionalType(ref.inner, ctx);
  }
}

/** Renders the primitive for the language. */
export function primitiveType(primitive: PrimitiveKind, language: TargetLanguage): string {
  const mapping = PRIMITIVE_MAPPINGS[primitive];
  switch (language) {
    case 'go': return mapping.go;
    case 'rust': return mapping.rust;
    case 'typescript': return mapping.typescript;
    case 'python': return mapping.python;
    case 'java': return mapping.java;
    case 'csharp': return mapping.csharp;
  }
}

/** `list<T>` -> `[]T` / `Vec<T>` / `T[]` / `list[T]`. */
export function listType(element: TypeRef, ctx: RenderContext): string {
  const inner = renderTypeRef(element, ctx);
  switch (ctx.language) {
    case 'go': return `[]${inner}`;
    case 'rust': return `Vec<${inner}>`;
    case 'typescript': return `${inner}[]`;
    case 'python': return `list[${inner}]`;
    case 'java': return `List<${boxedJava(inner)}>`;
    case 'csharp': return `List<${inner}>`;
  }
}

/**
 * Boxes a Java primitive type name for use inside generics (`int` →
 * `Integer`, `long` → `Long`, ...). Other names pass through unchanged.
 */
export function boxedJava(name: string): string {
  switch (name) {
    case 'int': return 'Integer';
    case 'long': return 'Long';
    case 'float': return 'Float';
    case 'double': return 'Double';
    case 'boolean': return 'Boolean';
    default: return name;
  }
}

/**
 * `set<T>` -> `Set[T]struct{}`-style Go wrapper / `BTreeSet<T>` / `Set<T>` /
 * `set[T]`. Wire format is always a JSON array; see the module docs.
 */
export function setType(element: TypeRef, ctx: RenderContext): string {
  const inner = renderTypeRef(element, ctx);
  switch (ctx.language) {
    case 'go': return `Set[${inner}]`;
    case 'rust': return `BTreeSet<${inner}>`;
    case 'typescript': return `Set<${inner}>`;
    case 'python': return `set[${inner}]`;
    case 'java': return `Set<${boxedJava(inner)}>`;
    case 'csharp': return `HashSet<${inner}>`;
  }
}

/**
 * `map<K,V>` -> `map[K]V` / `BTreeMap<K,V>` / `Record<K,V>` / `dict[K, V]`.
 * JSON object keys are always strings; non-string key primitives (uuid,
 * timestamp, ...) render with their string mapping on the wire and stay
 * typed via the value type.
 */
export function mapType(key: TypeRef, value: TypeRef, ctx: RenderContext): string {
  const k = renderTypeRef(mapKeyRef(key), ctx);
  const v = renderTypeRef(value, ctx);
  switch (ctx.language) {
    case 'go': return `map[${k}]${v}`;
    case 'rust': return `BTreeMap<${k}, ${v}>`;
    case 'typescript': return `Record<${k}, ${v}>`;
    case 'python': return `dict[${k}, ${v}]`;
    case 'java': return `Map<String, ${boxedJava(v)}>`;
    case 'csharp': return `Dictionary<string, ${v}>`;
  }
}

/**
 * Map keys are JSON object keys, hence strings. When the IDL declares a
 * string-like key (string/uuid/timestamp/decimal) the natural mapping is
 * used; other primitives degrade to their string rendering in Go/TS/Rust
 * and to `str` in Python so the generated code always compiles.
 */
function mapKeyRef(key: TypeRef): TypeRef {
  if (key.kind === 'primitive' && !STRING_LIKE_PRIMITIVES.has(key.primitive)) {
    return { kind: 'primitive', primitive: 'string' };
  }
  if (key.kind === 'named') return { kind: 'primitive', primitive: 'string' };
  return key;
}

/**
 * Optional wrapper. TS optional-ness is expressed at the field level, so
 * the wrapper renders as the inner type there; Go uses a pointer, Rust
 * `Option<T>`, Python `T | None`.
 */
export function optionalType(inner: TypeRef, ctx: RenderContext): string {
  const t = renderTypeRef(inner, ctx);
  switch (ctx.language) {
    case 'go': return `*${t}`;
    case 'rust': return `Option<${t}>`;
    case 'typescript': return t;
    case 'python': return `${t} | None`;
    case 'java': return `Optional<${boxedJava(t)}>`;
    case 'csharp': return `${t}?`;
  }
}

/**
 * Finds a local type by name. Used by generators to decide whether nested
 * validators can be called and which types are structs.
 */
export function findLocalType(
  ir: IRPackage,
  name: string,
): IRTypeDefinition | undefined {
  return ir.types.find((t) => t.name === name);
}

/**
 * True when the reference points at a struct declared in this package.
 * Used to decide whether nested `.validate()` calls can be generated.
 */
export function isLocalStructRef(ref: TypeRef, ir: IRPackage): boolean {
  if (ref.kind !== 'named') return false;
  if (ref.package !== undefined && ref.package !== ir.name) return false;
  const local = findLocalType(ir, ref.name);
  return local !== undefined && local.kind === 'struct';
}

/**
 * True when the reference points at an enum declared in this package.
 */
export function isLocalEnumRef(ref: TypeRef, ir: IRPackage): boolean {
  if (ref.kind !== 'named') return false;
  if (ref.package !== undefined && ref.package !== ir.name) return false;
  const local = findLocalType(ir, ref.name);
  return local !== undefined && local.kind === 'enum';
}

/**
 * Renders the zero value / empty literal for a field type, used by
 * constructors and decode helpers (Go only).
 *
 * Named references resolve through the local alias table first: Go
 * composite literals are only legal for struct/array/map/slice types, so
 * an alias to a primitive (`type OrderId = uuid`) must contribute the
 * primitive zero value (`""`), never `OrderId{}`.
 */
export function goZeroValue(ref: TypeRef, ctx: RenderContext): string {
  switch (ref.kind) {
    case 'primitive': {
      const p = ref.primitive;
      if (STRING_LIKE_PRIMITIVES.has(p)) return '""';
      if (p === 'bool') return 'false';
      if (p === 'json') return 'nil';
      return '0';
    }
    case 'named': {
      const aliasTarget = ctx.aliasTargets?.get(ref.name);
      if (aliasTarget !== undefined) return goZeroValue(aliasTarget, ctx);
      return `${namedRefName(ref, ctx)}{}`;
    }
    case 'list':
    case 'set':
      return 'nil';
    case 'map':
      return 'nil';
    case 'optional':
      return 'nil';
  }
}

/**
 * Default-value literal rendering.
 *
 * IR keeps `default` as the raw text written in the IDL (e.g. `0`,
 * `"normal"`, possibly quoted). This helper normalizes it into a literal
 * that is valid in the target language, or returns `undefined` when the
 * default cannot be rendered safely (generators then fall back to a
 * doc-comment note only).
 */
export function defaultLiteral(
  defaultValue: string,
  ref: TypeRef,
  language: TargetLanguage,
): string | undefined {
  const raw = defaultValue.trim();
  if (raw.length === 0) return undefined;

  // Strip one layer of matching quotes if present.
  let inner = raw;
  if (
    (inner.startsWith('"') && inner.endsWith('"') && inner.length >= 2) ||
    (inner.startsWith("'") && inner.endsWith("'") && inner.length >= 2)
  ) {
    inner = inner.slice(1, -1);
  }

  const isStringLike =
    ref.kind === 'primitive' && STRING_LIKE_PRIMITIVES.has(ref.primitive);
  const isNumeric = ref.kind === 'primitive' && NUMERIC_PRIMITIVES.has(ref.primitive);
  const isBool = ref.kind === 'primitive' && ref.primitive === 'bool';

  const numeric = /^[+-]?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(inner);

  if (isBool) {
    if (inner === 'true') return language === 'python' ? 'True' : 'true';
    if (inner === 'false') return language === 'python' ? 'False' : 'false';
    return undefined;
  }
  if (isNumeric) {
    if (!numeric) return undefined;
    return inner;
  }
  if (isStringLike) {
    // JSON.stringify is deterministic for plain strings.
    return JSON.stringify(inner);
  }
  // bytes/json and composite types: no literal support in v1.
  return undefined;
}
