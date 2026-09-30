/**
 * End-to-end tests for the Bridge language server, driven over IN-MEMORY
 * duplex streams — the server is exercised exactly as an editor would drive
 * it over stdio: LSP-framed JSON-RPC in both directions.
 *
 * Also covers, as unit tests:
 * - JSON-RPC framing (byte-accurate Content-Length, split-chunk reassembly,
 *   parse/framing error paths);
 * - the bridge-core → LSP position mapping, including multi-byte characters
 *   (UTF-16 code unit semantics — see positions.ts for the finding).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { createConnection, type LspConnection } from '../connection';
import { ErrorCodes, MessageReader, writeMessage, type JsonRpcMessage } from '../jsonrpc';
import { Methods } from '../protocol';
import {
  diagnosticRangeAt,
  fullDocumentRange,
  identifierAt,
  toBridgePosition,
  toLspPosition,
  wordPrefixAt,
} from '../positions';

// ---------------------------------------------------------------------------
// In-memory client harness: a framed JSON-RPC client talking to the server
// over two PassThrough streams.
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 5_000;

class TestClient {
  /** Client → server (the server's readable). */
  readonly toServer = new PassThrough();
  /** Server → client (the server's writable). */
  readonly fromServer = new PassThrough();
  /** Resolves with the code passed to the exit handler. */
  readonly exited: Promise<number>;

  private nextId = 1;
  private readonly pending = new Map<number, (message: JsonRpcMessage) => void>();
  private readonly queuedNotifications: Array<{ method: string; params: unknown }> = [];
  private readonly notificationWaiters: Array<{ method: string; resolve: (params: unknown) => void }> = [];
  private readonly reader: MessageReader;
  private readonly connection: LspConnection;
  private resolveExit!: (code: number) => void;

  constructor() {
    this.exited = new Promise<number>((resolve) => {
      this.resolveExit = resolve;
    });
    this.reader = new MessageReader((message) => this.accept(message));
    this.fromServer.on('data', (chunk: Buffer) => this.reader.push(chunk));
    this.connection = createConnection(this.toServer, this.fromServer, {
      exit: (code) => this.resolveExit(code),
    });
  }

  private accept(message: JsonRpcMessage): void {
    if (typeof message.method === 'string') {
      const waiter = this.notificationWaiters.findIndex((w) => w.method === message.method);
      if (waiter >= 0) {
        const found = this.notificationWaiters.splice(waiter, 1)[0];
        found?.resolve(message.params);
      } else {
        this.queuedNotifications.push({ method: message.method, params: message.params });
      }
      return;
    }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const resolve = this.pending.get(message.id as number);
      if (resolve !== undefined) {
        this.pending.delete(message.id as number);
        resolve(message);
      }
    }
  }

  request(method: string, params?: unknown): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout: no response to ${method} (id ${id}) within ${REQUEST_TIMEOUT_MS}ms`)),
        REQUEST_TIMEOUT_MS,
      );
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      writeMessage(this.toServer, { jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    writeMessage(this.toServer, { jsonrpc: '2.0', method, params });
  }

  /** Next server notification for `method`, resolving from the queue first. */
  nextNotification(method: string): Promise<Record<string, unknown>> {
    const queued = this.queuedNotifications.findIndex((n) => n.method === method);
    if (queued >= 0) {
      const found = this.queuedNotifications.splice(queued, 1)[0];
      return Promise.resolve((found?.params ?? {}) as Record<string, unknown>);
    }
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout: no ${method} notification within ${REQUEST_TIMEOUT_MS}ms`)),
        REQUEST_TIMEOUT_MS,
      );
      this.notificationWaiters.push({
        method,
        resolve: (params) => {
          clearTimeout(timer);
          resolve(params as Record<string, unknown>);
        },
      });
    });
  }

  /** How many notifications with exactly this method have arrived so far. */
  countNotifications(method: string): number {
    return this.queuedNotifications.filter((n) => n.method === method).length;
  }

  async initialize(): Promise<JsonRpcMessage> {
    const response = await this.request(Methods.Initialize, { capabilities: {} });
    this.notify(Methods.Initialized);
    return response;
  }

  open(uri: string, text: string, version = 1): void {
    this.notify(Methods.DidOpen, {
      textDocument: { uri, languageId: 'bridge', version, text },
    });
  }

  change(uri: string, text: string, version: number): void {
    this.notify(Methods.DidChange, { textDocument: { uri, version }, contentChanges: [{ text }] });
  }

  stop(): void {
    this.connection.stop();
    this.toServer.end();
    this.fromServer.end();
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GOOD_DOC = [
  'package payments.v1',
  '',
  'type Money {',
  '    amount: int64',
  '    currency: string @length(3)',
  '}',
  '',
  'enum PaymentStatus {',
  '    PENDING',
  '    COMPLETED',
  '}',
  '',
  'type Payment {',
  '    id: uuid',
  '    amount: Money',
  '}',
  '',
].join('\n');

const BROKEN_DOC = 'package payments.v1\ntype Money {\n    amount: money\n}\n';

const MESSY_DOC = 'package payments.v1\ntype Money{\namount:int64\n}\n';
const CANONICAL_DOC = 'package payments.v1\n\ntype Money {\n    amount: int64\n}\n';

const URI = 'file:///work/payments.bridge';

// ---------------------------------------------------------------------------
// JSON-RPC framing
// ---------------------------------------------------------------------------

test('writeMessage frames Content-Length in UTF-8 BYTES, not characters', () => {
  const chunks: Buffer[] = [];
  const sink = { write: (chunk: Buffer) => { chunks.push(chunk); return true; } };
  const body = { jsonrpc: '2.0' as const, method: 'x', params: { text: 'héllo 😀' } };
  writeMessage(sink, body);
  const frame = Buffer.concat(chunks);
  const header = frame.subarray(0, frame.indexOf('\r\n\r\n')).toString('ascii');
  const payload = frame.subarray(frame.indexOf('\r\n\r\n') + 4);
  const expected = JSON.stringify(body);
  assert.match(header, /^Content-Length: \d+$/);
  assert.equal(payload.toString('utf8'), expected);
  const declared = Number(header.match(/Content-Length: (\d+)/)?.[1]);
  assert.equal(declared, Buffer.byteLength(expected, 'utf8'));
  // The é (2 bytes) and 😀 (4 bytes) make the byte length strictly larger
  // than the character count — proving byte-accurate framing.
  assert.ok(declared > expected.length);
});

test('MessageReader reassembles a message split across arbitrary chunks', () => {
  const received: JsonRpcMessage[] = [];
  const reader = new MessageReader((message) => received.push(message));
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'a', params: 1 }), 'utf8');
  const frame = Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'),
    body,
  ]);
  // Split after 2, 9, 14 bytes, then the rest.
  reader.push(frame.subarray(0, 2));
  reader.push(frame.subarray(2, 9));
  reader.push(frame.subarray(9, 14));
  reader.push(frame.subarray(14));
  assert.equal(received.length, 1);
  assert.equal(received[0]?.method, 'a');
});

