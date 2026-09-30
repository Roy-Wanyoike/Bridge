/**
 * Semantic analysis for the Bridge IDL.
 *
 * Runs after parsing over the best-effort AST and validates everything the
 * grammar cannot express: name resolution (with did-you-mean hints), duplicate
 * declarations, package/import hygiene, alias cycles, method signatures, map
 * key restrictions, optional-element restrictions and constraint
 * applicability. It also emits style warnings so `bridge check` can nudge
 * authors toward the canonical naming conventions without failing builds.
 *
 * The analyzer never throws: every problem becomes a diagnostic with a stable
 * `BR2xxx` code, a file/line/column position and, where actionable, a hint.
 *
 * Diagnostic codes (stable — registry and CLI surface them):
 * - BR2001 unknown type reference (errors, with did-you-mean hint when close)
 * - BR2002 duplicate top-level declaration name — within a kind, or across
 *   kinds (type/event/service share one namespace)
 * - BR2003 duplicate field / union-member name
 * - BR2004 duplicate enum variant name
 * - BR2005 duplicate method name
 * - BR2006 duplicate import
 * - BR2007 package statement problems (missing; parser reuses the code for
 *   placement/duplicates)
 * - BR2008 invalid package/import name (must be dotted lowercase identifier)
 * - BR2009 alias definition cycle
 * - BR2010 method input/output must be a named struct reference
 * - BR2011 map key must be a hashable primitive
 * - BR2012 optional wrapper on a list/set element
 * - BR2013 constraint not applicable to the field type
 * - BR2014 unknown constraint kind (emitted by the parser; listed here to
 *   keep the family documented in one place)
 * - BR2015 unknown imported package (compilePackage with dependencies)
 * - BR2016 constraint argument shape/arity (per constraint kind)
 * - BR2017 recursive struct (self-reference outside optional/list/set/map)
 * - BR2018 @pattern uses regex syntax unsupported by Go's regexp (RE2)
 * - BR2019 set element type is not hashable/orderable
 * - BR2101 type name not PascalCase (warning)
 * - BR2102 enum variant not SCREAMING_SNAKE_CASE (warning)
 * - BR2103 field name not snake_case (warning)
 */

import type { Diagnostic, IRPackage, IRTypeDefinition, PrimitiveKind } from './ir/types';
import {
  CONSTRAINT_KINDS,
  MAP_KEY_PRIMITIVES,
  NUMERIC_PRIMITIVES,
  PRIMITIVES,
  PRIMITIVE_SET,
  isTypeDecl,
  typeToText,
  type AliasDeclNode,
  type BridgeFileNode,
  type ConstraintArgNode,
  type ConstraintNode,
  type EnumDeclNode,
  type FieldNode,
  type NamedTypeNode,
  type ServiceDeclNode,
  type SetTypeNode,
  type StructDeclNode,
  type TypeDeclNode,
  type TypeNode,
} from './ast';

/** Stable diagnostic codes emitted by semantic analysis. */
export const SEMANTIC_CODES = {
  unknownType: 'BR2001',
  duplicateDeclaration: 'BR2002',
  duplicateField: 'BR2003',
  duplicateEnumVariant: 'BR2004',
  duplicateMethod: 'BR2005',
  duplicateImport: 'BR2006',
  packageStatement: 'BR2007',
  invalidDottedName: 'BR2008',
  aliasCycle: 'BR2009',
  methodSignature: 'BR2010',
  invalidMapKey: 'BR2011',
  optionalCollectionElement: 'BR2012',
  constraintNotApplicable: 'BR2013',
  unknownConstraint: 'BR2014',
  unknownImport: 'BR2015',
  constraintArgs: 'BR2016',
  recursiveType: 'BR2017',
  patternNotRE2: 'BR2018',
  setElement: 'BR2019',
  typeNameStyle: 'BR2101',
  enumVariantStyle: 'BR2102',
  fieldNameStyle: 'BR2103',
} as const;

/** Internal error code used by the compiler pipeline for unexpected failures. */
export const INTERNAL_ERROR = 'BR2999';

// ---------------------------------------------------------------------------
// Constraint argument rules (BR2016)
// ---------------------------------------------------------------------------

/**
 * Positional argument shape per constraint kind. A single trailing quoted
 * string beyond the positional arguments is always a custom violation
 * message (mirrors `lowerConstraint` in compiler/compile.ts).
 */
const CONSTRAINT_ARG_RULES: Readonly<Record<string, { min: number; max: number; shape: 'number' | 'string' }>> = {
  min: { min: 1, max: 1, shape: 'number' },
  max: { min: 1, max: 1, shape: 'number' },
  length: { min: 1, max: 2, shape: 'number' },
  pattern: { min: 1, max: 1, shape: 'string' },
  email: { min: 0, max: 0, shape: 'string' },
  url: { min: 0, max: 0, shape: 'string' },
  uuid: { min: 0, max: 0, shape: 'string' },
};

/** Numeric constraint arguments: integer or decimal literals, sign allowed. */
const NUMERIC_ARG_RE = /^-?[0-9]+(\.[0-9]+)?$/;

/** Drop the trailing custom-message argument using the IR lowering rule. */
function positionalConstraintArgs(constraint: ConstraintNode): ConstraintArgNode[] {
  const rule = CONSTRAINT_ARG_RULES[constraint.kindName];
  if (rule === undefined) return constraint.args;
  const args = constraint.args;
  if (args.length > rule.min && args.length > 0) {
    const last = args[args.length - 1];
    if (last !== undefined && last.isString) return args.slice(0, -1);
  }
  return args;
}

/** Render an argument the way it was written (strings re-quoted). */
function argAsWritten(arg: ConstraintArgNode): string {
  return arg.isString ? JSON.stringify(arg.text) : `\`${arg.text}\``;
}

