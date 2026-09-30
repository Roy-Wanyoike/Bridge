/**
 * Lexer tests: UTF-8 BOM tolerance at position 0, CRLF canonicalization
 * of doc comments, and astral (non-BMP) character handling — one code point
 * must yield exactly one BR1001, never one per surrogate half (issue #114).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../lexer';
import { compileSource } from '../compiler/compile';

// ------------------------------------------------------------------ BOM

test('BOM at position 0 is skipped silently', () => {
  const lexed = tokenize('\uFEFFpackage p\ntype T {\n    x: int32\n}\n', 'bom.bridge');
  assert.deepEqual(lexed.diagnostics, [], 'no diagnostic for a leading BOM');
  const first = lexed.tokens[0];
  assert.ok(first !== undefined);
  assert.equal(first.kind, 'keyword');
  assert.equal(first.text, 'package');
  assert.equal(first.line, 1, 'BOM is invisible: the first token stays on line 1');
  assert.equal(first.column, 1, 'BOM is invisible: the first token stays at column 1');
});

test('a file containing only a BOM lexes to a single eof token', () => {
  const lexed = tokenize('\uFEFF', 'bom.bridge');
  assert.deepEqual(lexed.diagnostics, []);
  assert.equal(lexed.tokens.length, 1);
  assert.equal(lexed.tokens[0]?.kind, 'eof');
});

test('a BOM-compiling file compiles cleanly end to end', () => {
  const result = compileSource('\uFEFFpackage p\ntype T {\n    x: int32\n}\n', 'bom.bridge');
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
});

test('a BOM after position 0 is still an unexpected character', () => {
  const lexed = tokenize('package p\n\uFEFF\ntype T { x: int32 }\n', 'bom.bridge');
  assert.equal(
    lexed.diagnostics.some((d) => d.code === 'BR1001'),
    true,
    'mid-file BOM must be reported',
  );
});

// ------------------------------------------------------------------ CRLF

test('CRLF doc comments: trailing \\r is stripped from doc text', () => {
  const lexed = tokenize(
    'package p\r\n/// Struct docs.\r\ntype T {\r\n    /// Field docs.\r\n    x: int32\r\n}\r\n',
    'crlf.bridge',
  );
  assert.deepEqual(lexed.diagnostics, []);
  const docs = lexed.tokens.filter((t) => t.kind === 'doc').map((t) => t.text);
  assert.deepEqual(docs, ['Struct docs.', 'Field docs.']);
  assert.ok(docs.every((d) => !d.includes('\r')), JSON.stringify(docs));
});

test('CRLF files parse with clean doc text end to end', () => {
  const result = compileSource(
    'package p\r\n/// Struct docs.\r\ntype T {\r\n    /// Field docs.\r\n    x: int32\r\n}\r\n',
    'crlf.bridge',
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  const t = result.ir?.types[0];
  assert.equal(t?.docs, 'Struct docs.');
  assert.equal(t?.kind === 'struct' ? t.fields[0]?.docs : undefined, 'Field docs.');
});

test('lone \\r is whitespace and CRLF still advances the line counter', () => {
  const lexed = tokenize('package p\r\n\r\ntype T {\r\n    x: int32\r\n}\r\n', 'crlf.bridge');
  assert.deepEqual(lexed.diagnostics, []);
  const typeKeyword = lexed.tokens.find((t) => t.text === 'type');
  assert.equal(typeKeyword?.line, 3, 'each CRLF advances exactly one line');
  const eof = lexed.tokens[lexed.tokens.length - 1];
  assert.equal(eof?.kind, 'eof');
});

// -------------------------------------------------------- astral characters

test('one astral character yields exactly one BR1001; columns stay UTF-16 based', () => {
  // `package p😀中v1`: 😀 is one astral code point (2 UTF-16 code units),
  // 中 is one BMP code point. Per-code-unit scanning used to report the
  // emoji twice (columns 10 and 11); now each bad character is reported
  // exactly once and the columns remain code-unit counts.
  const lexed = tokenize('package p😀中v1\n', 'astral.bridge');
  const unexpected = lexed.diagnostics.filter((d) => d.code === 'BR1001');
  assert.equal(unexpected.length, 2, JSON.stringify(lexed.diagnostics));
  const emoji = unexpected[0];
  const bmp = unexpected[1];
  assert.equal(emoji?.line, 1);
  assert.equal(emoji?.column, 10, 'the emoji starts at column 10');
  assert.ok(emoji?.message.includes('😀') ?? false, `message must show the emoji: ${emoji?.message}`);
  assert.equal(bmp?.column, 12, 'the BMP character starts at column 12 (the emoji spans two code units)');
  assert.ok(bmp?.message.includes('中') ?? false, `message must show 中: ${bmp?.message}`);
  // Content around the bad characters lexes unaffected; `v1` sits after the
  // emoji (2 code units) + 中 (1 code unit).
  assert.deepEqual(
    lexed.tokens
      .filter((t) => t.kind === 'ident')
      .map((t) => [t.text, t.column]),
    [
      ['p', 9],
      ['v1', 13],
    ],
  );
});

test('an astral character inside a string or comment is not an error', () => {
  const lexed = tokenize(
    'package p\n/// Emoji docs 😀\ntype T {\n    label: string = "😀"\n}\n',
    'astral.bridge',
  );
  assert.deepEqual(lexed.diagnostics, [], JSON.stringify(lexed.diagnostics));
  const doc = lexed.tokens.find((t) => t.kind === 'doc');
  assert.equal(doc?.text, 'Emoji docs 😀');
  const str = lexed.tokens.find((t) => t.kind === 'string');
  assert.equal(str?.text, '😀');
});

test('a lone trailing surrogate produces exactly one diagnostic', () => {
  // U+D800 with no low surrogate after it: one code unit, one diagnostic.
  const lexed = tokenize('package p\n\u{D800}', 'surrogate.bridge');
  const unexpected = lexed.diagnostics.filter((d) => d.code === 'BR1001');
  assert.equal(unexpected.length, 1, JSON.stringify(lexed.diagnostics));
  assert.equal(unexpected[0]?.line, 2);
  assert.equal(unexpected[0]?.column, 1);
});
