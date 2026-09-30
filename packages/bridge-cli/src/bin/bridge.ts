#!/usr/bin/env node
/**
 * `bridge` — the Bridge IDL command line interface.
 *
 * Zero runtime dependencies beyond @bridge/* workspace packages.
 */
import { main } from '../main';

// Downstream pipes close early (`bridge version | head -1`): Node surfaces
// that as an EPIPE error on stdout. Exit quietly — a closed pipe is the
// consumer's backpressure, not a CLI failure. Any other stdout error is a
// real problem: rethrow it through the uncaughtException path (exit 1).
process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EPIPE') process.exit(0);
  throw e;
});

// Registry commands await HTTP responses; `main` catches every command error
// internally and maps it to a process exit code, so the promise itself can
// only reject on an internal bug — surface that honestly instead of hanging.
void main(process.argv.slice(2)).catch((e: unknown) => {
  console.error(`bridge: internal error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exitCode = 1;
});
