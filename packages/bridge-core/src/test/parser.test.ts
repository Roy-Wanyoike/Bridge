/**
 * Parser tests: full grammar surface and error recovery.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../lexer';
import { parse, MAX_TYPE_DEPTH } from '../parser';
import { compileSource } from '../compiler/compile';
import type {
  AliasDeclNode,
  EnumDeclNode,
  EventDeclNode,
  FieldNode,
  ServiceDeclNode,
  StructDeclNode,
  TopLevelDeclNode,
  UnionDeclNode,
} from '../ast';

function parseText(text: string) {
  const lexed = tokenize(text, 'test.bridge');
  const parsed = parse(lexed.tokens, 'test.bridge');
  return { ...parsed, lexErrors: lexed.diagnostics };
}

function structOf(file: { decls: TopLevelDeclNode[] }, index: number): StructDeclNode {
  const decl = file.decls[index];
  assert.ok(decl !== undefined, `declaration ${index} missing`);
  assert.equal(decl.decl, 'struct');
  return decl;
}

// ------------------------------------------------------------------ structs

test('structs: fields, types, constraints, defaults, docs, deprecation', () => {
  const { file, diagnostics } = parseText(`
package shop.v1

/// A monetary amount in a currency.
type Money {
    /// Whole units, never fractional.
    amount: int64 @min(0) @max(999999)
    currency: string @length(3) = "USD"
    legacy: string @deprecated
    old_field?: string @deprecated("use new_field")
    note: string? = "hello"
}
`);
  assert.equal(diagnostics.length, 0);
  assert.equal(file.package?.name, 'shop.v1');
  const money = structOf(file, 0);
  assert.equal(money.name, 'Money');
  assert.equal(money.docs, 'A monetary amount in a currency.');
  assert.equal(money.fields.length, 5);

  const amount: FieldNode = money.fields[0] as FieldNode;
  assert.equal(amount.name, 'amount');
  assert.equal(amount.optional, false);
  assert.deepEqual(amount.type, {
    kind: 'primitive',
    primitive: 'int64',
    line: 7,
    column: 13,
  });
  assert.deepEqual(amount.constraints.map((c) => [c.kindName, c.args.map((a) => a.text)]), [
    ['min', ['0']],
    ['max', ['999999']],
  ]);
  assert.equal(amount.docs, 'Whole units, never fractional.');

  const currency: FieldNode = money.fields[1] as FieldNode;
  assert.deepEqual(currency.defaultValue, { text: 'USD', isString: true });
  assert.deepEqual(currency.constraints[0]?.args, [{ text: '3', isString: false }]);

  const legacy: FieldNode = money.fields[2] as FieldNode;
  assert.equal(legacy.deprecated, true);

  const oldField: FieldNode = money.fields[3] as FieldNode;
  assert.equal(oldField.deprecated, 'use new_field');
  assert.equal(oldField.optional, true, 'pre-colon `?` marks the field optional');

  const note: FieldNode = money.fields[4] as FieldNode;
  assert.equal(note.optional, true, 'type-suffix `?` marks the field optional');
  assert.deepEqual(note.defaultValue, { text: 'hello', isString: true });
});

test('structs: header deprecation and @deprecated("reason")', () => {
  const { file, diagnostics } = parseText(`
package p
type Old @deprecated {
    x: int32
}
type AlsoOld @deprecated("superseded") {
    y: int32
}
`);
  assert.equal(diagnostics.length, 0);
  assert.equal(structOf(file, 0).deprecated, true);
  assert.equal(structOf(file, 1).deprecated, 'superseded');
});

test('optional marker equivalence: `name?: T` and `name: T?`', () => {
  const { file, diagnostics } = parseText(`
package p
type T {
    a?: string
    b: string?
}
`);
  assert.equal(diagnostics.length, 0);
  const t = structOf(file, 0);
  const a: FieldNode = t.fields[0] as FieldNode;
  const b: FieldNode = t.fields[1] as FieldNode;
  assert.equal(a.optional, true);
  assert.equal(a.type.kind, 'primitive');
  assert.equal(b.optional, true);
  assert.equal(b.type.kind, 'optional', 'suffix form keeps the wrapper in the AST');
});

// ------------------------------------------------------------------- enums

test('enums: SCREAMING_SNAKE_CASE variants, docs, deprecated variants', () => {
  const { file, diagnostics } = parseText(`
package p
/// Payment lifecycle.
enum PaymentStatus {
    /// Awaiting authorization.
    PENDING
    COMPLETED
    FAILED
    REFUNDED
    RATE_LIMIT_5XX
    LEGACY @deprecated("no longer issued")
}
`);
  assert.equal(diagnostics.length, 0);
  const e = file.decls[0] as EnumDeclNode;
  assert.equal(e.decl, 'enum');
  assert.equal(e.docs, 'Payment lifecycle.');
  assert.deepEqual(e.variants.map((v) => v.name), [
    'PENDING',
    'COMPLETED',
    'FAILED',
    'REFUNDED',
    'RATE_LIMIT_5XX',
    'LEGACY',
  ]);
  assert.equal(e.variants[0]?.docs, 'Awaiting authorization.');
  assert.equal(e.variants[5]?.deprecated, 'no longer issued');
});

// ------------------------------------------------------------------ unions

test('unions: tagged members with types', () => {
  const { file, diagnostics } = parseText(`
package p
type Shape {
    radius: float64
}
union Geometry {
    circle: Shape
    nothing: bool?
}
`);
  assert.equal(diagnostics.length, 0);
  const u = file.decls[1] as UnionDeclNode;
  assert.equal(u.decl, 'union');
  assert.equal(u.members.length, 2);
  assert.equal(u.members[0]?.name, 'circle');
  assert.equal(u.members[1]?.type.kind, 'optional');
});

// ----------------------------------------------------------------- aliases

test('aliases: primitive, composite and optional targets', () => {
  const { file, diagnostics } = parseText(`
package p
alias UserId = uuid
alias Tags = map<string, list<string>>
alias MaybeUser = UserId?
`);
  assert.equal(diagnostics.length, 0);
  const a1 = file.decls[0] as AliasDeclNode;
  const a2 = file.decls[1] as AliasDeclNode;
  const a3 = file.decls[2] as AliasDeclNode;
  assert.equal(a1.target.kind, 'primitive');
  assert.equal(a2.target.kind, 'map');
  assert.equal(a3.target.kind, 'optional');
});

// ---------------------------------------------------------------- services

test('services: methods with docs and deprecation', () => {
  const { file, diagnostics } = parseText(`
package p
type Req {
    id: uuid
}
type Res {
    ok: bool
}
service Payments {
    /// Creates a payment.
    CreatePayment(Req) -> Res
    LegacyGet(Req) -> Res @deprecated
    Refund(Req) -> Res @deprecated("use ReversePayment")
}
`);
  assert.equal(diagnostics.length, 0);
  const s = file.decls[2] as ServiceDeclNode;
  assert.equal(s.decl, 'service');
  assert.deepEqual(s.methods.map((m) => m.name), ['CreatePayment', 'LegacyGet', 'Refund']);
  assert.equal(s.methods[0]?.docs, 'Creates a payment.');
  assert.equal(s.methods[1]?.deprecated, true);
  assert.equal(s.methods[2]?.deprecated, 'use ReversePayment');
});

// ----------------------------------------------------------------- events

test('events: fields and docs', () => {
  const { file, diagnostics } = parseText(`
package p
/// Emitted when a payment completes.
event PaymentCompleted {
    /// The finished payment.
    payment_id: uuid
    at: timestamp
}
`);
  assert.equal(diagnostics.length, 0);
  const e = file.decls[0] as EventDeclNode;
  assert.equal(e.decl, 'event');
  assert.equal(e.docs, 'Emitted when a payment completes.');
  assert.deepEqual(e.fields.map((f) => f.name), ['payment_id', 'at']);
});

// ------------------------------------------------------------ type nesting

test('type nesting: map<string, list<Money>> and deeper composites', () => {
  const { file, diagnostics } = parseText(`
package p
type Money {
    units: int64
}
type Deep {
    matrix: map<string, list<Money>>
    index: list<set<int32>>
    lookup: set<map<string, bool>>
    by_id: map<uuid, Money>?
}
`);
  assert.equal(diagnostics.length, 0);
  const deep = structOf(file, 1);
  const matrix = deep.fields[0] as FieldNode;
  assert.equal(matrix.type.kind, 'map');
  if (matrix.type.kind === 'map') {
    assert.equal(matrix.type.key.kind, 'primitive');
    assert.equal(matrix.type.value.kind, 'list');
    if (matrix.type.value.kind === 'list') {
      assert.equal(matrix.type.value.element.kind, 'named');
      if (matrix.type.value.element.kind === 'named') {
        assert.equal(matrix.type.value.element.name, 'Money');
      }
    }
  }
  const index = deep.fields[1] as FieldNode;
  assert.equal(index.type.kind, 'list');
  if (index.type.kind === 'list') {
    assert.equal(index.type.element.kind, 'set');
    if (index.type.element.kind === 'set') {
      assert.equal(index.type.element.element.kind, 'primitive');
    }
  }
  const byId = deep.fields[3] as FieldNode;
  assert.equal(byId.optional, true);
  assert.equal(byId.type.kind, 'optional');
});

test('qualified type references split package and name', () => {
  const { file, diagnostics } = parseText(`
package p
import identity.v1
type T {
    owner: identity.v1.User
}
`);
  assert.equal(diagnostics.length, 0);
  const t = structOf(file, 0);
  const owner = t.fields[0] as FieldNode;
  assert.deepEqual(owner.type, {
    kind: 'named',
    name: 'User',
    package: 'identity.v1',
    line: 5,
    column: 12,
  });
});

// ------------------------------------------------------- package & imports

test('package statement with docs and multiple imports', () => {
  const { file, diagnostics } = parseText(`
/// Payments domain contracts.
package payments.v1

import identity.v1
import money.v2
import money.v2
`);
  // Duplicate import is a semantic concern, not a parse error.
  assert.equal(diagnostics.length, 0);
  assert.equal(file.package?.name, 'payments.v1');
  assert.equal(file.package?.docs, 'Payments domain contracts.');
  assert.deepEqual(file.imports.map((i) => i.name), ['identity.v1', 'money.v2', 'money.v2']);
});

test('duplicate package statement is a parse error', () => {
  const { diagnostics } = parseText('package a\npackage b\n');
  assert.ok(diagnostics.length >= 1);
  assert.equal(diagnostics[0]?.code, 'BR2007');
});

// ------------------------------------------------------------ import docs

test('docs above import attach to the import, not the next declaration', () => {
  const { file, diagnostics } = parseText(`
package p

/// Docs about the import.
import identity.v1

/// Docs about the type.
type T {
    x: int32
}
`);
  assert.equal(diagnostics.length, 0, JSON.stringify(diagnostics));
  assert.equal(file.imports[0]?.docs, 'Docs about the import.');
  const t = structOf(file, 0);
  assert.equal(t.docs, 'Docs about the type.', 'type docs must not absorb the import docs');
});

test('docs above the last import at EOF are kept on the import node', () => {
  const { file, diagnostics } = parseText('package p\n/// Kept.\nimport a.b\n');
  assert.equal(diagnostics.length, 0, JSON.stringify(diagnostics));
  assert.equal(file.imports[0]?.docs, 'Kept.', 'docs above an import must not be dropped at EOF');
  assert.equal(file.decls.length, 0);
});

test('consecutive imports each keep their own docs', () => {
  const { file, diagnostics } = parseText(
    'package p\n/// First.\nimport a.b\n/// Second.\nimport c.d\n',
  );
  assert.equal(diagnostics.length, 0, JSON.stringify(diagnostics));
  assert.deepEqual(
    file.imports.map((i) => [i.name, i.docs]),
    [
      ['a.b', 'First.'],
      ['c.d', 'Second.'],
    ],
  );
});

test('import docs do not leak into the IR of the following declaration', () => {
  const result = compileSource(
    'package p\n/// Import docs.\nimport identity.v1\n/// Type docs.\ntype T {\n    x: int32\n}\n',
    'docs.bridge',
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.ir?.types[0]?.docs, 'Type docs.');
});

// --------------------------------------------------------- error recovery

test('error recovery: missing colon still parses the next field', () => {
  const { file, diagnostics } = parseText(`
package p
type A {
    x int32
    y: int32
}
`);
  assert.ok(diagnostics.length >= 1, 'missing colon must be reported');
  const a = structOf(file, 0);
  assert.deepEqual(a.fields.map((f) => f.name), ['x', 'y']);
  const x: FieldNode = a.fields[0] as FieldNode;
  assert.equal(x.type.kind, 'primitive', 'type after the missing colon still parses');
  assert.ok(diagnostics.some((d) => d.column === 7), 'error points at the token after the name');
});

test('error recovery: multiple independent errors in one file', () => {
  const { diagnostics } = parseText(`
package p
type A {
    x: int32,
    y: string;
}
type B {
    z: 42
}
`);
  assert.ok(diagnostics.length >= 3, `expected >=3 diagnostics, got ${diagnostics.length}`);
  const codes = new Set(diagnostics.map((d) => d.code));
  assert.ok(codes.has('BR1004'), 'syntax errors use BR1004');
});

test('error recovery: missing closing brace does not swallow next declaration', () => {
  const { file, diagnostics } = parseText(`
package p
type A {
    x: int32
type B {
    y: int32
}
`);
  assert.ok(diagnostics.length >= 1, 'missing `}` must be reported');
  assert.deepEqual(
    file.decls.map((d) => d.name),
    ['A', 'B'],
    'declaration B must survive recovery',
  );
  const b = structOf(file, 1);
  assert.deepEqual(b.fields.map((f) => f.name), ['y']);
});

test('lexer errors: unexpected character and unterminated string', () => {
  const { diagnostics, lexErrors } = parseText(
    'package p\ntype T { x: int32 }\nlet $x = "oops\n',
  );
  const codes = [...diagnostics, ...lexErrors].map((d) => d.code);
  assert.ok(codes.includes('BR1001'), 'unexpected character');
  assert.ok(codes.includes('BR1002'), 'unterminated string');
});

// --------------------------------------------------- @ modifier recovery

test('termination: dangling `@ @ @ :` in a field body terminates with diagnostics', () => {
  // Regression guard for the removed dead re-skip in parseField: progress
  // comes from `parseAtModifier` always consuming the `@`, so malformed
  // modifiers cannot loop forever.
  const { file, diagnostics } = parseText('package p\ntype T {\n    a: string @ @ @ :\n}\n');
  assert.ok(diagnostics.length >= 4, JSON.stringify(diagnostics));
  assert.ok(
    diagnostics.every((d) => d.code === 'BR1004'),
    `all diagnostics are syntax errors: ${JSON.stringify(diagnostics)}`,
  );
  assert.ok(
    diagnostics.filter((d) => d.message.includes('Expected a constraint name after `@`')).length === 3,
    'each dangling `@` is reported once',
  );
  const t = structOf(file, 0);
  assert.deepEqual(t.fields.map((f) => f.name), ['a'], 'the field still parses best-effort');
});

test('termination: compileSource returns ok:false with diagnostics for `@ @ @ :`', () => {
  const result = compileSource('package p\ntype T {\n    a: string @ @ @ :\n}\n', 'at.bridge');
  assert.equal(result.ok, false);
  assert.equal(result.ir, undefined);
  assert.ok(result.diagnostics.length >= 1, JSON.stringify(result.diagnostics));
});

test('constraint arguments: strings, numbers, negatives, identifiers', () => {
  const { file, diagnostics } = parseText(`
package p
type T {
    a: string @pattern("^[a-z]+$")
    b: int32 @min(-5) @max(10)
    c: string @length(1, 64)
    d: string @email @deprecated
}
`);
  assert.equal(diagnostics.length, 0);
  const t = structOf(file, 0);
  assert.deepEqual(t.fields[0]?.constraints[0]?.args, [
    { text: '^[a-z]+$', isString: true },
  ]);
  assert.deepEqual(t.fields[1]?.constraints[0]?.args, [{ text: '-5', isString: false }]);
  assert.deepEqual(t.fields[2]?.constraints[0]?.args, [
    { text: '1', isString: false },
    { text: '64', isString: false },
  ]);
  assert.equal(t.fields[3]?.constraints[0]?.kindName, 'email');
  assert.equal(t.fields[3]?.constraints[0]?.args.length, 0);
});

test('positions are 1-based and point at the declaration keyword', () => {
  const { file } = parseText('package p\n\ntype T {\n    x: int32\n}\n');
  const t = structOf(file, 0);
  assert.equal(t.line, 3);
  assert.equal(t.column, 1);
});

// ------------------------------------------------------- type depth limit

/** Build `x: list<list<…string…>>` nested `depth` levels. */
function nestedType(depth: number, open = 'list<', close = '>'): string {
  return `package p\ntype T {\n    x: ${open.repeat(depth)}string${close.repeat(depth)}\n}\n`;
}

