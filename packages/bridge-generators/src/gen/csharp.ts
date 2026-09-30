/**
 * C# generator.
 *
 * Emits, in order: <Namespace>.csproj, Enums.cs, Models.cs, Validation.cs,
 * Services.cs, Events.cs, RoundTripTest.cs. Files whose content would be
 * empty are skipped, keeping the file list deterministic.
 *
 * C#-specific decisions (documented in generated files too):
 * - Zero dependencies: generated code uses only the Base Class Library
 *   (System.Text.Json, System.Net.Http, System.Net, System.Text.Regular
 *   Expressions). The .csproj targets net8.0 with no package references.
 * - Structs map to `sealed class` types: settable properties, ToDict()
 *   (Dictionary<string, object> in declared field order), FromDict
 *   (System.Text.Json JsonElement), Validate(), synthesized value
 *   equality/hash/ToString.
 * - Wire names stay the declared snake_case names; property names are
 *   PascalCase (keyword collisions get a trailing underscore).
 * - Enums map to `readonly record struct` wrappers around a string Value
 *   (C# enums cannot carry string wire values). Constants are PascalCase;
 *   Parse throws ArgumentException on unknown wire values.
 * - Tagged unions map to a record with Kind + Value and per-variant
 *   factories/asAccessors, matching the {"kind", "value"} wire format.
 * - Optional fields map to nullable properties (`T?` covers both value
 *   and reference types); absent/JSON-null decode to null.
 * - `bytes` maps to byte[]; System.Text.Json serializes byte[] as a
 *   base64 string, which is exactly the Bridge wire encoding.
 * - `set<T>` maps to HashSet<T>; the wire format is ALWAYS a JSON array
 *   and ToDict sorts elements into the canonical Bridge set order (numbers
 *   numerically, strings by Unicode code point via UTF-8 bytes, enums by
 *   wire name, false < true — identical in all six targets, #117).
 * - Type aliases have no C# declaration: the underlying type is
 *   substituted everywhere (see mappings.ts aliasTargets).
 * - Cross-package references become opaque JsonElement passthrough
 *   fields documented as "imported from <pkg>".
 * - `timestamp` stays a string (RFC 3339 passthrough) so the wire text
 *   is byte-identical with the other targets; a structured
 *   DateTimeOffset would re-normalize the text.
 * - uint32/uint64 map to uint/ulong (exact unsigned range; non-CLS-
 *   compliant types, accepted by generated assemblies).
 * - Validation lives in Validation.cs as static Validate<Struct>(value)
 *   functions; models expose a Validate() method that delegates.
 * - Services map to a synchronous <Service>Client using HttpClient
 *   (POST JSON to /<package>/<Service>/<Method>) plus an
 *   <Service>HttpListenerServer adapter on System.Net.HttpListener.
 * - Errors are {"code": str, "message": str} bodies with the canonical
 *   Bridge error-code to HTTP-status mapping (identical in every target).
 * - Events map to payload records plus the CloudEvents-style Bridge
 *   envelope {"specversion", "id", "source", "type", "time", "data"};
 *   id/source/time are ALWAYS caller-supplied (no clocks, no uuid
 *   generation — determinism).
 */

import type {
  IRConstraint,
  IREvent,
  IRField,
  IRService,
  IRTypeDefinition,
  PrimitiveKind,
  TypeRef,
} from '@bridge/core';
import { generatedFile, joinBlocks } from '../util';
import { fileHeader } from '../header';
import { docLines, withDeprecation } from '../docs';
import {
  NUMERIC_PRIMITIVES,
  STRING_LIKE_PRIMITIVES,
  isLocalStructRef,
  renderTypeRef,
} from '../mappings';
import { crossPackageRefs, sortedEvents, sortedServices, sortedTypes } from '../analysis';
import {
  csharpNamespace,
  csharpPropertyName,
  csharpSafeIdent,
} from '../naming';
import type { GeneratedFile, GeneratorInput } from './input';
import { GENERATED_MARKER, HEADER_GENERATOR_VERSION } from '../header';
import { ENVELOPE_SPECVERSION, eventTypeName, RPC_ERROR_CODES_SORTED, RPC_ERROR_STATUS } from '../wire';

/** Generates the C# project for an IR package. */
export function generateCSharp(input: GeneratorInput): GeneratedFile[] {
  const files: GeneratedFile[] = [csprojFile(input)];

  const types = sortedTypes(input.ir);
  const enumsFile = csharpEnumsFile(input);
  if (enumsFile !== undefined) files.push(enumsFile);
  const modelsFile = csharpModelsFile(input);
  if (modelsFile !== undefined) files.push(modelsFile);
  const validationFile = csharpValidationFile(input);
  if (validationFile !== undefined) files.push(validationFile);
  if (input.generateServices) {
    const servicesFile = csharpServicesFile(input);
    if (servicesFile !== undefined) files.push(servicesFile);
  }
  if (input.generateEvents) {
    const eventsFile = csharpEventsFile(input);
    if (eventsFile !== undefined) files.push(eventsFile);
  }
  const roundtrip = csharpRoundtripFile(input);
  if (roundtrip !== undefined) files.push(roundtrip);

  return files;
}

/* ------------------------------------------------------------------ */
/* Doc comments                                                        */
/* ------------------------------------------------------------------ */

/** XML doc comment for a docs string (+ deprecation), at the given indent. */
function csDoc(
  docs: string | undefined,
  deprecated: string | true | undefined,
  indent: string,
): string | undefined {
  const lines = withDeprecation(docLines(docs), deprecated);
  if (lines.length === 0) return undefined;
  const out = [`${indent}/// <summary>`];
  for (const line of lines) {
    out.push(`${indent}/// ${xmlEscape(line)}`.trimEnd());
  }
  out.push(`${indent}/// </summary>`);
  return out.join('\n');
}

function xmlEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The C# property name for a field (PascalCase, keyword-escaped). */
function cp(field: IRField): string {
  return csharpPropertyName(field.name).name;
}

/**
 * PascalCase identifier that PRESERVES existing camel humps
 * (`CreatePayment` stays `CreatePayment`; `create_payment` becomes
 * `CreatePayment`).
 */
function camelToPascal(name: string): string {
  return pascal(name.replace(/([a-z0-9])([A-Z])/g, '$1_$2'));
}