function describeExpectedArgs(rule: { min: number; max: number; shape: 'number' | 'string' }): string {
  const shape = rule.shape === 'number' ? 'numeric' : 'string';
  const noun = (n: number): string => `${n} ${shape} argument${n === 1 ? '' : 's'}`;
  if (rule.min === 0 && rule.max === 0) return 'no arguments';
  if (rule.min === rule.max) return `exactly ${noun(rule.min)}`;
  return `${rule.min} or ${rule.max} ${shape} arguments`;
}

// ---------------------------------------------------------------------------
// RE2 dialect check for @pattern (BR2018)
// ---------------------------------------------------------------------------

/** A regex construct found in a pattern that Go's regexp (RE2) rejects. */
export interface Re2Finding {
  /** Human-readable description of the construct, e.g. `lookahead \`(?=\``. */
  construct: string;
  /** Offset of the construct within the pattern string. */
  offset: number;
}

/** Capture names Go's regexp accepts (word characters). */
const RE2_CAPTURE_NAME_RE = /^[A-Za-z0-9_]+$/;

/**
 * Scan a pattern for constructs Go's regexp (RE2) does not support:
 * lookahead, lookbehind, atomic groups, possessive/nested repetition
 * quantifiers and backreferences. Returns the first finding, or undefined
 * when the pattern is plain RE2. Character-class aware (`[*+]` inside
 * `[...]` is a literal pair, not a possessive quantifier). Every `\1`..`\9`
 * escape is rejected (regexp/syntax parseEscape: "Single non-zero digit is a
 * backreference; not supported" — octal escapes must start with `\0`),
 * inside and outside classes alike. A trailing `?` after a quantifier is a
 * lazy quantifier (`x*?`), which RE2 supports and is not flagged.
 */
export function re2UnsupportedConstruct(pattern: string): Re2Finding | undefined {
  const n = pattern.length;
  let i = 0;
  let inClass = false;
  while (i < n) {
    const c = pattern.charAt(i);

    if (c === '\\') {
      const next = pattern.charAt(i + 1);
      // Go's regexp/syntax rejects every \1..\9 escape: a single non-zero
      // digit is a backreference (unsupported), so `\12` errors too — octal
      // escapes must start with `\0`. \8 and \9 are invalid escapes outright.
      if (next >= '1' && next <= '9') {
        return { construct: `backreference \`\\${next}\``, offset: i };
      }
      i += 2; // consume the escape pair (escaped chars are literal)
      continue;
    }

    if (!inClass && c === '[') {
      inClass = true;
      i++;
      if (pattern.charAt(i) === '^') i++; // negation — a following `]` is literal
      if (pattern.charAt(i) === ']') i++; // `[]` right after `[`/`[^` is a literal `]`
      continue;
    }
    if (inClass && c === ']') {
      inClass = false;
      i++;
      continue;
    }

    if (!inClass && c === '(' && pattern.charAt(i + 1) === '?') {
      const d = pattern.charAt(i + 2);
      if (d === '=') return { construct: 'lookahead `(?=`', offset: i };
      if (d === '!') return { construct: 'negative lookahead `(?!`', offset: i };
      if (d === '>') return { construct: 'atomic group `(?>`', offset: i };
      if (d === '<') {
        const e = pattern.charAt(i + 3);
        if (e === '=') return { construct: 'lookbehind `(?<=`', offset: i };
        if (e === '!') return { construct: 'negative lookbehind `(?<!`', offset: i };
        // Named group `(?<name>...` — validate the name is terminated.
        let j = i + 3;
        while (j < n && pattern.charAt(j) !== '>') j++;
        if (j >= n || j === i + 3) {
          return { construct: 'named capture group with an empty or unterminated name', offset: i };
        }
        i = j + 1;
        continue;
      }
      if (d === 'P') {
        const e = pattern.charAt(i + 3);
        if (e === '=') return { construct: 'capture-group call `(?P=name`', offset: i };
        if (e === '<') {
          let j = i + 4;
          while (j < n && pattern.charAt(j) !== '>') j++;
          if (j >= n) {
            return { construct: 'named capture group with an unterminated name', offset: i };
          }
          if (j === i + 4 || !RE2_CAPTURE_NAME_RE.test(pattern.slice(i + 4, j))) {
            return { construct: 'named capture group with an invalid name (use (?P<name>...) with [A-Za-z0-9_] names)', offset: i };
          }
          i = j + 1;
          continue;
        }
      }
      // Flag groups `(?i)`, `(?s)`, `(?-i)`, non-capturing `(?:...)` are RE2.
      i++;
      continue;
    }

    if (!inClass && (c === '*' || c === '+' || c === '?')) {
      const next = pattern.charAt(i + 1);
      // Possessive/nested repetition (`x*+`, `x**`, `x?+`) — RE2 rejects it.
      // A following `?` is a lazy quantifier (`x*?`), which RE2 supports.
      if (next === '*' || next === '+') {
        return { construct: `nested repetition operator \`${c}${next}\``, offset: i };
      }
    }

    i++;
  }
  return undefined;
}

/** A dotted lowercase identifier: `payments`, `payments.v1`, `a.b_c.d1`. */
const DOTTED_NAME_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

/** PascalCase for type declarations: `Money`, `PaymentStatus`, `HTTPError2`. */
const PASCAL_CASE_RE = /^[A-Z][A-Za-z0-9]*$/;

/** SCREAMING_SNAKE_CASE for enum variants: `PENDING`, `RATE_LIMIT_5XX`. */
const SCREAMING_CASE_RE = /^[A-Z][A-Z0-9_]*$/;

/** snake_case for fields: `customer_id`, `amount2`, `id`. */
const SNAKE_CASE_RE = /^[a-z][a-z0-9_]*$/;

