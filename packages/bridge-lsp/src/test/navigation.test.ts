/**
 * Navigation tests: `textDocument/definition`, `textDocument/references`,
 * `textDocument/documentSymbol` and the rename pair — driven over the same
 * in-memory duplex harness as lsp.test.ts.
 *
 * The fixture positions are deliberate: every character offset in this file
 * is computed by hand from the fixture text and asserted exactly, so a
 * position-mapping regression cannot hide behind structural assertions.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compileSource } from '@bridge/core';

import { TestClient, URI } from './harness';
import { Methods, type DocumentSymbol, type Location, type Position, type Range } from '../protocol';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NAV_DOC = [
  'package shop.v1', //          0
  '', //                         1
  'import identity.v1', //       2
  '', //                         3
  'type Item {', //              4   name 5..9
  '    sku: string @length(8)', // 5
  '}', //                        6
  '', //                         7
  'type Cart {', //              8   name 5..9
  '    items: list<Item>', //    9   Item 16..20
  '    labels: set<string>', //  10
  '    totals: map<string, Item>', // 11  Item 24..28
  '    coupon: Item?', //        12  Item 12..16
  '    buyer: identity.v1.User', // 13  User 23..27 (pkg identity.v1)
  '}', //                        14
  '', //                         15
  'type User {', //              16  local User — distinct from identity.v1.User
  '    id: uuid', //             17
  '}', //                        18
  '', //                         19
  'service Shop {', //           20  name 8..12
  '    Checkout(Cart) -> Receipt', // 21  Cart 13..17, Receipt 22..29
  '}', //                        22
  '', //                         23
  'type Receipt {', //           24  name 5..12
  '    cart: Cart', //           25  Cart 10..14
  '}', //                        26
  '', //                         27
  'alias CartRef = Cart', //     28  CartRef 6..13, Cart 16..20
  '', //                         29
  'event OrderPlaced {', //      30  name 6..17
  '    orderId: string', //      31
  '}', //                        32
].join('\n');

/** Self-qualified reference (`a.v1.T`) — bridge-core resolves it locally. */
const SELF_QUALIFIED_DOC = [
  'package a.v1', //       0
  '', //                   1
  'type U {', //           2   name 5..6
  '    v: a.v1.T', //      3   a 7..8, v1 9..11, T 12..13
  '}', //                  4
  '', //                   5
  'type T {', //           6   name 5..6
  '    x: int32', //       7
  '}', //                  8
].join('\n');

const NAV_URI = 'file:///work/shop.bridge';

async function withClient(run: (client: TestClient) => Promise<void>): Promise<void> {
  const client = new TestClient();
  try {
    await client.initialize();
    await run(client);
  } finally {
    client.stop();
  }
}

function rangeOf(startLine: number, startCharacter: number, endLine: number, endCharacter: number): Range {
  return { start: { line: startLine, character: startCharacter }, end: { line: endLine, character: endCharacter } };
}

function at(line: number, character: number): Position {
  return { line, character };
}

/** Assert-and-narrow the first element (noUncheckedIndexedAccess-safe). */
function first<T>(list: T[]): T {
  const item = list[0];
  assert.ok(item !== undefined, 'expected a non-empty list');
  return item;
}

/** Collect leaf + child symbols in document order (flattened). */
function flatten(symbols: DocumentSymbol[]): Array<{ name: string; kind: number; symbol: DocumentSymbol; depth: number }> {
  const out: Array<{ name: string; kind: number; symbol: DocumentSymbol; depth: number }> = [];
  const walk = (list: DocumentSymbol[], depth: number): void => {
    for (const symbol of list) {
      out.push({ name: symbol.name, kind: symbol.kind, symbol, depth });
      if (symbol.children !== undefined) walk(symbol.children, depth + 1);
    }
  };
  walk(symbols, 0);
  return out;
}

// ---------------------------------------------------------------------------
// textDocument/documentSymbol
// ---------------------------------------------------------------------------

