/**
 * Naming utilities for the Bridge generators.
 *
 * All functions are pure and deterministic: identical input always yields
 * identical output. They handle the three concerns that every language
 * backend needs:
 *
 * 1. Case conversion (snake_case -> CamelCase / PascalCase / camelCase).
 * 2. Go initialism expansion (id -> ID, api -> API, ...).
 * 3. Keyword collision handling per language (Rust `r#type`, TS `type_`,
 *    Python `from_`).
 */

/** Initialisms that Go style guides require to stay all-caps. */
const GO_INITIALISMS: ReadonlySet<string> = new Set([
  'id',
  'api',
  'url',
  'uri',
  'http',
  'https',
  'json',
  'sql',
  'uuid',
  'tcp',
  'udp',
  'ip',
  'rpc',
  'cpu',
  'db',
  'tls',
  'ssh',
  'ok',
]);

/** Go reserved words that could collide with a *lowercase* identifier. */
const GO_KEYWORDS: ReadonlySet<string> = new Set([
  'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else',
  'fallthrough', 'for', 'func', 'go', 'goto', 'if', 'import', 'interface',
  'map', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type',
  'var',
]);

/**
 * Exported Go method names generated on struct types. Fields and methods
 * share the selector namespace in Go, so a field whose exported name equals
 * a generated method (Validate on every struct from validate.go) would
 * make the emitted accessor and the method declaration collide
 * ("field and method with the same name"). Escaped with the same
 * trailing-underscore strategy as the other backends; the JSON tag keeps
 * the declared wire name.
 */
const GO_RESERVED_MEMBERS: ReadonlySet<string> = new Set(['Validate']);

/**
 * Rust keywords that require escaping when used as identifiers.
 * `self`, `Self`, `super` and `crate` cannot be raw identifiers, so they
 * fall back to the trailing-underscore strategy.
 */
const RUST_RAW_KEYWORDS: ReadonlySet<string> = new Set([
  'abstract', 'as', 'async', 'await', 'become', 'box', 'break', 'const',
  'continue', 'do', 'dyn', 'else', 'enum', 'extern', 'false', 'final', 'fn',
  'for', 'gen', 'if', 'impl', 'in', 'let', 'loop', 'macro', 'match', 'mod',
  'move', 'mut', 'override', 'priv', 'pub', 'ref', 'return', 'static',
  'struct', 'trait', 'true', 'try', 'type', 'typeof', 'union', 'unsafe',
  'unsized', 'use', 'virtual', 'where', 'while', 'yield',
]);

const RUST_NON_RAW_KEYWORDS: ReadonlySet<string> = new Set([
  'self', 'Self', 'super', 'crate',
]);

/** Python reserved keywords (Python 3.12 keyword list). */
export const PYTHON_KEYWORDS: ReadonlySet<string> = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break',
  'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally',
  'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal',
  'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
  'match', 'case',
]);

/**
 * TypeScript reserved words that Bridge escapes with a trailing underscore
 * in generated interfaces/members. Property names are legal in modern TS,
 * but escaping keeps generated code usable in destructuring patterns and
 * older targets; the wire name is preserved via a `@wireName` JSDoc tag.
 */
const TS_RESERVED_WORDS: ReadonlySet<string> = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false',
  'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new',
  'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try',
  'typeof', 'var', 'void', 'while', 'with', 'type', 'interface', 'let',
  'package', 'private', 'protected', 'public', 'static', 'yield', 'await',
  'implements', 'readonly', 'namespace', 'module', 'declare', 'abstract',
]);

/** Splits a snake_case identifier into its parts. */
export function snakeParts(name: string): string[] {
  return name.split('_').filter((part) => part.length > 0);
}