test('type depth limit: nesting up to 256 levels parses cleanly', () => {
  const { file, diagnostics } = parseText(nestedType(MAX_TYPE_DEPTH));
  assert.equal(diagnostics.length, 0, JSON.stringify(diagnostics));
  const t = structOf(file, 0);
  assert.equal(t.fields[0]?.type.kind, 'list');
});

test('type depth limit: 257 levels report BR1005 "type nesting too deep", not a crash', () => {
  const { diagnostics } = parseText(nestedType(MAX_TYPE_DEPTH + 1));
  const depthErrors = diagnostics.filter((d) => d.code === 'BR1005');
  assert.equal(depthErrors.length, 1, `expected exactly one BR1005, got: ${JSON.stringify(diagnostics)}`);
  assert.match(depthErrors[0]?.message ?? '', /Type nesting too deep/);
  assert.match(depthErrors[0]?.message ?? '', /256/);
  assert.equal(depthErrors[0]?.severity, 'error');
  assert.ok(diagnostics.every((d) => d.code !== 'BR2999'), 'no internal error');
});

test('type depth limit: unbounded `list<` seed (8000 deep) recovers with one diagnostic', () => {
  // The original issue scenario: an 8000-deep `list<` used to overflow the
  // call stack and surface as BR2999 "Maximum call stack size exceeded".
  const source = `package p\ntype T {\n    x: ${'list<'.repeat(8000)}\n}\n`;
  const { diagnostics } = parseText(source);
  const depthErrors = diagnostics.filter((d) => d.code === 'BR1005');
  assert.equal(depthErrors.length, 1, `expected exactly one BR1005, got: ${JSON.stringify(diagnostics.map((d) => d.code))}`);
  assert.ok(diagnostics.every((d) => d.code !== 'BR2999'));
});

