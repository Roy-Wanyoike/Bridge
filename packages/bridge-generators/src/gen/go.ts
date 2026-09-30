/**
 * Go generator.
 *
 * Emits, in order: go.mod, types.go, enums.go, validate.go, services.go,
 * events.go. Files without content are skipped (e.g. enums.go when the
 * package declares no enums), keeping the emitted file list deterministic.
 *
 * Go-specific decisions (documented in generated files too):
 * - Fields are exported (CamelCase with initialism expansion: id -> ID,
 *   api -> API, url -> URL, ...); json tags keep the snake_case wire names.
 *   Optional fields are pointers with `json:"...,omitempty"`.
 * - `set<T>` becomes `Set[T]` — a generic `map[T]struct{}` wrapper whose
 *   MarshalJSON/UnmarshalJSON speak the JSON-array wire format in the
 *   canonical set order (numbers numeric, strings by UTF-8 byte order /
 *   code points, false < true — identical in all six targets, #117), with
 *   SetToSlice/SliceToSet converters.
 * - Required-field presence is NOT enforced at runtime by Go Validate:
 *   JSON zero values are indistinguishable from missing fields for
 *   non-pointer fields. Go Validate covers constraints (first error,
 *   wrapped with fmt.Errorf) and nested struct validation.
 * - Defaults are documented as `Default:` comments (no builder machinery).
 * - Cross-package references become `type X = json.RawMessage` opaque
 *   aliases documented as "imported from <pkg>".
 * - Tagged unions map to a `Kind string` + `Value json.RawMessage` struct
 *   with typed constructors (`NewX<Variant>`) and accessors (`As<Variant>`).
 */

import type {
  IRConstraint,
  IRField,
  IRService,
  IRTypeDefinition,
  TypeRef,
} from '@bridge/core';
import { generatedFile } from '../util';
import { fileHeader } from '../header';
import { docLines, goDoc } from '../docs';
import {
  NUMERIC_PRIMITIVES,
  STRING_LIKE_PRIMITIVES,
  defaultLiteral,
  goZeroValue,
  isLocalStructRef,
  renderTypeRef,
} from '../mappings';
import {
  crossPackageRefs,
  sortedEvents,
  sortedServices,
  sortedTypes,
  structZeroValuePassesValidation,
  usesSets,
} from '../analysis';
import {
  ENVELOPE_SPECVERSION,
  RPC_ERROR_CODES_SORTED,
  RPC_ERROR_STATUS,
  eventTypeName,
} from '../wire';
import {
  goExportedName,
  goPackageName,
  goReceiver,
  goSafeIdent,
  pascalFromScreaming,
  sanitizedPackageName,
} from '../naming';
import type { GeneratedFile, GeneratorInput } from './input';

/** Shared regexes emitted once in validate.go when the package uses them. */
const GO_EMAIL_RE = 'reBridgeEmail';
const GO_URL_RE = 'reBridgeURL';
const GO_UUID_RE = 'reBridgeUUID';

/** Generates the Go project for an IR package. */
export function generateGo(input: GeneratorInput): GeneratedFile[] {
  const files: GeneratedFile[] = [goModFile(input)];
  const types = goTypesFile(input);
  if (types !== undefined) files.push(types);
  const enums = goEnumsFile(input);
  if (enums !== undefined) files.push(enums);
  const validate = goValidateFile(input);
  if (validate !== undefined) files.push(validate);
  const services = goServicesFile(input);
  if (services !== undefined) files.push(services);
  const events = goEventsFile(input);
  if (events !== undefined) files.push(events);
  const roundtripTest = goRoundtripTestFile(input);
  if (roundtripTest !== undefined) files.push(roundtripTest);
  return files;
}

/* ------------------------------------------------------------------ */
/* Per-file helpers                                                    */
/* ------------------------------------------------------------------ */

/** Import accumulator; renders a deterministic gofmt-style import block. */
class GoImports {
  private readonly names = new Set<string>();

  add(name: string): void {
    this.names.add(name);
  }

  block(): string {
    if (this.names.size === 0) return '';
    const sorted = [...this.names].sort();
    if (sorted.length === 1) return `import ${JSON.stringify(sorted[0])}`;
    const lines = sorted.map((name) => `\t${JSON.stringify(name)}`).join('\n');
    return `import (\n${lines}\n)`;
  }
}

/** Full doc block for a field: docs + deprecation + default note. */
function goFieldDoc(field: IRField): string {
  const lines = docLines(field.docs);
  if (field.deprecated !== undefined) {
    lines.push(field.deprecated === true ? 'Deprecated.' : `Deprecated: ${field.deprecated}`);
  }
  if (field.default !== undefined) lines.push(`Default: ${field.default}`);
  if (lines.length === 0) return '';
  return lines.map((line) => `// ${line}`).join('\n');
}

/** Indents a doc/normal block by n tabs. */
function tab(block: string, levels = 1): string {
  const pad = '\t'.repeat(levels);
  return block
    .split('\n')
    .map((line) => (line.length > 0 ? pad + line : line))
    .join('\n');
}

/** Package clause. */
function goPackageClause(packageName: string): string {
  return `package ${goPackageName(packageName)}`;
}

/* ------------------------------------------------------------------ */
/* go.mod                                                              */
/* ------------------------------------------------------------------ */

function goModFile(input: GeneratorInput): GeneratedFile {
  const content = [
    fileHeader('go', input.packageName),
    '',
    `module bridge/generated/${sanitizedPackageName(input.packageName)}`,
    '',
    'go 1.22',
    '',
  ].join('\n');
  return generatedFile('go.mod', content);
}

/* ------------------------------------------------------------------ */
/* types.go                                                            */
/* ------------------------------------------------------------------ */

function goTypesFile(input: GeneratorInput): GeneratedFile | undefined {
  const types = sortedTypes(input.ir);
  const structs = types.filter((t) => t.kind === 'struct');
  const unions = types.filter((t) => t.kind === 'union');
  const aliases = types.filter((t) => t.kind === 'alias');
  const opaque = crossPackageRefs(input.ir);
  const hasSets = usesSets(input.ir);
  const hasStructs = structs.length > 0;
  const hasUnions = unions.length > 0;
  const hasAliases = aliases.length > 0;
  if (!hasStructs && !hasUnions && !hasAliases && opaque.length === 0 && !hasSets) {
    return undefined;
  }

  const imports = new GoImports();
  let body = '';

  // Opaque aliases for cross-package references (may be referenced by the
  // declarations below, so they come first).
  for (const ref of opaque) {
    imports.add('encoding/json');
    const doc = goDoc(
      `${ref.name} is an opaque alias: imported from ${ref.fromPackage}; regenerate with that package for full types.`,
    );
    body += `${doc}\ntype ${ref.name} = json.RawMessage\n\n`;
  }

  for (const alias of aliases) {
    const doc = goDoc(alias.docs, alias.deprecated);
    if (doc.length > 0) body += `${doc}\n`;
    body += `type ${alias.name} = ${renderTypeRef(alias.target, input.render)}\n\n`;
  }

  for (const struct of structs) {
    const doc = goDoc(struct.docs, struct.deprecated);
    if (doc.length > 0) body += `${doc}\n`;
    body += `type ${struct.name} struct {\n`;
    for (const field of struct.fields) {
      const fieldDoc = goFieldDoc(field);
      if (fieldDoc.length > 0) body += `${tab(fieldDoc)}\n`;
      const tag = field.optional ? ` json:"${field.name},omitempty"` : ` json:"${field.name}"`;
      body += `\t${goExportedName(field.name)} ${goFieldType(field, input)} \`${tag}\`\n`;
    }
    body += '}\n\n';
  }

  for (const union of unions) {
    body += goUnion(union as IRTypeDefinition & { kind: 'union' }, input, imports);
  }

  if (hasSets) {
    body += goSetSupport();
  }

  if (opaque.length > 0 || hasUnions || hasSets) imports.add('encoding/json');
  if (hasUnions || hasSets) imports.add('fmt');
  if (hasSets) imports.add('sort');
  if (hasSets) imports.add('reflect');

  const parts = [fileHeader('go', input.packageName), '', goPackageClause(input.packageName)];
  const importBlock = imports.block();
  if (importBlock.length > 0) parts.push('', importBlock);
  parts.push('', body.trimEnd(), '');
  return generatedFile('types.go', parts.join('\n'));
}

