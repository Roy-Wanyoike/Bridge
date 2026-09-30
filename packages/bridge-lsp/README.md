# @bridge/lsp — Bridge IDL Language Server

A [Language Server Protocol 3.17](https://microsoft.github.io/language-server-protocol/)
implementation for the Bridge IDL. JSON-RPC over stdio with **hand-rolled
framing and zero runtime dependencies** beyond `@bridge/core` (the compiler).
No `vscode-languageserver`, no LSP framework — ~700 lines of TypeScript.

```
npm run build --workspace @bridge/lsp
npm test  --workspace @bridge/lsp   # 33 tests, driven over in-memory duplexes
```

## Running

The server binary reads LSP-framed JSON-RPC from **stdin** and writes to
**stdout**:

```
node packages/bridge-lsp/dist/bin/bridge-lsp.js
# or, if the workspace is installed/linked:
bridge-lsp
```

Quick manual check (framed `initialize` request):

```sh
node -e "
  const body = JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{capabilities:{}}});
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body);
" | node packages/bridge-lsp/dist/bin/bridge-lsp.js
```

## Editor wiring

### Neovim (lspconfig / `vim.lsp.start`)

```lua
-- ~/.config/nvim/lua/bridge-lsp.lua  (requires nvim >= 0.8)
vim.api.nvim_create_autocmd('FileType', {
  pattern = 'bridge',
  callback = function(args)
    vim.lsp.start({
      name = 'bridge-lsp',
      cmd = { 'node', vim.fn.expand('~/bridge/packages/bridge-lsp/dist/bin/bridge-lsp.js') },
      root_dir = vim.fs.root(args.file, { '.git', 'bridge.json' }),
      filetypes = { 'bridge' },
    })
  end,
})
```

Register the filetype first (`vim.filetype.add({ extension = { bridge = 'bridge' } })`).
The same server works through `nvim-lspconfig`'s custom-config mechanism by
passing the `cmd` above.

### VS Code (launch config for the server process)

VS Code needs a thin client extension to attach an arbitrary language
server (none ships in v1 — see limits). For **debugging / driving the server
directly**, add this to `.vscode/launch.json`:

```jsonc
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Bridge LSP server (stdio)",
      "type": "node",
      "request": "launch",
      "program": "${workspaceFolder}/packages/bridge-lsp/dist/bin/bridge-lsp.js",
      "cwd": "${workspaceFolder}",
      "console": "internalConsole",
      // The server speaks LSP on stdin/stdout; pipe framed JSON-RPC in via
      // the debug console or a client. Breakpoints in the server hit live.
    }
  ]
}
```

With [`vscode-languageserver-node`'s client library](https://github.com/microsoft/vscode-languageserver-node)
(or any LSP client extension such as *LSP Support*) point the client at:

```
command: node
args: ["${workspaceFolder}/packages/bridge-lsp/dist/bin/bridge-lsp.js"]
```

## Capabilities (advertised by `initialize`)

| Capability | Value | Behavior |
| --- | --- | --- |
| `textDocumentSync` | `{ openClose: true, change: 1 (Full), save: { includeText: true } }` | Whole-document sync |
| `hoverProvider` | `true` | Markdown declaration of the named type under the cursor |
| `documentFormattingProvider` | `true` | One full-document `TextEdit` from the canonical formatter |
| `documentDiagnosticProvider` | `true` | Pull mode: full report (`textDocument/diagnostic`) |
| `completionProvider` | `{ resolveProvider: false, triggerCharacters: [] }` | Keywords + primitives + document types |

Plus push diagnostics: every `didOpen` / `didChange` / `didSave` publishes
`textDocument/publishDiagnostics` computed by the real Bridge compiler
(`compileSource`), with stable codes (`BR1001`, `BR2001`, …), severities and
hints appended to the message. `didClose` publishes an empty list to clear.

## Position mapping (the subtle part) — what we found in bridge-core

**bridge-core positions are 1-based and counted in UTF-16 code units.** The
lexer (`packages/bridge-core/src/lexer.ts`) iterates the source with
`String.prototype.charAt` — UTF-16 code unit indexing — and bumps its 1-based
`column` once per unit. Verified empirically in this repo:

- `é` (U+00E9 — 2 UTF-8 bytes, **1** UTF-16 unit) inside a string shifts every
  later column on the line by exactly 1;
- `😀` (U+1F600 — 4 UTF-8 bytes, **2** UTF-16 units, a surrogate pair) shifts
  every later column by exactly 2;
- consequently an unexpected astral character produces exactly **one** `BR1001`
  unexpected-character diagnostic, at the character's start column (the lexer
  consumes whole code points; the old per-surrogate-half double report was
  fixed in issue #114).

The LSP spec defines `position.character` as a 0-based offset in **UTF-16
code units** too, so the mapping is exact in both directions:

```
LSP  line      = bridge line   - 1
LSP  character = bridge column - 1
```

UTF-8-byte counting or code-point counting would both be wrong here; the
offsets are proven by end-to-end tests with multi-byte documents in
`src/test/lsp.test.ts`. Diagnostic points are expanded to ranges honestly:
across the offending identifier when one starts there, otherwise across its
UTF-16 code unit(s).

## Architecture

| File | Role |
| --- | --- |
| `src/jsonrpc.ts` | `Content-Length` framing (byte-accurate UTF-8), incremental `MessageReader`, `writeMessage` |
| `src/protocol.ts` | The hand-rolled LSP 3.17 subset used by v1 |
| `src/positions.ts` | bridge-core ↔ LSP position mapping + word/range utilities |
| `src/render.ts` | IR → Bridge IDL text (hover markdown, completion details) |
| `src/server.ts` | `BridgeLspServer`: document store, compile, all handlers |
| `src/connection.ts` | `createConnection(readable, writable, options?)` transport wiring |
| `src/bin/bridge-lsp.ts` | stdio entry point |
| `src/test/lsp.test.ts` | 33 tests over in-memory duplexes |

`createConnection` accepts **any** duplex pair — pass `process.stdin`/`process.stdout`
in production or `PassThrough` streams in tests (the test suite does exactly
that, exercising the server precisely like an editor would).

## Honest v1 limits

- **`$/cancelNotification` is accepted and ignored.** Handlers are
  synchronous and cheap (documents compile in well under a millisecond), so
  there is nothing to cancel yet.
- **Full-sync only.** `textDocument/didChange` expects whole-document text;
  incremental range edits are ignored (the advertised `change: 1` matches).
- **Single-file scope.** Cross-package imports are not resolved: hover,
  completion and diagnostics only know the current document (plus, for
  hover/completion, the last cleanly compiled IR of that document while it
  is temporarily broken). `import`ed packages contribute nothing yet.
- **Diagnostics push on open/change/save + pull full reports** — no
  workspace-wide diagnostics, no `workspace/diagnostic/refresh` and no
  related-document reports.
- **No semantic tokens, go-to-definition, references, rename, or code
  actions.** Hover answers named types only (structs, enums, unions,
  aliases); fields, services, methods and events are not hover targets.
- **Formatting is opinionated.** Client options (`tabSize`, `insertSpaces`)
  are ignored — the canonical formatter is canonical. Documents with syntax
  errors answer `null` (no edit) rather than a best-effort format.
- **Windows paths**: `file:///C:/…` URIs are mapped best-effort; v1 targets
  POSIX hosts.
- **Astral characters**: an unexpected non-BMP character yields exactly one
  lexer diagnostic (at its start column) — the compiler consumes whole code
  points; see the position mapping section.
