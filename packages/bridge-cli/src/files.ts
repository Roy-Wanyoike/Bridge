/**
 * Shared file-reading helpers and implicit input resolution.
 */
import * as fs from 'node:fs';
import { ParsedArgs } from './args';
import { CONFIG_FILE, loadConfig } from './config';
import { CliError, UsageError, describeError } from './errors';

/** Read a UTF-8 file or fail with a friendly (never stack-trace) error. */
export function readText(file: string): string {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(file);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT') throw new CliError(`file not found: ${file}`);
    if (code === 'EISDIR') throw new CliError(`${file} is a directory, not a file`);
    throw new CliError(`cannot read ${file}: ${describeError(e)}`);
  }
  const text = raw.toString('utf8');
  // Node's utf8 decoding silently replaces invalid byte sequences with U+FFFD,
  // which would feed corrupted source to the compiler with no complaint.
  // Round-tripping the decoded text catches that: any replaced byte re-encodes
  // differently than it was read.
  if (!raw.equals(Buffer.from(text, 'utf8'))) {
    throw new CliError(`${file} is not valid UTF-8`);
  }
  return text;
}

/**
 * Resolve the input files for a command: explicit positionals win; else the
 * `source` from bridge.json in the current directory; else a usage error.
 */
export function inputFiles(args: ParsedArgs, command: string): string[] {
  if (args.positionals.length > 0) return [...args.positionals];
  const config = loadConfig();
  if (config) return [config.source];
  throw new UsageError(
    `no input files for 'bridge ${command}' — pass .bridge files or run inside a project with ${CONFIG_FILE}`,
  );
}
