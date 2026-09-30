#!/usr/bin/env node
/**
 * Docs-facts gate: fails CI when the documentation drifts from verified
 * reality. Zero dependencies — plain Node (no packages, no network).
 *
 * Two checks over the user-facing docs:
 *   1. STALE: no doc may contain a retired test-count string
 *      ("669", "669+", "711" as a count) — these numbers have been wrong
 *      before and silently survived multiple doc passes.
 *   2. REQUIRED: each doc must still carry its canonical facts (the
 *      measured suite size and per-package breakdown, the dashboard's
 *      separate suite, the honest local-only gate phrasing, the release
 *      guard description), so a future edit cannot silently drop them.
 *
 * When the suite size legitimately changes, update the docs AND the
 * numbers below in the same commit.
 *
 * Run: node scripts/check-docs-facts.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DOC_FILES = [
  'README.md',
  'CONTRIBUTING.md',
  'CHANGELOG.md',
  'RELEASE.md',
  'docs/TESTING.md',
  'docs/ROADMAP.md',
  'docs/strategy/MARKET_ANALYSIS.md',
  'docs/strategy/POSITIONING.md',
];

/** Retired test counts that must never reappear in the docs above. */
const STALE_PATTERNS = [
  { label: 'old count "669" (pre-platform-era suite size)', regex: /669/ },
  { label: 'old count "711 tests"', regex: /711 tests/i },
  { label: 'old count "711"', regex: /\b711\b/ },
];

/** Canonical facts each doc must contain (verified suite: 831 + dashboard 94). */
const REQUIRED = [
  {
    file: 'README.md',
    needles: [
      '831 tests',
      'CLI 136',
      'compat 109',
      'core 172',
      'FFI 12',
      'generators 86',
      'LSP 38',
      'registry 65',
      'registry-service 101',
      'serialization 112',
      '94-test dashboard suite',
      'doctor/version/help',
      'Generated Go, Rust, Java and C# are compile-verified in CI',
      'scripts/verify-ts.sh',
      'scripts/verify-python.sh',
      'issues/127',
    ],
  },
  {
    file: 'CONTRIBUTING.md',
    needles: [
      '831 tests',
      'CLI 136',
      'serialization 112',
      '94-test suite',
      'dashboard/',
    ],
  },
  {
    file: 'docs/TESTING.md',
    needles: [
      '831 tests',
      'CLI 136',
      'registry-service 101',
      'serialization 112',
      '94 tests',
      'verify-events-rpc.sh',
    ],
  },
  {
    file: 'docs/ROADMAP.md',
    needles: [
      '831 tests',
      'registry-service 101',
      '94-test dashboard suite',
      'not wired into any CI workflow',
      'Go/Rust/Java/C# compile-verified in CI',
      'issues/127',
    ],
  },
  {
    file: 'docs/strategy/MARKET_ANALYSIS.md',
    needles: ['831 tests', '831 green tests'],
  },
  {
    file: 'docs/strategy/POSITIONING.md',
    needles: ['831 tests', '831 green tests', 'compile-verified in CI'],
  },
  {
    file: 'CHANGELOG.md',
    needles: [
      '## [Unreleased]',
      '[0.2.1]: https://github.com/Roy-Wanyoike/bridge/releases/tag/v0.2.1',
    ],
  },
  {
    file: 'RELEASE.md',
    needles: [
      'CLI_VERSION',
      'sha256 :no_check',
      '1.2.23',
      'derived from',
    ],
  },
];

const failures = [];

for (const rel of DOC_FILES) {
  let text;
  try {
    text = readFileSync(path.join(ROOT, rel), 'utf8');
  } catch (err) {
    failures.push(`${rel}: unreadable (${err.code ?? err.message})`);
    continue;
  }

  for (const { label, regex } of STALE_PATTERNS) {
    if (regex.test(text)) {
      failures.push(`${rel}: stale fact found — ${label}`);
    }
  }

  const req = REQUIRED.find((r) => r.file === rel);
  if (req === undefined) continue;
  for (const needle of req.needles) {
    if (!text.includes(needle)) {
      failures.push(`${rel}: missing canonical fact — ${JSON.stringify(needle)}`);
    }
  }
}

if (failures.length > 0) {
  console.error('check-docs-facts: FAILED — docs contradict verified reality:');
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  console.error('Update the docs to the measured numbers (see worklog/task notes)');
  console.error('and update STALE_PATTERNS / REQUIRED here in the same commit.');
  process.exit(1);
}

console.log(`check-docs-facts: OK — ${DOC_FILES.length} docs free of stale counts, all canonical facts present.`);