/** Go type for a field; optional fields are pointers. */
function goFieldType(field: IRField, input: GeneratorInput): string {
  const base = renderTypeRef(field.type, input.render);
  if (field.optional && field.type.kind !== 'optional') return `*${base}`;
  return base;
}

function goUnion(
  union: IRTypeDefinition & { kind: 'union' },
  input: GeneratorInput,
  imports: GoImports,
): string {
  imports.add('encoding/json');
  imports.add('fmt');
  let out = '';
  const variantLines = union.variants.map(
    (v) => `  - ${v.name}: ${renderTypeRef(v.type, input.render)}`,
  );
  const docText = [
    `Tagged union. Wire format: {"kind": "<variant>", "value": <payload>}.`,
    'Variants:',
    ...variantLines,
  ];
  if (union.docs !== undefined) docText.unshift(...docLines(union.docs));
  const doc = goDoc(docText.join('\n'), union.deprecated);
  if (doc.length > 0) out += `${doc}\n`;
  out += `type ${union.name} struct {\n`;
  out += `${tab('// Kind selects the union variant.')}\n`;
  out += `\tKind string \`json:"kind"\`\n`;
  out += `${tab('// Value is the JSON payload for the selected variant.')}\n`;
  out += `\tValue json.RawMessage \`json:"value"\`\n`;
  out += '}\n\n';

  const receiver = goReceiver(union.name);
  for (const variant of union.variants) {
    const variantGoName = goExportedName(variant.name);
    const payloadType = renderTypeRef(variant.type, input.render);
    const zero = goZeroValue(variant.type, input.render);
    const vdoc = goDoc(variant.docs, variant.deprecated);

    if (vdoc.length > 0) out += `${vdoc}\n`;
    out += `${goDoc(`New${union.name}${variantGoName} builds a ${union.name} carrying the ${variant.name} variant.`)}\n`;
    out += `func New${union.name}${variantGoName}(value ${payloadType}) (${union.name}, error) {\n`;
    out += `\traw, err := json.Marshal(value)\n`;
    out += `\tif err != nil {\n`;
    out += `\t\treturn ${union.name}{}, fmt.Errorf("marshal ${variant.name}: %w", err)\n`;
    out += `\t}\n`;
    out += `\treturn ${union.name}{Kind: ${JSON.stringify(variant.name)}, Value: raw}, nil\n`;
    out += '}\n\n';

    if (vdoc.length > 0) out += `${vdoc}\n`;
    out += `${goDoc(`As${variantGoName} returns the ${variant.name} payload when Kind == ${JSON.stringify(variant.name)}.`)}\n`;
    out += `func (${receiver} ${union.name}) As${variantGoName}() (${payloadType}, bool) {\n`;
    out += `\tif ${receiver}.Kind != ${JSON.stringify(variant.name)} {\n`;
    out += `\t\treturn ${zero}, false\n`;
    out += `\t}\n`;
    out += `\tvar out ${payloadType}\n`;
    out += `\tif err := json.Unmarshal(${receiver}.Value, &out); err != nil {\n`;
    out += `\t\treturn ${zero}, false\n`;
    out += `\t}\n`;
    out += `\treturn out, true\n`;
    out += '}\n\n';
  }
  return out;
}

function goSetSupport(): string {
  let out = '';
  out += `${goDoc('Set is a set of comparable items. On the JSON wire it is an array.')}\n`;
  out += 'type Set[T comparable] map[T]struct{}\n\n';
  out += `${goDoc('MarshalJSON encodes the set as a JSON array in the canonical Bridge set order.')}\n`;
  out += 'func (s Set[T]) MarshalJSON() ([]byte, error) {\n';
  out += '\titems := make([]T, 0, len(s))\n';
  out += '\tfor item := range s {\n';
  out += '\t\titems = append(items, item)\n';
  out += '\t}\n';
  out += '\tsort.Slice(items, func(i, j int) bool {\n';
  out += '\t\treturn bridgeSetLess(items[i], items[j])\n';
  out += '\t})\n';
  out += '\treturn json.Marshal(items)\n';
  out += '}\n\n';
  out += `${goDoc('UnmarshalJSON decodes the set from a JSON array.')}\n`;
  out += 'func (s *Set[T]) UnmarshalJSON(data []byte) error {\n';
  out += '\tvar items []T\n';
  out += '\tif err := json.Unmarshal(data, &items); err != nil {\n';
  out += '\t\treturn err\n';
  out += '\t}\n';
  out += '\tout := make(Set[T], len(items))\n';
  out += '\tfor _, item := range items {\n';
  out += '\t\tout[item] = struct{}{}\n';
  out += '\t}\n';
  out += '\t*s = out\n';
  out += '\treturn nil\n';
  out += '}\n\n';
  out += `${goDoc('SetToSlice converts a Set into its JSON-array representation (deterministic order).')}\n`;
  out += 'func SetToSlice[T comparable](s Set[T]) []T {\n';
  out += '\traw, err := json.Marshal(s)\n';
  out += '\tif err != nil {\n';
  out += '\t\treturn nil\n';
  out += '\t}\n';
  out += '\tvar items []T\n';
  out += '\tif err := json.Unmarshal(raw, &items); err != nil {\n';
  out += '\t\treturn nil\n';
  out += '\t}\n';
  out += '\treturn items\n';
  out += '}\n\n';
  out += `${goDoc('SliceToSet converts a JSON-array representation into a Set.')}\n`;
  out += 'func SliceToSet[T comparable](items []T) Set[T] {\n';
  out += '\tout := make(Set[T], len(items))\n';
  out += '\tfor _, item := range items {\n';
  out += '\t\tout[item] = struct{}{}\n';
  out += '\t}\n';
  out += '\treturn out\n';
  out += '}\n\n';
  out += `${goDoc(
    [
      'bridgeSetLess reports whether a sorts before b in the canonical Bridge',
      'set order: numbers ascending numerically, strings ascending by UTF-8',
      'byte order (Unicode code points), false before true. Bridge sets are',
      'homogeneous, so the dynamic check always takes the same branch for a',
      'given set; every Bridge target language implements the same rule',
      '(docs/SERIALIZATION.md, canonical rule 5).',
    ].join('\n'),
  )}\n`;
  out += 'func bridgeSetLess(a, b any) bool {\n';
  out += '\tav := reflect.ValueOf(a)\n';
  out += '\tbv := reflect.ValueOf(b)\n';
  out += '\tswitch av.Kind() {\n';
  out += '\tcase reflect.String:\n';
  out += '\t\treturn av.String() < bv.String()\n';
  out += '\tcase reflect.Bool:\n';
  out += '\t\treturn !av.Bool() && bv.Bool()\n';
  out += '\tcase reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:\n';
  out += '\t\treturn av.Int() < bv.Int()\n';
  out += '\tcase reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:\n';
  out += '\t\treturn av.Uint() < bv.Uint()\n';
  out += '\tcase reflect.Float32, reflect.Float64:\n';
  out += '\t\treturn av.Float() < bv.Float()\n';
  out += '\tdefault:\n';
  out += '\t\t// Unreachable for Bridge set elements (primitives only); keeps the\n';
  out += '\t\t// previous deterministic ordering for any exotic user generic.\n';
  out += '\t\treturn fmt.Sprint(a) < fmt.Sprint(b)\n';
  out += '\t}\n';
  out += '}\n\n';
  return out;
}

/* ------------------------------------------------------------------ */
/* enums.go                                                            */
/* ------------------------------------------------------------------ */

