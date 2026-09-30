/**
 * Issue #118: byte-level snapshots for every generator.
 *
 * CONTRIBUTING.md:55 mandates "Include snapshot tests for every generator";
 * until now the repo shipped zero snapshot files and generator drift was
 * only caught by ad-hoc regex assertions. This file freezes the FULL
 * generated output of all six backends for the ONE canonical fixture,
 * `makePaymentsIR()` from src/test/fixtures.ts (no new IR is introduced):
 *
 *   src/test/__snapshots__/<language>/<generated-path>.snap
 *
 * e.g. src/test/__snapshots__/go/types.go.snap — one file per generated
 * artifact, paths mirroring the generated project layout. Comparisons are
 * BYTE-FOR-BYTE (Buffer.compare, not deepEqual) and drift fails with the
 * first differing line + column + byte offset.
 *
 * Write-once bootstrap: if a snapshot file is MISSING, the per-language
 * test writes it from the current output with a loud message and passes
 * once. Committed files are the preferred state, so the inventory test
 * below FAILS whenever any expected snapshot is absent — a fresh bootstrap
 * can never silently hide a deleted or never-committed snapshot. To
 * re-baseline deliberately: delete the stale .snap file(s), re-run, review
 * the regenerated output, and commit it.
 *
 * Determinism rule: generators must not emit timestamps. The scan below
 * fails on clock reads (new Date(, Utc::now(, datetime.now(, ...), on
 * "generated at/on" phrasing, and on ISO-8601 datetimes that carry
 * fractional seconds or are dated at/near the run date (±1 day). The one
 * ISO datetime allowed in this corpus is the fixture's literal
 * 2026-01-01T00:00:00Z (whole seconds, fixed date) inside
 * tests/roundtrip.rs. If this test ever fires: a REAL timestamp leaked
 * into generated output — fix the generator; do NOT normalize the
 * snapshot to make the suite green.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { generate } from '../index';
import { makePaymentsIR } from './fixtures';
import type { GeneratedFile } from '../gen/input';

const LANGUAGES = ['go', 'rust', 'typescript', 'python', 'java', 'csharp'] as const;
type Language = (typeof LANGUAGES)[number];

// Tests execute from dist/test; snapshots are committed under src/test.
const SNAPSHOT_ROOT = join(__dirname, '..', '..', 'src', 'test', '__snapshots__');

const ir = makePaymentsIR();

function snapshotPath(language: Language, artifactPath: string): string {
  return join(SNAPSHOT_ROOT, language, `${artifactPath}.snap`);
}

/** Recursively lists committed .snap files as <language>/<path>.snap. */
function listSnapshots(): string[] {
  const out: string[] = [];
  if (!existsSync(SNAPSHOT_ROOT)) return out;
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name), join(prefix, entry.name));
      else if (entry.isFile() && entry.name.endsWith('.snap')) {
        out.push(join(prefix, entry.name));
      }
    }
  };
  walk(SNAPSHOT_ROOT, '');
  return out.sort();
}

// ---------------------------------------------------------------------------
// Byte-level diff reporting: first differing line, column, and byte offset.
// ---------------------------------------------------------------------------

interface ByteDiff {
  offset: number;
  line: number;
  column: number;
  actualLine: string;
  expectedLine: string;
}

function firstByteDiff(actual: string, expected: string): ByteDiff | undefined {
  let line = 1;
  let lineStart = 0;
  const max = Math.max(actual.length, expected.length);
  for (let i = 0; i < max; i++) {
    const a = i < actual.length ? actual.charCodeAt(i) : NaN;
    const b = i < expected.length ? expected.charCodeAt(i) : NaN;
    if (a !== b) {
      const endOf = (s: string, from: number): number => {
        const nl = s.indexOf('\n', from);
        return nl === -1 ? s.length : nl;
      };
      return {
        offset: i,
        line,
        column: i - lineStart + 1,
        actualLine: actual.slice(lineStart, endOf(actual, lineStart)),
        expectedLine: expected.slice(lineStart, endOf(expected, lineStart)),
      };
    }
    if (a === 10) {
      // '\n' — both sides matched up to here, so both advance together.
      line += 1;
      lineStart = i + 1;
    }
  }
  return undefined;
}

function excerpt(s: string): string {
  const oneLine = s.replace(/\t/g, '\\t').replace(/\r/g, '\\r');
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine;
}

function assertByteIdentical(language: Language, file: GeneratedFile): void {
  const snapPath = snapshotPath(language, file.path);
  const relative = join('src/test/__snapshots__', language, `${file.path}.snap`);
  if (!existsSync(snapPath)) {
    mkdirSync(dirname(snapPath), { recursive: true });
    writeFileSync(snapPath, file.content, { encoding: 'utf8', flag: 'wx' });
    console.error(
      `[#118] SNAPSHOT BOOTSTRAP: ${relative} was missing and was written from the ` +
        'current output. Review the file, then commit it — committed snapshots ' +
        'are the required state.',
    );
    return;
  }
  const committed = readFileSync(snapPath, 'utf8');
  const generatedBytes = Buffer.from(file.content, 'utf8');
  const committedBytes = Buffer.from(committed, 'utf8');
  if (Buffer.compare(generatedBytes, committedBytes) !== 0) {
    const diff = firstByteDiff(file.content, committed);
    assert.fail(
      `snapshot drift for ${language}/${file.path} (byte-for-byte mismatch)\n` +
        `  snapshot: ${relative}\n` +
        (diff
          ? `  first difference: line ${diff.line}, column ${diff.column}, byte offset ${diff.offset}\n` +
            `  generated: "${excerpt(diff.actualLine)}"\n` +
            `  snapshot:  "${excerpt(diff.expectedLine)}"\n`
          : '  (text compare found no difference but bytes differ — encoding-level drift)\n') +
        '  If the change is intended: delete the stale .snap file and re-run to re-baseline.',
    );
  }
}