test('MessageReader parses two messages delivered in a single chunk', () => {
  const received: JsonRpcMessage[] = [];
  const reader = new MessageReader((message) => received.push(message));
  const frame = (params: number): Buffer => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'm', params }), 'utf8');
    return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
  };
  reader.push(Buffer.concat([frame(1), frame(2)]));
  assert.deepEqual(received.map((m) => m.params), [1, 2]);
});

test('MessageReader reports a parse error for invalid JSON and keeps the stream usable', () => {
  const received: JsonRpcMessage[] = [];
  const errors: string[] = [];
  const reader = new MessageReader(
    (message) => received.push(message),
    (kind) => errors.push(kind),
  );
  const bad = Buffer.concat([Buffer.from('Content-Length: 7\r\n\r\n', 'ascii'), Buffer.from('notjson', 'ascii')]);
  const goodBody = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'ok' }), 'utf8');
  const good = Buffer.concat([Buffer.from(`Content-Length: ${goodBody.length}\r\n\r\n`, 'ascii'), goodBody]);
  reader.push(Buffer.concat([bad, good]));
  assert.deepEqual(errors, ['parse']);
  assert.deepEqual(received.map((m) => m.method), ['ok']);
});

test('MessageReader reports a framing error when Content-Length is missing', () => {
  const errors: string[] = [];
  const reader = new MessageReader(
    () => assert.fail('must not deliver a message'),
    (kind) => errors.push(kind),
  );
  reader.push(Buffer.from('X-Nothing: 1\r\n\r\n', 'ascii'));
  assert.deepEqual(errors, ['framing']);
});

