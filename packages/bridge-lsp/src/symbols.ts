/**
 * The symbol index: the Bridge AST turned into navigable, position-addressed
 * symbols — the machinery behind `textDocument/definition`, `references`,
 * `documentSymbol` and `rename`.
 *
 * bridge-core's AST (not the canonical IR) is the right source here: the IR
 * strips every source position (`compiler/compile.ts`), while AST nodes all
 * carry the 1-based UTF-16 line/column of the token that starts them
 * (`ast.ts`). Positions convert with the exact `-1` mapping proven in
 * positions.ts.
 *
 * Fidelity notes (what the AST does and does not record):
 * - Declaration nodes (struct/enum/union/alias/service/event) record the
 *   position of their KEYWORD token, not of the declared name. The name
 *   range is recovered by scanning the text forward from the keyword for the
 *   first whole-word occurrence of `decl.name` — the name always directly
 *   follows the keyword (modulo whitespace/comments), so the first match is
 *   the declaration itself, and the word-boundary check prevents a prefix
 *   hit inside the keyword (`type s {` does not match inside `type`).
 * - Member nodes (fields, enum variants, methods) and `NamedTypeNode`s DO
 *   record their name token start, so those ranges are exact. For qualified
 *   references (`pkg.Name`) the recorded position is the FIRST segment; the
 *   name-segment range is computed arithmetically and verified against the
 *   line text, degrading to an unmatchable zero-width range when the
 *   verification fails (pathological whitespace like `a . b`).
 *
 * Everything here is parse-based, so navigation keeps working on documents
 * with semantic errors (unknown types, duplicates, …) — exactly the state a
 * user is in while editing. Parse failures cannot throw into the server:
 * `tokenize`/`parse` recover from any input, and `buildSymbolIndex` still
 * guards with an empty-index fallback.
 */

import {
  isTypeDecl,
  parse,
  tokenize,
  typeToText,
  type BridgeFileNode,
  type FieldNode,
  type MethodNode,
  type TopLevelDeclNode,
  type TypeNode,
  type VariantNode,
} from '@bridge/core';
import { SymbolKind, type DocumentSymbol, type Position, type Range } from './protocol';
import { lineTextAt, toLspPosition } from './positions';

/** Kinds of top-level declarations (AST `decl` discriminant). */
export type TopDeclKind = 'struct' | 'enum' | 'union' | 'alias' | 'service' | 'event';

/** A top-level declaration with its navigable ranges. */
export interface DeclSymbol {
  name: string;
  kind: TopDeclKind;
  /** Range of the declared NAME (the `selectionRange` of an outline symbol). */
  nameRange: Range;
  /** Range enclosing the whole declaration (keyword → last body line). */
  fullRange: Range;
  node: TopLevelDeclNode;
}

/** One type reference as written (`Money`, `list<Money>` → `Money`, …). */
export interface TypeRefSymbol {
  /** The final (type-name) segment. */
  name: string;
  /** Dotted package prefix when the reference was qualified. */
  package?: string;
  /** Range of the NAME segment only — the range a user selects. */
  nameRange: Range;
  /** Range of the whole dotted reference (== nameRange when unqualified). */
  fullRange: Range;
}

/** A field / enum variant / service method with its exact name range. */
export interface MemberSymbol {
  name: string;
  kind: 'field' | 'variant' | 'method';
  /** Name of the enclosing top-level declaration. */
  parent: string;
  nameRange: Range;
  node: FieldNode | VariantNode | MethodNode;
}

export interface SymbolIndex {
  /** The file's own dotted package name (`''` when the package header is missing). */
  packageName: string;
  decls: DeclSymbol[];
  members: MemberSymbol[];
  typeRefs: TypeRefSymbol[];
}

const EMPTY_INDEX: SymbolIndex = { packageName: '', decls: [], members: [], typeRefs: [] };

/** Character class shared with bridge-core's lexer: ASCII identifiers only. */
function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}

// ---------------------------------------------------------------- offsets

/** Start offset of every line (0-based line index → character offset). */
function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charAt(i) === '\n') starts.push(i + 1);
  }
  return starts;
}

