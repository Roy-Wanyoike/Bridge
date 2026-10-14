/**
 * CLI config tests for the hosted-readiness wave:
 * - R2: the memory driver defaults to a FileAuditSink mirror at
 *   ./data/audit.jsonl (BRIDGE_REGISTRY_AUDIT_FILE relocates or disables it;
 *   --audit wins; postgres keeps its durable no-mirror default);
 * - R2: wireFileAuditMirror actually writes JSONL entries and keeps the
 *   driver backend queryable.
 * No sockets are opened.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_AUDIT_FILE,
  buildOptions,
  isAuditFileOffValue,
  parseArgs,
  wireFileAuditMirror,
} from '../bin/bridge-registry-service';
import type { Config } from '../bin/bridge-registry-service';
import { InMemoryDriver } from '../storage/memory';
import type { AuditEntry } from '../types';

/** Run `fn` with a clean env for the variables this suite cares about. */
function withEnv(fn: () => void): void {
  const keys = ['BRIDGE_REGISTRY_AUDIT_FILE', 'BRIDGE_REGISTRY_DRIVER', 'BRIDGE_REGISTRY_PORT', 'BRIDGE_REGISTRY_TOKEN'];
  const saved = new Map<string, string | undefined>();
  for (const key of keys) saved.set(key, process.env[key]);
  for (const key of keys) delete process.env[key];
  try {
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    driver: 'memory',
    tokens: {},
    signingKeys: {},
    signingOptional: false,
    productionProfile: false,
    ...overrides,
  };
}

test('memory driver defaults to the durable audit mirror (audit item R2)', () => {
  withEnv(() => {
    const config = parseArgs([]);
    assert.equal(config.driver, 'memory');
    assert.equal(config.auditFile, DEFAULT_AUDIT_FILE, './data/audit.jsonl is the default mirror path');
  });
});

test('BRIDGE_REGISTRY_AUDIT_FILE relocates or disables the mirror', () => {
  withEnv(() => {
    process.env['BRIDGE_REGISTRY_AUDIT_FILE'] = '/var/log/bridge/audit.jsonl';
    const relocated = parseArgs([]);
    assert.equal(relocated.auditFile, '/var/log/bridge/audit.jsonl');

    process.env['BRIDGE_REGISTRY_AUDIT_FILE'] = 'off';
    const off = parseArgs([]);
    assert.equal(off.auditFile, undefined);
    assert.equal(off.auditFileDisabled, true, 'the off value disables the default explicitly');

    for (const value of ['none', 'false', '0', 'OFF']) {
      assert.equal(isAuditFileOffValue(value), true, `'${value}' disables the mirror`);
    }
    assert.equal(isAuditFileOffValue('./keep.jsonl'), false);
  });
});

test('--audit overrides the default; postgres keeps its no-mirror default', () => {
  withEnv(() => {
    const flagged = parseArgs(['--audit', './ops/audit.jsonl']);
    assert.equal(flagged.auditFile, './ops/audit.jsonl');

    process.env['BRIDGE_REGISTRY_AUDIT_FILE'] = './env/path.jsonl';
    const flagWins = parseArgs(['--audit', './flag/path.jsonl']);
    assert.equal(flagWins.auditFile, './flag/path.jsonl', 'the flag wins over the env');

    const postgres = parseArgs(['--driver', 'postgres', '--pg-dsn', 'postgres://u:p@db/bridge']);
    assert.equal(postgres.auditFile, undefined, 'postgres audit rows are durable + retention-managed');
    assert.equal(postgres.auditFileDisabled, undefined);
  });
});

test('wireFileAuditMirror writes JSONL entries while the driver stays queryable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-audit-'));
  try {
    const file = join(dir, 'audit.jsonl');
    const options = buildOptions(baseConfig());
    assert.equal((options.driver as InMemoryDriver).kind, 'memory');
    assert.equal(options.audit === undefined, true, 'buildOptions does not wire the mirror itself');
    wireFileAuditMirror(options, file);
    const audit = options.audit!;
    assert.ok(audit, 'the mirror becomes the audit backend');

    const entry: AuditEntry = {
      time: new Date().toISOString(),
      org: 'acme',
      project: 'payments',
      actor: 'token:acme',
      action: 'publish',
      contract: 'payments',
      version: 'v1',
      ok: true,
      status: 201,
      ip: '127.0.0.1',
    };
    const appended = audit.append(entry);
    assert.ok(appended instanceof Promise, 'append is async (await-able by the server)');
    await appended;
    const line = JSON.parse(readFileSync(file, 'utf8')) as { action: string };
    assert.equal(line.action, 'publish', 'the JSONL file holds the entry');
    const queried = await audit.query({ org: 'acme' });
    assert.equal(queried.length, 1, 'queries still serve the driver backend');
    assert.equal(queried[0]!.action, 'publish');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('production profile is unaffected by the audit-mirror default', () => {
  withEnv(() => {
    // parseArgs eagerly reads --signing-key files, so the test materializes
    // a throwaway key rather than pointing at a path that does not exist.
    const dir = mkdtempSync(join(tmpdir(), 'bridge-keys-'));
    try {
      const key = join(dir, 'k1.pem');
      writeFileSync(key, '-----BEGIN PUBLIC KEY-----\nTEST\n-----END PUBLIC KEY-----\n', 'utf8');
      const config = parseArgs(['--production-profile', '--signing-key', `k1=${key}`]);
      assert.equal(config.auditFile, DEFAULT_AUDIT_FILE, 'the mirror default applies under every profile');
      assert.equal(config.productionProfile, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
