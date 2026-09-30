/**
 * AST for the Bridge IDL — the parser's output before IR lowering.
 *
 * Every node carries a 1-based source position so diagnostics and tooling
 * can point at exact locations. The AST deliberately preserves source-level
 * detail that the canonical IR normalizes away (constraint arguments as
 * written, string-vs-raw defaults, optional markers in either position).
 *
 * AST→IR conversion (see `compiler/compile.ts`) strips all positions.
 */

import type { PrimitiveKind } from './ir/types';

/** 1-based source position of a node. */
export interface SourcePos {
  line: number;
  column: number;
}

/**
 * All primitive kinds, derived from an exhaustive record so that adding a
 * primitive to the frozen IR union forces this table to be updated.
 */
const PRIMITIVE_RECORD: Record<PrimitiveKind, true> = {
  string: true,
  bool: true,
  int32: true,
  int64: true,
  uint32: true,
  uint64: true,
  float32: true,
  float64: true,
  bytes: true,
  uuid: true,
  timestamp: true,
  decimal: true,
  json: true,
};

/** Every primitive type name accepted by the IDL. */
export const PRIMITIVES: readonly PrimitiveKind[] = Object.keys(
  PRIMITIVE_RECORD,
) as PrimitiveKind[];

/** Set form of {@link PRIMITIVES} for O(1) lookups. */
export const PRIMITIVE_SET: ReadonlySet<string> = new Set(PRIMITIVES);

/**
 * Primitives allowed as map keys: `string`, `bool`, `int32`, `int64`,
 * `uint32`, `uint64` and `uuid`. Floats, bytes, timestamps, decimals and
 * `json` are unordered or unhashable and are rejected as keys.
 */
export const MAP_KEY_PRIMITIVES: ReadonlySet<string> = new Set([
  'string',
  'bool',
  'int32',
  'int64',
  'uint32',
  'uint64',
  'uuid',
]);

/** Primitives accepted by the `@min` / `@max` numeric constraints. */
export const NUMERIC_PRIMITIVES: ReadonlySet<string> = new Set([
  'int32',
  'int64',
  'uint32',
  'uint64',
  'float32',
  'float64',
  'decimal',
]);

/** Constraint kinds accepted by the IDL (`@kind(args)`). */
export const CONSTRAINT_KINDS: ReadonlySet<string> = new Set([
  'min',
  'max',
  'length',
  'email',
  'url',
  'pattern',
  'uuid',
]);

// ---------------------------------------------------------------------------
// Type expressions
// ---------------------------------------------------------------------------

export interface PrimitiveTypeNode {
  kind: 'primitive';
  primitive: PrimitiveKind;
  line: number;
  column: number;
}

/**
 * A reference to a named type. Dotted references such as
 * `identity.v1.User` are split: `package` holds every segment except the
 * last; single-segment references have no `package`.
 */
export interface NamedTypeNode {
  kind: 'named';
  name: string;
  package?: string;
  line: number;
  column: number;
}

export interface ListTypeNode {
  kind: 'list';
  element: TypeNode;
  line: number;
  column: number;
}

export interface SetTypeNode {
  kind: 'set';
  element: TypeNode;
  line: number;
  column: number;
}

export interface MapTypeNode {
  kind: 'map';
  key: TypeNode;
  value: TypeNode;
  line: number;
  column: number;
}

/**
 * Optional wrapper, produced by a trailing `?` on a type expression
 * (e.g. `uuid?` in an alias target or `Money?` inside `map<K, V?>`).
 * For struct/union/event fields the parser also records the marker on
 * {@link FieldNode.optional}; IR lowering unwraps the top-level wrapper.
 */
export interface OptionalTypeNode {
  kind: 'optional';
  inner: TypeNode;
  line: number;
  column: number;
}

/** Placeholder for a type expression that failed to parse. */
export interface ErrorTypeNode {
  kind: 'error';
  line: number;
  column: number;
}

export type TypeNode =
  | PrimitiveTypeNode
  | NamedTypeNode
  | ListTypeNode
  | SetTypeNode
  | MapTypeNode
  | OptionalTypeNode
  | ErrorTypeNode;

