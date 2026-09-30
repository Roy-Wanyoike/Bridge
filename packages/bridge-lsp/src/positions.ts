/**
 * Position mapping between bridge-core (compiler) coordinates and LSP
 * coordinates — the single most subtle part of this server.
 *
 * FINDING — how bridge-core counts columns (verified empirically against
 * `packages/bridge-core/src/lexer.ts` and by compiling crafted inputs):
 *
 *   bridge-core positions are 1-based and counted in **UTF-16 code units**.
 *   The lexer advances its 1-based `column` once per UTF-16 unit and consumes
 *   whole code points when scanning (an astral character is one scan step).
 *   Concretely (all verified in this repo):
 *
 *   - `é` (U+00E9 — 2 UTF-8 bytes, 1 UTF-16 unit) inside a string literal
 *     shifts every later column on the line by exactly 1;
 *   - `😀` (U+1F600 — 4 UTF-8 bytes, 2 UTF-16 units, one surrogate pair)
 *     shifts every later column by exactly 2;
 *   - consequently an unexpected astral character produces exactly ONE
 *     unexpected-character diagnostic at the character's start column (the
 *     per-surrogate-half double report was fixed in issue #114).
 *
 * The LSP 3.17 specification defines `position.character` as a 0-based
 * offset in **UTF-16 code units** as well. The mapping is therefore exact
 * and trivially simple in both directions:
 *
 *     LSP  line       = bridge line   - 1
 *     LSP  character  = bridge column - 1
 *
 * Any other unit (UTF-8 bytes, Unicode code points) would be WRONG here:
 * byte counting over-reports after 2/3/4-byte characters, code-point
 * counting under-reports after surrogate pairs.
 */

import type { Position, Range } from './protocol';

/** Convert a 1-based bridge-core position to a 0-based LSP position. */
export function toLspPosition(bridge: { line: number; column: number }): Position {
  return { line: bridge.line - 1, character: bridge.column - 1 };
}

/** Convert a 0-based LSP position to a 1-based bridge-core position. */
export function toBridgePosition(lsp: Position): { line: number; column: number } {
  return { line: lsp.line + 1, column: lsp.character + 1 };
}

/** The text of the 0-based `line` in `text`, or `undefined` when out of range. */
export function lineTextAt(text: string, line: number): string | undefined {
  return text.split('\n')[line];
}

function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}

/**
 * The LSP range of the Bridge identifier that contains (or ends exactly
 * at) `position`, or `undefined` when the cursor is not on an identifier.
 */
export function identifierAt(text: string, position: Position): Range | undefined {
  const line = lineTextAt(text, position.line);
  if (line === undefined) return undefined;

  let index = Math.min(position.character, line.length);
  if (!isIdentChar(line.charAt(index)) && index > 0 && isIdentChar(line.charAt(index - 1))) {
    index--; // cursor sits immediately after the word
  }
  if (!isIdentChar(line.charAt(index))) return undefined;

  let start = index;
  while (start > 0 && isIdentChar(line.charAt(start - 1))) start--;
  let end = index;
  while (end < line.length && isIdentChar(line.charAt(end))) end++;

  return {
    start: { line: position.line, character: start },
    end: { line: position.line, character: end },
  };
}

/**
 * The range a diagnostic should underline. bridge-core diagnostics are
 * POINTS, so the range is expanded honestly from the text itself:
 * - across the full identifier when the point starts one;
 * - otherwise across the single UTF-16 code unit at the point (two units
 *   for the high half of a surrogate pair, matching how the lexer counted).
 * When the line does not exist (EOF diagnostics) the range is zero-width.
 */
export function diagnosticRangeAt(text: string, position: Position): Range {
  const line = lineTextAt(text, position.line);
  if (line === undefined) return { start: position, end: position };

  const ch = line.charAt(position.character);
  if (/[A-Za-z_]/.test(ch)) {
    return identifierAt(text, position) ?? { start: position, end: position };
  }
  // Lone or high surrogate → the character occupies two UTF-16 code units.
  const high = ch >= '\uD800' && ch <= '\uDBFF';
  const width = high ? 2 : 1;
  return {
    start: position,
    end: { line: position.line, character: position.character + width },
  };
}

/** The whole-document range used for full-document formatting edits. */
export function fullDocumentRange(text: string): Range {
  const lines = text.split('\n');
  const last = Math.max(0, lines.length - 1);
  return {
    start: { line: 0, character: 0 },
    end: { line: last, character: (lines[last] ?? '').length },
  };
}

/**
 * The partial identifier immediately before the cursor (the typed prefix),
 * or `''` when the cursor is not at the end of a word. Used to filter
 * completion items.
 */
export function wordPrefixAt(text: string, position: Position): string {
  const line = lineTextAt(text, position.line);
  if (line === undefined) return '';
  let start = Math.min(position.character, line.length);
  while (start > 0 && isIdentChar(line.charAt(start - 1))) start--;
  return line.slice(start, position.character);
}
