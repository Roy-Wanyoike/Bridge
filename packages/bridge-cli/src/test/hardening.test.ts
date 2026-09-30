/**
 * Hardening regression tests (issue #119, fix(cli)) — one test per defect:
 *
 * - EPIPE: `bridge version | head -1` must exit quietly (bin/bridge.ts guard).
 * - UTF-8: readText rejects invalid byte sequences instead of silently
 *   replacing them (files.ts).
 * - TOCTOU: init/generate write with exclusive-create flags ('wx') and map
 *   EEXIST to the friendly refusal; doctor wraps statSync in a plain CliError.
 * - HTTP response shapes: truncated / wrong-typed registry payloads fail as
 *   plain CliErrors (registry-http.ts), driven against a stub HTTP server.
 *
 * The HTTP stubs follow the same pattern as registry-http.test.ts: the server
 * lives in THIS process, so the CLI is spawned asynchronously.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import { BIN, GOOD, PAYMENTS_V1, run, tmpdir, writeFile } from './helpers';
import { readText } from '../files';
import { CliError } from '../errors';
import * as doctor from '../commands/doctor';

const tempRoots: string[] = [];
function fresh(label: string): string {
  const dir = tmpdir(label);
  tempRoots.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// EPIPE (bin/bridge.ts): a closed downstream pipe is backpressure, not a crash
// ---------------------------------------------------------------------------

test('EPIPE: stdout closed after spawn exits quietly, like `bridge version | head -1`', async () => {
  const child = spawn(process.execPath, [BIN, 'version'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
  const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
  // Close the read end before the child writes: its first stdout write then
  // fails with EPIPE, which the bin/bridge.ts guard must swallow.
  child.stdout?.destroy();
  const code = await exited;
  assert.equal(code, 0, `expected a quiet exit 0, got ${code} (stderr: ${stderr})`);
  assert.ok(!stderr.includes('EPIPE'), 'EPIPE must not surface on stderr');
});

// ---------------------------------------------------------------------------
// UTF-8 (files.ts): invalid bytes are detected, not silently replaced
// ---------------------------------------------------------------------------

test('readText: invalid UTF-8 fails as a plain CliError instead of silent replacement', () => {
  const dir = fresh('utf8-latin1');
  const file = path.join(dir, 'latin1.bridge');
  // "package p.v1\n" followed by a lone latin-1 é (0xE9) — invalid UTF-8.
  fs.writeFileSync(file, Buffer.from([0x70, 0x61, 0x63, 0x6b, 0x61, 0x67, 0x65, 0x20, 0x70, 0x2e, 0x76, 0x31, 0xe9, 0x0a]));
  assert.throws(
    () => readText(file),
    (e: unknown) => e instanceof CliError && e.exitCode === 1 && e.message === `${file} is not valid UTF-8`,
  );
});

test('readText: valid UTF-8 — including a legitimate U+FFFD — reads unchanged', () => {
  const dir = fresh('utf8-valid');
  const file = path.join(dir, 'valid.bridge');
  const text = 'package p.v1 // café \uFFFD\n';
  fs.writeFileSync(file, text, 'utf8');
  assert.equal(readText(file), text);
});

test('validate: a latin-1 file exits 1 with the plain UTF-8 error (no crash)', () => {
  const dir = fresh('utf8-validate');
  const file = path.join(dir, 'latin1.bridge');
  fs.writeFileSync(file, Buffer.from('package p.v1\n// café\n', 'latin1'));
  const r = run(['validate', file]);
  assert.equal(r.status, 1);
  assert.match(r.all, /is not valid UTF-8/);
  assert.ok(!r.all.includes('internal error'), 'must render as a plain CliError, not a crash');
});

// ---------------------------------------------------------------------------
// TOCTOU (init.ts / generate.ts / doctor.ts): exclusive-create writes
// ---------------------------------------------------------------------------

test('init: a pre-existing bridge.json alone is refused (EEXIST on the exclusive write)', () => {
  const dir = fresh('init-config-eexist');
  fs.writeFileSync(path.join(dir, 'bridge.json'), '{"version":1}', 'utf8');
  const r = run(['init', dir]);
  assert.equal(r.status, 1);
  assert.match(r.all, /refusing to overwrite existing file\(s\): .*bridge\.json/);
  assert.equal(fs.readFileSync(path.join(dir, 'bridge.json'), 'utf8'), '{"version":1}');
});

test('generate: one pre-existing target is refused by name; --force rewrites it', () => {
  const dir = fresh('gen-wx');
  const file = writeFile(dir, 'good.bridge', GOOD);
  const outDir = path.join(dir, 'out');
  assert.equal(run(['generate', '--language', 'go', '--out', outDir, file]).status, 0);

  // Leave exactly one generated target in place.
  fs.rmSync(outDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'go.mod'), '// pre-existing\n', 'utf8');

  const refused = run(['generate', '--language', 'go', '--out', outDir, file]);
  assert.equal(refused.status, 1);
  assert.match(refused.all, /refusing to overwrite 1 existing file\(s\)/);
  assert.match(refused.all, /go\.mod/);
  assert.equal(fs.readFileSync(path.join(outDir, 'go.mod'), 'utf8'), '// pre-existing\n');

  const forced = run(['generate', '--language', 'go', '--out', outDir, '--force', file]);
  assert.equal(forced.status, 0);
  assert.match(fs.readFileSync(path.join(outDir, 'go.mod'), 'utf8'), /Package: shop\.v1/);
});

test('doctor: a registry path that cannot be stat-ed fails as a plain CliError', () => {
  const dir = fresh('doctor-stat');
  const root = path.join(dir, 'registry');
  fs.mkdirSync(root); // existsSync → true, so the stat branch is taken

  // The compiled modules read `fs.statSync` through live getters onto the
  // real builtin exports object, so patching it here is visible to doctor —
  // this simulates the path vanishing between existsSync and statSync.
  const requireReal = createRequire(__filename);
  const fsReal = requireReal('node:fs') as unknown as Record<string, unknown>;
  const original = fsReal['statSync'] as typeof fs.statSync;
  fsReal['statSync'] = () => {
    const boom = new Error('simulated stat failure') as NodeJS.ErrnoException;
    boom.code = 'EACCES';
    throw boom;
  };
  try {
    assert.throws(
      () => doctor.run({ positionals: [], flags: new Set(), values: new Map([['--registry', root]]) }),
      (e: unknown) =>
        e instanceof CliError &&
        e.exitCode === 1 &&
        e.message === `cannot inspect registry ${root}: simulated stat failure`,
    );
  } finally {
    fsReal['statSync'] = original;
  }
});

// ---------------------------------------------------------------------------
// HTTP response shapes (registry-http.ts): malformed payloads are plain
// CliErrors. Stub server pattern as in registry-http.test.ts.
// ---------------------------------------------------------------------------

const TIMEOUT_CHILD = 40_000;

function runAsync(args: readonly string[]): Promise<{ status: number; stdout: string; stderr: string; all: string }> {
  return new Promise((resolve) => {
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    delete childEnv['BRIDGE_REGISTRY'];
    delete childEnv['BRIDGE_TOKEN'];
    delete childEnv['BRIDGE_ORG'];
    delete childEnv['BRIDGE_PROJECT'];
    const child = spawn(process.execPath, [BIN, ...args], { env: childEnv });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_CHILD);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ status: code ?? -1, stdout, stderr, all: stdout + stderr });
    });
  });
}

interface StubRoute {
  status: number;
  body: unknown;
}

function startStub(respond: (method: string, url: string) => StubRoute | undefined): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const route = respond(req.method ?? 'GET', req.url ?? '/');
      res.writeHead(route?.status ?? 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(route?.body ?? { error: { code: 'not-found', message: 'stub: unrouted request' } }));
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

const PULL_ARGS = ['--registry', 'STUB', '--token', 'stub-token', '--org', 'acme', '--project', 'payments'] as const;

/** A meta payload that passes the validator (positive control). */
const VALID_META = {
  org: 'acme',
  project: 'payments',
  packageName: 'payments.v1',
  base: 'payments',
  version: 'v1',
  hash: 'a'.repeat(64),
  shortHash: 'a'.repeat(12),
  imports: [],
  publishedAt: '2026-01-01T00:00:00.000Z',
};

