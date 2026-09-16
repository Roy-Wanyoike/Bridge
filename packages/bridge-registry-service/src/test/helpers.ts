/**
 * Shared test helpers: IR fixtures, an HTTP request helper, JWT minting
 * (RS256/ES256) and ed25519 signing material for the signing tests.
 */

import { createSign, createSign as createCryptoSign, generateKeyPairSync } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { start } from '../server';
import type { RegistryServiceOptions } from '../types';

/** A minimal, valid IR package (sorted types/imports; exact key set). */
export function makeIR(name = 'payments.v1'): Record<string, unknown> {
  return {
    name,
    imports: [],
    types: [
      {
        name: 'Money',
        kind: 'struct',
        fields: [
          {
            name: 'amount',
            type: { kind: 'primitive', primitive: 'string' },
            optional: false,
            constraints: [],
          },
        ],
      },
    ],
    services: [],
    events: [],
  };
}

/** IR package with one service + one event (still canonical). */
export function makeFullIR(name = 'orders.v1'): Record<string, unknown> {
  return {
    name,
    imports: [],
    types: [
      {
        name: 'Order',
        kind: 'struct',
        fields: [
          { name: 'id', type: { kind: 'primitive', primitive: 'string' }, optional: false, constraints: [] },
          {
            name: 'total',
            type: { kind: 'primitive', primitive: 'int64' },
            optional: false,
            constraints: [{ kind: 'min', args: ['0'] }],
          },
        ],
      },
    ],
    services: [
      {
        name: 'Orders',
        methods: [
          {
            name: 'GetOrder',
            input: { kind: 'named', name: 'Order' },
            output: { kind: 'named', name: 'Order' },
          },
        ],
      },
    ],
    events: [
      {
        name: 'OrderCreated',
        fields: [
          { name: 'id', type: { kind: 'primitive', primitive: 'string' }, optional: false, constraints: [] },
        ],
      },
    ],
  };
}

/** Starts the service on an ephemeral port; returns the base URL + server. */
export function startTestServer(
  options: RegistryServiceOptions,
): { server: Server; url: string; close: () => Promise<void> } {
  const server = start(options, 0);
  // `start` binds immediately; wait for listening.
  return {
    server,
    get url(): string {
      const address = server.address() as AddressInfo;
      return `http://127.0.0.1:${address.port}`;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** Thin JSON-over-HTTP helper for integration tests. */
export async function request(
  url: string,
  method: string,
  path: string,
  opts: { body?: unknown; token?: string; headers?: Record<string, string> } = {},
): Promise<{
  // Integration-test helper: response bodies are intentionally untyped —
  // every test asserts its own shape — so `json` stays loose by design.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  status: number; json: any; headers: Record<string, string | string[] | undefined>;
}> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token !== undefined) headers['authorization'] = `Bearer ${opts.token}`;
  let body: Buffer | undefined;
  if (opts.body !== undefined) {
    body = Buffer.from(JSON.stringify(opts.body), 'utf8');
    headers['content-type'] = 'application/json';
  }
  const response = await fetch(`${url}${path}`, {
    method,
    headers,
    body,
    redirect: 'manual',
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, headers: Object.fromEntries(response.headers.entries()) };
}

// ------------------------------------------------------------------- JWT

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export interface MintedKey {
  kid: string;
  jwk: Record<string, unknown>;
  alg: 'RS256' | 'ES256';
}

/** Generates a real signing key pair usable in tests (JWK + signer). */
export function generateSigningKey(alg: 'RS256' | 'ES256', kid = 'test-key-1'): { mint: MintedKey; key: KeyObject } {
  if (alg === 'RS256') {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid, alg: 'RS256', use: 'sig' };
    return { mint: { kid, jwk, alg }, key: privateKey };
  }
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid, alg: 'ES256', use: 'sig' };
  return { mint: { kid, jwk, alg }, key: privateKey };
}

/** Mints a compact JWT with the given header/claims, signed by `key`. */
export function mintJwt(
  key: KeyObject,
  alg: 'RS256' | 'ES256',
  kid: string,
  claims: Record<string, unknown>,
  headerExtra: Record<string, unknown> = {},
): string {
  const header = { alg, kid, typ: 'JWT', ...headerExtra };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  if (alg === 'RS256') {
    const signature = createCryptoSign('sha256').update(signingInput).sign(key);
    return `${signingInput}.${b64url(signature)}`;
  }
  const signature = createSign('sha256').update(signingInput).sign({ key, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${b64url(signature)}`;
}
