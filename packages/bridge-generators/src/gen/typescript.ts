/**
 * TypeScript generator.
 *
 * Emits, in order: package.json, tsconfig.json, src/types.ts, src/enums.ts,
 * src/validate.ts, src/services.ts, src/events.ts, src/index.ts. Files
 * without content are skipped (e.g. enums.ts when the package declares no
 * enums); index.ts re-exports only the modules that were actually emitted,
 * keeping the file list deterministic.
 *
 * TypeScript-specific decisions (documented in generated files too):
 * - Fields keep their snake_case wire names as member names; reserved words
 *   are escaped with a trailing underscore and keep the wire key via a
 *   `@wireName` JSDoc tag. Optional fields are `field?: T`.
 * - `int64`/`uint64` map to `number`: values above 2^53 lose precision —
 *   a documented caveat is attached to every such field.
 * - `bytes` maps to `Uint8Array`; on the JSON wire bytes are base64 strings.
 * - `set<T>` maps to `Set<T>`; the wire format is ALWAYS a JSON array in
 *   the canonical set order (numbers numeric, strings by code point,
 *   false < true — identical in all six targets, #117), so types.ts also
 *   emits `setToArray`/`arrayToSet` converters.
 * - `map<K,V>` maps to `Record<K,V>`.
 * - Tagged unions map to a discriminated union of
 *   `{ kind: '<variant>', value: <payload> }` members, matching the wire
 *   format used by Go/Rust.
 * - Enums map to a string-literal union type plus a same-named `const`
 *   object of wire values plus a `parse<Name>` helper that throws on
 *   unknown wire values.
 * - Validation is runtime-shaped: `validate<Name>(value: unknown): string[]`
 *   checks the decoded JSON object by wire key, and `is<Name>` is a type
 *   guard. Required-field presence is intentionally NOT checked (matching
 *   the Go generator's zero-value semantics); constraints and nested
 *   struct validators are.
 * - Defaults map to a `<NAME>_DEFAULTS` partial-constant factory; combine
 *   with spread: `{ ...PAYMENT_DEFAULTS, ...rest }`.
 * - Services map to a `<Service>Client` interface plus
 *   `create<Service>Client({ baseUrl, fetchImpl? })` built on `fetch`, a
 *   `<Service>ServiceHandler` interface plus a node:http-compatible request
 *   listener via `create<Service>RequestListener(handler)` (server side).
 *   POST /<package>/<Service>/<Method>; errors are thrown/returned as
 *   `BridgeRpcError` carrying the wire code and HTTP status.
 * - Events map to payload interfaces plus a CloudEvents-style envelope
 *   {specversion, id, source, type, time, data} with encode/decode
 *   helpers, per-event handler/publisher interfaces, a generic
 *   `EventPublisher`, an `InMemoryEventBus` and a `BridgeEventDispatcher`
 *   that routes decoded JSON envelopes by their `type`.
 * - Cross-package references become `export type X = unknown` opaque
 *   aliases documented as "imported from <pkg>"; modules referencing them
 *   import the alias from ./types.
 */

import type { IRField, IRService, IRTypeDefinition, IREvent, TypeRef } from '@bridge/core';
import { generatedFile } from '../util';
import { fileHeader, headerLines } from '../header';
import { docLines, tsDoc } from '../docs';
import {
  NUMERIC_PRIMITIVES,
  PRIMITIVE_MAPPINGS,
  STRING_LIKE_PRIMITIVES,
  defaultLiteral,
  findLocalType,
  isLocalEnumRef,
  isLocalStructRef,
  renderTypeRef,
} from '../mappings';
import { crossPackageRefs, sortedEvents, sortedServices, sortedTypes, usesSets } from '../analysis';
import {
  ENVELOPE_SPECVERSION,
  RPC_ERROR_CODES_SORTED,
  RPC_ERROR_STATUS,
  eventTypeName,
} from '../wire';
import {
  pascalFromScreaming,
  pascalToCamel,
  tsFieldName,
  tsPackageName,
  tsSafeIdent,
  upperSnake,
} from '../naming';
import type { GeneratedFile, GeneratorInput } from './input';

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

/** Indents a block by n spaces. */
function spaceIndent(block: string, levels = 1): string {
  const pad = ' '.repeat(2 * levels);
  return block
    .split('\n')
    .map((line) => (line.length > 0 ? pad + line : line))
    .join('\n');
}

/** Full JSDoc for a field: docs, primitive notes, default, deprecation, wireName. */
function tsFieldJSDoc(field: IRField): string {
  const lines = docLines(field.docs);
  const inner = field.type.kind === 'optional' ? field.type.inner : field.type;
  if (inner.kind === 'primitive') {
    if (inner.primitive === 'int64' || inner.primitive === 'uint64' || inner.primitive === 'bytes') {
      lines.push(`Note: ${PRIMITIVE_MAPPINGS[inner.primitive].note}.`);
    }
  }
  if (field.default !== undefined) lines.push(`Default: ${field.default}`);
  if (field.deprecated !== undefined) {
    lines.push(field.deprecated === true ? 'Deprecated.' : `Deprecated: ${field.deprecated}`);
  }
  const named = tsFieldName(field.name);
  if (named.escaped) {
    lines.push(`@wireName ${JSON.stringify(named.wire)} — JSON wire key for this field.`);
  }
  if (lines.length === 0) return '';
  return tsDoc(lines.join('\n'));
}

/** TS type for a field (TS optionality is expressed at the field level). */
function tsFieldType(field: IRField, input: GeneratorInput): string {
  return renderTypeRef(field.type, input.render);
}

/** Result of scanning refs for local named targets. */
interface LocalRefs {
  readonly types: Set<string>;
  readonly enums: Set<string>;
  /** Cross-package named refs; declared as opaque aliases in types.ts. */
  readonly opaque: Set<string>;
}

function emptyLocalRefs(): LocalRefs {
  return { types: new Set(), enums: new Set(), opaque: new Set() };
}

/** True when the named ref points at any type declared in this package. */
function isLocalType(ref: { name: string; package?: string }, input: GeneratorInput): boolean {
  if (ref.package !== undefined && ref.package !== input.ir.name) return false;
  return findLocalType(input.ir, ref.name) !== undefined;
}

function scanRef(ref: TypeRef, input: GeneratorInput, into: LocalRefs): void {
  switch (ref.kind) {
    case 'primitive':
      break;
    case 'named':
      if (isLocalEnumRef(ref, input.ir)) into.enums.add(ref.name);
      else if (isLocalType(ref, input)) into.types.add(ref.name);
      else if (
        ref.package !== undefined &&
        ref.package !== input.ir.name &&
        findLocalType(input.ir, ref.name) === undefined
      ) {
        into.opaque.add(ref.name);
      }
      break;
    case 'list':
      scanRef(ref.element, input, into);
      break;
    case 'set':
      scanRef(ref.element, input, into);
      break;
    case 'map':
      scanRef(ref.key, input, into);
      scanRef(ref.value, input, into);
      break;
    case 'optional':
      scanRef(ref.inner, input, into);
      break;
  }
}