function goEnumsFile(input: GeneratorInput): GeneratedFile | undefined {
  const enums = sortedTypes(input.ir).filter((t) => t.kind === 'enum');
  if (enums.length === 0) return undefined;
  const imports = new GoImports();
  imports.add('encoding/json');
  imports.add('fmt');
  let body = '';
  for (const enumType of enums) {
    body += goEnum(enumType as IRTypeDefinition & { kind: 'enum' });
  }
  const parts = [
    fileHeader('go', input.packageName),
    '',
    goPackageClause(input.packageName),
    '',
    imports.block(),
    '',
    body.trimEnd(),
    '',
  ];
  return generatedFile('enums.go', parts.join('\n'));
}

function goEnum(enumType: IRTypeDefinition & { kind: 'enum' }): string {
  let out = '';
  const doc = goDoc(enumType.docs, enumType.deprecated);
  if (doc.length > 0) out += `${doc}\n`;
  out += `type ${enumType.name} string\n\n`;
  out += `// ${enumType.name} variants.\n`;
  out += 'const (\n';
  for (const variant of enumType.variants) {
    const vdoc = goDoc(variant.docs, variant.deprecated);
    if (vdoc.length > 0) out += `${tab(vdoc)}\n`;
    out += `\t${goConstName(enumType, variant.name)} ${enumType.name} = ${JSON.stringify(variant.name)}\n`;
  }
  out += ')\n\n';

  const parse = `${goSafeIdent('Parse')}${enumType.name}`;
  out += `${goDoc(`${parse} parses the wire representation into a ${enumType.name}.`)}\n`;
  out += `func ${parse}(value string) (${enumType.name}, error) {\n`;
  out += '\tswitch value {\n';
  for (const variant of enumType.variants) {
    out += `\tcase ${JSON.stringify(variant.name)}:\n`;
    out += `\t\treturn ${goConstName(enumType, variant.name)}, nil\n`;
  }
  out += '\t}\n';
  out += `\treturn "", fmt.Errorf("unknown ${enumType.name} value %q", value)\n`;
  out += '}\n\n';

  out += `${goDoc(`MarshalJSON encodes ${enumType.name} as its wire representation.`)}\n`;
  out += `func (e ${enumType.name}) MarshalJSON() ([]byte, error) {\n`;
  out += '\tswitch e {\n';
  for (const variant of enumType.variants) {
    out += `\tcase ${goConstName(enumType, variant.name)}:\n`;
    out += `\t\treturn []byte(${JSON.stringify(JSON.stringify(variant.name))}), nil\n`;
  }
  out += '\t}\n';
  out += `\treturn nil, fmt.Errorf("cannot marshal invalid ${enumType.name} value %q", string(e))\n`;
  out += '}\n\n';

  out += `${goDoc(`UnmarshalJSON decodes ${enumType.name} from its wire representation, erroring on unknown values.`)}\n`;
  out += `func (e *${enumType.name}) UnmarshalJSON(data []byte) error {\n`;
  out += '\tvar raw string\n';
  out += '\tif err := json.Unmarshal(data, &raw); err != nil {\n';
  out += '\t\treturn err\n';
  out += '\t}\n';
  out += `\tparsed, err := ${parse}(raw)\n`;
  out += '\tif err != nil {\n';
  out += '\t\treturn err\n';
  out += '\t}\n';
  out += '\t*e = parsed\n';
  out += '\treturn nil\n';
  out += '}\n\n';
  return out;
}

function goConstName(enumType: IRTypeDefinition & { kind: 'enum' }, variant: string): string {
  return `${enumType.name}${pascalFromScreaming(variant)}`;
}

/* ------------------------------------------------------------------ */
/* validate.go                                                         */
/* ------------------------------------------------------------------ */

function goValidateFile(input: GeneratorInput): GeneratedFile | undefined {
  const structs = sortedTypes(input.ir).filter((t) => t.kind === 'struct');
  if (structs.length === 0) return undefined;

  const imports = new GoImports();
  imports.add('fmt');
  let regexBlock = '';
  let usesEmail = false;
  let usesURL = false;
  let usesUUID = false;

  // Shared + per-field regex variables.
  for (const struct of structs) {
    for (const field of (struct as IRTypeDefinition & { kind: 'struct' }).fields) {
      for (const constraint of field.constraints) {
        if (constraint.kind === 'pattern') {
          imports.add('regexp');
          const arg = constraint.args[0] ?? '';
          regexBlock += `// ${goPatternVar(struct.name, field.name)} matches the @pattern constraint on ${struct.name}.${goExportedName(field.name)}.\n`;
          regexBlock += `var ${goPatternVar(struct.name, field.name)} = regexp.MustCompile(${JSON.stringify(arg)})\n\n`;
        } else if (constraint.kind === 'email') {
          usesEmail = true;
        } else if (constraint.kind === 'url') {
          usesURL = true;
        } else if (constraint.kind === 'uuid') {
          usesUUID = true;
        }
      }
    }
  }
  if (usesEmail || usesURL || usesUUID) imports.add('regexp');
  if (usesEmail) {
    regexBlock = `// ${GO_EMAIL_RE} implements the @email constraint: ^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$\nvar ${GO_EMAIL_RE} = regexp.MustCompile("^[^@\\\\s]+@[^@\\\\s]+\\\\.[^@\\\\s]+$")\n\n${regexBlock}`;
  }
  if (usesURL) {
    regexBlock = `// ${GO_URL_RE} implements the @url constraint: ^https?://\\S+$\nvar ${GO_URL_RE} = regexp.MustCompile("^https?://\\\\S+$")\n\n${regexBlock}`;
  }
  if (usesUUID) {
    regexBlock = `// ${GO_UUID_RE} implements the @uuid constraint (8-4-4-4-12 hex).\nvar ${GO_UUID_RE} = regexp.MustCompile("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")\n\n${regexBlock}`;
  }

  let body = '';
  for (const struct of structs) {
    body += goValidateStruct(struct as IRTypeDefinition & { kind: 'struct' }, input, imports);
  }

  const parts = [
    fileHeader('go', input.packageName),
    '',
    goPackageClause(input.packageName),
    '',
    imports.block(),
  ];
  if (regexBlock.length > 0) parts.push('', regexBlock.trimEnd());
  parts.push('', body.trimEnd(), '');
  return generatedFile('validate.go', parts.join('\n'));
}

/** Variable name for a @pattern constraint regex. */
function goPatternVar(typeName: string, fieldName: string): string {
  return `re${typeName}${goExportedName(fieldName)}`;
}

function goValidateStruct(
  struct: IRTypeDefinition & { kind: 'struct' },
  input: GeneratorInput,
  imports: GoImports,
): string {
  let out = '';
  out += `${goDoc(`Validate checks the constraints declared on ${struct.name}. The first violation is returned, wrapped with the field name.`)}\n`;
  const receiver = goReceiver(struct.name);
  out += `func (${receiver} ${struct.name}) Validate() error {\n`;
  for (const field of struct.fields) {
    out += goFieldValidation(struct, field, input, imports);
  }
  for (const field of struct.fields) {
    out += goNestedValidation(struct, field, input);
  }
  out += '\treturn nil\n';
  out += '}\n\n';
  return out;
}

function goFieldValidation(
  struct: IRTypeDefinition & { kind: 'struct' },
  field: IRField,
  input: GeneratorInput,
  imports: GoImports,
): string {
  let out = '';
  const receiver = goReceiver(struct.name);
  const goField = goExportedName(field.name);
  const valueExpr = field.optional
    ? `*${receiver}.${goField}`
    : `${receiver}.${goField}`;

  for (const constraint of field.constraints) {
    const rendered = goConstraintCheck(constraint, struct, field, valueExpr, input, imports);
    if (rendered === undefined) continue;
    if (field.optional) {
      out += `\tif ${receiver}.${goField} != nil {\n`;
      out += tab(rendered.trimEnd(), 1) + '\n';
      out += `\t}\n`;
    } else {
      out += rendered;
    }
  }
  return out;
}

