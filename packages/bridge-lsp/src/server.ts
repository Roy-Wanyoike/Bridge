/**
 * The Bridge language server: state + message handling, transport-agnostic.
 *
 * `BridgeLspServer` owns the open-document store and answers JSON-RPC
 * requests/notifications. It never touches streams directly — a single
 * `send` callback delivers outgoing messages, which keeps the logic fully
 * testable over in-memory transports (see connection.ts for the stdio
 * wiring and src/test for the duplex harness).
 *
 * Lifecycle (LSP 3.17):
 * - `initialize` → capabilities response; requests before it are answered
 *   with `ServerNotInitialized`, notifications before it are dropped.
 * - `initialized` → no-op.
 * - `shutdown` → `null` result; further requests get `InvalidRequest`.
 * - `exit` → invokes the exit handler with 0 after `shutdown`, 1 otherwise.
 * - `$/cancelNotification` and other `$/…` notifications are accepted and
 *   ignored (v1: requests are synchronous and not cancellable).
 */

import {
  compileSource,
  formatSource,
  KEYWORDS,
  PRIMITIVES,
  type CompileResult,
  type Diagnostic,
  type IRPackage,
} from '@bridge/core';
import {
  CompletionItemKind,
  DiagnosticSeverity,
  Methods,
  TextDocumentSyncKind,
  type DocumentDiagnosticReport,
  type Hover,
  type CompletionItem,
  type InitializeResult,
  type LspDiagnostic,
  type PublishDiagnosticsParams,
  type TextEdit,
} from './protocol';
import {
  diagnosticRangeAt,
  fullDocumentRange,
  identifierAt,
  toLspPosition,
  wordPrefixAt,
} from './positions';
import { typeDeclToText } from './render';
import { ErrorCodes, type JsonRpcErrorBody, type JsonRpcMessage } from './jsonrpc';

export const SERVER_NAME = 'bridge-lsp';
export const SERVER_VERSION = '0.2.1';

/** Options a host may customize when embedding the server. */
export interface ServerOptions {
  /** Map a document URI to the `file` path used in bridge-core diagnostics. */
  uriToPath?: (uri: string) => string;
  /** Invoked on the `exit` notification. Not invoked on `stop()`. */
  exit?: (code: number) => void;
}

/** Outgoing-message sink (a notification or response envelope). */
export type MessageSink = (message: JsonRpcMessage) => void;

interface OpenDocument {
  uri: string;
  text: string;
  version: number | undefined;
}

/**
 * Default `file://` URI → filesystem path mapping. Non-URI strings pass
 * through unchanged so tests can use plain paths. Windows drive URIs are
 * handled (`file:///C:/x` → `C:/x`) although v1 targets POSIX hosts.
 */
export function defaultUriToPath(uri: string): string {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol === 'file:') {
      let path = decodeURIComponent(parsed.pathname);
      if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
      return path;
    }
  } catch {
    // not an absolute URI — treat as an opaque path
  }
  return uri;
}

export class BridgeLspServer {
  private readonly documents = new Map<string, OpenDocument>();
  /** Last successfully compiled IR per URI — powers hover/completion while a document is broken. */
  private readonly lastGoodIr = new Map<string, IRPackage>();
  private initialized = false;
  private shutdownRequested = false;
  private disposed = false;

  constructor(
    private readonly send: MessageSink,
    private readonly options: ServerOptions = {},
  ) {}

  // ------------------------------------------------------------- dispatch

  handleRequest(method: string, params: unknown, id: number | string | null): void {
    if (this.disposed) return;
    try {
      this.dispatchRequest(method, params, id);
    } catch (cause) {
      this.respondError(id, ErrorCodes.InternalError, internalMessage(cause));
    }
  }

  handleNotification(method: string, params: unknown): void {
    if (this.disposed) return;
    try {
      this.dispatchNotification(method, params);
    } catch (cause) {
      // Per JSON-RPC, notifications never produce error responses; the
      // failure is surfaced on stderr so hosts can diagnose it.
      process.stderr.write(`${SERVER_NAME}: unhandled notification error in ${method}: ${internalMessage(cause)}\n`);
    }
  }

