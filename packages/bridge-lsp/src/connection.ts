/**
 * Transport wiring: attach a `BridgeLspServer` to a byte stream pair.
 *
 * `createConnection(readable, writable, options)` is the only entry point a
 * host needs. The server reads framed JSON-RPC from `readable`, writes
 * responses and notifications to `writable`, and works with ANY duplex
 * pair — stdio in production, in-memory streams in tests.
 *
 * `exit` semantics: on the `exit` notification the connection stops and the
 * exit handler runs with the LSP-mandated code (0 after `shutdown`, 1
 * otherwise). Unrecoverable read errors — framing corruption past the header
 * cap and declared bodies above MAX_BODY_BYTES — answer with a JSON-RPC error
 * envelope, log to stderr, and run the exit handler with code 1. The default
 * handler sets `process.exitCode` and destroys the
 * readable so a stdio host terminates cleanly without truncating buffered
 * stdout — hosts (and tests) can pass their own handler.
 */

import type { Readable } from 'node:stream';
import { MessageReader, ErrorCodes, isRequest, writeMessage, type JsonRpcMessage } from './jsonrpc';
import { BridgeLspServer, SERVER_NAME, type ServerOptions } from './server';

export interface ConnectionOptions {
  /** Invoked on the `exit` notification (default: exitCode + destroy readable). */
  exit?: (code: number) => void;
  /** Map a document URI to the file path used in bridge-core diagnostics. */
  uriToPath?: (uri: string) => string;
}

export interface LspConnection {
  /** Stop reading and detach from the streams. Does not run the exit handler. */
  stop(): void;
}

export function createConnection(
  readable: Readable,
  writable: NodeJS.WritableStream,
  options: ConnectionOptions = {},
): LspConnection {
  let stopped = false;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    readable.off('data', onData);
    server.dispose();
  };

  const serverOptions: ServerOptions = {
    uriToPath: options.uriToPath,
    exit: options.exit ?? ((code: number) => {
      process.exitCode = code;
      readable.destroy(); // stdio host: ends the read loop, process drains and exits
    }),
  };

  const server = new BridgeLspServer(
    (message) => {
      if (!stopped) writeMessage(writable, message);
    },
    serverOptions,
  );

  const reader = new MessageReader(dispatch, (kind, cause) => {
    if (stopped) return;
    if (kind === 'parse') {
      // Body was not valid JSON but the framing is intact: answer with a
      // JSON-RPC Parse error (id null — the request id is unknowable).
      writeMessage(writable, {
        jsonrpc: '2.0',
        id: null,
        error: { code: ErrorCodes.ParseError, message: `Parse error: ${String(cause)}` },
      });
      return;
    }
    // 'framing' (unrecoverable framing corruption) and 'limit' (declared
    // Content-Length above MAX_BODY_BYTES) both desynchronize the stream, so
    // neither can be answered with a normal in-band recovery: report the
    // failure, stop reading, and exit nonzero. Never buffered silently.
    const code = kind === 'limit' ? ErrorCodes.InvalidRequest : ErrorCodes.ParseError;
    const label = kind === 'limit' ? 'Message limit' : 'Framing error';
    writeMessage(writable, {
      jsonrpc: '2.0',
      id: null,
      error: { code, message: `${label}: ${String(cause)}` },
    });
    process.stderr.write(`${SERVER_NAME}: ${label.toLowerCase()}: ${String(cause)} — stopping.\n`);
    stop(); // corrupt framing / rejected body cannot be recovered — stop reading
    serverOptions.exit?.(1);
  });

  function dispatch(message: JsonRpcMessage): void {
    if (stopped) return;
    if (isEnvelope(message)) {
      if (isRequest(message)) {
        server.handleRequest(message.method, message.params, message.id ?? null);
      } else {
        server.handleNotification(message.method, message.params);
      }
      return;
    }
    // Not a JSON-RPC envelope at all.
    writeMessage(writable, {
      jsonrpc: '2.0',
      id: null,
      error: { code: ErrorCodes.InvalidRequest, message: 'Invalid request: not a JSON-RPC 2.0 message.' },
    });
  }

  function onData(chunk: Buffer): void {
    reader.push(chunk);
  }

  readable.on('data', onData);
  readable.on('error', stop);

  return { stop };
}

function isEnvelope(message: JsonRpcMessage): message is JsonRpcMessage & { method: string } {
  return typeof message === 'object' && message !== null && typeof message.method === 'string';
}