/** Capitalizes a single word: `currency` -> `Currency`. */
function capitalize(word: string): string {
  if (word.length === 0) return word;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** `order_id` -> `OrderId` (without initialism expansion). */
export function pascalCase(name: string): string {
  return snakeParts(name).map(capitalize).join('');
}

/** `SCREAMING_SNAKE` -> `ScreamingSnake`. */
export function pascalFromScreaming(name: string): string {
  return name
    .split('_')
    .filter((part) => part.length > 0)
    .map((part) => capitalize(part.toLowerCase()))
    .join('');
}

/** `ScreamingSnake` -> `SCREAMING_SNAKE`. */
export function screamingSnakeFromPascal(name: string): string {
  const parts = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/\s+/)
    .filter((part) => part.length > 0);
  return parts.map((part) => part.toUpperCase()).join('_');
}

/**
 * Go exported field name from a snake_case wire name, with initialism
 * expansion: `user_id` -> `UserID`, `api_key` -> `APIKey`,
 * `http_url` -> `HTTPURL`, `json_body` -> `JSONBody`.
 * Each part is expanded independently (`payment_id` -> `PaymentID`).
 */
export function goExportedName(snake: string): string {
  const exported = snakeParts(snake)
    .map((part) => {
      const lower = part.toLowerCase();
      if (GO_INITIALISMS.has(lower)) return lower.toUpperCase();
      return capitalize(part);
    })
    .join('');
  if (GO_RESERVED_MEMBERS.has(exported)) return `${exported}_`;
  return exported;
}

/**
 * Go receiver name for a type: first letter of the PascalCase name,
 * lowercased (`Money` -> `m`, `Order` -> `o`).
 */
export function goReceiver(typeName: string): string {
  const first = typeName.charAt(0);
  return first ? first.toLowerCase() : 'x';
}

/** Rust identifier for a field name, handling keyword collisions. */
export function rustFieldName(snake: string): { name: string; rename?: string } {
  if (RUST_RAW_KEYWORDS.has(snake)) {
    return { name: `r#${snake}`, rename: snake };
  }
  if (RUST_NON_RAW_KEYWORDS.has(snake)) {
    return { name: `${snake}_`, rename: snake };
  }
  return { name: snake };
}

/** Rust variant identifier for an enum variant declared name. */
export function rustVariantName(declared: string): string {
  return pascalFromScreaming(declared);
}

/**
 * Returns `true` when serde's `rename_all = "SCREAMING_SNAKE_CASE"` already
 * reproduces the declared wire name, i.e. no explicit per-variant rename
 * attribute is required.
 */
export function serdeRenameAllMatches(declared: string): boolean {
  return screamingSnakeFromPascal(rustVariantName(declared)) === declared;
}

/**
 * Names that generated Python *members* must not collide with, beyond true
 * keywords. Struct and event-payload dataclasses emit `to_dict`, `from_dict`
 * and `validate` methods, and the from_dict decoders use fixed parameter/
 * local names (`raw_data` for the wire dict, `raw_value` for the per-field
 * temp, `out` for the to_dict accumulator, `self` for the receiver). A field
 * sharing one of these names would shadow a generated method (a field named
 * `validate` makes `m.validate()` raise TypeError: 'str' object is not
 * callable) or clobber a decoder variable (a field named `data` rewrites the
 * from_dict parameter, so the next `data.get(...)` raises AttributeError).
 * Escaped with the same trailing-underscore mechanism as keywords; the wire
 * name keeps the declared form via the returned `wire` value.
 */
export const PYTHON_RESERVED_MEMBERS: ReadonlySet<string> = new Set([
  'self',
  'data',
  'raw',
  'out',
  'to_dict',
  'from_dict',
  'validate',
  'raw_data',
  'raw_value',
]);

/** Python identifier for a field name, handling keyword collisions. */
export function pythonFieldName(snake: string): { name: string; wire: string } {
  if (PYTHON_KEYWORDS.has(snake) || PYTHON_RESERVED_MEMBERS.has(snake)) {
    return { name: `${snake}_`, wire: snake };
  }
  return { name: snake, wire: snake };
}

/**
 * Python enum member name for a declared variant name. Enum members are
 * emitted verbatim (SCREAMING_SNAKE wire values) except for true keywords
 * and the reserved member table: a variant named `pass` would otherwise
 * emit `pass = "pass"` inside the class body, a SyntaxError in the whole
 * module. The wire value stays the declared name; only the member identifier
 * gets a trailing underscore.
 */
