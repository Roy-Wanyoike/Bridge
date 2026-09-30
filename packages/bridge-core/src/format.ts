/**
 * Canonical source formatter for the Bridge IDL.
 *
 * `formatSource` parses the input and re-emits it in canonical style:
 * - 4-space indentation;
 * - one field / variant / method per line;
 * - `name: type @constraints` with the optional marker as a `T?` type
 *   suffix, `@deprecated` after constraints and `= default` last;
 * - `///` doc comments preserved verbatim above their declaration;
 * - exactly one blank line between top-level declarations;
 * - single trailing newline.
 *
 * Formatting is idempotent: `formatSource(formatSource(x).output)` yields
 * the identical text. Only lexically and syntactically valid input is
 * formatted; otherwise `ok === false` and the diagnostics are returned.
 * Like the compiler, the formatter never throws.
 *
 * Depth protection: type expressions are bounded by the parser (BR1005
 * "type nesting too deep" past 256 levels), so deep input fails at the parse
 * step with a proper syntax diagnostic instead of overflowing the stack
 * while rendering (previously an internal BR2999 error).
 */

import type { Diagnostic } from './ir/types';
import {
  isTypeDecl,
  type BridgeFileNode,
  type ConstraintNode,
  type EventDeclNode,
  type FieldNode,
  type MethodNode,
  type ServiceDeclNode,
  type TopLevelDeclNode,
  type TypeDeclNode,
  typeToText,
} from './ast';
import { tokenize } from './lexer';
import { parse } from './parser';
import { INTERNAL_ERROR } from './semantic';

/** Result of {@link formatSource}. */
export interface FormatResult {
  ok: boolean;
  /** Canonical source, present only when ok === true. */
  output?: string;
  diagnostics: Diagnostic[];
}

const INDENT = '    ';

/**
 * Format Bridge IDL source text into canonical style. `filePath` is only
 * used to attribute diagnostics. Never throws on any input.
 */
export function formatSource(text: string, filePath = '<input>'): FormatResult {
  try {
    const lexed = tokenize(text, filePath);
    const parsed = parse(lexed.tokens, filePath);
    const diagnostics = [...lexed.diagnostics, ...parsed.diagnostics];
    if (diagnostics.some((d) => d.severity === 'error')) {
      return { ok: false, diagnostics };
    }
    return { ok: true, output: formatFile(parsed.file), diagnostics };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      ok: false,
      diagnostics: [
        {
          severity: 'error',
          code: INTERNAL_ERROR,
          message: `Internal formatter error: ${message}`,
          file: filePath,
          line: 1,
          column: 1,
        },
      ],
    };
  }
}

// ---------------------------------------------------------------------------
// File layout
// ---------------------------------------------------------------------------

function formatFile(file: BridgeFileNode): string {
  const out: string[] = [];

  if (file.package !== undefined) {
    pushDocs(out, '', file.package.docs);
    out.push(`package ${file.package.name}`);
  }
  const hasHeader = file.package !== undefined;
  const hasBody = file.imports.length > 0 || file.decls.length > 0;
  if (hasHeader && hasBody) out.push('');

  for (const imp of file.imports) {
    // Docs written above an `import` belong to the import (the parser
    // attaches them to the node) — print them there so they are preserved
    // verbatim and never migrate to the next declaration.
    pushDocs(out, '', imp.docs);
    out.push(`import ${imp.name}`);
  }
  if (file.imports.length > 0 && file.decls.length > 0) out.push('');

  let first = true;
  for (const decl of file.decls) {
    if (!first) out.push('');
    first = false;
    formatDecl(decl, out, '');
  }

  let text = out.join('\n');
  if (text.length > 0) text += '\n';
  return text;
}

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

function formatDecl(decl: TopLevelDeclNode, out: string[], indent: string): void {
  if (isTypeDecl(decl)) formatTypeDecl(decl, out, indent);
  else if (decl.decl === 'service') formatService(decl, out, indent);
  else formatEvent(decl, out, indent);
}