function positionAtOffset(text: string, starts: number[], offset: number): Position {
  // Binary search for the last line that starts at or before `offset`.
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi + 1) / 2);
    if ((starts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  const line = lo;
  const start = starts[line] ?? 0;
  return { line, character: Math.min(offset - start, lineTextAt(text, line)?.length ?? 0) };
}

/** Offset of a 1-based bridge-core position. */
function offsetOf(starts: number[], line: number, column: number): number {
  const base = starts[line - 1] ?? 0;
  return base + (column - 1);
}

// ------------------------------------------------------------ name ranges

/**
 * Scan forward from `fromOffset` for the first WHOLE-WORD occurrence of
 * `name` and return its range. Identifiers are ASCII, so the UTF-16 string
 * length is the width. Falls back to a zero-width range at `fromOffset`
 * when the name is empty or absent (parse-error artifacts).
 */
function scannedNameRange(text: string, starts: number[], fromOffset: number, name: string): Range {
  if (name !== '') {
    for (let i = Math.max(0, fromOffset); i + name.length <= text.length; i++) {
      if (!text.startsWith(name, i)) continue;
      const before = text.charAt(i - 1);
      const after = text.charAt(i + name.length);
      if (isIdentChar(before) || isIdentChar(after)) continue;
      const start = positionAtOffset(text, starts, i);
      const end = positionAtOffset(text, starts, i + name.length);
      return { start, end };
    }
  }
  const start = positionAtOffset(text, starts, fromOffset);
  return { start, end: start };
}

/**
 * Exact single-line range of an identifier token that starts at the given
 * 1-based bridge-core position. Used for members and unqualified type
 * references, whose AST nodes record the name token start.
 */
function tokenRange(text: string, starts: number[], line: number, column: number, name: string): Range {
  const start = toLspPosition({ line, column });
  const lineText = lineTextAt(text, start.line) ?? '';
  // Verify the slice actually is the name (defends against any position
  // drift); degrade to zero-width rather than answer a wrong range.
  if (lineText.slice(start.character, start.character + name.length) !== name) {
    return { start, end: start };
  }
  return { start, end: { line: start.line, character: start.character + name.length } };
}

/**
 * The end position of the declaration region `[start, regionEnd)` after
 * trimming trailing whitespace — the honest enclosing range of a top-level
 * declaration without a dedicated end-position in the AST.
 */
function regionEnd(text: string, starts: number[], start: number, regionEndOffset: number): Position {
  let end = regionEndOffset;
  while (end > start && /\s/.test(text.charAt(end - 1))) end--;
  return positionAtOffset(text, starts, end);
}

// ------------------------------------------------------------- type walks

function collectTypeRefs(text: string, starts: number[], type: TypeNode, out: TypeRefSymbol[]): void {
  switch (type.kind) {
    case 'named': {
      const start = toLspPosition({ line: type.line, column: type.column });
      if (type.package === undefined) {
        const nameRange = tokenRange(text, starts, type.line, type.column, type.name);
        out.push({ name: type.name, nameRange, fullRange: nameRange });
        break;
      }
      // Qualified `pkg.Name`: the AST records the FIRST segment. Reconstruct
      // the whole dotted extent arithmetically and verify it against the text.
      const full = `${type.package}.${type.name}`;
      const fullEnd = start.character + full.length;
      const lineText = lineTextAt(text, start.line) ?? '';
      if (lineText.slice(start.character, fullEnd) === full) {
        const nameStart = start.character + type.package.length + 1;
        out.push({
          name: type.name,
          package: type.package,
          nameRange: {
            start: { line: start.line, character: nameStart },
            end: { line: start.line, character: nameStart + type.name.length },
          },
          fullRange: { start, end: { line: start.line, character: fullEnd } },
        });
      } else {
        // Pathological whitespace (`a . b`) — the arithmetic extent does not
        // match the text. Keep the ref (so a cursor elsewhere is unaffected)
        // but make it unmatchable: navigation on it answers null honestly.
        out.push({ name: type.name, package: type.package, nameRange: { start, end: start }, fullRange: { start, end: start } });
      }
      break;
    }
    case 'list':
    case 'set':
      collectTypeRefs(text, starts, type.element, out);
      break;
    case 'map':
      collectTypeRefs(text, starts, type.key, out);
      collectTypeRefs(text, starts, type.value, out);
      break;
    case 'optional':
      collectTypeRefs(text, starts, type.inner, out);
      break;
    case 'primitive':
    case 'error':
      break;
  }
}

// ------------------------------------------------------------ index build

/**
 * Parse `text` (best-effort, never throws) and index every declaration,
 * member and type reference with its LSP range. This is the entry point the
 * server calls per request; the AST is re-derived only when the document
 * text changed (the caller caches).
 */
export function buildSymbolIndex(text: string, filePath = 'bridge-lsp'): SymbolIndex {
  try {
    const lexed = tokenize(text, filePath);
    const parsed = parse(lexed.tokens, filePath);
    return indexFile(text, parsed.file);
  } catch {
    // tokenize/parse recover from any input; this guard only keeps an
    // unexpected internal failure from ever surfacing as a server error.
    return EMPTY_INDEX;
  }
}

function indexFile(text: string, file: BridgeFileNode): SymbolIndex {
  const starts = lineStartsOf(text);
  const decls: DeclSymbol[] = [];
  const members: MemberSymbol[] = [];
  const typeRefs: TypeRefSymbol[] = [];
  const packageName = file.package?.name ?? '';

  const declOffsets = file.decls.map((d) => offsetOf(starts, d.line, d.column));

  for (let i = 0; i < file.decls.length; i++) {
    const decl = file.decls[i];
    if (decl === undefined || decl.name === '') continue; // unnamed = parse-error artifact
    const start = declOffsets[i] ?? 0;
    const next = i + 1 < file.decls.length ? declOffsets[i + 1] : undefined;
    const declSymbol: DeclSymbol = {
      name: decl.name,
      kind: decl.decl,
      nameRange: scannedNameRange(text, starts, start, decl.name),
      fullRange: {
        start: positionAtOffset(text, starts, start),
        end: regionEnd(text, starts, start, next ?? text.length),
      },
      node: decl,
    };
    decls.push(declSymbol);

    if (isTypeDecl(decl)) {
      if (decl.decl === 'alias') {
        collectTypeRefs(text, starts, decl.target, typeRefs);
      } else if (decl.decl === 'enum') {
        for (const variant of decl.variants) {
          if (variant.name === '') continue;
          members.push({
            name: variant.name,
            kind: 'variant',
            parent: decl.name,
            nameRange: tokenRange(text, starts, variant.line, variant.column, variant.name),
            node: variant,
          });
        }
      } else {
        const body: readonly FieldNode[] = decl.decl === 'union' ? decl.members : decl.fields;
        for (const field of body) {
          if (field.name === '') continue;
          members.push({
            name: field.name,
            kind: 'field',
            parent: decl.name,
            nameRange: tokenRange(text, starts, field.line, field.column, field.name),
            node: field,
          });
          collectTypeRefs(text, starts, field.type, typeRefs);
        }
      }
    } else if (decl.decl === 'service') {
      for (const method of decl.methods) {
        if (method.name === '') continue;
        members.push({
          name: method.name,
          kind: 'method',
          parent: decl.name,
          nameRange: tokenRange(text, starts, method.line, method.column, method.name),
          node: method,
        });
        collectTypeRefs(text, starts, method.input, typeRefs);
        collectTypeRefs(text, starts, method.output, typeRefs);
      }
    } else {
      for (const field of decl.fields) {
        if (field.name === '') continue;
        members.push({
          name: field.name,
          kind: 'field',
          parent: decl.name,
          nameRange: tokenRange(text, starts, field.line, field.column, field.name),
          node: field,
        });
        collectTypeRefs(text, starts, field.type, typeRefs);
      }
    }
  }

  return { packageName, decls, members, typeRefs };
}

// ---------------------------------------------------------- lookups

/** The declaration whose NAME contains `position`, if any. */
export function declAtPosition(index: SymbolIndex, position: Position): DeclSymbol | undefined {
  return index.decls.find((d) => containsPosition(d.nameRange, position));
}

/** The field / variant / method whose NAME contains `position`, if any. */
export function memberAtPosition(index: SymbolIndex, position: Position): MemberSymbol | undefined {
  return index.members.find((m) => containsPosition(m.nameRange, position));
}

/** The type reference whose written extent contains `position`, if any. */
export function typeRefAtPosition(index: SymbolIndex, position: Position): TypeRefSymbol | undefined {
  return index.typeRefs.find((r) => containsPosition(r.fullRange, position));
}

/** The first top-level declaration with this exact name, if any. */
export function findDeclByName(index: SymbolIndex, name: string): DeclSymbol | undefined {
  return index.decls.find((d) => d.name === name);
}

/**
 * True when the declaration introduces a type (struct/enum/union/alias) —
 * the only symbols v1 considers renamable: services, events and members
 * have no same-file call sites beyond their own declaration.
 */
export function isTypeDeclSymbol(decl: DeclSymbol): boolean {
  return decl.kind === 'struct' || decl.kind === 'enum' || decl.kind === 'union' || decl.kind === 'alias';
}

/**
 * All same-file references to `name`, in document order: unqualified
 * references plus SELF-QUALIFIED ones (`shop.v1.Item` inside package
 * `shop.v1` — bridge-core's semantic analysis resolves those locally too,
 * see the own-package case in `semantic.ts`).
 */
export function localRefsTo(index: SymbolIndex, name: string): TypeRefSymbol[] {
  return index.typeRefs.filter(
    (r) => (r.package === undefined || r.package === index.packageName) && r.name === name,
  );
}

function containsPosition(range: Range, position: Position): boolean {
  if (position.line < range.start.line || position.line > range.end.line) return false;
  if (position.line === range.start.line && position.character < range.start.character) return false;
  if (position.line === range.end.line && position.character > range.end.character) return false;
  return true;
}

// ----------------------------------------------------- document symbols

/** SymbolKind for a top-level declaration. */
export function declSymbolKind(kind: TopDeclKind): number {
  switch (kind) {
    case 'struct':
      return SymbolKind.Struct;
    case 'enum':
      return SymbolKind.Enum;
    case 'union':
      return SymbolKind.Interface; // a closed sum type — no dedicated LSP kind
    case 'alias':
      return SymbolKind.Class; // matches the completion fallback convention
    case 'service':
      return SymbolKind.Interface;
    case 'event':
      return SymbolKind.Event;
  }
}

function fieldDetail(field: FieldNode): string {
  let text = typeToTextSafe(field.type);
  if (field.optional && field.type.kind !== 'optional') text += '?';
  return text;
}

/** Render a member / declaration detail without ever throwing. */
function typeToTextSafe(type: TypeNode): string {
  try {
    return typeToText(type);
  } catch {
    return '<error>';
  }
}

/** Build the hierarchical `textDocument/documentSymbol` response. */
export function documentSymbols(text: string, index: SymbolIndex): DocumentSymbol[] {
  const starts = lineStartsOf(text);
  const byParent = new Map<string, MemberSymbol[]>();
  for (const member of index.members) {
    const list = byParent.get(member.parent);
    if (list === undefined) byParent.set(member.parent, [member]);
    else list.push(member);
  }

  const childrenOf = (decl: DeclSymbol): DocumentSymbol[] | undefined => {
    const list = byParent.get(decl.name);
    if (list === undefined || list.length === 0) return undefined;
    return list.map((member) => {
      const symbol: DocumentSymbol = {
        name: member.name,
        kind: member.kind === 'method' ? SymbolKind.Method : member.kind === 'variant' ? SymbolKind.EnumMember : SymbolKind.Field,
        range: memberRange(text, starts, member.nameRange),
        selectionRange: member.nameRange,
      };
      if (member.kind === 'method') {
        const m = member.node as MethodNode;
        symbol.detail = `${typeToTextSafe(m.input)} -> ${typeToTextSafe(m.output)}`;
      } else if (member.kind === 'field') {
        symbol.detail = fieldDetail(member.node as FieldNode);
      }
      return symbol;
    });
  };

  return index.decls.map((decl) => {
    const symbol: DocumentSymbol = {
      name: decl.name,
      detail: decl.kind,
      kind: declSymbolKind(decl.kind),
      range: decl.fullRange,
      selectionRange: decl.nameRange,
    };
    const children = childrenOf(decl);
    if (children !== undefined) symbol.children = children;
    return symbol;
  });
}

/**
 * The range shown for a member in the outline: from the name to the end of
 * the (necessarily single-line) member, trailing whitespace trimmed.
 */
function memberRange(text: string, starts: number[], nameRange: Range): Range {
  const startOffset = (starts[nameRange.start.line] ?? 0) + nameRange.start.character;
  let lineEnd = text.indexOf('\n', startOffset);
  if (lineEnd === -1) lineEnd = text.length;
  let end = lineEnd;
  while (end > startOffset && /\s/.test(text.charAt(end - 1))) end--;
  return {
    start: nameRange.start,
    end: positionAtOffset(text, starts, end),
  };
}