/**
 * The three top-level declaration kinds, in the fixed order used to build
 * deterministic cross-kind collision messages (BR2002). Types, events and
 * services share one namespace: generators emit every declaration into the
 * same file/scope, so a name used by one kind may not be reused by another.
 */
const DECL_KINDS = ['type', 'event', 'service'] as const;
type DeclKind = (typeof DECL_KINDS)[number];

/** Render colliding kinds for a BR2002 message: `['type', 'event']` → `a type and an event`. */
function describeDeclKinds(kinds: readonly DeclKind[]): string {
  const phrases = kinds.map((k) => (k === 'event' ? 'an event' : `a ${k}`));
  if (phrases.length <= 1) return phrases[0] ?? '';
  const head = phrases.slice(0, -1).join(', ');
  return `${head} and ${phrases[phrases.length - 1]}`;
}

/** Options for {@link analyzeFile}. */
export interface AnalyzeOptions {
  /**
   * Already-compiled dependency packages used to resolve qualified type
   * references (`identity.v1.User`) and validate imports. When omitted
   * (`compileSource`), cross-package resolution is skipped and imports are
   * not checked for existence.
   */
  dependencies?: Map<string, IRPackage>;
}

/**
 * Analyze a parsed Bridge file.
 *
 * Diagnostics are emitted in a deterministic order: package checks first,
 * then imports in source order, then declarations in source order (with
 * per-declaration checks in field/method order), then alias-cycle findings,
 * then recursive-struct findings.
 */
export function analyzeFile(
  file: BridgeFileNode,
  filePath: string,
  options: AnalyzeOptions = {},
): Diagnostic[] {
  return new Analyzer(file, filePath, options.dependencies).run();
}

// ---------------------------------------------------------------------------

/**
 * Minimal structural shape shared by AST `TypeNode` and IR `TypeRef`, so one
 * resolver can walk both (dependency alias targets are IR TypeRefs).
 */
type ResolvableTypeRef =
  | { kind: 'primitive'; primitive: PrimitiveKind }
  | { kind: 'named'; name: string; package?: string }
  | { kind: 'list'; element: ResolvableTypeRef }
  | { kind: 'set'; element: ResolvableTypeRef }
  | { kind: 'map'; key: ResolvableTypeRef; value: ResolvableTypeRef }
  | { kind: 'optional'; inner: ResolvableTypeRef }
  | { kind: 'error' };

/** Result of resolving a constraint/set-element target type. */
type ConstraintTargetResolution =
  | { resolved: true; primitive: PrimitiveKind }
  /**
   * Struct/enum/union or composite — a constraint cannot apply and a set
   * element is not hashable. Always produces a diagnostic (no silent skip).
   */
  | { resolved: false; reason: 'not-primitive' }
  /**
   * Unknown reference (BR2001 already reported) or an opaque cross-package
   * reference in compileSource mode — checking deeper would double-report.
   */
  | { resolved: false; reason: 'unresolved-ref' };

class Analyzer {
  private readonly diags: Diagnostic[] = [];
  private readonly deps: Map<string, IRPackage> | undefined;
  /** Local type declarations by name (first declaration wins for lookups). */
  private readonly localTypes = new Map<string, TypeDeclNode>();
  /** Local type names + primitives — did-you-mean candidate pool. */
  private readonly candidateNames: string[] = [];
  private ownPackage = '';

  constructor(
    private readonly file: BridgeFileNode,
    private readonly filePath: string,
    dependencies?: Map<string, IRPackage>,
  ) {
    this.deps = dependencies;
  }

  run(): Diagnostic[] {
    this.checkPackage();
    this.checkImports();
    this.collectLocalTypes();
    this.checkDeclarations();
    this.checkAliasCycles();
    this.checkRecursiveTypes();
    return this.diags;
  }

  // ------------------------------------------------------------- plumbing

  private push(
    severity: Diagnostic['severity'],
    code: string,
    message: string,
    line: number,
    column: number,
    hint?: string,
  ): void {
    const d: Diagnostic = { severity, code, message, file: this.filePath, line, column };
    if (hint !== undefined) d.hint = hint;
    this.diags.push(d);
  }

  private error(code: string, message: string, line: number, column: number, hint?: string): void {
    this.push('error', code, message, line, column, hint);
  }

  private warning(code: string, message: string, line: number, column: number, hint?: string): void {
    this.push('warning', code, message, line, column, hint);
  }

  // ------------------------------------------------------------- package

  private checkPackage(): void {
    const pkg = this.file.package;
    if (pkg === undefined) {
      this.error(
        SEMANTIC_CODES.packageStatement,
        'Missing package statement — every Bridge file must declare its package.',
        1,
        1,
        'Add `package <name>` as the first statement, e.g. `package payments.v1`.',
      );
      return;
    }
    if (pkg.name !== '') {
      if (!DOTTED_NAME_RE.test(pkg.name)) {
        this.error(
          SEMANTIC_CODES.invalidDottedName,
          `Invalid package name \`${pkg.name}\`.`,
          pkg.line,
          pkg.column,
          'Package names are dotted lowercase identifiers: segments match [a-z][a-z0-9_]*, e.g. `payments.v1`.',
        );
      }
      this.ownPackage = pkg.name;
    }
  }

  // ------------------------------------------------------------- imports