test('documentSymbol outlines declarations in source order with kinds and details', async () => {
  await withClient(async (client) => {
    client.open(NAV_URI, NAV_DOC);
    const response = await client.request(Methods.DocumentSymbol, { textDocument: { uri: NAV_URI } });
    assert.equal(response.error, undefined);
    const symbols = response.result as DocumentSymbol[];

    assert.deepEqual(
      symbols.map((s) => s.name),
      ['Item', 'Cart', 'User', 'Shop', 'Receipt', 'CartRef', 'OrderPlaced'],
    );
    assert.deepEqual(
      symbols.map((s) => s.detail),
      ['struct', 'struct', 'struct', 'service', 'struct', 'alias', 'event'],
    );
    // SymbolKind: Struct=23, Interface=11 (service/union), Class=5 (alias), Event=24.
    assert.deepEqual(
      symbols.map((s) => s.kind),
      [23, 23, 23, 11, 23, 5, 24],
    );

    const item = first(symbols);
    assert.deepEqual(item.selectionRange, rangeOf(4, 5, 4, 9));
    assert.deepEqual(item.range, rangeOf(4, 0, 6, 1));
    const cart = symbols[1];
    assert.ok(cart !== undefined);
    assert.deepEqual(
      (cart.children ?? []).map((c) => `${c.name}=${c.detail}`),
      ['items=list<Item>', 'labels=set<string>', 'totals=map<string, Item>', 'coupon=Item?', 'buyer=identity.v1.User'],
    );
    const shop = symbols[3];
    assert.ok(shop !== undefined);
    assert.deepEqual((shop.children ?? []).map((c) => c.name), ['Checkout']);
    assert.equal(shop.children?.[0]?.kind, 6); // Method
    assert.equal(shop.children?.[0]?.detail, 'Cart -> Receipt');
    assert.deepEqual(shop.children?.[0]?.selectionRange, rangeOf(21, 4, 21, 12));
    const cartRef = symbols[5];
    assert.ok(cartRef !== undefined);
    assert.equal(cartRef.children, undefined); // aliases have no members
    const event = symbols[6];
    assert.ok(event !== undefined);
    assert.deepEqual((event.children ?? []).map((c) => c.name), ['orderId']);
    assert.equal(event.children?.[0]?.kind, 8); // Field
  });
});

test('documentSymbol lists enum variants as EnumMember children', async () => {
  await withClient(async (client) => {
    const doc = 'package payments.v1\n\nenum PaymentStatus {\n    PENDING\n    COMPLETED\n}\n';
    client.open(NAV_URI, doc);
    const response = await client.request(Methods.DocumentSymbol, { textDocument: { uri: NAV_URI } });
    const symbols = response.result as DocumentSymbol[];
    assert.equal(symbols.length, 1);
    const status = first(symbols);
    assert.equal(status.kind, 10); // Enum
    assert.deepEqual(status.selectionRange, rangeOf(2, 5, 2, 18));
    assert.deepEqual((status.children ?? []).map((c) => c.kind), [22, 22]); // EnumMember
    assert.deepEqual((status.children ?? []).map((c) => c.selectionRange), [
      rangeOf(3, 4, 3, 11),
      rangeOf(4, 4, 4, 13),
    ]);
  });
});

test('documentSymbol ranges nest: selection inside range, children inside parents', async () => {
  await withClient(async (client) => {
    client.open(NAV_URI, NAV_DOC);
    const response = await client.request(Methods.DocumentSymbol, { textDocument: { uri: NAV_URI } });
    const symbols = response.result as DocumentSymbol[];
    const within = (outer: Range, inner: Range): boolean =>
      (inner.start.line > outer.start.line ||
        (inner.start.line === outer.start.line && inner.start.character >= outer.start.character)) &&
      (inner.end.line < outer.end.line ||
        (inner.end.line === outer.end.line && inner.end.character <= outer.end.character));
    for (const { symbol, depth } of flatten(symbols)) {
      assert.ok(within(symbol.range, symbol.selectionRange), `selectionRange outside range: ${symbol.name}`);
      if (depth > 0) assert.ok(true); // parent containment asserted via the children walk below
    }
    for (const symbol of symbols) {
      for (const child of symbol.children ?? []) {
        assert.ok(within(symbol.range, child.range), `child ${child.name} outside parent ${symbol.name}`);
      }
    }
  });
});

