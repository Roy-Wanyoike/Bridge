/**
 * `bridge versions <package> [--registry dir|url] …` — list published
 * versions, oldest → newest, marking the latest.
 */
import { RegistryStore, compareVersions } from '@bridge/registry';
import { ParsedArgs, positionals } from '../args';
import { CliError } from '../errors';
import { out } from '../output';
import { registryCliError, registryDir } from '../registry-cli';
import { httpVersions, RegistryTarget, resolveRegistryTarget } from '../registry-http';

export async function run(args: ParsedArgs): Promise<void> {
  const pos = positionals(args, 'versions', '<package>', 1, 1);
  const packageName = pos[0] as string;
  const target: RegistryTarget = resolveRegistryTarget(args, {
    command: 'versions',
    requireOrgProject: true,
  });

  if (target.kind === 'http') {
    let versions: string[];
    try {
      versions = await httpVersions(target, packageName);
    } catch (e) {
      throw registryCliError(e);
    }
    if (versions.length === 0) {
      throw new CliError(`no versions published for '${packageName}' in ${target.baseUrl} (org ${target.org}, project ${target.project})`);
    }
    const latest = versions.slice().sort(compareVersions).at(-1);
    out(`${packageName} (${versions.length} version(s), registry ${target.baseUrl} — org ${target.org}, project ${target.project}):`);
    for (const version of versions) {
      out(`  ${version}${version === latest ? '  (latest)' : ''}`);
    }
    return;
  }

  const store = new RegistryStore(registryDir(args));

  let versions: string[];
  let latest: string;
  try {
    versions = store.versions(packageName);
    latest = store.latest(packageName).version;
  } catch (e) {
    throw registryCliError(e);
  }

  if (versions.length === 0) {
    throw new CliError(`no versions published for '${packageName}' in ${store.paths.root}`);
  }

  out(`${packageName} (${versions.length} version(s), registry ${store.paths.root}):`);
  for (const version of versions) {
    out(`  ${version}${version === latest ? '  (latest)' : ''}`);
  }
}