function goConstraintCheck(
  constraint: IRConstraint,
  struct: IRTypeDefinition & { kind: 'struct' },
  field: IRField,
  valueExpr: string,
  input: GeneratorInput,
  imports: GoImports,
): string | undefined {
  const fail = (fallback: string): string => {
    const msg = constraint.message ?? fallback;
    return `\t\treturn fmt.Errorf(${JSON.stringify(`${field.name}: ${msg}`)})\n`;
  };
  void input;

  switch (constraint.kind) {
    case 'min':
    case 'max': {
      if (!isNumericField(field)) return undefined;
      const arg = constraint.args[0] ?? '';
      const op = constraint.kind === 'min' ? '<' : '>';
      const text = constraint.kind === 'min' ? `must be >= ${arg}` : `must be <= ${arg}`;
      return `\tif ${valueExpr} ${op} ${arg} {\n${fail(text)}\t}\n`;
    }
    case 'length': {
      if (!isStringLikeField(field)) return undefined;
      const arg = constraint.args[0] ?? '';
      // len() counts bytes; docs note the unicode caveat.
      return `\tif len(${valueExpr}) != ${arg} {\n${fail(`must be exactly ${arg} characters`)}\t}\n`;
    }
    case 'email': {
      if (!isStringLikeField(field)) return undefined;
      return `\tif !${GO_EMAIL_RE}.MatchString(${valueExpr}) {\n${fail('must be a valid email address')}\t}\n`;
    }
    case 'url': {
      if (!isStringLikeField(field)) return undefined;
      return `\tif !${GO_URL_RE}.MatchString(${valueExpr}) {\n${fail('must be a valid URL')}\t}\n`;
    }
    case 'uuid': {
      if (!isStringLikeField(field)) return undefined;
      return `\tif !${GO_UUID_RE}.MatchString(${valueExpr}) {\n${fail('must be a valid UUID')}\t}\n`;
    }
    case 'pattern': {
      if (!isStringLikeField(field)) return undefined;
      const arg = constraint.args[0] ?? '';
      const varName = goPatternVar(struct.name, field.name);
      return `\tif !${varName}.MatchString(${valueExpr}) {\n${fail(`must match pattern ${arg}`)}\t}\n`;
    }
    default:
      return undefined;
  }
}

function goNestedValidation(
  struct: IRTypeDefinition & { kind: 'struct' },
  field: IRField,
  input: GeneratorInput,
): string {
  let ref: TypeRef = field.type;
  if (ref.kind === 'optional') ref = ref.inner;
  if (!isLocalStructRef(ref, input.ir)) return '';
  const receiver = goReceiver(struct.name);
  const goField = goExportedName(field.name);
  let out = '';
  if (field.optional) {
    out += `\tif ${receiver}.${goField} != nil {\n`;
    out += `\t\tif err := ${receiver}.${goField}.Validate(); err != nil {\n`;
    out += `\t\t\treturn fmt.Errorf("${field.name}: %w", err)\n`;
    out += `\t\t}\n`;
    out += `\t}\n`;
  } else {
    out += `\tif err := ${receiver}.${goField}.Validate(); err != nil {\n`;
    out += `\t\treturn fmt.Errorf("${field.name}: %w", err)\n`;
    out += `\t}\n`;
  }
  return out;
}

function isNumericField(field: IRField): boolean {
  const t = unwrapOptional(field.type);
  return t.kind === 'primitive' && NUMERIC_PRIMITIVES.has(t.primitive);
}

function isStringLikeField(field: IRField): boolean {
  const t = unwrapOptional(field.type);
  return t.kind === 'primitive' && STRING_LIKE_PRIMITIVES.has(t.primitive);
}

function unwrapOptional(ref: TypeRef): TypeRef {
  return ref.kind === 'optional' ? ref.inner : ref;
}

/* ------------------------------------------------------------------ */
/* services.go                                                         */
/* ------------------------------------------------------------------ */

function goServicesFile(input: GeneratorInput): GeneratedFile | undefined {
  if (!input.generateServices) return undefined;
  const services = sortedServices(input.ir);
  if (services.length === 0) return undefined;

  // Server-side request validators: one per method whose input is a local
  // struct (validate.go emits Validate for every local struct).
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
  body += goRpcBlock();
  for (const service of services) {
    body += goService(service, input);
    body += goServiceHandler(service, input, validators);
  }

  const parts = [
    fileHeader('go', input.packageName),
    '',
    goPackageClause(input.packageName),
    '',
    'import (\n\t"bytes"\n\t"context"\n\t"encoding/json"\n\t"errors"\n\t"fmt"\n\t"io"\n\t"net/http"\n\t"strings"\n)',
    '',
    body.trimEnd(),
    '',
  ];
  return generatedFile('services.go', parts.join('\n'));
}

/**
 * Shared RPC block: BridgeRPCError, the code→status mapping and the
 * JSON response-writing helpers used by the server adapters.
 */
function goRpcBlock(): string {
  let out = '';
  out += `${goDoc('HTTPDoer executes HTTP requests. *http.Client implements it.')}\n`;
  out += 'type HTTPDoer interface {\n';
  out += '\tDo(req *http.Request) (*http.Response, error)\n';
  out += '}\n\n';
  out += `${goDoc('BridgeRPCError is the wire-level Bridge RPC error: HTTP status + code + message.')}\n`;
  out += 'type BridgeRPCError struct {\n';
  out += '\tStatus  int    `json:"-"`\n';
  out += '\tCode    string `json:"code"`\n';
  out += '\tMessage string `json:"message"`\n';
  out += '}\n\n';
  out += `${goDoc('Error implements the error interface.')}\n`;
  out += 'func (e *BridgeRPCError) Error() string {\n';
  out += '\treturn fmt.Sprintf("bridge rpc %s (status %d): %s", e.Code, e.Status, e.Message)\n';
  out += '}\n\n';
  out += `${goDoc('BridgeStatusForCode maps a Bridge RPC error code to its canonical HTTP status; unknown codes map to 500.')}\n`;
  out += 'func BridgeStatusForCode(code string) int {\n';
  out += '\tswitch code {\n';
  for (const code of RPC_ERROR_CODES_SORTED) {
    out += `\tcase ${JSON.stringify(code)}:\n\t\treturn ${RPC_ERROR_STATUS[code]}\n`;
  }
  out += '\tdefault:\n\t\treturn 500\n\t}\n}\n\n';
  out += `${goDoc('writeBridgeJSON writes a JSON body with the given HTTP status.')}\n`;
  out += 'func writeBridgeJSON(w http.ResponseWriter, status int, body any) {\n';
  out += '\tw.Header().Set("Content-Type", "application/json")\n';
  out += '\tw.WriteHeader(status)\n';
  out += '\t_ = json.NewEncoder(w).Encode(body)\n';
  out += '}\n\n';
  out += `${goDoc('writeBridgeError writes the canonical {"code", "message"} error body.')}\n`;
  out += 'func writeBridgeError(w http.ResponseWriter, code string, message string) {\n';
  out += '\twriteBridgeJSON(w, BridgeStatusForCode(code), map[string]string{"code": code, "message": message})\n';
  out += '}\n\n';
  out += `${goDoc('bridgeMaxBodyBytes caps request bodies decoded by generated servers (DoS guard).')}\n`;
  out += 'const bridgeMaxBodyBytes int64 = 1 << 20\n\n';
  out += `${goDoc('bridgeErrorFromBody parses a non-2xx {"code", "message"} body into a *BridgeRPCError.')}\n`;
  out += 'func bridgeErrorFromBody(status int, body []byte) *BridgeRPCError {\n';
  out += '\tcode := "internal"\n';
  out += '\tmessage := fmt.Sprintf("non-2xx status %d: %s", status, string(body))\n';
  out += '\tvar parsed struct {\n';
  out += '\t\tCode    string `json:"code"`\n';
  out += '\t\tMessage string `json:"message"`\n';
  out += '\t}\n';
  out += '\tif err := json.Unmarshal(body, &parsed); err == nil && parsed.Code != "" {\n';
  out += '\t\tcode = parsed.Code\n';
  out += '\t\tif parsed.Message != "" {\n';
  out += '\t\t\tmessage = parsed.Message\n';
  out += '\t\t}\n';
  out += '\t}\n';
  out += '\treturn &BridgeRPCError{Status: status, Code: code, Message: message}\n';
  out += '}\n\n';
  return out;
}

