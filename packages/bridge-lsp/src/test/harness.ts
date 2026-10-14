/**
 * Shared in-memory client harness for the LSP test suite: a framed JSON-RPC
 * client talking to the server over two PassThrough streams — the server is
 * exercised exactly as an editor would drive it over stdio.
 *
 * Not a test file (`*.test.js` glob) — imported by the suites in this
 * directory.
 */

import { PassThrough } from 'node:stream';

import { createConnection, type LspConnection } from '../connection';
import { MessageReader, writeMessage, type JsonRpcMessage } from '../jsonrpc';
import { Methods } from '../protocol';

const REQUEST_TIMEOUT_MS = 5_000;

export class TestClient {
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
// Shared fixtures
// ---------------------------------------------------------------------------

/** A clean document exercising types, an enum and a reference between them. */
export const GOOD_DOC = [
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

export const BROKEN_DOC = 'package payments.v1\ntype Money {\n    amount: money\n}\n';

export const MESSY_DOC = 'package payments.v1\ntype Money{\namount:int64\n}\n';
export const CANONICAL_DOC = 'package payments.v1\n\ntype Money {\n    amount: int64\n}\n';

export const URI = 'file:///work/payments.bridge';
