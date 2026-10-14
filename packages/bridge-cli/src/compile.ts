/**
 * Compile helpers shared by validate/lint/generate/diff/check/publish.
 */
import * as path from 'node:path';
import {
  compileSource,
  createCompileCache,
  formatDiagnostics,
  IRPackage,
  CompileResult,
} from '@bridge/core';
import { CliError } from './errors';
import { readText } from './files';

export interface Compiled {
  readonly file: string;
  readonly text: string;
  readonly ir: IRPackage;
}

/** Options for {@link compileOrThrow}. */
export interface CompileOptions {
  /**
   * Consult/populate the on-disk compile cache (`.bridge-cache/` in the
   * current project directory). Opt-in: callers derive it from the `--cache`
   * flag plus the BRIDGE_CACHE environment variable via {@link cacheRequested}.
   * Entries are keyed by (cache format version, compiler version, file path,
   * source hash), so a hit returns the stored result verbatim — byte-identical
   * to a fresh compile — and any source change or compiler upgrade recompiles.
   */
  readonly cache?: boolean;
}

/**
 * Resolve the cache decision for one invocation: an explicit `--cache` flag
 * wins, else the BRIDGE_CACHE environment variable ('1' or 'true') opts in.
 */
export function cacheRequested(flag: boolean): boolean {
  if (flag) return true;
  const env = process.env['BRIDGE_CACHE'];
  return env === '1' || env === 'true';
}

const CACHE_DIR_NAME = '.bridge-cache';

/**
 * Compile with the cache: on a hit return the stored result untouched; on a
 * miss compile fresh and store the result (including failed compiles — the
 * rendered diagnostics are byte-identical on a later hit).
 *
 * The cache must never break a command: `get` never throws by design, and
 * `set` IO errors (unwritable/missing directory) degrade to plain no-cache
 * compilation here.
 */
function cachedResult(text: string, file: string): CompileResult {
  const cache = createCompileCache(path.join(process.cwd(), CACHE_DIR_NAME));
  const hit = cache.get(text, file);
  if (hit !== undefined) return hit;
  const fresh = compileSource(text, file);
  try {
    cache.set(text, fresh, file);
  } catch {
    // set propagates IO errors by design ("the caller owns the directory");
    // a broken cache location must not fail the command.
  }
  return fresh;
}

/**
 * Read + compile one file. Compile errors are rendered with source context
 * and thrown as a {@link CliError} (exit 1) — never a stack trace.
 */
export function compileOrThrow(file: string, options: CompileOptions = {}): Compiled {
  const text = readText(file);
  const result = options.cache ? cachedResult(text, file) : compileSource(text, file);
  if (!result.ok || !result.ir) {
    throw new CliError(`${file} does not compile:\n\n${formatDiagnostics(result.diagnostics, text)}`);
  }
  return { file, text, ir: result.ir };
}