function goService(service: IRService, input: GeneratorInput): string {
  let out = '';
  const serverDocs = [`${service.name}Server is the server interface for the ${service.name} service.`];
  if (service.docs !== undefined) serverDocs.unshift(...docLines(service.docs));
  const sdoc = goDoc(serverDocs.join('\n'));
  if (sdoc.length > 0) out += `${sdoc}\n`;
  out += `type ${service.name}Server interface {\n`;
  for (const method of service.methods) {
    const mdoc = goDoc(method.docs, method.deprecated);
    if (mdoc.length > 0) out += `${tab(mdoc)}\n`;
    // Method identifiers go through goSafeIdent: a method named like a Go
    // keyword (func, interface, map, type, ...) would otherwise break the
    // interface/client/stub. Route strings below keep the raw wire name.
    out += `\t${goSafeIdent(method.name)}(ctx context.Context, req *${methodTypeName(method.input, input)}) (*${methodTypeName(method.output, input)}, error)\n`;
  }
  out += '}\n\n';

  const clientDocs = [
    `${service.name}JSONClient is a JSON-over-HTTP client for the ${service.name} service.`,
    `Routes: POST /${input.packageName}/${service.name}/<Method>.`,
  ];
  out += `${goDoc(clientDocs.join('\n'))}\n`;
  out += `type ${service.name}JSONClient struct {\n`;
  out += '\tbaseURL string\n';
  out += '\thttp    HTTPDoer\n';
  out += '}\n\n';
  out += `${goDoc(`New${service.name}JSONClient creates a client. baseURL must not have a trailing slash.`)}\n`;
  out += `func New${service.name}JSONClient(doer HTTPDoer, baseURL string) *${service.name}JSONClient {\n`;
  out += `\treturn &${service.name}JSONClient{baseURL: baseURL, http: doer}\n`;
  out += '}\n\n';

  for (const method of service.methods) {
    const mdoc = goDoc(method.docs, method.deprecated);
    if (mdoc.length > 0) out += `${mdoc}\n`;
    const inType = methodTypeName(method.input, input);
    const outType = methodTypeName(method.output, input);
    out += `func (c *${service.name}JSONClient) ${goSafeIdent(method.name)}(req *${inType}) (*${outType}, error) {\n`;
    out += `\tvar out ${outType}\n`;
    out += `\tif err := c.do(${JSON.stringify(method.name)}, req, &out); err != nil {\n`;
    out += '\t\treturn nil, err\n';
    out += '\t}\n';
    out += '\treturn &out, nil\n';
    out += '}\n\n';
  }

  out += goClientDoHelper(service, input.packageName);
  return out;
}

function goClientDoHelper(service: IRService, packageName: string): string {
  let out = '';
  out += `${goDoc('do marshals req as JSON, POSTs it to /<package>/<Service>/<Method> and decodes the JSON response.')}\n`;
  out += `func (c *${service.name}JSONClient) do(method string, req any, out any) error {\n`;
  out += '\tbody, err := json.Marshal(req)\n';
  out += '\tif err != nil {\n';
  out += '\t\treturn fmt.Errorf("marshal request: %w", err)\n';
  out += '\t}\n';
  out += `\turl := strings.TrimSuffix(c.baseURL, "/") + ${JSON.stringify(`/${packageName}/${service.name}/`)} + method\n`;
  out += `\thttpReq, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))\n`;
  out += '\tif err != nil {\n';
  out += '\t\treturn fmt.Errorf("build request: %w", err)\n';
  out += '\t}\n';
  out += '\thttpReq.Header.Set("Content-Type", "application/json")\n';
  out += '\tresp, err := c.http.Do(httpReq)\n';
  out += '\tif err != nil {\n';
  out += `\t\treturn fmt.Errorf("call %s: %w", method, err)\n`;
  out += '\t}\n';
  out += '\tdefer resp.Body.Close()\n';
  out += '\trespBody, err := io.ReadAll(resp.Body)\n';
  out += '\tif err != nil {\n';
  out += '\t\treturn fmt.Errorf("read response: %w", err)\n';
  out += '\t}\n';
  out += '\tif resp.StatusCode < 200 || resp.StatusCode > 299 {\n';
  out += `\t\treturn fmt.Errorf("%s: %w", method, bridgeErrorFromBody(resp.StatusCode, respBody))\n`;
  out += '\t}\n';
  out += '\tif err := json.Unmarshal(respBody, out); err != nil {\n';
  out += '\t\treturn fmt.Errorf("unmarshal response: %w", err)\n';
  out += '\t}\n';
  out += '\treturn nil\n';
  out += '}\n\n';
  return out;
}

/**
 * Server side: net/http handler binding a <Service>Server to the Bridge
 * JSON-over-HTTP wire shape. POST /<package>/<Service>/<Method>; malformed
 * or invalid requests become 400 {"code": "invalid_argument"};
 * *BridgeRPCError from the handler maps code → status; anything else is
 * 500 {"code": "internal"}.
 */
function goServiceHandler(
  service: IRService,
  input: GeneratorInput,
  validators: ReadonlyMap<string, string>,
): string {
  let out = '';
  const handlerName = `New${service.name}Handler`;
  const routePrefix = `/${input.packageName}/${service.name}/`;
  const docLinesOut = [
    ...docLines(service.docs),
    `${handlerName} binds a ${service.name}Server to the Bridge JSON-over-HTTP wire shape`,
    `(POST ${routePrefix}<Method>) as a net/http handler.`,
    'Malformed or invalid requests become 400 {"code": "invalid_argument"};',
    '*BridgeRPCError maps code → status; anything else is 500 {"code": "internal"}.',
  ];
  const doc = goDoc(docLinesOut.join('\n'));
  if (doc.length > 0) out += `${doc}\n`;
  out += `func ${handlerName}(server ${service.name}Server) http.Handler {\n`;
  out += `\tconst routePrefix = ${JSON.stringify(routePrefix)}\n`;
  out += '\treturn http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {\n';
  out += '\t\tif r.Method != http.MethodPost {\n';
  out += `\t\t\twriteBridgeError(w, "method_not_allowed", "Bridge RPC routes accept POST only")\n`;
  out += '\t\t\treturn\n';
  out += '\t\t}\n';
  out += '\t\tif !strings.HasPrefix(r.URL.Path, routePrefix) {\n';
  out += '\t\t\twriteBridgeError(w, "not_found", fmt.Sprintf("unknown route %q", r.URL.Path))\n';
  out += '\t\t\treturn\n';
  out += '\t\t}\n';
  out += '\t\tmethod := strings.TrimPrefix(r.URL.Path, routePrefix)\n';
  out += '\t\t// DoS guard: cap the decoded body size before buffering it (issue #45).\n';
  out += '\t\tr.Body = http.MaxBytesReader(w, r.Body, bridgeMaxBodyBytes)\n';
  out += '\t\tbody, err := io.ReadAll(r.Body)\n';
  out += '\t\tif err != nil {\n';
  out += '\t\t\twriteBridgeError(w, "payload_too_large", "request body exceeds the 1 MiB limit")\n';
  out += '\t\t\treturn\n';
  out += '\t\t}\n';
  out += '\t\tswitch method {\n';
  for (const method of service.methods) {
    const requestType = methodTypeName(method.input, input);
    const responseType = methodTypeName(method.output, input);
    const validator = validators.get(`${service.name}.${method.name}`);
    out += `\t\tcase ${JSON.stringify(method.name)}:\n`;
    out += `\t\t\tvar req ${requestType}\n`;
    out += '\t\t\tif err := json.Unmarshal(body, &req); err != nil {\n';
    out += `\t\t\t\twriteBridgeError(w, "invalid_argument", fmt.Sprintf("decode ${requestType}: %v", err))\n`;
    out += '\t\t\t\treturn\n';
    out += '\t\t\t}\n';
    if (validator !== undefined) {
      out += '\t\t\tif err := req.Validate(); err != nil {\n';
      out += '\t\t\t\twriteBridgeError(w, "invalid_argument", err.Error())\n';
      out += '\t\t\t\treturn\n';
      out += '\t\t\t}\n';
    }
    out += `\t\t\tresp, err := server.${goSafeIdent(method.name)}(r.Context(), &req)\n`;
    out += '\t\t\tif err != nil {\n';
    out += '\t\t\t\tvar rpcErr *BridgeRPCError\n';
    out += '\t\t\t\tif errors.As(err, &rpcErr) {\n';
    out += '\t\t\t\t\twriteBridgeError(w, rpcErr.Code, rpcErr.Message)\n';
    out += '\t\t\t\t\treturn\n';
    out += '\t\t\t\t}\n';
    out += '\t\t\t\twriteBridgeError(w, "internal", err.Error())\n';
    out += '\t\t\t\treturn\n';
    out += '\t\t\t}\n';
    out += `\t\t\twriteBridgeJSON(w, http.StatusOK, resp)\n`;
    out += '\t\t\treturn\n';
  }
  out += '\t\tdefault:\n';
  out += '\t\t\twriteBridgeError(w, "not_found", fmt.Sprintf("unknown method %q", method))\n';
  out += '\t\t}\n';
  out += '\t})\n';
  out += '}\n\n';
  return out;
}