test('MessageReader rejects a DECLARED oversized body before buffering a single byte', () => {
  const received: JsonRpcMessage[] = [];
  const errors: Array<{ kind: string; cause: unknown }> = [];
  const reader = new MessageReader(
    (message) => received.push(message),
    (kind, cause) => errors.push({ kind, cause }),
  );
  // Declare a 200MB body but only write the header and a tiny tail: the
  // reader must react to the DECLARED size, not wait for the body to arrive.
  reader.push(Buffer.from('Content-Length: 209715200\r\n\r\n', 'ascii'));
  reader.push(Buffer.from('{ "jsonrpc"', 'ascii'));
  assert.equal(received.length, 0, 'no message may be delivered');
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.kind, 'limit');
  assert.match(String(errors[0]?.cause), /Content-Length 209715200 exceeds/);
  // Later bytes neither deliver a message nor re-trigger the limit — the
  // rejected frame was dropped wholesale (the connection treats the stream
  // as unrecoverable and stops; see the connection-level test below).
  reader.push(Buffer.from('trailing bytes', 'ascii'));
  assert.equal(received.length, 0);
  assert.equal(errors.length, 1);
});

// ---------------------------------------------------------------------------
// Position mapping (bridge-core ↔ LSP)
// ---------------------------------------------------------------------------

test('toLspPosition and toBridgePosition are exact inverses (1-based ↔ 0-based)', () => {
  assert.deepEqual(toLspPosition({ line: 3, column: 13 }), { line: 2, character: 12 });
  assert.deepEqual(toBridgePosition({ line: 2, character: 12 }), { line: 3, column: 13 });
  assert.deepEqual(toBridgePosition(toLspPosition({ line: 1, column: 1 })), { line: 1, column: 1 });
});

test('identifierAt finds the word at start, middle and end, and rejects non-word positions', () => {
  const line = '    amount: Money';
  const at = (character: number) => identifierAt(line, { line: 0, character });
  assert.deepEqual(at(4), { start: { line: 0, character: 4 }, end: { line: 0, character: 10 } });
  assert.deepEqual(at(7), { start: { line: 0, character: 4 }, end: { line: 0, character: 10 } });
  assert.deepEqual(at(9), { start: { line: 0, character: 4 }, end: { line: 0, character: 10 } });
  // Cursor immediately after `amount` still resolves to `amount`.
  assert.deepEqual(at(10), { start: { line: 0, character: 4 }, end: { line: 0, character: 10 } });
  assert.deepEqual(at(11), undefined); // space
  assert.deepEqual(at(12), { start: { line: 0, character: 12 }, end: { line: 0, character: 17 } });
  // Cursor just past the end of the word resolves to the word itself.
  assert.deepEqual(at(17), { start: { line: 0, character: 12 }, end: { line: 0, character: 17 } });
});

test('fullDocumentRange covers the entire document including the trailing newline', () => {
  assert.deepEqual(fullDocumentRange('a\nbb\nccc\n'), {
    start: { line: 0, character: 0 },
    end: { line: 3, character: 0 },
  });
  assert.deepEqual(fullDocumentRange('one\ntwo'), {
    start: { line: 0, character: 0 },
    end: { line: 1, character: 3 },
  });
  assert.deepEqual(fullDocumentRange(''), { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } });
});

test('diagnosticRangeAt extends across identifiers and single UTF-16 code units', () => {
  // Identifier start → the whole identifier is underlined.
  assert.deepEqual(diagnosticRangeAt('    money: int64', { line: 0, character: 4 }), {
    start: { line: 0, character: 4 },
    end: { line: 0, character: 9 },
  });
  // `é` is one UTF-16 code unit (not bytes!) → width 1.
  assert.deepEqual(diagnosticRangeAt('aé b', { line: 0, character: 1 }), {
    start: { line: 0, character: 1 },
    end: { line: 0, character: 2 },
  });
  // High half of a surrogate pair → width 2 (the lexer counts both units).
  assert.deepEqual(diagnosticRangeAt('a😀b', { line: 0, character: 1 }), {
    start: { line: 0, character: 1 },
    end: { line: 0, character: 3 },
  });
  // Line out of range (EOF diagnostics) → zero-width.
  assert.deepEqual(diagnosticRangeAt('one line', { line: 5, character: 0 }), {
    start: { line: 5, character: 0 },
    end: { line: 5, character: 0 },
  });
});

