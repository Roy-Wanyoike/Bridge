/**
 * E2E tests for the opt-in compile cache (`bridge generate --cache` /
 * BRIDGE_CACHE=1): a cache hit must be indistinguishable from a fresh
 * compile (byte-identical output and error rendering), entries must be
 * invalidated by source changes and compiler-version bumps, and a broken
 * cache location must degrade to plain uncached compilation.
 *
 * Every "was it a hit?" assertion is structural — cache-entry identity via
 * inode and entry counts (a store replaces the entry file, a hit leaves it
 * untouched) — never timing-based.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { BROKEN, GOOD, run, tmpdir, writeFile } from './helpers';

const CACHE_DIR = '.bridge-cache';

const tempRoots: string[] = [];
function fresh(label: string): string {
  const dir = tmpdir(`cache-${label}`);
  tempRoots.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true });
});

/** Final cache entries are `<sha256>.json` (tmp files carry extra suffixes). */
function entries(dir: string): string[] {
  return fs
    .readdirSync(path.join(dir, CACHE_DIR))
    .filter((name) => /^[0-9a-f]{64}\.json$/.test(name))
    .sort();
}

function entryPaths(dir: string): string[] {
  return entries(dir).map((name) => path.join(dir, CACHE_DIR, name));
}

/** Entry identity — a cache store replaces the file (new inode), a hit does not. */
function inos(dir: string): string[] {
  return entryPaths(dir).map((p) => String(fs.statSync(p).ino));
}

/** Relative file paths under dir, sorted, directories flattened. */
function tree(dir: string): string[] {
  const files: string[] = [];
  const walk = (rel: string): void => {
    for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
      const next = path.join(rel, name);
      if (fs.statSync(path.join(dir, next)).isDirectory()) walk(next);
      else files.push(next.split(path.sep).join('/'));
    }
  };
  walk('');
  return files;
}

/** Map of relative path → file content for a whole directory. */
function snapshot(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const rel of tree(dir)) files.set(rel, fs.readFileSync(path.join(dir, rel), 'utf8'));
  return files;
}

// ---------------------------------------------------------------------------
// Hits
// ---------------------------------------------------------------------------

test('generate --cache: cold run creates the cache dir + one entry, warm run hits it', () => {
  const dir = fresh('hit');
  const file = writeFile(dir, 'good.bridge', GOOD);
  const outDir = path.join(dir, 'out');

  const cold = run(['generate', '--language', 'go', '--cache', '--out', outDir, file], { cwd: dir });
  assert.equal(cold.status, 0);
  assert.ok(fs.existsSync(path.join(dir, CACHE_DIR)), 'cache directory is created in the project dir');
  assert.equal(entries(dir).length, 1, 'one entry per (source, path, compiler version)');

  const coldFiles = snapshot(outDir);
  const coldInos = inos(dir);
  const coldStdout = cold.stdout;

  const warm = run(['generate', '--language', 'go', '--cache', '--force', '--out', outDir, file], {
    cwd: dir,
  });
  assert.equal(warm.status, 0);
  assert.equal(entries(dir).length, 1, 'identical input does not add entries');
  assert.deepEqual(inos(dir), coldInos, 'entry file untouched on a warm run — compile+store skipped');
  assert.equal(warm.stdout, coldStdout, 'warm run prints exactly what the cold run printed');
  assert.deepEqual(snapshot(outDir), coldFiles, 'warm run output is byte-identical to the cold run');
});

test('cache-hit output is byte-identical to a fresh compile without the cache', () => {
  const cachedDir = fresh('vs-fresh-cached');
  const plainDir = fresh('vs-fresh-plain');
  const cachedFile = writeFile(cachedDir, 'good.bridge', GOOD);
  const plainFile = writeFile(plainDir, 'good.bridge', GOOD);
  const cachedOut = path.join(cachedDir, 'out');
  const plainOut = path.join(plainDir, 'out');

  assert.equal(
    run(['generate', '--language', 'typescript', '--cache', '--out', cachedOut, cachedFile], {
      cwd: cachedDir,
    }).status,
    0,
  );
  assert.equal(
    run(['generate', '--language', 'typescript', '--out', plainOut, plainFile], { cwd: plainDir }).status,
    0,
  );

  const cached = snapshot(cachedOut);
  const plain = snapshot(plainOut);
  assert.deepEqual([...cached.keys()], [...plain.keys()], 'same generated file set');
  for (const [rel, content] of cached) {
    assert.equal(content, plain.get(rel), `byte-identical: ${rel}`);
  }
});