/** Renders an import type statement for a sorted name set. */
function tsImportType(module: string, names: Iterable<string>): string | undefined {
  const sorted = [...names].sort();
  if (sorted.length === 0) return undefined;
  return `import type { ${sorted.join(', ')} } from '${module}';`;
}

/** Wraps a body with the standard file header. */
function tsFile(header: string, ...rest: string[]): string {
  return [header, ...rest].join('\n');
}

/* ------------------------------------------------------------------ */
/* package.json / tsconfig.json                                        */
/* ------------------------------------------------------------------ */

/** Deterministic 2-space JSON with trailing newline. */
function jsonFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function tsPackageJsonFile(input: GeneratorInput): GeneratedFile {
  const content = jsonFile({
    '//': headerLines(input.packageName, [
      'Bridge-generated TypeScript package; see src/ for the modules.',
    ]),
    name: tsPackageName(input.packageName),
    version: '0.1.0',
    description: `Bridge-generated TypeScript types for ${input.packageName}. Do not edit.`,
    main: 'src/index.ts',
    types: 'src/index.ts',
    sideEffects: false,
    license: 'UNLICENSED',
  });
  return generatedFile('package.json', content);
}

function tsConfigJsonFile(input: GeneratorInput): GeneratedFile {
  const content = jsonFile({
    '//': headerLines(input.packageName, ['TypeScript configuration for the generated package.']),
    compilerOptions: {
      target: 'ES2020',
      module: 'CommonJS',
      moduleResolution: 'Node',
      lib: ['ES2020'],
      declaration: true,
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
      rootDir: 'src',
      outDir: 'dist',
    },
    include: ['src/**/*.ts'],
  });
  return generatedFile('tsconfig.json', content);
}

/* ------------------------------------------------------------------ */
/* src/types.ts                                                        */
/* ------------------------------------------------------------------ */

function tsTypesFile(input: GeneratorInput): GeneratedFile | undefined {
  const types = sortedTypes(input.ir);
  const structs = types.filter((t) => t.kind === 'struct');
  const unions = types.filter((t) => t.kind === 'union');
  const aliases = types.filter((t) => t.kind === 'alias');
  const opaque = crossPackageRefs(input.ir);

  const refs = emptyLocalRefs();
  for (const type of types) {
    switch (type.kind) {
      case 'struct':
        for (const field of type.fields) scanRef(field.type, input, refs);
        break;
      case 'union':
        for (const variant of type.variants) scanRef(variant.type, input, refs);
        break;
      case 'alias':
        scanRef(type.target, input, refs);
        break;
      case 'enum':
        break;
    }
  }

  if (structs.length === 0 && unions.length === 0 && aliases.length === 0 && opaque.length === 0) {
    return undefined;
  }

  let body = '';

  for (const ref of opaque) {
    body += `${tsDoc(
      `${ref.name} is an opaque alias: imported from ${ref.fromPackage}; regenerate with that package for full types.`,
    )}\nexport type ${ref.name} = unknown;\n\n`;
  }

  for (const alias of aliases) {
    const doc = tsDoc(alias.docs, alias.deprecated);
    if (doc.length > 0) body += `${doc}\n`;
    body += `export type ${alias.name} = ${renderTypeRef(alias.target, input.render)};\n\n`;
  }

  for (const structType of structs) {
    body += tsStruct(structType as IRTypeDefinition & { kind: 'struct' }, input);
  }

  for (const union of unions) {
    body += tsUnion(union as IRTypeDefinition & { kind: 'union' }, input);
  }

  if (usesSets(input.ir)) {
    body += `${tsDoc(
      [
        'Converts a set into its JSON-array wire representation in the',
        'canonical Bridge set order: numbers ascending numerically, strings',
        'ascending by Unicode code point (UTF-8 byte order), false before',
        'true. Every Bridge target language implements the same rule, so a',
        'given set serializes to the identical array everywhere',
        '(docs/SERIALIZATION.md, canonical rule 5).',
      ].join('\n'),
    )}\nexport function setToArray<T>(value: Set<T>): T[] {\n  return Array.from(value).sort(bridgeCompareSetElements);\n}\n\n`;
    body += `${tsDoc(
      'Canonical order for two same-family set elements (see setToArray).',
    )}\nexport function bridgeCompareSetElements(a: unknown, b: unknown): number {\n`;
    body += `  if (typeof a === 'number' && typeof b === 'number') return a - b;\n`;
    body += `  if (typeof a === 'boolean' && typeof b === 'boolean') return (a ? 1 : 0) - (b ? 1 : 0);\n`;
    body += `  if (typeof a === 'string' && typeof b === 'string') return bridgeCompareCodePoints(a, b);\n`;
    body += `  return 0;\n}\n\n`;
    body += `${tsDoc(
      [
        'Code-point order for strings: matches UTF-8 byte order (the',
        'serialization canonical layer), deliberately NOT the UTF-16 code',
        'unit order of `<`, which reorders supplementary characters.',
      ].join('\n'),
    )}\nfunction bridgeCompareCodePoints(a: string, b: string): number {\n`;
    body += `  const ca = Array.from(a);\n`;
    body += `  const cb = Array.from(b);\n`;
    body += `  const n = Math.min(ca.length, cb.length);\n`;
    body += `  for (let i = 0; i < n; i++) {\n`;
    body += `    const x = ca[i]!.codePointAt(0)!;\n`;
    body += `    const y = cb[i]!.codePointAt(0)!;\n`;
    body += `    if (x !== y) return x - y;\n`;
    body += `  }\n`;
    body += `  return ca.length - cb.length;\n}\n\n`;
    body += `${tsDoc(
      'Converts a JSON-array wire representation into a Set.',
    )}\nexport function arrayToSet<T>(values: readonly T[]): Set<T> {\n  return new Set(values);\n}\n\n`;
  }

  for (const structType of structs) {
    const defaults = tsDefaultsConst(structType as IRTypeDefinition & { kind: 'struct' }, input);
    if (defaults !== undefined) body += defaults;
  }

  const header = tsFile(
    fileHeader('typescript', input.packageName),
    '',
    tsDoc('Type declarations generated from the Bridge package.'),
  );
  const importStatement = tsImportType('./enums', refs.enums);
  const parts = [header];
  if (importStatement !== undefined) parts.push('', importStatement);
  parts.push('', body.trimEnd(), '');
  return generatedFile('src/types.ts', parts.join('\n'));
}