test('wordPrefixAt returns the partial identifier before the cursor', () => {
  assert.equal(wordPrefixAt('enum PaymentStatus {', { line: 0, character: 2 }), 'en');
  assert.equal(wordPrefixAt('enum PaymentStatus {', { line: 0, character: 0 }), '');
  assert.equal(wordPrefixAt('    amount: Money', { line: 0, character: 17 }), 'Money');
});

// ---------------------------------------------------------------------------
// End-to-end: server driven over in-memory duplexes
// ---------------------------------------------------------------------------

test('initialize handshake advertises the Bridge capabilities and serverInfo', async () => {
  const client = new TestClient();
  try {
    const response = await client.initialize();
    const result = response.result as {
      capabilities: Record<string, unknown>;
      serverInfo: { name: string; version: string };
    };
    assert.equal(response.error, undefined);
    assert.deepEqual(result.capabilities.textDocumentSync, {
      openClose: true,
      change: 1, // Full
      save: { includeText: true },
    });
    assert.equal(result.capabilities.hoverProvider, true);
    assert.equal(result.capabilities.documentFormattingProvider, true);
    assert.equal(result.capabilities.documentDiagnosticProvider, true);
    assert.deepEqual(result.capabilities.completionProvider, { resolveProvider: false, triggerCharacters: [] });
    assert.equal(result.serverInfo.name, 'bridge-lsp');
    assert.equal(typeof result.serverInfo.version, 'string');
  } finally {
    client.stop();
  }
});

test('requests before initialize are rejected with ServerNotInitialized', async () => {
  const client = new TestClient();
  try {
    const response = await client.request(Methods.Hover, {
      textDocument: { uri: URI },
      position: { line: 0, character: 0 },
    });
    assert.equal(response.error?.code, ErrorCodes.ServerNotInitialized);
  } finally {
    client.stop();
  }
});

test('notifications before initialize are dropped: the document never opens', async () => {
  const client = new TestClient();
  try {
    client.open(URI, GOOD_DOC); // sent before initialize — must be dropped
    await client.initialize();
    // If the pre-initialize didOpen had been processed, hovering Money would work.
    const hover = await client.request(Methods.Hover, {
      textDocument: { uri: URI },
      position: { line: 14, character: 13 },
    });
    assert.equal(hover.result, null);
  } finally {
    client.stop();
  }
});

test('diagnostics on a broken document carry code, 0-based UTF-16 range and message', async () => {
  const client = new TestClient();
  try {
    await client.initialize();
    client.open(URI, BROKEN_DOC);
    const params = await client.nextNotification(Methods.PublishDiagnostics);
    assert.equal(params.uri, URI);
    assert.equal(params.version, 1);
    const diagnostics = params.diagnostics as Array<Record<string, unknown>>;
    const unknownType = diagnostics.find((d) => d.code === 'BR2001');
    assert.ok(unknownType !== undefined, 'expected a BR2001 diagnostic');
    assert.equal(unknownType.severity, 1); // error
    assert.equal(unknownType.source, 'bridge');
    assert.ok(String(unknownType.message).includes('Unknown type `money`.'));
    const range = unknownType.range as { start: { line: number; character: number }; end: { line: number; character: number } };
    // bridge-core: line 3, column 13 (1-based UTF-16 units) → LSP (2, 12).
    assert.deepEqual(range.start, { line: 2, character: 12 });
    // The point is expanded across the offending identifier `money`.
    assert.deepEqual(range.end, { line: 2, character: 17 });
  } finally {
    client.stop();
  }
});

test('diagnostics clear when the document is fixed by didChange', async () => {
  const client = new TestClient();
  try {
    await client.initialize();
    client.open(URI, BROKEN_DOC);
    const broken = await client.nextNotification(Methods.PublishDiagnostics);
    assert.ok((broken.diagnostics as unknown[]).length > 0);

    client.change(URI, GOOD_DOC, 2);
    const fixed = await client.nextNotification(Methods.PublishDiagnostics);
    assert.equal(fixed.uri, URI);
    assert.equal(fixed.version, 2);
    assert.deepEqual(fixed.diagnostics, []);
  } finally {
    client.stop();
  }
});