test('documentSymbol on an empty document answers []', async () => {
  await withClient(async (client) => {
    client.open(NAV_URI, '');
    const response = await client.request(Methods.DocumentSymbol, { textDocument: { uri: NAV_URI } });
    assert.deepEqual(response.result, []);
  });
});

test('documentSymbol on a never-opened document answers []', async () => {
  await withClient(async (client) => {
    const response = await client.request(Methods.DocumentSymbol, { textDocument: { uri: 'file:///nowhere.bridge' } });
    assert.deepEqual(response.result, []);
  });
});

test('documentSymbol keeps working on a document with syntax errors', async () => {
  await withClient(async (client) => {
    // Missing closing brace: the parser recovers, the declaration survives.
    client.open(NAV_URI, 'package shop.v1\ntype Item {\n    sku: string\n');
    const response = await client.request(Methods.DocumentSymbol, { textDocument: { uri: NAV_URI } });
    const symbols = response.result as DocumentSymbol[];
    assert.deepEqual(symbols.map((s) => s.name), ['Item']);
    assert.deepEqual((symbols[0]?.children ?? []).map((c) => c.name), ['sku']);
  });
});

test('documentSymbol skips parse-error artifacts (declarations without a name)', async () => {
  await withClient(async (client) => {
    client.open(NAV_URI, 'package shop.v1\ntype {\n    sku: string\n}\n');
    const response = await client.request(Methods.DocumentSymbol, { textDocument: { uri: NAV_URI } });
    const symbols = response.result as DocumentSymbol[];
    assert.deepEqual(symbols.map((s) => s.name), [], 'a nameless declaration must not become an outline entry');
  });
});

test('documentSymbol reflects edits: the outline follows didChange', async () => {
  await withClient(async (client) => {
    client.open(NAV_URI, 'package shop.v1\n');
    const before = (await client.request(Methods.DocumentSymbol, { textDocument: { uri: NAV_URI } })).result as DocumentSymbol[];
    assert.deepEqual(before, []);

    client.change(NAV_URI, 'package shop.v1\ntype Later { x: int32 }\n', 2);
    const after = (await client.request(Methods.DocumentSymbol, { textDocument: { uri: NAV_URI } })).result as DocumentSymbol[];
    assert.deepEqual(after.map((s) => s.name), ['Later']);
  });
});

// ---------------------------------------------------------------------------
// textDocument/definition
// ---------------------------------------------------------------------------

test('definition jumps from a field type reference to the declaration', async () => {
  await withClient(async (client) => {
    client.open(URI, [
      'package payments.v1',
      '',
      'type Money {',
      '    amount: int64',
      '}',
      '',
      'type Payment {',
      '    amount: Money',
      '}',
    ].join('\n'));
    const response = await client.request(Methods.Definition, {
      textDocument: { uri: URI },
      position: at(7, 14), // on `Money` in `amount: Money`
    });
    assert.equal(response.error, undefined);
    const location = response.result as Location;
    assert.equal(location.uri, URI);
    assert.deepEqual(location.range, rangeOf(2, 5, 2, 10)); // `Money` in `type Money {`
  });
});

test('definition resolves references inside list<>, map<> and optional wrappers', async () => {
  await withClient(async (client) => {
    client.open(NAV_URI, NAV_DOC);
    const expected = rangeOf(4, 5, 4, 9); // `Item` declaration
    for (const position of [at(9, 18), at(11, 26), at(12, 14)]) {
      const response = await client.request(Methods.Definition, {
        textDocument: { uri: NAV_URI },
        position,
      });
      const location = response.result as Location;
      assert.deepEqual(location?.range, expected, `cursor ${JSON.stringify(position)} must resolve to Item`);
    }
  });
});

