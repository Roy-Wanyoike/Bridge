/**
 * Registry helpers: root-directory resolution (--registry > BRIDGE_REGISTRY
 * > ./.bridge-registry) and translation of RegistryError codes into
 * friendly CLI errors with actionable hints.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RegistryError } from '@bridge/registry';
import { ParsedArgs } from './args';
import { CliError, describeError } from './errors';

export const DEFAULT_REGISTRY_DIR = '.bridge-registry';

/** HTTP(S) registry targets are not filesystem directories — fail fast. */
export function isHttpRegistryTarget(target: string): boolean {
  return /^https?:\/\//i.test(target);
}

/** Resolve the registry root for the current invocation. */
export function registryDir(args: ParsedArgs): string {
  const flag = args.values.get('--registry');
  const env = process.env['BRIDGE_REGISTRY'];
  const target = flag ?? (env !== undefined && env.length > 0 ? env : undefined);
  if (target !== undefined) {
    if (isHttpRegistryTarget(target)) {
      throw new CliError(
        `registry: '${target}' is an HTTP(S) URL, but this command talks to a filesystem registry`,
        2,
      );
    }
    return target;
  }
  return path.join(process.cwd(), DEFAULT_REGISTRY_DIR);
}

export function isRegistryError(e: unknown): e is RegistryError {
  return e instanceof RegistryError;
}

/** Map any thrown value from a registry operation to a CLI error. */
export function registryCliError(e: unknown): CliError {
  if (isRegistryError(e)) {
    switch (e.code) {
      case 'not-found':
        return new CliError(`${e.message}\nhint: run 'bridge search <query>' or 'bridge versions <package>' to see what is published.`);
      case 'immutable':
        return new CliError(
          `${e.message}\nhint: bump the final segment of the package name (e.g. .v2), ` +
          `or pass --version for versionless names.`,
        );
      case 'hash-conflict':
        return new CliError(`${e.message}\nhint: this indicates store tampering or an SHA-256 collision — verify the registry directory.`);
      case 'invalid-name':
        return new CliError(`${e.message}\nhint: package names are dotted lowercase identifiers with an optional version segment, e.g. payments.v1.`);
      case 'invalid-version':
        return new CliError(`${e.message}\nhint: versions look like v1, v2, v10 — and must match the package name's version segment when present.`);
      case 'corrupt':
        return new CliError(`${e.message}\nhint: stored registry data failed an integrity check — restore the directory or republish.`);
      case 'io':
        return new CliError(`registry I/O failure: ${e.message}${e.cause !== undefined ? ` (${describeError(e.cause)})` : ''}`);
    }
  }
  return new CliError(describeError(e));
}

/** Whether a directory exists and accepts writes. */
export function checkWritable(dir: string): true | string {
  try {
    const probe = path.join(dir, `.bridge-doctor-${process.pid}-${Date.now()}.tmp`);
    fs.writeFileSync(probe, 'bridge doctor write probe');
    fs.unlinkSync(probe);
    return true;
  } catch (e) {
    return describeError(e);
  }
}