test('didSave republishes diagnostics and honors includeText updates', async () => {
  const client = new TestClient();
  try {
    await client.initialize();
    client.open(URI, GOOD_DOC);
    const afterOpen = await client.nextNotification(Methods.PublishDiagnostics);
    assert.deepEqual(afterOpen.diagnostics, []);

    // Save with new (broken) text — the server replaces the text and republishes.
    client.notify(Methods.DidSave, { textDocument: { uri: URI }, text: BROKEN_DOC });
    const afterSave = await client.nextNotification(Methods.PublishDiagnostics);
    const codes = (afterSave.diagnostics as Array<Record<string, unknown>>).map((d) => d.code);
    assert.ok(codes.includes('BR2001'), `expected BR2001 after saving broken text, got ${codes.join(',')}`);

    // Save again without text: republishes the stored (broken) document.
    client.notify(Methods.DidSave, { textDocument: { uri: URI } });
    const afterSecondSave = await client.nextNotification(Methods.PublishDiagnostics);
    assert.ok((afterSecondSave.diagnostics as Array<Record<string, unknown>>).length > 0);
  } finally {
    client.stop();
  }
});

test('textDocument/diagnostic (pull) returns a full report', async () => {
  const client = new TestClient();
  try {
    await client.initialize();
    client.open(URI, BROKEN_DOC);
    await client.nextNotification(Methods.PublishDiagnostics);
    const response = await client.request(Methods.DocumentDiagnostic, { textDocument: { uri: URI } });
    const report = response.result as { kind: string; items: Array<Record<string, unknown>> };
    assert.equal(response.error, undefined);
    assert.equal(report.kind, 'full');
    assert.ok(report.items.length > 0);
    assert.ok(report.items.some((d) => d.code === 'BR2001'));
  } finally {
    client.stop();
  }
});

test('pull diagnostics for a never-opened document is an InvalidParams error, not an empty report', async () => {
  const client = new TestClient();
  try {
    await client.initialize();
    const response = await client.request(Methods.DocumentDiagnostic, {
      textDocument: { uri: 'file:///work/never-opened.bridge' },
    });
    assert.equal(response.result, undefined, 'an empty full report would masquerade as a clean document');
    assert.equal(response.error?.code, ErrorCodes.InvalidParams);
    assert.match(response.error?.message ?? '', /not open/);
  } finally {
    client.stop();
  }
});

test('hover on a known type returns markdown with the full declaration', async () => {
  const client = new TestClient();
  try {
    await client.initialize();
    client.open(URI, GOOD_DOC);
    // `amount: Money` is line 15 (0-based 14); Money spans characters 12–17.
    const response = await client.request(Methods.Hover, {
      textDocument: { uri: URI },
      position: { line: 14, character: 13 },
    });
    const hover = response.result as { contents: { kind: string; value: string }; range: Record<string, unknown> };
    assert.equal(response.error, undefined);
    assert.equal(hover.contents.kind, 'markdown');
    assert.ok(hover.contents.value.includes('```bridge'), 'markdown fenced block');
    assert.ok(hover.contents.value.includes('type Money {'));
    assert.ok(hover.contents.value.includes('amount: int64'));
    assert.ok(hover.contents.value.includes('currency: string @length(3)'));
    assert.deepEqual(hover.range, {
      start: { line: 14, character: 12 },
      end: { line: 14, character: 17 },
    });
  } finally {
    client.stop();
  }
});

test('hover on an unknown symbol, a field or off-text answers null', async () => {
  const client = new TestClient();
  try {
    await client.initialize();
    client.open(URI, GOOD_DOC);
    const fieldHover = await client.request(Methods.Hover, {
      textDocument: { uri: URI },
      position: { line: 3, character: 7 }, // `amount` (a field, not a type)
    });
    assert.equal(fieldHover.result, null);
    const whitespaceHover = await client.request(Methods.Hover, {
      textDocument: { uri: URI },
      position: { line: 1, character: 0 }, // blank line
    });
    assert.equal(whitespaceHover.result, null);
    const unknownUri = await client.request(Methods.Hover, {
      textDocument: { uri: 'file:///nowhere.bridge' },
      position: { line: 0, character: 0 },
    });
    assert.equal(unknownUri.result, null);
  } finally {
    client.stop();
  }
});