test('type depth limit: parsing continues after a too-deep type', () => {
  const { file, diagnostics } = parseText(`
package p
type T {
    x: ${'map<string, '.repeat(300)}int32${'>'.repeat(300)}
    y: int32
}

type U {
    z: string
}
`);
  assert.equal(diagnostics.filter((d) => d.code === 'BR1005').length, 1);
  assert.deepEqual(file.decls.map((d) => d.name), ['T', 'U'], 'following declarations survive');
  const u = structOf(file, 1);
  assert.deepEqual(u.fields.map((f) => f.name), ['z']);
  assert.equal(u.fields[0]?.type.kind, 'primitive');
});

// -------------------------------------------------- redundant optional markers

test('redundant optional markers warn (BR2104): `a: string ? ?`', () => {
  const { diagnostics } = parseText('package p\ntype T {\n    a: string ? ?\n}\n');
  const warnings = diagnostics.filter((d) => d.code === 'BR2104');
  assert.equal(warnings.length, 1, JSON.stringify(diagnostics));
  assert.equal(warnings[0]?.severity, 'warning');
  assert.match(warnings[0]?.message ?? '', /declares the optional marker `\?` more than once/);
  assert.match(warnings[0]?.hint ?? '', /canonical style/);
});

test('redundant optional markers warn for `a?: string?` and `a: string??`', () => {
  for (const field of ['a?: string?', 'a: string??', 'a?: string??']) {
    const { diagnostics } = parseText(`package p\ntype T {\n    ${field}\n}\n`);
    const warnings = diagnostics.filter((d) => d.code === 'BR2104');
    assert.equal(warnings.length, 1, `${field}: ${JSON.stringify(diagnostics)}`);
    assert.equal(warnings[0]?.severity, 'warning');
  }
});

test('a single optional marker never warns', () => {
  for (const field of ['a: string', 'a: string?', 'a?: string', 'b: list<int32>?', 'c?: list<int32>', 'd: map<string, int32>?']) {
    const { diagnostics } = parseText(`package p\ntype T {\n    ${field}\n}\n`);
    assert.equal(
      diagnostics.filter((d) => d.code === 'BR2104').length,
      0,
      `${field} must not warn: ${JSON.stringify(diagnostics)}`,
    );
  }
});

test('redundant optional markers are advisory: compilation still succeeds', () => {
  const result = compileSource('package p\ntype T {\n    a?: string?\n}\n', 'warn.bridge');
  assert.equal(result.ok, true, 'warnings must not block compilation');
  assert.ok(result.diagnostics.some((d) => d.code === 'BR2104' && d.severity === 'warning'));
});
