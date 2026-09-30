/**
 * Python generator.
 *
 * Emits, in order: pyproject.toml, <module>/__init__.py, <module>/enums.py,
 * <module>/models.py, <module>/validation.py, <module>/services.py,
 * <module>/events.py. Files without content are skipped (e.g. enums.py when
 * the package declares no enums), keeping the file list deterministic.
 *
 * Python-specific decisions (documented in generated files too):
 * - Stdlib only: dataclasses, typing, enum, json, base64, urllib.request,
 *   re. No third-party dependencies.
 * - Structs map to `@dataclass` classes with full type annotations.
 *   Dataclass field order puts required fields (no default) first — Python
 *   requires non-default fields before defaulted ones — while `to_dict`
 *   keeps the declared IR field order for the wire dict.
 * - Optional fields map to `field: T | None = None`; absent keys decode to
 *   None, None keys are skipped in to_dict.
 * - `bytes` maps to `bytes`; on the JSON wire it is a base64 string.
 *   to_dict/from_dict convert with the stdlib base64 module.
 * - `set<T>` maps to `set[T]`; the wire format is ALWAYS a JSON array and
 *   to_dict sorts elements into the canonical Bridge set order (numbers
 *   numerically, strings by code point, False < True — identical in all
 *   six targets, #117).
 * - Enums map to `class Name(str, Enum)` with the declared SCREAMING_SNAKE
 *   names as both member names and values; `parse_<Name>` raises ValueError
 *   on unknown wire values.
 * - Tagged unions map to a dataclass with `kind: str` + `value: Any` and
 *   per-variant classmethods, matching the {"kind", "value"} wire format
 *   used by Go/TS/Rust.
 * - Cross-package references become `Name = Any` opaque aliases documented
 *   as "imported from <pkg>".
 * - Validation lives in validation.py as `validate_<name>(value) -> list[str]`
 *   functions; model classes expose a `validate()` method that delegates via
 *   a lazy import (avoids a models<->validation import cycle).
 * - Services map to a synchronous `<Service>Client` using urllib.request,
 *   POSTing JSON to `/<package>/<Service>/<Method>`.
 * - Events map to payload dataclasses plus the Bridge wire envelope
 *   {"event": name, "payload": {...}} with wrap/unwrap helpers.
 */

import type {
  IRConstraint,
  IRField,
  IRService,
  IRTypeDefinition,
  IREvent,
  PrimitiveKind,
  TypeRef,
} from '@bridge/core';
import { generatedFile, joinBlocks } from '../util';
import { fileHeader } from '../header';
import { pythonDocstring, pythonFieldComment } from '../docs';
import { NUMERIC_PRIMITIVES, isLocalStructRef, renderTypeRef } from '../mappings';
import { crossPackageRefs, sortedEvents, sortedServices, sortedTypes } from '../analysis';
import { pythonEventsFileV2, pythonServerBlocks } from './python-wire';
import {
  camelToScreamingSnake,
  camelToLowerSnake,
  pythonEnumMemberName,
  pythonFieldName,
  pythonModuleName,
  pythonUnionVariantMethod,
  rustCrateName,
} from '../naming';
import type { GeneratedFile, GeneratorInput } from './input';