  private checkImports(): void {
    const seen = new Set<string>();
    for (const imp of this.file.imports) {
      if (imp.name === '') continue; // parse error already reported
      if (seen.has(imp.name)) {
        this.error(
          SEMANTIC_CODES.duplicateImport,
          `Duplicate import of \`${imp.name}\`.`,
          imp.line,
          imp.column,
          'Remove the repeated import — each package may be imported at most once.',
        );
        continue;
      }
      seen.add(imp.name);
      if (!DOTTED_NAME_RE.test(imp.name)) {
        this.error(
          SEMANTIC_CODES.invalidDottedName,
          `Invalid import name \`${imp.name}\`.`,
          imp.line,
          imp.column,
          'Import names are dotted lowercase identifiers, e.g. `identity.v1`.',
        );
        continue;
      }
      if (this.deps !== undefined && !this.deps.has(imp.name)) {
        this.error(
          SEMANTIC_CODES.unknownImport,
          `Unknown imported package \`${imp.name}\`.`,
          imp.line,
          imp.column,
          'Imported packages must be compiled first and passed as dependencies to `compilePackage`.',
        );
      }
    }
  }

  // -------------------------------------------------- local type collection

  private collectLocalTypes(): void {
    // Primitive names join the did-you-mean pool so typos like `strng`
    // suggest `string`.
    this.candidateNames.push(...PRIMITIVES);
    for (const decl of this.file.decls) {
      if (!isTypeDecl(decl)) continue;
      if (!this.localTypes.has(decl.name)) {
        this.localTypes.set(decl.name, decl);
        this.candidateNames.push(decl.name);
      }
    }
  }

  // ---------------------------------------------------------- declarations

  private checkDeclarations(): void {
    const seenTypes = new Set<string>();
    const seenEvents = new Set<string>();
    const seenServices = new Set<string>();
    /** Every top-level name → the kinds already using it (cross-kind BR2002). */
    const usedByKind = new Map<string, DeclKind[]>();

    for (const decl of this.file.decls) {
      if (isTypeDecl(decl)) {
        this.checkDuplicateName(seenTypes, decl.name, 'type', decl.line, decl.column, usedByKind);
        if (!PASCAL_CASE_RE.test(decl.name)) {
          this.warning(
            SEMANTIC_CODES.typeNameStyle,
            `Type name \`${decl.name}\` is not PascalCase.`,
            decl.line,
            decl.column,
            'Bridge type names start with an uppercase letter and use no underscores, e.g. `PaymentStatus`.',
          );
        }
        switch (decl.decl) {
          case 'struct':
            this.checkFieldBody(decl.fields, `struct \`${decl.name}\``);
            break;
          case 'union':
            this.checkFieldBody(decl.members, `union \`${decl.name}\``);
            break;
          case 'enum':
            this.checkEnum(decl);
            break;
          case 'alias':
            // Type-expression checks for the alias target run here so that
            // unknown references are reported in declaration order.
            this.checkTypeExpr(decl.target);
            break;
        }
      } else if (decl.decl === 'event') {
        this.checkDuplicateName(seenEvents, decl.name, 'event', decl.line, decl.column, usedByKind);
        this.checkFieldBody(decl.fields, `event \`${decl.name}\``);
      } else {
        this.checkDuplicateName(seenServices, decl.name, 'service', decl.line, decl.column, usedByKind);
        this.checkService(decl);
      }
    }
  }

  /**
   * Duplicate-name check for one top-level declaration, covering both
   * within-kind duplicates (`type Money` twice — the original BR2002) and
   * cross-kind collisions (`type Money` + `event Money`, which generators
   * emit into the same scope — also BR2002). Each offending declaration
   * produces exactly one diagnostic; the colliding kinds are listed in the
   * fixed DECL_KINDS order so messages are deterministic regardless of the
   * order the declarations appear in.
   */
  private checkDuplicateName(
    seen: Set<string>,
    name: string,
    what: DeclKind,
    line: number,
    column: number,
    usedByKind: Map<string, DeclKind[]>,
  ): void {
    if (name === '') return; // parse error already reported
    if (seen.has(name)) {
      this.error(
        SEMANTIC_CODES.duplicateDeclaration,
        `Duplicate ${what} name \`${name}\`.`,
        line,
        column,
        `Rename one of the declarations — ${what} names must be unique within a package.`,
      );
      return;
    }
    seen.add(name);

    // Cross-kind namespace check. `seen` and `usedByKind` are updated in
    // lockstep (both on first sight of a name per kind), so `kinds` never
    // contains `what` here and within-kind duplicates never re-report.
    const kinds = usedByKind.get(name) ?? [];
    if (!kinds.includes(what)) kinds.push(what);
    usedByKind.set(name, kinds);
    const others = DECL_KINDS.filter((k) => k !== what && kinds.includes(k));
    if (others.length === 0) return;
    this.error(
      SEMANTIC_CODES.duplicateDeclaration,
      `Duplicate ${what} name \`${name}\` — ${describeDeclKinds(others)} with this name already ${others.length === 1 ? 'exists' : 'exist'}.`,
      line,
      column,
      'Rename one of the declarations — type, event and service names share one namespace within a package.',
    );
  }

  // --------------------------------------------------------------- fields

  private checkFieldBody(fields: FieldNode[], container: string): void {
    const seenFields = new Set<string>();
    for (const field of fields) {
      if (field.name === '') continue; // parse error already reported
      if (seenFields.has(field.name)) {
        this.error(
          SEMANTIC_CODES.duplicateField,
          `Duplicate field name \`${field.name}\` in ${container}.`,
          field.line,
          field.column,
          'Field names must be unique within a struct, union or event.',
        );
      } else {
        seenFields.add(field.name);
      }
      if (!SNAKE_CASE_RE.test(field.name)) {
        this.warning(
          SEMANTIC_CODES.fieldNameStyle,
          `Field name \`${field.name}\` is not snake_case.`,
          field.line,
          field.column,
          'Bridge field names are lowercase with underscores between words, e.g. `customer_id`.',
        );
      }
      this.checkTypeExpr(field.type);
      this.checkConstraints(field, container);
    }
  }