/** A minimal IR payload that passes the validator (positive control). */
const VALID_IR = { name: 'payments.v1', imports: [], types: [], services: [], events: [] };

test('http registry: publish response with truncated meta fails as a plain CliError', async () => {
  const dir = fresh('shape-publish');
  const file = writeFile(dir, 'payments.bridge', PAYMENTS_V1);
  const { server, url } = await startStub((method, u) => {
    if (method === 'POST' && u.includes('/contracts/payments.v1')) {
      // Strings are fine — but `imports` is missing, which publish.ts
      // dereferences with .length/.join.
      return { status: 200, body: { outcome: 'created', meta: { ...VALID_META, imports: undefined } } };
    }
    return undefined;
  });
  try {
    const r = await runAsync([
      'publish', file, '--registry', url, '--token', 'stub-token', '--org', 'acme', '--project', 'payments',
    ]);
    assert.equal(r.status, 1);
    assert.match(r.all, /publish response for payments\.v1 had an unexpected shape: meta\.imports must be a list of strings/);
    assert.ok(!r.all.includes('internal error'), 'no stack-trace rendering');
    assert.ok(!r.all.includes('TypeError'), 'the command must not crash on the payload');
  } finally {
    server.close();
  }
});

test('http registry: publish response with no meta at all fails as a plain CliError', async () => {
  const dir = fresh('shape-publish-nometa');
  const file = writeFile(dir, 'payments.bridge', PAYMENTS_V1);
  const { server, url } = await startStub((method, u) => {
    if (method === 'POST' && u.includes('/contracts/payments.v1')) {
      return { status: 200, body: { outcome: 'created' } };
    }
    return undefined;
  });
  try {
    const r = await runAsync([
      'publish', file, '--registry', url, '--token', 'stub-token', '--org', 'acme', '--project', 'payments',
    ]);
    assert.equal(r.status, 1);
    assert.match(r.all, /publish response for payments\.v1 had an unexpected shape/);
  } finally {
    server.close();
  }
});