/* ------------------------------------------------------------------ */
/* roundtrip_test.go                                                   */
/* ------------------------------------------------------------------ */

/**
 * Emits a `net/http/httptest` round-trip test file that ships inside the
 * generated Go module:
 *
 * - a stub <Service>Server whose methods return zero responses;
 * - unknown-method  → 404 {"code":"not_found"};
 * - non-POST        → 405 {"code":"method_not_allowed"};
 * - invalid JSON    → 400 {"code":"invalid_argument"};
 * - a full typed client round-trip per method whose request struct's zero
 *   value is guaranteed to pass Bridge validation (see
 *   structZeroValuePassesValidation); methods that may fail validation
 *   assert the 400 {"code":"invalid_argument"} error path instead, which
 *   is deterministic for any contract.
 */
function goRoundtripTestFile(input: GeneratorInput): GeneratedFile | undefined {
  if (!input.generateServices) return undefined;
  const services = sortedServices(input.ir);
  if (services.length === 0) return undefined;

  let body = '';
  for (const service of services) {
    body += goStubServer(service, input);
  }

  const testHelpers = goRoundtripTestHelpers();
  body = testHelpers + body;

  for (const service of services) {
    body += goRoundtripErrorPathTest(service, input);
    for (const method of service.methods) {
      const ref = method.input.kind === 'optional' ? method.input.inner : method.input;
      if (ref.kind !== 'named') continue;
      if (!isLocalStructRef(ref, input.ir)) continue;
      const passesZero = structZeroValuePassesValidation(input.ir, ref.name);
      body += passesZero
        ? goRoundtripSuccessTest(service, method, input)
        : goRoundtripValidationTest(service, method, input);
    }
  }

  const parts = [
    fileHeader('go', input.packageName),
    '',
    goPackageClause(input.packageName),
    '',
    'import (\n\t"context"\n\t"encoding/json"\n\t"net/http"\n\t"net/http/httptest"\n\t"strings"\n\t"testing"\n)',
    '',
    body.trimEnd(),
    '',
  ];
  return generatedFile('roundtrip_test.go', parts.join('\n'));
}

/** Shared assertion helpers for the generated round-trip tests. */
function goRoundtripTestHelpers(): string {
  let out = '';
  out += `${goDoc('bridgeAssertErrorBody decodes a {"code","message"} error body and asserts the code.')}\n`;
  out += 'func bridgeAssertErrorBody(t *testing.T, resp *http.Response, wantCode string) {\n';
  out += '\tt.Helper()\n';
  out += '\tdefer resp.Body.Close()\n';
  out += '\tvar parsed struct {\n';
  out += '\t\tCode    string `json:"code"`\n';
  out += '\t\tMessage string `json:"message"`\n';
  out += '\t}\n';
  out += '\tif err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {\n';
  out += '\t\tt.Fatalf("decode error body: %v", err)\n';
  out += '\t}\n';
  out += '\tif parsed.Code != wantCode {\n';
  out += '\t\tt.Fatalf("error code = %q, want %q", parsed.Code, wantCode)\n';
  out += '\t}\n';
  out += '}\n\n';
  return out;
}

/** Stub server implementation returning zero-value responses. */
function goStubServer(service: IRService, input: GeneratorInput): string {
  let out = '';
  out += `${goDoc(`stub${service.name}Server is a ${service.name}Server returning zero-value responses.`)}\n`;
  out += `type stub${service.name}Server struct{}\n\n`;
  for (const method of service.methods) {
    const inType = methodTypeName(method.input, input);
    const outType = methodTypeName(method.output, input);
    out += `func (s *stub${service.name}Server) ${goSafeIdent(method.name)}(ctx context.Context, req *${inType}) (*${outType}, error) {\n`;
    out += `\t_ = ctx\n`;
    out += `\t_ = req\n`;
    out += `\tvar out ${outType}\n`;
    out += '\treturn &out, nil\n';
    out += '}\n\n';
  }
  return out;
}

/** Deterministic wire-level error-path tests (405 / 404 / invalid JSON). */
function goRoundtripErrorPathTest(service: IRService, input: GeneratorInput): string {
  const first = service.methods[0];
  if (first === undefined) return '';
  const route = `${input.packageName}/${service.name}/${first.name}`;
  const unknownRoute = `${input.packageName}/${service.name}/DefinitelyNotAMethod`;
  let out = '';
  out += `${goDoc(`Test${service.name}MethodNotAllowed asserts POST-only routing on real HTTP.`)}\n`;
  out += `func Test${service.name}MethodNotAllowed(t *testing.T) {\n`;
  out += `\tserver := httptest.NewServer(New${service.name}Handler(&stub${service.name}Server{}))\n`;
  out += '\tdefer server.Close()\n';
  out += `\tresp, err := server.Client().Get(server.URL + ${JSON.stringify(`/${input.packageName}/${service.name}/`)})\n`;
  out += '\tif err != nil {\n\t\tt.Fatalf("get: %v", err)\n\t}\n';
  out += '\tif resp.StatusCode != http.StatusMethodNotAllowed {\n';
  out += '\t\tt.Fatalf("status = %d, want 405", resp.StatusCode)\n\t}\n';
  out += '\tbridgeAssertErrorBody(t, resp, "method_not_allowed")\n';
  out += '}\n\n';
  out += `${goDoc(`Test${service.name}UnknownMethod asserts 404 not_found for unknown methods over real HTTP.`)}\n`;
  out += `func Test${service.name}UnknownMethod(t *testing.T) {\n`;
  out += `\tserver := httptest.NewServer(New${service.name}Handler(&stub${service.name}Server{}))\n`;
  out += '\tdefer server.Close()\n';
  out += `\tresp, err := server.Client().Post(server.URL+${JSON.stringify(`/${unknownRoute}`)}, "application/json", strings.NewReader("{}"))\n`;
  out += '\tif err != nil {\n\t\tt.Fatalf("post: %v", err)\n\t}\n';
  out += '\tif resp.StatusCode != http.StatusNotFound {\n';
  out += '\t\tt.Fatalf("status = %d, want 404", resp.StatusCode)\n\t}\n';
  out += '\tbridgeAssertErrorBody(t, resp, "not_found")\n';
  out += '}\n\n';
  out += `${goDoc(`Test${service.name}InvalidJSON asserts 400 invalid_argument for undecodable bodies over real HTTP.`)}\n`;
  out += `func Test${service.name}InvalidJSON(t *testing.T) {\n`;
  out += `\tserver := httptest.NewServer(New${service.name}Handler(&stub${service.name}Server{}))\n`;
  out += '\tdefer server.Close()\n';
  out += `\tresp, err := server.Client().Post(server.URL+${JSON.stringify(`/${route}`)}, "application/json", strings.NewReader("not-json"))\n`;
  out += '\tif err != nil {\n\t\tt.Fatalf("post: %v", err)\n\t}\n';
  out += '\tif resp.StatusCode != http.StatusBadRequest {\n';
  out += '\t\tt.Fatalf("status = %d, want 400", resp.StatusCode)\n\t}\n';
  out += '\tbridgeAssertErrorBody(t, resp, "invalid_argument")\n';
  out += '}\n\n';
  return out;
}

