/**
 * `bridge doctor [--registry dir]` — environment diagnostics.
 */
import * as fs from 'node:fs';
import { compileSource } from '@bridge/core';
import { generate, GENERATOR_VERSION } from '@bridge/generators';
import { ParsedArgs } from '../args';
import { CliError } from '../errors';
import { out, CHECK, CROSS } from '../output';
import { registryDir, checkWritable } from '../registry-cli';
import { MINIMAL_STARTER } from '../schema';

interface Check {
  readonly ok: boolean;
  readonly detail: string;
}

export function run(args: ParsedArgs): void {
  const checks: Check[] = [];

  // 1. Node version (monorepo requires >= 22).
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  checks.push({
    ok: major >= 22,
    detail: `node ${process.versions.node} (requires >= 22)`,
  });

  // 2. Workspace package resolution.
  const pkgs = ['@bridge/core', '@bridge/compat', '@bridge/generators', '@bridge/registry'] as const;
  const versions: string[] = [];
  let packagesOk = true;
  for (const name of pkgs) {
    const resolved = resolveVersion(name);
    if (resolved === undefined) packagesOk = false;
    versions.push(`${name.replace('@bridge/', '')} ${resolved ?? 'NOT RESOLVABLE'}`);
  }
  checks.push({ ok: packagesOk, detail: versions.join(', ') });

  // 3. Compiler smoke test on an embedded minimal schema.
  const compiled = compileSource(MINIMAL_STARTER, 'bridge-doctor.bridge');
  const errorDiagnostics = compiled.diagnostics.filter((d) => d.severity === 'error');
  checks.push({
    ok: compiled.ok && errorDiagnostics.length === 0,
    detail:
      compiled.ok && errorDiagnostics.length === 0
        ? `compiler ok ('${compiled.ir?.name}', ${compiled.diagnostics.length} diagnostics)`
        : `compiler failed on the embedded sample schema (${errorDiagnostics.length} error(s))`,
  });

  // 4. Generator smoke test (TypeScript target).
  if (compiled.ok && compiled.ir) {
    const files = generate(compiled.ir, { language: 'typescript' });
    checks.push({
      ok: files.length > 0,
      detail: `generator ${GENERATOR_VERSION} ok (typescript: ${files.length} files)`,
    });
  } else {
    checks.push({ ok: false, detail: `generator skipped (compiler failed)` });
  }

  // 5. Registry directory: existence + writability. statSync can still fail
  // after existsSync (the path may vanish or change mid-check), so it is
  // wrapped — a doctor diagnostic must never surface as a raw stack trace.
  const root = registryDir(args);
  if (!fs.existsSync(root)) {
    checks.push({ ok: true, detail: `registry ${root} (absent — created on first publish)` });
  } else {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(root);
    } catch (e) {
      throw new CliError(`cannot inspect registry ${root}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!stat.isDirectory()) {
      checks.push({ ok: false, detail: `registry ${root} exists but is not a directory` });
    } else {
      const writable = checkWritable(root);
      checks.push({
        ok: writable === true,
        detail: `registry ${root} (${writable === true ? 'writable' : `not writable: ${writable}`})`,
      });
    }
  }

  for (const check of checks) {
    out(`${check.ok ? CHECK : CROSS} ${check.detail}`);
  }

  if (checks.some((c) => !c.ok)) {
    throw new CliError(`doctor found ${checks.filter((c) => !c.ok).length} problem(s)`);
  }
}

/** Resolve a workspace package's version from its package.json, if possible. */
function resolveVersion(name: string): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require(`${name}/package.json`) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return undefined;
  }
}