  /** Drop all state. Does NOT invoke the exit handler. */
  dispose(): void {
    this.disposed = true;
    this.documents.clear();
    this.lastGoodIr.clear();
  }

  private dispatchRequest(method: string, params: unknown, id: number | string | null): void {
    if (method === Methods.Initialize) {
      if (this.initialized) {
        return this.respondError(id, ErrorCodes.InvalidRequest, 'The server is already initialized.');
      }
      this.initialized = true;
      return this.respond(id, initializeResult());
    }

    if (!this.initialized) {
      return this.respondError(id, ErrorCodes.ServerNotInitialized, 'Server not initialized — send `initialize` first.');
    }
    if (this.shutdownRequested) {
      return this.respondError(id, ErrorCodes.InvalidRequest, 'Invalid request — the server is shutting down.');
    }

    switch (method) {
      case Methods.Shutdown:
        this.shutdownRequested = true;
        return this.respond(id, null);
      case Methods.Hover:
        return this.hover(id, params);
      case Methods.Formatting:
        return this.formatting(id, params);
      case Methods.Completion:
        return this.completion(id, params);
      case Methods.DocumentDiagnostic:
        return this.pullDiagnostics(id, params);
      default:
        return this.respondError(id, ErrorCodes.MethodNotFound, `Method not found: ${method}`);
    }
  }

  private dispatchNotification(method: string, params: unknown): void {
    if (method === Methods.Exit) {
      const code = this.shutdownRequested ? 0 : 1;
      this.dispose();
      this.options.exit?.(code);
      return;
    }
    if (method === Methods.Initialized) return; // no dynamic registrations in v1
    if (method.startsWith('$/')) return; // optional notifications ($/cancelNotification, $/setTrace, …) are ignored
    if (!this.initialized) return; // drop notifications before `initialize`, per spec

    switch (method) {
      case Methods.DidOpen:
        this.didOpen(params);
        return;
      case Methods.DidChange:
        this.didChange(params);
        return;
      case Methods.DidSave:
        this.didSave(params);
        return;
      case Methods.DidClose:
        this.didClose(params);
        return;
      default:
        return; // unknown notifications are ignored, per spec
    }
  }

  // ------------------------------------------------------------ responses

  private respond(id: number | string | null, result: unknown): void {
    this.send({ jsonrpc: '2.0', id, result });
  }

  private respondError(id: number | string | null, code: number, message: string, data?: unknown): void {
    const error: JsonRpcErrorBody = { code, message };
    if (data !== undefined) error.data = data;
    this.send({ jsonrpc: '2.0', id, error });
  }