test('definition on a declaration name answers the declaration itself', async () => {
  await withClient(async (client) => {
    client.open(NAV_URI, NAV_DOC);
    const response = await client.request(Methods.Definition, {
      textDocument: { uri: NAV_URI },
      position: at(8, 7), // `Cart` in `type Cart {`
    });
    const location = response.result as Location;
    assert.deepEqual(location?.range, rangeOf(8, 5, 8, 9));
  });
});

test('definition on a member name answers the member itself', async () => {
  await withClient(async (client) => {
    client.open(NAV_URI, NAV_DOC);
    const response = await client.request(Methods.Definition, {
      textDocument: { uri: NAV_URI },
      position: at(9, 6), // `items` field name
    });
    const location = response.result as Location;
    assert.deepEqual(location?.range, rangeOf(9, 4, 9, 9));
  });
});

test('definition through a self-qualified reference resolves locally', async () => {
  await withClient(async (client) => {
    client.open(NAV_URI, SELF_QUALIFIED_DOC);
    // Cursor on the `T` segment of `a.v1.T` (package a.v1 === own package).
    const response = await client.request(Methods.Definition, {
      textDocument: { uri: NAV_URI },
      position: at(3, 12),
    });
    const location = response.result as Location;
    assert.deepEqual(location?.range, rangeOf(6, 5, 6, 6)); // `T` in `type T {`
  });
});

test('definition on a cross-package reference answers null even when a local type shares the name', async () => {
  await withClient(async (client) => {
    client.open(NAV_URI, NAV_DOC);
    const response = await client.request(Methods.Definition, {
      textDocument: { uri: NAV_URI },
      position: at(13, 25), // `User` segment of `identity.v1.User`
    });
    assert.equal(response.result, null, 'identity.v1.User must not resolve to the local `type User`');
  });
});

test('definition on a package segment answers null', async () => {
  await withClient(async (client) => {
    client.open(NAV_URI, NAV_DOC);
    for (const position of [at(13, 12), at(13, 21)]) { // `identity`, `v1`
      const response = await client.request(Methods.Definition, {
        textDocument: { uri: NAV_URI },
        position,
      });
      assert.equal(response.result, null, `cursor ${JSON.stringify(position)} is on a package segment`);
    }
  });
});

test('definition of an unresolved type answers null', async () => {
  await withClient(async (client) => {
    client.open(NAV_URI, 'package shop.v1\ntype Item {\n    ghost: Missing\n}\n');
    const response = await client.request(Methods.Definition, {
      textDocument: { uri: NAV_URI },
      position: at(2, 11), // `Missing`
    });
    assert.equal(response.result, null);
  });
});

test('definition answers null for keywords, whitespace, primitives and unopened documents', async () => {
  await withClient(async (client) => {
    client.open(NAV_URI, NAV_DOC);
    for (const position of [at(4, 1), at(7, 0), at(5, 11), at(0, 3)]) {
      // `type` keyword, blank line, `string` primitive, `package` keyword.
      const response = await client.request(Methods.Definition, {
        textDocument: { uri: NAV_URI },
        position,
      });
      assert.equal(response.result, null, `cursor ${JSON.stringify(position)} must not resolve`);
    }
    const unopened = await client.request(Methods.Definition, {
      textDocument: { uri: 'file:///nowhere.bridge' },
      position: at(0, 0),
    });
    assert.equal(unopened.result, null);
  });
});

test('definition is parse-based: it still works while the document has semantic errors', async () => {
  await withClient(async (client) => {
    // `money` is an unknown type (BR2001) — navigation must not care.
    client.open(URI, 'package payments.v1\ntype Money {\n    amount: money\n}\n');
    const response = await client.request(Methods.Definition, {
      textDocument: { uri: URI },
      position: at(1, 7), // `Money` in `type Money {`
    });
    const location = response.result as Location;
    assert.deepEqual(location?.range, rangeOf(1, 5, 1, 10));
  });
});

