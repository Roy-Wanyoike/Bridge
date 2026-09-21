#!/usr/bin/env node
/**
 * `bridge` — the Bridge IDL command line interface.
 *
 * Zero runtime dependencies beyond @bridge/* workspace packages.
 */
import { main } from '../main';

// Registry commands await HTTP responses; `main` catches every command error
// internally and maps it to a process exit code, so the promise itself can
// only reject on an internal bug — surface that honestly instead of hanging.
void main(process.argv.slice(2)).catch((e: unknown) => {
  console.error(`bridge: internal error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exitCode = 1;
});
