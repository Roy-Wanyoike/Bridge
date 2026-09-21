/**
 * `bridge pull <package> <version> [--registry dir|url] [--out file]` —
 * fetch a published contract; print a summary or write canonical IR JSON.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalJson } from '@bridge/core';
import { IRPackage } from '@bridge/core';
import { RegistryStore } from '@bridge/registry';
import { ParsedArgs, positionals } from '../args';
import { CliError } from '../errors';
import { out, CHECK } from '../output';
import { registryCliError, registryDir } from '../registry-cli';
import { httpPull, RegistryTarget, RemoteContractMeta, resolveRegistryTarget } from '../registry-http';
import { renderShape } from './inspect';

export async function run(args: ParsedArgs): Promise<void> {
  const pos = positionals(args, 'pull', '<package> <version>', 2, 2);
  const [packageName, version] = pos as [string, string];
  const outFile = args.values.get('--out');
  const target: RegistryTarget = resolveRegistryTarget(args, {
    command: 'pull',
    requireOrgProject: true,
  });

  let ir: IRPackage;
  // Filesystem and remote metadata share the fields this command prints;
  // each branch also produces the human-facing registry label.
  let meta: (RemoteContractMeta & { owner?: string }) | Record<string, unknown> & { packageName: string };
  let registryLabel: string;

  if (target.kind === 'http') {
    let pulled;
    try {
      pulled = await httpPull(target, packageName, version);
    } catch (e) {
      throw registryCliError(e);
    }
    ir = pulled.ir;
    meta = pulled.meta;
    registryLabel = `${target.baseUrl} (org ${pulled.meta.org}, project ${pulled.meta.project})`;
  } else {
    const store = new RegistryStore(registryDir(args));
    let pulled;
    try {
      pulled = store.pull(packageName, version);
    } catch (e) {
      throw registryCliError(e);
    }
    ir = pulled.ir;
    meta = pulled.meta as unknown as { packageName: string; [k: string]: unknown };
    registryLabel = store.paths.root;
  }

  const m = meta as { packageName: string; version: string; hash?: string; shortHash?: string; owner?: string; publishedBy?: string; description?: string; publishedAt?: string };

  if (outFile !== undefined) {
    try {
      fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
      fs.writeFileSync(outFile, canonicalJson(ir) + '\n', 'utf8');
    } catch (e) {
      throw new CliError(`cannot write ${outFile}: ${e instanceof Error ? e.message : String(e)}`);
    }
    out(`${CHECK} wrote ${outFile} (${m.packageName}@${m.version}, hash ${m.shortHash})`);
    return;
  }

  out(`${CHECK} pulled ${m.packageName}@${m.version}`);
  out(`    registry: ${registryLabel}`);
  out(`    hash: ${m.hash}`);
  if (m.owner !== undefined) out(`    owner: ${m.owner}`);
  if (m.publishedBy !== undefined) out(`    publishedBy: ${m.publishedBy}`);
  if (m.description !== undefined) out(`    description: ${m.description}`);
  if (m.publishedAt !== undefined) out(`    published: ${m.publishedAt}`);

  const shape = renderShape(ir);
  out(`    types: ${ir.types.length}, services: ${shape.services}, events: ${shape.events}`);
  out(`    imports: ${shape.imports}`);
}