  private checkEnum(decl: EnumDeclNode): void {
    const seen = new Set<string>();
    for (const variant of decl.variants) {
      if (variant.name === '') continue; // parse error already reported
      if (seen.has(variant.name)) {
        this.error(
          SEMANTIC_CODES.duplicateEnumVariant,
          `Duplicate variant name \`${variant.name}\` in enum \`${decl.name}\`.`,
          variant.line,
          variant.column,
          'Variant names must be unique within an enum.',
        );
      } else {
        seen.add(variant.name);
      }
      if (!SCREAMING_CASE_RE.test(variant.name)) {
        this.warning(
          SEMANTIC_CODES.enumVariantStyle,
          `Enum variant \`${variant.name}\` is not SCREAMING_SNAKE_CASE.`,
          variant.line,
          variant.column,
          'Bridge enum variants are all-uppercase with underscores between words, e.g. `PAYMENT_FAILED`.',
        );
      }
    }
  }

  // ----------------------------------------------------------- type walks

  private checkTypeExpr(t: TypeNode): void {
    switch (t.kind) {
      case 'primitive':
        return;
      case 'named':
        this.checkNamedRef(t);
        return;
      case 'list':
      case 'set': {
        if (t.element.kind === 'optional') {
          this.error(
            SEMANTIC_CODES.optionalCollectionElement,
            `Optional elements are not allowed inside \`${t.kind}\` types — \`${typeToText(t)}\` is invalid.`,
            t.element.line,
            t.element.column,
            'Wrap the whole collection instead: `ids: list<string>?` means the list itself may be absent.',
          );
          this.checkTypeExpr(t.element.inner);
          return;
        }
        if (t.kind === 'set') this.checkSetElement(t);
        this.checkTypeExpr(t.element);
        return;
      }
      case 'map': {
        if (t.key.kind !== 'primitive' || !MAP_KEY_PRIMITIVES.has(t.key.primitive)) {
          this.error(
            SEMANTIC_CODES.invalidMapKey,
            `Map key type \`${typeToText(t.key)}\` is not allowed — keys must be hashable primitives.`,
            t.key.line,
            t.key.column,
            `Allowed map key types: ${[...MAP_KEY_PRIMITIVES].join(', ')}.`,
          );
        }
        this.checkTypeExpr(t.value);
        return;
      }
      case 'optional':
        this.checkTypeExpr(t.inner);
        return;
      case 'error':
        return; // parse error already reported
    }
  }

  private checkNamedRef(t: NamedTypeNode): void {
    if (t.package === undefined) {
      if (PRIMITIVE_SET.has(t.name)) return; // defensive: parser routes primitives
      if (this.localTypes.has(t.name)) return;
      this.error(
        SEMANTIC_CODES.unknownType,
        `Unknown type \`${t.name}\`.`,
        t.line,
        t.column,
        suggestionHint(t.name, this.candidateNames),
      );
      return;
    }

    // Qualified reference `pkg.Type`.
    if (t.package === this.ownPackage) {
      // Self-qualified reference to the enclosing package resolves locally.
      if (this.localTypes.has(t.name)) return;
      this.error(
        SEMANTIC_CODES.unknownType,
        `Unknown type \`${t.package}.${t.name}\`.`,
        t.line,
        t.column,
        suggestionHint(t.name, this.candidateNames),
      );
      return;
    }

    if (!this.importedPackages().has(t.package)) {
      const pkgSuggestion = didYouMean(t.package, [this.ownPackage, ...this.importedPackages()]);
      this.error(
        SEMANTIC_CODES.unknownType,
        `Unknown type \`${t.package}.${t.name}\` — package \`${t.package}\` is not imported.`,
        t.line,
        t.column,
        pkgSuggestion !== undefined
          ? `Did you mean package \`${pkgSuggestion}\`?`
          : `Add \`import ${t.package}\` below the package statement, or reference a type from an imported package.`,
      );
      return;
    }

    const depEntry = this.depTypes(t.package);
    if (depEntry === undefined) return; // no dependencies in compileSource — nothing deeper to check
    if (!depEntry.byName.has(t.name)) {
      this.error(
        SEMANTIC_CODES.unknownType,
        `Unknown type \`${t.package}.${t.name}\` — package \`${t.package}\` does not declare it.`,
        t.line,
        t.column,
        suggestionHint(t.name, depEntry.names),
      );
    }
  }

  private importedNamesCache: Set<string> | undefined;

  private importedPackages(): Set<string> {
    if (this.importedNamesCache === undefined) {
      this.importedNamesCache = new Set(this.file.imports.map((i) => i.name));
    }
    return this.importedNamesCache;
  }

  /** Per-package dependency type index (built once, shared by all refs). */
  private depTypesCache: Map<string, { names: string[]; byName: Map<string, IRTypeDefinition> }> | undefined;

  /**
   * Type index for a dependency package: the ordered name list (for
   * did-you-mean suggestions) and a name→definition map (for resolution).
   * Built once per package instead of `dep.types.map(...)`/`.find(...)` per
   * reference — references are O(1) after the first touch.
   */
  private depTypes(pkg: string): { names: string[]; byName: Map<string, IRTypeDefinition> } | undefined {
    if (this.depTypesCache === undefined) this.depTypesCache = new Map();
    let entry = this.depTypesCache.get(pkg);
    if (entry === undefined) {
      const dep = this.deps?.get(pkg);
      if (dep === undefined) return undefined;
      entry = {
        names: dep.types.map((td) => td.name),
        byName: new Map(dep.types.map((td) => [td.name, td])),
      };
      this.depTypesCache.set(pkg, entry);
    }
    return entry;
  }

  // ------------------------------------------------------------- services