test('formatting returns one full-document TextEdit with the canonical text', async () => {
  const client = new TestClient();
  try {
    await client.initialize();
    client.open(URI, MESSY_DOC);
    const response = await client.request(Methods.Formatting, {
      textDocument: { uri: URI },
      options: { tabSize: 2, insertSpaces: true },
    });
    const edits = response.result as Array<{ range: Record<string, unknown>; newText: string }>;
    assert.equal(response.error, undefined);
    assert.equal(edits.length, 1);
    assert.deepEqual(edits[0]?.range, fullDocumentRange(MESSY_DOC));
    assert.equal(edits[0]?.newText, CANONICAL_DOC);
  } finally {
    client.stop();
  }
});

test('formatting a syntactically invalid document answers null (no edit)', async () => {
  const client = new TestClient();
  try {
    await client.initialize();
    client.open(URI, 'type Broken {');
    const response = await client.request(Methods.Formatting, {
      textDocument: { uri: URI },
      options: { tabSize: 4, insertSpaces: true },
    });
    assert.equal(response.result, null);
  } finally {
    client.stop();
  }
});

test('completion includes keywords, primitives and local named types', async () => {
  const client = new TestClient();
  try {
    await client.initialize();
    client.open(URI, GOOD_DOC);
    const response = await client.request(Methods.Completion, {
      textDocument: { uri: URI },
      position: { line: 0, character: 0 },
    });
    const items = response.result as Array<{ label: string; kind?: number; detail?: string }>;
    const labels = items.map((i) => i.label);
    // All 8 Bridge keywords.
    for (const keyword of ['package', 'import', 'type', 'enum', 'union', 'alias', 'service', 'event']) {
      assert.ok(labels.includes(keyword), `missing keyword ${keyword}`);
    }
    // Primitives.
    assert.ok(labels.includes('int32'));
    assert.ok(labels.includes('string'));
    assert.ok(labels.includes('timestamp'));
    // Named types from the current document's IR, with distinct kinds.
    const money = items.find((i) => i.label === 'Money');
    assert.equal(money?.kind, 22); // Struct
    assert.equal(money?.detail, 'struct Money');
    const status = items.find((i) => i.label === 'PaymentStatus');
    assert.equal(status?.kind, 13); // Enum
    const payment = items.find((i) => i.label === 'Payment');
    assert.equal(payment?.kind, 22);
  } finally {
    client.stop();
  }
});

test('completion filters by the typed prefix at the cursor', async () => {
  const client = new TestClient();
  try {
    await client.initialize();
    client.open(URI, GOOD_DOC);
    // Cursor after `en` of `enum` on line 8 (0-based 7) → only 'en…' items.
    const response = await client.request(Methods.Completion, {
      textDocument: { uri: URI },
      position: { line: 7, character: 2 },
    });
    const labels = (response.result as Array<{ label: string }>).map((i) => i.label);
    assert.ok(labels.length > 0);
    for (const label of labels) assert.ok(label.startsWith('en'), `${label} does not start with 'en'`);
    assert.ok(labels.includes('enum'));
    assert.ok(!labels.includes('Money'));
  } finally {
    client.stop();
  }
});

test('shutdown answers null, blocks further requests, and exit reports code 0', async () => {
  const client = new TestClient();
  try {
    await client.initialize();
    const shutdown = await client.request(Methods.Shutdown);
    assert.equal(shutdown.result, null);

    const afterShutdown = await client.request(Methods.Hover, {
      textDocument: { uri: URI },
      position: { line: 0, character: 0 },
    });
    assert.equal(afterShutdown.error?.code, ErrorCodes.InvalidRequest);

    client.notify(Methods.Exit);
    assert.equal(await client.exited, 0);
  } finally {
    client.stop();
  }
});

