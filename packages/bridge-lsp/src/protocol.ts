/**
 * The slice of the Language Server Protocol (3.17) this server implements,
 * hand-rolled as TypeScript interfaces — no `vscode-languageserver`
 * dependency. Only the shapes v1 actually uses are modeled; anything the
 * server does not need stays untyped `unknown` at the boundary.
 */

// ------------------------------------------------------------------ basics

export interface Position {
  /** 0-based line. */
  line: number;
  /** 0-based offset in UTF-16 code units. */
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface TextDocumentIdentifier {
  uri: string;
}

export interface VersionedTextDocumentIdentifier extends TextDocumentIdentifier {
  version: number;
}

export interface TextDocumentItem extends TextDocumentIdentifier {
  /** The language id, e.g. `bridge`. Not interpreted by this server. */
  languageId: string;
  version: number;
  text: string;
}

// ---------------------------------------------------------------- lifecycle

export const TextDocumentSyncKind = {
  None: 0,
  Full: 1,
  Incremental: 2,
} as const;

export interface ServerCapabilities {
  textDocumentSync: {
    openClose: boolean;
    change: typeof TextDocumentSyncKind.Full;
    save?: { includeText?: boolean };
  };
  hoverProvider: boolean;
  documentFormattingProvider: boolean;
  documentDiagnosticProvider: boolean;
  completionProvider: {
    resolveProvider: boolean;
    triggerCharacters: string[];
  };
  definitionProvider: boolean;
  referencesProvider: boolean;
  documentSymbolProvider: boolean;
  /** `prepareProvider` — the server answers `textDocument/prepareRename` first. */
  renameProvider: { prepareProvider: boolean };
}

export interface InitializeResult {
  capabilities: ServerCapabilities;
  serverInfo: { name: string; version: string };
}

// -------------------------------------------------------------- diagnostics

export const DiagnosticSeverity = {
  Error: 1,
  Warning: 2,
  Information: 3,
  Hint: 4,
} as const;

export interface LspDiagnostic {
  range: Range;
  /** 1 = error, 2 = warning, 3 = information. */
  severity?: number;
  /** Stable Bridge code, e.g. `BR2001`. */
  code?: string;
  source?: string;
  message: string;
}

export interface PublishDiagnosticsParams {
  uri: string;
  version?: number;
  diagnostics: LspDiagnostic[];
}

/**
 * `textDocument/diagnostic` (pull diagnostics): this server only supports
 * the full-report mode — no related documents, no unchanged deltas.
 */
export interface DocumentDiagnosticReport {
  kind: 'full';
  items: LspDiagnostic[];
}

// -------------------------------------------------------------------- hover

export interface MarkupContent {
  kind: 'markdown' | 'plaintext';
  value: string;
}

export interface HoverParams {
  textDocument: TextDocumentIdentifier;
  position: Position;
}

export interface Hover {
  contents: MarkupContent;
  range?: Range;
}

// --------------------------------------------------------------- formatting

export interface DocumentFormattingParams {
  textDocument: TextDocumentIdentifier;
  /** Formatting options (`tabSize`, `insertSpaces`, …) — the canonical
   *  Bridge formatter is opinionated and does not honor these. */
  options: unknown;
}

export interface TextEdit {
  range: Range;
  newText: string;
}

// --------------------------------------------------------------- completion

export const CompletionItemKind = {
  Text: 1,
  Method: 2,
  Function: 3,
  Constructor: 4,
  Field: 5,
  Variable: 6,
  Class: 7,
  Interface: 8,
  Module: 9,
  Property: 10,
  Unit: 11,
  Value: 12,
  Enum: 13,
  Keyword: 14,
  Snippet: 15,
  Color: 16,
  File: 17,
  Reference: 18,
  Folder: 19,
  EnumMember: 20,
  Constant: 21,
  Struct: 22,
  Event: 23,
  Operator: 24,
  TypeParameter: 25,
} as const;

export interface CompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | MarkupContent;
  insertText?: string;
}

export interface CompletionParams {
  textDocument: TextDocumentIdentifier;
  position: Position;
}

// ------------------------------------------------- navigation + rename

/** A location in a document — the answer shape of definition/references. */
export interface Location {
  uri: string;
  range: Range;
}

/** `SymbolKind` values (LSP 3.17) used by `textDocument/documentSymbol`. */
export const SymbolKind = {
  File: 1,
  Module: 2,
  Namespace: 3,
  Package: 4,
  Class: 5,
  Method: 6,
  Property: 7,
  Field: 8,
  Constructor: 9,
  Enum: 10,
  Interface: 11,
  Function: 12,
  Variable: 13,
  Constant: 14,
  String: 15,
  Number: 16,
  Boolean: 17,
  Array: 18,
  Object: 19,
  Key: 20,
  Null: 21,
  EnumMember: 22,
  Struct: 23,
  Event: 24,
  Operator: 25,
  TypeParameter: 26,
} as const;

/**
 * Hierarchical document symbol (`textDocument/documentSymbol`). `range`
 * encloses the whole declaration, `selectionRange` covers the name — the
 * range an editor reveals when the symbol is picked from the outline.
 */
export interface DocumentSymbol {
  name: string;
  detail?: string;
  kind: number; // SymbolKind
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}

/** `context` of `textDocument/references` (LSP 3.17 — required, but the
 *  server is lenient and treats a missing context as `false`). */
export interface ReferenceContext {
  includeDeclaration: boolean;
}

/** First phase of a rename: is the symbol renamable, and where is its name? */
export interface PrepareRenameResult {
  /** Range of the symbol name the rename would replace. */
  range: Range;
  placeholder: string;
}

/** A workspace-scoped edit; this server only ever touches one document. */
export interface WorkspaceEdit {
  changes: Record<string, TextEdit[]>;
}

// ------------------------------------------------------------ method names

/** Every LSP method name this server sends or handles. */
export const Methods = {
  Initialize: 'initialize',
  Initialized: 'initialized',
  Shutdown: 'shutdown',
  Exit: 'exit',
  /** Accepted and IGNORED for v1 (see README — cancellations are not acted on). */
  Cancel: '$/cancelNotification',
  PublishDiagnostics: 'textDocument/publishDiagnostics',
  DidOpen: 'textDocument/didOpen',
  DidChange: 'textDocument/didChange',
  DidSave: 'textDocument/didSave',
  DidClose: 'textDocument/didClose',
  Hover: 'textDocument/hover',
  Formatting: 'textDocument/formatting',
  Completion: 'textDocument/completion',
  DocumentDiagnostic: 'textDocument/diagnostic',
  Definition: 'textDocument/definition',
  References: 'textDocument/references',
  DocumentSymbol: 'textDocument/documentSymbol',
  PrepareRename: 'textDocument/prepareRename',
  Rename: 'textDocument/rename',
} as const;