export function pythonEnumMemberName(variant: string): { name: string; wire: string } {
  if (PYTHON_KEYWORDS.has(variant) || PYTHON_RESERVED_MEMBERS.has(variant)) {
    return { name: `${variant}_`, wire: variant };
  }
  return { name: variant, wire: variant };
}

/**
 * Names a union dataclass declares itself (`kind`/`value` fields) plus the
 * receiver name; a snake-cased variant sharing one would shadow or produce
 * unusable methods (`def self(...)`).
 */
const PYTHON_UNION_RESERVED: ReadonlySet<string> = new Set(['self', 'kind', 'value']);

/**
 * snake_case classmethod name for a union variant name. Python keywords,
 * the union's own members and the reserved member table (so a variant named
 * TO_DICT cannot shadow the union's to_dict) are escaped with a trailing
 * underscore. Wire kind values are emitted separately and stay original.
 */
export function pythonUnionVariantMethod(variantName: string): string {
  const snake = camelToLowerSnake(variantName);
  if (
    PYTHON_KEYWORDS.has(snake) ||
    PYTHON_UNION_RESERVED.has(snake) ||
    PYTHON_RESERVED_MEMBERS.has(snake)
  ) {
    return `${snake}_`;
  }
  return snake;
}

/** Python identifier validity check (rough, ASCII-oriented). */
export function isPythonIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !PYTHON_KEYWORDS.has(name);
}

/** TypeScript member name, escaping reserved words with a trailing `_`. */
export function tsFieldName(snake: string): { name: string; wire: string; escaped: boolean } {
  if (TS_RESERVED_WORDS.has(snake)) {
    return { name: `${snake}_`, wire: snake, escaped: true };
  }
  return { name: snake, wire: snake, escaped: false };
}

/**
 * TS identifier that is safe to use for local declarations (functions,
 * constants): appends `_` for reserved words, digits-leading or empty.
 */
export function tsSafeIdent(name: string): string {
  if (name.length === 0) return '_';
  if (/^[0-9]/.test(name) || TS_RESERVED_WORDS.has(name)) return `${name}_`;
  return name;
}

/**
 * Go identifier that is safe to use for local declarations inside a
 * function (helpers, regex vars). Falls back to appending `_` on keyword
 * collisions. The result is exported-style (callers pass PascalCase input).
 */
export function goSafeIdent(name: string): string {
  if (GO_KEYWORDS.has(name)) return `${name}_`;
  return name;
}

/**
 * Java reserved words that cannot be used as identifiers. Contextual
 * keywords (`record`, `sealed`, `var`, `yield`, `permits`) are included
 * too — escaping them keeps generated code valid on older javac and
 * avoids confusion.
 */
const JAVA_KEYWORDS: ReadonlySet<string> = new Set([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char',
  'class', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum',
  'extends', 'final', 'finally', 'float', 'for', 'goto', 'if', 'implements',
  'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new',
  'package', 'private', 'protected', 'public', 'return', 'short', 'static',
  'strictfp', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws',
  'transient', 'try', 'void', 'volatile', 'while',
  'true', 'false', 'null',
  'var', 'record', 'sealed', 'yield', 'permits',
]);

/** C# reserved keywords (identifier escapes via trailing underscore). */
const CSHARP_KEYWORDS: ReadonlySet<string> = new Set([
  'abstract', 'as', 'base', 'bool', 'break', 'byte', 'case', 'catch',
  'char', 'checked', 'class', 'const', 'continue', 'decimal', 'default',
  'delegate', 'do', 'double', 'else', 'enum', 'event', 'explicit', 'extern',
  'false', 'finally', 'fixed', 'float', 'for', 'foreach', 'goto', 'if',
  'implicit', 'in', 'int', 'interface', 'internal', 'is', 'lock', 'long',
  'namespace', 'new', 'null', 'object', 'operator', 'out', 'override',
  'params', 'private', 'protected', 'public', 'readonly', 'ref', 'return',
  'sbyte', 'sealed', 'short', 'sizeof', 'stackalloc', 'static', 'string',
  'struct', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'uint',
  'ulong', 'unchecked', 'unsafe', 'ushort', 'using', 'virtual', 'void',
  'volatile', 'while',
]);

