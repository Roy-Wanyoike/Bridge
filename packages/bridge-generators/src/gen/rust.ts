/**
 * Rust generator.
 *
 * Emits, in order: Cargo.toml, src/lib.rs, src/types.rs, src/enums.rs,
 * src/validate.rs, src/services.rs, src/events.rs. Files without content
 * are skipped (e.g. enums.rs when the package declares no enums); lib.rs
 * only declares the modules that were actually emitted, keeping the file
 * list deterministic.
 *
 * Rust-specific decisions (documented in generated files too):
 * - Dependencies are serde (+derive) and serde_json ONLY — the generated
 *   crate has no other third-party dependencies. Consequences:
 *   - `@pattern` constraints are NOT evaluated by the generated Rust v1
 *     validator (no regex crate). validate() documents each skipped field
 *     with "pattern validation not supported in generated Rust v1".
 *   - @email/@url/@uuid are checked by hand-written helpers implementing
 *     the exact Bridge regex semantics without a regex crate.
 *   - `bytes` maps to Vec<u8>; serde_json serializes it as a JSON array of
 *     numbers (NOT base64 — base64 would require another dependency).
 *     This is a documented v1 wire-format caveat for Rust.
 * - Maps/sets use BTreeMap/BTreeSet for deterministic key ordering; serde
 *   serializes both as JSON arrays/objects per the Bridge wire format.
 *   BTreeSet's ordering of primitives (numbers numerically, strings by
 *   UTF-8 bytes, false < true) IS the canonical Bridge set order (#117),
 *   so Rust needs no extra canonicalization.
 * - Optional fields are Option<T> with
 *   `#[serde(default, skip_serializing_if = "Option::is_none")]` so absent
 *   and null both decode to None.
 * - Tagged unions map to adjacently tagged serde enums
 *   (`#[serde(tag = "kind", content = "value")]`), matching the
 *   {"kind": "<variant>", "value": <payload>} wire format used by Go/TS.
 * - Enums derive Debug, Clone, PartialEq, Serialize, Deserialize with
 *   `#[serde(rename_all = "SCREAMING_SNAKE_CASE")]`; when a declared
 *   variant name does not round-trip through that casing, per-variant
 *   `#[serde(rename = ...)]` attributes are emitted instead. A `parse`
 *   associated function errors on unknown wire values.
 * - Cross-package references become `pub type X = serde_json::Value`
 *   opaque aliases documented as "imported from <pkg>".
 * - Defaults are documented as `Default:` doc lines (no builder machinery).
 * - Service methods become `pub trait <Service>` with sync methods
 *   returning Result<T, String>; transport is left to the embedder.
 */

import type {
  IRField,
  IRService,
  IRTypeDefinition,
  IREvent,
  IRConstraint,
  TypeRef,
} from '@bridge/core';
import { generatedFile } from '../util';
import { fileHeader, headerLines } from '../header';
import { docLines, rustDoc } from '../docs';
import {
  rustEventEnvelopeBlock,
  rustEventV2,
  rustRoundtripTestFile,
  rustServerPrelude,
  rustServiceHttp,
} from './rust-wire';
import { findLocalType, isLocalEnumRef, isLocalStructRef, renderTypeRef } from '../mappings';
import { crossPackageRefs, sortedEvents, sortedServices, sortedTypes } from '../analysis';
import { camelToLowerSnake, rustCrateName, rustFieldName, rustVariantName, serdeRenameAllMatches } from '../naming';
import type { GeneratedFile, GeneratorInput } from './input';

/** Generates the Rust project for an IR package. */
export function generateRust(input: GeneratorInput): GeneratedFile[] {
  const files: GeneratedFile[] = [cargoTomlFile(input)];
  const types = rustTypesFile(input);
  const enums = rustEnumsFile(input);
  const validate = rustValidateFile(input);
  const services = rustServicesFile(input);
  const events = rustEventsFile(input);
  const modules: Array<[string, GeneratedFile | undefined]> = [
    ['types', types],
    ['enums', enums],
    ['validate', validate],
    ['services', services],
    ['events', events],
  ];
  const present = sortedModuleNames(modules);
  if (present.length > 0) {
    files.push(rustLibFile(input, present));
  }
  for (const [, file] of modules) {
    if (file !== undefined) files.push(file);
  }
  const roundtripTest = rustRoundtripTestFile(input);
  if (roundtripTest !== undefined) files.push(roundtripTest);
  return files;
}