  private checkService(decl: ServiceDeclNode): void {
    const seen = new Set<string>();
    for (const method of decl.methods) {
      if (method.name === '') continue; // parse error already reported
      if (seen.has(method.name)) {
        this.error(
          SEMANTIC_CODES.duplicateMethod,
          `Duplicate method name \`${method.name}\` in service \`${decl.name}\`.`,
          method.line,
          method.column,
          'Method names must be unique within a service.',
        );
      } else {
        seen.add(method.name);
      }
      this.checkMethodSignature(method.name, 'input', method.input);
      this.checkMethodSignature(method.name, 'output', method.output);
    }
  }

  private checkMethodSignature(
    methodName: string,
    what: 'input' | 'output',
    t: TypeNode,
  ): void {
    if (t.kind === 'error') return; // parse error already reported
    if (t.kind !== 'named') {
      this.error(
        SEMANTIC_CODES.methodSignature,
        `Method \`${methodName}\` ${what} must be a named struct reference, but \`${typeToText(t)}\` is not.`,
        t.line,
        t.column,
        'Declare a request/response struct and reference it by name, e.g. `CreatePayment(CreatePaymentRequest) -> Payment`.',
      );
      return;
    }
    // Resolve the named reference to a declaration and require a struct.
    // `checkNamedRef` reports unknown/unimported references first so that a
    // broken signature does not silently pass when the type is missing.
    this.checkNamedRef(t);
    const resolved = this.resolveNamed(t);
    if (resolved === undefined) return; // unknown reference already diagnosed
    if (resolved.decl !== 'struct') {
      this.error(
        SEMANTIC_CODES.methodSignature,
        `Method \`${methodName}\` ${what} \`${t.name}\` must reference a struct, but \`${t.name}\` is a ${resolved.decl}.`,
        t.line,
        t.column,
        `Change \`${t.name}\` to a struct, or wrap it in one, e.g. \`type ${t.name}Response { value: ${t.name} }\`.`,
      );
    }
  }

  /**
   * Resolve a named type reference to a local declaration or a dependency's
   * type definition rendered as a pseudo-declaration. Returns undefined when
   * the reference is unknown (already diagnosed) or not checkable here.
   */
  private resolveNamed(t: NamedTypeNode): { decl: 'struct' | 'enum' | 'union' | 'alias' } | undefined {
    if (t.package === undefined || t.package === this.ownPackage) {
      const local = this.localTypes.get(t.name);
      return local === undefined ? undefined : { decl: local.decl };
    }
    if (!this.importedPackages().has(t.package)) return undefined;
    const depType = this.depTypes(t.package)?.byName.get(t.name);
    if (depType === undefined) return undefined;
    return { decl: depType.kind };
  }

  // ---------------------------------------------------------- constraints

  private checkConstraints(field: FieldNode, container: string): void {
    for (const constraint of field.constraints) {
      if (!CONSTRAINT_KINDS.has(constraint.kindName)) continue; // parser reported BR2014
      const underlying = field.type.kind === 'optional' ? field.type.inner : field.type;
      const numeric = constraint.kindName === 'min' || constraint.kindName === 'max';
      const target = this.resolveConstraintTarget(underlying);
      if (target.resolved) {
        if (numeric && !NUMERIC_PRIMITIVES.has(target.primitive)) {
          this.error(
            SEMANTIC_CODES.constraintNotApplicable,
            `@${constraint.kindName} applies to numeric types only, but field \`${field.name}\` of ${container} has type \`${typeToText(underlying)}\`.`,
            constraint.line,
            constraint.column,
            '@min/@max support int32, int64, uint32, uint64, float32, float64 and decimal fields.',
          );
          continue;
        }
        if (!numeric && target.primitive !== 'string') {
          this.error(
            SEMANTIC_CODES.constraintNotApplicable,
            `@${constraint.kindName} applies to string fields only, but field \`${field.name}\` of ${container} has type \`${typeToText(underlying)}\`.`,
            constraint.line,
            constraint.column,
            '@length/@email/@url/@pattern/@uuid support `string` fields only.',
          );
          continue;
        }
      } else if (target.reason === 'not-primitive') {
        // The target resolves to a struct/enum/union or a composite — never
        // silently ignored: the constraint cannot apply (BR2013).
        if (numeric) {
          this.error(
            SEMANTIC_CODES.constraintNotApplicable,
            `@${constraint.kindName} applies to numeric types only, but field \`${field.name}\` of ${container} has type \`${typeToText(underlying)}\`.`,
            constraint.line,
            constraint.column,
            '@min/@max support int32, int64, uint32, uint64, float32, float64 and decimal fields.',
          );
        } else {
          this.error(
            SEMANTIC_CODES.constraintNotApplicable,
            `@${constraint.kindName} applies to string fields only, but field \`${field.name}\` of ${container} has type \`${typeToText(underlying)}\`.`,
            constraint.line,
            constraint.column,
            '@length/@email/@url/@pattern/@uuid support `string` fields only.',
          );
        }
        continue;
      } else {
        // Unresolved reference — BR2001 was already reported for it (or the
        // reference is opaque in compileSource mode); nothing deeper to add.
        continue;
      }
      this.checkConstraintArgs(constraint);
      if (constraint.kindName === 'pattern') this.checkPatternRE2(constraint);
    }
  }

