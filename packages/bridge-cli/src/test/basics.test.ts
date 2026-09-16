/**
 * E2E tests: version/help, init, validate, fmt, lint, doctor — the CLI is
 * spawned as a real child process in isolated temp directories.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { unifiedDiff } from '../difftext';
import { CLI_VERSION } from '../meta';
import { BROKEN, GOOD, run, tmpdir, UGLY, UNPARSEABLE, WARNY, writeFile } from './helpers';
import { GENERATOR_VERSION } from '@bridge/generators';

/** Escape a version string for use inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
// version / help / dispatch
// ---------------------------------------------------------------------------

test('version exits 0 and prints CLI and generator versions', () => {
  const r = run(['version']);
  assert.equal(r.status, 0);
  // Assert against the real constants so the test tracks version bumps
  // instead of pinning a literal that drifts on every release.
  assert.match(r.stdout, new RegExp(`bridge ${escapeRe(CLI_VERSION)}`));
  assert.match(r.stdout, new RegExp(`generator ${escapeRe(GENERATOR_VERSION)}`));
});

test('help exits 0 and lists all commands', () => {
  const r = run(['help']);
  assert.equal(r.status, 0);
  for (const command of [
    'init', 'validate', 'fmt', 'lint', 'generate', 'diff', 'check',
    'publish', 'pull', 'versions', 'inspect', 'search', 'doctor', 'version', 'help',
  ]) {
    assert.ok(r.stdout.includes(command), `help lists ${command}`);
  }
  assert.match(r.stdout, /Exit codes/);
});

test('help <command> shows command-specific usage', () => {
  const r = run(['help', 'publish']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--registry/);
  assert.match(r.stdout, /BRIDGE_REGISTRY/);
});

test('help with unknown command exits 2', () => {
  const r = run(['help', 'nonesuch']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown command 'nonesuch'/);
});

test('unknown command exits 2 with hint', () => {
  const r = run(['transmogrify']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown command 'transmogrify'/);
  assert.match(r.stderr, /bridge help/);
});

test('bare invocation prints usage and exits 2', () => {
  const r = run([]);
  assert.equal(r.status, 2);
  assert.match(r.all, /Usage: bridge <command>/);
});

test('unknown option exits 2 with command hint', () => {
  const r = run(['validate', '--bogus']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown option '--bogus' for 'bridge validate'/);
});

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

test('init scaffolds a project with payments starter and valid config', () => {
  const dir = fresh('init');
  const r = run(['init', dir], { cwd: path.dirname(dir) });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /created Bridge project/);
  assert.match(r.stdout, /Next steps/);

  const config = JSON.parse(fs.readFileSync(path.join(dir, 'bridge.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(config['version'], 1);
  assert.equal(config['source'], 'bridge.bridge');
  assert.equal(config['out'], 'generated');
  assert.ok(fs.readFileSync(path.join(dir, 'bridge.bridge'), 'utf8').includes('package payments.v1'));
});

test('init scaffold compiles out of the box (validate exit 0)', () => {
  const dir = fresh('init-validate');
  run(['init', dir]);
  const r = run(['validate'], { cwd: dir });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /✓ bridge\.bridge ok \(package payments\.v1, hash [0-9a-f]{12}\)/);
});

test('init --minimal scaffolds a compiling minimal contract', () => {
  const dir = fresh('init-minimal');
  run(['init', dir, '--minimal']);
  const r = run(['validate'], { cwd: dir });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /package app\.v1/);
});

test('init refuses to overwrite existing files', () => {
  const dir = fresh('init-overwrite');
  fs.writeFileSync(path.join(dir, 'bridge.bridge'), 'package keep.v1', 'utf8');
  const r = run(['init', dir]);
  assert.equal(r.status, 1);
  assert.match(r.all, /refusing to overwrite/);
  assert.equal(fs.readFileSync(path.join(dir, 'bridge.bridge'), 'utf8'), 'package keep.v1');
});

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

test('validate: ok file exits 0 with ✓, package name and short hash', () => {
  const dir = fresh('validate-ok');
  const file = writeFile(dir, 'good.bridge', GOOD);
  const r = run(['validate', file]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /✓ .*good\.bridge ok \(package shop\.v1, hash [0-9a-f]{12}\)/);
});

test('validate: broken file exits 1 with file:line:col diagnostic and hint', () => {
  const dir = fresh('validate-broken');
  const file = writeFile(dir, 'broken.bridge', BROKEN);
  const r = run(['validate', file]);
  assert.equal(r.status, 1);
  assert.match(r.all, /broken\.bridge:9:13: error BR\d+: /);
  assert.match(r.all, /amount: money/);
  assert.match(r.all, /Did you mean `Money`\?/);
  assert.match(r.stderr, /1 of 1 file\(s\) failed validation/);
});

test('validate: missing file exits 1 with friendly error', () => {
  const r = run(['validate', path.join(fresh('validate-missing'), 'nope.bridge')]);
  assert.equal(r.status, 1);
  assert.match(r.all, /file not found/);
});

test('validate: multiple files — exit 1 when one fails, both reported', () => {
  const dir = fresh('validate-multi');
  const good = writeFile(dir, 'good.bridge', GOOD);
  const bad = writeFile(dir, 'broken.bridge', BROKEN);
  const r = run(['validate', good, bad]);
  assert.equal(r.status, 1);
  assert.match(r.all, /✓ .*good\.bridge ok/);
  assert.match(r.all, /broken\.bridge:9:13/);
  assert.match(r.all, /1 of 2 file\(s\) failed/);
});

test('validate --json: ok output parses with package and hash', () => {
  const dir = fresh('validate-json-ok');
  const file = writeFile(dir, 'good.bridge', GOOD);
  const r = run(['validate', '--json', file]);
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout) as Array<{ file: string; ok: boolean; package?: string; hash?: string; diagnostics: unknown[] }>;
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]!.file, file);
  assert.equal(parsed[0]!.ok, true);
  assert.equal(parsed[0]!.package, 'shop.v1');
  assert.match(parsed[0]!.hash ?? '', /^[0-9a-f]{12}$/);
  assert.deepEqual(parsed[0]!.diagnostics, []);
});

test('validate --json: broken output parses with located diagnostics', () => {
  const dir = fresh('validate-json-broken');
  const file = writeFile(dir, 'broken.bridge', BROKEN);
  const r = run(['validate', '--json', file]);
  assert.equal(r.status, 1);
  const parsed = JSON.parse(r.stdout) as Array<{
    file: string;
    ok: boolean;
    diagnostics: Array<{ severity: string; code: string; line: number; column: number }>;
  }>;
  assert.equal(parsed[0]!.ok, false);
  assert.ok(parsed[0]!.diagnostics.length > 0);
  const first = parsed[0]!.diagnostics[0]!;
  assert.equal(first.severity, 'error');
  assert.match(first.code, /^BR\d+/);
  assert.equal(first.line, 9);
  assert.equal(first.column, 13);
});

test('validate --json: read failure still emits one JSON entry per file', () => {
  const dir = fresh('validate-json-read-failure');
  const good = writeFile(dir, 'good.bridge', GOOD);
  const missing = path.join(dir, 'missing.bridge');
  const r = run(['validate', '--json', good, missing]);
  assert.equal(r.status, 1);
  const parsed = JSON.parse(r.stdout) as Array<{
    file: string;
    ok: boolean;
    diagnostics: Array<{ severity: string; message: string }>;
  }>;
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]!.file, good);
  assert.equal(parsed[0]!.ok, true);
  assert.equal(parsed[1]!.file, missing);
  assert.equal(parsed[1]!.ok, false);
  assert.equal(parsed[1]!.diagnostics.length, 1);
  assert.equal(parsed[1]!.diagnostics[0]!.severity, 'error');
  assert.match(parsed[1]!.diagnostics[0]!.message, /file not found/);
});

test('validate: read failure does not abort the remaining files', () => {
  const dir = fresh('validate-read-failure-continue');
  const missing = path.join(dir, 'missing.bridge');
  const bad = writeFile(dir, 'broken.bridge', BROKEN);
  const r = run(['validate', missing, bad]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /file not found/);
  assert.match(r.all, /broken\.bridge:9:13/); // later file still validated
  assert.match(r.stderr, /2 of 2 file\(s\) failed/);
});

test('validate without files or config is a usage error', () => {
  const dir = fresh('validate-empty');
  const r = run(['validate'], { cwd: dir });
  assert.equal(r.status, 2);
  assert.match(r.all, /no input files/);
});

test('validate falls back to the bridge.json source', () => {
  const dir = fresh('validate-config');
  writeFile(dir, 'contract.bridge', GOOD);
  writeFile(dir, 'bridge.json', JSON.stringify({ version: 1, source: 'contract.bridge', out: 'generated' }));
  const r = run(['validate'], { cwd: dir });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /✓ contract\.bridge ok/);
});

// ---------------------------------------------------------------------------
// fmt
// ---------------------------------------------------------------------------

test('fmt: unformatted file exits 1 and prints a unified diff', () => {
  const dir = fresh('fmt-diff');
  const file = writeFile(dir, 'ugly.bridge', UGLY);
  const r = run(['fmt', file]);
  assert.equal(r.status, 1);
  assert.match(r.all, /--- a\/.*ugly\.bridge/);
  assert.match(r.all, /\+\+\+ b\/.*ugly\.bridge/);
  assert.match(r.all, /@@ -\d+,\d+ \+\d+,\d+ @@/);
  assert.match(r.all, /^- {2}amount: int64$/m);
  assert.match(r.all, /^\+ {4}amount: int64$/m);
  assert.match(r.stderr, /need formatting/);
});

test('fmt -w rewrites the file in place; second run reports clean', () => {
  const dir = fresh('fmt-write');
  const file = writeFile(dir, 'ugly.bridge', UGLY);
  const first = run(['fmt', '-w', file]);
  assert.equal(first.status, 0);
  assert.match(first.stdout, /✓ formatted .*ugly\.bridge/);

  const formatted = fs.readFileSync(file, 'utf8');
  assert.match(formatted, /^ {4}amount: int64$/m); // canonical 4-space indent
  assert.match(formatted, /^package shop\.v1\n\n/m); // blank line restored

  const second = run(['fmt', file]);
  assert.equal(second.status, 0);
  assert.match(second.stdout, /already formatted/);
});

test('fmt: unparseable file exits 1 with diagnostics', () => {
  const dir = fresh('fmt-broken');
  const file = writeFile(dir, 'broken.bridge', UNPARSEABLE);
  const r = run(['fmt', file]);
  assert.equal(r.status, 1);
  assert.match(r.all, /error BR\d+/);
  assert.match(r.stderr, /could not be formatted/);
});

test('fmt: diff hunk headers carry git-verified values', () => {
  // UGLY formats to: blank line inserted after line 1 + 2-space re-indent.
  // a-side: package / 'type Money {' / '  amount: int64' / '}' → 4 lines;
  // b-side: package / '' / 'type Money {' / '    amount: int64' / '}' → 5.
  const dir = fresh('fmt-headers');
  const file = writeFile(dir, 'ugly.bridge', UGLY);
  const r = run(['fmt', file]);
  assert.equal(r.status, 1);
  const headers = r.stdout.split('\n').filter((l) => l.startsWith('@@'));
  assert.deepEqual(headers, ['@@ -1,4 +1,5 @@']);
});

// ---------------------------------------------------------------------------
// lint
// ---------------------------------------------------------------------------

test('lint: clean file exits 0', () => {
  const dir = fresh('lint-clean');
  const file = writeFile(dir, 'good.bridge', GOOD);
  const r = run(['lint', file]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /✓ .*good\.bridge ok/);
});

test('lint: warning tolerated by default (exit 0) but reported', () => {
  const dir = fresh('lint-warn');
  const file = writeFile(dir, 'warny.bridge', WARNY);
  const r = run(['lint', file]);
  assert.equal(r.status, 0);
  assert.match(r.all, /warny\.bridge:3:1: warning BR\d+/);
  assert.match(r.all, /not PascalCase/);
  assert.match(r.all, /tolerated/);
});

test('lint --strict: warning fails (exit 1)', () => {
  const dir = fresh('lint-strict');
  const file = writeFile(dir, 'warny.bridge', WARNY);
  const r = run(['lint', '--strict', file]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /lint failed \(--strict\)/);
});

test('lint: tolerated-findings note goes to stderr, not stdout', () => {
  const dir = fresh('lint-warn-stderr');
  const file = writeFile(dir, 'warny.bridge', WARNY);
  const r = run(['lint', file]);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /⚠ 1 finding\(s\) tolerated/);
  assert.ok(!r.stdout.includes('tolerated'), 'note must not be on stdout');
  assert.match(r.stdout, /warny\.bridge:3:1: warning BR\d+/); // report stays on stdout
});

test('lint: error-severity diagnostic fails (exit 1)', () => {
  const dir = fresh('lint-error');
  const file = writeFile(dir, 'broken.bridge', BROKEN);
  const r = run(['lint', file]);
  assert.equal(r.status, 1);
  assert.match(r.all, /error BR\d+/);
  assert.match(r.stderr, /lint failed: \d+ error/);
});

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

test('doctor exits 0 with ✓ lines in a sane environment', () => {
  const dir = fresh('doctor');
  const r = run(['doctor'], { cwd: dir });
  assert.equal(r.status, 0);
  const lines = r.stdout.split('\n').filter((l) => l.length > 0);
  assert.ok(lines.length >= 5, `expected at least 5 checks, got ${lines.length}`);
  for (const line of lines) assert.ok(line.startsWith('✓'), `all checks pass: ${line}`);
  assert.match(r.stdout, /node \d+\.\d+\.\d+/);
  assert.match(r.stdout, /compiler ok/);
  assert.match(r.stdout, new RegExp(`generator ${escapeRe(GENERATOR_VERSION)} ok`));
  assert.match(r.stdout, /registry .*absent/);
});

test('doctor fails when the registry path is a file (not a directory)', () => {
  const dir = fresh('doctor-registry-file');
  const bogus = writeFile(dir, 'registry-file', 'not a directory');
  const r = run(['doctor', '--registry', bogus], { cwd: dir });
  assert.equal(r.status, 1);
  assert.match(r.all, /✗ registry .*not a directory/);
});

// ---------------------------------------------------------------------------
// argument parsing (flag-as-value / empty inline values)
// ---------------------------------------------------------------------------

test('args: a flag is rejected as an option value (exit 2)', () => {
  const r = run(['doctor', '--registry', '--json']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /'--registry' requires a value/);
  assert.match(r.stderr, /'--json' is a flag, not a value/);
});

test('args: empty inline option value is rejected (exit 2)', () => {
  const r = run(['doctor', '--registry=']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /requires a non-empty value/);
});

// ---------------------------------------------------------------------------
// help completeness (six languages, check --json/--format precedence)
// ---------------------------------------------------------------------------

test('help lists all six generate languages', () => {
  const general = run(['help']);
  assert.equal(general.status, 0);
  assert.match(general.stdout, /Go\/Rust\/TypeScript\/Python\/Java\/C# code/);
  const generate = run(['help', 'generate']);
  assert.equal(generate.status, 0);
  for (const lang of ['go', 'rust', 'typescript', 'python', 'java', 'csharp']) {
    assert.ok(generate.stdout.includes(lang), `generate help lists ${lang}`);
  }
});

test('help check documents --json vs --format precedence', () => {
  const r = run(['help', 'check']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--json/);
  assert.match(r.stdout, /explicit --format\s+wins when both are given/);
});

// ---------------------------------------------------------------------------
// unified-diff hunk headers (byte-identical to `git diff --no-index`)
// ---------------------------------------------------------------------------

const L = (n: number, from = 0): string[] => Array.from({ length: n }, (_, i) => `line${i + 1 + from}`);
const linesOf = (lines: string[]): string => (lines.length === 0 ? '' : lines.map((l) => `${l}\n`).join(''));
const headers = (lines: string[]): string[] => lines.filter((l) => l.startsWith('@@'));

test('difftext: insertion-only and deletion-only hunks report git-identical ranges', () => {
  // git: @@ -3,6 +3,7 @@ (context 3 before + insertion + context 3 after)
  const inserted = unifiedDiff(linesOf([...L(4), 'alpha', ...L(4, 4)]), linesOf([...L(4), 'alpha', 'INSERTED', ...L(4, 4)]), 'f');
  assert.deepEqual(headers(inserted), ['@@ -3,6 +3,7 @@']);
  // git: @@ -2,7 +2,6 @@
  const deleted = unifiedDiff(linesOf([...L(4), 'alpha', ...L(4, 4)]), linesOf([...L(4), ...L(4, 4)]), 'f');
  assert.deepEqual(headers(deleted), ['@@ -2,7 +2,6 @@']);
});

test('difftext: multi-hunk numbering counts only preceding a-side lines', () => {
  const old = linesOf([...L(2), 'a-old', ...L(20, 2), 'b-old', ...L(2, 22)]);
  const neu = linesOf([...L(2), 'a-new', ...L(20, 2), 'b-new', ...L(2, 22)]);
  assert.deepEqual(headers(unifiedDiff(old, neu, 'f')), ['@@ -1,6 +1,6 @@', '@@ -21,6 +21,6 @@']);
});

test('difftext: trailing context is clipped at EOF', () => {
  const old = linesOf([...L(9), 'last-old']);
  const neu = linesOf([...L(9), 'last-new']);
  assert.deepEqual(headers(unifiedDiff(old, neu, 'f')), ['@@ -7,4 +7,4 @@']);
});

test('difftext: empty-file and whole-file edges use git conventions', () => {
  // whole-file add: old side is position 0 with count 0
  assert.deepEqual(headers(unifiedDiff('', linesOf(L(3)), 'f')), ['@@ -0,0 +1,3 @@']);
  // whole-file delete: new side is position 0 with count 0
  assert.deepEqual(headers(unifiedDiff(linesOf(L(3)), '', 'f')), ['@@ -1,3 +0,0 @@']);
  // single-line counts are omitted (git prints @@ -1 +1 @@, not @@ -1,1 +1,1 @@)
  assert.deepEqual(headers(unifiedDiff('only\n', 'ONLY\n', 'f')), ['@@ -1 +1 @@']);
  // whole-file replace keeps explicit counts
  assert.deepEqual(headers(unifiedDiff('a\nb\nc\nd\n', 'A\nB\nC\nD\n', 'f')), ['@@ -1,4 +1,4 @@']);
  // identical inputs produce no diff at all
  assert.deepEqual(unifiedDiff('same\n', 'same\n', 'f'), []);
});

test('difftext: hunks separated by ≤ 2×context unchanged lines merge (git rule)', () => {
  const wrap = (gap: number): string[] =>
    headers(
      unifiedDiff(
        linesOf([...L(1), 'a-old', ...L(gap, 1), 'b-old', ...L(1, 1 + gap)]),
        linesOf([...L(1), 'a-new', ...L(gap, 1), 'b-new', ...L(1, 1 + gap)]),
        'f',
      ),
    );
  assert.deepEqual(wrap(6), ['@@ -1,10 +1,10 @@']); // 6 apart: one merged hunk
  assert.deepEqual(wrap(7), ['@@ -1,5 +1,5 @@', '@@ -7,5 +7,5 @@']); // 7 apart: two hunks
});