  private sendNotification(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  // ------------------------------------------------------------ documents

  private didOpen(params: unknown): void {
    const parsed = didOpenParams(params);
    if (parsed === undefined) return;
    this.documents.set(parsed.textDocument.uri, {
      uri: parsed.textDocument.uri,
      text: parsed.textDocument.text,
      version: parsed.textDocument.version,
    });
    this.publishDiagnostics(parsed.textDocument.uri);
  }

  private didChange(params: unknown): void {
    const parsed = didChangeParams(params);
    if (parsed === undefined) return;
    const { textDocument, text } = parsed;
    if (text === undefined) return; // incremental ranges are not supported (v1 = full sync only)
    const existing = this.documents.get(textDocument.uri);
    this.documents.set(textDocument.uri, {
      uri: textDocument.uri,
      text,
      version: textDocument.version ?? existing?.version,
    });
    this.publishDiagnostics(textDocument.uri);
  }

  private didSave(params: unknown): void {
    const parsed = didSaveParams(params);
    if (parsed === undefined) return;
    const doc = this.documents.get(parsed.textDocument.uri);
    if (doc === undefined) return;
    if (typeof parsed.text === 'string' && parsed.text !== doc.text) {
      doc.text = parsed.text;
    }
    this.publishDiagnostics(doc.uri);
  }

  private didClose(params: unknown): void {
    const parsed = didCloseParams(params);
    if (parsed === undefined) return;
    const uri = parsed.textDocument.uri;
    this.documents.delete(uri);
    this.lastGoodIr.delete(uri);
    // Clear any diagnostics the editor is still showing for this document.
    this.sendNotification(Methods.PublishDiagnostics, { uri, diagnostics: [] } satisfies PublishDiagnosticsParams);
  }

  // ---------------------------------------------------------------- hover

  /**
   * `textDocument/hover`: when the cursor is on an identifier that names a
   * type declared in the document (or named in the last clean IR), answer
   * with a markdown block showing the full declaration. Anything else —
   * unknown symbols, fields, keywords, no document — answers `null`.
   */
  private hover(id: number | string | null, params: unknown): void {
    const parsed = hoverParams(params);
    if (parsed === undefined) {
      return this.respondError(id, ErrorCodes.InvalidParams, 'Invalid params: expected { textDocument: { uri }, position }.');
    }
    const uri = parsed.textDocument.uri;
    const doc = this.documents.get(uri);
    if (doc === undefined) return this.respond(id, null);

    const range = identifierAt(doc.text, parsed.position);
    if (range === undefined) return this.respond(id, null);

    const word = doc.text
      .split('\n')[range.start.line]
      ?.slice(range.start.character, range.end.character);
    if (word === undefined || word === '') return this.respond(id, null);

    // Compile the CURRENT text; while it is broken, fall back to the last
    // clean IR so hover keeps working across an editing mistake.
    this.compile(uri, doc.text);
    const ir = this.lastGoodIr.get(uri);
    const definition = ir?.types.find((t) => t.name === word);
    if (definition === undefined) return this.respond(id, null);

    const hover: Hover = {
      contents: { kind: 'markdown', value: hoverMarkdown(definition) },
      range,
    };
    this.respond(id, hover);
  }

  // ------------------------------------------------------------ formatting

  /**
   * `textDocument/formatting`: run the canonical Bridge formatter over the
   * whole document and answer with ONE TextEdit replacing the entire text
   * (the formatter is opinionated — client options like `tabSize` are not
   * honored). Documents with syntax errors answer `null` (no edit).
   */
  private formatting(id: number | string | null, params: unknown): void {
    const parsed = documentIdentifierParams(params);
    if (parsed === undefined) {
      return this.respondError(id, ErrorCodes.InvalidParams, 'Invalid params: expected { textDocument: { uri } }.');
    }
    const doc = this.documents.get(parsed.textDocument.uri);
    if (doc === undefined) return this.respond(id, null);

    const toPath = this.options.uriToPath ?? defaultUriToPath;
    const result = formatSource(doc.text, toPath(doc.uri));
    if (!result.ok || result.output === undefined) return this.respond(id, null);

    const edit: TextEdit = {
      range: fullDocumentRange(doc.text),
      newText: result.output,
    };
    this.respond(id, [edit]);
  }

  // ------------------------------------------------------------ completion

  /**
   * `textDocument/completion`: Bridge keywords + primitive types + the
   * named types declared in the current document's IR (from the last clean
   * compile while the text is broken). No trigger characters in v1; items
   * are filtered by the typed prefix. Returns a plain `CompletionItem[]`.
   */
  private completion(id: number | string | null, params: unknown): void {
    const parsed = hoverParams(params);
    if (parsed === undefined) {
      return this.respondError(id, ErrorCodes.InvalidParams, 'Invalid params: expected { textDocument: { uri }, position }.');
    }
    const uri = parsed.textDocument.uri;
    const doc = this.documents.get(uri);
    if (doc === undefined) return this.respond(id, []);

    const prefix = wordPrefixAt(doc.text, parsed.position);
    const startsWithPrefix = (label: string): boolean => label.startsWith(prefix);

    const items: CompletionItem[] = [];
    for (const keyword of KEYWORDS) {
      if (startsWithPrefix(keyword)) {
        items.push({ label: keyword, kind: CompletionItemKind.Keyword, detail: 'Bridge keyword', insertText: keyword });
      }
    }
    for (const primitive of PRIMITIVES) {
      if (startsWithPrefix(primitive)) {
        items.push({ label: primitive, kind: CompletionItemKind.Class, detail: 'Bridge primitive type', insertText: primitive });
      }
    }

    // Named types from the current document (last clean IR while broken).
    this.compile(uri, doc.text);
    const ir = this.lastGoodIr.get(uri);
    for (const definition of ir?.types ?? []) {
      if (!startsWithPrefix(definition.name)) continue;
      const item: CompletionItem = {
        label: definition.name,
        kind: completionKind(definition),
        detail: `${definition.kind} ${definition.name}`,
      };
      if (definition.docs !== undefined) item.documentation = definition.docs;
      items.push(item);
    }

    this.respond(id, items);
  }

  // ---------------------------------------------------------- diagnostics

  /**
   * Compile the current document text and PUSH an publish-diagnostics
   * notification. Runs on didOpen, didChange and didSave.
   */
  private publishDiagnostics(uri: string): void {
    const doc = this.documents.get(uri);
    if (doc === undefined) return;
    const result = this.compile(doc.uri, doc.text);
    const params: PublishDiagnosticsParams = {
      uri,
      diagnostics: result.diagnostics.map((d) => toLspDiagnostic(doc.text, d)),
    };
    if (doc.version !== undefined) params.version = doc.version;
    this.sendNotification(Methods.PublishDiagnostics, params);
  }

  /** Pull diagnostics (`textDocument/diagnostic`) — full report mode. */
  private pullDiagnostics(id: number | string | null, params: unknown): void {
    const parsed = documentIdentifierParams(params);
    if (parsed === undefined) {
      return this.respondError(id, ErrorCodes.InvalidParams, 'Invalid params: expected { textDocument: { uri } }.');
    }
    const doc = this.documents.get(parsed.textDocument.uri);
    const result = doc === undefined ? undefined : this.compile(doc.uri, doc.text);
    const items = result === undefined ? [] : result.diagnostics.map((d) => toLspDiagnostic(doc?.text ?? '', d));
    const report: DocumentDiagnosticReport = { kind: 'full', items };
    this.respond(id, report);
  }

  /** Compile one document, remembering the IR of the last clean compile. */
  private compile(uri: string, text: string): CompileResult {
    const toPath = this.options.uriToPath ?? defaultUriToPath;
    const result = compileSource(text, toPath(uri));
    if (result.ok && result.ir !== undefined) this.lastGoodIr.set(uri, result.ir);
    return result;
  }
}

// ------------------------------------------------------------- initialize

function initializeResult(): InitializeResult {
  return {
    capabilities: {
      textDocumentSync: {
        openClose: true,
        change: TextDocumentSyncKind.Full,
        save: { includeText: true },
      },
      hoverProvider: true,
      documentFormattingProvider: true,
      documentDiagnosticProvider: true,
      completionProvider: {
        resolveProvider: false,
        triggerCharacters: [], // no trigger characters in v1
      },
    },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
  };
}

// ---------------------------------------------------- diagnostic mapping

/**
 * bridge-core `Diagnostic` → LSP `Diagnostic`.
 *
 * Position mapping is the exact UTF-16-aware offset described in
 * positions.ts: `line - 1`, `column - 1`. The point is expanded to a
 * range covering the offending token where the text makes that possible.
 * A diagnostic `hint` is appended to the message (LSP has no hint field),
 * separated by a blank line.
 */
export function toLspDiagnostic(text: string, diagnostic: Diagnostic): LspDiagnostic {
  const start = toLspPosition(diagnostic);
  return {
    range: diagnosticRangeAt(text, start),
    severity:
      diagnostic.severity === 'error'
        ? DiagnosticSeverity.Error
        : diagnostic.severity === 'warning'
          ? DiagnosticSeverity.Warning
          : DiagnosticSeverity.Information,
    code: diagnostic.code,
    source: 'bridge',
    message: diagnostic.hint === undefined ? diagnostic.message : `${diagnostic.message}\n\n${diagnostic.hint}`,
  };
}

// -------------------------------------------------------- param coercion

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function textDocumentOf(params: Record<string, unknown>): { uri: string } | undefined {
  const doc = params.textDocument;
  if (!isRecord(doc) || typeof doc.uri !== 'string') return undefined;
  return { uri: doc.uri };
}

function documentIdentifierParams(params: unknown): { textDocument: { uri: string } } | undefined {
  if (!isRecord(params)) return undefined;
  const doc = textDocumentOf(params);
  return doc === undefined ? undefined : { textDocument: doc };
}

function didOpenParams(params: unknown): {
  textDocument: { uri: string; languageId: string; version: number; text: string };
} | undefined {
  if (!isRecord(params)) return undefined;
  const doc = params.textDocument;
  if (!isRecord(doc) || typeof doc.uri !== 'string' || typeof doc.text !== 'string') return undefined;
  return {
    textDocument: {
      uri: doc.uri,
      languageId: typeof doc.languageId === 'string' ? doc.languageId : 'bridge',
      version: typeof doc.version === 'number' ? doc.version : 0,
      text: doc.text,
    },
  };
}

function didChangeParams(params: unknown): {
  textDocument: { uri: string; version: number | undefined };
  text: string | undefined;
} | undefined {
  if (!isRecord(params)) return undefined;
  const doc = params.textDocument;
  if (!isRecord(doc) || typeof doc.uri !== 'string') return undefined;
  const changes = params.contentChanges;
  if (!Array.isArray(changes) || changes.length === 0) return undefined;
  // Full sync: the spec guarantees a single whole-text change; if a client
  // still sends several, the last one wins.
  const last = changes[changes.length - 1];
  if (!isRecord(last) || typeof last.text !== 'string') return undefined;
  return {
    textDocument: {
      uri: doc.uri,
      version: typeof doc.version === 'number' ? doc.version : undefined,
    },
    text: last.text,
  };
}

function didSaveParams(params: unknown): { textDocument: { uri: string }; text?: string } | undefined {
  if (!isRecord(params)) return undefined;
  const doc = textDocumentOf(params);
  if (doc === undefined) return undefined;
  return typeof params.text === 'string' ? { textDocument: doc, text: params.text } : { textDocument: doc };
}

function didCloseParams(params: unknown): { textDocument: { uri: string } } | undefined {
  return documentIdentifierParams(params);
}

function hoverParams(params: unknown): {
  textDocument: { uri: string };
  position: { line: number; character: number };
} | undefined {
  if (!isRecord(params)) return undefined;
  const doc = textDocumentOf(params);
  const position = params.position;
  if (doc === undefined || !isRecord(position)) return undefined;
  if (typeof position.line !== 'number' || typeof position.character !== 'number') return undefined;
  return { textDocument: doc, position: { line: position.line, character: position.character } };
}

/** Markdown payload for a hover: docs blockquote + ```bridge declaration. */
function hoverMarkdown(definition: import('@bridge/core').IRTypeDefinition): string {
  const parts: string[] = [];
  if (definition.docs !== undefined) {
    for (const line of definition.docs.split('\n')) {
      parts.push(line.length > 0 ? `> ${line}` : '>');
    }
    parts.push('');
  }
  parts.push('```bridge', typeDeclToText(definition), '```');
  if (definition.deprecated !== undefined) {
    parts.push('', definition.deprecated === true ? '*deprecated*' : `*deprecated: ${definition.deprecated}*`);
  }
  return parts.join('\n');
}

function internalMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** LSP CompletionItemKind for an IR type definition. */
function completionKind(definition: import('@bridge/core').IRTypeDefinition): number {
  switch (definition.kind) {
    case 'struct':
      return CompletionItemKind.Struct;
    case 'enum':
      return CompletionItemKind.Enum;
    default:
      return CompletionItemKind.Class; // unions and aliases
  }
}
