/**
 * `bridge search <query> [--registry dir|url] …` — search published contracts.
 */
import { RegistryStore } from '@bridge/registry';
import { ParsedArgs, positionals } from '../args';
import { out } from '../output';
import { registryCliError, registryDir } from '../registry-cli';
import { httpSearch, RegistryTarget, resolveRegistryTarget } from '../registry-http';

export async function run(args: ParsedArgs): Promise<void> {
  const pos = positionals(args, 'search', '<query>', 1, 1);
  const query = pos[0] as string;
  const target: RegistryTarget = resolveRegistryTarget(args, { command: 'search' });

  let results;
  if (target.kind === 'http') {
    try {
      results = await httpSearch(target, query);
    } catch (e) {
      throw registryCliError(e);
    }
  } else {
    const store = new RegistryStore(registryDir(args));
    try {
      results = store.search(query);
    } catch (e) {
      throw registryCliError(e);
    }
  }

  if (results.length === 0) {
    const label = target.kind === 'http' ? target.baseUrl : target.root;
    out(`no contracts matching '${query}' (registry ${label})`);
    return;
  }

  out(`${results.length} result(s) for '${query}':`);
  for (const meta of results) {
    const bits = [
      `${meta.packageName}@${meta.version}`,
      meta.shortHash,
    ];
    if ('owner' in meta && meta.owner !== undefined) bits.push(meta.owner);
    if ('publishedBy' in meta && meta.publishedBy !== undefined) bits.push(meta.publishedBy);
    if (meta.description !== undefined) bits.push(`— ${meta.description}`);
    out(`  ${bits.join('  ')}`);
  }
}