// ---------------------------------------------------------------------------
// Invalidation
// ---------------------------------------------------------------------------

test('changed source invalidates the entry (new key, new output)', () => {
  const dir = fresh('invalidate-source');
  const file = writeFile(dir, 'good.bridge', GOOD);
  const outDir = path.join(dir, 'out');

  assert.equal(run(['generate', '--language', 'go', '--cache', '--out', outDir, file], { cwd: dir }).status, 0);
  assert.equal(entries(dir).length, 1);
  const before = snapshot(outDir);
  const beforeInos = inos(dir);

  writeFile(dir, 'good.bridge', GOOD.replace('type Money {', 'type Money {\n    note: string'));
  const second = run(['generate', '--language', 'go', '--cache', '--force', '--out', outDir, file], {
    cwd: dir,
  });
  assert.equal(second.status, 0);
  assert.equal(entries(dir).length, 2, 'changed source compiles to a second entry');
  assert.deepEqual(
    inos(dir).filter((ino) => beforeInos.includes(ino)),
    beforeInos,
    'old entry is left untouched (both stay valid for their sources)',
  );
  assert.notDeepEqual(snapshot(outDir), before, 'output reflects the changed source');
});

test('compiler-version mismatch invalidates the entry (miss → recompile → re-store)', () => {
  const dir = fresh('invalidate-version');
  const file = writeFile(dir, 'good.bridge', GOOD);
  const outDir = path.join(dir, 'out');

  assert.equal(run(['generate', '--language', 'go', '--cache', '--out', outDir, file], { cwd: dir }).status, 0);
  const [entry] = entryPaths(dir);
  const stored = JSON.parse(fs.readFileSync(entry!, 'utf8')) as Record<string, unknown>;
  // Entry payload carries the key material: cache format version, compiler
  // version, source hash — the last line of defense against stale hits.
  assert.equal(typeof stored['cacheFormatVersion'], 'number');
  assert.match(String(stored['compilerVersion']), /^\d+\.\d+\.\d+/);
  assert.match(String(stored['sourceHash']), /^[0-9a-f]{64}$/);

  // Simulate a compiler upgrade for this entry: bump the stored version.
  // The key is unchanged, so the CLI finds the file but must treat it as a
  // miss and re-store it (new inode).
  stored['compilerVersion'] = '0.0.0-invalidated';
  fs.writeFileSync(entry!, JSON.stringify(stored), 'utf8');
  const before = inos(dir);

  const warm = run(['generate', '--language', 'go', '--cache', '--force', '--out', outDir, file], {
    cwd: dir,
  });
  assert.equal(warm.status, 0);
  assert.equal(entries(dir).length, 1);
  assert.notDeepEqual(inos(dir), before, 'version mismatch forces a recompile + re-store');
  const restored = JSON.parse(fs.readFileSync(entryPaths(dir)[0]!, 'utf8')) as Record<string, unknown>;
  assert.match(String(restored['compilerVersion']), /^\d+\.\d+\.\d+/, 'entry re-stored with the real version');
});

test('corrupt cache entry is treated as a miss without crashing', () => {
  const dir = fresh('corrupt');
  const file = writeFile(dir, 'good.bridge', GOOD);
  const outDir = path.join(dir, 'out');

  assert.equal(run(['generate', '--language', 'go', '--cache', '--out', outDir, file], { cwd: dir }).status, 0);
  const [entry] = entryPaths(dir);
  fs.writeFileSync(entry!, '{"torn', 'utf8');

  const warm = run(['generate', '--language', 'go', '--cache', '--force', '--out', outDir, file], {
    cwd: dir,
  });
  assert.equal(warm.status, 0);
  assert.match(warm.stdout, /wrote /);
  JSON.parse(fs.readFileSync(entryPaths(dir)[0]!, 'utf8')); // parse-able again
});

