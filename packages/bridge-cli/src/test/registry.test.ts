/**
 * E2E tests: publish / pull / versions / inspect / search against real
 * RegistryStores rooted in temp directories.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { PAYMENTS_BREAKING, PAYMENTS_V1, PAYMENTS_V2, PAYMENTS_SAFE, run, tmpdir, writeFile } from './helpers';

const tempRoots: string[] = [];
function fresh(label: string): string {
  const dir = tmpdir(label);
  tempRoots.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true });
});

/** Publish PAYMENTS_V1 into a fresh registry; returns { dir, file }. */
function publishPayments(label: string, owner?: string): { dir: string; file: string } {
  const dir = fresh(label);
  const file = writeFile(dir, 'payments.bridge', PAYMENTS_V1);
  const args = ['publish', file, '--registry', path.join(dir, 'registry')];
  if (owner !== undefined) args.push('--owner', owner);
  const r = run(args);
  assert.equal(r.status, 0, `setup publish failed: ${r.all}`);
  return { dir, file };
}

// ---------------------------------------------------------------------------
// publish
// ---------------------------------------------------------------------------

test('publish: prints package@version + hash and creates the registry', () => {
  const dir = fresh('publish');
  const registry = path.join(dir, 'registry');
  const file = writeFile(dir, 'payments.bridge', PAYMENTS_V1);
  const r = run(['publish', file, '--registry', registry, '--owner', 'team-pay', '--description', 'payments example']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /✓ published payments\.v1@v1 \(hash [0-9a-f]{12}\)/);
  assert.match(r.stdout, /owner: team-pay/);
  assert.match(r.stdout, /description: payments example/);
  assert.ok(fs.existsSync(path.join(registry, 'index.json')));
});

test('publish: BRIDGE_REGISTRY env overrides the default directory', () => {
  const dir = fresh('publish-env');
  const registry = path.join(dir, 'env-registry');
  const file = writeFile(dir, 'payments.bridge', PAYMENTS_V1);
  const r = run(['publish', file, '--owner', 'x'], { env: { BRIDGE_REGISTRY: registry } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, new RegExp(registry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(fs.existsSync(path.join(registry, 'index.json')));
});

test('publish: default registry root is ./.bridge-registry', () => {
  const dir = fresh('publish-default');
  const file = writeFile(dir, 'payments.bridge', PAYMENTS_V1);
  const r = run(['publish', file], { cwd: dir });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\.bridge-registry/);
  assert.ok(fs.existsSync(path.join(dir, '.bridge-registry', 'index.json')));
});

test('publish: identical content is an idempotent no-op (exit 0)', () => {
  const { dir, file } = publishPayments('publish-idempotent', 'team');
  const r = run(['publish', file, '--registry', path.join(dir, 'registry')]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /published payments\.v1@v1/);
});

test('publish: different content under the same version fails (immutable)', () => {
  const { dir } = publishPayments('publish-immutable', 'team');
  const breaking = writeFile(dir, 'breaking.bridge', PAYMENTS_BREAKING);
  const r = run(['publish', breaking, '--registry', path.join(dir, 'registry')]);
  assert.equal(r.status, 1);
  assert.match(r.all, /immutable/);
  assert.match(r.all, /bump the final segment/);
});

test('publish: uncompileable file exits 1 with diagnostics', () => {
  const dir = fresh('publish-broken');
  const file = writeFile(dir, 'broken.bridge', 'package nope.v1\ntype A { x: mystery }\n');
  const r = run(['publish', file, '--registry', path.join(dir, 'registry')]);
  assert.equal(r.status, 1);
  assert.match(r.all, /does not compile/);
});

test('publish --version: versionless name requires it; mismatch fails', () => {
  const dir = fresh('publish-version');
  const registry = path.join(dir, 'registry');
  const file = writeFile(dir, 'shop.bridge', 'package shop\n\ntype Item {\n    id: uuid\n}\n');

  // name "shop" has no version segment → publish fails without --version
  const missing = run(['publish', file, '--registry', registry]);
  assert.equal(missing.status, 1);
  assert.match(missing.all, /invalid-version|version/, 'mentions the version problem');

  // ...and succeeds with --version v1
  const ok = run(['publish', file, '--registry', registry, '--version', 'v1']);
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /published shop@v1/);

  // payments.v1 published with mismatching --version v2 → invalid-version
  const mismatchFile = writeFile(dir, 'payments.bridge', PAYMENTS_V1);
  const mismatch = run(['publish', mismatchFile, '--registry', registry, '--version', 'v2']);
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.all, /does not match the version/);
});