test('after shutdown, textDocument/* notifications are ignored: no publishDiagnostics', async () => {
  const client = new TestClient();
  try {
    await client.initialize();
    const shutdown = await client.request(Methods.Shutdown);
    assert.equal(shutdown.result, null);

    client.open(URI, BROKEN_DOC); // must be ignored, not compiled
    // Stream ordering proves the negative: a (forbidden) publishDiagnostics
    // notification would have been written BEFORE this response arrives.
    const response = await client.request(Methods.Hover, {
      textDocument: { uri: URI },
      position: { line: 0, character: 0 },
    });
    assert.equal(response.error?.code, ErrorCodes.InvalidRequest);
    assert.equal(client.countNotifications(Methods.PublishDiagnostics), 0);

    // Exit stays clean: the server still distinguishes shutdown from crash.
    client.notify(Methods.Exit);
    assert.equal(await client.exited, 0);
  } finally {
    client.stop();
  }
});

test('an oversized declared body answers InvalidRequest and stops with exit code 1', async () => {
  const client = new TestClient();
  try {
    const raw: Buffer[] = [];
    client.fromServer.on('data', (chunk: Buffer) => raw.push(chunk));
    await client.initialize();
    // Declared 200MB, actual write tiny — the connection must refuse on the
    // DECLARED size, answer with an error envelope, and stop without
    // buffering the body.
    client.toServer.write(Buffer.from('Content-Length: 209715200\r\n\r\n', 'ascii'));
    client.toServer.write(Buffer.from('{ "jsonrpc"', 'ascii'));
    assert.equal(await client.exited, 1);
    const text = Buffer.concat(raw).toString('utf8');
    assert.match(text, /"code":-32600/);
    assert.match(text, /Content-Length 209715200 exceeds/);
  } finally {
    client.stop();
  }
});