/**
 * Names that generated Java *members* must not collide with, beyond true
 * keywords. Every struct class emits `toDict()`, `fromDict(...)` and
 * `validate()` methods (and event payloads reuse the same class body), and
 * `equals`/`hashCode`/`toString` override java.lang.Object. A field sharing
 * one of these names would emit a duplicate member definition
 * ("method toDict() is already defined"). Escaped with the same
 * trailing-underscore mechanism as keywords; the wire name keeps the
 * declared form because generated Java writes JSON keys explicitly,
 * mirroring how the Rust generator renames fields and keeps a serde rename.
 */
export const JAVA_RESERVED_MEMBERS: ReadonlySet<string> = new Set([
  'toDict',
  'fromDict',
  'validate',
  'equals',
  'hashCode',
  'toString',
]);

export function javaFieldName(snake: string): { name: string; escaped: boolean } {
  const parts = snakeParts(snake);
  if (parts.length === 0) return { name: '_', escaped: false };
  let name = parts[0]!;
  for (let i = 1; i < parts.length; i++) name += capitalize(parts[i]!);
  if (JAVA_KEYWORDS.has(name) || JAVA_RESERVED_MEMBERS.has(name)) {
    return { name: `${name}_`, escaped: true };
  }
  return { name, escaped: false };
}

/**
 * Java PascalCase identifier preserving the lower-casing of remainder
 * characters (`userID` -> `Userid`, `user_id` -> `UserId`), matching the
 * getter/accessor derivation in generated classes.
 */
export function javaPascal(name: string): string {
  const parts = name.split(/[_\s]+/).filter((p) => p.length > 0);
  if (parts.length === 0) return 'Value';
  let out = '';
  for (const part of parts) {
    out += part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
  }
  return out;
}

/**
 * Getter name derived from the (possibly escaped) MEMBER name. Trailing
 * underscores of escaped members are preserved (`class_` -> `getClass_`),
 * which keeps the member->getter mapping injective and guarantees an
 * escaped keyword field can never produce the final `Object.getClass()`
 * signature. The wire name is untouched (getters are wire-neutral).
 */
export function javaGetterName(member: string): string {
  const stripped = member.replace(/_+$/, '');
  const underscores = member.slice(stripped.length);
  return `get${javaPascal(stripped)}${underscores}`;
}

/**
 * True when a derived getter name would override `Object.getClass()` or
 * spell `get<javaKeyword>` (`getInt` from a field named `Int`). Such a
 * getter either fails to compile (incompatible Object.getClass override)
 * or produces a bean accessor named after a keyword.
 */
export function javaGetterCollidesWithObjectOrKeyword(getter: string): boolean {
  if (getter === 'getClass') return true;
  if (!getter.startsWith('get') || getter.length === 3) return false;
  const stem = getter.slice(3);
  return JAVA_KEYWORDS.has(stem.charAt(0).toLowerCase() + stem.slice(1));
}

/** Java identifier that is safe for local declarations (statics, params). */
export function javaSafeIdent(name: string): string {
  if (JAVA_KEYWORDS.has(name)) return `${name}_`;
  return name;
}

/**
 * Method names generated on every C# model class (ToDict/FromDict/Validate;
 * Equals/GetHashCode override System.Object). A property sharing one of
 * these names is a duplicate member definition (CS0102). Escaped with the
 * same trailing-underscore mechanism as keywords; the wire name always
 * stays the declared snake_case name because ToDict/FromDict write JSON
 * keys explicitly.
 */
export const CSHARP_RESERVED_MEMBERS: ReadonlySet<string> = new Set([
  'ToDict',
  'FromDict',
  'Validate',
  'Equals',
  'GetHashCode',
]);

export function csharpPropertyName(snake: string): { name: string; escaped: boolean } {
  const pascal = pascalCase(snake);
  if (CSHARP_KEYWORDS.has(pascal) || CSHARP_RESERVED_MEMBERS.has(pascal)) {
    return { name: `${pascal}_`, escaped: true };
  }
  return { name: pascal, escaped: false };
}

