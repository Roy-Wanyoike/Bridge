/**
 * Java generator.
 *
 * Emits, in order: pom.xml, BridgeJson.java, BridgeValidation.java, one
 * file per struct/enum/union type, one client + one HTTP-server file per
 * service, BridgeEvents.java, and a plain-Java RoundTripTest. Files whose
 * content would be empty (no structs -> no validation file, no services ->
 * no client) are skipped, keeping the file list deterministic.
 *
 * Java-specific decisions (documented in generated files too):
 * - Zero dependencies: generated code uses only the JDK (java.util,
 *   java.net.http, com.sun.net.httpserver, java.util.regex, Base64).
 *   JSON has no JDK runtime, so BridgeJson.java is generated into the
 *   package: a compact recursive-descent parser + a writer with explicit
 *   escaping. Object keys preserve insertion order (LinkedHashMap).
 * - Structs map to final classes: private final fields, constructor,
 *   getters, toDict()/fromDict(), validate(), equals/hashCode/toString.
 * - Wire names stay the declared snake_case names; member names are
 *   lowerCamelCase (keyword collisions get a trailing underscore).
 * - Optional fields map to java.util.Optional (boxed element types).
 * - `bytes` maps to byte[]; on the JSON wire it is a base64 string.
 * - `set<T>` maps to Set<T>; the wire format is ALWAYS a JSON array and
 *   toDict sorts elements (String natural ordering, i.e. UTF-16 code
 *   units — matching TypeScript) for deterministic wire output.
 * - Enums map to Java enums whose constant names are the declared
 *   SCREAMING_SNAKE wire names; fromWire throws IllegalArgumentException
 *   on unknown wire values.
 * - Tagged unions map to a final class with kind + value and per-variant
 *   factories/asAccessors, matching the {"kind", "value"} wire format.
 * - Type aliases have no Java declaration: the underlying type is
 *   substituted everywhere (see mappings.ts aliasTargets).
 * - Cross-package references become opaque Object passthrough fields
 *   documented as "imported from <pkg>".
 * - `timestamp` stays a String (RFC 3339 passthrough) so the wire text is
 *   byte-identical with the other targets; a structured
 *   java.time.OffsetDateTime would re-normalize the text.
 * - uint32 maps to long and uint64 to long: Java lacks unsigned types;
 *   decoding rejects negative values, and values above 2^63-1 are not
 *   representable (documented caveat, same spirit as the TS 2^53 note).
 * - Validation lives in BridgeValidation as static
 *   validate<Struct>(value) -> List<String> functions; models expose a
 *   validate() method that delegates.
 * - Services map to a synchronous <Service>Client using java.net.http
 *   (POST JSON to /<package>/<Service>/<Method>) plus a
 *   <Service>HttpServer adapter on the JDK's built-in HTTP server.
 * - Errors are {"code": str, "message": str} bodies with the canonical
 *   Bridge error-code to HTTP-status mapping (identical in every target).
 * - Events map to payload classes plus the CloudEvents-style Bridge
 *   envelope {"specversion", "id", "source", "type", "time", "data"};
 *   id/source/time are ALWAYS caller-supplied (no clocks, no uuid
 *   generation — determinism).
 */

import type {
  IRConstraint,
  IRField,
  IREvent,
  IRService,
  IRTypeDefinition,
  PrimitiveKind,
  TypeRef,
} from '@bridge/core';
import { generatedFile, joinBlocks } from '../util';
import { fileHeader } from '../header';
import { docLines, withDeprecation } from '../docs';
import { NUMERIC_PRIMITIVES, STRING_LIKE_PRIMITIVES, boxedJava, isLocalStructRef, renderTypeRef } from '../mappings';
import { crossPackageRefs, sortedEvents, sortedServices, sortedTypes } from '../analysis';
import {
  javaFieldName,
  javaPackageName,
  javaPackagePath,
  javaSafeIdent,
} from '../naming';
import type { GeneratedFile, GeneratorInput } from './input';
import { GENERATED_MARKER, HEADER_GENERATOR_VERSION } from '../header';
import { ENVELOPE_SPECVERSION, eventTypeName, RPC_ERROR_CODES_SORTED, RPC_ERROR_STATUS } from '../wire';

/** Generates the Java project for an IR package. */
export function generateJava(input: GeneratorInput): GeneratedFile[] {
  const pkgPath = javaPackagePath(input.packageName);
  const src = `src/main/java/${pkgPath}`;
  const testSrc = `src/test/java/${pkgPath}`;

  const files: GeneratedFile[] = [pomFile(input)];

  const types = sortedTypes(input.ir);
  const hasComposite = types.some((t) => t.kind === 'struct' || t.kind === 'union');
  if (hasComposite) files.push(bridgeJsonFile(input));

  const validation = bridgeValidationFile(input, src);
  if (validation !== undefined) files.push(validation);

  for (const type of types) {
    switch (type.kind) {
      case 'struct':
        files.push(structFile(input, type, src));
        break;
      case 'enum':
        files.push(enumFile(input, type, src));
        break;
      case 'union':
        files.push(unionFile(input, type, src));
        break;
      case 'alias':
        break; // substituted by the underlying type; no declaration
    }
  }

  if (input.generateServices) {
    for (const service of sortedServices(input.ir)) {
      files.push(serviceClientFile(input, service, src));
      files.push(serviceServerFile(input, service, src));
    }
  }

  const events = eventsFile(input, src);
  if (events !== undefined) files.push(events);

  const roundtrip = roundtripTestFile(input, testSrc);
  if (roundtrip !== undefined) files.push(roundtrip);

  return files;
}

/* ------------------------------------------------------------------ */
/* Doc comments                                                        */
/* ------------------------------------------------------------------ */