// ---------------------------------------------------------------------------
// textDocument/references
// ---------------------------------------------------------------------------

test('references finds every usage plus the declaration when requested', async () => {
  await withClient(async (client) => {
    client.open(NAV_URI, NAV_DOC);
    const response = await client.request(Methods.References, {
      textDocument: { uri: NAV_URI },
      position: at(8, 7), // `Cart` declaration name
      context: { includeDeclaration: true },
    });
    assert.equal(response.error, undefined);
    const locations = response.result as Location[];
    assert.deepEqual(
      locations.map((l) => l.range),
      [
        rangeOf(8, 5, 8, 9), // declaration
        rangeOf(21, 13, 21, 17), // Checkout(Cart)
        rangeOf(25, 10, 25, 14), // cart: Cart
        rangeOf(28, 16, 28, 20), // alias CartRef = Cart
      ],
      'locations must be in document order',
    );
    for (const location of locations) assert.equal(location.uri, NAV_URI);
  });
});

test('references omits the declaration when includeDeclaration is false', async () => {
  await withClient(async (client) => {
    client.open(NAV_URI, NAV_DOC);
    const response = await client.request(Methods.References, {
      textDocument: { uri: NAV_URI },
      position: at(8, 7),
      context: { includeDeclaration: false },
    });
    const locations = response.result as Location[];
    assert.deepEqual(
      locations.map((l) => l.range),
      [rangeOf(21, 13, 21, 17), rangeOf(25, 10, 25, 14), rangeOf(28, 16, 28, 20)],
    );
  });
});

test('references from a usage site find the same set as from the declaration', async () => {
  await withClient(async (client) => {
    client.open(NAV_URI, NAV_DOC);
    const fromDecl = (await client.request(Methods.References, {
      textDocument: { uri: NAV_URI },
      position: at(8, 7),
      context: { includeDeclaration: true },
    })).result as Location[];
    const fromUsage = (await client.request(Methods.References, {
      textDocument: { uri: NAV_URI },
      position: at(25, 12), // `Cart` in `cart: Cart`
      context: { includeDeclaration: true },
    })).result as Location[];
    assert.deepEqual(fromUsage, fromDecl);
  });
});

test('references counts self-qualified references as usages', async () => {
  await withClient(async (client) => {
    client.open(NAV_URI, SELF_QUALIFIED_DOC);
    const response = await client.request(Methods.References, {
      textDocument: { uri: NAV_URI },
      position: at(6, 5), // `T` in `type T {`
      context: { includeDeclaration: true },
    });
    const locations = response.result as Location[];
    assert.deepEqual(
      locations.map((l) => l.range),
      // Document order: the reference (line 3) precedes the declaration (line 6).
      [rangeOf(3, 12, 3, 13), rangeOf(6, 5, 6, 6)],
    );
  });
});

test('references never leaks a cross-package reference into a same-file result', async () => {
  await withClient(async (client) => {
    client.open(NAV_URI, NAV_DOC);
    const response = await client.request(Methods.References, {
      textDocument: { uri: NAV_URI },
      position: at(16, 7), // local `User` declaration
      context: { includeDeclaration: true },
    });
    const locations = response.result as Location[];
    assert.deepEqual(locations.map((l) => l.range), [rangeOf(16, 5, 16, 9)],
      'identity.v1.User belongs to another package and must not be counted');
  });
});

test('references on a member name answers only the declaration', async () => {
  await withClient(async (client) => {
    client.open(NAV_URI, NAV_DOC);
    const withDecl = (await client.request(Methods.References, {
      textDocument: { uri: NAV_URI },
      position: at(9, 6), // `items` field
      context: { includeDeclaration: true },
    })).result as Location[];
    assert.deepEqual(withDecl.map((l) => l.range), [rangeOf(9, 4, 9, 9)]);
    const withoutDecl = (await client.request(Methods.References, {
      textDocument: { uri: NAV_URI },
      position: at(9, 6),
      context: { includeDeclaration: false },
    })).result as Location[];
    assert.deepEqual(withoutDecl, []);
  });
});

