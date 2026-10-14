/**
 * Structured logging option (audit item R3).
 *
 * The service logs with plain `console.*` calls (human-readable, the
 * default). The CLI entry (`bin/bridge-registry-service.ts`) can switch the
 * whole process to JSON LINES via `BRIDGE_LOG_FORMAT=json`: every
 * `console.log/info/warn/error/debug` call then emits exactly one JSON
 * object per line (`{"time":…,"level":…,"msg":…}`) on stdout, so log
 * shippers can ingest the service without parsing prose.
 *
 * Deliberate scope: this patches the console methods only. `--help`/usage
 * output and argv-level CLI errors are written directly to the streams in
 * the bin and stay human-readable regardless of the format — a malformed
 * command line must be readable by the operator who typed it.
 */

/** Log output formats: `console` (default) or `json` (one object per line). */
export type LogFormat = 'console' | 'json';

/** Environment variable selecting the JSON-lines format. */
export const LOG_FORMAT_ENV = 'BRIDGE_LOG_FORMAT';

/**
 * Resolve the log format from an env-like object (defaults to
 * `process.env`). Only the exact value `json` (case-insensitive) selects
 * JSON; anything else — including garbage — stays on the console default.
 */
export function logFormatFromEnv(env: Record<string, string | undefined> = process.env): LogFormat {
  const raw = (env[LOG_FORMAT_ENV] ?? '').trim().toLowerCase();
  return raw === 'json' ? 'json' : 'console';
}

/**
 * Render one structured log line. Extra arguments are stringified and
 * joined with spaces (matching how the service passes context to
 * `console.error('audit.dropped', reason)`); Errors contribute their
 * message, not `{}`.
 */
export function formatLogLine(
  level: 'debug' | 'info' | 'warn' | 'error',
  args: readonly unknown[],
  now: () => Date = () => new Date(),
): string {
  const msg = args.map(stringifyArg).join(' ');
  return JSON.stringify({ time: now().toISOString(), level, msg });
}

function stringifyArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.message;
  if (arg === undefined) return 'undefined';
  try {
    const json = JSON.stringify(arg);
    return json === undefined ? String(arg) : json;
  } catch {
    return String(arg);
  }
}

/** Minimal structural type of the console surface we patch. */
export interface PatchableConsole {
  log: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
}

/**
 * Replace the console methods on `target` (default: the global console) with
 * JSON-line emitters writing to `write` (default: `process.stdout`).
 * Returns a restore function that puts the original methods back — used by
 * tests and by the bin nothing else needs to undo.
 */
export function installJsonLogging(
  target: PatchableConsole = console,
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): () => void {
  const originals: Array<[keyof PatchableConsole, (...args: unknown[]) => void]> = [];
  const patch = (method: keyof PatchableConsole, level: 'debug' | 'info' | 'warn' | 'error'): void => {
    const original = target[method].bind(target);
    originals.push([method, original]);
    target[method] = (...args: unknown[]) => {
      write(formatLogLine(level, args));
    };
  };
  patch('log', 'info');
  patch('info', 'info');
  patch('warn', 'warn');
  patch('error', 'error');
  patch('debug', 'debug');
  return () => {
    for (const [method, original] of originals.reverse()) {
      target[method] = original;
    }
  };
}