// ---------------------------------------------------------------------------
// pull
// ---------------------------------------------------------------------------

test('pull: prints a metadata + shape summary', () => {
  const { dir } = publishPayments('pull-summary', 'team-pay');
  const r = run(['pull', 'payments.v1', 'v1', '--registry', path.join(dir, 'registry')]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /✓ pulled payments\.v1@v1/);
  assert.match(r.stdout, /hash: [0-9a-f]{64}/);
  assert.match(r.stdout, /owner: team-pay/);
  assert.match(r.stdout, /types: 5, services: 1 \(2 methods\), events: 0/);
  assert.match(r.stdout, /imports: \(none\)/);
});

test('pull --out writes canonical IR JSON', () => {
  const { dir } = publishPayments('pull-out');
  const target = path.join(dir, 'pulled', 'ir.json');
  const r = run(['pull', 'payments.v1', 'v1', '--registry', path.join(dir, 'registry'), '--out', target]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /✓ wrote .*ir\.json/);
  const parsed = JSON.parse(fs.readFileSync(target, 'utf8')) as { name?: string };
  assert.equal(parsed.name, 'payments.v1');
});

test('pull: unknown package exits 1 with a friendly error', () => {
  const { dir } = publishPayments('pull-unknown');
  const r = run(['pull', 'ghost.v9', 'v9', '--registry', path.join(dir, 'registry')]);
  assert.equal(r.status, 1);
  assert.match(r.all, /no contract published/i);
});

// ---------------------------------------------------------------------------
// versions
// ---------------------------------------------------------------------------

test('versions: lists oldest→newest and marks the latest', () => {
  const dir = fresh('versions');
  const registry = path.join(dir, 'registry');
  const v1 = writeFile(dir, 'payments_v1.bridge', PAYMENTS_V1);
  assert.equal(run(['publish', v1, '--registry', registry]).status, 0);
  const v2 = writeFile(dir, 'payments_v2.bridge', PAYMENTS_V2);
  assert.equal(run(['publish', v2, '--registry', registry]).status, 0);

  const r = run(['versions', 'payments', '--registry', registry]);
  assert.equal(r.status, 0);
  const idxV1 = r.stdout.indexOf('v1');
  const idxV2 = r.stdout.indexOf('v2');
  assert.ok(idxV1 >= 0 && idxV2 > idxV1, 'v1 listed before v2 (oldest→newest)');
  assert.match(r.stdout, /v2 {2,}\(latest\)/);
});

test('versions: unknown package exits 1', () => {
  const { dir } = publishPayments('versions-unknown');
  const r = run(['versions', 'ghost', '--registry', path.join(dir, 'registry')]);
  assert.equal(r.status, 1);
  assert.match(r.all, /no versions published for package 'ghost'/i);
});

// ---------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------

test('inspect: defaults to latest, shows meta and shape counts', () => {
  const { dir } = publishPayments('inspect-latest', 'team-pay');
  const r = run(['inspect', 'payments', '--registry', path.join(dir, 'registry')]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /payments\.v1@v1/);
  assert.match(r.stdout, /hash: [0-9a-f]{12} \([0-9a-f]{64}\)/);
  assert.match(r.stdout, /owner: team-pay/);
  assert.match(r.stdout, /types: 5 \(structs 4, enums 1, unions 0, aliases 0\)/);
  assert.match(r.stdout, /services: 1 \(2 methods\)/);
  assert.match(r.stdout, /events: 0/);
  assert.match(r.stdout, /imports: \(none\)/);
});

test('inspect: explicit version selects that version', () => {
  const dir = fresh('inspect-version');
  const registry = path.join(dir, 'registry');
  const v1 = writeFile(dir, 'payments_v1.bridge', PAYMENTS_V1);
  run(['publish', v1, '--registry', registry]);
  const v2 = writeFile(dir, 'payments_v2.bridge', PAYMENTS_V2);
  run(['publish', v2, '--registry', registry]);

  const r = run(['inspect', 'payments', 'v1', '--registry', registry]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /payments\.v1@v1/);
  assert.doesNotMatch(r.stdout, /reference/);
});