test('references on an enum variant or service name answers only the declaration', async () => {
  await withClient(async (client) => {
    const doc = [
      'package payments.v1',
      '',
      'enum PaymentStatus {',
      '    PENDING',
      '}',
      '',
      'service Payments {',
      '    Charge(Payment) -> Payment',
      '}',
    ].join('\n');
    client.open(NAV_URI, doc);
    const variant = (await client.request(Methods.References, {
      textDocument: { uri: NAV_URI },
      position: at(3, 7), // PENDING
      context: { includeDeclaration: true },
    })).result as Location[];
    assert.deepEqual(variant.map((l) => l.range), [rangeOf(3, 4, 3, 11)]);

    const service = (await client.request(Methods.References, {
      textDocument: { uri: NAV_URI },
      position: at(6, 10), // Payments service name
      context: { includeDeclaration: true },
    })).result as Location[];
    assert.deepEqual(service.map((l) => l.range), [rangeOf(6, 8, 6, 16)]);
  });
});

test('references of an unresolved name group the same-named same-file references', async () => {
  await withClient(async (client) => {
    client.open(NAV_URI, 'package shop.v1\ntype Item {\n    ghost: Missing\n    more: list<Missing>\n}\n');
    const response = await client.request(Methods.References, {
      textDocument: { uri: NAV_URI },
      position: at(2, 11), // first `Missing`
      context: { includeDeclaration: true },
    });
    const locations = response.result as Location[];
    assert.deepEqual(
      locations.map((l) => l.range),
      [rangeOf(2, 11, 2, 18), rangeOf(3, 15, 3, 22)],
    );
  });
});

test('references answers [] for keywords, whitespace, primitives and unopened documents', async () => {
  await withClient(async (client) => {
    client.open(NAV_URI, NAV_DOC);
    for (const position of [at(4, 1), at(7, 0), at(5, 11)]) {
      const response = await client.request(Methods.References, {
        textDocument: { uri: NAV_URI },
        position,
        context: { includeDeclaration: true },
      });
      assert.deepEqual(response.result, [], `cursor ${JSON.stringify(position)} has no references`);
    }
    const unopened = await client.request(Methods.References, {
      textDocument: { uri: 'file:///nowhere.bridge' },
      position: at(0, 0),
      context: { includeDeclaration: true },
    });
    assert.deepEqual(unopened.result, []);
  });
});

// ---------------------------------------------------------------------------
// textDocument/prepareRename + textDocument/rename
// ---------------------------------------------------------------------------

test('prepareRename offers the declaration name of a type from its declaration', async () => {
  await withClient(async (client) => {
    client.open(NAV_URI, NAV_DOC);
    const response = await client.request(Methods.PrepareRename, {
      textDocument: { uri: NAV_URI },
      position: at(8, 7), // `Cart` in `type Cart {`
    });
    assert.equal(response.error, undefined);
    const result = response.result as { range: Range; placeholder: string };
    assert.deepEqual(result.range, rangeOf(8, 5, 8, 9));
    assert.equal(result.placeholder, 'Cart');
  });
});

test('prepareRename from a usage site offers the same target as the declaration', async () => {
  await withClient(async (client) => {
    client.open(NAV_URI, NAV_DOC);
    const fromDecl = (await client.request(Methods.PrepareRename, {
      textDocument: { uri: NAV_URI },
      position: at(8, 7),
    })).result as { range: Range; placeholder: string };
    const fromUsage = (await client.request(Methods.PrepareRename, {
      textDocument: { uri: NAV_URI },
      position: at(25, 12), // `Cart` in `cart: Cart`
    })).result as { range: Range; placeholder: string };
    assert.deepEqual(fromUsage, fromDecl);
  });
});

