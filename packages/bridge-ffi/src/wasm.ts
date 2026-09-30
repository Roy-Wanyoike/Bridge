/**
 * WASM target generator.
 *
 * Compiles the contract's Rust core (types + validators, reused from the
 * Rust data generator) into a wasm32 library with `wasm-bindgen` surface,
 * plus typed TypeScript wrappers for the emitted bindings.
 *
 * Scope note (documented in generated files too): the WASM surface carries
 * the contract's DATA across the boundary — parse/validate/serialize every
 * type from JavaScript with Rust-side correctness. Function-carrying FFI
 * (Rust handler registry + Go cgo client) lives in the C-ABI targets; a
 * browser has no dynamic-library loader, so service dispatch there is a
 * different (host-driven) pattern.
 */

import type { IRPackage, TypeRef } from '@bridge/core';
import { generate } from '@bridge/generators';
import { ffiCrateName } from './abi';
import { fileHeader, generatedFile } from './util';
import type { GeneratedFile } from './util';

/** Generates the wasm32 crate + TS wrappers for an IR package. */
export function generateWasm(ir: IRPackage): GeneratedFile[] {
  const crate = ffiCrateName(ir.name) + '-wasm';
  const files: GeneratedFile[] = [wasmCargoToml(ir, crate)];
  // Reuse the canonical generated Rust types/validators. This is the ONE
  // generate() call for the whole target: lib.rs wrapper names and the TS
  // declarations below are derived from the IR, not by re-running the
  // generator or re-parsing its output (issue #117).
  const dataFiles = generate(ir, { language: 'rust', generateServices: false, generateEvents: false });
  for (const path of ['src/types.rs', 'src/enums.rs', 'src/validate.rs']) {
    const file = dataFiles.find((f) => f.path === path);
    if (file !== undefined) files.push(file);
  }
  const hasTypes = dataFiles.some((f) => f.path === 'src/types.rs');
  const hasEnums = dataFiles.some((f) => f.path === 'src/enums.rs');
  const hasValidate = dataFiles.some((f) => f.path === 'src/validate.rs');
  files.push(wasmLibRs(ir, { hasTypes, hasEnums, hasValidate }), tsDeclarations(ir), tsLoader(ir));
  return files;
}

function wasmCargoToml(ir: IRPackage, crate: string): GeneratedFile {
  const lines = [
    `# ${fileHeader('#', ir.name)}`,
    '[package]',
    `name = "${crate}"`,
    'version = "0.1.0"',
    'edition = "2021"',
    `description = "wasm32 bindings for the ${ir.name} Bridge contract."`,
    '',
    '[lib]',
    'crate-type = ["cdylib", "rlib"]',
    '',
    '[dependencies]',
    'serde = { version = "1", features = ["derive"] }',
    'serde_json = "1"',
    'wasm-bindgen = "0.2"',
    '',
  ];
  return generatedFile('Cargo.toml', lines.join('\n'));
}

