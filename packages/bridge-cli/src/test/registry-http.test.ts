/**
 * Integration tests: the CLI's registry commands against a REAL
 * `bridge-registry-service` running in-process on an ephemeral port
 * (issue #91). Covers the full publish → versions → inspect → pull →
 * search loop over HTTP, auth/tenancy failures, immutability, and the
 * byte-identical cross-process IR round-trip.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryDriver, start } from '@bridge/registry-service';
import type { Server } from 'node:http';
import { BIN, PAYMENTS_V1, PAYMENTS_V2, tmpdir, writeFile } from './helpers';

// ---------------------------------------------------------------------------
// Boot the real service (in-memory driver, static token, rate limits off for
// determinism — limits themselves are covered by the service's own suite).
// ---------------------------------------------------------------------------

const TOKEN = 'cli-integration-secret';
const server: Server = start(
  {
    driver: new InMemoryDriver(),
    auth: { tokens: { [TOKEN]: { tenant: 'acme', role: 'admin' } } },
    rateLimit: { enabled: false },
  },
  0,
);
const PORT = (server.address() as { port: number }).port;
const URL_ = `http://127.0.0.1:${PORT}`;

const tempRoots: string[] = [];
function fresh(label: string): string {
  const dir = tmpdir(label);
  tempRoots.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true });
  server.close();
});

/** Publish a contract file over HTTP; asserts success. */
async function publishOk(file: string, extra: readonly string[] = []): Promise<string> {
  const r = await runAsync([
    'publish', file,
    '--registry', URL_, '--token', TOKEN, '--org', 'acme', '--project', 'payments',
    ...extra,
  ]);
  assert.equal(r.status, 0, `publish failed: ${r.all}`);
  return r.stdout;
}

const TIMEOUT_CHILD = 40_000;

/**
 * Spawn the CLI asynchronously. The service runs in THIS process — a
 * synchronous spawn would block the event loop the server needs to answer
 * the child's requests (mutual deadlock at the 30s fetch timeout).
 */