/** Full typed client round-trip for methods whose zero request validates. */
function goRoundtripSuccessTest(
  service: IRService,
  method: import('@bridge/core').IRMethod,
  input: GeneratorInput,
): string {
  const inType = methodTypeName(method.input, input);
  let out = '';
  out += `${goDoc(`Test${service.name}${method.name}RoundTrip calls the typed JSON client against the generated handler over real HTTP.`)}\n`;
  out += `func Test${service.name}${method.name}RoundTrip(t *testing.T) {\n`;
  out += `\tserver := httptest.NewServer(New${service.name}Handler(&stub${service.name}Server{}))\n`;
  out += '\tdefer server.Close()\n';
  out += `\tclient := New${service.name}JSONClient(server.Client(), server.URL)\n`;
  out += `\treq := &${inType}{}\n`;
  out += `\tif _, err := client.${goSafeIdent(method.name)}(req); err != nil {\n`;
  out += `\t\tt.Fatalf("${method.name}: %v", err)\n\t}\n`;
  out += '}\n\n';
  return out;
}

/**
 * Methods whose zero request may fail Bridge validation assert the
 * deterministic 400 {"code":"invalid_argument"} error path instead.
 */
function goRoundtripValidationTest(
  service: IRService,
  method: import('@bridge/core').IRMethod,
  input: GeneratorInput,
): string {
  const route = `${input.packageName}/${service.name}/${method.name}`;
  let out = '';
  out += `${goDoc(`Test${service.name}${method.name}Validation asserts that a request violating ${methodTypeName(method.input, input)} constraints yields 400 {"code":"invalid_argument"}.`)}\n`;
  out += `func Test${service.name}${method.name}Validation(t *testing.T) {\n`;
  out += `\tserver := httptest.NewServer(New${service.name}Handler(&stub${service.name}Server{}))\n`;
  out += '\tdefer server.Close()\n';
  out += `\tresp, err := server.Client().Post(server.URL+${JSON.stringify(`/${route}`)}, "application/json", strings.NewReader("{}"))\n`;
  out += '\tif err != nil {\n\t\tt.Fatalf("post: %v", err)\n\t}\n';
  out += '\tif resp.StatusCode != http.StatusBadRequest {\n';
  out += '\t\tt.Fatalf("status = %d, want 400", resp.StatusCode)\n\t}\n';
  out += '\tbridgeAssertErrorBody(t, resp, "invalid_argument")\n';
  out += '}\n\n';
  return out;
}

/* ------------------------------------------------------------------ */
/* events.go                                                           */
/* ------------------------------------------------------------------ */

function goEventsFile(input: GeneratorInput): GeneratedFile | undefined {
  if (!input.generateEvents) return undefined;
  if (sortedEvents(input.ir).length === 0) return undefined;

  let body = '';
  body += goEventEnvelopeBlock(input);

  const parts = [
    fileHeader('go', input.packageName),
    '',
    goPackageClause(input.packageName),
    '',
    'import (\n\t"encoding/json"\n\t"fmt"\n\t"sync"\n)',
    '',
    body.trimEnd(),
    '',
  ];
  return generatedFile('events.go', parts.join('\n'));
}

/**
 * Shared envelope machinery: BridgeEventMeta, the CloudEvents-style
 * BridgeEventEnvelope, envelope decode, the generic publisher interface,
 * the in-memory bus and the type-routing dispatcher.
 */