/** Deterministic alphabetical module order for lib.rs. */
function sortedModuleNames(modules: Array<[string, GeneratedFile | undefined]>): string[] {
  return modules
    .filter(([, file]) => file !== undefined)
    .map(([name]) => name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

/** Indents a block by n spaces. */
function spaceIndent(block: string, levels = 1): string {
  const pad = ' '.repeat(4 * levels);
  return block
    .split('\n')
    .map((line) => (line.length > 0 ? pad + line : line))
    .join('\n');
}

/** Full doc block for a field: docs + deprecation + default note. */
function rustFieldDoc(field: IRField): string {
  const lines = docLines(field.docs);
  if (field.deprecated !== undefined) {
    lines.push(field.deprecated === true ? 'Deprecated.' : `Deprecated: ${field.deprecated}`);
  }
  if (field.default !== undefined) lines.push(`Default: ${field.default}`);
  if (lines.length === 0) return '';
  return lines.map((line) => `/// ${line}`).join('\n');
}

/** Doc attribute for a deprecated type. Empty when not deprecated. */
function rustDeprecatedAttr(deprecated: string | true | undefined): string {
  if (deprecated === undefined) return '';
  if (deprecated === true) return '#[deprecated]\n';
  return `#[deprecated(note = ${JSON.stringify(deprecated)})]\n`;
}

/** Rust type for a field; optional fields are wrapped in Option. */
export function rustFieldType(field: IRField, input: GeneratorInput): string {
  const base = renderTypeRef(field.type, input.render);
  if (field.optional && field.type.kind !== 'optional') return `Option<${base}>`;
  return base;
}

/** serde attribute list for a field. */
export function rustFieldSerdeAttrs(field: IRField): string[] {
  const attrs: string[] = [];
  const named = rustFieldName(field.name);
  if (named.rename !== undefined) attrs.push(`rename = ${JSON.stringify(named.rename)}`);
  if (field.optional) {
    attrs.push('default', 'skip_serializing_if = "Option::is_none"');
  }
  return attrs;
}

/** Result of scanning refs for local named targets. */
export interface LocalRefs {
  /** Local named types that are NOT enums (structs, aliases, unions). */
  readonly types: Set<string>;
  readonly enums: Set<string>;
  usesBTreeMap: boolean;
  usesBTreeSet: boolean;
}

export function emptyLocalRefs(): LocalRefs {
  return { types: new Set(), enums: new Set(), usesBTreeMap: false, usesBTreeSet: false };
}

/** True when the named ref points at any type declared in this package. */
function isLocalType(
  ref: { name: string; package?: string },
  input: GeneratorInput,
): boolean {
  if (ref.package !== undefined && ref.package !== input.ir.name) return false;
  return findLocalType(input.ir, ref.name) !== undefined;
}

export function scanRef(ref: TypeRef, input: GeneratorInput, into: LocalRefs): void {
  switch (ref.kind) {
    case 'primitive':
      break;
    case 'named':
      if (isLocalEnumRef(ref, input.ir)) into.enums.add(ref.name);
      else if (isLocalType(ref, input)) into.types.add(ref.name);
      break;
    case 'list':
      scanRef(ref.element, input, into);
      break;
    case 'set':
      into.usesBTreeSet = true;
      scanRef(ref.element, input, into);
      break;
    case 'map':
      into.usesBTreeMap = true;
      scanRef(ref.key, input, into);
      scanRef(ref.value, input, into);
      break;
    case 'optional':
      scanRef(ref.inner, input, into);
      break;
  }
}

/** Renders a sorted `use` list for one path prefix. */
export function rustUseList(prefix: string, names: Iterable<string>): string | undefined {
  const sorted = [...names].sort();
  if (sorted.length === 0) return undefined;
  if (sorted.length === 1) return `use ${prefix}::${sorted[0]};`;
  return `use ${prefix}::{${sorted.join(', ')}};`;
}

/** File preamble: header, crate-level docs, then use statements. */
export function rustFilePreamble(input: GeneratorInput, crateDocs: string[], uses: string[]): string {
  const parts: string[] = [fileHeader('rust', input.packageName)];
  const docLinesOut = crateDocs.map((line) => `//! ${line}`);
  if (docLinesOut.length > 0) parts.push('', docLinesOut.join('\n'));
  if (uses.length > 0) parts.push('', uses.join('\n'));
  return parts.join('\n');
}

/* ------------------------------------------------------------------ */
/* Cargo.toml                                                          */
/* ------------------------------------------------------------------ */

function cargoTomlFile(input: GeneratorInput): GeneratedFile {
  const header = headerLines(input.packageName).map((line) => `# ${line}`).join('\n');
  const content = [
    header,
    '',
    '[package]',
    `name = ${JSON.stringify(rustCrateName(input.packageName))}`,
    'version = "0.1.0"',
    'edition = "2021"',
    '',
    '[dependencies]',
    'serde = { version = "1", features = ["derive"] }',
    'serde_json = "1"',
    '',
  ].join('\n');
  return generatedFile('Cargo.toml', content);
}

/* ------------------------------------------------------------------ */
/* src/lib.rs                                                          */
/* ------------------------------------------------------------------ */

function rustLibFile(input: GeneratorInput, modules: string[]): GeneratedFile {
  const docs = docLines(input.ir.docs);
  const parts: string[] = [fileHeader('rust', input.packageName)];
  if (docs.length > 0) parts.push('', docs.map((line) => `//! ${line}`).join('\n'));
  parts.push('', modules.map((name) => `pub mod ${name};`).join('\n'), '');
  return generatedFile('src/lib.rs', parts.join('\n'));
}

/* ------------------------------------------------------------------ */
/* src/types.rs                                                        */
/* ------------------------------------------------------------------ */

function rustTypesFile(input: GeneratorInput): GeneratedFile | undefined {
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
  for (const name of refs.enums) refs.types.delete(name);

  if (structs.length === 0 && unions.length === 0 && aliases.length === 0 && opaque.length === 0) {
    return undefined;
  }

  const uses: string[] = [];
  // rustfmt grouping order: std, external crates, then crate-local paths.
  if (refs.usesBTreeMap || refs.usesBTreeSet) {
    const wanted = [
      refs.usesBTreeMap ? 'BTreeMap' : undefined,
      refs.usesBTreeSet ? 'BTreeSet' : undefined,
    ].filter((name): name is string => name !== undefined);
    uses.push(`use std::collections::{${wanted.join(', ')}};`);
  }
  if (structs.length > 0 || unions.length > 0) uses.push('use serde::{Deserialize, Serialize};');
  const enumsUse = rustUseList('crate::enums', refs.enums);
  if (enumsUse !== undefined) uses.push(enumsUse);

  let body = '';

  for (const ref of opaque) {
    body += rustDoc(
      `${ref.name} is an opaque alias: imported from ${ref.fromPackage}; regenerate with that package for full types.`,
    );
    body += `\npub type ${ref.name} = serde_json::Value;\n\n`;
  }

  for (const alias of types.filter((t) => t.kind === 'alias')) {
    const doc = rustDoc(alias.docs, alias.deprecated);
    if (doc.length > 0) body += `${doc}\n`;
    body += `pub type ${alias.name} = ${renderTypeRef(alias.target, input.render)};\n\n`;
  }

  for (const structType of structs) {
    body += rustStruct(structType as IRTypeDefinition & { kind: 'struct' }, input);
  }

  for (const union of unions) {
    body += rustUnion(union as IRTypeDefinition & { kind: 'union' }, input);
  }

  const parts = [
    rustFilePreamble(input, ['Type declarations generated from the Bridge package.'], uses),
    '',
    body.trimEnd(),
    '',
  ];
  return generatedFile('src/types.rs', parts.join('\n'));
}

function rustStruct(
  struct: IRTypeDefinition & { kind: 'struct' },
  input: GeneratorInput,
): string {
  let out = '';
  const doc = rustDoc(struct.docs, struct.deprecated);
  if (doc.length > 0) out += `${doc}\n`;
  out += '#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]\n';
  out += rustDeprecatedAttr(struct.deprecated);
  out += `pub struct ${struct.name} {\n`;
  for (const field of struct.fields) {
    const fieldDoc = rustFieldDoc(field);
    if (fieldDoc.length > 0) out += `${spaceIndent(fieldDoc)}\n`;
    const attrs = rustFieldSerdeAttrs(field);
    if (attrs.length > 0) out += `    #[serde(${attrs.join(', ')})]\n`;
    out += `    pub ${rustFieldName(field.name).name}: ${rustFieldType(field, input)},\n`;
  }
  out += '}\n\n';
  return out;
}

function rustUnion(
  union: IRTypeDefinition & { kind: 'union' },
  input: GeneratorInput,
): string {
  let out = '';
  const docLinesOut = [
    ...docLines(union.docs),
    `Tagged union. Wire format: {"kind": "<variant>", "value": <payload>}.`,
    'Variants:',
    ...union.variants.map((v) => `  - ${v.name}: ${renderTypeRef(v.type, input.render)}`),
  ];
  const doc = rustDoc(docLinesOut.join('\n'), union.deprecated);
  if (doc.length > 0) out += `${doc}\n`;
  out += '#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]\n';
  out += rustDeprecatedAttr(union.deprecated);
  out += '#[serde(tag = "kind", content = "value")]\n';
  out += `pub enum ${union.name} {\n`;
  for (const variant of union.variants) {
    const vdoc = rustDoc(variant.docs, variant.deprecated);
    if (vdoc.length > 0) out += `${spaceIndent(vdoc)}\n`;
    out += `    #[serde(rename = ${JSON.stringify(variant.name)})]\n`;
    out += `    ${rustVariantName(variant.name)}(${renderTypeRef(variant.type, input.render)}),\n`;
  }
  out += '}\n\n';

  out += `impl ${union.name} {\n`;
  for (const variant of union.variants) {
    const variantRust = rustVariantName(variant.name);
    const payloadType = renderTypeRef(variant.type, input.render);
    out += `    /// Builds a ${union.name} carrying the ${variant.name} variant.\n`;
    out += `    pub fn new_${camelToLowerSnake(variant.name)}(value: ${payloadType}) -> ${union.name} {\n`;
    out += `        ${union.name}::${variantRust}(value)\n`;
    out += `    }\n\n`;
    out += `    /// Returns the ${variant.name} payload when the kind is ${JSON.stringify(variant.name)}.\n`;
    out += `    pub fn as_${camelToLowerSnake(variant.name)}(&self) -> Option<${payloadType}> {\n`;
    out += `        match self {\n`;
    out += `            ${union.name}::${variantRust}(value) => Some(value.clone()),\n`;
    out += `            _ => None,\n`;
    out += `        }\n`;
    out += `    }\n\n`;
  }
  out += '}\n\n';
  return out;
}

/* ------------------------------------------------------------------ */
/* src/enums.rs                                                        */
/* ------------------------------------------------------------------ */

function rustEnumsFile(input: GeneratorInput): GeneratedFile | undefined {
  const enums = sortedTypes(input.ir).filter((t) => t.kind === 'enum');
  if (enums.length === 0) return undefined;

  let body = '';
  for (const enumType of enums) {
    body += rustEnum(enumType as IRTypeDefinition & { kind: 'enum' });
  }

  const parts = [
    rustFilePreamble(input, ['Enum declarations generated from the Bridge package.'], [
      'use serde::{Deserialize, Serialize};',
    ]),
    '',
    body.trimEnd(),
    '',
  ];
  return generatedFile('src/enums.rs', parts.join('\n'));
}

function rustEnum(enumType: IRTypeDefinition & { kind: 'enum' }): string {
  let out = '';
  const doc = rustDoc(enumType.docs, enumType.deprecated);
  if (doc.length > 0) out += `${doc}\n`;
  out += '#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]\n';
  out += rustDeprecatedAttr(enumType.deprecated);
  const useRenameAll = enumType.variants.every((v) => serdeRenameAllMatches(v.name));
  if (useRenameAll) {
    out += '#[serde(rename_all = "SCREAMING_SNAKE_CASE")]\n';
  }
  out += `pub enum ${enumType.name} {\n`;
  for (const variant of enumType.variants) {
    const vdoc = rustDoc(variant.docs, variant.deprecated);
    if (vdoc.length > 0) out += `${spaceIndent(vdoc)}\n`;
    if (!useRenameAll) {
      out += `    #[serde(rename = ${JSON.stringify(variant.name)})]\n`;
    }
    out += `    ${rustVariantName(variant.name)},\n`;
  }
  out += '}\n\n';

  out += `impl ${enumType.name} {\n`;
  out += `    /// Parses the wire representation into a ${enumType.name}; errors on unknown values.\n`;
  out += `    pub fn parse(value: &str) -> Result<${enumType.name}, String> {\n`;
  out += `        match value {\n`;
  for (const variant of enumType.variants) {
    out += `            ${JSON.stringify(variant.name)} => Ok(${enumType.name}::${rustVariantName(variant.name)}),\n`;
  }
  out += `            _ => Err(format!("unknown ${enumType.name} value {:?}", value)),\n`;
  out += `        }\n`;
  out += `    }\n`;
  out += `}\n\n`;
  return out;
}

/* ------------------------------------------------------------------ */
/* src/validate.rs                                                     */
/* ------------------------------------------------------------------ */

/** Constraint check rendered for Rust; undefined when unsupported/skipped. */
function rustConstraintCheck(
  constraint: IRConstraint,
  field: IRField,
  input: GeneratorInput,
  accesses: { email: boolean; url: boolean; uuid: boolean },
  notes: string[],
): string | undefined {
  const fallback = (text: string): string => constraint.message ?? text;
  const unwrap = (ref: TypeRef): TypeRef => (ref.kind === 'optional' ? ref.inner : ref);
  const inner = unwrap(field.type);

  const isNumeric =
    inner.kind === 'primitive' &&
    ['int32', 'int64', 'uint32', 'uint64', 'float32', 'float64'].includes(inner.primitive);
  const isStringLike =
    inner.kind === 'primitive' &&
    ['string', 'uuid', 'timestamp', 'decimal'].includes(inner.primitive);

  // Struct member accesses must go through rustFieldName: keyword-named
  // fields are declared as raw identifiers (r#type) or escaped names
  // (self_), and the raw wire name would be a rustc syntax error here.
  const member = rustFieldName(field.name).name;
  const optionalGuardOpen = field.optional ? `if let Some(value) = &self.${member} {\n` : '';
  const optionalGuardClose = field.optional ? '}\n' : '';
  const err = (message: string): string =>
    `return Err(ValidationError::new(${JSON.stringify(field.name)}, ${JSON.stringify(message)}));`;
  // Numeric comparisons dereference the borrowed value; string-like checks
  // pass it by reference (deref coercion &String -> &str).
  const numericExpr = field.optional ? '*value' : `self.${member}`;
  const methodExpr = field.optional ? 'value' : `self.${member}`;
  const borrowedArgExpr = field.optional ? 'value' : `&self.${member}`;

  switch (constraint.kind) {
    case 'min':
    case 'max': {
      if (!isNumeric) return undefined;
      const arg = constraint.args[0] ?? '';
      const op = constraint.kind === 'min' ? '<' : '>';
      const text = fallback(constraint.kind === 'min' ? `must be >= ${arg}` : `must be <= ${arg}`);
      const check = `if ${numericExpr} ${op} ${arg} {\n    ${err(text)}\n}\n`;
      if (field.optional) {
        return optionalGuardOpen + spaceIndent(check) + optionalGuardClose;
      }
      return check;
    }
    case 'length': {
      if (!isStringLike) return undefined;
      const arg = constraint.args[0] ?? '';
      const text = fallback(`must be exactly ${arg} characters`);
      // len() counts bytes; the unicode caveat is documented in the module docs.
      const check = `if ${methodExpr}.len() != ${arg} {\n    ${err(text)}\n}\n`;
      if (field.optional) {
        return optionalGuardOpen + spaceIndent(check) + optionalGuardClose;
      }
      return check;
    }
    case 'email': {
      if (!isStringLike) return undefined;
      accesses.email = true;
      const text = fallback('must be a valid email address');
      const check = `if !is_bridge_email(${borrowedArgExpr}) {\n    ${err(text)}\n}\n`;
      if (field.optional) {
        return optionalGuardOpen + spaceIndent(check) + optionalGuardClose;
      }
      return check;
    }
    case 'url': {
      if (!isStringLike) return undefined;
      accesses.url = true;
      const text = fallback('must be a valid URL');
      const check = `if !is_bridge_url(${borrowedArgExpr}) {\n    ${err(text)}\n}\n`;
      if (field.optional) {
        return optionalGuardOpen + spaceIndent(check) + optionalGuardClose;
      }
      return check;
    }
    case 'uuid': {
      if (!isStringLike) return undefined;
      accesses.uuid = true;
      const text = fallback('must be a valid UUID');
      const check = `if !is_bridge_uuid(${borrowedArgExpr}) {\n    ${err(text)}\n}\n`;
      if (field.optional) {
        return optionalGuardOpen + spaceIndent(check) + optionalGuardClose;
      }
      return check;
    }
    case 'pattern': {
      if (!isStringLike) return undefined;
      notes.push(`- \`${field.name}\`: pattern validation not supported in generated Rust v1`);
      return undefined;
    }
    default:
      return undefined;
  }
}

function rustValidateImpl(
  struct: IRTypeDefinition & { kind: 'struct' },
  input: GeneratorInput,
  accesses: { email: boolean; url: boolean; uuid: boolean },
): string {
  let out = '';
  const notes: string[] = [];
  let checks = '';

  for (const field of struct.fields) {
    for (const constraint of field.constraints) {
      const rendered = rustConstraintCheck(constraint, field, input, accesses, notes);
      if (rendered !== undefined) checks += rendered;
    }
  }
  // Nested struct validation (after all constraint checks, matching Go).
  for (const field of struct.fields) {
    let ref: TypeRef = field.type;
    if (ref.kind === 'optional') ref = ref.inner;
    if (!isLocalStructRef(ref, input.ir)) continue;
    const prefix = `format!(${JSON.stringify(`${field.name}.{}`)}, err.field)`;
    const member = rustFieldName(field.name).name;
    if (field.optional) {
      checks += `if let Some(value) = &self.${member} {\n`;
      checks += `    if let Err(err) = value.validate() {\n`;
      checks += `        return Err(ValidationError { field: ${prefix}, message: err.message });\n`;
      checks += `    }\n`;
      checks += `}\n`;
    } else {
      checks += `if let Err(err) = self.${member}.validate() {\n`;
      checks += `    return Err(ValidationError { field: ${prefix}, message: err.message });\n`;
      checks += `}\n`;
    }
  }

  out += `impl ${struct.name} {\n`;
  out += `    /// Validates the constraints declared on ${struct.name} in the Bridge contract.\n`;
  if (notes.length > 0) {
    out += `    ///\n`;
    out += `    /// # Notes\n`;
    for (const note of notes) out += `    /// ${note}\n`;
  }
  out += `    pub fn validate(&self) -> Result<(), ValidationError> {\n`;
  if (checks.trimEnd().length > 0) {
    out += `${spaceIndent(checks.trimEnd(), 2)}\n`;
  }
  out += `        Ok(())\n`;
  out += `    }\n`;
  out += `}\n\n`;
  return out;
}

function rustValidateFile(input: GeneratorInput): GeneratedFile | undefined {
  const structs = sortedTypes(input.ir).filter((t) => t.kind === 'struct');
  if (structs.length === 0) return undefined;

  const accesses = { email: false, url: false, uuid: false };
  let body = '';

  body += `/// Validation error returned by generated \`validate\` functions: the dotted\n`;
  body += `/// field path plus a human-readable message.\n`;
  body += `#[derive(Debug, Clone, PartialEq)]\n`;
  body += `pub struct ValidationError {\n`;
  body += `    /// Dotted field path, e.g. \`unit_price.currency\`.\n`;
  body += `    pub field: String,\n`;
  body += `    /// Human-readable violation message.\n`;
  body += `    pub message: String,\n`;
  body += `}\n\n`;
  body += `impl ValidationError {\n`;
  body += `    /// Builds a validation error for a (possibly dotted) field path.\n`;
  body += `    pub fn new(field: &str, message: impl Into<String>) -> ValidationError {\n`;
  body += `        ValidationError { field: field.to_string(), message: message.into() }\n`;
  body += `    }\n`;
  body += `}\n\n`;

  for (const structType of structs) {
    body += rustValidateImpl(structType as IRTypeDefinition & { kind: 'struct' }, input, accesses);
  }

  if (accesses.email) {
    body += `/// Implements the Bridge @email constraint: ^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$
/// (hand-written; the generated crate does not depend on a regex crate).
fn is_bridge_email(value: &str) -> bool {
    if value.is_empty() || value.contains(char::is_whitespace) {
        return false;
    }
    if value.matches('@').count() != 1 {
        return false;
    }
    match value.split_once('@') {
        Some((local, domain)) => {
            if local.is_empty() {
                return false;
            }
            let parts: Vec<&str> = domain.split('.').collect();
            parts.len() >= 2 && parts.iter().all(|part| !part.is_empty())
        }
        None => false,
    }
}

`;
  }
  if (accesses.url) {
    body += `/// Implements the Bridge @url constraint: ^https?://\\S+$
/// (hand-written; the generated crate does not depend on a regex crate).
fn is_bridge_url(value: &str) -> bool {
    let rest = value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"));
    match rest {
        Some(rest) => !rest.is_empty() && !rest.contains(char::is_whitespace),
        None => false,
    }
}

`;
  }
  if (accesses.uuid) {
    body += `/// Implements the Bridge @uuid constraint (8-4-4-4-12 hex)
/// (hand-written; the generated crate does not depend on a regex crate).
fn is_bridge_uuid(value: &str) -> bool {
    let expected = [8usize, 4, 4, 4, 12];
    let parts: Vec<&str> = value.split('-').collect();
    if parts.len() != expected.len() {
        return false;
    }
    parts
        .iter()
        .zip(expected.iter())
        .all(|(part, len)| part.len() == *len && part.chars().all(|c| c.is_ascii_hexdigit()))
}

`;
  }

  const uses: string[] = [];
  const structsUse = rustUseList(
    'crate::types',
    structs.map((s) => s.name),
  );
  if (structsUse !== undefined) uses.push(structsUse);

  const crateDocs = [
    'Constraint validation generated from the Bridge @constraint annotations.',
    'Note: `len()` counts bytes, not unicode characters (documented v1 caveat).',
  ];

  const parts = [
    rustFilePreamble(input, crateDocs, uses),
    '',
    body.trimEnd(),
    '',
  ];
  return generatedFile('src/validate.rs', parts.join('\n'));
}

/* ------------------------------------------------------------------ */
/* src/services.rs                                                     */
/* ------------------------------------------------------------------ */

function rustServicesFile(input: GeneratorInput): GeneratedFile | undefined {
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

  const uses: string[] = [];
  const typesUse = rustUseList('crate::types', refs.types);
  if (typesUse !== undefined) uses.push(typesUse);
  const enumsUse = rustUseList('crate::enums', refs.enums);
  if (enumsUse !== undefined) uses.push(enumsUse);

  let body = '';
  for (const service of services) {
    body += rustService(service, input);
  }
  body += rustServerPrelude();
  body += '\n';
  for (const service of services) {
    body += rustServiceHttp(service, input);
    body += '\n';
  }

  const parts = [
    rustFilePreamble(
      input,
      [
        'Service traits, the canonical error-code table and stdlib-TCP JSON-over-HTTP',
        'clients/servers generated from the Bridge package.',
        'Wire shape: POST /<package>/<Service>/<Method>.',
      ],
      uses,
    ),
    '',
    body.trimEnd(),
    '',
  ];
  return generatedFile('src/services.rs', parts.join('\n'));
}

/** Method input/output type: named refs render as the type name. */
function rustMethodTypeName(ref: TypeRef, input: GeneratorInput): string {
  if (ref.kind === 'named') return ref.name;
  return renderTypeRef(ref, input.render);
}

function rustService(service: IRService, input: GeneratorInput): string {
  let out = '';
  const docLinesOut = [
    ...docLines(service.docs),
    `${service.name} is the Bridge service trait for the ${service.name} service.`,
    'Sync methods returning Result<T, String>; bind to HTTP with the generated',
    `client/server pair (POST /${input.packageName}/${service.name}/<Method>).`,
  ];
  const doc = rustDoc(docLinesOut.join('\n'));
  if (doc.length > 0) out += `${doc}\n`;
  out += `pub trait ${service.name} {\n`;
  for (const method of service.methods) {
    const mdoc = rustDoc(method.docs, method.deprecated);
    if (mdoc.length > 0) out += `${spaceIndent(mdoc)}\n`;
    out += `    fn ${camelToLowerSnake(method.name)}(&self, req: &${rustMethodTypeName(method.input, input)}) -> Result<${rustMethodTypeName(method.output, input)}, String>;\n`;
  }
  out += `}\n\n`;
  return out;
}

/* ------------------------------------------------------------------ */
/* src/events.rs                                                       */
/* ------------------------------------------------------------------ */

function rustEventsFile(input: GeneratorInput): GeneratedFile | undefined {
  if (!input.generateEvents) return undefined;
  const events = sortedEvents(input.ir);
  if (events.length === 0) return undefined;

  const refs = emptyLocalRefs();
  for (const event of events) {
    for (const field of event.fields) scanRef(field.type, input, refs);
  }

  const uses: string[] = ['use serde::{Deserialize, Serialize};'];
  const typesUse = rustUseList('crate::types', refs.types);
  if (typesUse !== undefined) uses.push(typesUse);
  const enumsUse = rustUseList('crate::enums', refs.enums);
  if (enumsUse !== undefined) uses.push(enumsUse);

  let body = rustEventEnvelopeBlock() + '\n';
  for (const event of events) {
    body += rustEvent(event, input);
    body += rustEventV2(event, input);
    body += '\n';
  }

  const parts = [
    rustFilePreamble(
      input,
      [
        'Event payloads and the CloudEvents-style Bridge envelope:',
        '{specversion: "1.0", id, source, type: "<package>.<Event>", time, data}.',
        'id, source and time are ALWAYS caller-supplied: generated code contains',
        'no clocks and no uuid generation.',
      ],
      uses,
    ),
    '',
    body.trimEnd(),
    '',
  ];
  return generatedFile('src/events.rs', parts.join('\n'));
}

function rustEvent(event: IREvent, input: GeneratorInput): string {
  let out = '';
  const doc = rustDoc(event.docs);
  if (doc.length > 0) out += `${doc}\n`;
  out += '#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]\n';
  out += `pub struct ${event.name} {\n`;
  for (const field of event.fields) {
    const fieldDoc = rustFieldDoc(field);
    if (fieldDoc.length > 0) out += `${spaceIndent(fieldDoc)}\n`;
    const attrs = rustFieldSerdeAttrs(field);
    if (attrs.length > 0) out += `    #[serde(${attrs.join(', ')})]\n`;
    out += `    pub ${rustFieldName(field.name).name}: ${rustFieldType(field, input)},\n`;
  }
  out += '}\n\n';
  return out;
}