function runAsync(
  args: readonly string[],
  opts: { env?: Readonly<Record<string, string>> } = {},
): Promise<{
  status: number;
  stdout: string;
  stderr: string;
  all: string;
}> {
  return new Promise((resolve) => {
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    delete childEnv['BRIDGE_REGISTRY'];
    delete childEnv['BRIDGE_TOKEN'];
    delete childEnv['BRIDGE_ORG'];
    delete childEnv['BRIDGE_PROJECT'];
    Object.assign(childEnv, opts.env);
    const child = spawn(process.execPath, [BIN, ...args], { env: childEnv });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_CHILD);
    void timer;
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ status: code ?? -1, stdout, stderr, all: stdout + stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// Full lifecycle
// ---------------------------------------------------------------------------

test('http registry: publish → versions → inspect → search → pull round-trip', async () => {
  const dir = fresh('http-lifecycle');
  const file = writeFile(dir, 'payments.bridge', PAYMENTS_V1);

  const published = await publishOk(file, ['--description', 'integration fixture']);
  assert.match(published, /✓ published payments\.v1@v1 \(hash [0-9a-f]{12}\)/);
  assert.match(published, new RegExp(`registry: ${URL_.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(org acme, project payments\\)`));
  assert.match(published, /publishedBy: token:acme/);

  const versions = await runAsync([
    'versions', 'payments.v1', '--registry', URL_, '--token', TOKEN, '--org', 'acme', '--project', 'payments',
  ]);
  assert.equal(versions.status, 0);
  assert.match(versions.stdout, /payments\.v1 \(1 version\(s\)/);
  assert.match(versions.stdout, /v1\s+\(latest\)/);

  const inspect = await runAsync([
    'inspect', 'payments.v1', '--registry', URL_, '--token', TOKEN, '--org', 'acme', '--project', 'payments',
  ]);
  assert.equal(inspect.status, 0);
  assert.match(inspect.stdout, /payments\.v1@v1/);
  assert.match(inspect.stdout, /hash: [0-9a-f]{12} \([0-9a-f]{64}\)/);
  assert.match(inspect.stdout, /types: 5 \(structs 4, enums 1, unions 0, aliases 0\)/);
  assert.match(inspect.stdout, /services: 1 \(2 methods\)/);
  assert.match(inspect.stdout, /events: 0/);
  assert.match(inspect.stdout, /published: /);

  const search = await runAsync(['search', 'payments', '--registry', URL_, '--token', TOKEN]);
  assert.equal(search.status, 0);
  assert.match(search.stdout, /1 result\(s\)/);
  assert.match(search.stdout, /payments\.v1@v1/);
  assert.match(search.stdout, /integration fixture/);

  // Cross-process byte-identical round-trip: pull the IR JSON and compare it
  // to what a filesystem registry publish of the same source produces.
  const outFile = path.join(dir, 'pulled-ir.json');
  const pulled = await runAsync([
    'pull', 'payments.v1', 'v1', '--registry', URL_, '--token', TOKEN, '--org', 'acme', '--project', 'payments',
    '--out', outFile,
  ]);
  assert.equal(pulled.status, 0, `pull failed: ${pulled.all}`);
  assert.ok(fs.existsSync(outFile));

  const fsRegistry = path.join(dir, 'fs-registry');
  const fsPublish = await runAsync(['publish', file, '--registry', fsRegistry]);
  assert.equal(fsPublish.status, 0);
  const fsFile = await runAsync([
    'pull', 'payments.v1', 'v1', '--registry', fsRegistry, '--out', path.join(dir, 'fs-ir.json'),
  ]);
  assert.equal(fsFile.status, 0);
  assert.equal(
    fs.readFileSync(outFile, 'utf8'),
    fs.readFileSync(path.join(dir, 'fs-ir.json'), 'utf8'),
    'HTTP-published IR and filesystem-published IR must be byte-identical canonical JSON',
  );
});

test('http registry: republishing identical content is reported as unchanged', async () => {
  const dir = fresh('http-unchanged');
  const file = writeFile(dir, 'payments.bridge', PAYMENTS_V1);
  await publishOk(file);
  const again = await publishOk(file);
  assert.match(again, /identical content already published/);
});

test('http registry: republishing a version with different content fails (immutable)', async () => {
  const dir = fresh('http-immutable');
  const file1 = writeFile(dir, 'payments-v1.bridge', PAYMENTS_V1);
  publishOk(file1);
  const file2 = writeFile(dir, 'payments-broken.bridge', PAYMENTS_V2);
  publishOk(file2);

  // payments.v1 with mutated content → 409 immutable, friendly hint.
  const mutated = PAYMENTS_V1.replace('currency: string @length(3)', 'currency: string');
  const file3 = writeFile(dir, 'payments-mutated.bridge', mutated);
  const r = await runAsync([
    'publish', file3, '--registry', URL_, '--token', TOKEN, '--org', 'acme', '--project', 'payments',
  ]);
  assert.equal(r.status, 1);
  assert.match(r.all, /immutable|already exists with different content/i);
});

test('http registry: v2 publish and explicit version pull', async () => {
  const dir = fresh('http-v2');
  const v1 = writeFile(dir, 'v1.bridge', PAYMENTS_V1);
  const v2 = writeFile(dir, 'v2.bridge', PAYMENTS_V2);
  publishOk(v1);
  publishOk(v2);

  const versions = await runAsync([
    'versions', 'payments', '--registry', URL_, '--token', TOKEN, '--org', 'acme', '--project', 'payments',
  ]);
  assert.equal(versions.status, 0);
  assert.match(versions.stdout, /2 version\(s\)/);
  assert.match(versions.stdout, /v1/);
  assert.match(versions.stdout, /v2\s+\(latest\)/);

  const inspectV1 = await runAsync([
    'inspect', 'payments', 'v1', '--registry', URL_, '--token', TOKEN, '--org', 'acme', '--project', 'payments',
  ]);
  assert.equal(inspectV1.status, 0);
  assert.match(inspectV1.stdout, /payments\.v1@v1/);
});

// ---------------------------------------------------------------------------
// Failure paths
// ---------------------------------------------------------------------------

test('http registry: wrong token fails with an actionable auth error (no token echo)', async () => {
  const dir = fresh('http-badtoken');
  const file = writeFile(dir, 'payments.bridge', PAYMENTS_V1);
  const r = await runAsync([
    'publish', file, '--registry', URL_, '--token', 'WRONG-token-not-shown-anywhere', '--org', 'acme', '--project', 'payments',
  ]);
  assert.equal(r.status, 1);
  assert.match(r.all, /authentication failed/);
  assert.ok(!r.all.includes('WRONG-token-not-shown-anywhere'), 'the rejected token must never be echoed');
});

test('http registry: cross-tenant reads are indistinguishable from unknown routes (404)', async () => {
  const dir = fresh('http-tenancy');
  const file = writeFile(dir, 'payments.bridge', PAYMENTS_V1);
  await publishOk(file);

  // The token is bound to org 'acme'; asking for globex must not leak
  // whether globex exists — it surfaces as not-found.
  const r = await runAsync([
    'versions', 'payments.v1', '--registry', URL_, '--token', TOKEN, '--org', 'globex', '--project', 'billing',
  ]);
  assert.equal(r.status, 1);
  assert.match(r.all, /unknown route/);
});

test('http registry: unreachable service fails loudly with a typed error', async () => {
  const dir = fresh('http-unreachable');
  const file = writeFile(dir, 'payments.bridge', PAYMENTS_V1);
  const r = await runAsync([
    'publish', file, '--registry', 'http://127.0.0.1:1', '--token', TOKEN, '--org', 'acme', '--project', 'payments',
  ]);
  assert.equal(r.status, 1);
  assert.match(r.all, /registry request to http:\/\/127\.0\.0\.1:1.*failed/);
});

test('http registry: search over an empty registry exits 0 with the friendly message', async () => {
  const r = await runAsync(['search', 'zzz-nothing', '--registry', URL_, '--token', TOKEN]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no contracts matching/);
});

test('http registry: BRIDGE_TOKEN/BRIDGE_ORG/BRIDGE_PROJECT env forms work', async () => {
  const dir = fresh('http-env');
  const file = writeFile(dir, 'payments.bridge', PAYMENTS_V1);
  const r = await runAsync(['publish', file, '--registry', URL_], {
    env: { BRIDGE_TOKEN: TOKEN, BRIDGE_ORG: 'acme', BRIDGE_PROJECT: 'payments' },
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /✓ published payments\.v1@v1/);
});