function tsStruct(
  struct: IRTypeDefinition & { kind: 'struct' },
  input: GeneratorInput,
): string {
  let out = '';
  const doc = tsDoc(struct.docs, struct.deprecated);
  if (doc.length > 0) out += `${doc}\n`;
  out += `export interface ${struct.name} {\n`;
  for (const field of struct.fields) {
    const fieldDoc = tsFieldJSDoc(field);
    if (fieldDoc.length > 0) out += `${spaceIndent(fieldDoc)}\n`;
    const suffix = field.optional ? '?' : '';
    out += `  ${tsFieldName(field.name).name}${suffix}: ${tsFieldType(field, input)};\n`;
  }
  out += '}\n\n';
  return out;
}

function tsUnion(
  union: IRTypeDefinition & { kind: 'union' },
  input: GeneratorInput,
): string {
  let out = '';
  const docLinesOut = [
    ...docLines(union.docs),
    `Tagged union. Wire format: {"kind": "<variant>", "value": <payload>}.`,
  ];
  const doc = tsDoc(docLinesOut.join('\n'), union.deprecated);
  if (doc.length > 0) out += `${doc}\n`;
  out += `export type ${union.name} =\n`;
  union.variants.forEach((variant, index) => {
    const bar = '  |';
    out += `${bar} { kind: ${JSON.stringify(variant.name)}; value: ${renderTypeRef(variant.type, input.render)} }\n`;
  });
  out += ';\n\n';
  return out;
}

/** `<NAME>_DEFAULTS` partial constant when the struct has renderable defaults. */
function tsDefaultsConst(
  struct: IRTypeDefinition & { kind: 'struct' },
  input: GeneratorInput,
): string | undefined {
  const entries: string[] = [];
  for (const field of struct.fields) {
    if (field.default === undefined) continue;
    const literal = defaultLiteral(field.default, field.type, 'typescript');
    if (literal === undefined) continue;
    entries.push(`  ${tsFieldName(field.name).name}: ${literal},`);
  }
  if (entries.length === 0) return undefined;
  let out = `${tsDoc(
    `Bridge-declared defaults for ${struct.name} fields. Combine with required input via spread: { ...${upperSnake(struct.name)}_DEFAULTS, ...rest }.`,
  )}\n`;
  out += `export const ${upperSnake(struct.name)}_DEFAULTS: Partial<${struct.name}> = {\n`;
  out += `${entries.join('\n')}\n`;
  out += '};\n\n';
  return out;
}

/* ------------------------------------------------------------------ */
/* src/enums.ts                                                        */
/* ------------------------------------------------------------------ */

function tsEnumsFile(input: GeneratorInput): GeneratedFile | undefined {
  const enums = sortedTypes(input.ir).filter((t) => t.kind === 'enum');
  if (enums.length === 0) return undefined;

  let body = '';
  for (const enumType of enums) {
    body += tsEnum(enumType as IRTypeDefinition & { kind: 'enum' });
  }

  const parts = [
    fileHeader('typescript', input.packageName),
    '',
    tsDoc('Enum declarations generated from the Bridge package.'),
    '',
    body.trimEnd(),
    '',
  ];
  return generatedFile('src/enums.ts', parts.join('\n'));
}

function tsEnum(enumType: IRTypeDefinition & { kind: 'enum' }): string {
  let out = '';
  const doc = tsDoc(enumType.docs, enumType.deprecated);
  if (doc.length > 0) out += `${doc}\n`;
  out += `export type ${enumType.name} =\n`;
  enumType.variants.forEach((variant) => {
    const bar = '  |';
    out += `${bar} ${JSON.stringify(variant.name)}\n`;
  });
  out += ';\n\n';

  out += `${tsDoc(`Wire values for the ${enumType.name} variants.`)}\n`;
  out += `export const ${enumType.name} = {\n`;
  for (const variant of enumType.variants) {
    const vdoc = tsDoc(variant.docs, variant.deprecated);
    if (vdoc.length > 0) out += `${spaceIndent(vdoc)}\n`;
    out += `  ${pascalFromScreaming(variant.name)}: ${JSON.stringify(variant.name)},\n`;
  }
  out += '} as const;\n\n';

  const parse = `parse${enumType.name}`;
  out += `${tsDoc(
    `Parses the wire representation into a ${enumType.name}; throws on unknown values.`,
  )}\n`;
  out += `export function ${parse}(value: string): ${enumType.name} {\n`;
  out += `  switch (value) {\n`;
  for (const variant of enumType.variants) {
    out += `    case ${JSON.stringify(variant.name)}:\n`;
    out += `      return ${enumType.name}.${pascalFromScreaming(variant.name)};\n`;
  }
  out += `  }\n`;
  out += `  throw new Error(\`unknown ${enumType.name} value: \${value}\`);\n`;
  out += `}\n\n`;
  return out;
}

/* ------------------------------------------------------------------ */
/* src/validate.ts                                                     */
/* ------------------------------------------------------------------ */

/** Shared regex constant name for a per-field pattern. */
function tsPatternConst(typeName: string, fieldName: string): string {
  return `${upperSnake(typeName, fieldName)}_RE`;
}

function tsValidateFile(input: GeneratorInput): GeneratedFile | undefined {
  const structs = sortedTypes(input.ir).filter((t) => t.kind === 'struct');
  if (structs.length === 0) return undefined;

  const usesEmail = input.ir.types.some((t) =>
    t.kind === 'struct' &&
    t.fields.some((f) => f.constraints.some((c) => c.kind === 'email')),
  );
  const usesURL = input.ir.types.some((t) =>
    t.kind === 'struct' &&
    t.fields.some((f) => f.constraints.some((c) => c.kind === 'url')),
  );
  const usesUUID = input.ir.types.some((t) =>
    t.kind === 'struct' &&
    t.fields.some((f) => f.constraints.some((c) => c.kind === 'uuid')),
  );

  let body = '';
  const prelude: string[] = [];
  if (usesEmail) {
    prelude.push(`const BRIDGE_EMAIL_RE = new RegExp(${JSON.stringify('^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$')});`);
  }
  if (usesURL) {
    prelude.push(`const BRIDGE_URL_RE = new RegExp(${JSON.stringify('^https?://\\S+$')});`);
  }
  if (usesUUID) {
    prelude.push(
      `const BRIDGE_UUID_RE = new RegExp(${JSON.stringify(
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
      )});`,
    );
  }

  for (const structType of structs) {
    body += tsValidateStruct(structType as IRTypeDefinition & { kind: 'struct' }, input, prelude);
  }

  const header = tsFile(
    fileHeader('typescript', input.packageName),
    '',
    tsDoc(
      [
        'Runtime constraint validation generated from the Bridge @constraint annotations.',
        'Validators operate on the decoded JSON object (wire keys) and return one',
        'message per violation; required-field presence is intentionally not',
        'checked, matching the Go generator semantics.',
      ].join('\n'),
    ),
  );

  const importStatement = tsImportType(
    './types',
    structs.map((s) => s.name),
  );
  const parts = [header, ''];
  if (importStatement !== undefined) parts.push(importStatement, '');
  if (prelude.length > 0) parts.push(...prelude, '');
  parts.push(body.trimEnd(), '');
  return generatedFile('src/validate.ts', parts.join('\n'));
}