test('http registry: pull response with a truncated ir fails as a plain CliError', async () => {
  const { server, url } = await startStub((method, u) => {
    if (method === 'GET' && u.includes('/contracts/payments.v1/versions/v1')) {
      // `ir.types` is missing — pull.ts prints ir.types.length / iterates
      // ir.services, so this must never reach the command.
      return { status: 200, body: { ir: { name: 'payments.v1', imports: [] }, meta: VALID_META } };
    }
    return undefined;
  });
  try {
    const r = await runAsync(['pull', 'payments.v1', 'v1', ...PULL_ARGS.map((a) => (a === 'STUB' ? url : a))]);
    assert.equal(r.status, 1);
    assert.match(r.all, /pull response for payments\.v1 had an unexpected shape: ir\.types must be a list/);
    assert.ok(!r.all.includes('TypeError'), 'the command must not crash on the payload');
  } finally {
    server.close();
  }
});

test('http registry: pull response with wrong-typed meta fields fails as a plain CliError', async () => {
  const { server, url } = await startStub((method, u) => {
    if (method === 'GET' && u.includes('/contracts/payments.v1/versions/v1')) {
      return { status: 200, body: { ir: VALID_IR, meta: { ...VALID_META, shortHash: 42 } } };
    }
    return undefined;
  });
  try {
    const r = await runAsync(['pull', 'payments.v1', 'v1', ...PULL_ARGS.map((a) => (a === 'STUB' ? url : a))]);
    assert.equal(r.status, 1);
    assert.match(r.all, /pull response for payments\.v1 had an unexpected shape: meta\.shortHash must be a string/);
  } finally {
    server.close();
  }
});

test('http registry: versions response with non-string entries fails as a plain CliError', async () => {
  const { server, url } = await startStub((method, u) => {
    if (method === 'GET' && u.endsWith('/versions')) {
      return { status: 200, body: { versions: ['v1', 2] } };
    }
    return undefined;
  });
  try {
    const r = await runAsync(['versions', 'payments.v1', ...PULL_ARGS.map((a) => (a === 'STUB' ? url : a))]);
    assert.equal(r.status, 1);
    assert.match(r.all, /versions response for payments\.v1 had an unexpected shape/);
  } finally {
    server.close();
  }
});

test('http registry: search response with a malformed result entry fails as a plain CliError', async () => {
  const { server, url } = await startStub((method, u) => {
    if (method === 'GET' && u.startsWith('/v1/search')) {
      return { status: 200, body: { results: [VALID_META, { org: 'acme', project: 'payments', packageName: 7 }] } };
    }
    return undefined;
  });
  try {
    const r = await runAsync(['search', 'payments', '--registry', url, '--token', 'stub-token']);
    assert.equal(r.status, 1);
    assert.match(r.all, /search response for 'payments' had an unexpected shape: meta\.packageName must be a string/);
  } finally {
    server.close();
  }
});

test('http registry: a fully-shaped pull response still succeeds (no over-validation)', async () => {
  const { server, url } = await startStub((method, u) => {
    if (method === 'GET' && u.includes('/contracts/payments.v1/versions/v1')) {
      return { status: 200, body: { ir: VALID_IR, meta: VALID_META } };
    }
    return undefined;
  });
  try {
    const r = await runAsync(['pull', 'payments.v1', 'v1', ...PULL_ARGS.map((a) => (a === 'STUB' ? url : a))]);
    assert.equal(r.status, 0, `valid pull failed: ${r.all}`);
    assert.match(r.stdout, /✓ pulled payments\.v1@v1/);
    assert.match(r.stdout, /org acme, project payments/);
    assert.match(r.stdout, /types: 0/);
  } finally {
    server.close();
  }
});