test('prepareRename answers null for members, services, events and non-symbols', async () => {
  await withClient(async (client) => {
    client.open(NAV_URI, NAV_DOC);
    for (const position of [at(9, 6), at(20, 10), at(30, 10), at(4, 1), at(7, 0)]) {
      // field `items`, service `Shop`, event `OrderPlaced`, `type` keyword, blank line.
      const response = await client.request(Methods.PrepareRename, {
        textDocument: { uri: NAV_URI },
        position,
      });
      assert.equal(response.result, null, `cursor ${JSON.stringify(position)} must not be renamable`);
    }
  });
});

test('rename rewrites the declaration and every same-file reference', async () => {
  await withClient(async (client) => {
    client.open(NAV_URI, NAV_DOC);
    const response = await client.request(Methods.Rename, {
      textDocument: { uri: NAV_URI },
      position: at(8, 7), // `Cart`
      newName: 'Basket',
    });
    assert.equal(response.error, undefined);
    const edit = response.result as { changes: Record<string, Array<{ range: Range; newText: string }>> };
    const edits = edit.changes[NAV_URI];
    assert.deepEqual(
      edits,
      [
        { range: rangeOf(8, 5, 8, 9), newText: 'Basket' },
        { range: rangeOf(21, 13, 21, 17), newText: 'Basket' },
        { range: rangeOf(25, 10, 25, 14), newText: 'Basket' },
        { range: rangeOf(28, 16, 28, 20), newText: 'Basket' },
      ],
      'four edits, in document order',
    );

    // Applying the edits must yield a document that still compiles — and
    // whose renamed type carries the new name end to end. Edits are applied
    // bottom-up so earlier offsets stay valid (all edits are single-line).
    const lines = NAV_DOC.split('\n');
    for (const { range, newText } of [...edits].reverse()) {
      const line = lines[range.start.line];
      assert.ok(line !== undefined, `edit line ${range.start.line} exists`);
      lines[range.start.line] =
        line.slice(0, range.start.character) +
        newText +
        line.slice(range.end.character);
    }
    const renamed = lines.join('\n');
    const result = compileSource(renamed, 'renamed.bridge');
    assert.equal(result.ok, true, `renamed document must compile: ${(result.diagnostics ?? []).map((d) => d.code).join(',')}`);
    assert.ok(result.ir?.types.some((t) => t.name === 'Basket'));
    assert.ok(!result.ir?.types.some((t) => t.name === 'Cart'));
  });
});

test('rename rejects names that are not valid Bridge identifiers', async () => {
  await withClient(async (client) => {
    client.open(NAV_URI, NAV_DOC);
    for (const newName of ['1basket', 'has space', 'type', 'a-b', '']) {
      const response = await client.request(Methods.Rename, {
        textDocument: { uri: NAV_URI },
        position: at(8, 7),
        newName,
      });
      assert.equal(response.result, undefined, `'${newName}' must be rejected`);
      assert.equal(response.error?.code, -32602); // InvalidParams
      assert.match(response.error?.message ?? '', /not a valid Bridge identifier/);
    }
  });
});

test('rename rejects a name that collides with another declaration in the document', async () => {
  await withClient(async (client) => {
    client.open(NAV_URI, NAV_DOC);
    const response = await client.request(Methods.Rename, {
      textDocument: { uri: NAV_URI },
      position: at(8, 7), // `Cart`
      newName: 'User', // already declared (line 16)
    });
    assert.equal(response.result, undefined);
    assert.equal(response.error?.code, -32602);
    assert.match(response.error?.message ?? '', /already declared/);
  });
});

test('rename answers null for members, services and non-symbol positions', async () => {
  await withClient(async (client) => {
    client.open(NAV_URI, NAV_DOC);
    for (const position of [at(9, 6), at(20, 10), at(4, 1), at(0, 3)]) {
      const response = await client.request(Methods.Rename, {
        textDocument: { uri: NAV_URI },
        position,
        newName: 'Anything',
      });
      assert.equal(response.result, null, `cursor ${JSON.stringify(position)} must not rename`);
    }
  });
});