/** Render a type expression back to IDL syntax (used in diagnostics). */
export function typeToText(t: TypeNode): string {
  switch (t.kind) {
    case 'primitive':
      return t.primitive;
    case 'named':
      return t.package !== undefined ? `${t.package}.${t.name}` : t.name;
    case 'list':
      return `list<${typeToText(t.element)}>`;
    case 'set':
      return `set<${typeToText(t.element)}>`;
    case 'map':
      return `map<${typeToText(t.key)}, ${typeToText(t.value)}>`;
    case 'optional':
      return `${typeToText(t.inner)}?`;
    case 'error':
      return '<error>';
  }
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

/** One constraint argument, kept exactly as written in the source. */
export interface ConstraintArgNode {
  /** Argument text: decoded string content, or the raw number/identifier. */
  text: string;
  /** True when the argument was a quoted string literal. */
  isString: boolean;
}

/** A `@kind(arg, ...)` validation constraint attached to a field. */
export interface ConstraintNode {
  /** Constraint kind as written, e.g. `length`. */
  kindName: string;
  args: ConstraintArgNode[];
  line: number;
  column: number;
}

/** A `= default` value on a field, kept as written. */
export interface DefaultValueNode {
  /** Decoded string content or the raw number/identifier text. */
  text: string;
  /** True when the default was a quoted string literal. */
  isString: boolean;
}

/** A field of a struct, a member of a union, or a field of an event. */
export interface FieldNode {
  name: string;
  type: TypeNode;
  /** True when the field was written with `?` (before the colon or after the type). */
  optional: boolean;
  /** `@`-constraints in source order (excluding `@deprecated`). */
  constraints: ConstraintNode[];
  /** `@deprecated` / `@deprecated("msg")` on the field, if any. */
  deprecated?: string | true;
  /** `= default` value, if any. */
  defaultValue?: DefaultValueNode;
  /** Attached `///` doc comment lines joined with newlines. */
  docs?: string;
  line: number;
  column: number;
}

/** A unit variant of an enum. */
export interface VariantNode {
  name: string;
  deprecated?: string | true;
  docs?: string;
  line: number;
  column: number;
}

/** An RPC method of a service. */
export interface MethodNode {
  name: string;
  input: TypeNode;
  output: TypeNode;
  deprecated?: string | true;
  docs?: string;
  line: number;
  column: number;
}

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

export interface StructDeclNode {
  decl: 'struct';
  name: string;
  fields: FieldNode[];
  deprecated?: string | true;
  docs?: string;
  line: number;
  column: number;
}

export interface EnumDeclNode {
  decl: 'enum';
  name: string;
  variants: VariantNode[];
  deprecated?: string | true;
  docs?: string;
  line: number;
  column: number;
}

export interface UnionDeclNode {
  decl: 'union';
  name: string;
  members: FieldNode[];
  deprecated?: string | true;
  docs?: string;
  line: number;
  column: number;
}

export interface AliasDeclNode {
  decl: 'alias';
  name: string;
  target: TypeNode;
  deprecated?: string | true;
  docs?: string;
  line: number;
  column: number;
}

export type TypeDeclNode =
  | StructDeclNode
  | EnumDeclNode
  | UnionDeclNode
  | AliasDeclNode;

export interface ServiceDeclNode {
  decl: 'service';
  name: string;
  methods: MethodNode[];
  docs?: string;
  line: number;
  column: number;
}

export interface EventDeclNode {
  decl: 'event';
  name: string;
  fields: FieldNode[];
  docs?: string;
  line: number;
  column: number;
}

export type TopLevelDeclNode = TypeDeclNode | ServiceDeclNode | EventDeclNode;

/** True when the declaration introduces a *type* (not a service or event). */
export function isTypeDecl(d: TopLevelDeclNode): d is TypeDeclNode {
  return d.decl === 'struct' || d.decl === 'enum' || d.decl === 'union' || d.decl === 'alias';
}

/** The `package payments.v1` header. */
export interface PackageDeclNode {
  name: string;
  /** Doc comment attached to the package statement (package-level docs). */
  docs?: string;
  line: number;
  column: number;
}

/** An `import some.package` statement. */
export interface ImportDeclNode {
  name: string;
  /**
   * Doc comment written above the import, if any. Kept on the AST (and
   * re-emitted by the formatter above the `import` line) so docs above
   * `import` are neither dropped nor misattributed to the following
   * declaration. The canonical IR keeps `imports` as bare dotted names
   * (frozen `IRPackage.imports: string[]` contract), so import docs
   * deliberately end at the AST boundary — consistent with this module's
   * design: the AST preserves source-level detail the IR normalizes away.
   */
  docs?: string;
  line: number;
  column: number;
}

/** The parsed representation of a whole Bridge file. */
export interface BridgeFileNode {
  package?: PackageDeclNode;
  imports: ImportDeclNode[];
  decls: TopLevelDeclNode[];
}
