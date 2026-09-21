/**
 * `bridge publish <file> [--registry dir|url] [--org org] [--project project]
 *        [--token tok] [--owner name] [--description text] [--version vX]
 *        [--signing-key-id id] [--signing-key-file pem]
 *        [--language go,typescript]` —
 * publish to a filesystem registry or an HTTP registry service.
 */
import { hashPackage } from '@bridge/core';
import { PublishMeta, RegistryStore } from '@bridge/registry';
import { ParsedArgs, positionals } from '../args';
import { compileOrThrow } from '../compile';
import { CliError } from '../errors';
import { out, CHECK } from '../output';
import { registryCliError, registryDir } from '../registry-cli';
import { httpPublish, RegistryTarget, resolveRegistryTarget, resolveSigningMaterial } from '../registry-http';

/** Bounds/shape shared with the service's languages validation (issue #104). */
const MAX_LANGUAGES = 16;
const LANGUAGE_PATTERN = /^[a-z][a-z0-9+#.-]*$/;

/**
 * Parse the `--language go,typescript` list (issue #104): comma-separated,
 * trimmed, lowercased, deduped, bounded. A usage error on junk — the same
 * shape the registry service accepts, checked client-side first.
 */
export function parseLanguages(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  const out: string[] = [];
  for (const token of raw.split(',')) {
    const lang = token.trim().toLowerCase();
    if (lang.length === 0 || lang.length > 32 || !LANGUAGE_PATTERN.test(lang)) {
      throw new CliError(
        `registry: --language entries must be lowercase identifiers of at most 32 characters ` +
          `matching ${LANGUAGE_PATTERN.source} (got ${JSON.stringify(token)})`,
        2,
      );
    }
    if (!out.includes(lang)) out.push(lang);
  }
  if (out.length > MAX_LANGUAGES) {
    throw new CliError(`registry: --language accepts at most ${MAX_LANGUAGES} entries`, 2);
  }
  return out;
}

export async function run(args: ParsedArgs): Promise<void> {
  const pos = positionals(args, 'publish', '<file>', 1, 1);
  const file = pos[0] as string;

  const meta: PublishMeta = {};
  const owner = args.values.get('--owner');
  if (owner !== undefined) meta.owner = owner;
  const description = args.values.get('--description');
  if (description !== undefined) meta.description = description;
  const version = args.values.get('--version');

  const target: RegistryTarget = resolveRegistryTarget(args, {
    command: 'publish',
    requireOrgProject: true,
    rejectOwner: true,
  });
  // Optional ed25519 artifact signing (issue #103): both halves (key + key
  // id) or neither; a lone half is a usage error before any I/O.
  const signing = resolveSigningMaterial(args);
  // Optional generated-language metadata (issue #104): comma-separated
  // list, recorded on HTTP publishes and rendered by the dashboard.
  const languages = parseLanguages(args.values.get('--language'));

  const { ir } = compileOrThrow(file);

  if (target.kind === 'http') {
    try {
      const { outcome, meta: remote } = await httpPublish(
        target,
        ir.name,
        ir,
        { description: meta.description, languages },
        version,
        hashPackage(ir),
        signing,
      );
      out(
        `${CHECK} published ${remote.packageName}@${remote.version} (hash ${remote.shortHash})` +
          (outcome === 'replayed' ? ' — identical content already published' : ''),
      );
      out(`    registry: ${target.baseUrl} (org ${remote.org}, project ${remote.project})`);
      if (remote.publishedBy !== undefined) out(`    publishedBy: ${remote.publishedBy}`);
      if (remote.description !== undefined) out(`    description: ${remote.description}`);
      if (remote.imports.length > 0) out(`    imports: ${remote.imports.join(', ')}`);
    } catch (e) {
      throw registryCliError(e);
    }
    return;
  }

  const store = new RegistryStore(registryDir(args));

  let published;
  try {
    published = store.publish(ir, meta, version !== undefined ? { version } : undefined);
  } catch (e) {
    throw registryCliError(e);
  }

  out(`${CHECK} published ${published.packageName}@${published.version} (hash ${published.shortHash})`);
  out(`    registry: ${store.paths.root}`);
  if (published.owner !== undefined) out(`    owner: ${published.owner}`);
  if (published.description !== undefined) out(`    description: ${published.description}`);
  if (published.imports.length > 0) out(`    imports: ${published.imports.join(', ')}`);
}