test('garbage past the 32 KiB header cap answers ParseError, logs to stderr, exits 1', async () => {
  const realStderrWrite = process.stderr.write.bind(process.stderr);
  const stderrSeen: string[] = [];
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    stderrSeen.push(String(chunk));
    return (realStderrWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  const client = new TestClient();
  try {
    const raw: Buffer[] = [];
    client.fromServer.on('data', (chunk: Buffer) => raw.push(chunk));
    await client.initialize();
    client.toServer.write(Buffer.alloc(40 * 1024, 0x41)); // 40 KiB, no header terminator
    assert.equal(await client.exited, 1);
    const text = Buffer.concat(raw).toString('utf8');
    assert.match(text, /"code":-32700/);
    assert.match(text, /Framing error/);
    assert.ok(
      stderrSeen.some((line) => line.includes('Framing error') || line.includes('stopping')),
      `expected a stderr log line, got ${JSON.stringify(stderrSeen)}`,
    );
  } finally {
    process.stderr.write = realStderrWrite;
    client.stop();
  }
});

test('exit without shutdown reports code 1 (LSP-mandated)', async () => {
  const client = new TestClient();
  try {
    await client.initialize();
    client.notify(Methods.Exit);
    assert.equal(await client.exited, 1);
  } finally {
    client.stop();
  }
});

test('$/cancelNotification is accepted and ignored — the server stays responsive', async () => {
  const client = new TestClient();
  try {
    client.notify(Methods.Cancel, { id: 999 });
    const response = await client.request(Methods.Initialize, { capabilities: {} });
    assert.equal(response.error, undefined);
    assert.ok(response.result !== undefined);
  } finally {
    client.stop();
  }
});

test('didClose publishes empty diagnostics and drops the document', async () => {
  const client = new TestClient();
  try {
    await client.initialize();
    client.open(URI, BROKEN_DOC);
    const broken = await client.nextNotification(Methods.PublishDiagnostics);
    assert.ok((broken.diagnostics as unknown[]).length > 0);

    client.notify(Methods.DidClose, { textDocument: { uri: URI } });
    const cleared = await client.nextNotification(Methods.PublishDiagnostics);
    assert.equal(cleared.uri, URI);
    assert.deepEqual(cleared.diagnostics, []);
    assert.equal(cleared.version, undefined);
  } finally {
    client.stop();
  }
});

test('unknown request methods answer MethodNotFound', async () => {
  const client = new TestClient();
  try {
    await client.initialize();
    const response = await client.request(Methods.Hover + '/nope');
    assert.equal(response.error?.code, ErrorCodes.MethodNotFound);
  } finally {
    client.stop();
  }
});

test('an unknown notification is silently ignored', async () => {
  const client = new TestClient();
  try {
    await client.initialize();
    client.notify('workspace/didChangeConfiguration', { settings: {} });
    // The server is still alive and answers requests.
    const response = await client.request(Methods.Shutdown);
    assert.equal(response.result, null);
  } finally {
    client.stop();
  }
});

// ---------------------------------------------------------------------------
// UTF-16 column mapping over the wire (multi-byte characters)
// ---------------------------------------------------------------------------

test('a BMP multi-byte char shifts columns by exactly ONE UTF-16 unit (é)', async () => {
  const client = new TestClient();
  try {
    await client.initialize();
    //                                    col: 1111111111222222222233 4
    //                                         1234567890123456789012 3456
    const text = 'package p.v1\ntype T {\n    g: string = "h\u00e9llo" \u20ac\n}\n';
    client.open(URI, text);
    const params = await client.nextNotification(Methods.PublishDiagnostics);
    const unexpected = (params.diagnostics as Array<Record<string, unknown>>).find((d) => d.code === 'BR1001');
    assert.ok(unexpected !== undefined, 'expected a BR1001 diagnostic');
    const range = unexpected.range as { start: { line: number; character: number }; end: { line: number; character: number } };
    // bridge-core reports line 3, column 25 (verified against the lexer):
    // the é inside the string counts as ONE UTF-16 code unit, so `€` sits
    // at 0-based character 24. UTF-8-BYTE counting would claim 25.
    assert.deepEqual(range.start, { line: 2, character: 24 });
    assert.deepEqual(range.end, { line: 2, character: 25 });
  } finally {
    client.stop();
  }
});

test('a non-BMP emoji shifts columns by exactly TWO UTF-16 units (surrogate pair)', async () => {
  const client = new TestClient();
  try {
    await client.initialize();
    // The 😀 inside the string is one code point but TWO UTF-16 code units,
    // so `€` lands at bridge column 24 → LSP character 23. Code-point
    // counting would claim 22; UTF-8-byte counting would claim 26.
    const text = 'package p.v1\ntype T {\n    g: string = "hi\ud83d\ude00" \u20ac\n}\n';
    client.open(URI, text);
    const params = await client.nextNotification(Methods.PublishDiagnostics);
    const unexpected = (params.diagnostics as Array<Record<string, unknown>>).find((d) => d.code === 'BR1001');
    assert.ok(unexpected !== undefined, 'expected a BR1001 diagnostic');
    assert.deepEqual((unexpected.range as { start: { line: number; character: number } }).start, {
      line: 2,
      character: 23,
    });
  } finally {
    client.stop();
  }
});

test('an emoji where an identifier is expected yields TWO per-unit diagnostics', async () => {
  const client = new TestClient();
  try {
    await client.initialize();
    // Documented bridge-core behavior: the lexer walks UTF-16 code units, so
    // `😀` between `M` and `X` produces two BR1001 diagnostics — one per
    // surrogate half — at LSP characters 6 and 7 of line 1 (bridge columns
    // 7 and 8).
    const text = 'package p.v1\ntype M\ud83d\ude00X struct {\n    a: int64\n}\n';
    client.open(URI, text);
    const params = await client.nextNotification(Methods.PublishDiagnostics);
    const halves = (params.diagnostics as Array<Record<string, unknown>>)
      .filter((d) => d.code === 'BR1001')
      .map((d) => (d.range as { start: { line: number; character: number } }).start);
    assert.deepEqual(halves, [
      { line: 1, character: 6 },
      { line: 1, character: 7 },
    ]);
  } finally {
    client.stop();
  }
});

test('ASCII control case: the same fixture without multi-byte chars maps as usual', async () => {
  const client = new TestClient();
  try {
    await client.initialize();
    const text = 'package p.v1\ntype T {\n    g: string = "hi" \u20ac\n}\n';
    client.open(URI, text);
    const params = await client.nextNotification(Methods.PublishDiagnostics);
    const unexpected = (params.diagnostics as Array<Record<string, unknown>>).find((d) => d.code === 'BR1001');
    assert.ok(unexpected !== undefined, 'expected a BR1001 diagnostic');
    // bridge-core: line 3, column 22 → LSP (2, 21).
    assert.deepEqual((unexpected.range as { start: { line: number; character: number } }).start, {
      line: 2,
      character: 21,
    });
  } finally {
    client.stop();
  }
});
