/**
 * `bridge init [dir]` — scaffold a Bridge project.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ParsedArgs, positionals } from '../args';
import { CONFIG_FILE } from '../config';
import { CliError } from '../errors';
import { out, CHECK } from '../output';
import { MINIMAL_STARTER, PAYMENTS_STARTER } from '../schema';

export function run(args: ParsedArgs): void {
  const pos = positionals(args, 'init', '[dir]', 0, 1);
  const dir = pos[0] ?? '.';
  const minimal = args.flags.has('--minimal');

  const contractPath = path.join(dir, 'bridge.bridge');
  const configPath = path.join(dir, CONFIG_FILE);

  // Exclusive-create writes ('wx') make the no-overwrite guarantee race-free:
  // the kernel refuses if the target appears between the check and the write.
  // EEXIST maps to the same friendly error the old existsSync check produced.
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(contractPath, minimal ? MINIMAL_STARTER : PAYMENTS_STARTER, { encoding: 'utf8', flag: 'wx' });
    const config = { version: 1, source: 'bridge.bridge', out: 'generated' };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException | null)?.code === 'EEXIST') {
      throw new CliError(`refusing to overwrite existing file(s): ${(e as NodeJS.ErrnoException).path ?? contractPath}`);
    }
    throw new CliError(`cannot scaffold project in ${dir}: ${e instanceof Error ? e.message : String(e)}`);
  }

  out(`${CHECK} created Bridge project in ${path.resolve(dir)}`);
  out('');
  out('  bridge.bridge    contract source (edit me)');
  out(`  ${CONFIG_FILE.padEnd(17)}project configuration`);
  out('');
  out('Next steps:');
  if (dir !== '.') out(`  cd ${dir}`);
  out('  bridge validate                            # check the contract compiles');
  out('  bridge generate --language typescript      # generate client code');
  out('  bridge publish bridge.bridge --owner you   # share via the local registry');
}