function formatTypeDecl(decl: TypeDeclNode, out: string[], indent: string): void {
  pushDocs(out, indent, decl.docs);
  const dep = renderDeprecated(decl.deprecated);
  switch (decl.decl) {
    case 'struct':
      out.push(`${indent}type ${decl.name}${dep} {`);
      formatFieldBody(decl.fields, out, indent);
      out.push(`${indent}}`);
      return;
    case 'union':
      out.push(`${indent}union ${decl.name}${dep} {`);
      formatFieldBody(decl.members, out, indent);
      out.push(`${indent}}`);
      return;
    case 'enum':
      out.push(`${indent}enum ${decl.name}${dep} {`);
      for (const variant of decl.variants) {
        pushDocs(out, `${indent}${INDENT}`, variant.docs);
        out.push(`${indent}${INDENT}${variant.name}${renderDeprecated(variant.deprecated)}`);
      }
      out.push(`${indent}}`);
      return;
    case 'alias':
      out.push(`${indent}alias ${decl.name}${dep} = ${typeToText(decl.target)}`);
      return;
  }
}

function formatEvent(decl: EventDeclNode, out: string[], indent: string): void {
  pushDocs(out, indent, decl.docs);
  out.push(`${indent}event ${decl.name} {`);
  formatFieldBody(decl.fields, out, indent);
  out.push(`${indent}}`);
}

function formatService(decl: ServiceDeclNode, out: string[], indent: string): void {
  pushDocs(out, indent, decl.docs);
  out.push(`${indent}service ${decl.name} {`);
  for (const method of decl.methods) {
    formatMethod(method, out, `${indent}${INDENT}`);
  }
  out.push(`${indent}}`);
}

function formatMethod(method: MethodNode, out: string[], indent: string): void {
  pushDocs(out, indent, method.docs);
  const signature = `${method.name}(${typeToText(method.input)}) -> ${typeToText(method.output)}`;
  out.push(`${indent}${signature}${renderDeprecated(method.deprecated)}`);
}

function formatFieldBody(fields: FieldNode[], out: string[], indent: string): void {
  for (const field of fields) {
    formatField(field, out, `${indent}${INDENT}`);
  }
}

function formatField(field: FieldNode, out: string[], indent: string): void {
  pushDocs(out, indent, field.docs);
  // Canonical optional marker is the `?` type suffix. When the type node is
  // already an optional wrapper, `typeToText` renders the `?` itself.
  let typeText = typeToText(field.type);
  if (field.optional && field.type.kind !== 'optional') typeText += '?';

  let line = `${indent}${field.name}: ${typeText}`;
  for (const constraint of field.constraints) {
    line += ` ${renderConstraint(constraint)}`;
  }
  line += renderDeprecated(field.deprecated);
  if (field.defaultValue !== undefined) {
    line += ` = ${renderValue(field.defaultValue.text, field.defaultValue.isString)}`;
  }
  out.push(line);
}

// ---------------------------------------------------------------------------
// Atoms
// ---------------------------------------------------------------------------

function renderConstraint(constraint: ConstraintNode): string {
  if (constraint.args.length === 0) return `@${constraint.kindName}`;
  const args = constraint.args.map((a) => renderValue(a.text, a.isString));
  return `@${constraint.kindName}(${args.join(', ')})`;
}

/** Render a value: string literals are re-quoted and escaped; others raw. */
function renderValue(text: string, isString: boolean): string {
  return isString ? quoteString(text) : text;
}

/** Quote and escape a string literal using the IDL's supported escapes. */
function quoteString(text: string): string {
  const escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

function renderDeprecated(deprecated: string | true | undefined): string {
  if (deprecated === undefined) return '';
  if (deprecated === true) return ' @deprecated';
  return ` @deprecated(${quoteString(deprecated)})`;
}

function pushDocs(out: string[], indent: string, docs: string | undefined): void {
  if (docs === undefined) return;
  for (const rawLine of docs.split('\n')) {
    // Canonicalize CRLF input: a trailing `\r` (from pre-canonical doc text)
    // would leak mixed line endings into the output.
    const lineText = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    out.push(lineText.length > 0 ? `${indent}/// ${lineText}` : `${indent}///`);
  }
}

// ---------------------------------------------------------------------------