function goEventEnvelopeBlock(input: GeneratorInput): string {
  const events = sortedEvents(input.ir);
  let out = '';
  out += `${goDoc('BridgeEventSpecversion is the CloudEvents spec version emitted in every envelope.')}\n`;
  out += `const BridgeEventSpecversion = ${JSON.stringify(ENVELOPE_SPECVERSION)}\n\n`;
  out += `${goDoc(
    'BridgeEventMeta is the caller-supplied envelope metadata. Generated code\nnever reads the clock or generates ids, so publishers must provide all\nthree values.',
  )}\n`;
  out += 'type BridgeEventMeta struct {\n';
  out += '\tID     string\n';
  out += '\tSource string\n';
  out += '\tTime   string\n';
  out += '}\n\n';
  out += `${goDoc(
    'BridgeEventEnvelope is the CloudEvents-style Bridge event envelope:\n{specversion: "1.0", id, source, type: "<package>.<Event>", time, data}.',
  )}\n`;
  out += 'type BridgeEventEnvelope struct {\n';
  out += '\tSpecversion string          `json:"specversion"`\n';
  out += '\tID          string          `json:"id"`\n';
  out += '\tSource      string          `json:"source"`\n';
  out += '\tType        string          `json:"type"`\n';
  out += '\tTime        string          `json:"time"`\n';
  out += '\tData        json.RawMessage `json:"data"`\n';
  out += '}\n\n';
  out += `${goDoc(
    'DecodeBridgeEventEnvelope decodes and validates the envelope shape\n(specversion "1.0", string id/source/type/time) without touching the\npayload. Per-event decode helpers verify the type and decode `data`.',
  )}\n`;
  out += 'func DecodeBridgeEventEnvelope(data []byte) (BridgeEventEnvelope, error) {\n';
  out += '\tvar envelope BridgeEventEnvelope\n';
  out += '\tif err := json.Unmarshal(data, &envelope); err != nil {\n';
  out += '\t\treturn BridgeEventEnvelope{}, fmt.Errorf("bridge event envelope: %w", err)\n';
  out += '\t}\n';
  out += '\tif envelope.Specversion != BridgeEventSpecversion {\n';
  out += '\t\treturn BridgeEventEnvelope{}, fmt.Errorf("bridge event envelope: unsupported specversion %q", envelope.Specversion)\n';
  out += '\t}\n';
  out += '\tif envelope.ID == "" || envelope.Source == "" || envelope.Type == "" || envelope.Time == "" {\n';
  out += '\t\treturn BridgeEventEnvelope{}, fmt.Errorf("bridge event envelope: expected non-empty id, source, type and time")\n';
  out += '\t}\n';
  out += '\treturn envelope, nil\n';
  out += '}\n\n';
  out += `${goDoc(
    'BridgeEventPublisher publishes a raw payload under an event type; the\ntransport (bus, broker, queue) builds the envelope from `meta`.',
  )}\n`;
  out += 'type BridgeEventPublisher interface {\n';
  out += '\tPublish(eventType string, payload any, meta BridgeEventMeta) error\n';
  out += '}\n\n';
  out += `${goDoc(
    'InMemoryEventBus is an in-memory BridgeEventPublisher: it hands envelopes\nto per-type subscribers. Ideal for tests and in-process wiring; swap for a\nreal transport in production.',
  )}\n`;
  out += 'type bridgeEventSubscriber func(BridgeEventEnvelope)\n\n';
  out += 'type InMemoryEventBus struct {\n';
  out += '\tmu          sync.Mutex\n';
  out += '\tsubscribers map[string][]*bridgeEventSubscriber\n';
  out += '}\n\n';
  out += `${goDoc('Subscribe registers a subscriber for an event type; the returned func unsubscribes.')}\n`;
  out += 'func (b *InMemoryEventBus) Subscribe(eventType string, subscriber bridgeEventSubscriber) func() {\n';
  out += '\tentry := &subscriber\n';
  out += '\tb.mu.Lock()\n';
  out += '\tdefer b.mu.Unlock()\n';
  out += '\tif b.subscribers == nil {\n';
  out += '\t\tb.subscribers = make(map[string][]*bridgeEventSubscriber)\n';
  out += '\t}\n';
  out += '\tb.subscribers[eventType] = append(b.subscribers[eventType], entry)\n';
  out += '\treturn func() {\n';
  out += '\t\tb.mu.Lock()\n';
  out += '\t\tdefer b.mu.Unlock()\n';
  out += '\t\tcurrent := b.subscribers[eventType]\n';
  out += '\t\tfiltered := current[:0]\n';
  out += '\t\tfor _, existing := range current {\n';
  out += '\t\t\tif existing != entry {\n';
  out += '\t\t\t\tfiltered = append(filtered, existing)\n';
  out += '\t\t\t}\n';
  out += '\t\t}\n';
  out += '\t\tb.subscribers[eventType] = filtered\n';
  out += '\t}\n';
  out += '}\n\n';
  out += `${goDoc('Publish marshals the payload and delivers the envelope to every subscriber of the type.')}\n`;
  out += 'func (b *InMemoryEventBus) Publish(eventType string, payload any, meta BridgeEventMeta) error {\n';
  out += '\tdata, err := json.Marshal(payload)\n';
  out += '\tif err != nil {\n';
  out += '\t\treturn fmt.Errorf("marshal event payload: %w", err)\n';
  out += '\t}\n';
  out += '\tenvelope := BridgeEventEnvelope{\n';
  out += '\t\tSpecversion: BridgeEventSpecversion,\n';
  out += '\t\tID:          meta.ID,\n';
  out += '\t\tSource:      meta.Source,\n';
  out += '\t\tType:        eventType,\n';
  out += '\t\tTime:        meta.Time,\n';
  out += '\t\tData:        data,\n';
  out += '\t}\n';
  out += '\tb.mu.Lock()\n';
  out += '\tsubscribers := make([]*bridgeEventSubscriber, len(b.subscribers[eventType]))\n';
  out += '\tcopy(subscribers, b.subscribers[eventType])\n';
  out += '\tb.mu.Unlock()\n';
  out += '\tfor _, subscriber := range subscribers {\n';
  out += '\t\t(*subscriber)(envelope)\n';
  out += '\t}\n';
  out += '\treturn nil\n';
  out += '}\n\n';
  out += `${goDoc(
    'BridgeEventDispatcher routes Bridge event envelopes (decoded JSON or\nin-memory) to the registered per-event handlers by their `type`. Dispatch\nerrors on unknown types.',
  )}\n`;
  out += 'type BridgeEventDispatcher struct {\n';
  out += '\thandlers map[string][]func(BridgeEventEnvelope)\n';
  out += '}\n\n';
  out += `${goDoc('NewBridgeEventDispatcher creates an empty dispatcher.')}\n`;
  out += 'func NewBridgeEventDispatcher() *BridgeEventDispatcher {\n';
  out += '\treturn &BridgeEventDispatcher{handlers: make(map[string][]func(BridgeEventEnvelope))}\n';
  out += '}\n\n';
  for (const event of events) {
    out += `${goDoc(`On${event.name} registers a typed handler for ${event.name} events.`)}\n`;
    out += `func (d *BridgeEventDispatcher) On${event.name}(handler func(payload ${event.name}, meta BridgeEventMeta)) *BridgeEventDispatcher {\n`;
    out += `\td.handlers[${JSON.stringify(eventTypeName(input.packageName, event.name))}] = append(d.handlers[${JSON.stringify(eventTypeName(input.packageName, event.name))}], func(envelope BridgeEventEnvelope) {\n`;
    out += '\t\tvar payload ' + event.name + '\n';
    out += '\t\t_ = json.Unmarshal(envelope.Data, &payload)\n';
    out += `\t\thandler(payload, BridgeEventMeta{ID: envelope.ID, Source: envelope.Source, Time: envelope.Time})\n`;
    out += '\t})\n';
    out += '\treturn d\n';
    out += '}\n\n';
  }
  out += `${goDoc(
    'Dispatch decodes the envelope and runs every handler registered for its\ntype. Returns an error for malformed envelopes and unknown event types.',
  )}\n`;
  out += 'func (d *BridgeEventDispatcher) Dispatch(data []byte) error {\n';
  out += '\tenvelope, err := DecodeBridgeEventEnvelope(data)\n';
  out += '\tif err != nil {\n';
  out += '\t\treturn err\n';
  out += '\t}\n';
  out += '\thandlers, ok := d.handlers[envelope.Type]\n';
  out += '\tif !ok || len(handlers) == 0 {\n';
  out += '\t\treturn fmt.Errorf("no handler registered for event type %q", envelope.Type)\n';
  out += '\t}\n';
  out += '\tfor _, handler := range handlers {\n';
  out += '\t\thandler(envelope)\n';
  out += '\t}\n';
  out += '\treturn nil\n';
  out += '}\n\n';
  for (const event of events) {
    out += goEvent(event, input);
  }
  return out;
}

function goEvent(event: import('@bridge/core').IREvent, input: GeneratorInput): string {
  let out = '';
  const typeConst = `${event.name}Type`;
  const fqType = eventTypeName(input.packageName, event.name);
  out += `${goDoc(`${event.name}Type is the fully-qualified event type (${fqType}).`)}\n`;
  out += `const ${typeConst} = ${JSON.stringify(fqType)}\n\n`;

  const doc = goDoc(event.docs);
  if (doc.length > 0) out += `${doc}\n`;
  out += `type ${event.name} struct {\n`;
  for (const field of event.fields) {
    const fdoc = goDoc(field.docs, field.deprecated);
    if (fdoc.length > 0) out += `${tab(fdoc)}\n`;
    const base = renderTypeRef(field.type, input.render);
    const goType = field.optional && field.type.kind !== 'optional' ? `*${base}` : base;
    const tag = field.optional ? `json:"${field.name},omitempty"` : `json:"${field.name}"`;
    out += `\t${goExportedName(field.name)} ${goType} \`${tag}\`\n`;
  }
  out += '}\n\n';

  out += `${goDoc(`Encode${event.name} wraps the event into the CloudEvents-style Bridge envelope with caller-supplied metadata.`)}\n`;
  out += `func Encode${event.name}(payload ${event.name}, meta BridgeEventMeta) (BridgeEventEnvelope, error) {\n`;
  out += '\tdata, err := json.Marshal(payload)\n';
  out += '\tif err != nil {\n';
  out += '\t\treturn BridgeEventEnvelope{}, fmt.Errorf("marshal ' + event.name + ': %w", err)\n';
  out += '\t}\n';
  out += '\treturn BridgeEventEnvelope{\n';
  out += '\t\tSpecversion: BridgeEventSpecversion,\n';
  out += '\t\tID:          meta.ID,\n';
  out += '\t\tSource:      meta.Source,\n';
  out += `\t\tType:        ${typeConst},\n`;
  out += '\t\tTime:        meta.Time,\n';
  out += '\t\tData:        data,\n';
  out += '\t}, nil\n';
  out += '}\n\n';

  out += `${goDoc(`Decode${event.name} decodes an envelope, verifying specversion and the event type, and decodes the payload.`)}\n`;
  out += `func Decode${event.name}(data []byte) (${event.name}, BridgeEventEnvelope, error) {\n`;
  out += '\tenvelope, err := DecodeBridgeEventEnvelope(data)\n';
  out += '\tif err != nil {\n';
  out += `\t\treturn ${event.name}{}, BridgeEventEnvelope{}, err\n`;
  out += '\t}\n';
  out += `\tif envelope.Type != ${typeConst} {\n`;
  out += `\t\treturn ${event.name}{}, envelope, fmt.Errorf("unexpected event type %q, want %q", envelope.Type, ${typeConst})\n`;
  out += '\t}\n';
  out += `\tvar payload ${event.name}\n`;
  out += '\tif err := json.Unmarshal(envelope.Data, &payload); err != nil {\n';
  out += `\t\treturn ${event.name}{}, envelope, fmt.Errorf("decode ${event.name} payload: %w", err)\n`;
  out += '\t}\n';
  out += '\treturn payload, envelope, nil\n';
  out += '}\n\n';
  return out;
}

/** Method input/output type: named refs render as the type name. */
function methodTypeName(ref: TypeRef, input: GeneratorInput): string {
  if (ref.kind === 'named') return ref.name;
  return renderTypeRef(ref, input.render);
}