/** PascalCase identifier from a snake_case or SCREAMING_SNAKE name. */
function pascal(name: string): string {
  const parts = name.split(/[_\s]+/).filter((p) => p.length > 0);
  if (parts.length === 0) return 'Value';
  let out = '';
  for (const part of parts) {
    out += part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Serialization helpers                                               */
/* ------------------------------------------------------------------ */

/**
 * C# expression converting a value of the given type into its JSON wire
 * value (an object suitable for the ToDict dictionary). Works for all
 * TypeRef shapes because LINQ covers the composite cases.
 */
function serializeExpr(ref: TypeRef, value: string, input: GeneratorInput): string {
  switch (ref.kind) {
    case 'primitive':
      if (ref.primitive === 'bytes') return `Convert.ToBase64String(${value})`;
      return value;
    case 'named': {
      const aliasTarget = input.render.aliasTargets?.get(ref.name);
      if (aliasTarget !== undefined) return serializeExpr(aliasTarget, value, input);
      const local = input.ir.types.find((t) => t.name === ref.name);
      if (local !== undefined && local.kind === 'enum') return `${value}.Value`;
      if (local !== undefined && (local.kind === 'struct' || local.kind === 'union')) {
        return `${value}.ToDict()`;
      }
      return value; // opaque cross-package passthrough
    }
    case 'list':
      return `new List<object>(${value}.Select(item => (object)${serializeExpr(ref.element, 'item', input)}).ToList())`;
    case 'set': {
      // Canonical Bridge set order (#117), identical in every target
      // language: numeric/bool elements in natural order (ascending /
      // false<true), strings and enum wire names by Unicode code point
      // (UTF-8 byte order — StringComparer.Ordinal compares UTF-16 code
      // units, which reorders supplementary characters). Remaining element
      // kinds keep the compilable string-projection fallback.
      const elementSort = setElementSortClass(ref.element, input);
      if (elementSort === 'numeric' || elementSort === 'bool') {
        return `new List<object>(${value}.OrderBy(x => x).Select(item => (object)${serializeExpr(ref.element, 'item', input)}).ToList())`;
      }
      if (elementSort === 'string') {
        return `new List<object>(${value}.OrderBy(x => x, BridgeJson.Utf8Comparer).Select(item => (object)${serializeExpr(ref.element, 'item', input)}).ToList())`;
      }
      if (elementSort === 'enum') {
        return `new List<object>(${value}.OrderBy(x => x.Value, BridgeJson.Utf8Comparer).Select(item => (object)${serializeExpr(ref.element, 'item', input)}).ToList())`;
      }
      return `new List<object>(${value}.OrderBy(x => x?.ToString(), StringComparer.Ordinal).Select(item => (object)${serializeExpr(ref.element, 'item', input)}).ToList())`;
    }
    case 'map':
      return `new Dictionary<string, object>(${value}.ToDictionary(kv => kv.Key, kv => (object)${serializeExpr(ref.value, 'kv.Value', input)}))`;
    case 'optional':
      return serializeExpr(ref.inner, value, input);
  }
}

/**
 * Sort class of a set element for the canonical Bridge set order (#117).
 * Mirrors the Java setElementSort: numbers/bools natural, string-likes and
 * enums code-point ordered, everything else on the projection fallback.
 */
function setElementSortClass(ref: TypeRef, input: GeneratorInput): 'numeric' | 'bool' | 'string' | 'enum' | 'other' {
  switch (ref.kind) {
    case 'primitive':
      if (NUMERIC_PRIMITIVES.has(ref.primitive)) return 'numeric';
      if (ref.primitive === 'bool') return 'bool';
      if (STRING_LIKE_PRIMITIVES.has(ref.primitive)) return 'string';
      return 'other';
    case 'named': {
      // Aliases are substituted in C#, so resolve to the underlying type.
      const aliasTarget = input.render.aliasTargets?.get(ref.name);
      if (aliasTarget !== undefined) return setElementSortClass(aliasTarget, input);
      const local = input.ir.types.find((t) => t.name === ref.name);
      if (local !== undefined && local.kind === 'enum') return 'enum';
      return 'other';
    }
    default:
      return 'other';
  }
}

/**
 * C# expression converting a JsonElement (`raw`) into a value of the
 * given type. `ctx` labels error messages. Assumes null was handled by
 * the caller for optional fields.
 */
function deserializeExpr(ref: TypeRef, raw: string, input: GeneratorInput, ctx: string): string {
  switch (ref.kind) {
    case 'primitive':
      return deserializePrimitiveExpr(ref.primitive, raw, ctx);
    case 'named': {
      const aliasTarget = input.render.aliasTargets?.get(ref.name);
      if (aliasTarget !== undefined) return deserializeExpr(aliasTarget, raw, input, ctx);
      const local = input.ir.types.find((t) => t.name === ref.name);
      if (local !== undefined && local.kind === 'enum') {
        return `${ref.name}.Parse(BridgeJson.expectString(${raw}, ${JSON.stringify(ctx)}))`;
      }
      if (local !== undefined && (local.kind === 'struct' || local.kind === 'union')) {
        return `${ref.name}.FromDict(BridgeJson.expectObject(${raw}, ${JSON.stringify(ctx)}))`;
      }
      return `${raw}.Clone()`; // opaque cross-package passthrough
    }
    case 'list':
      return `BridgeJson.expectArray(${raw}, ${JSON.stringify(ctx)}).EnumerateArray().Select(item => ${deserializeExpr(ref.element, 'item', input, `${ctx}[]`)}).ToList()`;
    case 'set':
      return `new HashSet<${renderTypeRef(ref.element, input.render)}>(BridgeJson.expectArray(${raw}, ${JSON.stringify(ctx)}).EnumerateArray().Select(item => ${deserializeExpr(ref.element, 'item', input, `${ctx}[]`)}))`;
    case 'map': {
      const valueType = renderTypeRef(ref.value, input.render);
      return `BridgeJson.expectObject(${raw}, ${JSON.stringify(ctx)}).EnumerateObject().Aggregate(new Dictionary<string, ${valueType}>(), (acc, prop) => { acc[prop.Name] = ${deserializeExpr(ref.value, 'prop.Value', input, `${ctx}[]`)}; return acc; })`;
    }
    case 'optional':
      return deserializeExpr(ref.inner, raw, input, ctx);
  }
}

/** Primitive wire→C# conversion (non-null JsonElement). */
function deserializePrimitiveExpr(primitive: PrimitiveKind, raw: string, ctx: string): string {
  if (primitive === 'bytes') {
    return `Convert.FromBase64String(BridgeJson.expectString(${raw}, ${JSON.stringify(ctx)}))`;
  }
  if (primitive === 'json') {
    return `${raw}.Clone()`;
  }
  if (STRING_LIKE_PRIMITIVES.has(primitive)) {
    return `BridgeJson.expectString(${raw}, ${JSON.stringify(ctx)})`;
  }
  if (primitive === 'bool') {
    return `BridgeJson.expectBool(${raw}, ${JSON.stringify(ctx)})`;
  }
  if (primitive === 'float32') {
    return `BridgeJson.expectFloat(${raw}, ${JSON.stringify(ctx)})`;
  }
  if (primitive === 'float64') {
    return `BridgeJson.expectDouble(${raw}, ${JSON.stringify(ctx)})`;
  }
  if (primitive === 'int32') {
    return `BridgeJson.expectInt(${raw}, ${JSON.stringify(ctx)})`;
  }
  if (primitive === 'int64') {
    return `BridgeJson.expectLong(${raw}, ${JSON.stringify(ctx)})`;
  }
  if (primitive === 'uint32') {
    return `BridgeJson.expectUInt(${raw}, ${JSON.stringify(ctx)})`;
  }
  if (primitive === 'uint64') {
    return `BridgeJson.expectULong(${raw}, ${JSON.stringify(ctx)})`;
  }
  return `BridgeJson.expectString(${raw}, ${JSON.stringify(ctx)})`;
}

/* ------------------------------------------------------------------ */
/* csproj                                                              */
/* ------------------------------------------------------------------ */

function csprojFile(input: GeneratorInput): GeneratedFile {
  const lines: string[] = [];
  // XML files cannot start with a line comment; use an XML comment block.
  lines.push(`<!-- ${GENERATED_MARKER} Generator version: ${HEADER_GENERATOR_VERSION} Package: ${input.packageName} -->`);
  lines.push('<Project Sdk="Microsoft.NET.Sdk">');
  lines.push('');
  lines.push('  <PropertyGroup>');
  lines.push('    <TargetFramework>net8.0</TargetFramework>');
  lines.push('    <OutputType>Exe</OutputType>');
  lines.push('    <ImplicitUsings>enable</ImplicitUsings>');
  lines.push('    <Nullable>annotations</Nullable>');
  lines.push('    <RootNamespace>' + csharpNamespace(input.packageName) + '</RootNamespace>');
  lines.push('    <AssemblyName>' + csharpNamespace(input.packageName) + '</AssemblyName>');
  lines.push(`    <Description>Generated Bridge contracts for ${xmlEscape(input.packageName)}.</Description>`);
  lines.push('  </PropertyGroup>');
  lines.push('');
  lines.push('</Project>');
  lines.push('');
  return generatedFile(`${csharpNamespace(input.packageName)}.csproj`, lines.join('\n'));
}

/* ------------------------------------------------------------------ */
/* Enums.cs                                                            */
/* ------------------------------------------------------------------ */

/** Emits Enums.cs with one readonly record struct per Bridge enum. */
function csharpEnumsFile(input: GeneratorInput): GeneratedFile | undefined {
  const enums = sortedTypes(input.ir).filter(
    (t): t is IRTypeDefinition & { kind: 'enum' } => t.kind === 'enum',
  );
  if (enums.length === 0) return undefined;

  const blocks: string[] = [];
  for (const enumType of enums) {
    const lines: string[] = [];
    const doc = csDoc(enumType.docs, enumType.deprecated, '');
    if (doc !== undefined) lines.push(doc);
    if (enumType.deprecated !== undefined) lines.push('[Obsolete]');
    lines.push(`public readonly record struct ${enumType.name}`);
    lines.push('{');
    lines.push('    public string Value { get; }');
    lines.push('');
    lines.push(`    public ${enumType.name}(string value) { Value = value; }`);
    lines.push('');
    for (const variant of enumType.variants) {
      const name = pascal(variant.name);
      const vdoc = csDoc(variant.docs, variant.deprecated, '    ');
      if (vdoc !== undefined) lines.push(vdoc);
      lines.push(`    public static readonly ${enumType.name} ${csharpSafeIdent(name)} = new(${JSON.stringify(variant.name)});`);
    }
    lines.push('');
    lines.push(`    public static ${enumType.name} Parse(string value) {`);
    lines.push('        return value switch {');
    for (const variant of enumType.variants) {
      lines.push(`            ${JSON.stringify(variant.name)} => new ${enumType.name}(${JSON.stringify(variant.name)}),`);
    }
    const allowed = enumType.variants.map((v) => v.name).join(', ');
    lines.push(`            _ => throw new ArgumentException("Unknown ${enumType.name} value: " + value + ". Allowed: ${allowed}")`);
    lines.push('        };');
    lines.push('    }');
    lines.push('');
    lines.push('    public override string ToString() { return Value; }');
    lines.push('}');
    blocks.push(lines.join('\n'));
  }

  const content = [
    fileHeader('csharp', input.packageName),
    `namespace ${csharpNamespace(input.packageName)};`,
    '',
    joinBlocks(blocks),
    '',
  ].join('\n');
  return generatedFile('Enums.cs', content);
}

/* ------------------------------------------------------------------ */
/* Models.cs                                                           */
/* ------------------------------------------------------------------ */

/** Emits Models.cs: one sealed class per struct + per tagged union. */
function csharpModelsFile(input: GeneratorInput): GeneratedFile | undefined {
  const types = sortedTypes(input.ir).filter((t) => t.kind === 'struct' || t.kind === 'union');
  if (types.length === 0) return undefined;

  const blocks: string[] = [];

  // Shared JSON helper methods (expect*) for untrusted input conversion.
  blocks.push(jsonHelpersBlock());

  // Opaque cross-package aliases are represented as JsonElement fields
  // directly; no declaration is emitted for them here.

  for (const type of types) {
    if (type.kind === 'struct') {
      blocks.push(renderStructRecord(input, type));
    } else if (type.kind === 'union') {
      blocks.push(renderUnionRecord(input, type));
    }
  }

  const content = [
    fileHeader('csharp', input.packageName),
    `namespace ${csharpNamespace(input.packageName)};`,
    '',
    'using System.Text.Json;',
    '',
    joinBlocks(blocks),
    '',
  ].join('\n');
  return generatedFile('Models.cs', content);
}

/** Static expect* helpers shared by all FromDict decoders. */
function jsonHelpersBlock(): string {
  const lines: string[] = [];
  lines.push('/// <summary>');
  lines.push('/// JSON extraction helpers. Contract contents are untrusted input:');
  lines.push('/// every conversion produces a precise error message');
  lines.push('/// ("Type.field: expected ...") instead of a raw cast failure.');
  lines.push('/// </summary>');
  lines.push('public static class BridgeJson');
  lines.push('{');
  lines.push('    public static JsonElement expectObject(JsonElement el, string ctx) {');
  lines.push('        if (el.ValueKind != JsonValueKind.Object) {');
  lines.push('            throw new ArgumentException(ctx + ": expected object");');
  lines.push('        }');
  lines.push('        return el;');
  lines.push('    }');
  lines.push('');
  lines.push('    public static JsonElement expectArray(JsonElement el, string ctx) {');
  lines.push('        if (el.ValueKind != JsonValueKind.Array) {');
  lines.push('            throw new ArgumentException(ctx + ": expected array");');
  lines.push('        }');
  lines.push('        return el;');
  lines.push('    }');
  lines.push('');
  lines.push('    public static string expectString(JsonElement el, string ctx) {');
  lines.push('        if (el.ValueKind != JsonValueKind.String) {');
  lines.push('            throw new ArgumentException(ctx + ": expected string");');
  lines.push('        }');
  lines.push('        return el.GetString()!;');
  lines.push('    }');
  lines.push('');
  lines.push('    public static bool expectBool(JsonElement el, string ctx) {');
  lines.push('        if (el.ValueKind != JsonValueKind.True && el.ValueKind != JsonValueKind.False) {');
  lines.push('            throw new ArgumentException(ctx + ": expected boolean");');
  lines.push('        }');
  lines.push('        return el.GetBoolean();');
  lines.push('    }');
  lines.push('');
  lines.push('    public static int expectInt(JsonElement el, string ctx) {');
  lines.push('        if (el.ValueKind != JsonValueKind.Number) {');
  lines.push('            throw new ArgumentException(ctx + ": expected integer");');
  lines.push('        }');
  lines.push('        return el.GetInt32();');
  lines.push('    }');
  lines.push('');
  lines.push('    public static long expectLong(JsonElement el, string ctx) {');
  lines.push('        if (el.ValueKind != JsonValueKind.Number) {');
  lines.push('            throw new ArgumentException(ctx + ": expected integer");');
  lines.push('        }');
  lines.push('        return el.GetInt64();');
  lines.push('    }');
  lines.push('');
  lines.push('    public static uint expectUInt(JsonElement el, string ctx) {');
  lines.push('        if (el.ValueKind != JsonValueKind.Number || el.GetDouble() < 0) {');
  lines.push('            throw new ArgumentException(ctx + ": expected unsigned integer");');
  lines.push('        }');
  lines.push('        return el.GetUInt32();');
  lines.push('    }');
  lines.push('');
  lines.push('    public static ulong expectULong(JsonElement el, string ctx) {');
  lines.push('        if (el.ValueKind != JsonValueKind.Number || el.GetDouble() < 0) {');
  lines.push('            throw new ArgumentException(ctx + ": expected unsigned integer");');
  lines.push('        }');
  lines.push('        return el.GetUInt64();');
  lines.push('    }');
  lines.push('');
  lines.push('    public static float expectFloat(JsonElement el, string ctx) {');
  lines.push('        if (el.ValueKind != JsonValueKind.Number) {');
  lines.push('            throw new ArgumentException(ctx + ": expected number");');
  lines.push('        }');
  lines.push('        return el.GetSingle();');
  lines.push('    }');
  lines.push('');
  lines.push('    public static double expectDouble(JsonElement el, string ctx) {');
  lines.push('        if (el.ValueKind != JsonValueKind.Number) {');
  lines.push('            throw new ArgumentException(ctx + ": expected number");');
  lines.push('        }');
  lines.push('        return el.GetDouble();');
  lines.push('    }');
  lines.push('');
  lines.push('    /// <summary>Canonical string order for set elements (#117): compares');
  lines.push('    /// by UTF-8 bytes, i.e. Unicode code points — NOT StringComparer.Ordinal,');
  lines.push('    /// which is UTF-16 code-unit order and reorders supplementary (non-BMP)');
  lines.push('    /// characters.</summary>');
  lines.push('    public static readonly Comparer<string> Utf8Comparer = Comparer<string>.Create(CompareUtf8);');
  lines.push('');
  lines.push('    private static int CompareUtf8(string a, string b) {');
  lines.push('        byte[] ba = System.Text.Encoding.UTF8.GetBytes(a);');
  lines.push('        byte[] bb = System.Text.Encoding.UTF8.GetBytes(b);');
  lines.push('        int n = Math.Min(ba.Length, bb.Length);');
  lines.push('        for (int i = 0; i < n; i++) {');
  lines.push('            if (ba[i] != bb[i]) { return ba[i].CompareTo(bb[i]); }');
  lines.push('        }');
  lines.push('        return ba.Length.CompareTo(bb.Length);');
  lines.push('    }');
  lines.push('');
  lines.push('    /// <summary>Structural equality for wire values: dictionaries by');
  lines.push('    /// key/value, lists in order, sets as sets, bytes and JSON trees');
  lines.push('    /// by content. Record Equals uses this so collections compare by');
  lines.push('    /// value, matching the other generated languages.</summary>');
  lines.push('    public static bool DeepEquals(object? a, object? b) {');
  lines.push('        if (a is null || b is null) { return a is null && b is null; }');
  lines.push('        if (a is JsonElement ea && b is JsonElement eb) { return JsonDeepEquals(ea, eb); }');
  lines.push('        if (a is Dictionary<string, object> da && b is Dictionary<string, object> db) {');
  lines.push('            if (da.Count != db.Count) { return false; }');
  lines.push('            foreach (var kv in da) {');
  lines.push('                if (!db.TryGetValue(kv.Key, out var v) || !DeepEquals(kv.Value, v)) { return false; }');
  lines.push('            }');
  lines.push('            return true;');
  lines.push('        }');
  lines.push('        if (a is byte[] ba && b is byte[] bb) { return ba.AsSpan().SequenceEqual(bb); }');
  lines.push('        if (a is System.Collections.IList la && b is System.Collections.IList lb) {');
  lines.push('            if (la.Count != lb.Count) { return false; }');
  lines.push('            for (int i = 0; i < la.Count; i++) {');
  lines.push('                if (!DeepEquals(la[i], lb[i])) { return false; }');
  lines.push('            }');
  lines.push('            return true;');
  lines.push('        }');
  lines.push('        if (a is System.Collections.IEnumerable ea2 && b is System.Collections.IEnumerable eb2 && a is not string && b is not string) {');
  lines.push('            var sa = ea2.Cast<object>().OrderBy(x => x?.ToString(), StringComparer.Ordinal).ToList();');
  lines.push('            var sb = eb2.Cast<object>().OrderBy(x => x?.ToString(), StringComparer.Ordinal).ToList();');
  lines.push('            if (sa.Count != sb.Count) { return false; }');
  lines.push('            for (int i = 0; i < sa.Count; i++) {');
  lines.push('                if (!DeepEquals(sa[i], sb[i])) { return false; }');
  lines.push('            }');
  lines.push('            return true;');
  lines.push('        }');
  lines.push('        return a.Equals(b);');
  lines.push('    }');
  lines.push('');
  lines.push('    /// <summary>Hash consistent with DeepEquals (within a process).</summary>');
  lines.push('    public static int DeepHashCode(object? value) {');
  lines.push('        if (value is null) { return 0; }');
  lines.push('        if (value is JsonElement je) { return je.GetRawText().GetHashCode(StringComparison.Ordinal); }');
  lines.push('        if (value is Dictionary<string, object> d) {');
  lines.push('            var h = new HashCode();');
  lines.push('            foreach (var kv in d) { h.Add(kv.Key); h.Add(DeepHashCode(kv.Value)); }');
  lines.push('            return h.ToHashCode();');
  lines.push('        }');
  lines.push('        if (value is byte[] b) {');
  lines.push('            var h = new HashCode();');
  lines.push('            foreach (var item in b) { h.Add(item); }');
  lines.push('            return h.ToHashCode();');
  lines.push('        }');
  lines.push('        if (value is System.Collections.IList l) {');
  lines.push('            var h = new HashCode();');
  lines.push('            foreach (var item in l) { h.Add(DeepHashCode(item)); }');
  lines.push('            return h.ToHashCode();');
  lines.push('        }');
  lines.push('        if (value is System.Collections.IEnumerable e && value is not string) {');
  lines.push('            var h = new HashCode();');
  lines.push('            foreach (var item in e.Cast<object>().OrderBy(x => x?.ToString(), StringComparer.Ordinal)) { h.Add(DeepHashCode(item)); }');
  lines.push('            return h.ToHashCode();');
  lines.push('        }');
  lines.push('        return value.GetHashCode();');
  lines.push('    }');
  lines.push('');
  lines.push('    /// <summary>Recursive JsonElement structural comparison.</summary>');
  lines.push('    private static bool JsonDeepEquals(JsonElement a, JsonElement b) {');
  lines.push('        if (a.ValueKind != b.ValueKind) { return false; }');
  lines.push('        switch (a.ValueKind) {');
  lines.push('            case JsonValueKind.Object: {');
  lines.push('                var av = a.EnumerateObject().ToList();');
  lines.push('                if (av.Count != b.EnumerateObject().Count()) { return false; }');
  lines.push('                foreach (var prop in av) {');
  lines.push('                    if (!b.TryGetProperty(prop.Name, out var bv) || !JsonDeepEquals(prop.Value, bv)) { return false; }');
  lines.push('                }');
  lines.push('                return true;');
  lines.push('            }');
  lines.push('            case JsonValueKind.Array: {');
  lines.push('                var av = a.EnumerateArray().ToList();');
  lines.push('                var bv = b.EnumerateArray().ToList();');
  lines.push('                if (av.Count != bv.Count) { return false; }');
  lines.push('                for (int i = 0; i < av.Count; i++) {');
  lines.push('                    if (!JsonDeepEquals(av[i], bv[i])) { return false; }');
  lines.push('                }');
  lines.push('                return true;');
  lines.push('            }');
  lines.push('            default:');
  lines.push('                return a.GetRawText() == b.GetRawText();');
  lines.push('        }');
  lines.push('    }');
  lines.push('}');
  return lines.join('\n');
}

/** Renders one struct as a sealed class with ToDict/FromDict/Validate. */
function renderStructRecord(
  input: GeneratorInput,
  type: IRTypeDefinition & { kind: 'struct' },
): string {
  const lines: string[] = [];
  const className = type.name;
  const doc = csDoc(type.docs, type.deprecated, '');
  if (doc !== undefined) lines.push(doc);
  if (type.deprecated !== undefined) lines.push('[Obsolete]');
  lines.push(`public sealed class ${className}`);
  lines.push('{');
  // Properties
  for (const field of type.fields) {
    const fdoc = csDoc(field.docs, field.deprecated, '    ');
    if (fdoc !== undefined) lines.push(fdoc);
    lines.push(`    public ${csharpFieldType(field, input)} ${cp(field)} { get; set; }`);
  }
  if (type.fields.length > 0) lines.push('');
  // ToDict
  lines.push('    /// <summary>Serializes to the Bridge wire representation.</summary>');
  lines.push('    public Dictionary<string, object> ToDict()');
  lines.push('    {');
  lines.push('        var outDict = new Dictionary<string, object>();');
  for (const field of type.fields) {
    const value = fieldIsOptionalCs(field)
      ? serializeExpr(unwrapOptionalCs(field.type), `this.${cp(field)}`, input)
      : serializeExpr(field.type, `this.${cp(field)}`, input);
    if (fieldIsOptionalCs(field)) {
      lines.push(`        if (this.${cp(field)} is not null) {`);
      lines.push(`            outDict[${JSON.stringify(field.name)}] = ${value};`);
      lines.push('        }');
    } else if (field.type.kind === 'optional') {
      lines.push(`        outDict[${JSON.stringify(field.name)}] = ${value}!;`);
    } else {
      lines.push(`        outDict[${JSON.stringify(field.name)}] = ${value};`);
    }
  }
  lines.push('        return outDict;');
  lines.push('    }');
  lines.push('');
  // FromDict
  lines.push('    /// <summary>');
  lines.push('    /// Decodes from the Bridge wire representation; throws');
  lines.push('    /// ArgumentException on missing required fields or bad types.');
  lines.push('    /// </summary>');
  lines.push(`    public static ${className} FromDict(JsonElement root)`);
  lines.push('    {');
  lines.push('        if (root.ValueKind != JsonValueKind.Object) {');
  lines.push(`            throw new ArgumentException("${className}: expected object");`);
  lines.push('        }');
  for (const field of type.fields) {
    const ctx = `${className}.${field.name}`;
    lines.push(`        ${csharpFieldType(field, input)} ${cp(field)};`);
    lines.push(`        if (root.TryGetProperty(${JSON.stringify(field.name)}, out var el${pascal(field.name)})) {`);
    const inner = fieldIsOptionalCs(field) ? unwrapOptionalCs(field.type) : field.type;
    const converted = deserializeExpr(inner, `el${pascal(field.name)}`, input, ctx);
    if (fieldIsOptionalCs(field)) {
      lines.push(`            ${cp(field)} = el${pascal(field.name)}.ValueKind == JsonValueKind.Null || el${pascal(field.name)}.ValueKind == JsonValueKind.Undefined`);
      lines.push(`                ? null`);
      lines.push(`                : ${converted};`);
    } else if (field.default !== undefined) {
      lines.push(`            ${cp(field)} = el${pascal(field.name)}.ValueKind == JsonValueKind.Null || el${pascal(field.name)}.ValueKind == JsonValueKind.Undefined`);
      lines.push(`                ? ${csharpDefaultLiteral(field.default, field.type, input) ?? csharpDefaultFallback(field.type, input)}`);
      lines.push(`                : ${converted};`);
    } else {
      lines.push(`            ${cp(field)} = ${converted};`);
    }
    lines.push('        } else {');
    if (fieldIsOptionalCs(field) || field.default !== undefined) {
      lines.push(`            ${cp(field)} = ${fieldIsOptionalCs(field) ? 'null' : (csharpDefaultLiteral(field.default!, field.type, input) ?? csharpDefaultFallback(field.type, input))};`);
    } else {
      lines.push(`            throw new ArgumentException(${JSON.stringify(`Missing required field ${field.name} for ${className}`)});`);
    }
    lines.push('        }');
  }
  lines.push(`        return new ${className}`);
  lines.push('        {');
  for (const field of type.fields) {
    lines.push(`            ${cp(field)} = ${cp(field)},`);
  }
  if (lines[lines.length - 1]!.endsWith(',')) {
    lines[lines.length - 1] = lines[lines.length - 1]!.replace(/,$/, '');
  }
  lines.push('        };');
  lines.push('    }');
  lines.push('');
  // Validate
  lines.push('    /// <summary>Validates constraints; returns violation messages (empty means valid).</summary>');
  lines.push('    public List<string> Validate()');
  lines.push('    {');
  lines.push(`        return BridgeValidation.Validate${className}(this);`);
  lines.push('    }');
  lines.push('');
  lines.push(`    public bool Equals(${className}? other) {`);
  lines.push('        return other is not null');
  for (const field of type.fields) {
    lines.push(`            && BridgeJson.DeepEquals(this.${cp(field)}, other.${cp(field)})`);
  }
  if (type.fields.length === 0) {
    lines[lines.length - 1] = '        return other is not null;';
  } else {
    lines[lines.length - 1] = lines[lines.length - 1]!.replace(/$/, ';');
  }
  lines.push('    }');
  lines.push('');
  lines.push('    public override bool Equals(object? other) {');
  lines.push(`        return other is ${className} o && Equals(o);`);
  lines.push('    }');
  lines.push('');
  lines.push('    public override int GetHashCode() {');
  lines.push('        return BridgeJson.DeepHashCode(this.ToDict());');
  lines.push('    }');
  lines.push('}');
  return lines.join('\n');
}

/** Renders one tagged union as a Kind/Value class. */
function renderUnionRecord(
  input: GeneratorInput,
  type: IRTypeDefinition & { kind: 'union' },
): string {
  const lines: string[] = [];
  const className = type.name;
  const doc = csDoc(
    type.docs !== undefined
      ? `${type.docs}\nWire format: {"kind": "<variant>", "value": <payload>}.`
      : 'Tagged union. Wire format: {"kind": "<variant>", "value": <payload>}.',
    type.deprecated,
    '',
  );
  if (doc !== undefined) lines.push(doc);
  if (type.deprecated !== undefined) lines.push('[Obsolete]');
  lines.push(`public sealed class ${className}`);
  lines.push('{');
  lines.push('    public string Kind { get; set; }');
  lines.push('    public object? Value { get; set; }');
  lines.push('');
  for (const variant of type.variants) {
    const factory = csharpSafeIdent(pascal(variant.name));
    const variantType = renderTypeRef(variant.type, input.render);
    const vdoc = csDoc(variant.docs, variant.deprecated, '    ');
    if (vdoc !== undefined) lines.push(vdoc);
    lines.push(`    public static ${className} ${factory}(${variantType} value) {`);
    lines.push(`        return new ${className} { Kind = ${JSON.stringify(variant.name)}, Value = value };`);
    lines.push('    }');
    lines.push('');
    lines.push(`    public ${variantType}? As${pascal(variant.name)}() {`);
    lines.push(`        return Kind == ${JSON.stringify(variant.name)} ? (${variantType}) Value : null;`);
    lines.push('    }');
    lines.push('');
  }
  lines.push('    /// <summary>Serializes to the Bridge wire representation.</summary>');
  lines.push('    public Dictionary<string, object> ToDict()');
  lines.push('    {');
  lines.push('        var outDict = new Dictionary<string, object> { { "kind", Kind } };');
  lines.push('        if (Value is null) { outDict["value"] = null!; return outDict; }');
  for (const variant of type.variants) {
    lines.push(`        if (Kind == ${JSON.stringify(variant.name)}) { outDict["value"] = ${serializeExpr(variant.type, `((${renderTypeRef(variant.type, input.render)})Value)`, input)}; return outDict; }`);
  }
  lines.push('        outDict["value"] = Value;');
  lines.push('        return outDict;');
  lines.push('    }');
  lines.push('');
  lines.push('    /// <summary>');
  lines.push('    /// Decodes from the Bridge wire representation; throws');
  lines.push('    /// ArgumentException on unknown kinds or bad payloads.');
  lines.push('    /// </summary>');
  lines.push(`    public static ${className} FromDict(JsonElement root)`);
  lines.push('    {');
  lines.push('        var kind = BridgeJson.expectString(root.GetProperty("kind"), "Kind");');
  lines.push('        root.TryGetProperty("value", out var rawValue);');
  for (const variant of type.variants) {
    const factory = csharpSafeIdent(pascal(variant.name));
    const inner = deserializeExpr(variant.type, 'rawValue', input, 'Value');
    lines.push(`        if (kind == ${JSON.stringify(variant.name)}) {`);
    lines.push(`            return ${factory}(${inner});`);
    lines.push('        }');
  }
  lines.push(`        throw new ArgumentException("Unknown ${className} kind: " + kind);`);
  lines.push('    }');
  lines.push('');
  lines.push(`    public bool Equals(${className}? other) {`);
  lines.push('        return other is not null && Kind == other.Kind && BridgeJson.DeepEquals(Value, other.Value);');
  lines.push('    }');
  lines.push('');
  lines.push('    public override bool Equals(object? other) {');
  lines.push(`        return other is ${className} o && Equals(o);`);
  lines.push('    }');
  lines.push('');
  lines.push('    public override int GetHashCode() {');
  lines.push('        return BridgeJson.DeepHashCode(this.ToDict());');
  lines.push('    }');
  lines.push('}');
  return lines.join('\n');
}

/** Removes the optional wrapper from a field's TypeRef when present. */
function unwrapOptionalCs(ref: TypeRef): TypeRef {
  return ref.kind === 'optional' ? ref.inner : ref;
}

/** True when the field is optional (flag or explicit optional type). */
function fieldIsOptionalCs(field: IRField): boolean {
  return field.optional || field.type.kind === 'optional';
}

/**
 * The declared C# type for a struct field: optional fields are nullable
 * (`T?` — value types get Nullable<T>, reference types a nullability
 * annotation).
 */
function csharpFieldType(field: IRField, input: GeneratorInput): string {
  if (fieldIsOptionalCs(field)) {
    return `${renderTypeRef(unwrapOptionalCs(field.type), input.render)}?`;
  }
  return renderTypeRef(field.type, input.render);
}

/* ------------------------------------------------------------------ */
/* Validation.cs                                                       */
/* ------------------------------------------------------------------ */

/** Emits Validation.cs with compiled regexes + per-struct validators. */
function csharpValidationFile(input: GeneratorInput): GeneratedFile | undefined {
  const structs = sortedTypes(input.ir).filter(
    (t): t is IRTypeDefinition & { kind: 'struct' } => t.kind === 'struct',
  );
  const payloadStructs: (IRTypeDefinition & { kind: 'struct' })[] = input.generateEvents
    ? sortedEvents(input.ir).map((event) => ({
        name: `${event.name}Payload`,
        kind: 'struct' as const,
        docs: event.docs,
        fields: event.fields,
      }))
    : [];
  const allStructs = [...structs, ...payloadStructs];
  if (allStructs.length === 0) return undefined;
  const payloadNames = new Set(payloadStructs.map((s) => s.name));

  const needsRegex = allStructs.some((t) =>
    t.fields.some((f) =>
      f.constraints.some((c) => c.kind === 'email' || c.kind === 'url' || c.kind === 'uuid' || c.kind === 'pattern'),
    ),
  );

  const lines: string[] = [];
  lines.push(fileHeader('csharp', input.packageName));
  lines.push(`namespace ${csharpNamespace(input.packageName)};`);
  lines.push('');
  if (needsRegex) {
    lines.push('using System.Text.RegularExpressions;');
  }
  lines.push('');
  lines.push('/// <summary>');
  lines.push('/// Validation for the generated Bridge package. Each Validate');
  lines.push('/// function returns a list of violation messages (empty means');
  lines.push('/// valid). Required-field presence is enforced by FromDict; these');
  lines.push('/// functions check constraints and recurse into struct-typed fields.');
  lines.push('/// </summary>');
  lines.push('public static class BridgeValidation');
  lines.push('{');
  if (needsRegex) {
    lines.push('    private static readonly Regex EmailPattern = new("^(?:[^@\\\\s]+@[^@\\\\s]+\\\\.[^@\\\\s]+)\\\\z", RegexOptions.Compiled);');
    lines.push('    private static readonly Regex UrlPattern = new("^(?:https?://\\\\S+)\\\\z", RegexOptions.Compiled);');
    lines.push('    private static readonly Regex UuidPattern = new("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", RegexOptions.Compiled);');
    for (const structType of allStructs) {
      for (const field of structType.fields) {
        for (const constraint of field.constraints) {
          if (constraint.kind === 'pattern' && constraint.args[0] !== undefined) {
            const constant = `P${pascal(structType.name)}${pascal(field.name)}`;
            lines.push(`    private static readonly Regex ${constant} = new("^(?:" + ${JSON.stringify(constraint.args[0])} + ")\\\\z", RegexOptions.Compiled);`);
          }
        }
      }
    }
  }
  for (const structType of allStructs) {
    lines.push('');
    lines.push('    /// <summary>');
    lines.push(`    /// Validates a ${structType.name} instance; returns violation messages.`);
    lines.push('    /// </summary>');
    const paramType = payloadNames.has(structType.name) ? `BridgeEvents.${structType.name}` : structType.name;
    lines.push(`    public static List<string> Validate${structType.name}(${paramType} value)`);
    lines.push('    {');
    lines.push('        var errors = new List<string>();');
    for (const field of structType.fields) {
      const checkLines: string[] = [];
      for (const constraint of field.constraints) {
        const rendered = csConstraintCheck(constraint, field, structType.name);
        if (rendered !== undefined) checkLines.push(...rendered);
      }
      checkLines.push(...csNestedValidation(field, input));
      if (checkLines.length === 0) continue;
      const accessor = `value.${cp(field)}`;
      if (fieldIsOptionalCs(field)) {
        lines.push(`        if (${accessor} is not null) {`);
        lines.push(...checkLines);
        lines.push('        }');
      } else if (csharpFieldIsPrimitive(field)) {
        lines.push(...checkLines);
      } else {
        lines.push(`        if (${accessor} is null) {`);
        lines.push(`            errors.Add(${JSON.stringify(`${structType.name}.${field.name}: required field is null`)});`);
        lines.push('        } else {');
        lines.push(...checkLines);
        lines.push('        }');
      }
    }
    lines.push('        return errors;');
    lines.push('    }');
  }
  lines.push('}');
  lines.push('');
  return generatedFile('Validation.cs', lines.join('\n'));
}

/** Renders one constraint as C# if/Add lines. */
function csConstraintCheck(
  constraint: IRConstraint,
  field: IRField,
  className: string,
): string[] | undefined {
  const label = `${className}.${field.name}`;
  const message = constraint.message ?? `${label}: ${constraint.kind} constraint violated`;
  const fail = `errors.Add(${JSON.stringify(message)});`;
  const arg = constraint.args[0];
  const accessor = fieldIsOptionalCs(field)
    ? `value.${cp(field)}!`
    : `value.${cp(field)}`;
  switch (constraint.kind) {
    case 'min':
      if (arg === undefined) return undefined;
      return [`            if (${accessor} < ${arg}) {`, `                ${fail}`, '            }'];
    case 'max':
      if (arg === undefined) return undefined;
      return [`            if (${accessor} > ${arg}) {`, `                ${fail}`, '            }'];
    case 'length':
      if (arg === undefined) return undefined;
      return [`            if (${accessor}.Length != ${arg}) {`, `                ${fail}`, '            }'];
    case 'email':
      return [`            if (!EmailPattern.IsMatch(${accessor})) {`, `                ${fail}`, '            }'];
    case 'url':
      return [`            if (!UrlPattern.IsMatch(${accessor})) {`, `                ${fail}`, '            }'];
    case 'uuid':
      return [`            if (!UuidPattern.IsMatch(${accessor})) {`, `                ${fail}`, '            }'];
    case 'pattern': {
      if (arg === undefined) return undefined;
      const constant = `P${pascal(className)}${pascal(field.name)}`;
      return [`            if (!${constant}.IsMatch(${accessor})) {`, `                ${fail}`, '            }'];
    }
    default:
      return undefined;
  }
}

/** Nested validation lines for struct-typed fields. */
function csNestedValidation(field: IRField, input: GeneratorInput): string[] {
  let inner = field.type;
  if (inner.kind === 'optional') inner = inner.inner;
  if (!isLocalStructRef(inner, input.ir)) return [];
  const accessor = fieldIsOptionalCs(field) ? `value.${cp(field)}!` : `value.${cp(field)}`;
  if (inner.kind === 'list') {
    const elemTarget = (inner.element as { name: string }).name;
    return [
      `            for (int i = 0; i < ${accessor}.Count; i++) {`,
      `                foreach (var m in BridgeValidation.Validate${elemTarget}(${accessor}[i])) {`,
      `                    errors.Add(${JSON.stringify(elemTarget)} + "[" + i + "]: " + m);`,
      '                }',
      '            }',
    ];
  }
  return [`            errors.AddRange(BridgeValidation.Validate${(inner as { name: string }).name}(${accessor}));`];
}

/** True when the field renders as a C# value type (cannot be null). */
function csharpFieldIsPrimitive(field: IRField): boolean {
  if (fieldIsOptionalCs(field)) return false;
  if (field.type.kind !== 'primitive') return false;
  const p = field.type.primitive;
  return !STRING_LIKE_PRIMITIVES.has(p) && p !== 'bytes' && p !== 'json';
}

/** C# literal for an IDL default value, or undefined when unsupported. */
function csharpDefaultLiteral(
  defaultValue: string,
  ref: TypeRef,
  input: GeneratorInput,
): string | undefined {
  void input;
  const target = unwrapOptionalCs(ref);
  const raw = defaultValue.trim();
  if (raw.length === 0) return undefined;
  let inner = raw;
  if (
    (inner.startsWith('"') && inner.endsWith('"') && inner.length >= 2) ||
    (inner.startsWith("'") && inner.endsWith("'") && inner.length >= 2)
  ) {
    inner = inner.slice(1, -1);
  }
  if (target.kind !== 'primitive') return undefined;
  const p = target.primitive;
  if (p === 'bool') {
    if (inner === 'true') return 'true';
    if (inner === 'false') return 'false';
    return undefined;
  }
  if (NUMERIC_PRIMITIVES.has(p)) {
    if (!/^[+-]?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(inner)) return undefined;
    if (p === 'float32') return `${inner}f`;
    if (p === 'float64') return `${inner}d`;
    if (p === 'uint32') return `${inner}u`;
    if (p === 'uint64') return `${inner}UL`;
    if (p === 'int64') return `${inner}L`;
    return inner;
  }
  if (STRING_LIKE_PRIMITIVES.has(p)) {
    return JSON.stringify(inner);
  }
  return undefined;
}

/** Fallback when a default literal cannot be rendered. */
function csharpDefaultFallback(ref: TypeRef, input: GeneratorInput): string {
  const target = unwrapOptionalCs(ref);
  switch (target.kind) {
    case 'primitive': {
      const p = target.primitive;
      if (STRING_LIKE_PRIMITIVES.has(p)) return '""';
      if (p === 'bool') return 'false';
      if (p === 'bytes') return 'Array.Empty<byte>()';
      if (p === 'float32') return '0f';
      if (p === 'float64') return '0d';
      if (p === 'uint32') return '0u';
      if (p === 'uint64') return '0UL';
      return '0';
    }
    case 'named': {
      const local = input.ir.types.find((t) => t.name === target.name);
      if (local !== undefined && local.kind === 'enum') {
        return `new ${target.name}(${JSON.stringify(local.variants[0]!.name)})`;
      }
      return `${target.name}.FromDict(System.Text.Json.JsonSerializer.Deserialize<System.Text.Json.JsonElement>("{}"))`;
    }
    case 'list':
      return 'new List<' + renderTypeRef(target.element, input.render) + '>()';
    case 'set':
      return 'new HashSet<' + renderTypeRef(target.element, input.render) + '>()';
    case 'map':
      return 'new Dictionary<string, ' + renderTypeRef(target.value, input.render) + '>()';
    case 'optional':
      return 'null';
  }
}

/* ------------------------------------------------------------------ */
/* Services.cs                                                         */
/* ------------------------------------------------------------------ */

/** Emits Services.cs: clients + HttpListener servers for all services. */
function csharpServicesFile(input: GeneratorInput): GeneratedFile | undefined {
  const services = sortedServices(input.ir);
  if (services.length === 0) return undefined;

  const blocks: string[] = [];
  for (const service of services) {
    blocks.push(renderServiceClientCs(input, service));
    blocks.push(renderServiceServerCs(input, service));
  }

  const content = [
    fileHeader('csharp', input.packageName),
    `namespace ${csharpNamespace(input.packageName)};`,
    '',
    'using System.Net;',
    'using System.Text;',
    'using System.Text.Json;',
    '',
    joinBlocks(blocks),
    '',
  ].join('\n');
  return generatedFile('Services.cs', content);
}

/** Renders the synchronous <Service>Client for one service. */
function renderServiceClientCs(input: GeneratorInput, service: IRService): string {
  const lines: string[] = [];
  const className = `${service.name}Client`;
  const doc = csDoc(
    service.docs !== undefined
      ? `${service.docs}\nRoutes: POST /${input.packageName}/${service.name}/<Method>.`
      : `Client for the ${service.name} service.\nRoutes: POST /${input.packageName}/${service.name}/<Method>.`,
    undefined,
    '',
  );
  if (doc !== undefined) lines.push(doc);
  lines.push(`public sealed class ${className}`);
  lines.push('{');
  lines.push('    private readonly HttpClient http;');
  lines.push('    private readonly string baseUrl;');
  lines.push('');
  lines.push(`    public ${className}(string baseUrl, HttpClient? http = null) {`);
  lines.push('        this.baseUrl = baseUrl.EndsWith("/") ? baseUrl[..^1] : baseUrl;');
  lines.push('        this.http = http ?? new HttpClient { Timeout = TimeSpan.FromSeconds(30) };');
  lines.push('    }');
  lines.push('');
  for (const method of service.methods) {
    // Signatures render through the type table so cross-package (opaque)
    // and alias-substituted method types stay compilable; serialization
    // degrades to passthrough for those (same guard as the Go generator).
    const inputType = renderTypeRef(method.input, input.render);
    const outputType = renderTypeRef(method.output, input.render);
    const mName = camelToPascal(method.name);
    const mdoc = csDoc(method.docs, method.deprecated, '    ');
    if (mdoc !== undefined) lines.push(mdoc);
    lines.push(`    public ${outputType} ${mName}(${inputType} request) {`);
    lines.push(`        var url = this.baseUrl + "/${input.packageName}/${service.name}/${method.name}";`);
    lines.push(`        var body = JsonSerializer.Serialize(${serializeExpr(method.input, 'request', input)});`);
    lines.push('        using var content = new StringContent(body, Encoding.UTF8, "application/json");');
    lines.push('        using var response = this.http.PostAsync(url, content).GetAwaiter().GetResult();');
    lines.push('        var text = response.Content.ReadAsStringAsync().GetAwaiter().GetResult();');
    lines.push('        if (!response.IsSuccessStatusCode) {');
    lines.push('            throw new BridgeServiceError((int)response.StatusCode, text);');
    lines.push('        }');
    lines.push('        var parsed = JsonSerializer.Deserialize<JsonElement>(text);');
    lines.push(`        return ${deserializeExpr(method.output, 'parsed', input, 'response')};`);
    lines.push('    }');
    lines.push('');
  }
  lines.push('    /// <summary>Raised when a service call fails at the HTTP level.</summary>');
  lines.push('    public sealed class BridgeServiceError : Exception');
  lines.push('    {');
  lines.push('        public int Status { get; }');
  lines.push('        public string Body { get; }');
  lines.push('');
  lines.push('        public BridgeServiceError(int status, string body)');
  lines.push('            : base("bridge service error " + status + ": " + body)');
  lines.push('        {');
  lines.push('            this.Status = status;');
  lines.push('            this.Body = body;');
  lines.push('        }');
  lines.push('    }');
  lines.push('}');
  return lines.join('\n');
}

/** Renders the <Service>HttpListenerServer for one service. */
function renderServiceServerCs(input: GeneratorInput, service: IRService): string {
  const lines: string[] = [];
  const className = `${service.name}HttpListenerServer`;
  const handler = `${service.name}Handler`;
  lines.push('/// <summary>');
  lines.push(`/// Server adapter for the ${service.name} service.`);
  lines.push('/// Routes POST /&lt;package&gt;/&lt;Service&gt;/&lt;Method&gt; to a handler');
  lines.push('/// implementation. Request validators run before the handler; errors');
  lines.push('/// are {"code": str, "message": str} bodies with the canonical Bridge');
  lines.push('/// error-code to HTTP-status mapping (identical in every target).');
  lines.push('/// </summary>');
  lines.push(`public sealed class ${className}`);
  lines.push('{');
  lines.push(`    private readonly ${handler} handler;`);
  lines.push('');
  lines.push(`    public ${className}(${handler} handler) {`);
  lines.push('        this.handler = handler;');
  lines.push('    }');
  lines.push('');
  lines.push('    /// <summary>Handler interface for the ' + service.name + ' service.</summary>');
  lines.push(`    public interface ${handler} {`);
  for (const method of service.methods) {
    // Signatures render through the type table so cross-package (opaque)
    // and alias-substituted method types stay compilable.
    const inputType = renderTypeRef(method.input, input.render);
    const outputType = renderTypeRef(method.output, input.render);
    lines.push(`        ${outputType} ${camelToPascal(method.name)}(${inputType} request);`);
  }
  lines.push('    }');
  lines.push('');
  lines.push('    /// <summary>Starts an HTTP listener on the given prefix.</summary>');
  lines.push('    public HttpListener Start(string prefix) {');
  lines.push('        var listener = new HttpListener();');
  lines.push('        listener.Prefixes.Add(prefix);');
  lines.push('        listener.Start();');
  lines.push('        _ = Task.Run(() => { while (listener.IsListening) {');
  lines.push('            try { var ctx = listener.GetContext(); Route(ctx); }');
  lines.push('            catch (Exception) when (!listener.IsListening) { break; }');
  lines.push('            catch (Exception) { /* keep serving */ }');
  lines.push('        } });');
  lines.push('        return listener;');
  lines.push('    }');
  lines.push('');
  lines.push(`    private static readonly string RoutePrefix = "/${input.packageName}/${service.name}/";`);
  lines.push('');
  lines.push('    private void Route(HttpListenerContext ctx) {');
  lines.push('        var request = ctx.Request;');
  lines.push('        var response = ctx.Response;');
  lines.push('        var path = request.Url!.AbsolutePath;');
  lines.push('        if (request.HttpMethod != "POST" || !path.StartsWith(RoutePrefix)) {');
  lines.push('            RespondError(response, "method_not_allowed");');
  lines.push('            return;');
  lines.push('        }');
  lines.push('        var method = path[RoutePrefix.Length..];');
  lines.push('        string bodyText;');
  lines.push('        using (var reader = new System.IO.StreamReader(request.InputStream, Encoding.UTF8)) {');
  lines.push('            bodyText = reader.ReadToEnd();');
  lines.push('        }');
  lines.push('        JsonElement data;');
  lines.push('        try {');
  lines.push('            data = JsonSerializer.Deserialize<JsonElement>(bodyText);');
  lines.push('        } catch (Exception) {');
  lines.push('            RespondError(response, "invalid_argument");');
  lines.push('            return;');
  lines.push('        }');
  for (const methodDef of service.methods) {
    const mName = camelToPascal(methodDef.name);
    // Request decode degrades to passthrough for opaque cross-package
    // inputs; validation only applies to local struct inputs (same guard
    // as the Go generator's validator table).
    const ref = methodDef.input.kind === 'optional' ? methodDef.input.inner : methodDef.input;
    const validates = ref.kind === 'named' && isLocalStructRef(ref, input.ir);
    lines.push(`        if ("${methodDef.name}" == method) {`);
    lines.push(`            ${renderTypeRef(methodDef.input, input.render)} typedRequest;`);
    lines.push('            try {');
    lines.push(`                typedRequest = ${deserializeExpr(methodDef.input, 'data', input, 'request')};`);
    lines.push('            } catch (Exception) {');
    lines.push('                RespondError(response, "invalid_argument");');
    lines.push('                return;');
    lines.push('            }');
    if (validates && ref.kind === 'named') {
      lines.push(`            if (BridgeValidation.Validate${ref.name}(typedRequest).Count > 0) {`);
      lines.push('                RespondError(response, "invalid_argument");');
      lines.push('                return;');
      lines.push('            }');
    }
    lines.push('            try {');
    lines.push(`                var resp = this.handler.${mName}(typedRequest);`);
    lines.push(`                RespondJson(response, 200, JsonSerializer.Serialize(${serializeExpr(methodDef.output, 'resp', input)}));`);
    lines.push('            } catch (Exception) {');
    lines.push('                RespondError(response, "internal");');
    lines.push('            }');
    lines.push('            return;');
    lines.push('        }');
  }
  lines.push('        RespondError(response, "unimplemented");');
  lines.push('    }');
  lines.push('');
  lines.push('    private static void RespondJson(HttpListenerResponse response, int status, string json) {');
  lines.push('        var bytes = Encoding.UTF8.GetBytes(json);');
  lines.push('        response.ContentType = "application/json";');
  lines.push('        response.StatusCode = status;');
  lines.push('        response.ContentLength64 = bytes.Length;');
  lines.push('        response.OutputStream.Write(bytes);');
  lines.push('        response.OutputStream.Close();');
  lines.push('    }');
  lines.push('');
  lines.push('    private static void RespondError(HttpListenerResponse response, string code) {');
  lines.push('        var payload = new Dictionary<string, object> { { "code", code }, { "message", "bridge error: " + code } };');
  lines.push('        RespondJson(response, StatusFor(code), JsonSerializer.Serialize(payload));');
  lines.push('    }');
  lines.push('');
  lines.push('    /// <summary>Canonical Bridge error-code to HTTP-status mapping.</summary>');
  lines.push('    internal static int StatusFor(string code) {');
  lines.push('        return code switch {');
  for (const code of RPC_ERROR_CODES_SORTED) {
    lines.push(`            "${code}" => ${RPC_ERROR_STATUS[code]},`);
  }
  lines.push('            _ => 500,');
  lines.push('        };');
  lines.push('    }');
  lines.push('}');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Events.cs                                                           */
/* ------------------------------------------------------------------ */

/** Emits Events.cs: envelope machinery + per-event payload records. */
function csharpEventsFile(input: GeneratorInput): GeneratedFile | undefined {
  const events = sortedEvents(input.ir);
  if (events.length === 0) return undefined;

  const blocks: string[] = [];
  blocks.push('/// <summary>');
  blocks.push('/// Event payloads and the CloudEvents-style Bridge envelope.');
  blocks.push('/// Envelope wire format:');
  blocks.push('/// {"specversion": "1.0", "id": &lt;uuid&gt;, "source": &lt;string&gt;,');
  blocks.push('///  "type": "&lt;package&gt;.&lt;Event&gt;", "time": &lt;RFC3339&gt;, "data": {...}}.');
  blocks.push('/// id, source and time are ALWAYS caller-supplied: generated code');
  blocks.push('/// contains no clocks and no uuid generation (deterministic output).');
  blocks.push('/// </summary>');
  blocks.push('public static class BridgeEvents');
  blocks.push('{');
  blocks.push(`    public const string Specversion = ${JSON.stringify(ENVELOPE_SPECVERSION)};`);
  blocks.push('');
  for (const event of events) {
    blocks.push(`    public const string ${camelToPascal(event.name)}Type = ${JSON.stringify(eventTypeName(input.packageName, event.name))};`);
  }
  blocks.push('');
  blocks.push('    /// <summary>Caller-supplied envelope metadata (id, source, time).</summary>');
  blocks.push('    public sealed record BridgeEventMeta(string Id, string Source, string Time);');
  blocks.push('');
  blocks.push('    /// <summary>');
  blocks.push('    /// Validates the envelope shape (specversion "1.0", string');
  blocks.push('    /// id/source/type/time) without touching the payload.');
  blocks.push('    /// </summary>');
  blocks.push('    public static Dictionary<string, object> DecodeBridgeEventEnvelope(Dictionary<string, object> data) {');
  blocks.push('        if (!Specversion.Equals(data.TryGetValue("specversion", out var sv) ? sv?.ToString() : null, StringComparison.Ordinal)) {');
  blocks.push('            throw new ArgumentException("bridge event envelope: unsupported specversion " + data.GetValueOrDefault("specversion"));');
  blocks.push('        }');
  blocks.push('        foreach (var key in new[] { "id", "source", "type", "time" }) {');
  blocks.push('            if (data.GetValueOrDefault(key) is not string) {');
  blocks.push('                throw new ArgumentException("bridge event envelope: expected string " + key);');
  blocks.push('            }');
  blocks.push('        }');
  blocks.push('        return data;');
  blocks.push('    }');
  blocks.push('');
  blocks.push('    /// <summary>Generic event publisher; the transport builds the envelope.</summary>');
  blocks.push('    public interface IEventPublisher {');
  blocks.push('        void Publish(string type, Dictionary<string, object> payload, BridgeEventMeta meta);');
  blocks.push('    }');
  blocks.push('');
  blocks.push('    /// <summary>');
  blocks.push('    /// Hands envelopes to per-type subscribers; ideal for tests and');
  blocks.push('    /// in-process wiring. Swap for a real transport in production.');
  blocks.push('    /// </summary>');
  blocks.push('    public sealed class InMemoryEventBus : IEventPublisher {');
  blocks.push('        private readonly Dictionary<string, List<Action<Dictionary<string, object>>>> subscribers = new();');
  blocks.push('');
  blocks.push('        public void Subscribe(string type, Action<Dictionary<string, object>> handler) {');
  blocks.push('            if (!this.subscribers.TryGetValue(type, out var handlers)) {');
  blocks.push('                handlers = new List<Action<Dictionary<string, object>>>();');
  blocks.push('                this.subscribers[type] = handlers;');
  blocks.push('            }');
  blocks.push('            handlers.Add(handler);');
  blocks.push('        }');
  blocks.push('');
  blocks.push('        public void Publish(string type, Dictionary<string, object> payload, BridgeEventMeta meta) {');
  blocks.push('            var envelope = BridgeEvents.Wrap(type, payload, meta);');
  blocks.push('            if (!this.subscribers.TryGetValue(type, out var handlers)) { return; }');
  blocks.push('            foreach (var handler in handlers) { handler(envelope); }');
  blocks.push('        }');
  blocks.push('    }');
  blocks.push('');
  blocks.push('    /// <summary>Routes decoded envelopes by their type.</summary>');
  blocks.push('    public sealed class BridgeEventRouter {');
  blocks.push('        private readonly Dictionary<string, List<Action<Dictionary<string, object>>>> routes = new();');
  blocks.push('');
  blocks.push('        public void Register(string type, Action<Dictionary<string, object>> handler) {');
  blocks.push('            if (!this.routes.TryGetValue(type, out var handlers)) {');
  blocks.push('                handlers = new List<Action<Dictionary<string, object>>>();');
  blocks.push('                this.routes[type] = handlers;');
  blocks.push('            }');
  blocks.push('            handlers.Add(handler);');
  blocks.push('        }');
  blocks.push('');
  blocks.push('        public void Dispatch(Dictionary<string, object> envelope) {');
  blocks.push('            var validated = DecodeBridgeEventEnvelope(envelope);');
  blocks.push('            var type = (string)validated["type"];');
  blocks.push('            if (!this.routes.TryGetValue(type, out var handlers)) { return; }');
  blocks.push('            foreach (var handler in handlers) { handler(validated); }');
  blocks.push('        }');
  blocks.push('    }');
  blocks.push('');
  blocks.push('    /// <summary>Builds an envelope for a type and payload.</summary>');
  blocks.push('    public static Dictionary<string, object> Wrap(string type, Dictionary<string, object> payload, BridgeEventMeta meta) {');
  blocks.push('        return new Dictionary<string, object> {');
  blocks.push('            { "specversion", Specversion },');
  blocks.push('            { "id", meta.Id },');
  blocks.push('            { "source", meta.Source },');
  blocks.push('            { "type", type },');
  blocks.push('            { "time", meta.Time },');
  blocks.push('            { "data", payload },');
  blocks.push('        };');
  blocks.push('    }');

  // Per-event payload records + wrap/unwrap helpers.
  for (const event of events) {
    const payloadClass = `${event.name}Payload`;
    blocks.push('');
    blocks.push(`    /// <summary>Payload for the ${event.name} event.</summary>`);
    blocks.push(`    public sealed class ${payloadClass}`);
    blocks.push('    {');
    for (const field of event.fields) {
      const fdoc = csDoc(field.docs, field.deprecated, '        ');
      if (fdoc !== undefined) blocks.push(fdoc);
      blocks.push(`        public ${csharpFieldType(field, input)} ${cp(field)} { get; set; }`);
    }
    blocks.push('');
    blocks.push('        /// <summary>Serializes to the Bridge wire representation.</summary>');
    blocks.push('        public Dictionary<string, object> ToDict() {');
    blocks.push('            var outDict = new Dictionary<string, object>();');
    for (const field of event.fields) {
      const value = fieldIsOptionalCs(field)
        ? serializeExpr(unwrapOptionalCs(field.type), `this.${cp(field)}`, input)
        : serializeExpr(field.type, `this.${cp(field)}`, input);
      if (fieldIsOptionalCs(field)) {
        blocks.push(`            if (this.${cp(field)} is not null) { outDict[${JSON.stringify(field.name)}] = ${value}; }`);
      } else {
        blocks.push(`            outDict[${JSON.stringify(field.name)}] = ${value};`);
      }
    }
    blocks.push('            return outDict;');
    blocks.push('        }');
    blocks.push('');
    blocks.push('        /// <summary>Decodes from the Bridge wire representation.</summary>');
    blocks.push(`        public static ${payloadClass} FromDict(JsonElement root) {`);
    blocks.push(`            var payload = new ${payloadClass}();`);
    for (const [fieldIdx, field] of event.fields.entries()) {
      const ctx = `${payloadClass}.${field.name}`;
      const el = `el${fieldIdx}`;
      const inner = fieldIsOptionalCs(field) ? unwrapOptionalCs(field.type) : field.type;
      const converted = deserializeExpr(inner, el, input, ctx);
      if (fieldIsOptionalCs(field)) {
        blocks.push(`            if (root.TryGetProperty(${JSON.stringify(field.name)}, out var ${el}) && ${el}.ValueKind != JsonValueKind.Null && ${el}.ValueKind != JsonValueKind.Undefined) {`);
        blocks.push(`                payload.${cp(field)} = ${converted};`);
        blocks.push('            }');
      } else {
        blocks.push(`            if (!root.TryGetProperty(${JSON.stringify(field.name)}, out var ${el})) {`);
        blocks.push(`                throw new ArgumentException(${JSON.stringify(`Missing required field ${field.name} for ${payloadClass}`)});`);
        blocks.push('            }');
        blocks.push(`            payload.${cp(field)} = ${converted};`);
      }
    }
    blocks.push('            return payload;');
    blocks.push('        }');
    blocks.push('    }');
    blocks.push('');
    blocks.push(`    /// <summary>Wraps a ${payloadClass} into the Bridge envelope.</summary>`);
    blocks.push(`    public static Dictionary<string, object> Wrap${payloadClass}(${payloadClass} payload, BridgeEventMeta meta) {`);
    blocks.push(`        return Wrap(${camelToPascal(event.name)}Type, payload.ToDict(), meta);`);
    blocks.push('    }');
    blocks.push('');
    blocks.push(`    /// <summary>Validates an envelope and decodes the ${event.name} payload.</summary>`);
    blocks.push(`    public static ${payloadClass} Unwrap${payloadClass}(Dictionary<string, object> envelope) {`);
    blocks.push('        var validated = DecodeBridgeEventEnvelope(envelope);');
    blocks.push('        var type = (string)validated["type"];');
    blocks.push(`        if (!${camelToPascal(event.name)}Type.Equals(type, StringComparison.Ordinal)) {`);
    blocks.push(`            throw new ArgumentException("bridge event envelope: expected type ${eventTypeName(input.packageName, event.name)} but got " + type);`);
    blocks.push('        }');
    blocks.push(`        return ${payloadClass}.FromDict(JsonSerializer.Deserialize<JsonElement>(JsonSerializer.Serialize(validated["data"])));`);
    blocks.push('    }');
  }

  blocks.push('}');

  const content = [
    fileHeader('csharp', input.packageName),
    `namespace ${csharpNamespace(input.packageName)};`,
    '',
    'using System.Text.Json;',
    '',
    blocks.join('\n'),
    '',
  ].join('\n');
  return generatedFile('Events.cs', content);
}

/* ------------------------------------------------------------------ */
/* RoundTripTest.cs                                                    */
/* ------------------------------------------------------------------ */

/**
 * Emits a plain-C# RoundTripTest with a Main entry point (no test
 * framework): encode → decode → encode byte-identity checks over a
 * synthetic instance; non-zero exit on failure.
 */
function csharpRoundtripFile(input: GeneratorInput): GeneratedFile | undefined {
  const structs = sortedTypes(input.ir).filter(
    (t): t is IRTypeDefinition & { kind: 'struct' } => t.kind === 'struct',
  );
  if (structs.length === 0) return undefined;

  const lines: string[] = [];
  lines.push(fileHeader('csharp', input.packageName));
  lines.push(`namespace ${csharpNamespace(input.packageName)};`);
  lines.push('');
  lines.push('using System.Text.Json;');
  lines.push('');
  lines.push('/// <summary>');
  lines.push('/// Encode → decode → encode byte-identity checks (plain C#, no test');
  lines.push('/// framework: run with `dotnet run`).');
  lines.push('/// </summary>');
  lines.push('public static class RoundTripTest');
  lines.push('{');
  lines.push('    public static void Main() {');
  lines.push('        int checks = 0;');
  for (const structType of structs) {
    lines.push(`        checks += RoundTrip${structType.name}(Sample${structType.name}());`);
  }
  lines.push('        Console.WriteLine("RoundTripTest: " + checks + " checks passed");');
  lines.push('    }');
  lines.push('');
  for (const structType of structs) {
    lines.push(`    private static int RoundTrip${structType.name}(${structType.name} value) {`);
    lines.push('        var encoded = JsonSerializer.Serialize(value.ToDict());');
    lines.push('        var parsed = JsonSerializer.Deserialize<JsonElement>(encoded);');
    lines.push(`        var decoded = ${structType.name}.FromDict(parsed);`);
    lines.push('        if (!value.Equals(decoded)) {');
    lines.push(`            throw new Exception("${structType.name} round-trip mismatch: " + encoded);`);
    lines.push('        }');
    lines.push('        var reencoded = JsonSerializer.Serialize(decoded.ToDict());');
    lines.push('        if (encoded != reencoded) {');
    lines.push(`            throw new Exception("${structType.name} re-encode mismatch");`);
    lines.push('        }');
    lines.push('        return 2;');
    lines.push('    }');
    lines.push('');
  }
  // Sample builders for every struct (nested round-trip samples reference
  // them); the round-trip checks above run on the first two only.
  for (const structType of structs) {
    lines.push(`    private static ${structType.name} Sample${structType.name}() {`);
    lines.push(`        return new ${structType.name}`);
    lines.push('        {');
    for (const field of structType.fields) {
      lines.push(`            ${cp(field)} = ${csSampleValue(field, input, structType.name)},`);
    }
    if (lines[lines.length - 1]!.endsWith(',')) {
      lines[lines.length - 1] = lines[lines.length - 1]!.replace(/,$/, '');
    }
    lines.push('        };');
    lines.push('    }');
    lines.push('');
  }
  lines.push('}');
  lines.push('');
  return generatedFile('RoundTripTest.cs', lines.join('\n'));
}

/** Deterministic sample value for a field (C# object initializer expr). */
function csSampleValue(field: IRField, input: GeneratorInput, owner: string): string {
  if (fieldIsOptionalCs(field)) {
    // Sample: set the value for the first field, leave others null.
    return field.default !== undefined
      ? (csharpDefaultLiteral(field.default, field.type, input) ?? csharpDefaultFallback(field.type, input))
      : 'null';
  }
  const target = unwrapOptionalCs(field.type);
  switch (target.kind) {
    case 'primitive': {
      const p = target.primitive;
      if (p === 'bool') return 'true';
      if (STRING_LIKE_PRIMITIVES.has(p)) {
        // Pattern-constrained fields in the fixture need digits.
        if (owner === 'Money' && field.name === 'amount') return '"1.00"';
        if (owner === 'Address' && field.name === 'postal_code') return '"12345"';
        return JSON.stringify('sample');
      }
      if (p === 'bytes') return 'Convert.FromBase64String("c2FtcGxl")';
      if (p === 'json') return 'JsonSerializer.Deserialize<JsonElement>("{\\"k\\":1}")';
      if (p === 'float32') return '1.5f';
      if (p === 'float64') return '1.5d';
      if (p === 'uint32') return '1u';
      if (p === 'uint64') return '1UL';
      return '1';
    }
    case 'named': {
      const aliasTarget = input.render.aliasTargets?.get(target.name);
      if (aliasTarget !== undefined) {
        return csSampleValue({ ...field, type: aliasTarget }, input, owner);
      }
      const local = input.ir.types.find((t) => t.name === target.name);
      if (local !== undefined && local.kind === 'enum') {
        return `${target.name}.Parse(${JSON.stringify(local.variants[0]!.name)})`;
      }
      if (local !== undefined && local.kind === 'union') {
        // Unions have no public constructor: build the sample through the
        // first variant's factory so required union fields still decode.
        const first = local.variants[0]!;
        const payload = csSampleValue({ ...field, type: first.type, optional: false, default: undefined }, input, owner);
        return `${target.name}.${csharpSafeIdent(pascal(first.name))}(${payload})`;
      }
      if (local !== undefined && local.kind === 'struct') {
        return `Sample${target.name}()`;
      }
      return 'null!';
    }
    case 'list':
      return `new List<${renderTypeRef(target.element, input.render)}>()`;
    case 'set':
      return `new HashSet<${renderTypeRef(target.element, input.render)}>()`;
    case 'map':
      return `new Dictionary<string, ${renderTypeRef(target.value, input.render)}>()`;
    case 'optional':
      return 'null';
  }
}

