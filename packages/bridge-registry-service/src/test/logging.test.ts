/**
 * Structured-logging option tests (audit item R3): BRIDGE_LOG_FORMAT=json
 * selects JSON lines, the emitted lines parse as one JSON object per line
 * with time/level/msg, console stays the default, and installation is
 * revertible.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatLogLine, installJsonLogging, logFormatFromEnv } from '../logging';
import type { PatchableConsole } from '../logging';

test('logFormatFromEnv: json only for the exact value, console otherwise', () => {
  assert.equal(logFormatFromEnv({}), 'console');
  assert.equal(logFormatFromEnv({ BRIDGE_LOG_FORMAT: 'json' }), 'json');
  assert.equal(logFormatFromEnv({ BRIDGE_LOG_FORMAT: 'JSON' }), 'json');
  assert.equal(logFormatFromEnv({ BRIDGE_LOG_FORMAT: ' json\n' }), 'json');
  assert.equal(logFormatFromEnv({ BRIDGE_LOG_FORMAT: 'jsonl' }), 'console');
  assert.equal(logFormatFromEnv({ BRIDGE_LOG_FORMAT: 'pretty' }), 'console');
  assert.equal(logFormatFromEnv({ BRIDGE_LOG_FORMAT: '' }), 'console');
});

test('formatLogLine emits one parseable JSON object per call', () => {
  const fixed = (): Date => new Date(Date.parse('2026-10-14T12:00:00.000Z'));
  const line = formatLogLine('info', ['bridge-registry-service listening on port 4350'], fixed);
  const parsed = JSON.parse(line) as { time: string; level: string; msg: string };
  assert.equal(parsed.time, '2026-10-14T12:00:00.000Z');
  assert.equal(parsed.level, 'info');
  assert.equal(parsed.msg, 'bridge-registry-service listening on port 4350');

  // Multi-argument calls join with spaces (audit.dropped style).
  const dropped = JSON.parse(formatLogLine('error', ['audit.dropped', 'disk full'], fixed)) as {
    level: string;
    msg: string;
  };
  assert.equal(dropped.level, 'error');
  assert.equal(dropped.msg, 'audit.dropped disk full');

  // Non-string arguments are JSON-encoded; Errors contribute their message.
  assert.equal(
    (JSON.parse(formatLogLine('warn', ['ctx', { code: 'x' }], fixed)) as { msg: string }).msg,
    'ctx {"code":"x"}',
  );
  assert.equal(
    (JSON.parse(formatLogLine('error', [new Error('boom')], fixed)) as { msg: string }).msg,
    'boom',
  );
});

test('installJsonLogging patches console methods and is revertible', () => {
  const lines: string[] = [];
  const fake: PatchableConsole = {
    log: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
  const restore = installJsonLogging(fake, (line) => lines.push(line));
  try {
    fake.log('rate limiting enabled by default');
    fake.warn('unsigned publishes are accepted');
    fake.error('audit.dropped', 'disk full');
    assert.equal(lines.length, 3);
    const parsed = lines.map((l) => JSON.parse(l) as { level: string; msg: string });
    assert.equal(parsed[0]!.level, 'info');
    assert.equal(parsed[1]!.level, 'warn');
    assert.equal(parsed[2]!.level, 'error');
    assert.equal(parsed[2]!.msg, 'audit.dropped disk full');
  } finally {
    restore();
  }
  // After restore the original (silent test double) behavior is back and no
  // further lines appear.
  fake.log('human readable again');
  assert.equal(lines.length, 3);
});