function tsValidateStruct(
  struct: IRTypeDefinition & { kind: 'struct' },
  input: GeneratorInput,
  prelude: string[],
): string {
  let checks = '';
  let nested = '';

  for (const field of struct.fields) {
    // Validator locals are __bridge_-prefixed: field names like value,
    // obj or errors would otherwise redeclare the function's own locals
    // (value/obj/errors) and fail tsc with duplicate declarations.
    const local = `__bridge_${tsSafeIdent(field.name)}`;
    checks += `  const ${local} = obj[${JSON.stringify(field.name)}];\n`;
    for (const constraint of field.constraints) {
      const rendered = tsConstraintCheck(constraint, field, local, struct, prelude);
      if (rendered !== undefined) checks += rendered;
    }
    let ref: TypeRef = field.type;
    if (ref.kind === 'optional') ref = ref.inner;
    if (ref.kind !== 'named') continue;
    if (ref.package !== undefined && ref.package !== input.ir.name) continue;
    const localType = findLocalType(input.ir, ref.name);
    if (localType === undefined || localType.kind !== 'struct') continue;
    const validator = `validate${ref.name}`;
    nested += `  if (${local} !== undefined && ${local} !== null) {\n`;
    nested += `    for (const message of ${validator}(${local})) {\n`;
    nested += `      errors.push(\`${field.name}.\${message}\`);\n`;
    nested += `    }\n`;
    nested += `  }\n`;
  }

  let out = '';
  const docLinesOut = [
    `Validates the constraints declared on ${struct.name} in the Bridge contract.`,
    'Returns one message per violation; an empty array means the value is valid.',
  ];
  out += `${tsDoc(docLinesOut.join('\n'))}\n`;
  out += `export function validate${struct.name}(value: unknown): string[] {\n`;
  out += `  const errors: string[] = [];\n`;
  out += `  if (typeof value !== 'object' || value === null || Array.isArray(value)) {\n`;
  out += `    return [${JSON.stringify(`${struct.name}: expected object`)}];\n`;
  out += `  }\n`;
  out += `  const obj = value as { [key: string]: unknown };\n`;
  out += checks;
  out += nested;
  out += `  return errors;\n`;
  out += `}\n\n`;

  out += `${tsDoc(`Type guard: true when value satisfies every ${struct.name} constraint.`)}\n`;
  out += `export function is${struct.name}(value: unknown): value is ${struct.name} {\n`;
  out += `  return validate${struct.name}(value).length === 0;\n`;
  out += `}\n\n`;
  return out;
}