  /** Validate argument count and shape for one constraint (BR2016). */
  private checkConstraintArgs(constraint: ConstraintNode): void {
    const rule = CONSTRAINT_ARG_RULES[constraint.kindName];
    if (rule === undefined) return;
    const args = positionalConstraintArgs(constraint);
    if (args.length < rule.min || args.length > rule.max) {
      this.error(
        SEMANTIC_CODES.constraintArgs,
        `@${constraint.kindName} expects ${describeExpectedArgs(rule)}, but got ${args.length}.`,
        constraint.line,
        constraint.column,
        'A single trailing quoted string is a custom violation message, e.g. `@length(3, "ISO currency codes are 3 letters")`.',
      );
      return;
    }
    const numericShape = rule.shape === 'number';
    for (const arg of args) {
      const shapeOk = numericShape ? !arg.isString && NUMERIC_ARG_RE.test(arg.text) : arg.isString;
      if (shapeOk) continue;
      this.error(
        SEMANTIC_CODES.constraintArgs,
        numericShape
          ? `@${constraint.kindName} expects a numeric argument (an unquoted number), but got ${argAsWritten(arg)}.`
          : `@${constraint.kindName} expects a quoted string argument, but got ${argAsWritten(arg)}.`,
        constraint.line,
        constraint.column,
      );
    }
  }

  /** Reject @pattern arguments that Go's regexp (RE2) cannot compile (BR2018). */
  private checkPatternRE2(constraint: ConstraintNode): void {
    const args = positionalConstraintArgs(constraint);
    const arg = args[0];
    if (arg === undefined || !arg.isString) return; // shape error already reported by BR2016
    const finding = re2UnsupportedConstruct(arg.text);
    if (finding === undefined) return;
    this.error(
      SEMANTIC_CODES.patternNotRE2,
      `@pattern ${JSON.stringify(arg.text)} uses ${finding.construct}, which Go's regexp (RE2) does not support — generated Go code would panic in regexp.MustCompile at package init.`,
      constraint.line,
      constraint.column,
      'RE2 has no lookahead/lookbehind, no backreferences and no atomic/possessive quantifiers. Rewrite the pattern using plain RE2 syntax: https://github.com/google/re2/wiki/Syntax',
    );
  }

  /** Enforce the set element rule (BR2019): hashable, orderable values only. */
  private checkSetElement(t: SetTypeNode): void {
    const target = this.resolveConstraintTarget(t.element);
    if (target.resolved) {
      if (MAP_KEY_PRIMITIVES.has(target.primitive)) return;
    } else if (target.reason === 'unresolved-ref') {
      // Unknown (BR2001 already reported) or opaque cross-package reference —
      // nothing deeper to add here.
      return;
    }
    // `!resolved && reason === 'not-primitive'` falls through: struct, enum,
    // union and composite elements ARE diagnosed (no silent skip).
    this.error(
      SEMANTIC_CODES.setElement,
      `Set element type \`${typeToText(t.element)}\` is not allowed — set elements must be hashable, canonically orderable values.`,
      t.element.line,
      t.element.column,
      'Allowed element types: string, bool, int32, int64, uint32, uint64, uuid, or an alias to one. Struct, enum, union, composite and unhashable-primitive elements make cross-language set ordering non-canonical (Rust BTreeSet needs Ord; Go sets are map[T]struct{} and need comparable keys). Use `list<T>` when you need ordering or complex elements.',
    );
  }

  /**
   * Resolve a type expression to its underlying primitive for constraint and
   * set-element checks, following local aliases and (when dependencies are
   * available) cross-package aliases. Cycle-safe.
   */
  private resolveConstraintTarget(
    t: TypeNode | ResolvableTypeRef,
  ): ConstraintTargetResolution {
    const visited = new Set<string>();
    let current: ResolvableTypeRef = t;
    for (;;) {
      switch (current.kind) {
        case 'primitive':
          return { resolved: true, primitive: current.primitive };
        case 'optional':
          current = current.inner;
          continue;
        case 'list':
        case 'set':
        case 'map':
          return { resolved: false, reason: 'not-primitive' };
        case 'error':
          return { resolved: false, reason: 'unresolved-ref' }; // parse error already reported
        case 'named': {
          const key = `${current.package ?? ''}.${current.name}`;
          if (visited.has(key)) return { resolved: false, reason: 'not-primitive' }; // alias cycle — BR2009 reports
          visited.add(key);
          if (current.package !== undefined && current.package !== this.ownPackage) {
            const depType = this.depTypes(current.package)?.byName.get(current.name);
            if (depType === undefined) return { resolved: false, reason: 'unresolved-ref' };
            if (depType.kind !== 'alias') return { resolved: false, reason: 'not-primitive' };
            current = depType.target;
            continue;
          }
          const decl = this.localTypes.get(current.name);
          if (decl === undefined) return { resolved: false, reason: 'unresolved-ref' };
          if (decl.decl !== 'alias') return { resolved: false, reason: 'not-primitive' };
          current = decl.target;
          continue;
        }
      }
    }
  }

  // --------------------------------------------------------- alias cycles

  private checkAliasCycles(): void {
    // Direct alias→alias edges among local aliases (transitive via DFS).
    const edges = new Map<string, string[]>();
    for (const [name, decl] of this.localTypes) {
      if (decl.decl !== 'alias') continue;
      const targets = new Set<string>();
      this.collectAliasTargets(decl, targets, new Set());
      edges.set(name, [...targets]);
    }

    const state = new Map<string, 0 | 1 | 2>(); // 0 = unvisited, 1 = in stack, 2 = done
    const stack: string[] = [];
    const visit = (name: string): void => {
      state.set(name, 1);
      stack.push(name);
      for (const next of edges.get(name) ?? []) {
        const s = state.get(next) ?? 0;
        if (s === 1) {
          // Cycle closes at `next`. Report once, at `next`'s declaration.
          const start = stack.indexOf(next);
          const cycle = [...stack.slice(start), next];
          const decl = this.localTypes.get(next);
          const line = decl?.line ?? 1;
          const column = decl?.column ?? 1;
          this.error(
            SEMANTIC_CODES.aliasCycle,
            `Alias \`${next}\` participates in a definition cycle: ${cycle.join(' -> ')}.`,
            line,
            column,
            'Break the cycle — Bridge aliases must resolve to a concrete type without referencing themselves.',
          );
        } else if (s === 0) {
          visit(next);
        }
      }
      stack.pop();
      state.set(name, 2);
    };

    for (const name of edges.keys()) {
      if ((state.get(name) ?? 0) === 0) visit(name);
    }
  }