test('same source under a different file path gets its own entry (path is key material)', () => {
  const dir = fresh('path-in-key');
  const a = writeFile(dir, 'a.bridge', GOOD);
  const b = writeFile(dir, 'b.bridge', GOOD);
  assert.equal(
    run(['generate', '--language', 'go', '--cache', '--out', path.join(dir, 'o1'), a], { cwd: dir }).status,
    0,
  );
  assert.equal(
    run(['generate', '--language', 'go', '--cache', '--out', path.join(dir, 'o2'), b], { cwd: dir }).status,
    0,
  );
  assert.equal(entries(dir).length, 2, 'file path is part of the key (diagnostics embed it)');
});

test('failed compile is cached negatively and reproduced byte-identically', () => {
  const dir = fresh('negative');
  const file = writeFile(dir, 'broken.bridge', BROKEN);
  const outDir = path.join(dir, 'out');

  const cold = run(['generate', '--language', 'go', '--cache', '--out', outDir, file], { cwd: dir });
  assert.equal(cold.status, 1);
  assert.match(cold.all, /does not compile/);
  assert.ok(!fs.existsSync(outDir), 'nothing written on compile failure');
  assert.equal(entries(dir).length, 1, 'the failed result is stored too (negative caching)');

  const warm = run(['generate', '--language', 'go', '--cache', '--out', outDir, file], { cwd: dir });
  assert.equal(warm.status, 1);
  assert.equal(warm.all, cold.all, 'cached failure renders byte-identically');
});

// ---------------------------------------------------------------------------
// Opt-in surface
// ---------------------------------------------------------------------------

test('without --cache or BRIDGE_CACHE no cache directory is created', () => {
  const dir = fresh('off');
  const file = writeFile(dir, 'good.bridge', GOOD);
  const r = run(['generate', '--language', 'go', '--out', path.join(dir, 'out'), file], {
    cwd: dir,
    env: { BRIDGE_CACHE: '' }, // pin off, immune to the outer environment
  });
  assert.equal(r.status, 0);
  assert.ok(!fs.existsSync(path.join(dir, CACHE_DIR)), 'opt-in means opt-in');
});

test('BRIDGE_CACHE=1 enables the cache without the flag', () => {
  const dir = fresh('env');
  const file = writeFile(dir, 'good.bridge', GOOD);
  const r = run(['generate', '--language', 'go', '--out', path.join(dir, 'out'), file], {
    cwd: dir,
    env: { BRIDGE_CACHE: '1' },
  });
  assert.equal(r.status, 0);
  assert.equal(entries(dir).length, 1);
});

test('--cache is scoped to generate (unknown elsewhere)', () => {
  const dir = fresh('scoped');
  const file = writeFile(dir, 'good.bridge', GOOD);
  const r = run(['validate', '--cache', file]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown option '--cache' for 'bridge validate'/);
});

test('help generate documents --cache, BRIDGE_CACHE and the cache location', () => {
  const r = run(['help', 'generate']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--cache/);
  assert.match(r.stdout, /BRIDGE_CACHE=1/);
  assert.match(r.stdout, /\.bridge-cache/);
});

// ---------------------------------------------------------------------------
// Graceful degradation
// ---------------------------------------------------------------------------

test('unwritable cache location degrades to no-cache; the command still succeeds', () => {
  const dir = fresh('unwritable');
  const file = writeFile(dir, 'good.bridge', GOOD);
  // A plain file where the cache directory belongs defeats every mkdir/rename
  // inside it on any platform, for any user (root included).
  fs.writeFileSync(path.join(dir, CACHE_DIR), 'not a directory', 'utf8');

  const r = run(['generate', '--language', 'go', '--cache', '--out', path.join(dir, 'out'), file], {
    cwd: dir,
  });
  assert.equal(r.status, 0, 'cache IO failure must not fail the command');
  assert.ok(fs.existsSync(path.join(dir, 'out', 'go.mod')), 'output was still generated');
});
