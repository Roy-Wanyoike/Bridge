/**
 * Storage driver shared helpers: defensive coordinate validation and the
 * content-addressed integrity checks both implementations rely on.
 *
 * The identity of a contract version is `hashPackage(ir)` — the same
 * SHA-256-of-canonical-JSON content address used by `@bridge/registry`'s
 * filesystem store — so hashes computed by the CLI compile pipeline match
 * hashes stored here byte for byte.
 */

import { hashPackage } from '@bridge/core';
import { RegistryError } from '@bridge/registry';
import { normalizeVersion, splitPackageVersion } from '@bridge/registry';
import type { ContractMeta, PublishInput } from '../types';
import { assertOrgOrProject, isPlainObject, isValidContractName } from '../validation';

/** Validate and normalize tenant coordinates. Returns the (org, project). */
export function assertCoordinates(org: string, project: string): { org: string; project: string } {
  return { org: assertOrgOrProject(org, 'org'), project: assertOrgOrProject(project, 'project') };
}

/** Reduce a route contract name (base or `base.vN`) to its storage base. */
export function baseOfContract(contract: string): string {
  if (!isValidContractName(contract)) {
    throw new RegistryError(
      'invalid-name',
      `Invalid contract name ${JSON.stringify(contract)}: expected dotted lowercase identifiers`,
    );
  }
  return splitPackageVersion(contract).base;
}

/** Normalize a version argument (`'2'`/`'v2'` → `v2`); throws `invalid-version`. */
export function normalizeContractVersion(version: string): string {
  return normalizeVersion(version);
}

/**
 * Build the stored meta for a new version. `owner` is service-controlled:
 * always the org, never client input.
 */
export function buildMeta(input: PublishInput, base: string, version: string, hash: string): ContractMeta {
  const publishedAt = input.publishTime ?? new Date().toISOString();
  const meta: ContractMeta = {
    org: input.org,
    project: input.project,
    packageName: input.ir.name,
    base,
    version,
    hash,
    shortHash: hash.slice(0, 12),
    imports: [...input.ir.imports],
    publishedAt,
    publishedBy: input.publishedBy,
  };
  if (input.meta.description !== undefined) meta.description = input.meta.description;
  if (input.meta.repository !== undefined) meta.repository = input.meta.repository;
  if (input.meta.languages !== undefined) meta.languages = [...input.meta.languages];
  return meta;
}

/**
 * Re-hash the stored IR and compare with the recorded content address.
 * Throws `'corrupt'` on any mismatch (tamper detection on every pull).
 */
export function assertIntegrity(ir: unknown, meta: ContractMeta, where: string): void {
  if (!isPlainObject(ir)) {
    throw new RegistryError('corrupt', `${where}: stored IR is not an object`);
  }
  const actual = hashPackage(ir as never);
  if (actual !== meta.hash) {
    throw new RegistryError(
      'corrupt',
      `${where}: stored content hash ${actual} does not match recorded hash ${meta.hash} — stored data was tampered with`,
    );
  }
}

/** Defensive re-validation of driver-level lookup coordinates. */
export function requireLookupCoordinates(
  org: string,
  project: string,
  contract: string,
  version?: string,
): { org: string; project: string; base: string; version?: string } {
  const coords = assertCoordinates(org, project);
  const base = baseOfContract(contract);
  return { ...coords, base, version: version === undefined ? undefined : normalizeContractVersion(version) };
}