/** Generates the Python project for an IR package. */
export function generatePython(input: GeneratorInput): GeneratedFile[] {
  const files: GeneratedFile[] = [pyprojectFile(input)];
  const module = pythonModuleName(input.packageName).replace(/-/g, '_');

  const enums = pythonEnumsFile(input, module);
  const models = pythonModelsFile(input, module);
  const validation = pythonValidationFile(input, module);
  const services = pythonServicesFile(input, module);
  const events = pythonEventsFile(input, module);

  files.push(pythonInitFile(input, module, { enums, models, validation, services, events }));
  if (enums !== undefined) files.push(enums);
  if (models !== undefined) files.push(models);
  if (validation !== undefined) files.push(validation);
  if (services !== undefined) files.push(services);
  if (events !== undefined) files.push(events);
  return files;
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

/** Python annotation for a field; optional fields are `T | None`. */
export function pythonFieldType(field: IRField, input: GeneratorInput): string {
  const base = renderTypeRef(field.type, input.render);
  if (field.optional && field.type.kind !== 'optional') return `${base} | None`;
  return base;
}

/** Wire-name-aware field name (Python keywords get a trailing underscore). */
export function pyField(field: IRField): string {
  return pythonFieldName(field.name).name;
}

/** True when the field needs a dataclass default (optional or declared default). */
function hasDataclassDefault(field: IRField): boolean {
  return field.optional || field.default !== undefined;
}

/** Renders the default expression for a dataclass field, if any. */
function dataclassDefault(field: IRField, input: GeneratorInput): string | undefined {
  if (field.optional) return 'None';
  if (field.default === undefined) return undefined;
  const literal = pythonDefaultLiteral(field.default, field.type);
  return literal ?? undefined;
}

/**
 * Default-value literal rendering. Mirrors the semantics of
 * `defaultLiteral` in mappings.ts but with Python literals (True/False).
 */
function pythonDefaultLiteral(
  defaultValue: string,
  ref: TypeRef,
): string | undefined {
  const raw = defaultValue.trim();
  if (raw.length === 0) return undefined;
  let inner = raw;
  if (
    (inner.startsWith('"') && inner.endsWith('"') && inner.length >= 2) ||
    (inner.startsWith("'") && inner.endsWith("'") && inner.length >= 2)
  ) {
    inner = inner.slice(1, -1);
  }
  if (ref.kind === 'primitive' && ref.primitive === 'bool') {
    if (inner === 'true') return 'True';
    if (inner === 'false') return 'False';
    return undefined;
  }
  if (ref.kind === 'primitive' && NUMERIC_PRIMITIVES.has(ref.primitive)) {
    return /^[+-]?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(inner) ? inner : undefined;
  }
  if (ref.kind === 'primitive' && STRING_LIKE.has(ref.primitive)) {
    return JSON.stringify(inner);
  }
  return undefined;
}

const STRING_LIKE: ReadonlySet<PrimitiveKind> = new Set([
  'string', 'uuid', 'timestamp', 'decimal',
]);

/** Constraint check lines for one field inside a validate function. */
function constraintChecks(
  typeName: string,
  field: IRField,
  input: GeneratorInput,
  accessor: string,
): string[] {
  const out: string[] = [];
  const label = `${typeName}.${field.name}`;
  for (const constraint of field.constraints) {
    const render = renderConstraintCheck(constraint, field, input, accessor, label);
    if (render !== undefined) out.push(...render);
  }
  return out;
}

/** Renders one constraint as Python if/append lines. */
function renderConstraintCheck(
  constraint: IRConstraint,
  field: IRField,
  input: GeneratorInput,
  accessor: string,
  label: string,
): string[] | undefined {
  const message = constraint.message ?? `${label}: ${constraint.kind} constraint violated`;
  const fail = `errors.append(${JSON.stringify(message)})`;
  const arg = constraint.args[0];
  switch (constraint.kind) {
    case 'min': {
      if (arg === undefined) return undefined;
      return [`    if ${accessor} < ${arg}:`, `        ${fail}`];
    }
    case 'max': {
      if (arg === undefined) return undefined;
      return [`    if ${accessor} > ${arg}:`, `        ${fail}`];
    }
    case 'length': {
      if (arg === undefined) return undefined;
      return [`    if len(${accessor}) != ${arg}:`, `        ${fail}`];
    }
    case 'email': {
      return [
        `    if not EMAIL_RE.fullmatch(${accessor}):`,
        `        ${fail}`,
      ];
    }
    case 'url': {
      return [
        `    if not URL_RE.fullmatch(${accessor}):`,
        `        ${fail}`,
      ];
    }
    case 'uuid': {
      return [
        `    if not UUID_RE.fullmatch(${accessor}):`,
        `        ${fail}`,
      ];
    }
    case 'pattern': {
      if (arg === undefined) return undefined;
      return [
        `    if not re.fullmatch(${JSON.stringify(arg)}, ${accessor}):`,
        `        ${fail}`,
      ];
    }
    default:
      return undefined;
  }
}

/** True when the ref is a local struct (nested validation applies). */
function isNestedStruct(ref: TypeRef, input: GeneratorInput): boolean {
  let inner = ref;
  if (inner.kind === 'optional') inner = inner.inner;
  if (inner.kind !== 'named') return false;
  if (inner.package !== undefined && inner.package !== input.ir.name) return false;
  const local = input.ir.types.find((t) => t.name === inner.name);
  return local !== undefined && local.kind === 'struct';
}

/* ------------------------------------------------------------------ */
/* pyproject.toml                                                      */
/* ------------------------------------------------------------------ */

function pyprojectFile(input: GeneratorInput): GeneratedFile {
  const distName = rustCrateName(input.packageName, 'bridge');
  const lines = [
    fileHeader('python', input.packageName),
    '[build-system]',
    'requires = ["setuptools>=68"]',
    'build-backend = "setuptools.build_meta"',
    '',
    '[project]',
    `name = "${distName}"`,
    'version = "0.1.0"',
    `description = "Generated Bridge contracts for ${input.packageName}."`,
    'requires-python = ">=3.10"',
    'dependencies = []',
    '',
    '[tool.setuptools.packages.find]',
    `include = ["${pythonModuleName(input.packageName).replace(/-/g, '_')}*"]`,
    '',
  ];
  return generatedFile('pyproject.toml', lines.join('\n'));
}

/* ------------------------------------------------------------------ */
/* enums.py                                                            */
/* ------------------------------------------------------------------ */

function pythonEnumsFile(
  input: GeneratorInput,
  module: string,
): GeneratedFile | undefined {
  const enums = sortedTypes(input.ir).filter((t) => t.kind === 'enum');
  if (enums.length === 0) return undefined;

  const blocks: string[] = [];
  blocks.push(
    [
      '"""Enum types for the Bridge generated package.',
      '',
      'Enum members and values use the declared SCREAMING_SNAKE_CASE wire names.',
      'parse helpers raise ValueError on unknown wire values.',
      '"""',
    ].join('\n'),
  );
  blocks.push('import enum');

  for (const enumType of enums) {
    if (enumType.kind !== 'enum') continue;
    const doc = pythonDocstring(enumType.docs, enumType.deprecated);
    const lines: string[] = [];
    lines.push(`class ${enumType.name}(str, enum.Enum):`);
    if (doc !== undefined) lines.push(doc);
    for (const variant of enumType.variants) {
      const vdoc = pythonFieldComment(variant.docs, variant.deprecated);
      if (vdoc !== undefined) lines.push(vdoc);
      // Member identifiers are keyword-escaped (issue #116 class 5): a
      // variant named `pass` would emit `pass = "pass"`, a SyntaxError.
      // The VALUE stays the declared wire name, so parse_<Name> and the
      // str,Enum wire contract keep the original text.
      const member = pythonEnumMemberName(variant.name).name;
      lines.push(`    ${member} = ${JSON.stringify(variant.name)}`);
    }
    lines.push('');
    lines.push('');
    lines.push(`def parse_${enumType.name}(value: str) -> ${enumType.name}:`);
    lines.push(
      `    """Parse a wire value into ${enumType.name}; raises ValueError when unknown."""`,
    );
    lines.push('    try:');
    lines.push(`        return ${enumType.name}(value)`);
    lines.push('    except ValueError as exc:');
    const allowed = enumType.variants.map((v) => `'${v.name}'`).join(', ');
    lines.push(
      `        raise ValueError(f"Unknown ${enumType.name} value: {value!r}. Allowed: ${allowed}") from exc`,
    );
    blocks.push(lines.join('\n'));
  }

  const content = [fileHeader('python', input.packageName), joinBlocks(blocks), ''].join('\n');
  return generatedFile(`${module}/enums.py`, content);
}

/* ------------------------------------------------------------------ */
/* models.py                                                           */
/* ------------------------------------------------------------------ */

function pythonModelsFile(
  input: GeneratorInput,
  module: string,
): GeneratedFile | undefined {
  const types = sortedTypes(input.ir);
  if (types.length === 0) return undefined;

  const blocks: string[] = [];
  blocks.push(
    [
      '"""Model types for the Bridge generated package.',
      '',
      'Structs are dataclasses. Field order puts required fields first',
      '(Python requires non-default fields before defaulted ones); to_dict',
      'keeps the declared field order on the wire.',
      '"""',
    ].join('\n'),
  );
  blocks.push('from __future__ import annotations');
  blocks.push('');
  blocks.push('import base64');
  blocks.push('from dataclasses import dataclass');
  blocks.push('from typing import Any');

  const cross = crossPackageRefs(input.ir);
  const hasUnion = types.some((t) => t.kind === 'union');
  const importsEnums = types.some(
    (t) =>
      (t.kind === 'struct' && t.fields.some((f) => f.type.kind === 'named' && isLocalEnum(f.type, input))) ||
      (t.kind === 'union' && t.variants.some((v) => v.type.kind === 'named' && isLocalEnum(v.type, input))),
  );
  if (importsEnums) blocks.push(`from .enums import *  # noqa: F401,F403 — enum re-exports for annotations`);

  const modelNames: string[] = [];
  const aliasLines: string[] = [];

  for (const crossRef of cross) {
    aliasLines.push(`${crossRef.name} = Any  # imported from ${crossRef.fromPackage}; regenerate with that package for full types`);
  }

  // Aliases are top-level assignments: they belong after all imports
  // (`from __future__` must be the first statement after the docstring).
  if (aliasLines.length > 0) {
    blocks.push(aliasLines.join('\n'));
  }

  for (const type of types) {
    switch (type.kind) {
      case 'struct':
        blocks.push(renderStruct(type, input, module));
        modelNames.push(type.name);
        break;
      case 'union':
        blocks.push(renderUnion(type, input, module));
        modelNames.push(type.name);
        break;
      case 'alias':
        aliasLines.push(...renderAlias(type, input));
        break;
      case 'enum':
        break;
    }
  }

  // Alias declarations rendered for local alias types (cross-package ones
  // were already emitted above): append them after structs/unions.
  if (aliasLines.length > cross.length) {
    const localAliasLines = aliasLines.slice(cross.length);
    blocks.push(localAliasLines.join('\n'));
  }

  const content = [fileHeader('python', input.packageName), joinBlocks(blocks), ''].join('\n');
  return generatedFile(`${module}/models.py`, content);
}

function isLocalEnum(ref: TypeRef, input: GeneratorInput): boolean {
  if (ref.kind !== 'named') return false;
  if (ref.package !== undefined && ref.package !== input.ir.name) return false;
  const local = input.ir.types.find((t) => t.name === ref.name);
  return local !== undefined && local.kind === 'enum';
}

/** Renders one struct as a dataclass with to_dict/from_dict/validate. */
function renderStruct(
  type: IRTypeDefinition & { kind: 'struct' },
  input: GeneratorInput,
  module: string,
): string {
  const lines: string[] = [];
  const doc = pythonDocstring(type.docs, type.deprecated);
  lines.push('@dataclass');
  lines.push(`class ${type.name}:`);
  lines.push(doc ?? `    """${type.name} generated from the Bridge contract."""`);

  // Dataclass ordering: required (no default) first, then defaulted.
  const required = type.fields.filter((f) => !hasDataclassDefault(f));
  const defaulted = type.fields.filter((f) => hasDataclassDefault(f));
  const ordered = [...required, ...defaulted];

  for (const field of ordered) {
    const comment = pythonFieldComment(field.docs, field.deprecated);
    if (comment !== undefined) lines.push(comment);
    if (field.default !== undefined && !field.optional) {
      lines.push(`    # Default: ${field.default}`);
    }
    const defExpr = dataclassDefault(field, input);
    const defaultPart = defExpr !== undefined ? ` = ${defExpr}` : '';
    lines.push(`    ${pyField(field)}: ${pythonFieldType(field, input)}${defaultPart}`);
  }
  if (type.fields.length === 0) {
    lines.push('    pass');
  }

  lines.push('');
  lines.push('    def validate(self) -> "list[str]":');
  lines.push(`        from .validation import validate_${type.name}`);
  lines.push('');
  lines.push(`        return validate_${type.name}(self)`);

  // to_dict — declared field order, wire names.
  lines.push('');
  lines.push('    def to_dict(self) -> "dict[str, Any]":');
  lines.push(`        """Serialize to the Bridge wire representation."""`);
  lines.push('        out: "dict[str, Any]" = {}');
  for (const field of type.fields) {
    const expr = toDictExpr(field, input);
    const key = JSON.stringify(field.name);
    if (field.optional) {
      lines.push(`        if self.${pyField(field)} is not None:`);
      lines.push(`            out[${key}] = ${expr}`);
    } else {
      lines.push(`        out[${key}] = ${expr}`);
    }
  }
  lines.push('        return out');

  // from_dict — classmethod decoder. The parameter (`raw_data`) and the
  // per-field temp (`raw_value`) use bridge-prefixed raw-style names, not
  // `data`/`raw`: a declared field sharing a decoder-local name would
  // rebind it mid-decode (field `data` used to emit `data = data.get(...)`
  // and the following `data.get(...)` raised AttributeError). Both names
  // are in PYTHON_RESERVED_MEMBERS (naming.ts), so no declared field can
  // ever take them either — defense in depth, mirroring the TS generator's
  // __bridge_ validator locals.
  lines.push('');
  lines.push('    @classmethod');
  lines.push(`    def from_dict(cls, raw_data: "dict[str, Any]") -> "${type.name}":`);
  lines.push(`        """Decode from the Bridge wire representation; raises ValueError on missing required fields."""`);
  for (const field of type.fields) {
    const key = JSON.stringify(field.name);
    const expr = fromDictExpr(field, input, `raw_data.get(${key})`);
    if (field.optional || field.default !== undefined) {
      const defExpr = dataclassDefault(field, input);
      const fallback = field.optional ? 'None' : (defExpr ?? 'None');
      // Explicit JSON null behaves like a missing key (parity with the Java
      // and C# decoders): it must not smuggle None past a field default.
      lines.push(`        raw_value = raw_data.get(${key})`);
      lines.push(`        if raw_value is None:`);
      lines.push(`            raw_value = ${fallback}`);
      lines.push(`        ${pyField(field)} = ${deserializeExpr(field.type, 'raw_value', input, true)}`);
    } else {
      lines.push(`        if raw_data.get(${key}) is None:`);
      lines.push(`            raise ValueError("Missing required field ${field.name} for ${type.name}")`);
      lines.push(`        ${pyField(field)} = ${expr}`);
    }
  }
  lines.push('        return cls(');
  for (const field of type.fields) {
    lines.push(`            ${pyField(field)}=${pyField(field)},`);
  }
  lines.push('        )');
  return lines.join('\n');
}

/** to_dict conversion expression for a field value. */
function toDictExpr(field: IRField, input: GeneratorInput): string {
  const value = `self.${pyField(field)}`;
  return serializeExpr(field.type, value, input);
}

/** Serialization expression for a TypeRef value. */
export function serializeExpr(ref: TypeRef, value: string, input: GeneratorInput): string {
  switch (ref.kind) {
    case 'primitive':
      if (ref.primitive === 'bytes') return `base64.b64encode(${value}).decode("ascii")`;
      if (ref.primitive === 'json') return value;
      if (isEnumPrimitiveWire(ref.primitive)) return value;
      return value;
    case 'named': {
      const local = input.ir.types.find((t) => t.name === ref.name);
      if (local !== undefined && local.kind === 'enum') return `${value}.value`;
      if (local !== undefined && local.kind === 'struct') return `${value}.to_dict()`;
      return value;
    }
    case 'list':
      return `[${serializeExpr(ref.element, 'item', input)} for item in ${value}]`;
    case 'set':
      // Deterministic wire output: the canonical Bridge set order (#117).
      // Python's sorted() already implements it for the primitives Bridge
      // allows in sets: numbers numerically, str by code point, bool
      // False < True; sets are homogeneous by contract.
      return `sorted(${serializeSetElement(ref.element, value, input)})`;
    case 'map':
      return `{str(k): ${serializeExpr(ref.value, 'v', input)} for k, v in ${value}.items()}`;
    case 'optional':
      return serializeExpr(ref.inner, value, input);
  }
}

function serializeSetElement(element: TypeRef, value: string, input: GeneratorInput): string {
  // Sets serialize element-wise into a JSON array; elements must be
  // sortable, which holds for the primitives Bridge allows in sets.
  return serializeExpr(element, value, input);
}

function isEnumPrimitiveWire(_p: PrimitiveKind): boolean {
  return false;
}

/** from_dict conversion expression for a raw value expression. */
function fromDictExpr(field: IRField, input: GeneratorInput, raw: string): string {
  return deserializeExpr(field.type, raw, input, field.optional);
}

/** Deserialization expression for a TypeRef raw value. */
export function deserializeExpr(ref: TypeRef, raw: string, input: GeneratorInput, optional: boolean): string {
  const noneGuard = (expr: string): string =>
    optional ? `None if ${raw} is None else ${expr}` : expr;
  switch (ref.kind) {
    case 'primitive':
      if (ref.primitive === 'bytes') {
        return noneGuard(`base64.b64decode(${raw})`);
      }
      if (NUMERIC_PRIMITIVES.has(ref.primitive)) {
        return `${raw}`; // JSON numbers decode to int/float natively
      }
      return raw;
    case 'named': {
      const local = input.ir.types.find((t) => t.name === ref.name);
      if (local !== undefined && local.kind === 'enum') {
        return noneGuard(`parse_${ref.name}(${raw})`);
      }
      if (local !== undefined && local.kind === 'struct') {
        return noneGuard(`${ref.name}.from_dict(${raw})`);
      }
      return raw;
    }
    case 'list':
      return noneGuard(
        `[${deserializeExpr(ref.element, 'item', input, false)} for item in ${raw}]`,
      );
    case 'set':
      return noneGuard(
        `set(${deserializeExpr(ref.element, 'item', input, false)} for item in ${raw})`,
      );
    case 'map':
      return noneGuard(
        `{str(k): ${deserializeExpr(ref.value, 'v', input, false)} for k, v in ${raw}.items()}`,
      );
    case 'optional':
      return deserializeExpr(ref.inner, raw, input, true);
  }
}

/** Renders an alias declaration block. */
function renderAlias(
  type: IRTypeDefinition & { kind: 'alias' },
  input: GeneratorInput,
): string[] {
  const lines: string[] = [];
  const doc = pythonDocstring(type.docs, type.deprecated, 0);
  if (doc !== undefined) lines.push(doc);
  lines.push(`${type.name} = ${renderTypeRef(type.target, input.render)}`);
  return lines;
}

/** Renders a tagged union as a kind/value dataclass. */
function renderUnion(
  type: IRTypeDefinition & { kind: 'union' },
  input: GeneratorInput,
  _module: string,
): string {
  const lines: string[] = [];
  lines.push('@dataclass');
  lines.push(`class ${type.name}:`);
  const doc = pythonDocstring(
    type.docs !== undefined
      ? `${type.docs}\nWire format: {"kind": "<variant>", "value": <payload>}.`
      : 'Tagged union. Wire format: {"kind": "<variant>", "value": <payload>}.',
    type.deprecated,
  );
  if (doc !== undefined) lines.push(doc);
  lines.push('    kind: str');
  lines.push('    value: Any');

  for (const variant of type.variants) {
    const vdoc = pythonFieldComment(variant.docs, variant.deprecated, 4);
    lines.push('');
    lines.push('    @classmethod');
    lines.push(`    def ${pythonUnionVariantMethod(variant.name)}(cls, value: ${renderTypeRef(variant.type, input.render)}) -> "${type.name}":`);
    if (vdoc !== undefined) lines.push(vdoc);
    lines.push(`        return cls(kind=${JSON.stringify(variant.name)}, value=value)`);
  }

  lines.push('');
  lines.push('    def to_dict(self) -> "dict[str, Any]":');
  lines.push('        out: "dict[str, Any]" = {"kind": self.kind}');
  lines.push('        v = self.value');
  for (const variant of type.variants) {
    lines.push(`        if self.kind == ${JSON.stringify(variant.name)}:`);
    lines.push(`            out["value"] = ${serializeExpr(variant.type, 'v', input)}`);
    lines.push('            return out');
  }
  lines.push('        out["value"] = v');
  lines.push('        return out');

  lines.push('');
  lines.push('    @classmethod');
  lines.push(`    def from_dict(cls, raw_data: "dict[str, Any]") -> "${type.name}":`);
  lines.push('        kind = raw_data.get("kind")');
  lines.push('        raw_value = raw_data.get("value")');
  for (const variant of type.variants) {
    lines.push(`        if kind == ${JSON.stringify(variant.name)}:`);
    lines.push(`            return cls(kind=${JSON.stringify(variant.name)}, value=${deserializeExpr(variant.type, 'raw_value', input, false)})`);
  }
  lines.push('        raise ValueError(f"Unknown {type.__name__} kind: {kind!r}")');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* validation.py                                                       */
/* ------------------------------------------------------------------ */

function pythonValidationFile(
  input: GeneratorInput,
  module: string,
): GeneratedFile | undefined {
  const structs = sortedTypes(input.ir).filter((t) => t.kind === 'struct');
  if (structs.length === 0) return undefined;

  const needsRegex = structs.some(
    (t) =>
      t.kind === 'struct' &&
      t.fields.some((f) =>
        f.constraints.some((c) => c.kind === 'email' || c.kind === 'url' || c.kind === 'uuid'),
      ),
  );

  const blocks: string[] = [];
  blocks.push(
    [
      '"""Validation for the Bridge generated package.',
      '',
      'Each validate function returns a list of violation messages (empty',
      'means valid). Required-field presence is enforced by from_dict; these',
      'functions check constraints and recurse into struct-typed fields.',
      '"""',
    ].join('\n'),
  );
  blocks.push('from __future__ import annotations');
  blocks.push('');
  if (needsRegex) {
    blocks.push('import re');
    blocks.push('');
    blocks.push('EMAIL_RE = re.compile(r"[^@\\s]+@[^@\\s]+\\.[^@\\s]+")');
    blocks.push('URL_RE = re.compile(r"https?://\\S+")');
    blocks.push(
      'UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")',
    );
  }
  blocks.push(`from .models import *  # noqa: F401,F403 — model types for annotations`);

  for (const structType of structs) {
    if (structType.kind !== 'struct') continue;
    const lines: string[] = [];
    lines.push(`def validate_${structType.name}(value: ${structType.name}) -> "list[str]":`);
    lines.push(`    """Validate a ${structType.name} instance; returns violation messages."""`);
    lines.push('    errors: "list[str]" = []');
    for (const field of structType.fields) {
      const accessor = `value.${pyField(field)}`;
      const constraintLines = constraintChecks(structType.name, field, input, accessor);
      const nestedLines = nestedValidationLines(field, input, accessor);
      const body = [...constraintLines, ...nestedLines];
      const indentedBody = body.map((line) => (line.length > 0 ? `    ${line}` : line));

      if (field.optional) {
        if (indentedBody.length === 0) continue;
        lines.push(`    if ${accessor} is not None:`);
        lines.push(...indentedBody);
      } else {
        lines.push(`    if ${accessor} is None:`);
        lines.push(`        errors.append(${JSON.stringify(`${structType.name}.${field.name}: required field is None`)})`);
        if (indentedBody.length > 0) {
          lines.push('    else:');
          lines.push(...indentedBody);
        }
      }
    }
    lines.push('    return errors');
    blocks.push(lines.join('\n'));
  }

  const content = [fileHeader('python', input.packageName), joinBlocks(blocks), ''].join('\n');
  return generatedFile(`${module}/validation.py`, content);
}

/** Emits nested validation lines for struct-typed fields. */
function nestedValidationLines(
  field: IRField,
  input: GeneratorInput,
  accessor: string,
): string[] {
  if (!isNestedStruct(field.type, input)) return [];
  let ref = field.type;
  if (ref.kind === 'optional') ref = ref.inner;
  const target = (ref as { name: string }).name;
  // Base indent of 4 spaces, matching constraintChecks line convention.
  const lines: string[] = [`    errors.extend(validate_${target}(${accessor}))`];
  // Lists of structs: validate each element.
  let inner = field.type;
  if (inner.kind === 'optional') inner = inner.inner;
  if (inner.kind === 'list' && isNestedStruct(inner.element, input)) {
    const elemTarget = (inner.element as { name: string }).name;
    lines.push(
      `    for i, item in enumerate(${accessor}):`,
      `        errors.extend(f"${target}[{i}]: {m}" for m in validate_${elemTarget}(item))`,
    );
  }
  return lines;
}

/* ------------------------------------------------------------------ */
/* services.py                                                         */
/* ------------------------------------------------------------------ */

function pythonServicesFile(
  input: GeneratorInput,
  module: string,
): GeneratedFile | undefined {
  if (!input.generateServices) return undefined;
  const services = sortedServices(input.ir);
  if (services.length === 0) return undefined;

  const blocks: string[] = [];
  blocks.push(
    [
      '"""Service clients and HTTP server adapters for the Bridge generated package.',
      '',
      'Clients POST JSON to `<base_url>/<package>/<Service>/<Method>` and',
      'decode responses with the generated from_dict decoders. The transport',
      'is urllib.request (stdlib) and can be replaced per call via `urlopen`.',
      '',
      'Server side: `<Service>ServiceHandler` implementations are bound to the',
      'standard library http.server with `make_<service>_handler(handler)`.',
      'Errors are {"code": str, "message": str} bodies with the canonical',
      'Bridge error-code to HTTP-status mapping (every generated language',
      'emits the identical table).',
      '"""',
    ].join('\n'),
  );
  blocks.push('from __future__ import annotations');
  blocks.push('');
  blocks.push('import json');
  blocks.push('import urllib.request');
  blocks.push('from http.server import BaseHTTPRequestHandler');
  blocks.push('from typing import Any, Callable');

  // Request-type validators for the server adapter (local struct inputs
  // only; cross-package opaque inputs have no generated validator).
  const requestTypes = sortedServices(input.ir)
    .flatMap((service) =>
      service.methods.map((m) => {
        const ref = m.input.kind === 'optional' ? m.input.inner : m.input;
        return isLocalStructRef(ref, input.ir) && ref.kind === 'named' ? ref.name : undefined;
      }),
    )
    .filter((name): name is string => name !== undefined);
  const uniqueRequestTypes = [...new Set(requestTypes)].sort();
  const hasEnumsForServices = sortedTypes(input.ir).some((t) => t.kind === 'enum');
  blocks.push('');
  blocks.push(`from .models import *  # noqa: F401,F403`);
  if (hasEnumsForServices) blocks.push(`from .enums import *  # noqa: F401,F403`);
  if (uniqueRequestTypes.length > 0) {
    blocks.push(`from .validation import ${uniqueRequestTypes.map((n) => `validate_${n}`).join(', ')}`);
  }

  blocks.push(
    [
      '',
      'class BridgeServiceError(Exception):',
      '    """Raised when a service call returns a non-200 response."""',
      '',
      '    def __init__(self, status: int, body: str) -> None:',
      '        super().__init__(f"bridge service error {status}: {body}")',
      '        self.status = status',
      '        self.body = body',
    ].join('\n'),
  );

  for (const service of services) {
    blocks.push(renderServiceClient(service, input, module));
  }

  blocks.push(...pythonServerBlocks(input));

  const content = [fileHeader('python', input.packageName), joinBlocks(blocks), ''].join('\n');
  return generatedFile(`${module}/services.py`, content);
}

function renderServiceClient(
  service: IRService,
  input: GeneratorInput,
  _module: string,
): string {
  const lines: string[] = [];
  const doc = pythonDocstring(
    service.docs !== undefined
      ? `${service.docs}\nRoutes: POST /${input.packageName}/${service.name}/<Method>.`
      : `Client for the ${service.name} service.\nRoutes: POST /${input.packageName}/${service.name}/<Method>.`,
  );
  lines.push('');
  lines.push('');
  lines.push(`class ${service.name}Client:`);
  if (doc !== undefined) lines.push(doc);
  lines.push('    def __init__(');
  lines.push('        self,');
  lines.push('        base_url: str,');
  lines.push('        timeout: float = 30.0,');
  lines.push(
    '        urlopen: "Callable[[str, bytes], bytes] | None" = None,',
  );
  lines.push('    ) -> None:');
  lines.push('        self._base_url = base_url.rstrip("/")');
  lines.push('        self._timeout = timeout');
  lines.push('        self._urlopen = urlopen');
  for (const method of service.methods) {
    // Method input/output are rendered through the type table: local
    // structs/unions keep their to_dict/from_dict machinery, while
    // cross-package (opaque) or alias-substituted signatures degrade to
    // JSON passthrough — same guard as the Go/TS generators.
    const inputType = renderTypeRef(method.input, input.render);
    const outputType = renderTypeRef(method.output, input.render);
    lines.push('');
    lines.push(`    def ${camelToLowerSnake(method.name)}(self, request: ${inputType}) -> ${outputType}:`);
    const mdoc = pythonDocstring(method.docs, method.deprecated, 8);
    if (mdoc !== undefined) lines.push(mdoc);
    lines.push('        raw = self._call(');
    lines.push(`            ${JSON.stringify(method.name)},`);
    lines.push(`            ${serializeExpr(method.input, 'request', input)},`);
    lines.push('        )');
    lines.push(
      `        return ${pythonDecodeExpr(method.output, input, 'json.loads(raw.decode("utf-8"))')}`,
    );
  }
  lines.push('');
  lines.push('    def _call(self, method_name: "str", payload: "Any") -> bytes:');
  lines.push('        body = json.dumps(payload).encode("utf-8")');
  lines.push(`        url = f"{self._base_url}/${input.packageName}/${service.name}/{method_name}"`);
  lines.push('        if self._urlopen is not None:');
  lines.push('            return self._urlopen(url, body)');
  lines.push('        req = urllib.request.Request(');
  lines.push('            url,');
  lines.push('            data=body,');
  lines.push('            headers={"Content-Type": "application/json"},');
  lines.push('            method="POST",');
  lines.push('        )');
  lines.push('        try:');
  lines.push('            with urllib.request.urlopen(req, timeout=self._timeout) as response:');
  lines.push('                return response.read()');
  lines.push('        except urllib.error.HTTPError as exc:');
  lines.push('            raise BridgeServiceError(exc.code, exc.read().decode("utf-8", "replace")) from exc');
  return lines.join('\n');
}

/**
 * Client-side decode for a service output value: local structs/unions
 * decode through from_dict, local enums through parse_<Name>; opaque
 * cross-package values (and any non-model shape) are returned as plain
 * decoded JSON instead of calling a method that does not exist. Also used
 * by the server-side request decoder (python-wire.ts).
 */
export function pythonDecodeExpr(ref: TypeRef, input: GeneratorInput, raw: string): string {
  if (ref.kind === 'named') {
    if (ref.package !== undefined && ref.package !== input.ir.name) return raw;
    const local = input.ir.types.find((t) => t.name === ref.name);
    if (local !== undefined && local.kind === 'enum') return `parse_${ref.name}(${raw})`;
    if (local !== undefined && (local.kind === 'struct' || local.kind === 'union')) {
      return `${ref.name}.from_dict(${raw})`;
    }
  }
  return raw;
}

/* ------------------------------------------------------------------ */
/* events.py                                                           */
/* ------------------------------------------------------------------ */

function pythonEventsFile(
  input: GeneratorInput,
  module: string,
): GeneratedFile | undefined {
  return pythonEventsFileV2(input, module);
}


/* ------------------------------------------------------------------ */
/* __init__.py                                                         */
/* ------------------------------------------------------------------ */

function pythonInitFile(
  input: GeneratorInput,
  module: string,
  present: {
    enums: GeneratedFile | undefined;
    models: GeneratedFile | undefined;
    validation: GeneratedFile | undefined;
    services: GeneratedFile | undefined;
    events: GeneratedFile | undefined;
  },
): GeneratedFile {
  const lines: string[] = [];
  lines.push(fileHeader('python', input.packageName));
  lines.push(`"""Generated Bridge contracts for ${input.packageName}."""`);
  lines.push('');
  const names: string[] = [];
  if (present.enums !== undefined) {
    const enumNames = sortedTypes(input.ir)
      .filter((t) => t.kind === 'enum')
      .map((t) => t.name);
    for (const name of enumNames) {
      lines.push(`from .enums import ${name}, parse_${name}`);
      names.push(name, `parse_${name}`);
    }
  }
  if (present.models !== undefined) {
    const modelNames = sortedTypes(input.ir)
      .filter((t) => t.kind !== 'enum')
      .map((t) => t.name);
    for (const crossRef of crossPackageRefs(input.ir)) {
      if (!modelNames.includes(crossRef.name)) modelNames.push(crossRef.name);
    }
    for (const name of modelNames.sort()) {
      lines.push(`from .models import ${name}`);
      names.push(name);
    }
  }
  if (present.validation !== undefined) {
    for (const structType of sortedTypes(input.ir).filter((t) => t.kind === 'struct')) {
      lines.push(`from .validation import validate_${structType.name}`);
      names.push(`validate_${structType.name}`);
    }
  }
  if (present.services !== undefined) {
    lines.push('from .services import BridgeServiceError, BridgeRpcError');
    names.push('BridgeServiceError', 'BridgeRpcError');
    for (const service of sortedServices(input.ir)) {
      const snake = camelToLowerSnake(service.name);
      lines.push(
        `from .services import ${service.name}Client, ${service.name}ServiceHandler, make_${snake}_handler`,
      );
      names.push(`${service.name}Client`, `${service.name}ServiceHandler`, `make_${snake}_handler`);
    }
  }
  if (present.events !== undefined) {
    lines.push('from .events import (');
    lines.push('    BRIDGE_EVENT_SPECVERSION,');
    lines.push('    BridgeEventMeta,');
    lines.push('    EventPublisher,');
    lines.push('    InMemoryEventBus,');
    lines.push('    BridgeEventDispatcher,');
    lines.push('    decode_bridge_event_envelope,');
    lines.push(')');
    for (const event of sortedEvents(input.ir)) {
      const snake = camelToLowerSnake(event.name);
      const screaming = camelToScreamingSnake(event.name);
      lines.push(`from .events import ${event.name}, ${screaming}_TYPE, ${event.name}Publisher, ${event.name}Handler`);
      lines.push(`from .events import create_${snake}_publisher, encode_${snake}, decode_${snake}, register_${snake}`);
      names.push(
        event.name,
        `${screaming}_TYPE`,
        `${event.name}Publisher`,
        `${event.name}Handler`,
        `create_${snake}_publisher`,
        `encode_${snake}`,
        `decode_${snake}`,
        `register_${snake}`,
      );
    }
    names.push(
      'BRIDGE_EVENT_SPECVERSION',
      'BridgeEventMeta',
      'EventPublisher',
      'InMemoryEventBus',
      'BridgeEventDispatcher',
      'decode_bridge_event_envelope',
    );
  }
  lines.push('');
  lines.push('__all__ = [');
  for (const name of [...new Set(names)].sort()) {
    lines.push(`    ${JSON.stringify(name)},`);
  }
  lines.push(']');
  lines.push('');
  return generatedFile(`${module}/__init__.py`, lines.join('\n'));
}