/** src/lib.rs: wasm-bindgen surface over the contract's types. */
function wasmLibRs(
  ir: IRPackage,
  present: { hasTypes: boolean; hasEnums: boolean; hasValidate: boolean },
): GeneratedFile {
  const lines: string[] = [];
  lines.push(fileHeader('//', ir.name));
  lines.push('');
  lines.push('//! wasm32 surface: parse / validate / serialize every contract type');
  lines.push('//! from JavaScript with Rust-side correctness. Build with');
  lines.push('//! `cargo build --target wasm32-unknown-unknown` then generate the JS');
  lines.push('//! glue with `wasm-bindgen` (see index.ts for the typed wrappers).');
  lines.push('');
  lines.push('use wasm_bindgen::prelude::*;');
  lines.push('');
  // Modules are declared only when their file was actually emitted (mirrors
  // rust-ffi.ts): an enum-less or struct-less package must not reference
  // missing src/enums.rs / src/validate.rs, or cargo build fails.
  if (present.hasTypes) lines.push('pub mod types;');
  if (present.hasEnums) lines.push('pub mod enums;');
  if (present.hasValidate) lines.push('pub mod validate;');
  if (present.hasTypes) lines.push('pub use types::*;');
  if (present.hasEnums) lines.push('pub use enums::*;');
  lines.push('');
  lines.push('/// Generates a wasm-bindgen class wrapper around one contract type.');
  lines.push('/// (fromJson / toJson / validate, callable from JavaScript).');
  lines.push('macro_rules! bridge_wasm_type {');
  lines.push('    ($name:ident) => {');
  lines.push('        #[wasm_bindgen]');
  lines.push('        pub struct $name {');
  lines.push('            inner: types::$name,');
  lines.push('        }');
  lines.push('');
  lines.push('        #[wasm_bindgen]');
  lines.push('        impl $name {');
  lines.push('            /// Parses the type from its JSON wire representation.');
  lines.push('            #[wasm_bindgen(js_name = fromJson)]');
  lines.push('            pub fn from_json(json: &str) -> Result<$name, JsValue> {');
  lines.push('                let inner: types::$name = serde_json::from_str(json)');
  lines.push('                    .map_err(|err| JsValue::from_str(&err.to_string()))?;');
  lines.push('                Ok($name { inner })');
  lines.push('            }');
  lines.push('');
  lines.push('            /// Serializes the type to its JSON wire representation.');
  lines.push('            #[wasm_bindgen(js_name = toJson)]');
  lines.push('            pub fn to_json(&self) -> Result<String, JsValue> {');
  lines.push('                serde_json::to_string(&self.inner).map_err(|err| JsValue::from_str(&err.to_string()))');
  lines.push('            }');
  lines.push('');
  lines.push('            /// Validates constraints; Err carries the violation messages.');
  lines.push('            #[wasm_bindgen(js_name = validate)]');
  lines.push('            pub fn validate(&self) -> Result<(), JsValue> {');
  lines.push('                self.inner.validate().map_err(|err| JsValue::from_str(&format!("{}: {}", err.field, err.message)))');
  lines.push('            }');
  lines.push('        }');
  lines.push('    };');
  lines.push('}');
  lines.push('');
  // Extract the struct names from the IR and emit one wrapper invocation
  // per type (every IR struct is emitted as `pub struct` in types.rs).
  // Issue #117: derived from the IR, not by re-generating/re-parsing.
  const typeNames = [...ir.types]
    .filter((t) => t.kind === 'struct')
    .map((t) => t.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const name of typeNames) {
    lines.push(`bridge_wasm_type!(${name});`);
  }
  if (typeNames.length === 0) {
    lines.push('// (no struct types in this package)');
  }
  lines.push('');
  lines.push('/// Package identity exposed for diagnostics.');
  lines.push('#[wasm_bindgen]');
  lines.push('pub fn bridge_package() -> String {');
  lines.push(`    String::from(${JSON.stringify(ir.name)})`);
  lines.push('}');
  lines.push('');
  lines.push('/// Serializer version gate: JS callers can verify compatibility.');
  lines.push('#[wasm_bindgen]');
  lines.push('pub fn bridge_format_version() -> u32 {');
  lines.push('    1');
  lines.push('}');
  lines.push('');
  return generatedFile('src/lib.rs', `${lines.join('\n')}\n`);
}

/**
 * index.d.ts: typed declarations for the wasm-bindgen output, derived
 * DIRECTLY from the IR (issue #117).
 *
 * The previous implementation regex-parsed the generated Rust
 * (`/pub (\w+):\s*([^\n]+?),?$/gm`), which silently dropped every field
 * declared with a raw identifier (`r#type`) — the regex cannot match the
 * `r#` prefix — and rendered BTreeSet/BTreeMap/named types as `unknown`.
 * Deriving from the same IR the Rust generator consumes removes both
 * failure modes by construction: the field list is the IR field list
 * (wire names), and every IR type shape has an explicit TS mapping
 * below (mirroring the @bridge/generators TypeScript conventions:
 * int64/uint64 → number with the documented 2^53 caveat, uuid/timestamp/
 * decimal → string, bytes → Uint8Array, json → unknown).
 */
function tsDeclarations(ir: IRPackage): GeneratedFile {
  const lines: string[] = [];
  lines.push(fileHeader('//', ir.name));
  lines.push('');
  lines.push('//! Typed declarations for the wasm-bindgen output of this crate.');
  lines.push('//! Derived from the contract IR; the Rust BTreeSet fields cross as');
  lines.push('//! JSON arrays in canonical order, BTreeMap as JSON objects.');
  lines.push('//! Runtime shape: each Bridge struct type exposes `fromJson(string)`,');
  lines.push('//! `toJson()` and `validate()`; module-level `bridgePackage()` /');
  lines.push('//! `bridgeFormatVersion()` identify the contract.');
  lines.push('');
  lines.push(`export const BRIDGE_PACKAGE = ${JSON.stringify(ir.name)};`);
  lines.push('export const BRIDGE_FORMAT_VERSION = 1;');
  lines.push('');
  lines.push('export declare class BridgeWasmError extends Error {}');
  lines.push('');

  const structs = [...ir.types]
    .filter((t) => t.kind === 'struct')
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const structType of structs) {
    lines.push(`export declare class ${structType.name}Wasm {`);
    lines.push(`  static fromJson(json: string): ${structType.name}Wasm;`);
    lines.push('  toJson(): string;');
    lines.push('  validate(): void;');
    for (const field of structType.fields) {
      const base = wasmTsType(field.type, ir);
      // Field-level optionality renders as Rust Option<T> in types.rs,
      // which serde_json crosses as null; an explicit optional TypeRef
      // already carries its own "| null" from wasmTsType.
      const nullable =
        field.optional && field.type.kind !== 'optional' ? `${base} | null` : base;
      lines.push(`  readonly ${camelToJs(field.name)}: ${nullable};`);
    }
    lines.push('}');
    lines.push('');
  }

  lines.push('export declare function bridgePackage(): string;');
  lines.push('export declare function bridgeFormatVersion(): number;');
  lines.push('');
  return generatedFile('index.d.ts', `${lines.join('\n')}\n`);
}