// ---------------------------------------------------------------------------
// Inventory: the committed .snap set must EXACTLY match the generated file
// set — no missing files (which the write-once fallback would mask on the
// next run) and no stale files (a dropped artifact). Runs FIRST.
// ---------------------------------------------------------------------------

test('snapshots: inventory matches the generated file set exactly', () => {
  const expected: string[] = [];
  for (const language of LANGUAGES) {
    for (const file of generate(ir, { language })) {
      expected.push(join(language, `${file.path}.snap`));
    }
  }
  expected.sort();
  assert.deepEqual(
    listSnapshots(),
    expected,
    'the committed snapshot set must match generated output exactly; ' +
      'delete stale .snap files, commit new ones (write-once bootstrap documents how)',
  );
});

for (const language of LANGUAGES) {
  test(`snapshots: ${language} output matches committed snapshots byte-for-byte`, () => {
    for (const file of generate(ir, { language })) {
      assertByteIdentical(language, file);
    }
  });
}

test('snapshots: snapshot files are stable across two generations in one run', () => {
  // Determinism hardening on top of the existing generate-twice test:
  // BOTH generations must equal the committed snapshot bytes, and each
  // other, per artifact.
  for (const language of LANGUAGES) {
    const first = generate(ir, { language });
    const second = generate(ir, { language });
    assert.equal(first.length, second.length, `file count changed for ${language}`);
    for (let i = 0; i < first.length; i++) {
      const f1 = first[i] as GeneratedFile;
      const f2 = second[i] as GeneratedFile;
      assert.equal(f1.path, f2.path, `artifact order changed for ${language}`);
      const bytes1 = Buffer.from(f1.content, 'utf8');
      const bytes2 = Buffer.from(f2.content, 'utf8');
      const committed = readFileSync(snapshotPath(language, f1.path), 'utf8');
      const committedBytes = Buffer.from(committed, 'utf8');
      assert.equal(
        Buffer.compare(bytes1, bytes2),
        0,
        `second generation differs from the first for ${language}/${f1.path}`,
      );
      assert.equal(
        Buffer.compare(bytes2, committedBytes),
        0,
        `second generation differs from the committed snapshot for ${language}/${f1.path}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Determinism rule: no timestamps in generated output. Any finding below is
// a REAL BUG in a generator — report and fix the generator; never normalize
// the snapshot.
// ---------------------------------------------------------------------------

/** Clock reads in any backend (C#, Go, Java, JS/TS, Python, Rust). */
const CLOCK_CALL_RE =
  /\b(?:new\s+Date\s*\(|Date\.now\s*\(|time\.Now\s*\(|Utc::now\s*\(|Local::now\s*\(|Instant::now\s*\(|datetime\.(?:now|utcnow)\s*\(|time\.time\s*\(|System\.currentTimeMillis\s*\(|DateTimeOffset\.Now|OffsetDateTime\.now|LocalDateTime\.now)\b/g;

/** ISO-8601 dates/datetimes, with or without a time part. */
const ISO_DATETIME_RE =
  /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;

/** "Generated at/on ..." phrasing (a header would name the clock). */
const GENERATED_AT_RE = /[Gg]enerated\s+(?:at|on)\b/g;

const DAY_MS = 24 * 60 * 60 * 1000;

/** True when the ISO date (YYYY-MM-DD) is within a day of the run date. */
function nearRunDate(isoDate: string): boolean {
  const parsed = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(parsed)) return false;
  return Math.abs(parsed - Date.now()) <= DAY_MS;
}

test('snapshots: generated output contains no timestamps (determinism rule)', () => {
  const findings: string[] = [];
  for (const language of LANGUAGES) {
    for (const file of generate(ir, { language })) {
      const label = `${language}/${file.path}`;
      for (const match of file.content.matchAll(CLOCK_CALL_RE)) {
        findings.push(`${label}: clock read ${JSON.stringify(match[0])}`);
      }
      for (const match of file.content.matchAll(GENERATED_AT_RE)) {
        findings.push(`${label}: generated-at phrase ${JSON.stringify(match[0])}`);
      }
      for (const match of file.content.matchAll(ISO_DATETIME_RE)) {
        const iso = match[0] as string;
        // Fixture literals (2026-01-01T00:00:00Z) are whole-second, fixed
        // dates; a leaked clock read is either "now" (±1 day) or carries
        // fractional seconds from toISOString()-style serialization.
        const hasFraction = /\.\d+/.test(iso);
        if (hasFraction || nearRunDate(iso.slice(0, 10))) {
          findings.push(
            `${label}: datetime literal ${JSON.stringify(iso)} carries fractional ` +
              'seconds or is dated at/near the generation run',
          );
        }
      }
    }
  }
  assert.deepEqual(
    findings,
    [],
    '[#118] generated output contains timestamp-like content — REAL BUG: a ' +
      'generator emitted a timestamp; fix the generator, do not normalize snapshots',
  );
});
