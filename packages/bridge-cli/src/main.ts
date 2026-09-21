/**
 * Command dispatch for the `bridge` CLI.
 *
 * Exit codes: 0 success · 1 error (compile errors, failed checks, registry
 * failures, missing files) · 2 usage error. User-facing failures are thrown
 * as {@link CliError} and rendered as plain messages — never stack traces.
 */
import { ImpactError } from '@bridge/compat';
import { ArgSpec, parseArgs, ParsedArgs } from './args';
import { CliError } from './errors';
import { errOut } from './output';
import { isRegistryError, registryCliError } from './registry-cli';
import { GENERAL_USAGE } from './usage';
import * as check from './commands/check';
import * as diff from './commands/diff';
import * as doctor from './commands/doctor';
import * as generate from './commands/generate';
import * as help from './commands/help';
import * as impact from './commands/impact';
import * as init from './commands/init';
import * as inspect from './commands/inspect';
import * as fmt from './commands/fmt';
import * as lint from './commands/lint';
import * as publish from './commands/publish';
import * as pull from './commands/pull';
import * as search from './commands/search';
import * as validate from './commands/validate';
import * as version from './commands/version';
import * as versions from './commands/versions';

interface CommandEntry {
  readonly spec: ArgSpec;
  readonly run: (args: ParsedArgs) => void;
}

const COMMANDS: Record<string, CommandEntry> = {
  init: { spec: { flags: ['--minimal'] }, run: init.run },
  validate: { spec: { flags: ['--json'] }, run: validate.run },
  fmt: { spec: { shortFlags: ['-w'] }, run: fmt.run },
  lint: { spec: { flags: ['--strict'] }, run: lint.run },
  generate: {
    spec: { flags: ['--force'], options: ['--language', '--out', '--package-name'] },
    run: generate.run,
  },
  diff: { spec: { flags: ['--compatible'] }, run: diff.run },
  check: {
    spec: {
      flags: ['--json', '--compatible', '--strict'],
      options: ['--against', '--registry', '--format'],
    },
    run: check.run,
  },
  impact: {
    spec: { flags: ['--strict'], options: ['--to', '--registry', '--format'] },
    run: impact.run,
  },
  publish: {
    spec: {
      options: [
        '--registry', '--owner', '--description', '--version', '--token', '--org', '--project',
        '--signing-key-id', '--signing-key-file',
      ],
    },
    run: publish.run,
  },
  pull: {
    spec: { options: ['--registry', '--out', '--token', '--org', '--project'] },
    run: pull.run,
  },
  versions: {
    spec: { options: ['--registry', '--token', '--org', '--project'] },
    run: versions.run,
  },
  inspect: {
    spec: { options: ['--registry', '--token', '--org', '--project'] },
    run: inspect.run,
  },
  search: {
    spec: { options: ['--registry', '--token', '--org', '--project'] },
    run: search.run,
  },
  doctor: { spec: { options: ['--registry'] }, run: doctor.run },
  version: { spec: {}, run: version.run },
  help: { spec: {}, run: help.run },
};

export async function main(argv: readonly string[]): Promise<void> {
  if (argv.length === 0) {
    errOut(GENERAL_USAGE);
    process.exitCode = 2;
    return;
  }

  const command = argv[0] as string;
  const entry = COMMANDS[command];
  if (entry === undefined) {
    errOut(`bridge: unknown command '${command}'`);
    errOut('');
    errOut("Run 'bridge help' to list available commands.");
    process.exitCode = 2;
    return;
  }

  try {
    const parsed = parseArgs(argv.slice(1), entry.spec, command);
    await entry.run(parsed);
  } catch (e) {
    fail(command, e);
  }
}

/** Render a failure as a plain message and set the exit code. */
function fail(command: string, e: unknown): void {
  if (e instanceof CliError) {
    errOut(`bridge: ${e.message}`);
    if (e.exitCode === 2) {
      errOut('');
      errOut(`Run 'bridge help ${command}' for usage.`);
    }
    process.exitCode = e.exitCode;
    return;
  }
  if (e instanceof ImpactError) {
    errOut(`bridge: impact analysis failed: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  if (isRegistryError(e)) {
    errOut(`bridge: ${registryCliError(e).message}`);
    process.exitCode = 1;
    return;
  }
  errOut(`bridge: internal error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exitCode = 1;
}