function tsConstraintCheck(
  constraint: { kind: string; args: string[]; message?: string },
  field: IRField,
  local: string,
  struct: IRTypeDefinition & { kind: 'struct' },
  prelude: string[],
): string | undefined {
  const fallback = (text: string): string => constraint.message ?? text;
  const unwrap = (ref: TypeRef): TypeRef => (ref.kind === 'optional' ? ref.inner : ref);
  const inner = unwrap(field.type);
  const isNumeric = inner.kind === 'primitive' && NUMERIC_PRIMITIVES.has(inner.primitive);
  const isStringLike = inner.kind === 'primitive' && STRING_LIKE_PRIMITIVES.has(inner.primitive);

  const push = (message: string): string =>
    `    errors.push(${JSON.stringify(`${field.name}: ${message}`)});\n`;

  switch (constraint.kind) {
    case 'min':
    case 'max': {
      if (!isNumeric) return undefined;
      const arg = constraint.args[0] ?? '';
      const op = constraint.kind === 'min' ? '<' : '>';
      const text = fallback(constraint.kind === 'min' ? `must be >= ${arg}` : `must be <= ${arg}`);
      return `  if (typeof ${local} === 'number' && ${local} ${op} ${arg}) {\n${push(text)}  }\n`;
    }
    case 'length': {
      if (!isStringLike) return undefined;
      const arg = constraint.args[0] ?? '';
      const text = fallback(`must be exactly ${arg} characters`);
      return `  if (typeof ${local} === 'string' && ${local}.length !== ${arg}) {\n${push(text)}  }\n`;
    }
    case 'email': {
      if (!isStringLike) return undefined;
      const text = fallback('must be a valid email address');
      return `  if (typeof ${local} === 'string' && !BRIDGE_EMAIL_RE.test(${local})) {\n${push(text)}  }\n`;
    }
    case 'url': {
      if (!isStringLike) return undefined;
      const text = fallback('must be a valid URL');
      return `  if (typeof ${local} === 'string' && !BRIDGE_URL_RE.test(${local})) {\n${push(text)}  }\n`;
    }
    case 'uuid': {
      if (!isStringLike) return undefined;
      const text = fallback('must be a valid UUID');
      return `  if (typeof ${local} === 'string' && !BRIDGE_UUID_RE.test(${local})) {\n${push(text)}  }\n`;
    }
    case 'pattern': {
      if (!isStringLike) return undefined;
      const arg = constraint.args[0] ?? '';
      const constName = tsPatternConst(struct.name, field.name);
      if (!prelude.some((line) => line.startsWith(`const ${constName} `))) {
        prelude.push(`const ${constName} = new RegExp(${JSON.stringify(arg)});`);
      }
      const text = fallback(`must match pattern ${arg}`);
      return `  if (typeof ${local} === 'string' && !${constName}.test(${local})) {\n${push(text)}  }\n`;
    }
    default:
      return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* src/services.ts                                                     */
/* ------------------------------------------------------------------ */

function tsServicesFile(input: GeneratorInput): GeneratedFile | undefined {
  if (!input.generateServices) return undefined;
  const services = sortedServices(input.ir);
  if (services.length === 0) return undefined;

  const refs = emptyLocalRefs();
  for (const service of services) {
    for (const method of service.methods) {
      scanRef(method.input, input, refs);
      scanRef(method.output, input, refs);
    }
  }

  // Server-side request validators: one per method whose input is a local
  // struct (validate.ts emits validate<Type> for every local struct).
  const validators = new Map<string, string>();
  for (const service of services) {
    for (const method of service.methods) {
      const ref = method.input.kind === 'optional' ? method.input.inner : method.input;
      if (ref.kind === 'named' && isLocalStructRef(ref, input.ir)) {
        validators.set(`${service.name}.${method.name}`, ref.name);
      }
    }
  }

  let body = '';
  body += tsRpcBlock();

  for (const service of services) {
    body += tsService(service, input);
    body += tsServiceListener(service, input, validators);
  }

  const header = tsFile(
    fileHeader('typescript', input.packageName),
    '',
    tsDoc('JSON-over-HTTP clients and server adapters generated from the Bridge package.'),
  );
  const imports: string[] = [];
  const typeImport = tsImportType('./types', [...refs.types, ...refs.opaque]);
  if (typeImport !== undefined) imports.push(typeImport);
  const validatorImports = [...new Set(validators.values())].sort();
  if (validatorImports.length > 0) {
    imports.push(
      `import { ${validatorImports.map((name) => `validate${name}`).join(', ')} } from './validate';`,
    );
  }
  const parts = [header];
  if (imports.length > 0) parts.push('', imports.join('\n'));
  parts.push('', body.trimEnd(), '');
  return generatedFile('src/services.ts', parts.join('\n'));
}

/**
 * Shared RPC block: BridgeRpcError, the code→status mapping and the
 * structural node:http request/response types used by the server adapters
 * (keeps the generated package free of @types/node).
 */
function tsRpcBlock(): string {
  let out = '';
  out += `${tsDoc(
    'Minimal structural fetch type; keeps the generated package independent of DOM lib types.',
  )}\n`;
  out += `export type FetchLike = (\n`;
  out += `  input: string,\n`;
  out += `  init?: {\n`;
  out += `    method?: string;\n`;
  out += `    headers?: Record<string, string>;\n`;
  out += `    body?: string;\n`;
  out += `  },\n`;
  out += `) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;\n\n`;
  out += `${tsDoc(
    'Error thrown by generated clients and understood by generated servers;\ncarries the HTTP status and the Bridge wire error code.',
  )}\n`;
  out += `export class BridgeRpcError extends Error {\n`;
  out += `  readonly status: number;\n`;
  out += `  readonly code: string;\n\n`;
  out += `  constructor(status: number, code: string, message: string) {\n`;
  out += `    super(\`bridge rpc \${code} (status \${status}): \${message}\`);\n`;
  out += `    this.name = 'BridgeRpcError';\n`;
  out += `    this.status = status;\n`;
  out += `    this.code = code;\n`;
  out += `  }\n}\n\n`;
  out += `${tsDoc('Maps a Bridge RPC error code to its canonical HTTP status; unknown codes map to 500.')}\n`;
  out += `export function bridgeStatusForCode(code: string): number {\n`;
  out += `  switch (code) {\n`;
  for (const code of RPC_ERROR_CODES_SORTED) {
    out += `    case ${JSON.stringify(code)}: return ${RPC_ERROR_STATUS[code]};\n`;
  }
  out += `    default: return 500;\n`;
  out += `  }\n}\n\n`;

  out += `${tsDoc(
    'Minimal structural node:http types; keeps the generated package independent\nof @types/node. The listener returned by create<Service>RequestListener is\ndirectly usable with http.createServer.',
  )}\n`;
  out += `export interface BridgeNodeHttpRequest {\n`;
  out += `  method?: string | undefined;\n`;
  out += `  url?: string | undefined;\n`;
  out += `  headers: { [header: string]: string | string[] | undefined };\n`;
  out += `  on(eventName: 'data', listener: (chunk: unknown) => void): unknown;\n`;
  out += `  on(eventName: 'end', listener: () => void): unknown;\n`;
  out += `  on(eventName: 'error', listener: (error: Error) => void): unknown;\n`;
  out += `}\n\n`;
  out += `export interface BridgeNodeHttpResponse {\n`;
  out += `  statusCode?: number | undefined;\n`;
  out += `  setHeader(name: string, value: string): void;\n`;
  out += `  end(body?: string): void;\n`;
  out += `}\n\n`;
  out += `export type BridgeNodeRequestListener = (\n`;
  out += `  request: BridgeNodeHttpRequest,\n`;
  out += `  response: BridgeNodeHttpResponse,\n`;
  out += `) => Promise<void> | void;\n\n`;

  out += `function writeBridgeJson(response: BridgeNodeHttpResponse, status: number, body: unknown): void {\n`;
  out += `  response.statusCode = status;\n`;
  out += `  response.setHeader('Content-Type', 'application/json');\n`;
  out += `  response.end(JSON.stringify(body ?? null));\n`;
  out += `}\n\n`;
  out += `function writeBridgeError(response: BridgeNodeHttpResponse, code: string, message: string): void {\n`;
  out += `  writeBridgeJson(response, bridgeStatusForCode(code), { code, message });\n`;
  out += `}\n\n`;
  out += `function bridgeErrorFromResponse(method: string, status: number, bodyText: string): BridgeRpcError {\n`;
  out += `  let code = 'internal';\n`;
  out += `  let message = \`non-2xx status \${status}: \${bodyText}\`;\n`;
  out += `  try {\n`;
  out += `    const parsed = JSON.parse(bodyText) as { code?: unknown; message?: unknown };\n`;
  out += `    if (typeof parsed?.code === 'string') {\n`;
  out += `      code = parsed.code;\n`;
  out += `      if (typeof parsed.message === 'string') message = parsed.message;\n`;
  out += `    }\n`;
  out += `  } catch {\n`;
  out += `    // Non-JSON error body: keep the raw text as the message.\n`;
  out += `  }\n`;
  out += `  return new BridgeRpcError(status, code, \`\${method}: \${message}\`);\n`;
  out += `}\n\n`;
  out += `function readRequestBody(request: BridgeNodeHttpRequest): Promise<string> {\n`;
  out += `  return new Promise<string>((resolve, reject) => {\n`;
  out += `    let body = '';\n`;
  out += `    request.on('data', (chunk) => {\n`;
  out += `      body += typeof chunk === 'string' ? chunk : String(chunk);\n`;
  out += `    });\n`;
  out += `    request.on('end', () => resolve(body));\n`;
  out += `    request.on('error', (error) => reject(error));\n`;
  out += `  });\n`;
  out += `}\n\n`;
  return out;
}

function tsService(service: IRService, input: GeneratorInput): string {
  let out = '';
  const optionsName = `Create${service.name}ClientOptions`;

  const docLinesOut = [
    ...docLines(service.docs),
    `Client for the ${service.name} service. Routes: POST /${input.packageName}/${service.name}/<Method>.`,
  ];
  const doc = tsDoc(docLinesOut.join('\n'));
  out += `${doc}\n`;
  out += `export interface ${service.name}Client {\n`;
  for (const method of service.methods) {
    const mdoc = tsDoc(method.docs, method.deprecated);
    if (mdoc.length > 0) out += `${spaceIndent(mdoc)}\n`;
    out += `  ${pascalToCamel(method.name)}(req: ${methodTypeName(method.input, input)}): Promise<${methodTypeName(method.output, input)}>;\n`;
  }
  out += `}\n\n`;

  out += `${tsDoc(`Options for create${service.name}Client.`)}\n`;
  out += `export interface ${optionsName} {\n`;
  out += `  /** Base URL of the Bridge server, without a trailing slash. */\n`;
  out += `  baseUrl: string;\n`;
  out += `  /** Optional fetch implementation; defaults to the global fetch. */\n`;
  out += `  fetchImpl?: FetchLike;\n`;
  out += `}\n\n`;

  out += `${tsDoc(`Creates a JSON-over-HTTP client for the ${service.name} service.`)}\n`;
  out += `export function create${service.name}Client(options: ${optionsName}): ${service.name}Client {\n`;
  out += `  const baseUrl = options.baseUrl.replace(/\\/+$/, '');\n`;
  out += `  const routePrefix = ${JSON.stringify(`${input.packageName}/${service.name}`)};\n`;
  out += `  const fetchImpl = options.fetchImpl ?? (globalThis as { fetch?: FetchLike }).fetch as FetchLike;\n`;
  out += `  async function call<TResponse>(method: string, body: unknown): Promise<TResponse> {\n`;
  out += `    const response = await fetchImpl(\`\${baseUrl}/\${routePrefix}/\${method}\`, {\n`;
  out += `      method: 'POST',\n`;
  out += `      headers: { 'Content-Type': 'application/json' },\n`;
  out += `      body: JSON.stringify(body),\n`;
  out += `    });\n`;
  out += `    if (!response.ok) {\n`;
  out += `      const text = await response.text();\n`;
  out += `      throw bridgeErrorFromResponse(\`\${routePrefix}/\${method}\`, response.status, text);\n`;
  out += `    }\n`;
  out += `    return (await response.json()) as TResponse;\n`;
  out += `  }\n`;
  out += `  return {\n`;
  for (const method of service.methods) {
    out += `    ${pascalToCamel(method.name)}: (req) =>\n`;
    out += `      call<${methodTypeName(method.output, input)}>(\n`;
    out += `        ${JSON.stringify(method.name)},\n`;
    out += `        req,\n`;
    out += `      ),\n`;
  }
  out += `  };\n`;
  out += `}\n\n`;
  return out;
}

/** Method input/output type: named refs render as the type name. */
function methodTypeName(ref: TypeRef, input: GeneratorInput): string {
  if (ref.kind === 'named') return ref.name;
  return renderTypeRef(ref, input.render);
}

/**
 * Server side: handler interface + node:http request listener. The listener
 * parses the JSON body, runs the Bridge validator for the request struct,
 * dispatches to the handler and maps errors onto the canonical
 * {"code", "message"} body.
 */
function tsServiceListener(
  service: IRService,
  input: GeneratorInput,
  validators: ReadonlyMap<string, string>,
): string {
  let out = '';
  const handlerName = `${service.name}ServiceHandler`;
  const listenerName = `create${service.name}RequestListener`;
  const routePrefix = `/${input.packageName}/${service.name}/`;

  const docLinesOut = [
    ...docLines(service.docs),
    `Server-side handler interface for the ${service.name} service.`,
    `Routes: POST /${input.packageName}/${service.name}/<Method>.`,
  ];
  const doc = tsDoc(docLinesOut.join('\n'));
  out += `${doc}\n`;
  out += `export interface ${handlerName} {\n`;
  for (const method of service.methods) {
    const mdoc = tsDoc(method.docs, method.deprecated);
    if (mdoc.length > 0) out += `${spaceIndent(mdoc)}\n`;
    out += `  ${pascalToCamel(method.name)}(req: ${methodTypeName(method.input, input)}): ${methodTypeName(method.output, input)} | Promise<${methodTypeName(method.output, input)}>;\n`;
  }
  out += `}\n\n`;

  out += `${tsDoc(
    `Binds a ${handlerName} to the Bridge JSON-over-HTTP wire shape\n(POST ${routePrefix}<Method>) as a node:http request listener.\nMalformed or invalid requests become 400 {"code": "invalid_argument"};\nBridgeRpcError from the handler maps code → status; anything else is 500.`,
  )}\n`;
  out += `export function ${listenerName}(handler: ${handlerName}): BridgeNodeRequestListener {\n`;
  out += `  const routePrefix = ${JSON.stringify(routePrefix)};\n`;
  out += `  return async (request, response) => {\n`;
  out += `    if ((request.method ?? 'GET') !== 'POST') {\n`;
  out += `      writeBridgeError(response, 'method_not_allowed', 'Bridge RPC routes accept POST only');\n`;
  out += `      return;\n`;
  out += `    }\n`;
  out += `    const path = (request.url ?? '').split('?')[0] ?? '';\n`;
  out += `    if (!path.startsWith(routePrefix)) {\n`;
  out += `      writeBridgeError(response, 'not_found', \`unknown route \${JSON.stringify(path)}\`);\n`;
  out += `      return;\n`;
  out += `    }\n`;
  out += `    const method = path.slice(routePrefix.length);\n`;
  out += `    let raw = '';\n`;
  out += `    try {\n`;
  out += `      raw = await readRequestBody(request);\n`;
  out += `    } catch {\n`;
  out += `      writeBridgeError(response, 'invalid_argument', 'failed to read request body');\n`;
  out += `      return;\n`;
  out += `    }\n`;
  out += `    switch (method) {\n`;
  for (const method of service.methods) {
    const requestType = methodTypeName(method.input, input);
    const validator = validators.get(`${service.name}.${method.name}`);
    out += `      case ${JSON.stringify(method.name)}: {\n`;
    out += `        let parsed: unknown;\n`;
    out += `        try {\n`;
    out += `          parsed = JSON.parse(raw) as unknown;\n`;
    out += `        } catch (error) {\n`;
    out += `          writeBridgeError(\n`;
    out += `            response,\n`;
    out += `            'invalid_argument',\n`;
    out += `            \`decode ${requestType}: \${error instanceof Error ? error.message : String(error)}\`,\n`;
    out += `          );\n`;
    out += `          return;\n`;
    out += `        }\n`;
    if (validator !== undefined) {
      out += `        const violations = validate${validator}(parsed);\n`;
      out += `        if (violations.length > 0) {\n`;
      out += `          writeBridgeError(response, 'invalid_argument', violations.join('; '));\n`;
      out += `          return;\n`;
      out += `        }\n`;
    }
    out += `        try {\n`;
    out += `          const result = await handler.${pascalToCamel(method.name)}(parsed as ${requestType});\n`;
    out += `          writeBridgeJson(response, 200, result);\n`;
    out += `        } catch (error) {\n`;
    out += `          if (error instanceof BridgeRpcError) {\n`;
    out += `            writeBridgeError(response, error.code, error.message);\n`;
    out += `          } else {\n`;
    out += `            writeBridgeError(\n`;
    out += `              response,\n`;
    out += `              'internal',\n`;
    out += `              error instanceof Error ? error.message : String(error),\n`;
    out += `            );\n`;
    out += `          }\n`;
    out += `        }\n`;
    out += `        return;\n`;
    out += `      }\n`;
  }
  out += `      default:\n`;
  out += `        writeBridgeError(response, 'not_found', \`unknown method \${JSON.stringify(method)}\`);\n`;
  out += `    }\n`;
  out += `  };\n`;
  out += `}\n\n`;
  return out;
}

/* ------------------------------------------------------------------ */
/* src/events.ts                                                       */
/* ------------------------------------------------------------------ */

function tsEventsFile(input: GeneratorInput): GeneratedFile | undefined {
  if (!input.generateEvents) return undefined;
  const events = sortedEvents(input.ir);
  if (events.length === 0) return undefined;

  const refs = emptyLocalRefs();
  for (const event of events) {
    for (const field of event.fields) scanRef(field.type, input, refs);
  }

  let body = '';
  body += tsEventEnvelopeBlock();

  for (const event of events) {
    body += tsEvent(event, input);
  }

  body += tsEventDispatcher(events);

  const header = tsFile(
    fileHeader('typescript', input.packageName),
    '',
    tsDoc(
      'Event payloads and the CloudEvents-style Bridge envelope:\n{specversion: "1.0", id, source, type: "<package>.<Event>", time, data}.\nid, source and time are ALWAYS caller-supplied: generated code contains\nno clocks and no uuid generation.',
    ),
  );
  const imports: string[] = [];
  const typeImport = tsImportType('./types', [...refs.types, ...refs.opaque]);
  if (typeImport !== undefined) imports.push(typeImport);
  const enumImport = tsImportType('./enums', refs.enums);
  if (enumImport !== undefined) imports.push(enumImport);
  const parts = [header];
  if (imports.length > 0) parts.push('', imports.join('\n'));
  parts.push('', body.trimEnd(), '');
  return generatedFile('src/events.ts', parts.join('\n'));
}

/** Shared envelope machinery: meta, envelope type, decode helper, publisher + bus. */
function tsEventEnvelopeBlock(): string {
  let out = '';
  out += `${tsDoc('CloudEvents spec version emitted in every Bridge event envelope.')}\n`;
  out += `export const BRIDGE_EVENT_SPECVERSION = ${JSON.stringify(ENVELOPE_SPECVERSION)};\n\n`;
  out += `${tsDoc(
    'Caller-supplied envelope metadata. Generated code never reads the clock\nor generates ids, so publishers must provide all three values.',
  )}\n`;
  out += `export interface BridgeEventMeta {\n`;
  out += `  id: string;\n`;
  out += `  source: string;\n`;
  out += `  time: string;\n`;
  out += `}\n\n`;
  out += `${tsDoc('CloudEvents-style Bridge event envelope; `data` carries the event payload.')}\n`;
  out += `export interface BridgeEventEnvelope<TPayload> {\n`;
  out += `  specversion: string;\n`;
  out += `  id: string;\n`;
  out += `  source: string;\n`;
  out += `  type: string;\n`;
  out += `  time: string;\n`;
  out += `  data: TPayload;\n`;
  out += `}\n\n`;
  out += `${tsDoc(
    'Decodes and validates the envelope shape (specversion "1.0", string type/id/source/time)\nwithout touching the payload. Per-event decode<T> helpers verify the type.',
  )}\n`;
  out += `export function decodeBridgeEventEnvelope(data: unknown): BridgeEventEnvelope<unknown> {\n`;
  out += `  if (typeof data !== 'object' || data === null || Array.isArray(data)) {\n`;
  out += `    throw new Error('bridge event envelope: expected object');\n`;
  out += `  }\n`;
  out += `  const envelope = data as {\n`;
  out += `    specversion?: unknown;\n`;
  out += `    id?: unknown;\n`;
  out += `    source?: unknown;\n`;
  out += `    type?: unknown;\n`;
  out += `    time?: unknown;\n`;
  out += `    data?: unknown;\n`;
  out += `  };\n`;
  out += `  if (envelope.specversion !== BRIDGE_EVENT_SPECVERSION) {\n`;
  out += `    throw new Error(\`bridge event envelope: unsupported specversion \${JSON.stringify(envelope.specversion)}\`);\n`;
  out += `  }\n`;
  out += `  if (\n`;
  out += `    typeof envelope.id !== 'string' ||\n`;
  out += `    typeof envelope.source !== 'string' ||\n`;
  out += `    typeof envelope.type !== 'string' ||\n`;
  out += `    typeof envelope.time !== 'string'\n`;
  out += `  ) {\n`;
  out += `    throw new Error('bridge event envelope: expected string "id", "source", "type" and "time"');\n`;
  out += `  }\n`;
  out += `  return {\n`;
  out += `    specversion: envelope.specversion,\n`;
  out += `    id: envelope.id,\n`;
  out += `    source: envelope.source,\n`;
  out += `    type: envelope.type,\n`;
  out += `    time: envelope.time,\n`;
  out += `    data: envelope.data,\n`;
  out += `  };\n`;
  out += `}\n\n`;
  out += `${tsDoc(
    'Generic event publisher. Publishes a raw payload under an event type;\nthe transport (bus, broker, queue) builds the envelope from `meta`.',
  )}\n`;
  out += `export interface EventPublisher {\n`;
  out += `  publish(type: string, payload: unknown, meta: BridgeEventMeta): Promise<void>;\n`;
  out += `}\n\n`;
  out += `${tsDoc(
    'In-memory EventPublisher: hands envelopes to per-type subscribers.\nIdeal for tests and in-process wiring; swap for a real transport in prod.',
  )}\n`;
  out += `export class InMemoryEventBus implements EventPublisher {\n`;
  out += `  private readonly subscribers = new Map<\n`;
  out += `    string,\n`;
  out += `    Array<(envelope: BridgeEventEnvelope<unknown>) => void | Promise<void>>\n`;
  out += `  >();\n\n`;
  out += `  subscribe(\n`;
  out += `    type: string,\n`;
  out += `    subscriber: (envelope: BridgeEventEnvelope<unknown>) => void | Promise<void>,\n`;
  out += `  ): () => void {\n`;
  out += `    const list = this.subscribers.get(type) ?? [];\n`;
  out += `    list.push(subscriber);\n`;
  out += `    this.subscribers.set(type, list);\n`;
  out += `    return () => {\n`;
  out += `      const current = this.subscribers.get(type) ?? [];\n`;
  out += `      this.subscribers.set(\n`;
  out += `        type,\n`;
  out += `        current.filter((entry) => entry !== subscriber),\n`;
  out += `      );\n`;
  out += `    };\n`;
  out += `  }\n\n`;
  out += `  async publish(type: string, payload: unknown, meta: BridgeEventMeta): Promise<void> {\n`;
  out += `    const envelope: BridgeEventEnvelope<unknown> = {\n`;
  out += `      specversion: BRIDGE_EVENT_SPECVERSION,\n`;
  out += `      id: meta.id,\n`;
  out += `      source: meta.source,\n`;
  out += `      type,\n`;
  out += `      time: meta.time,\n`;
  out += `      data: payload,\n`;
  out += `    };\n`;
  out += `    for (const subscriber of [...(this.subscribers.get(type) ?? [])]) {\n`;
  out += `      await subscriber(envelope);\n`;
  out += `    }\n`;
  out += `  }\n}\n\n`;
  return out;
}

function tsEvent(event: IREvent, input: GeneratorInput): string {
  const typeConst = `${event.name}Type`;
  let out = '';
  out += `${tsDoc(`Fully-qualified event type (${eventTypeName(input.packageName, event.name)}).`)}\n`;
  out += `export const ${typeConst} = ${JSON.stringify(eventTypeName(input.packageName, event.name))};\n\n`;

  const doc = tsDoc(event.docs);
  if (doc.length > 0) out += `${doc}\n`;
  out += `export interface ${event.name} {\n`;
  for (const field of event.fields) {
    const fieldDoc = tsFieldJSDoc(field);
    if (fieldDoc.length > 0) out += `${spaceIndent(fieldDoc)}\n`;
    const suffix = field.optional ? '?' : '';
    out += `  ${tsFieldName(field.name).name}${suffix}: ${tsFieldType(field, input)};\n`;
  }
  out += `}\n\n`;

  out += `${tsDoc(`Handler for ${event.name} events, invoked with the decoded payload.`)}\n`;
  out += `export interface ${event.name}Handler {\n`;
  out += `  (event: ${event.name}, meta: BridgeEventMeta): void | Promise<void>;\n`;
  out += `}\n\n`;

  out += `${tsDoc(`Typed publisher for ${event.name} events.`)}\n`;
  out += `export interface ${event.name}Publisher {\n`;
  out += `  publish(event: ${event.name}, meta: BridgeEventMeta): Promise<void>;\n`;
  out += `}\n\n`;

  out += `${tsDoc(`Builds a ${event.name}Publisher on top of any generic EventPublisher.`)}\n`;
  out += `export function create${event.name}Publisher(publisher: EventPublisher): ${event.name}Publisher {\n`;
  out += `  return {\n`;
  out += `    publish: (event, meta) => publisher.publish(${typeConst}, event, meta),\n`;
  out += `  };\n`;
  out += `}\n\n`;

  out += `${tsDoc(`Wraps a ${event.name} into the CloudEvents-style Bridge envelope.`)}\n`;
  out += `export function encode${event.name}(\n`;
  out += `  data: ${event.name},\n`;
  out += `  meta: BridgeEventMeta,\n`;
  out += `): BridgeEventEnvelope<${event.name}> {\n`;
  out += `  return {\n`;
  out += `    specversion: BRIDGE_EVENT_SPECVERSION,\n`;
  out += `    id: meta.id,\n`;
  out += `    source: meta.source,\n`;
  out += `    type: ${typeConst},\n`;
  out += `    time: meta.time,\n`;
  out += `    data,\n`;
  out += `  };\n`;
  out += `}\n\n`;

  out += `${tsDoc(`Decodes a ${event.name} envelope, verifying specversion and the event type.`)}\n`;
  out += `export function decode${event.name}(data: unknown): BridgeEventEnvelope<${event.name}> {\n`;
  out += `  const envelope = decodeBridgeEventEnvelope(data);\n`;
  out += `  if (envelope.type !== ${typeConst}) {\n`;
  out += `    throw new Error(\`${event.name} envelope: unexpected type \${JSON.stringify(envelope.type)}\`);\n`;
  out += `  }\n`;
  out += `  return envelope as BridgeEventEnvelope<${event.name}>;\n`;
  out += `}\n\n`;
  return out;
}

/** Routes decoded envelopes to the registered per-event handlers by `type`. */
function tsEventDispatcher(events: readonly IREvent[]): string {
  let out = '';
  out += `${tsDoc(
    'Routes Bridge event envelopes (decoded JSON or in-memory) to the registered\nper-event handlers by their `type`. Throws on unknown types.',
  )}\n`;
  out += `export class BridgeEventDispatcher {\n`;
  out += `  private readonly handlers = new Map<\n`;
  out += `    string,\n`;
  out += `    Array<(payload: unknown, meta: BridgeEventMeta) => void | Promise<void>>\n`;
  out += `  >();\n\n`;
  for (const event of events) {
    out += `  ${tsDoc(`Registers a handler for ${event.name} events.`)}\n`;
    out += `  on${event.name}(handler: ${event.name}Handler): this {\n`;
    out += `    const list = this.handlers.get(${event.name}Type) ?? [];\n`;
    out += `    list.push((payload, meta) => handler(payload as ${event.name}, meta));\n`;
    out += `    this.handlers.set(${event.name}Type, list);\n`;
    out += `    return this;\n`;
    out += `  }\n\n`;
  }
  out += `  async dispatch(data: unknown): Promise<void> {\n`;
  out += `    const envelope = decodeBridgeEventEnvelope(data);\n`;
  out += `    const handlers = this.handlers.get(envelope.type);\n`;
  out += `    if (handlers === undefined || handlers.length === 0) {\n`;
  out += `      throw new Error(\`no handler registered for event type \${JSON.stringify(envelope.type)}\`);\n`;
  out += `    }\n`;
  out += `    const meta: BridgeEventMeta = { id: envelope.id, source: envelope.source, time: envelope.time };\n`;
  out += `    for (const handler of [...handlers]) {\n`;
  out += `      await handler(envelope.data, meta);\n`;
  out += `    }\n`;
  out += `  }\n\n`;
  out += `  async dispatchJson(text: string): Promise<void> {\n`;
  out += `    await this.dispatch(JSON.parse(text) as unknown);\n`;
  out += `  }\n}\n\n`;
  return out;
}

/* ------------------------------------------------------------------ */
/* src/index.ts                                                        */
/* ------------------------------------------------------------------ */

function tsIndexFile(input: GeneratorInput, modules: string[]): GeneratedFile {
  const parts = [
    fileHeader('typescript', input.packageName),
    '',
    tsDoc(`Public surface of the Bridge-generated package for ${input.packageName}.`),
    '',
    ...modules.map((name) => `export * from './${name}';`),
    '',
  ];
  return generatedFile('src/index.ts', parts.join('\n'));
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/** Generates the TypeScript project for an IR package. */
export function generateTypeScript(input: GeneratorInput): GeneratedFile[] {
  const types = tsTypesFile(input);
  const enums = tsEnumsFile(input);
  const validate = tsValidateFile(input);
  const services = tsServicesFile(input);
  const events = tsEventsFile(input);

  const moduleFiles: Array<[string, GeneratedFile | undefined]> = [
    ['types', types],
    ['enums', enums],
    ['validate', validate],
    ['services', services],
    ['events', events],
  ];
  const present = moduleFiles
    .filter(([, file]) => file !== undefined)
    .map(([name]) => name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const files: GeneratedFile[] = [
    tsPackageJsonFile(input),
    tsConfigJsonFile(input),
  ];
  for (const [, file] of moduleFiles) {
    if (file !== undefined) files.push(file);
  }
  files.push(tsIndexFile(input, present));
  return files;
}