/** C# identifier that is safe for local declarations (fields, params). */
export function csharpSafeIdent(name: string): string {
  if (CSHARP_KEYWORDS.has(name)) return `${name}_`;
  if (name.length > 0 && /^[0-9]/.test(name)) return `_${name}`;
  return name;
}

/**
 * Java package for a Bridge package: prefixed with `bridge.` to keep out
 * of the default/global package space; each dotted segment is lowercased
 * and sanitized to a legal Java identifier (`payments.v1` →
 * `bridge.payments.v1`, `2023.data` → `bridge._2023.data`).
 */
export function javaPackageName(pkg: string): string {
  const segments = pkg
    .toLowerCase()
    .split('.')
    .map((segment) => {
      let s = segment.replace(/[^a-z0-9_]/g, '');
      if (s.length === 0) s = '_';
      if (/^[0-9]/.test(s)) s = `_${s}`;
      return s;
    });
  return ['bridge', ...segments].join('.');
}

/** Dots-only path suffix for the Java package directory layout. */
export function javaPackagePath(pkg: string): string {
  return javaPackageName(pkg).split('.').join('/');
}

/**
 * C# namespace: `bridge.` prefix + one PascalCase segment per dotted part
 * (`payments.v1` → `Bridge.Payments.V1`). Illegal characters are stripped
 * and digit-leading segments get an underscore prefix.
 */
export function csharpNamespace(pkg: string): string {
  const segments = pkg
    .split('.')
    .map((segment) => {
      let s = segment.replace(/[^A-Za-z0-9_]/g, '');
      if (s.length === 0) s = '_';
      if (/^[0-9]/.test(s)) s = `_${s}`;
      return capitalize(s.charAt(0).toLowerCase() + s.slice(1));
    });
  return ['Bridge', ...segments].join('.');
}

/** .csproj / assembly name derived from the C# namespace. */
export function csharpProjectName(pkg: string): string {
  return csharpNamespace(pkg);
}

/** Package name for Go: dots -> underscores, lowercased (`payments.v1` -> `payments_v1`). */
export function goPackageName(pkg: string): string {
  return pkg.toLowerCase().replace(/\./g, '_').replace(/[^a-z0-9_]/g, '');
}

/** Crate name for Rust: dots -> dashes (`payments.v1` -> `bridge-payments-v1`). */
export function rustCrateName(pkg: string, prefix = 'bridge'): string {
  const sanitized = pkg.toLowerCase().replace(/\./g, '-').replace(/[^a-z0-9-]/g, '');
  return prefix ? `${prefix}-${sanitized}` : sanitized;
}

/** Distribution/module name for Python: `payments.v1` -> module `payments_v1`. */
export function pythonModuleName(pkg: string): string {
  return goPackageName(pkg);
}

/** npm package name: `payments.v1` -> `@generated/payments.v1`. */
export function tsPackageName(pkg: string): string {
  return `@generated/${pkg}`;
}

/**
 * Sanitized package name used in project file identifiers:
 * `payments.v1` -> `payments_v1` (go module suffix), dashed variants are
 * derived by callers via `rustCrateName`.
 */
export function sanitizedPackageName(pkg: string): string {
  return goPackageName(pkg);
}

/** Upper snake case identifier, used for constant names (`Money_amount` -> `MONEY_AMOUNT`). */
export function upperSnake(...parts: string[]): string {
  return parts
    .flatMap((part) => snakeParts(part))
    .map((part) => part.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase())
    .filter((part) => part.length > 0)
    .join('_');
}

/** Service method name -> snake_case client method (`CreatePayment` -> `create_payment`). */
/** `OrderPlaced` → `ORDER_PLACED` — SCREAMING_SNAKE for generated constants. */
export function camelToScreamingSnake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toUpperCase();
}

export function camelToLowerSnake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

/** Service method name -> camelCase client method (`CreatePayment` -> `createPayment`). */
export function pascalToCamel(name: string): string {
  if (name.length === 0) return name;
  return name.charAt(0).toLowerCase() + name.slice(1);
}