/** String-like primitives render as `string` in every TS convention. */
const WASM_STRING_LIKE_PRIMITIVES: ReadonlySet<string> = new Set([
  'string',
  'uuid',
  'timestamp',
  'decimal',
]);

/**
 * IR type → TS type for the wasm declaration surface. Composites mirror
 * the generated Rust shapes: list → Vec (plain array), set → BTreeSet
 * (readonly array, elements in canonical order per issue #117 part A),
 * map → BTreeMap (Record; JSON object keys are strings, mirroring
 * mapKeyRef in mappings.ts), optional → Option (nullable).
 */
function wasmTsType(ref: TypeRef, ir: IRPackage): string {
  switch (ref.kind) {
    case 'primitive': {
      const p = ref.primitive;
      if (p === 'bool') return 'boolean';
      if (p === 'bytes') return 'Uint8Array';
      if (p === 'json') return 'unknown';
      if (WASM_STRING_LIKE_PRIMITIVES.has(p)) return 'string';
      return 'number'; // int32/int64/uint32/uint64/float32/float64
    }
    case 'named': {
      // Local types win over same-named cross-package references (the
      // generators' collision rules reject ambiguous contracts).
      const local = ir.types.find((t) => t.name === ref.name);
      if (local !== undefined) {
        switch (local.kind) {
          case 'alias':
            return wasmTsType(local.target, ir);
          case 'struct':
            // The same struct's wasm-bindgen wrapper class.
            return `${ref.name}Wasm`;
          case 'enum': {
            // Enums cross as their wire-name string (serde rename); the
            // literal union mirrors the TS generator's enum mapping.
            const variants = local.variants.map((v) => JSON.stringify(v.name));
            return variants.length > 0 ? variants.join(' | ') : 'string';
          }
          case 'union':
            // Unions have no wasm-bindgen wrapper: JSON {kind, value}.
            return 'unknown';
        }
      }
      return 'unknown'; // opaque cross-package passthrough (serde_json::Value)
    }
    case 'list':
      return `${wasmTsType(ref.element, ir)}[]`;
    case 'set':
      return `readonly ${wasmTsType(ref.element, ir)}[]`;
    case 'map':
      return `Record<string, ${wasmTsType(ref.value, ir)}>`;
    case 'optional':
      return `${wasmTsType(ref.inner, ir)} | null`;
  }
}

/** index.js: loader + typed façade over the wasm-bindgen output. */
function tsLoader(ir: IRPackage): GeneratedFile {
  const crate = (ffiCrateName(ir.name) + '-wasm').replace(/-/g, '_');
  const lines: string[] = [];
  lines.push(fileHeader('//', ir.name));
  lines.push('');
  lines.push('/**');
  lines.push(' * Loader + typed façade for the wasm module. Run `wasm-bindgen` with');
  lines.push(' * `--out-dir pkg` on the built wasm32 artifact first:');
  lines.push(' *');
  lines.push(' *   cargo build --target wasm32-unknown-unknown --release');
  lines.push(` *   wasm-bindgen target/wasm32-unknown-unknown/release/${crate}.wasm --out-dir pkg --target bundler`);
  lines.push(' *');
  lines.push(' * The default import path resolves to ./pkg — override with');
  lines.push(' * BRIDGE_WASM_INIT env-free bundler aliases if needed.');
  lines.push(' */');
  lines.push('');
  lines.push(`// @ts-ignore — generated by wasm-bindgen at build time`);
  lines.push(`import init, { bridgePackage, bridgeFormatVersion${''} } from './pkg/${crate}_bg.js';`);
  lines.push('');
  lines.push('export * from \'./index.d.js\';');
  lines.push('');
  lines.push('let initialized = false;');
  lines.push('');
  lines.push('/** Loads and instantiates the wasm module exactly once. */');
  lines.push('export async function loadWasm(): Promise<void> {');
  lines.push('  if (initialized) return;');
  lines.push('  await init();');
  lines.push('  initialized = true;');
  lines.push('}');
  lines.push('');
  lines.push('/** Identity probe: returns the contract package name from the module. */');
  lines.push('export async function packageId(): Promise<string> {');
  lines.push('  await loadWasm();');
  lines.push('  return bridgePackage();');
  lines.push('}');
  lines.push('');
  lines.push('/** Format gate: returns 1 for the v1 wire format. */');
  lines.push('export async function formatVersion(): Promise<number> {');
  lines.push('  await loadWasm();');
  lines.push('  return bridgeFormatVersion();');
  lines.push('}');
  lines.push('');
  return generatedFile('index.ts', `${lines.join('\n')}\n`);
}

function camelToJs(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}
