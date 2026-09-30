/**
 * Formatter tests: canonical 4-space output, exact layout, idempotence
 * (format∘format = format), doc preservation and failure behavior.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSource } from '../format';

const MESSY = `package   shop.v1
/// Money.
type    Money{
    amount:int64 @min( 0 )
    currency:string @length(3)="USD"
    label?:string
    // plain comments are dropped; only /// docs survive
}

enum Status { ACTIVE
BANNED }

service   Svc{
/// Do it.
Get(Money)->Money
}
alias   Tag = map<string,list<int32>>

event Ping {}
`;

const CANONICAL = `package shop.v1

/// Money.
type Money {
    amount: int64 @min(0)
    currency: string @length(3) = "USD"
    label: string?
}

enum Status {
    ACTIVE
    BANNED
}

service Svc {
    /// Do it.
    Get(Money) -> Money
}

alias Tag = map<string, list<int32>>

event Ping {
}
`;

function formatOk(text: string): string {
  const result = formatSource(text, 'fmt.bridge');
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.ok(typeof result.output === 'string');
  return result.output;
}

test('canonical output: 4-space indent, one decl per block, single trailing newline', () => {
  assert.equal(formatOk(MESSY), CANONICAL);
});

test('formatting is idempotent: format(format(x)) === format(x)', () => {
  const once = formatOk(MESSY);
  const twice = formatOk(once);
  assert.equal(twice, once);
});

test('docs are preserved verbatim above their declaration', () => {
  const source = `/// Package docs.
package p

/// Struct docs.
type T {
    /// Field docs.
    id: uuid
}

/// Enum docs.
enum E {
    /// Variant docs.
    OK
}

/// Service docs.
service S {
    /// Method docs.
    Get(T) -> T
}
`;
  const once = formatOk(source);
  assert.equal(once, source, 'already-canonical input is a fixed point');
  assert.equal(formatOk(once), source);
});

// ------------------------------------------------------- docs above imports

test('docs above imports stay above the import, not the next declaration', () => {
  const source = `package p

/// Docs about the import.
import identity.v1

/// Docs about the type.
type T {
    x: int32
}
`;
  const once = formatOk(source);
  assert.equal(once, source, 'import docs stay on the import; type docs stay on the type');
  assert.equal(formatOk(once), source, 'formatting is idempotent');
});

test('docs above the last import at EOF survive formatting', () => {
  const output = formatOk('package p\n/// Kept.\nimport a.b\n');
  assert.equal(output, 'package p\n\n/// Kept.\nimport a.b\n');
  assert.equal(formatOk(output), output, 'the formatted output is a fixed point');
});

test('each of several imports keeps its own docs when formatting', () => {
  const output = formatOk('package p\n/// One.\nimport a.b\n/// Two.\nimport c.d\n');
  assert.equal(output, 'package p\n\n/// One.\nimport a.b\n/// Two.\nimport c.d\n');
  assert.equal(formatOk(output), output);
});

test('optional markers normalize to the `T?` type suffix', () => {
  const output = formatOk('package p\ntype T {\n    a?: string\n    b: string?\n    c?: list<int32>?\n}\n');
  assert.equal(
    output,
    `package p

type T {
    a: string?
    b: string?
    c: list<int32>?
}
`,
  );
});

test('deprecated renders after constraints and before defaults', () => {
  const output = formatOk(
    'package p\n' +
      'type Old @deprecated("superseded") {\n' +
      '    x: int32 @min(0) @deprecated("use y")\n' +
      '    y: string @deprecated = "n/a"\n' +
      '}\n',
  );
  assert.equal(
    output,
    `package p

type Old @deprecated("superseded") {
    x: int32 @min(0) @deprecated("use y")
    y: string @deprecated = "n/a"
}
`,
  );
});

test('string constraint arguments are re-quoted with IDL escapes', () => {
  // IDL source carries `\\d` (escaped backslash); the decoded value is `\d`
  // and the canonical output re-escapes it to `\\d`.
  const output = formatOk('package p\ntype T {\n    re: string @pattern("^\\\\d+$")\n}\n');
  assert.ok(output.includes('@pattern("^\\\\d+$")'), output);
});

test('invalid source: ok=false, diagnostics present, no output', () => {
  const result = formatSource('type T {\n    x: int32\n', 'broken.bridge');
  assert.equal(result.ok, false);
  assert.equal(result.output, undefined);
  assert.ok(result.diagnostics.length >= 1);
  assert.ok(result.diagnostics.every((d) => typeof d.code === 'string'));
});

test('formatSource never throws on garbage and reports failure instead', () => {
  const garbage = ['', '   ', ']]]{', 'type', 'type T', '😀😀', 'package;\x00\x01', '"unterminated'];
  for (const text of garbage) {
    const result = formatSource(text, 'garbage.bridge');
    assert.equal(typeof result.ok, 'boolean');
    assert.ok(Array.isArray(result.diagnostics));
    if (!result.ok) assert.equal(result.output, undefined);
  }
});

// ------------------------------------------------------------- CRLF input

test('CRLF files format to canonical LF output', () => {
  const crlfSource = [
    'package shop.v1',
    '/// Money.',
    'type Money {',
    '    /// Whole units.',
    '    amount: int64',
    '    currency: string?',
    '}',
    '',
  ].join('\r\n');
  const result = formatSource(crlfSource, 'crlf.bridge');
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.output, `package shop.v1

/// Money.
type Money {
    /// Whole units.
    amount: int64
    currency: string?
}
`);
  assert.ok(!result.output?.includes('\r'), 'output must not contain any CR');
  // Formatting is idempotent across the CRLF → LF canonicalization.
  const again = formatSource(result.output ?? '', 'crlf.bridge');
  assert.equal(again.ok, true);
  assert.equal(again.output, result.output);
});

// ------------------------------------------------------- depth protection

test('deeply nested types fail with BR1005, never an internal formatter error', () => {
  // Depth 200 formats fine (the issue's baseline case).
  const shallow = formatSource(
    `package p\ntype T {\n    x: ${'list<'.repeat(200)}string${'>'.repeat(200)}\n}\n`,
    'deep.bridge',
  );
  assert.equal(shallow.ok, true, JSON.stringify(shallow.diagnostics));

  // 8000 open `list<` used to overflow the stack while parsing (BR2999);
  // the parser's depth limit now rejects it with a proper syntax diagnostic.
  const deep = formatSource(`package p\ntype T {\n    x: ${'list<'.repeat(8000)}\n}\n`, 'deep.bridge');
  assert.equal(deep.ok, false);
  assert.equal(deep.output, undefined);
  assert.ok(deep.diagnostics.some((d) => d.code === 'BR1005'), JSON.stringify(deep.diagnostics));
  assert.ok(
    deep.diagnostics.every((d) => d.code !== 'BR2999'),
    'formatter must report BR1005, not an internal error',
  );
});