test('inspect: unknown package exits 1', () => {
  const { dir } = publishPayments('inspect-unknown');
  const r = run(['inspect', 'ghost.v1', '--registry', path.join(dir, 'registry')]);
  assert.equal(r.status, 1);
  assert.match(r.all, /no versions published/i);
});

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

test('search: finds published contracts by name substring', () => {
  const { dir } = publishPayments('search-hit', 'team-pay');
  const r = run(['search', 'pay', '--registry', path.join(dir, 'registry')]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /1 result\(s\)/);
  assert.match(r.stdout, /payments\.v1@v1/);
  assert.match(r.stdout, /team-pay/);
});

test('search: description and owner are searchable', () => {
  const dir = fresh('search-desc');
  const registry = path.join(dir, 'registry');
  const file = writeFile(dir, 'payments.bridge', PAYMENTS_V1);
  run(['publish', file, '--registry', registry, '--description', 'online checkout flows']);

  const byDesc = run(['search', 'checkout', '--registry', registry]);
  assert.equal(byDesc.status, 0);
  assert.match(byDesc.stdout, /payments\.v1@v1/);
});

test('search: no matches exits 0 with a friendly message', () => {
  const { dir } = publishPayments('search-miss');
  const r = run(['search', 'zzz-nothing', '--registry', path.join(dir, 'registry')]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no contracts matching/);
});

// ---------------------------------------------------------------------------
// HTTP(S) registry usage errors (issues #90/#91): an HTTP target is never
// treated as a directory, and the HTTP path fails loudly on missing
// credentials/coordinates before any request or filesystem write.
// ---------------------------------------------------------------------------

test('publish: --registry http:// URL without a token is a usage error (exit 2)', () => {
  const dir = fresh('reject-publish');
  const file = writeFile(dir, 'payments.bridge', PAYMENTS_V1);
  const r = run(['publish', file, '--registry', 'http://127.0.0.1:4400']);
  assert.equal(r.status, 2);
  assert.match(r.all, /HTTP\(S\) registry — authentication is required/);
  assert.match(r.all, /BRIDGE_TOKEN/);
  assert.ok(!fs.existsSync(path.join(dir, 'http:')), 'no URL-named directory may be created');
});

test('publish: --owner is rejected for HTTP registries (publishedBy comes from the credential)', () => {
  const dir = fresh('reject-publish-owner');
  const file = writeFile(dir, 'payments.bridge', PAYMENTS_V1);
  const r = run([
    'publish', file, '--registry', 'http://127.0.0.1:4400',
    '--token', 't', '--org', 'acme', '--project', 'payments', '--owner', 'team',
  ]);
  assert.equal(r.status, 2);
  assert.match(r.all, /--owner applies to filesystem registries only/);
});

test('publish: HTTP registry without --org/--project is a usage error', () => {
  const dir = fresh('reject-publish-coords');
  const file = writeFile(dir, 'payments.bridge', PAYMENTS_V1);
  const r = run(['publish', file, '--registry', 'http://127.0.0.1:4400', '--token', 't']);
  assert.equal(r.status, 2);
  assert.match(r.all, /needs tenancy coordinates/);
});

test('versions: HTTP registry without a token is a usage error', () => {
  const r = run(['versions', 'payments.v1', '--registry', 'http://127.0.0.1:4400']);
  assert.equal(r.status, 2);
  assert.match(r.all, /authentication is required/);
});

test('doctor: filesystem-only command rejects URL --registry (issue #90 invariant)', () => {
  const r = run(['doctor', '--registry', 'http://127.0.0.1:4400']);
  assert.equal(r.status, 2);
  assert.match(r.all, /HTTP\(S\) URL, but this command talks to a filesystem registry/);
});

test('check: filesystem-only --against registry rejects URL --registry', () => {
  const dir = fresh('reject-check');
  const file = writeFile(dir, 'payments.bridge', PAYMENTS_V1);
  const r = run(['check', file, '--against', 'payments.v1', '--registry', 'http://127.0.0.1:4400']);
  assert.equal(r.status, 2);
  assert.match(r.all, /HTTP\(S\) URL, but this command talks to a filesystem registry/);
});