  /** Collect local alias names referenced (directly) by an alias target. */
  private collectAliasTargets(
    decl: AliasDeclNode,
    out: Set<string>,
    guard: Set<TypeNode>,
  ): void {
    const walk = (t: TypeNode): void => {
      if (guard.has(t)) return; // defensive: AST nodes are acyclic
      guard.add(t);
      switch (t.kind) {
        case 'named':
          if (t.package === undefined || t.package === this.ownPackage) {
            const target = this.localTypes.get(t.name);
            if (target?.decl === 'alias') out.add(t.name);
          }
          return;
        case 'list':
        case 'set':
          walk(t.element);
          return;
        case 'map':
          walk(t.key);
          walk(t.value);
          return;
        case 'optional':
          walk(t.inner);
          return;
        default:
          return;
      }
    };
    walk(decl.target);
  }

  // -------------------------------------------------------- recursive types

  /**
   * Detect structs that directly or indirectly contain themselves through a
   * plain named field (BR2017). Self-references through `optional`, `list`,
   * `set` or `map` are allowed (protobuf-style indirection); aliases are
   * transparent edges. Cross-package references cannot participate in a
   * local cycle (the other package cannot reference this file), so they are
   * skipped.
   */
  private checkRecursiveTypes(): void {
    const state = new Map<string, 0 | 1 | 2>(); // 0 = unvisited, 1 = on stack, 2 = done
    for (const [name, decl] of this.localTypes) {
      if (decl.decl !== 'struct') continue;
      if ((state.get(name) ?? 0) !== 0) continue;
      this.visitStructForRecursion(name, decl, [], state);
    }
  }

  private visitStructForRecursion(
    name: string,
    decl: StructDeclNode,
    stack: string[],
    state: Map<string, 0 | 1 | 2>,
  ): void {
    state.set(name, 1);
    stack.push(name);
    for (const field of decl.fields) {
      if (field.type.kind === 'error') continue; // parse error already reported
      this.walkFieldForRecursion(field.type, stack, state, new Set<string>());
    }
    stack.pop();
    state.set(name, 2);
  }

  /**
   * Walk one field's type expression. Only *direct* named references create
   * recursion edges — once the walk passes through `optional`, `list`,
   * `set` or `map`, the contained types are heap/pointer represented in
   * every backend and cannot close an inline cycle, so the walk stops there.
   */
  private walkFieldForRecursion(
    t: TypeNode,
    stack: string[],
    state: Map<string, 0 | 1 | 2>,
    aliasGuard: Set<string>,
  ): void {
    switch (t.kind) {
      case 'named': {
        if (t.package !== undefined && t.package !== this.ownPackage) return; // cross-package — no local cycle
        if (PRIMITIVE_SET.has(t.name)) return;
        const decl = this.localTypes.get(t.name);
        if (decl === undefined) return; // unknown — BR2001 already reported
        if (decl.decl === 'alias') {
          if (aliasGuard.has(t.name)) return; // alias cycle — BR2009 reports
          aliasGuard.add(t.name);
          this.walkFieldForRecursion(decl.target, stack, state, aliasGuard);
          return;
        }
        if (decl.decl !== 'struct') return; // enum/union payloads — not an inline edge
        const target = t.name;
        if (state.get(target) === 1) {
          const path = [...stack, target].join(' -> ');
          this.error(
            SEMANTIC_CODES.recursiveType,
            `Recursive struct \`${target}\` — the type reaches itself via \`${path}\` without going through optional, list, set or map.`,
            t.line,
            t.column,
            `Wrap the self-reference: e.g. \`next: ${target}?\` or \`children: list<${target}>\`. Direct structural recursion generates infinitely sized values (Go: "invalid recursive type"; Rust: E0072).`,
          );
          return;
        }
        if ((state.get(target) ?? 0) === 0) {
          this.visitStructForRecursion(target, decl, stack, state);
        }
        return;
      }
      default:
        return; // optional/list/set/map break the inline cycle; primitives/errors are leaves
    }
  }
}

// ---------------------------------------------------------------------------
// Did-you-mean suggestions
// ---------------------------------------------------------------------------

/**
 * Levenshtein edit distance (insert/delete/substitute), full DP over short
 * identifier-sized strings.
 */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev: number[] = [];
  for (let j = 0; j <= n; j++) prev.push(j);
  for (let i = 1; i <= m; i++) {
    const curr: number[] = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      curr.push(Math.min(
        (prev[j] ?? 0) + 1,
        (curr[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      ));
    }
    prev = curr;
  }
  return prev[n] ?? 0;
}

/** Maximum edit distance for a did-you-mean suggestion. */
const MAX_SUGGESTION_DISTANCE = 2;

/**
 * Pick the closest candidate within {@link MAX_SUGGESTION_DISTANCE} edits,
 * or undefined when nothing is close enough. Deterministic: ties are broken
 * by alphabetical order of the candidate list.
 */
export function didYouMean(name: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestDistance = MAX_SUGGESTION_DISTANCE + 1;
  for (const candidate of [...candidates].sort()) {
    if (candidate === name) continue;
    const distance = levenshtein(name, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  if (best !== undefined && bestDistance > MAX_SUGGESTION_DISTANCE) return undefined;
  return best;
}

/** Render a did-you-mean hint, or undefined when there is no suggestion. */
export function suggestionHint(name: string, candidates: Iterable<string>): string | undefined {
  const suggestion = didYouMean(name, candidates);
  return suggestion === undefined ? undefined : `Did you mean \`${suggestion}\`?`;
}