/** Javadoc block for a docs string (+ deprecation), at the given indent. */
function javaDoc(
  docs: string | undefined,
  deprecated: string | true | undefined,
  indent: string,
): string | undefined {
  const lines = withDeprecation(docLines(docs), deprecated);
  if (lines.length === 0) return undefined;
  // `*/` inside a doc line would terminate the Javadoc block early (issue #45).
  const safe = lines.map((line) => line.replace(/\*\//g, '*\\/'));
  const out = [`${indent}/**`];
  for (const line of safe) out.push(`${indent} * ${line}`.trimEnd());
  out.push(`${indent} */`);
  return out.join('\n');
}

/** Field-level Javadoc; falls back to a short wire-name note. */
function fieldDoc(field: IRField, indent: string): string | undefined {
  return javaDoc(field.docs, field.deprecated, indent);
}

/** The Java member name for a field (lowerCamelCase, keyword-escaped). */
function jf(field: IRField): string {
  return javaFieldName(field.name).name;
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
 * Java type for use INSIDE generics (collection element/value types and
 * casts): primitives are boxed recursively because `List<int>` and
 * `Map<String, int>` are illegal Java. Leaf shapes render through
 * {@link renderTypeRef} (which substitutes alias targets for Java) and
 * box bare primitives via {@link boxedJava}; composite shapes mirror the
 * Java renderings from mappings.ts (listType/setType/mapType/optionalType).
 */
function boxedTypeRef(ref: TypeRef, input: GeneratorInput): string {
  switch (ref.kind) {
    case 'list':
      return `List<${boxedTypeRef(ref.element, input)}>`;
    case 'set':
      return `Set<${boxedTypeRef(ref.element, input)}>`;
    case 'map':
      return `Map<String, ${boxedTypeRef(ref.value, input)}>`;
    case 'optional':
      return `Optional<${boxedTypeRef(ref.inner, input)}>`;
    default:
      return boxedJava(renderTypeRef(ref, input.render));
  }
}

/**
 * Expression that converts a Java value of the given type into its JSON
 * wire value, for leaf-like references (primitives, bytes, json, local
 * enums, local structs, opaque cross-package values). Returns undefined
 * for composites (list/set/map), which need statement blocks — use
 * {@link serializeInto} for those.
 */
function serializeLeafExpr(ref: TypeRef, value: string, input: GeneratorInput): string | undefined {
  switch (ref.kind) {
    case 'primitive':
      if (ref.primitive === 'bytes') return `Base64.getEncoder().encodeToString(${value})`;
      if (ref.primitive === 'uint64') return `Long.toUnsignedString(${value})`;
      return value;
    case 'named': {
      const aliasTarget = input.render.aliasTargets?.get(ref.name);
      if (aliasTarget !== undefined) return serializeLeafExpr(aliasTarget, value, input);
      const local = input.ir.types.find((t) => t.name === ref.name);
      if (local !== undefined && local.kind === 'enum') return `${value}.wire()`;
      if (local !== undefined && (local.kind === 'struct' || local.kind === 'union')) {
        return `${value}.toDict()`;
      }
      return value; // opaque cross-package passthrough
    }
    default:
      return undefined;
  }
}

/**
 * Emits Java statements that serialize a composite value (list/set/map)
 * into a fresh local variable, returning the lines and the variable name.
 */
function serializeBlock(
  ref: TypeRef,
  value: string,
  input: GeneratorInput,
  depth: number,
): { lines: string[]; tmp: string } {
  if (ref.kind === 'list' || ref.kind === 'set') {
    const tmp = `v${depth}`;
    const lines: string[] = [];
    let source = value;
    if (ref.kind === 'set') {
      // Deterministic wire order: sort a copy (natural ordering of the
      // element type — UTF-16 code units for strings, matching TS).
      const sorted = `s${depth}`;
      lines.push(`    List<${boxedTypeRef(ref.element, input)}> ${sorted} = new ArrayList<>(${value});`);
      lines.push(`    Collections.sort(${sorted});`);
      source = sorted;
    }
    lines.push(`    List<Object> ${tmp} = new ArrayList<>();`);
    const element = serializeLeafExpr(ref.element, 'item', input);
    lines.push(`    for (${boxedTypeRef(ref.element, input)} item : ${source}) {`);
    if (element !== undefined) {
      lines.push(`        ${tmp}.add(${element});`);
    } else {
      const inner = serializeBlock(ref.element, 'item', input, depth + 1);
      lines.push(...indent(inner.lines, 1));
      lines.push(`        ${tmp}.add(${inner.tmp});`);
    }
    lines.push('    }');
    return { lines, tmp };
  }
  if (ref.kind === 'map') {
    const tmp = `v${depth}`;
    const lines = [`    Map<String, Object> ${tmp} = new LinkedHashMap<>();`];
    const valueExpr = serializeLeafExpr(ref.value, 'e.getValue()', input);
    lines.push(`    for (Map.Entry<String, ${boxedTypeRef(ref.value, input)}> e : ${value}.entrySet()) {`);
    if (valueExpr !== undefined) {
      lines.push(`        ${tmp}.put(e.getKey(), ${valueExpr});`);
    } else {
      const inner = serializeBlock(ref.value, 'e.getValue()', input, depth + 1);
      lines.push(...indent(inner.lines, 1));
      lines.push(`        ${tmp}.put(e.getKey(), ${inner.tmp});`);
    }
    lines.push('    }');
    return { lines, tmp };
  }
  throw new Error(`java generator: serializeBlock on non-composite ${ref.kind}`);
}

/**
 * Emits Java statements that serialize `value` and put the result into
 * `outExpr` under the wire key `wireName`.
 */
function serializeInto(
  ref: TypeRef,
  value: string,
  wireName: string,
  outExpr: string,
  input: GeneratorInput,
  depth: number,
): string[] {
  const leaf = serializeLeafExpr(ref, value, input);
  if (leaf !== undefined) {
    return [`    ${outExpr}.put(${JSON.stringify(wireName)}, ${leaf});`];
  }
  const block = serializeBlock(ref, value, input, depth);
  return [...block.lines, `    ${outExpr}.put(${JSON.stringify(wireName)}, ${block.tmp});`];
}

/** Indents lines by n 4-space steps. */
function indent(lines: string[], n: number): string[] {
  const pad = '    '.repeat(n);
  return lines.map((l) => (l.length > 0 ? pad + l : l));
}

/**
 * Deserialization result: statements to run first (declaring `expr`'s
 * variable when needed), then the expression yielding the decoded value.
 */
interface Deserialized {
  readonly lines: string[];
  readonly expr: string;
}

/**
 * Deserializes `raw` (an Object-typed Java expression) into a value of
 * the given type. Composite types declare a local variable; the caller
 * must emit {@link Deserialized.lines} before the statement using
 * {@link Deserialized.expr}.
 */
function deserializeValue(
  ref: TypeRef,
  raw: string,
  input: GeneratorInput,
  ctx: string,
  depth: number,
): Deserialized {
  switch (ref.kind) {
    case 'primitive':
      return { lines: [], expr: deserializePrimitiveExpr(ref.primitive, raw, ctx) };
    case 'named': {
      const aliasTarget = input.render.aliasTargets?.get(ref.name);
      if (aliasTarget !== undefined) {
        return deserializeValue(aliasTarget, raw, input, ctx, depth);
      }
      const local = input.ir.types.find((t) => t.name === ref.name);
      if (local !== undefined && local.kind === 'enum') {
        return { lines: [], expr: `${ref.name}.fromWire(${deserializeStringExpr(raw, ctx)})` };
      }
      if (local !== undefined && (local.kind === 'struct' || local.kind === 'union')) {
        return {
          lines: [],
          expr: `${ref.name}.fromDict(BridgeJson.expectMap(${raw}, ${JSON.stringify(ctx)}))`,
        };
      }
      return { lines: [], expr: raw }; // opaque cross-package passthrough
    }
    case 'list': {
      const inner = deserializeValue(ref.element, 'item', input, `${ctx}[]`, depth + 1);
      const lines = [
        `    List<${boxedTypeRef(ref.element, input)}> l${depth} = new ArrayList<>();`,
        `    for (Object item : BridgeJson.expectList(${raw}, ${JSON.stringify(ctx)})) {`,
      ];
      lines.push(...indent(inner.lines, 1));
      lines.push(`        l${depth}.add(${inner.expr});`);
      lines.push('    }');
      return { lines, expr: `l${depth}` };
    }
    case 'set': {
      const inner = deserializeValue(ref.element, 'item', input, `${ctx}[]`, depth + 1);
      const lines = [
        `    Set<${boxedTypeRef(ref.element, input)}> s${depth} = new LinkedHashSet<>();`,
        `    for (Object item : BridgeJson.expectList(${raw}, ${JSON.stringify(ctx)})) {`,
      ];
      lines.push(...indent(inner.lines, 1));
      lines.push(`        s${depth}.add(${inner.expr});`);
      lines.push('    }');
      return { lines, expr: `s${depth}` };
    }
    case 'map': {
      const inner = deserializeValue(ref.value, 'e.getValue()', input, `${ctx}[]`, depth + 1);
      const lines = [
        `    Map<String, ${boxedTypeRef(ref.value, input)}> m${depth} = new LinkedHashMap<>();`,
        `    for (Map.Entry<String, Object> e : BridgeJson.expectMap(${raw}, ${JSON.stringify(ctx)}).entrySet()) {`,
      ];
      lines.push(...indent(inner.lines, 1));
      lines.push(`        m${depth}.put(e.getKey(), ${inner.expr});`);
      lines.push('    }');
      return { lines, expr: `m${depth}` };
    }
    case 'optional': {
      const inner = deserializeValue(ref.inner, raw, input, ctx, depth + 1);
      const lines = [...inner.lines];
      const typed = boxedTypeRef(ref, input);
      lines.push(`    ${typed} o${depth};`);
      lines.push(`    if (${raw} == null) {`);
      lines.push(`        o${depth} = Optional.empty();`);
      lines.push('    } else {');
      lines.push(`        o${depth} = Optional.of(${inner.expr});`);
      lines.push('    }');
      return { lines, expr: `o${depth}` };
    }
  }
}

/** Primitive wire→Java conversion (non-null raw). */
function deserializePrimitiveExpr(primitive: PrimitiveKind, raw: string, ctx: string): string {
  if (primitive === 'bytes') {
    return `BridgeJson.expectBytes(${raw}, ${JSON.stringify(ctx)})`;
  }
  if (primitive === 'json') {
    return raw; // arbitrary JSON value; stored as-is
  }
  if (STRING_LIKE_PRIMITIVES.has(primitive)) {
    return deserializeStringExpr(raw, ctx);
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
  if (primitive === 'uint32' || primitive === 'uint64') {
    return `BridgeJson.expectUnsigned(${raw}, ${JSON.stringify(ctx)})`;
  }
  if (primitive === 'int32') {
    return `BridgeJson.expectInt(${raw}, ${JSON.stringify(ctx)})`;
  }
  return `BridgeJson.expectLong(${raw}, ${JSON.stringify(ctx)})`;
}

/** String extraction that fails loudly on non-string raw values. */
function deserializeStringExpr(raw: string, ctx: string): string {
  return `BridgeJson.expectString(${raw}, ${JSON.stringify(ctx)})`;
}

/* ------------------------------------------------------------------ */
/* pom.xml                                                             */
/* ------------------------------------------------------------------ */

function pomFile(input: GeneratorInput): GeneratedFile {
  const artifact = input.packageName
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/[^a-z0-9]/g, '-');
  const lines = [
    `<!-- ${GENERATED_MARKER} Generator version: ${HEADER_GENERATOR_VERSION} Package: ${input.packageName} -->`,
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<project xmlns="http://maven.apache.org/POM/4.0.0"',
    '         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    '         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">',
    '  <modelVersion>4.0.0</modelVersion>',
    '  <groupId>bridge.generated</groupId>',
    `  <artifactId>${artifact}</artifactId>`,
    '  <version>0.1.0</version>',
    '  <packaging>jar</packaging>',
    `  <description>Generated Bridge contracts for ${input.packageName}.</description>`,
    '  <properties>',
    '    <maven.compiler.release>17</maven.compiler.release>',
    '    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>',
    '  </properties>',
    '</project>',
    '',
  ];
  return generatedFile('pom.xml', lines.join('\n'));
}

/* ------------------------------------------------------------------ */
/* BridgeJson.java                                                     */
/* ------------------------------------------------------------------ */

/** Emits the zero-dependency JSON runtime every composite type relies on. */
function bridgeJsonFile(input: GeneratorInput): GeneratedFile {
  const lines: string[] = [];
  lines.push(fileHeader('java', input.packageName));
  lines.push(`package ${javaPackageName(input.packageName)};`);
  lines.push('');
  lines.push('import java.util.ArrayList;');
  lines.push('import java.util.Base64;');
  lines.push('import java.util.LinkedHashMap;');
  lines.push('import java.util.List;');
  lines.push('import java.util.Map;');
  lines.push('');
  lines.push('/**');
  lines.push(' * Zero-dependency JSON runtime for the generated Bridge package.');
  lines.push(' *');
  lines.push(' * <p>parse builds insertion-ordered maps ({@link LinkedHashMap}) and');
  lines.push(' * keeps integers as Long, fractional numbers as Double. encode writes');
  lines.push(' * maps in iteration order, so struct serialization is deterministic.');
  lines.push(' *');
  lines.push(' * <p>The expect* helpers convert parsed values with precise context');
  lines.push(' * messages ("Type.field: expected string"), because contract contents');
  lines.push(' * are untrusted input.');
  lines.push(' */');
  lines.push('public final class BridgeJson {');
  lines.push('    private BridgeJson() {}');
  lines.push('');
  lines.push('    /** Thrown on malformed JSON text. */');
  lines.push('    public static final class JsonSyntaxException extends RuntimeException {');
  lines.push('        private static final long serialVersionUID = 1L;');
  lines.push('        public JsonSyntaxException(String message) { super(message); }');
  lines.push('    }');
  lines.push('');
  lines.push('    // ---------------- parse ----------------');
  lines.push('');
  lines.push('    /** Parses JSON text into Map/List/String/Long/Double/Boolean/null. */');
  lines.push('    public static Object parse(String text) {');
  lines.push('        Parser p = new Parser(text);');
  lines.push('        Object value = p.parseValue();');
  lines.push('        p.skipWhitespace();');
  lines.push('        if (!p.atEnd()) {');
  lines.push('            throw new JsonSyntaxException("trailing characters at offset " + p.pos);');
  lines.push('        }');
  lines.push('        return value;');
  lines.push('    }');
  lines.push('');
  lines.push('    private static final class Parser {');
  lines.push('        final String text;');
  lines.push('        int pos;');
  lines.push('');
  lines.push('        Parser(String text) { this.text = text; this.pos = 0; }');
  lines.push('');
  lines.push('        boolean atEnd() { return pos >= text.length(); }');
  lines.push('');
  lines.push('        void skipWhitespace() {');
  lines.push('            while (pos < text.length()) {');
  lines.push("                char c = text.charAt(pos);");
  lines.push("                if (c == ' ' || c == '\\t' || c == '\\n' || c == '\\r') { pos++; } else { break; }");
  lines.push('            }');
  lines.push('        }');
  lines.push('');
  lines.push('        char peek() {');
  lines.push('            if (atEnd()) throw new JsonSyntaxException("unexpected end of input");');
  lines.push('            return text.charAt(pos);');
  lines.push('        }');
  lines.push('');
  lines.push('        void expect(char c) {');
  lines.push('            if (atEnd() || text.charAt(pos) != c) {');
  lines.push('                throw new JsonSyntaxException("expected \'" + c + "\' at offset " + pos);');
  lines.push('            }');
  lines.push('            pos++;');
  lines.push('        }');
  lines.push('');
  lines.push('        Object parseValue() {');
  lines.push('            skipWhitespace();');
  lines.push('            char c = peek();');
  lines.push("            switch (c) {");
  lines.push("                case '{': return parseObject();");
  lines.push("                case '[': return parseArray();");
  lines.push("                case '\"': return parseString();");
  lines.push("                case 't': expectWord(\"true\"); return Boolean.TRUE;");
  lines.push("                case 'f': expectWord(\"false\"); return Boolean.FALSE;");
  lines.push("                case 'n': expectWord(\"null\"); return null;");
  lines.push('                default: return parseNumber();');
  lines.push('            }');
  lines.push('        }');
  lines.push('');
  lines.push('        void expectWord(String word) {');
  lines.push('            if (!text.startsWith(word, pos)) {');
  lines.push('                throw new JsonSyntaxException("invalid literal at offset " + pos);');
  lines.push('            }');
  lines.push('            pos += word.length();');
  lines.push('        }');
  lines.push('');
  lines.push('        Map<String, Object> parseObject() {');
  lines.push("            expect('{');");
  lines.push('            Map<String, Object> out = new LinkedHashMap<>();');
  lines.push('            skipWhitespace();');
  lines.push("            if (peek() == '}') { pos++; return out; }");
  lines.push('            while (true) {');
  lines.push('                skipWhitespace();');
  lines.push('                String key = parseString();');
  lines.push('                skipWhitespace();');
  lines.push("                expect(':');");
  lines.push('                out.put(key, parseValue());');
  lines.push('                skipWhitespace();');
  lines.push("                char c = peek();");
  lines.push("                if (c == ',') { pos++; continue; }");
  lines.push("                if (c == '}') { pos++; return out; }");
  lines.push('                throw new JsonSyntaxException("expected \',\' or \'}\' at offset " + pos);');
  lines.push('            }');
  lines.push('        }');
  lines.push('');
  lines.push('        List<Object> parseArray() {');
  lines.push("            expect('[');");
  lines.push('            List<Object> out = new ArrayList<>();');
  lines.push('            skipWhitespace();');
  lines.push("            if (peek() == ']') { pos++; return out; }");
  lines.push('            while (true) {');
  lines.push('                out.add(parseValue());');
  lines.push('                skipWhitespace();');
  lines.push("                char c = peek();");
  lines.push("                if (c == ',') { pos++; continue; }");
  lines.push("                if (c == ']') { pos++; return out; }");
  lines.push('                throw new JsonSyntaxException("expected \',\' or \']\' at offset " + pos);');
  lines.push('            }');
  lines.push('        }');
  lines.push('');
  lines.push('        String parseString() {');
  lines.push("            expect('\"');");
  lines.push('            StringBuilder sb = new StringBuilder();');
  lines.push('            while (true) {');
  lines.push('                if (atEnd()) throw new JsonSyntaxException("unterminated string");');
  lines.push('                char c = text.charAt(pos++);');
  lines.push("                if (c == '\"') { return sb.toString(); }");
  lines.push("                if (c == '\\\\') {");
  lines.push('                    if (atEnd()) throw new JsonSyntaxException("unterminated escape");');
  lines.push('                    char e = text.charAt(pos++);');
  lines.push("                    switch (e) {");
  lines.push("                        case '\"': sb.append('\"'); break;");
  lines.push("                        case '\\\\': sb.append('\\\\'); break;");
  lines.push("                        case '/': sb.append('/'); break;");
  lines.push("                        case 'b': sb.append('\\b'); break;");
  lines.push("                        case 'f': sb.append('\\f'); break;");
  lines.push("                        case 'n': sb.append('\\n'); break;");
  lines.push("                        case 'r': sb.append('\\r'); break;");
  lines.push("                        case 't': sb.append('\\t'); break;");
  lines.push("                        case 'u': sb.append(parseUnicodeEscape()); break;");
  lines.push('                        default: throw new JsonSyntaxException("invalid escape character");');
  lines.push('                    }');
  lines.push('                } else {');
  lines.push('                    sb.append(c);');
  lines.push('                }');
  lines.push('            }');
  lines.push('        }');
  lines.push('');
  lines.push('        private char parseUnicodeEscape() {');
  lines.push('            if (pos + 4 > text.length()) throw new JsonSyntaxException("invalid unicode escape");');
  lines.push('            String hex = text.substring(pos, pos + 4);');
  lines.push('            pos += 4;');
  lines.push('            try {');
  lines.push('                return (char) Integer.parseInt(hex, 16);');
  lines.push('            } catch (NumberFormatException exc) {');
  lines.push('                throw new JsonSyntaxException("invalid unicode escape \\\\u" + hex);');
  lines.push('            }');
  lines.push('        }');
  lines.push('');
  lines.push('        Object parseNumber() {');
  lines.push('            int start = pos;');
  lines.push("            if (peek() == '-') pos++;");
  lines.push('            boolean fraction = false;');
  lines.push('            while (!atEnd()) {');
  lines.push('                char c = text.charAt(pos);');
  lines.push("                if (c >= '0' && c <= '9') { pos++; }");
  lines.push("                else if (c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') { fraction = fraction || c == '.' || c == 'e' || c == 'E'; pos++; }");
  lines.push('                else { break; }');
  lines.push('            }');
  lines.push('            String num = text.substring(start, pos);');
  lines.push('            if (num.isEmpty() || num.equals("-")) {');
  lines.push('                throw new JsonSyntaxException("invalid number at offset " + start);');
  lines.push('            }');
  lines.push('            if (fraction) {');
  lines.push('                return Double.parseDouble(num);');
  lines.push('            }');
  lines.push('            try {');
  lines.push('                return Long.parseLong(num);');
  lines.push('            } catch (NumberFormatException exc) {');
  lines.push('                // Out-of-long-range integers (e.g. uint64 > 2^63-1) keep');
  lines.push('                // full precision as BigInteger, never clamping via double.');
  lines.push('                try {');
  lines.push('                    return new java.math.BigInteger(num);');
  lines.push('                } catch (NumberFormatException ignored) {');
  lines.push('                    return Double.parseDouble(num);');
  lines.push('                }');
  lines.push('            }');
  lines.push('        }');
  lines.push('    }');
  lines.push('');
  lines.push('    // ---------------- encode ----------------');
  lines.push('');
  lines.push('    /** Encodes a value tree (maps, lists, strings, numbers, booleans). */');
  lines.push('    public static String encode(Object value) {');
  lines.push('        StringBuilder sb = new StringBuilder();');
  lines.push('        write(sb, value);');
  lines.push('        return sb.toString();');
  lines.push('    }');
  lines.push('');
  lines.push('    private static void write(StringBuilder sb, Object value) {');
  lines.push('        if (value == null) {');
  lines.push("            sb.append(\"null\");");
  lines.push('        } else if (value instanceof String s) {');
  lines.push('            writeString(sb, s);');
  lines.push('        } else if (value instanceof Boolean b) {');
  lines.push('            sb.append(b.booleanValue() ? "true" : "false");');
  lines.push('        } else if (value instanceof Double d) {');
  lines.push('            if (d.isNaN() || d.isInfinite()) {');
  lines.push('                throw new IllegalArgumentException("cannot encode non-finite double");');
  lines.push('            }');
  lines.push('            sb.append(d.toString());');
  lines.push('        } else if (value instanceof Float f) {');
  lines.push('            if (f.isNaN() || f.isInfinite()) {');
  lines.push('                throw new IllegalArgumentException("cannot encode non-finite float");');
  lines.push('            }');
  lines.push('            sb.append(f.toString());');
  lines.push('        } else if (value instanceof Number n) {');
  lines.push('            sb.append(n.toString());');
  lines.push('        } else if (value instanceof Map<?, ?> m) {');
  lines.push("            sb.append('{');");
  lines.push('            boolean first = true;');
  lines.push('            for (Map.Entry<?, ?> e : m.entrySet()) {');
  lines.push('                if (!first) { sb.append(\',\'); }');
  lines.push('                first = false;');
  lines.push('                writeString(sb, String.valueOf(e.getKey()));');
  lines.push("                sb.append(':');");
  lines.push('                write(sb, e.getValue());');
  lines.push('            }');
  lines.push("            sb.append('}');");
  lines.push('        } else if (value instanceof Iterable<?> it) {');
  lines.push("            sb.append('[');");
  lines.push('            boolean first = true;');
  lines.push('            for (Object item : it) {');
  lines.push('                if (!first) { sb.append(\',\'); }');
  lines.push('                first = false;');
  lines.push('                write(sb, item);');
  lines.push('            }');
  lines.push("            sb.append(']');");
  lines.push('        } else {');
  lines.push('            throw new IllegalArgumentException(');
  lines.push('                "cannot encode type " + value.getClass().getName());');
  lines.push('        }');
  lines.push('    }');
  lines.push('');
  lines.push('    private static void writeString(StringBuilder sb, String s) {');
  lines.push("        sb.append('\"');");
  lines.push('        for (int i = 0; i < s.length(); i++) {');
  lines.push('            char c = s.charAt(i);');
  lines.push("            switch (c) {");
  lines.push("                case '\"': sb.append(\"\\\\\\\"\"); break;");
  lines.push("                case '\\\\': sb.append(\"\\\\\\\\\"); break;");
  lines.push("                case '\\b': sb.append(\"\\\\b\"); break;");
  lines.push("                case '\\f': sb.append(\"\\\\f\"); break;");
  lines.push("                case '\\n': sb.append(\"\\\\n\"); break;");
  lines.push("                case '\\r': sb.append(\"\\\\r\"); break;");
  lines.push("                case '\\t': sb.append(\"\\\\t\"); break;");
  lines.push('                default:');
  lines.push('                    if (c < 0x20) {');
  lines.push('                        sb.append(String.format("\\\\u%04x", (int) c));');
  lines.push('                    } else {');
  lines.push('                        sb.append(c);');
  lines.push('                    }');
  lines.push('            }');
  lines.push('        }');
  lines.push("        sb.append('\"');");
  lines.push('    }');
  lines.push('');
  lines.push('    // ---------------- typed extraction (untrusted input) ----------------');
  lines.push('');
  lines.push('    /** Extracts a Map value with a precise context message. */');
  lines.push('    public static Map<String, Object> expectMap(Object raw, String ctx) {');
  lines.push('        if (!(raw instanceof Map<?, ?> m)) {');
  lines.push('            throw new IllegalArgumentException(ctx + ": expected object");');
  lines.push('        }');
  lines.push('        @SuppressWarnings("unchecked")');
  lines.push('        Map<String, Object> cast = (Map<String, Object>) m;');
  lines.push('        return cast;');
  lines.push('    }');
  lines.push('');
  lines.push('    /** Extracts a List value with a precise context message. */');
  lines.push('    public static List<?> expectList(Object raw, String ctx) {');
  lines.push('        if (!(raw instanceof List<?> l)) {');
  lines.push('            throw new IllegalArgumentException(ctx + ": expected array");');
  lines.push('        }');
  lines.push('        return l;');
  lines.push('    }');
  lines.push('');
  lines.push('    /** Extracts a String value with a precise context message. */');
  lines.push('    public static String expectString(Object raw, String ctx) {');
  lines.push('        if (!(raw instanceof String s)) {');
  lines.push('            throw new IllegalArgumentException(ctx + ": expected string");');
  lines.push('        }');
  lines.push('        return s;');
  lines.push('    }');
  lines.push('');
  lines.push('    /** Extracts a Boolean value with a precise context message. */');
  lines.push('    public static Boolean expectBool(Object raw, String ctx) {');
  lines.push('        if (!(raw instanceof Boolean b)) {');
  lines.push('            throw new IllegalArgumentException(ctx + ": expected boolean");');
  lines.push('        }');
  lines.push('        return b;');
  lines.push('    }');
  lines.push('');
  lines.push('    /** Extracts an integer value; integral doubles are accepted. */');
  lines.push('    public static Long expectLong(Object raw, String ctx) {');
  lines.push('        if (raw instanceof Long l) { return l; }');
  lines.push('        if (raw instanceof java.math.BigInteger bi) {');
  lines.push('            if (bi.bitLength() <= 63) { return bi.longValue(); }');
  lines.push('            throw new IllegalArgumentException(ctx + ": integer out of 64-bit range");');
  lines.push('        }');
  lines.push('        if (raw instanceof Number n) {');
  lines.push('            double d = n.doubleValue();');
  lines.push('            if (d == Math.rint(d) && !Double.isInfinite(d)) { return (long) d; }');
  lines.push('        }');
  lines.push('        throw new IllegalArgumentException(ctx + ": expected integer");');
  lines.push('    }');
  lines.push('');
  lines.push('    /** Extracts a 32-bit integer value. */');
  lines.push('    public static Integer expectInt(Object raw, String ctx) {');
  lines.push('        Long l = expectLong(raw, ctx);');
  lines.push('        if (l < Integer.MIN_VALUE || l > Integer.MAX_VALUE) {');
  lines.push('            throw new IllegalArgumentException(ctx + ": expected 32-bit integer");');
  lines.push('        }');
  lines.push('        return l.intValue();');
  lines.push('    }');
  lines.push('');
  lines.push('    /** Extracts a 32-bit float value. */');
  lines.push('    public static Float expectFloat(Object raw, String ctx) {');
  lines.push('        Double d = expectDouble(raw, ctx);');
  lines.push('        return d.floatValue();');
  lines.push('    }');
  lines.push('');
  lines.push('    /** Extracts an unsigned integer value (rejects negatives). */');
  lines.push('    public static Long expectUnsigned(Object raw, String ctx) {');
  lines.push('        if (raw instanceof java.math.BigInteger bi) {');
  lines.push('            if (bi.signum() >= 0 && bi.bitLength() <= 64) { return bi.longValue(); }');
  lines.push('            throw new IllegalArgumentException(ctx + ": expected unsigned 64-bit integer");');
  lines.push('        }');
  lines.push('        Long l = expectLong(raw, ctx);');
  lines.push('        if (l < 0) {');
  lines.push('            throw new IllegalArgumentException(ctx + ": expected unsigned integer");');
  lines.push('        }');
  lines.push('        return l;');
  lines.push('    }');
  lines.push('');
  lines.push('    /** Extracts a floating point value with a precise context message. */');
  lines.push('    public static Double expectDouble(Object raw, String ctx) {');
  lines.push('        if (raw instanceof Number n) { return n.doubleValue(); }');
  lines.push('        throw new IllegalArgumentException(ctx + ": expected number");');
  lines.push('    }');
  lines.push('');
  lines.push('    /** Decodes a base64 wire string into bytes. */');
  lines.push('    public static byte[] expectBytes(Object raw, String ctx) {');
  lines.push('        String s = expectString(raw, ctx);');
  lines.push('        try {');
  lines.push('            return Base64.getDecoder().decode(s);');
  lines.push('        } catch (IllegalArgumentException exc) {');
  lines.push('            throw new IllegalArgumentException(ctx + ": expected base64 bytes");');
  lines.push('        }');
  lines.push('    }');
  lines.push('}');
  lines.push('');
  return generatedFile(`${'src/main/java/' + javaPackagePath(input.packageName)}/BridgeJson.java`, lines.join('\n'));
}

/* ------------------------------------------------------------------ */
/* Type files                                                          */
/* ------------------------------------------------------------------ */

/** File prologue: header + package + imports needed by a type file. */
function typeFilePrologue(
  input: GeneratorInput,
  type: IRTypeDefinition,
  srcDir: string,
  extraImports: readonly string[],
  className: string,
  docOverride?: string,
): string[] {
  const lines: string[] = [];
  lines.push(fileHeader('java', input.packageName));
  lines.push(`package ${javaPackageName(input.packageName)};`);
  lines.push('');
  for (const imp of extraImports) lines.push(`import ${imp};`);
  if (extraImports.length > 0) lines.push('');
  const doc = docOverride ?? javaDoc(type.docs, type.deprecated, '');
  if (doc !== undefined) lines.push(doc);
  lines.push(publicDeclaration(type, className));
  return lines;
}

/** The class/enum/interface declaration line (with @Deprecated when set). */
function publicDeclaration(type: IRTypeDefinition, className: string): string {
  const decl = typeKindDeclaration(type, className);
  return type.deprecated !== undefined ? `@Deprecated\n${decl}` : decl;
}

function typeKindDeclaration(type: IRTypeDefinition, className: string): string {
  switch (type.kind) {
    case 'enum':
      return `public enum ${className} {`;
    case 'union':
      return `public final class ${className} {`;
    case 'struct':
      return `public final class ${className} {`;
    case 'alias':
      return `public final class ${className} {`;
  }
}

/** Java imports for a struct based on the constructs it uses. */
function structImports(type: IRTypeDefinition & { kind: 'struct' }): string[] {
  const imports = new Set<string>(['java.util.List', 'java.util.Map', 'java.util.LinkedHashMap']);
  const usesSet = type.fields.some((f) => typeContainsCollection(f.type, 'set'));
  const usesBytes = type.fields.some((f) => typeContainsPrimitive(f.type, 'bytes'));
  const usesOptional = type.fields.some((f) => fieldIsOptional(f));
  if (usesSet) {
    imports.add('java.util.ArrayList');
    imports.add('java.util.Collections');
    imports.add('java.util.Set');
    imports.add('java.util.LinkedHashSet');
  }
  if (usesList(type)) imports.add('java.util.ArrayList');
  if (usesBytes) imports.add('java.util.Base64');
  if (usesOptional) imports.add('java.util.Optional');
  return [...imports].sort();
}

function usesList(type: IRTypeDefinition & { kind: 'struct' }): boolean {
  return type.fields.some((f) => typeContainsCollection(f.type, 'list'));
}

/** True when any field is optional (flag or explicit optional type). */
function fieldIsOptional(field: IRField): boolean {
  return field.optional || typeHasExplicitOptional(field.type);
}

/**
 * The declared Java type for a struct field: optional fields wrap the
 * (boxed) element type in java.util.Optional — Optional<primitive> is
 * illegal Java, so int/long/boolean/etc. become Optional<Integer>/…
 */
function fieldJavaType(field: IRField, input: GeneratorInput): string {
  if (fieldIsOptional(field)) {
    const inner = unwrapOptional(field.type);
    return `Optional<${boxedJava(renderTypeRef(inner, input.render))}>`;
  }
  return renderTypeRef(field.type, input.render);
}

function typeHasExplicitOptional(ref: TypeRef): boolean {
  switch (ref.kind) {
    case 'optional':
      return true;
    case 'list':
    case 'set':
      return typeHasExplicitOptional(ref.element);
    case 'map':
      return typeHasExplicitOptional(ref.value);
    default:
      return false;
  }
}

function typeContainsCollection(ref: TypeRef, kind: 'list' | 'set'): boolean {
  switch (ref.kind) {
    case kind:
      return true;
    case 'list':
    case 'set':
      return typeContainsCollection(ref.element, kind);
    case 'map':
      return typeContainsCollection(ref.value, kind);
    case 'optional':
      return typeContainsCollection(ref.inner, kind);
    default:
      return false;
  }
}

function typeContainsPrimitive(ref: TypeRef, primitive: PrimitiveKind): boolean {
  switch (ref.kind) {
    case 'primitive':
      return ref.primitive === primitive;
    case 'list':
    case 'set':
      return typeContainsPrimitive(ref.element, primitive);
    case 'map':
      return typeContainsPrimitive(ref.value, primitive);
    case 'optional':
      return typeContainsPrimitive(ref.inner, primitive);
    default:
      return false;
  }
}

/** Renders one struct as a final class file. */
function structFile(
  input: GeneratorInput,
  type: IRTypeDefinition & { kind: 'struct' },
  srcDir: string,
): GeneratedFile {
  const className = type.name;
  const lines = typeFilePrologue(input, type, srcDir, structImports(type), className);
  lines.push(...structClassBody(input, type, 0));
  lines.push('}');
  lines.push('');
  return generatedFile(`${srcDir}/${className}.java`, lines.join('\n'));
}

/**
 * The class body (fields, constructor, getters, validate, toDict,
 * fromDict, equals/hashCode/toString) for a struct-like type, at the
 * given indentation level (0 for top-level type files, 1 for nested
 * event payload classes). Does NOT include the declaration line or the
 * closing brace.
 */
function structClassBody(
  input: GeneratorInput,
  type: IRTypeDefinition & { kind: 'struct' },
  baseIndent: number,
): string[] {
  const className = type.name;
  const body: string[] = [];
  const push = (line: string): void => {
    body.push(line);
  };

  // Fields
  for (const field of type.fields) {
    const doc = fieldDoc(field, '    ');
    if (doc !== undefined) body.push(...doc.split('\n'));
    if (field.default !== undefined && !field.optional) {
      push(`    // Default: ${field.default}`);
    }
    push(`    private final ${fieldJavaType(field, input)} ${jf(field)};`);
  }
  push('');
  push(`    ${className}(`);
  for (const field of type.fields) {
    push(`            ${fieldJavaType(field, input)} ${jf(field)},`);
  }
  if (body[body.length - 1]!.endsWith(',')) {
    body[body.length - 1] = body[body.length - 1]!.replace(/,$/, '');
  }
  push('    ) {');
  for (const field of type.fields) {
    push(`        this.${jf(field)} = ${jf(field)};`);
  }
  push('    }');
  push('');

  // Getters
  for (const field of type.fields) {
    const getter = `get${pascal(field.name)}`;
    push(`    public ${fieldJavaType(field, input)} ${getter}() {`);
    push(`        return this.${jf(field)};`);
    push('    }');
    push('');
  }

  // validate
  push('    /**');
  push('     * Validates constraints; returns violation messages (empty means valid).');
  push('     */');
  push('    public java.util.List<String> validate() {');
  push(`        return BridgeValidation.validate${className}(this);`);
  push('    }');
  push('');

  // toDict
  push('    /**');
  push('     * Serializes to the Bridge wire representation.');
  push('     */');
  push('    public Map<String, Object> toDict() {');
  push('        Map<String, Object> out = new LinkedHashMap<>();');
  for (const [fieldIdx, field] of type.fields.entries()) {
    const depth = fieldIdx;
    if (field.optional) {
      push(`        if (this.${jf(field)}.isPresent()) {`);
      body.push(...indent(serializeInto(unwrapOptional(field.type), `this.${jf(field)}.get()`, field.name, 'out', input, depth), 1));
      push('        }');
    } else if (field.type.kind === 'optional') {
      // Explicit optional type on a required field: encode empty as null.
      push(`        if (this.${jf(field)}.isPresent()) {`);
      body.push(...indent(serializeInto(field.type.inner, `this.${jf(field)}.get()`, field.name, 'out', input, depth), 1));
      push('        } else {');
      push(`            out.put(${JSON.stringify(field.name)}, null);`);
      push('        }');
    } else {
      body.push(...indent(serializeInto(field.type, `this.${jf(field)}`, field.name, 'out', input, depth), 1));
    }
  }
  push('        return out;');
  push('    }');
  push('');

  // fromDict
  push('    /**');
  push('     * Decodes from the Bridge wire representation; throws');
  push('     * IllegalArgumentException on missing required fields or bad types.');
  push('     */');
  push('    public static ' + className + ' fromDict(Map<String, Object> data) {');
  for (const [fieldIdx, field] of type.fields.entries()) {
    const ctx = `${className}.${field.name}`;
    const depth = fieldIdx;
    const hasFallback = field.optional || field.default !== undefined;
    push(`        Object raw${pascal(field.name)} = data.get(${JSON.stringify(field.name)});`);
    if (!hasFallback) {
      push(`        if (raw${pascal(field.name)} == null) {`);
      push(
        `            throw new IllegalArgumentException(${JSON.stringify(
          `Missing required field ${field.name} for ${className}`,
        )});`,
      );
      push('        }');
    }
    if (field.optional) {
      // Optional<T> field: decode inner value when present
      const innerRef = unwrapOptional(field.type);
      const inner = deserializeValue(innerRef, `raw${pascal(field.name)}`, input, ctx, depth);
      push(`        ${fieldJavaType(field, input)} ${jf(field)};`);
      push(`        if (raw${pascal(field.name)} == null) {`);
      push(`            ${jf(field)} = Optional.empty();`);
      push('        } else {');
      body.push(...indent(inner.lines, 2));
      push(`            ${jf(field)} = Optional.of(${inner.expr});`);
      push('        }');
    } else if (field.default !== undefined) {
      const fallback = javaDefaultLiteral(field.default, field.type, input);
      const innerRef = unwrapOptional(field.type);
      const inner = deserializeValue(innerRef, `raw${pascal(field.name)}`, input, ctx, depth);
      push(`        ${fieldJavaType(field, input)} ${jf(field)};`);
      push(`        if (raw${pascal(field.name)} == null) {`);
      push(`            ${jf(field)} = ${fallback ?? defaultFallbackExpr(field.type, input)};`);
      push('        } else {');
      body.push(...indent(inner.lines, 2));
      push(`            ${jf(field)} = ${inner.expr};`);
      push('        }');
    } else {
      const inner = deserializeValue(field.type, `raw${pascal(field.name)}`, input, ctx, depth);
      body.push(...indent(inner.lines, 1));
      push(`        ${fieldJavaType(field, input)} ${jf(field)} = ${inner.expr};`);
    }
  }
  push(`        return new ${className}(`);
  for (const field of type.fields) {
    push(`            ${jf(field)},`);
  }
  if (body[body.length - 1]!.endsWith(',')) {
    body[body.length - 1] = body[body.length - 1]!.replace(/,$/, '');
  }
  push('        );');
  push('    }');
  push('');

  // equals/hashCode/toString
  push('    @Override');
  push('    public boolean equals(Object o) {');
  push('        if (this == o) { return true; }');
  push(`        if (!(o instanceof ${className} other)) { return false; }`);
  if (type.fields.length > 0) {
    const comparisons = type.fields.map((f) => `java.util.Objects.equals(this.${jf(f)}, other.${jf(f)})`);
    push(`        return ${comparisons[0]}`);
    for (let i = 1; i < comparisons.length; i++) {
      push(`            && ${comparisons[i]}`);
    }
    body[body.length - 1] = body[body.length - 1] + ';';
  } else {
    push('        return true;');
  }
  push('    }');
  push('');
  push('    @Override');
  push('    public int hashCode() {');
  if (type.fields.length > 0) {
    const fields = type.fields.map((f) => `this.${jf(f)}`).join(', ');
    push(`        return java.util.Objects.hash(${fields});`);
  } else {
    push('        return 0;');
  }
  push('    }');
  push('');
  push('    @Override');
  push('    public String toString() {');
  push('        return BridgeJson.encode(this.toDict());');
  push('    }');
  if (baseIndent === 0) return body;
  return indent(body, baseIndent);
}

/** Removes the Optional wrapper from a field's TypeRef when present. */
function unwrapOptional(ref: TypeRef): TypeRef {
  return ref.kind === 'optional' ? ref.inner : ref;
}

/** Java literal for an IDL default value, or undefined when unsupported. */
function javaDefaultLiteral(
  defaultValue: string,
  ref: TypeRef,
  input: GeneratorInput,
): string | undefined {
  const target = unwrapOptional(ref);
  const literal = defaultLiteralJava(defaultValue, target);
  if (literal !== undefined) return literal;
  return undefined;
}

function defaultLiteralJava(defaultValue: string, ref: TypeRef): string | undefined {
  const raw = defaultValue.trim();
  if (raw.length === 0) return undefined;
  let inner = raw;
  if (
    (inner.startsWith('"') && inner.endsWith('"') && inner.length >= 2) ||
    (inner.startsWith("'") && inner.endsWith("'") && inner.length >= 2)
  ) {
    inner = inner.slice(1, -1);
  }
  if (ref.kind !== 'primitive') return undefined;
  const p = ref.primitive;
  if (p === 'bool') {
    if (inner === 'true') return 'true';
    if (inner === 'false') return 'false';
    return undefined;
  }
  if (NUMERIC_PRIMITIVES.has(p)) {
    if (!/^[+-]?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(inner)) return undefined;
    if (p === 'float32') return `${inner}f`;
    if (p === 'float64') return `${inner}d`;
    if (p === 'int32') return inner;
    return `${inner}L`;
  }
  if (STRING_LIKE_PRIMITIVES.has(p)) {
    return JSON.stringify(inner);
  }
  return undefined;
}

/** Fallback when a default literal cannot be rendered (empty value). */
function defaultFallbackExpr(ref: TypeRef, input: GeneratorInput): string {
  const target = unwrapOptional(ref);
  if (target.kind === 'primitive') {
    if (STRING_LIKE_PRIMITIVES.has(target.primitive)) return '""';
    if (target.primitive === 'bool') return 'false';
    if (target.primitive === 'bytes') return 'new byte[0]';
    return '0L';
  }
  if (target.kind === 'named') {
    return `${target.name}.fromDict(new java.util.LinkedHashMap<>())`;
  }
  if (target.kind === 'list') {
    return `new java.util.ArrayList<>()`;
  }
  if (target.kind === 'set') {
    return `new java.util.LinkedHashSet<>()`;
  }
  if (target.kind === 'map') {
    return `new java.util.LinkedHashMap<>()`;
  }
  void input;
  return 'null';
}

/* ------------------------------------------------------------------ */
/* enum files                                                          */
/* ------------------------------------------------------------------ */

/** Renders one enum as a Java enum file. */
function enumFile(
  input: GeneratorInput,
  type: IRTypeDefinition & { kind: 'enum' },
  srcDir: string,
): GeneratedFile {
  const lines = typeFilePrologue(input, type, srcDir, [], type.name);
  for (const [i, variant] of type.variants.entries()) {
    const vdoc = javaDoc(variant.docs, variant.deprecated, '    ');
    if (vdoc !== undefined) lines.push(vdoc);
    lines.push(`    ${variant.name}${i < type.variants.length - 1 ? ',' : ';'}`);
  }
  lines.push('');
  lines.push('    /**');
  lines.push('     * The Bridge wire value for this variant (the declared name).');
  lines.push('     */');
  lines.push('    public String wire() {');
  lines.push('        return name();');
  lines.push('    }');
  lines.push('');
  lines.push('    /**');
  lines.push(`     * Parses a wire value into ${type.name}; throws`);
  lines.push('     * IllegalArgumentException on unknown values.');
  lines.push('     */');
  lines.push(`    public static ${type.name} fromWire(String value) {`);
  lines.push(`        for (${type.name} variant : values()) {`);
  lines.push('            if (variant.name().equals(value)) { return variant; }');
  lines.push('        }');
  const allowed = type.variants.map((v) => v.name).join(', ');
  lines.push(
    `        throw new IllegalArgumentException("Unknown ${type.name} value: " + value + ". Allowed: ${allowed}");`,
  );
  lines.push('    }');
  lines.push('');
  lines.push('    @Override');
  lines.push('    public String toString() {');
  lines.push('        return name();');
  lines.push('    }');
  lines.push('}');
  lines.push('');
  return generatedFile(`${srcDir}/${type.name}.java`, lines.join('\n'));
}

/* ------------------------------------------------------------------ */
/* union files                                                         */
/* ------------------------------------------------------------------ */

/** Renders one tagged union as a kind/value final class file. */
function unionFile(
  input: GeneratorInput,
  type: IRTypeDefinition & { kind: 'union' },
  srcDir: string,
): GeneratedFile {
  const className = type.name;
  const doc = javaDoc(
    type.docs !== undefined
      ? `${type.docs}\nWire format: {"kind": "<variant>", "value": <payload>}.`
      : 'Tagged union. Wire format: {"kind": "<variant>", "value": <payload>}.',
    type.deprecated,
    '',
  );
  const lines = typeFilePrologue(input, type, srcDir, ['java.util.Map', 'java.util.LinkedHashMap'], className, doc);

  lines.push('    private final String kind;');
  lines.push('    private final Object value;');
  lines.push('');
  lines.push(`    private ${className}(String kind, Object value) {`);
  lines.push('        this.kind = kind;');
  lines.push('        this.value = value;');
  lines.push('    }');
  lines.push('');
  lines.push('    public String getKind() { return this.kind; }');
  lines.push('    public Object getValue() { return this.value; }');
  lines.push('');

  // Per-variant factories and typed accessors. Variant types render with
  // boxed generics (a list<int32> payload must be List<Integer>, and
  // casting Object to List<int> is illegal Java).
  for (const variant of type.variants) {
    const variantType = boxedTypeRef(variant.type, input);
    const factory = javaSafeIdent(variant.name.toLowerCase());
    const vdoc = javaDoc(variant.docs, variant.deprecated, '    ');
    if (vdoc !== undefined) lines.push(vdoc);
    lines.push(`    public static ${className} ${factory}(${variantType} value) {`);
    lines.push(`        return new ${className}(${JSON.stringify(variant.name)}, value);`);
    lines.push('    }');
    lines.push('');
    const accessor = `as${pascal(variant.name)}`;
    lines.push(`    public java.util.Optional<${variantType}> ${accessor}() {`);
    lines.push(`        if (this.kind.equals(${JSON.stringify(variant.name)})) {`);
    lines.push(`            return java.util.Optional.of((${variantType}) this.value);`);
    lines.push('        }');
    lines.push('        return java.util.Optional.empty();');
    lines.push('    }');
    lines.push('');
  }

  // toDict
  lines.push('    /**');
  lines.push('     * Serializes to the Bridge wire representation.');
  lines.push('     */');
  lines.push('    public Map<String, Object> toDict() {');
  lines.push('        Map<String, Object> out = new LinkedHashMap<>();');
  lines.push('        out.put("kind", this.kind);');
  lines.push('        Object v = this.value;');
  for (const variant of type.variants) {
    const castType = boxedTypeRef(variant.type, input);
    lines.push(`        if (this.kind.equals(${JSON.stringify(variant.name)})) {`);
    lines.push(...indent(serializeInto(variant.type, `((${castType}) v)`, 'value', 'out', input, 0), 2));
    lines.push('            return out;');
    lines.push('        }');
  }
  lines.push('        out.put("value", v);');
  lines.push('        return out;');
  lines.push('    }');
  lines.push('');

  // fromDict
  lines.push('    /**');
  lines.push('     * Decodes from the Bridge wire representation; throws');
  lines.push('     * IllegalArgumentException on unknown kinds or bad payloads.');
  lines.push('     */');
  lines.push(`    public static ${className} fromDict(Map<String, Object> data) {`);
  lines.push(`        String kind = BridgeJson.expectString(data.get("kind"), ${JSON.stringify(`${className}.kind`)});`);
  lines.push('        Object raw = data.get("value");');
  for (const variant of type.variants) {
    const ctx = `${className}.value`;
    const inner = deserializeValue(variant.type, 'raw', input, ctx, 0);
    lines.push(`        if (kind.equals(${JSON.stringify(variant.name)})) {`);
    lines.push(...indent(inner.lines, 1));
    lines.push(`            return ${className}.${javaSafeIdent(variant.name.toLowerCase())}(${inner.expr});`);
    lines.push('        }');
  }
  lines.push(`        throw new IllegalArgumentException("Unknown ${className} kind: " + kind);`);
  lines.push('    }');
  lines.push('');

  // equals/hashCode/toString
  lines.push('    @Override');
  lines.push('    public boolean equals(Object o) {');
  lines.push('        if (this == o) { return true; }');
  lines.push(`        if (!(o instanceof ${className} other)) { return false; }`);
  lines.push('        return this.kind.equals(other.kind) && java.util.Objects.equals(this.value, other.value);');
  lines.push('    }');
  lines.push('');
  lines.push('    @Override');
  lines.push('    public int hashCode() {');
  lines.push('        return java.util.Objects.hash(this.kind, this.value);');
  lines.push('    }');
  lines.push('');
  lines.push('    @Override');
  lines.push('    public String toString() {');
  lines.push('        return BridgeJson.encode(this.toDict());');
  lines.push('    }');
  lines.push('}');
  lines.push('');
  return generatedFile(`${srcDir}/${className}.java`, lines.join('\n'));
}

/* ------------------------------------------------------------------ */
/* BridgeValidation.java                                               */
/* ------------------------------------------------------------------ */

/**
 * Renders one constraint as Java if/append lines. Returns undefined for
 * constraints the generated Java does not check (none currently).
 */
function javaConstraintCheck(
  constraint: IRConstraint,
  field: IRField,
  input: GeneratorInput,
  className: string,
  depth: number,
): string[] | undefined {
  const label = `${className}.${field.name}`;
  const message = constraint.message ?? `${label}: ${constraint.kind} constraint violated`;
  const fail = `errors.add(${JSON.stringify(message)});`;
  const arg = constraint.args[0];
  const pad = '    '.repeat(depth);
  const accessor = constraintAccessor(field, className, input);
  switch (constraint.kind) {
    case 'min':
      if (arg === undefined) return undefined;
      return [`${pad}if (${accessor} < ${numericLiteral(arg)}) {`, `${pad}    ${fail}`, `${pad}}`];
    case 'max':
      if (arg === undefined) return undefined;
      return [`${pad}if (${accessor} > ${numericLiteral(arg)}) {`, `${pad}    ${fail}`, `${pad}}`];
    case 'length':
      if (arg === undefined) return undefined;
      return [
        `${pad}if (${accessor}.length() != ${arg}) {`,
        `${pad}    ${fail}`,
        `${pad}}`,
      ];
    case 'email':
      return [`${pad}if (!EMAIL_PATTERN.matcher(${accessor}).matches()) {`, `${pad}    ${fail}`, `${pad}}`];
    case 'url':
      return [`${pad}if (!URL_PATTERN.matcher(${accessor}).matches()) {`, `${pad}    ${fail}`, `${pad}}`];
    case 'uuid':
      return [`${pad}if (!UUID_PATTERN.matcher(${accessor}).matches()) {`, `${pad}    ${fail}`, `${pad}}`];
    case 'pattern': {
      if (arg === undefined) return undefined;
      const constant = `P_${pascal(className)}_${pascal(field.name)}`;
      return [`${pad}if (!${constant}.matcher(${accessor}).matches()) {`, `${pad}    ${fail}`, `${pad}}`];
    }
    default:
      return undefined;
  }
}

/** Java literal for a numeric constraint argument. */
function numericLiteral(arg: string): string {
  return /^[+-]?[0-9]+$/.test(arg.trim()) ? `${arg.trim()}L` : arg.trim();
}

/**
 * The String expression for a field's validated value. Constraints apply
 * to strings and numerics; Optional fields are checked after an
 * isPresent() guard, so this unwraps with .get().
 */
function constraintAccessor(field: IRField, _className: string, _input: GeneratorInput): string {
  const base = `value.get${pascal(field.name)}()`;
  return fieldIsOptional(field) ? `${base}.get()` : base;
}

/** True when the field renders as a Java primitive (cannot be null). */
function javaFieldIsPrimitive(field: IRField, input: GeneratorInput): boolean {
  if (fieldIsOptional(field)) return false;
  if (field.type.kind !== 'primitive') return false;
  const p = field.type.primitive;
  return !STRING_LIKE_PRIMITIVES.has(p) && p !== 'bytes' && p !== 'json';
}

/** Emits BridgeValidation.java with per-struct validate functions. */
function bridgeValidationFile(input: GeneratorInput, srcDir: string): GeneratedFile | undefined {
  const structs = sortedTypes(input.ir).filter(
    (t): t is IRTypeDefinition & { kind: 'struct' } => t.kind === 'struct',
  );
  // Event payloads validate through the same static-function pattern.
  const payloadStructs: (IRTypeDefinition & { kind: 'struct' })[] = input.generateEvents
    ? sortedEvents(input.ir).map((event) => ({
        name: eventPayloadClass(event),
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
  lines.push(fileHeader('java', input.packageName));
  lines.push(`package ${javaPackageName(input.packageName)};`);
  lines.push('');
  lines.push('import java.util.ArrayList;');
  lines.push('import java.util.List;');
  if (needsRegex) {
    lines.push('import java.util.regex.Pattern;');
  }
  lines.push('');
  lines.push('/**');
  lines.push(' * Validation for the generated Bridge package.');
  lines.push(' *');
  lines.push(' * <p>Each validate function returns a list of violation messages');
  lines.push(' * (empty means valid). Required-field presence is enforced by the');
  lines.push(' * fromDict decoders; these functions check constraints and recurse');
  lines.push(' * into struct-typed fields.');
  lines.push(' */');
  lines.push('public final class BridgeValidation {');
  lines.push('    private BridgeValidation() {}');
  lines.push('');
  if (needsRegex) {
    lines.push('    private static final Pattern EMAIL_PATTERN = Pattern.compile("[^@\\\\s]+@[^@\\\\s]+\\\\.[^@\\\\s]+");');
    lines.push('    private static final Pattern URL_PATTERN = Pattern.compile("https?://\\\\S+");');
    lines.push(
      '    private static final Pattern UUID_PATTERN = Pattern.compile("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$");',
    );
    for (const structType of allStructs) {
      for (const field of structType.fields) {
        for (const constraint of field.constraints) {
          if (constraint.kind === 'pattern' && constraint.args[0] !== undefined) {
            const constant = `P_${pascal(structType.name)}_${pascal(field.name)}`;
            lines.push(`    private static final Pattern ${constant} = Pattern.compile(${JSON.stringify(constraint.args[0])});`);
          }
        }
      }
    }
    lines.push('');
  }

  for (const structType of allStructs) {
    lines.push('    /**');
    lines.push(`     * Validates a ${structType.name} instance; returns violation messages.`);
    lines.push('     */');
    const paramType = payloadNames.has(structType.name) ? `BridgeEvents.${structType.name}` : structType.name;
    lines.push(`    public static List<String> validate${structType.name}(${paramType} value) {`);
    lines.push('        List<String> errors = new ArrayList<>();');
    for (const field of structType.fields) {
      const checkLines: string[] = [];
      for (const constraint of field.constraints) {
        const rendered = javaConstraintCheck(constraint, field, input, structType.name, 1);
        if (rendered !== undefined) checkLines.push(...rendered);
      }
      // Nested validation for struct-typed fields.
      const nested = javaNestedValidation(field, input);
      checkLines.push(...nested);
      if (checkLines.length === 0) continue;
      const accessor = `value.get${pascal(field.name)}()`;
      if (fieldIsOptional(field)) {
        lines.push(`        if (${accessor}.isPresent()) {`);
        lines.push(...checkLines);
        lines.push('        }');
      } else if (javaFieldIsPrimitive(structType.fields.find((f) => f.name === field.name)!, input)) {
        lines.push(...checkLines);
      } else {
        lines.push(`        if (${accessor} == null) {`);
        lines.push(`            errors.add(${JSON.stringify(`${structType.name}.${field.name}: required field is null`)});`);
        lines.push('        } else {');
        lines.push(...checkLines);
        lines.push('        }');
      }
    }
    lines.push('        return errors;');
    lines.push('    }');
    lines.push('');
  }

  lines.push('}');
  lines.push('');
  return generatedFile(`${srcDir}/BridgeValidation.java`, lines.join('\n'));
}

/** Nested validation lines for struct-typed fields (with index prefixes). */
function javaNestedValidation(field: IRField, input: GeneratorInput): string[] {
  let inner = field.type;
  if (inner.kind === 'optional') inner = inner.inner;
  if (!isLocalStructRef(inner, input.ir)) return [];
  const target = (inner as { name: string }).name;
  const accessor = constraintAccessor(field, '', input);
  if (inner.kind === 'list') {
    // List of structs: validate each element with an index prefix.
    const elemTarget = (inner.element as { name: string }).name;
    return [
      `            for (int i = 0; i < ${accessor}.size(); i++) {`,
      `                for (String m : BridgeValidation.validate${elemTarget}(${accessor}.get(i))) {`,
      `                    errors.add(${JSON.stringify(elemTarget)} + "[" + i + "]: " + m);`,
      '                }',
      '            }',
    ];
  }
  return [`            errors.addAll(BridgeValidation.validate${target}(${accessor}));`];
}

/* ------------------------------------------------------------------ */
/* service files                                                       */
/* ------------------------------------------------------------------ */

/** Renders the synchronous <Service>Client for one service. */
function serviceClientFile(
  input: GeneratorInput,
  service: IRService,
  srcDir: string,
): GeneratedFile {
  const className = `${service.name}Client`;
  const lines: string[] = [];
  lines.push(fileHeader('java', input.packageName));
  lines.push(`package ${javaPackageName(input.packageName)};`);
  lines.push('');
  // Base64 is needed when a method serializes a top-level bytes value
  // (or an alias resolving to bytes) directly; struct payloads import it
  // in their own files.
  const needsBase64 = service.methods.some((m) => methodUsesBytes(m.input, input));
  const imports = [
    'java.net.URI',
    'java.net.http.HttpClient',
    'java.net.http.HttpRequest',
    'java.net.http.HttpResponse',
    'java.nio.charset.StandardCharsets',
    'java.time.Duration',
    'java.util.Map',
    ...(needsBase64 ? ['java.util.Base64'] : []),
  ].sort();
  for (const imp of imports) lines.push(`import ${imp};`);
  lines.push('');
  const doc = javaDoc(
    service.docs !== undefined
      ? `${service.docs}\nRoutes: POST /${input.packageName}/${service.name}/<Method>.`
      : `Client for the ${service.name} service.\nRoutes: POST /${input.packageName}/${service.name}/<Method>.`,
    undefined,
    '',
  );
  if (doc !== undefined) lines.push(doc);
  lines.push(`public final class ${className} {`);
  lines.push('    private final HttpClient http;');
  lines.push('    private final String baseUrl;');
  lines.push('    private final Duration timeout;');
  lines.push('');
  lines.push(`    public ${className}(String baseUrl) {`);
  lines.push('        this(baseUrl, Duration.ofSeconds(30));');
  lines.push('    }');
  lines.push('');
  lines.push(`    public ${className}(String baseUrl, Duration timeout) {`);
  lines.push('        this.baseUrl = baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl;');
  lines.push('        this.timeout = timeout;');
  lines.push('        this.http = HttpClient.newBuilder().connectTimeout(timeout).build();');
  lines.push('    }');
  lines.push('');

  for (const method of service.methods) {
    // Signatures render through the type table so cross-package (opaque)
    // and alias-substituted method types stay compilable; serialization
    // degrades to passthrough for those (same guard as the Go generator).
    const inputType = renderTypeRef(method.input, input.render);
    const outputType = renderTypeRef(method.output, input.render);
    const mName = camelToLowerSnakeJava(method.name);
    const mdoc = javaDoc(method.docs, method.deprecated, '    ');
    if (mdoc !== undefined) lines.push(mdoc);
    lines.push(`    public ${outputType} ${mName}(${inputType} request) {`);
    lines.push(`        String url = this.baseUrl + "/${input.packageName}/${service.name}/${method.name}";`);
    const wire = javaWireValue(method.input, 'request', input, 0);
    lines.push(...indent(wire.lines, 1));
    lines.push(`        byte[] body = BridgeJson.encode(${wire.expr}).getBytes(StandardCharsets.UTF_8);`);
    lines.push('        HttpRequest httpRequest = HttpRequest.newBuilder(URI.create(url))');
    lines.push('                .timeout(this.timeout)');
    lines.push('                .header("Content-Type", "application/json")');
    lines.push('                .POST(HttpRequest.BodyPublishers.ofByteArray(body))');
    lines.push('                .build();');
    lines.push('        HttpResponse<byte[]> response;');
    lines.push('        try {');
    lines.push('            response = this.http.send(httpRequest, HttpResponse.BodyHandlers.ofByteArray());');
    lines.push('        } catch (java.io.IOException exc) {');
    lines.push('            throw new BridgeServiceError(-1, "transport error: " + exc.getMessage());');
    lines.push('        } catch (InterruptedException exc) {');
    lines.push('            Thread.currentThread().interrupt();');
    lines.push('            throw new BridgeServiceError(-1, "interrupted");');
    lines.push('        }');
    lines.push('        if (response.statusCode() != 200) {');
    lines.push('            throw new BridgeServiceError(response.statusCode(), new String(response.body(), StandardCharsets.UTF_8));');
    lines.push('        }');
    lines.push('        String text = new String(response.body(), StandardCharsets.UTF_8);');
    lines.push('        Object parsed = BridgeJson.parse(text);');
    const decoded = deserializeValue(method.output, 'parsed', input, 'response', 0);
    lines.push(...indent(decoded.lines, 2));
    lines.push(`        return ${decoded.expr};`);
    lines.push('    }');
    lines.push('');
  }
  lines.push('    /**');
  lines.push('     * Raised when a service call fails at the transport or HTTP level.');
  lines.push('     */');
  lines.push('    public static final class BridgeServiceError extends RuntimeException {');
  lines.push('        private static final long serialVersionUID = 1L;');
  lines.push('        private final int status;');
  lines.push('        private final String body;');
  lines.push('');
  lines.push('        public BridgeServiceError(int status, String body) {');
  lines.push('            super("bridge service error " + status + ": " + body);');
  lines.push('            this.status = status;');
  lines.push('            this.body = body;');
  lines.push('        }');
  lines.push('');
  lines.push('        public int getStatus() { return this.status; }');
  lines.push('        public String getBody() { return this.body; }');
  lines.push('    }');
  lines.push('}');
  lines.push('');
  return generatedFile(`${srcDir}/${className}.java`, lines.join('\n'));
}

/** Renders the <Service>HttpServer adapter for one service. */
function serviceServerFile(
  input: GeneratorInput,
  service: IRService,
  srcDir: string,
): GeneratedFile {
  const className = `${service.name}HttpServer`;
  const handler = `${service.name}Handler`;
  const lines: string[] = [];
  lines.push(fileHeader('java', input.packageName));
  lines.push(`package ${javaPackageName(input.packageName)};`);
  lines.push('');
  lines.push('import com.sun.net.httpserver.HttpExchange;');
  lines.push('import com.sun.net.httpserver.HttpServer;');
  lines.push('import java.io.IOException;');
  lines.push('import java.io.OutputStream;');
  lines.push('import java.net.InetSocketAddress;');
  lines.push('import java.nio.charset.StandardCharsets;');
  lines.push('import java.util.LinkedHashMap;');
  lines.push('import java.util.Map;');
  lines.push('');
  lines.push('/**');
  lines.push(` * Server adapter for the ${service.name} service.`);
  lines.push(' *');
  lines.push(' * <p>Routes POST /<package>/<Service>/<Method> to a handler');
  lines.push(' * implementation. Request validators run before the handler; errors');
  lines.push(' * are {"code": str, "message": str} bodies with the canonical Bridge');
  lines.push(' * error-code to HTTP-status mapping (identical in every target).');
  lines.push(' */');
  lines.push(`public final class ${className} {`);
  lines.push(`    private final ${handler} handler;`);
  lines.push('');
  lines.push(`    public ${className}(${handler} handler) {`);
  lines.push('        this.handler = handler;');
  lines.push('    }');
  lines.push('');
  lines.push('    /**');
  lines.push(`     * Handler interface for the ${service.name} service.`);
  lines.push('     */');
  lines.push(`    public interface ${handler} {`);
  for (const method of service.methods) {
    // Signatures render through the type table so cross-package (opaque)
    // and alias-substituted method types stay compilable.
    const inputType = renderTypeRef(method.input, input.render);
    const outputType = renderTypeRef(method.output, input.render);
    lines.push(`        ${outputType} ${camelToLowerSnakeJava(method.name)}(${inputType} request);`);
  }
  lines.push('    }');
  lines.push('');
  lines.push('    /** Starts an HTTP server bound to the given port. */');
  lines.push('    public HttpServer start(int port) throws IOException {');
  lines.push('        HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);');
  lines.push(`        server.createContext("/${input.packageName}/${service.name}", this::route);`);
  lines.push('        server.start();');
  lines.push('        return server;');
  lines.push('    }');
  lines.push('');
  lines.push('    private void route(HttpExchange exchange) throws IOException {');
  lines.push(`        String prefix = "/${input.packageName}/${service.name}/";`);
  lines.push('        String path = exchange.getRequestURI().getPath();');
  lines.push('        if (!"POST".equals(exchange.getRequestMethod()) || !path.startsWith(prefix)) {');
  lines.push('            respondError(exchange, "method_not_allowed");');
  lines.push('            return;');
  lines.push('        }');
  lines.push('        String method = path.substring(prefix.length());');
  lines.push('        // DoS guard: cap the decoded body size before buffering it (issue #45).');
  lines.push('        byte[] body = readBodyCapped(exchange);');
  lines.push('        if (body == null) {');
  lines.push('            respondError(exchange, "payload_too_large");');
  lines.push('            return;');
  lines.push('        }');
  lines.push('        Object parsed;');
  lines.push('        try {');
  lines.push('            parsed = BridgeJson.parse(new String(body, StandardCharsets.UTF_8));');
  lines.push('        } catch (RuntimeException exc) {');
  lines.push('            respondError(exchange, "invalid_argument");');
  lines.push('            return;');
  lines.push('        }');
  for (const methodDef of service.methods) {
    const mName = camelToLowerSnakeJava(methodDef.name);
    // Request decode degrades to passthrough for opaque cross-package
    // inputs; validation only applies to local struct inputs (same guard
    // as the Go generator's validator table).
    const ref = methodDef.input.kind === 'optional' ? methodDef.input.inner : methodDef.input;
    const validates = ref.kind === 'named' && isLocalStructRef(ref, input.ir);
    lines.push(`        if ("${methodDef.name}".equals(method)) {`);
    lines.push(`            ${renderTypeRef(methodDef.input, input.render)} request;`);
    lines.push('            try {');
    const decoded = deserializeValue(methodDef.input, 'parsed', input, 'request', 0);
    lines.push(...indent(decoded.lines, 2));
    lines.push(`                request = ${decoded.expr};`);
    lines.push('            } catch (RuntimeException exc) {');
    lines.push('                respondError(exchange, "invalid_argument");');
    lines.push('                return;');
    lines.push('            }');
    if (validates && ref.kind === 'named') {
      lines.push(`            for (String violation : BridgeValidation.validate${ref.name}(request)) {`);
      lines.push('                respondError(exchange, "invalid_argument");');
      lines.push('                return;');
      lines.push('            }');
    }
    lines.push('            try {');
    const wire = javaWireValue(methodDef.output, 'response', input, 0);
    lines.push(...indent(wire.lines, 3));
    lines.push(`                ${renderTypeRef(methodDef.output, input.render)} response = this.handler.${mName}(request);`);
    lines.push(`                respondJson(exchange, 200, BridgeJson.encode(${wire.expr}));`);
    lines.push('            } catch (RuntimeException exc) {');
    lines.push('                respondError(exchange, "internal");');
    lines.push('            }');
    lines.push('            return;');
    lines.push('        }');
  }
  lines.push('        respondError(exchange, "unimplemented");');
  lines.push('    }');
  lines.push('');
  lines.push('    private static void respondJson(HttpExchange exchange, int status, String json) throws IOException {');
  lines.push('        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);');
  lines.push('        exchange.getResponseHeaders().set("Content-Type", "application/json");');
  lines.push('        exchange.sendResponseHeaders(status, bytes.length);');
  lines.push('        try (OutputStream out = exchange.getResponseBody()) {');
  lines.push('            out.write(bytes);');
  lines.push('        }');
  lines.push('    }');
  lines.push('');
  lines.push('    private static void respondError(HttpExchange exchange, String code) throws IOException {');
  lines.push('        Map<String, Object> payload = new LinkedHashMap<>();');
  lines.push('        payload.put("code", code);');
  lines.push('        payload.put("message", "bridge error: " + code);');
  lines.push('        respondJson(exchange, statusFor(code), BridgeJson.encode(payload));');
  lines.push('    }');
  lines.push('');
  lines.push('    /** DoS guard: maximum request body size decoded by generated servers. */');
  lines.push('    static final int MAX_BODY_BYTES = 1 << 20;');
  lines.push('');
  lines.push('    /** Reads the request body, or returns null when it exceeds {@link #MAX_BODY_BYTES}. */');
  lines.push('    private static byte[] readBodyCapped(HttpExchange exchange) throws IOException {');
  lines.push('        java.io.InputStream in = exchange.getRequestBody();');
  lines.push('        byte[] buffer = in.readNBytes(MAX_BODY_BYTES + 1);');
  lines.push('        if (buffer.length > MAX_BODY_BYTES) {');
  lines.push('            return null;');
  lines.push('        }');
  lines.push('        return buffer;');
  lines.push('    }');
  lines.push('');
  lines.push('    /** Canonical Bridge error-code to HTTP-status mapping. */');
  lines.push('    static int statusFor(String code) {');
  lines.push('        switch (code) {');
  for (const code of RPC_ERROR_CODES_SORTED) {
    lines.push(`            case "${code}":`);
    lines.push(`                return ${RPC_ERROR_STATUS[code]};`);
  }
  lines.push('            default:');
  lines.push('                return 500;');
  lines.push('        }');
  lines.push('    }');
  lines.push('}');
  lines.push('');
  return generatedFile(`${srcDir}/${className}.java`, lines.join('\n'));
}

/** lowerCamelCase method name for Java (service methods are CamelCase). */
function camelToLowerSnakeJava(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

/**
 * Serializes a top-level service request/response value into its JSON
 * wire object: leaf shapes (primitives, bytes, json, enums, structs,
 * unions, opaque passthrough) via serializeLeafExpr, composites via
 * serializeBlock statements.
 */
function javaWireValue(
  ref: TypeRef,
  value: string,
  input: GeneratorInput,
  depth: number,
): { lines: string[]; expr: string } {
  const leaf = serializeLeafExpr(ref, value, input);
  if (leaf !== undefined) return { lines: [], expr: leaf };
  const block = serializeBlock(ref, value, input, depth);
  return { lines: block.lines, expr: block.tmp };
}

/** True when a top-level method value needs a Base64 import to serialize. */
function methodUsesBytes(ref: TypeRef, input: GeneratorInput): boolean {
  if (ref.kind === 'named') {
    const aliasTarget = input.render.aliasTargets?.get(ref.name);
    if (aliasTarget !== undefined) return methodUsesBytes(aliasTarget, input);
    return false; // structs/enums import (or need) Base64 in their own files
  }
  return typeContainsPrimitive(ref, 'bytes');
}

/* ------------------------------------------------------------------ */
/* events file                                                         */
/* ------------------------------------------------------------------ */

/** Event payload class name for an event. */
function eventPayloadClass(event: IREvent): string {
  return `${event.name}Payload`;
}

/** Emits BridgeEvents.java: envelope machinery + per-event payload types. */
function eventsFile(input: GeneratorInput, srcDir: string): GeneratedFile | undefined {
  if (!input.generateEvents) return undefined;
  const events = sortedEvents(input.ir);
  if (events.length === 0) return undefined;

  const lines: string[] = [];
  lines.push(fileHeader('java', input.packageName));
  lines.push(`package ${javaPackageName(input.packageName)};`);
  lines.push('');
  const imports = new Set<string>([
    'java.util.ArrayList',
    'java.util.Base64',
    'java.util.Collections',
    'java.util.LinkedHashMap',
    'java.util.LinkedHashSet',
    'java.util.List',
    'java.util.Map',
    'java.util.Objects',
    'java.util.Optional',
    'java.util.Set',
    'java.util.function.Consumer',
  ]);
  for (const imp of [...imports].sort()) lines.push(`import ${imp};`);
  lines.push('');
  lines.push('/**');
  lines.push(' * Event payloads and the CloudEvents-style Bridge envelope.');
  lines.push(' *');
  lines.push(' * <p>Envelope wire format:');
  lines.push(' * <pre>{"specversion": "1.0", "id": &lt;uuid&gt;, "source": &lt;string&gt;,');
  lines.push(' *  "type": "&lt;package&gt;.&lt;Event&gt;", "time": &lt;RFC3339&gt;, "data": {...}}</pre>');
  lines.push(' *');
  lines.push(' * <p>id, source and time are ALWAYS caller-supplied: generated code');
  lines.push(' * contains no clocks and no uuid generation (deterministic output).');
  lines.push(' */');
  lines.push('public final class BridgeEvents {');
  lines.push('    private BridgeEvents() {}');
  lines.push('');
  lines.push(`    public static final String BRIDGE_EVENT_SPECVERSION = ${JSON.stringify(ENVELOPE_SPECVERSION)};`);
  lines.push('');

  // Per-event type constants.
  for (const event of events) {
    const constant = camelToScreamingSnakeConst(event.name);
    lines.push(
      `    public static final String ${constant}_TYPE = ${JSON.stringify(eventTypeName(input.packageName, event.name))};`,
    );
  }
  lines.push('');

  // Envelope meta + validation + publisher + bus + router.
  lines.push('    /**');
  lines.push('     * Caller-supplied envelope metadata (id, source, time).');
  lines.push('     */');
  lines.push('    public static final class BridgeEventMeta {');
  lines.push('        private final String id;');
  lines.push('        private final String source;');
  lines.push('        private final String time;');
  lines.push('');
  lines.push('        public BridgeEventMeta(String id, String source, String time) {');
  lines.push('            this.id = id;');
  lines.push('            this.source = source;');
  lines.push('            this.time = time;');
  lines.push('        }');
  lines.push('');
  lines.push('        public String getId() { return this.id; }');
  lines.push('        public String getSource() { return this.source; }');
  lines.push('        public String getTime() { return this.time; }');
  lines.push('    }');
  lines.push('');
  lines.push('    /**');
  lines.push('     * Validates the envelope shape (specversion "1.0", string id/source/');
  lines.push('     * type/time) without touching the payload; returns it unchanged.');
  lines.push('     */');
  lines.push('    public static Map<String, Object> decodeBridgeEventEnvelope(Map<String, Object> data) {');
  lines.push('        if (!BRIDGE_EVENT_SPECVERSION.equals(data.get("specversion"))) {');
  lines.push('            throw new IllegalArgumentException("bridge event envelope: unsupported specversion " + data.get("specversion"));');
  lines.push('        }');
  lines.push('        for (String key : new String[] {"id", "source", "type", "time"}) {');
  lines.push('            if (!(data.get(key) instanceof String)) {');
  lines.push('                throw new IllegalArgumentException("bridge event envelope: expected string " + key);');
  lines.push('            }');
  lines.push('        }');
  lines.push('        return data;');
  lines.push('    }');
  lines.push('');
  lines.push('    /**');
  lines.push('     * Generic event publisher; the transport builds the envelope.');
  lines.push('     */');
  lines.push('    public interface EventPublisher {');
  lines.push('        void publish(String type, Map<String, Object> payload, BridgeEventMeta meta);');
  lines.push('    }');
  lines.push('');
  lines.push('    /**');
  lines.push('     * Hands envelopes to per-type subscribers; ideal for tests and');
  lines.push('     * in-process wiring. Swap for a real transport in production.');
  lines.push('     */');
  lines.push('    public static final class InMemoryEventBus implements EventPublisher {');
  lines.push('        private final Map<String, List<Consumer<Map<String, Object>>>> subscribers = new LinkedHashMap<>();');
  lines.push('');
  lines.push('        public void subscribe(String type, Consumer<Map<String, Object>> handler) {');
  lines.push('            this.subscribers.computeIfAbsent(type, k -> new ArrayList<>()).add(handler);');
  lines.push('        }');
  lines.push('');
  lines.push('        @Override');
  lines.push('        public void publish(String type, Map<String, Object> payload, BridgeEventMeta meta) {');
  lines.push('            Map<String, Object> envelope = BridgeEvents.wrap(type, payload, meta);');
  lines.push('            List<Consumer<Map<String, Object>>> handlers = this.subscribers.get(type);');
  lines.push('            if (handlers == null) { return; }');
  lines.push('            for (Consumer<Map<String, Object>> handler : handlers) {');
  lines.push('                handler.accept(envelope);');
  lines.push('            }');
  lines.push('        }');
  lines.push('    }');
  lines.push('');
  lines.push('    /**');
  lines.push('     * Routes decoded envelopes by their type.');
  lines.push('     */');
  lines.push('    public static final class BridgeEventRouter {');
  lines.push('        private final Map<String, List<Consumer<Map<String, Object>>>> routes = new LinkedHashMap<>();');
  lines.push('');
  lines.push('        public void register(String type, Consumer<Map<String, Object>> handler) {');
  lines.push('            this.routes.computeIfAbsent(type, k -> new ArrayList<>()).add(handler);');
  lines.push('        }');
  lines.push('');
  lines.push('        public void dispatch(Map<String, Object> envelope) {');
  lines.push('            Map<String, Object> validated = decodeBridgeEventEnvelope(envelope);');
  lines.push('            String type = BridgeJson.expectString(validated.get("type"), "envelope.type");');
  lines.push('            List<Consumer<Map<String, Object>>> handlers = this.routes.get(type);');
  lines.push('            if (handlers == null) { return; }');
  lines.push('            for (Consumer<Map<String, Object>> handler : handlers) {');
  lines.push('                handler.accept(validated);');
  lines.push('            }');
  lines.push('        }');
  lines.push('    }');
  lines.push('');
  lines.push('    /**');
  lines.push('     * Builds an envelope for a type and payload.');
  lines.push('     */');
  lines.push('    public static Map<String, Object> wrap(String type, Map<String, Object> payload, BridgeEventMeta meta) {');
  lines.push('        Map<String, Object> out = new LinkedHashMap<>();');
  lines.push('        out.put("specversion", BRIDGE_EVENT_SPECVERSION);');
  lines.push('        out.put("id", meta.getId());');
  lines.push('        out.put("source", meta.getSource());');
  lines.push('        out.put("type", type);');
  lines.push('        out.put("time", meta.getTime());');
  lines.push('        out.put("data", payload);');
  lines.push('        return out;');
  lines.push('    }');
  lines.push('');

  // Per-event payload classes + wrap/unwrap helpers.
  for (const event of events) {
    const payloadClass = eventPayloadClass(event);
    const payloadType: IRTypeDefinition & { kind: 'struct' } = {
      name: payloadClass,
      kind: 'struct',
      docs: event.docs,
      fields: event.fields,
    };
    const constant = camelToScreamingSnakeConst(event.name);
    lines.push('    /**');
    lines.push(`     * Payload for the ${event.name} event.`);
    lines.push('     */');
    lines.push(`    public static final class ${payloadClass} {`);
    lines.push(...structClassBody(input, payloadType, 1));
    lines.push('    }');
    lines.push('');
    lines.push('    /**');
    lines.push(`     * Wraps a ${payloadClass} into the Bridge envelope.`);
    lines.push('     */');
    lines.push(
      `    public static Map<String, Object> wrap${payloadClass}(${payloadClass} payload, BridgeEventMeta meta) {`,
    );
    lines.push(`        return BridgeEvents.wrap(${constant}_TYPE, payload.toDict(), meta);`);
    lines.push('    }');
    lines.push('');
    lines.push('    /**');
    lines.push(`     * Validates an envelope and decodes the ${event.name} payload.`);
    lines.push('     */');
    lines.push(
      `    public static ${payloadClass} unwrap${payloadClass}(Map<String, Object> envelope) {`,
    );
    lines.push('        Map<String, Object> validated = decodeBridgeEventEnvelope(envelope);');
    lines.push('        String type = BridgeJson.expectString(validated.get("type"), "envelope.type");');
    lines.push(`        if (!${constant}_TYPE.equals(type)) {`);
    lines.push(`            throw new IllegalArgumentException("bridge event envelope: expected type ${eventTypeName(input.packageName, event.name)} but got " + type);`);
    lines.push('        }');
    lines.push(`        return ${payloadClass}.fromDict(BridgeJson.expectMap(validated.get("data"), "envelope.data"));`);
    lines.push('    }');
    lines.push('');
  }

  lines.push('}');
  lines.push('');
  return generatedFile(`${srcDir}/BridgeEvents.java`, lines.join('\n'));
}

/** SCREAMING_SNAKE constant name for a CamelCase event name. */
function camelToScreamingSnakeConst(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toUpperCase();
}

/* ------------------------------------------------------------------ */
/* round-trip test                                                     */
/* ------------------------------------------------------------------ */

/**
 * Emits a plain-Java RoundTripTest: no JUnit dependency — a main() that
 * runs encode → decode → encode byte-identity checks over a synthetic
 * instance and exits non-zero on failure.
 */
function roundtripTestFile(input: GeneratorInput, testSrc: string): GeneratedFile | undefined {
  const structs = sortedTypes(input.ir).filter(
    (t): t is IRTypeDefinition & { kind: 'struct' } => t.kind === 'struct',
  );
  if (structs.length === 0) return undefined;

  const lines: string[] = [];
  lines.push(fileHeader('java', input.packageName));
  lines.push(`package ${javaPackageName(input.packageName)};`);
  lines.push('');
  lines.push('import java.util.Map;');
  lines.push('import java.util.Optional;');
  lines.push('');
  lines.push('/**');
  lines.push(' * Encode → decode → encode byte-identity checks (plain Java, no');
  lines.push(' * test framework: run with `java ' + javaPackageName(input.packageName) + '.RoundTripTest`).');
  lines.push(' */');
  lines.push('public final class RoundTripTest {');
  lines.push('    private RoundTripTest() {}');
  lines.push('');
  lines.push('    public static void main(String[] args) {');
  lines.push('        int checks = 0;');
  for (const structType of structs) {
    lines.push(`        checks += roundTrip${structType.name}(sample${structType.name}());`);
  }
  lines.push('        System.out.println("RoundTripTest: " + checks + " checks passed");');
  lines.push('    }');
  lines.push('');
  for (const structType of structs) {
    lines.push(`    private static int roundTrip${structType.name}(${structType.name} value) {`);
    lines.push(`        String encoded = BridgeJson.encode(value.toDict());`);
    lines.push(`        Map<String, Object> parsed = BridgeJson.expectMap(BridgeJson.parse(encoded), "roundtrip");`);
    lines.push(`        ${structType.name} decoded = ${structType.name}.fromDict(parsed);`);
    lines.push(`        if (!value.equals(decoded)) {`);
    lines.push(`            throw new AssertionError("${structType.name} round-trip mismatch: " + encoded);`);
    lines.push('        }');
    lines.push('        String reencoded = BridgeJson.encode(decoded.toDict());');
    lines.push('        if (!encoded.equals(reencoded)) {');
    lines.push('            throw new AssertionError("' + structType.name + ' re-encode mismatch");');
    lines.push('        }');
    lines.push('        return 2;');
    lines.push('    }');
    lines.push('');
    lines.push(`    private static ${structType.name} sample${structType.name}() {`);
    lines.push(...javaSampleStruct(input, structType, 2));
    lines.push('    }');
    lines.push('');
  }
  lines.push('}');
  lines.push('');
  return generatedFile(`${testSrc}/RoundTripTest.java`, lines.join('\n'));
}

/**
 * Builds a synthetic sample instance for a struct: zero-ish scalars,
 * empty containers, and null-free values (deterministic, no clocks).
 */
function javaSampleStruct(
  input: GeneratorInput,
  type: IRTypeDefinition & { kind: 'struct' },
  depth: number,
): string[] {
  const lines: string[] = [];
  const args: string[] = [];
  for (const [fieldIdx, field] of type.fields.entries()) {
    const expr = javaSampleValue(field, input, depth + fieldIdx);
    lines.push(...expr.lines);
    args.push(expr.expr);
  }
  lines.push(`        return new ${type.name}(`);
  for (const arg of args) {
    lines.push(`            ${arg},`);
  }
  if (lines[lines.length - 1]!.endsWith(',')) {
    lines[lines.length - 1] = lines[lines.length - 1]!.replace(/,$/, '');
  }
  lines.push('        );');
  return lines;
}

/** Sample value result: statements + expression. */
function javaSampleValue(
  field: IRField,
  input: GeneratorInput,
  depth: number,
): { lines: string[]; expr: string } {
  if (field.optional) {
    const varName = `opt${depth}`;
    const lines = [`${'    '.repeat(2)}${fieldJavaType(field, input)} ${varName} = Optional.empty();`];
    return { lines, expr: varName };
  }
  return javaSampleValueFor(field.type, input, depth);
}

function javaSampleValueFor(ref: TypeRef, input: GeneratorInput, depth: number): { lines: string[]; expr: string } {
  switch (ref.kind) {
    case 'primitive': {
      const p = ref.primitive;
      if (p === 'bool') return { lines: [], expr: 'true' };
      if (STRING_LIKE_PRIMITIVES.has(p)) return { lines: [], expr: '"sample"' };
      if (p === 'bytes') return { lines: [], expr: '"c2FtcGxl".getBytes()' };
      // Java source must read BridgeJson.parse("{\"k\":1}") — the backslashes
      // are part of the emitted string literal, so they need \\ in this
      // single-quoted TS literal.
      if (p === 'json') return { lines: [], expr: 'BridgeJson.parse("{\\"k\\":1}")' };
      if (p === 'float32') return { lines: [], expr: '1.5f' };
      if (p === 'float64') return { lines: [], expr: '1.5d' };
      if (p === 'int32') return { lines: [], expr: '1' };
      return { lines: [], expr: '1L' };
    }
    case 'named': {
      const aliasTarget = input.render.aliasTargets?.get(ref.name);
      if (aliasTarget !== undefined) {
        return javaSampleValueFor(aliasTarget, input, depth);
      }
      const local = input.ir.types.find((t) => t.name === ref.name);
      if (local !== undefined && local.kind === 'enum') {
        return { lines: [], expr: `${ref.name}.fromWire(${JSON.stringify(local.variants[0]!.name)})` };
      }
      if (local !== undefined && local.kind === 'union') {
        // Unions have no public constructor: build the sample through the
        // first variant's factory so required union fields still decode.
        const unionType = local as IRTypeDefinition & { kind: 'union' };
        const first = unionType.variants[0]!;
        const payload = javaSampleValueFor(first.type, input, depth + 1);
        return {
          lines: payload.lines,
          expr: `${ref.name}.${javaSafeIdent(first.name.toLowerCase())}(${payload.expr})`,
        };
      }
      if (local !== undefined && local.kind === 'struct') {
        const structType = local as IRTypeDefinition & { kind: 'struct' };
        const varName = `s${depth}`;
        const lines = [`${'    '.repeat(2)}${ref.name} ${varName} = ${ref.name}.fromDict(BridgeJson.expectMap(BridgeJson.parse(${JSON.stringify(sampleJsonFor(input, structType))}), "sample"));`];
        return { lines, expr: varName };
      }
      return { lines: [], expr: 'null' };
    }
    case 'list': {
      return { lines: [], expr: `new java.util.ArrayList<>()` };
    }
    case 'set': {
      return { lines: [], expr: `new java.util.LinkedHashSet<>()` };
    }
    case 'map': {
      return { lines: [], expr: `new java.util.LinkedHashMap<>()` };
    }
    case 'optional': {
      return { lines: [], expr: 'Optional.empty()' };
    }
  }
}

/**
 * Builds a minimal valid JSON wire object for a struct (used to decode a
 * deterministic sample without needing nested constructor calls).
 */
function sampleJsonFor(input: GeneratorInput, type: IRTypeDefinition & { kind: 'struct' }): string {
  const obj: Record<string, unknown> = {};
  for (const field of type.fields) {
    if (field.optional) continue;
    obj[field.name] = sampleJsonForRef(field.type, input);
  }
  return JSON.stringify(obj);
}

function sampleJsonForRef(ref: TypeRef, input: GeneratorInput): unknown {
  switch (ref.kind) {
    case 'primitive': {
      const p = ref.primitive;
      if (p === 'bool') return true;
      if (STRING_LIKE_PRIMITIVES.has(p)) return 'sample';
      if (p === 'bytes') return 'c2FtcGxl';
      if (p === 'json') return { k: 1 };
      if (p === 'float32' || p === 'float64') return 1.5;
      return 1;
    }
    case 'named': {
      const aliasTarget = input.render.aliasTargets?.get(ref.name);
      if (aliasTarget !== undefined) return sampleJsonForRef(aliasTarget, input);
      const local = input.ir.types.find((t) => t.name === ref.name);
      if (local !== undefined && local.kind === 'enum') return local.variants[0]!.name;
      if (local !== undefined && local.kind === 'union') {
        // Required union fields sample their first variant on the wire:
        // {"kind": "<first>", "value": <first-variant sample>}.
        const first = local.variants[0]!;
        return { kind: first.name, value: sampleJsonForRef(first.type, input) };
      }
      if (local !== undefined && local.kind === 'struct') {
        const structType = local as IRTypeDefinition & { kind: 'struct' };
        const obj: Record<string, unknown> = {};
        for (const field of structType.fields) {
          if (field.optional) continue;
          obj[field.name] = sampleJsonForRef(field.type, input);
        }
        return obj;
      }
      return null;
    }
    case 'list':
      return [];
    case 'set':
      return [];
    case 'map':
      return {};
    case 'optional':
      return null;
  }
}


