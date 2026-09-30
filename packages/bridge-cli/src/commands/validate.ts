/**
 * `bridge validate [files...]` — compile contracts and report diagnostics.
 */
import { compileSource, formatDiagnostics, shortHash } from '@bridge/core';
import { ParsedArgs } from '../args';
import { inputFiles, readText } from '../files';
import { CliError, describeError } from '../errors';
import { errOut, out, CHECK, printJson } from '../output';

interface ValidateResultJson {
  file: string;
  ok: boolean;
  package?: string;
  hash?: string;
  diagnostics: unknown[];
}

export function run(args: ParsedArgs): void {
  const json = args.flags.has('--json');
  const files = inputFiles(args, 'validate');
  const results: ValidateResultJson[] = [];
  let failures = 0;

  for (const file of files) {
    let text: string;
    try {
      text = readText(file);
    } catch (e) {
      // One JSON entry per input file, even when it cannot be read — CI
      // consumers parse the array instead of losing it to an early abort.
      // readText raises plain CliErrors (missing file, invalid UTF-8, …).
      failures++;
      const message = e instanceof CliError ? e.message : `cannot read ${file}: ${describeError(e)}`;
      results.push({
        file,
        ok: false,
        diagnostics: [{ severity: 'error', message }],
      });
      if (!json) errOut(message);
      continue;
    }
    const result = compileSource(text, file);
    if (result.ok && result.ir) {
      const hash = shortHash(result.ir);
      results.push({
        file,
        ok: true,
        package: result.ir.name,
        hash,
        diagnostics: result.diagnostics,
      });
      if (!json) out(`${CHECK} ${file} ok (package ${result.ir.name}, hash ${hash})`);
    } else {
      failures++;
      results.push({ file, ok: false, diagnostics: result.diagnostics });
      if (!json) out(formatDiagnostics(result.diagnostics, text));
    }
  }

  if (json) {
    printJson(results);
  } else if (files.length > 1) {
    out(`${files.length - failures}/${files.length} file(s) valid`);
  }

  if (failures > 0) {
    throw new CliError(`${failures} of ${files.length} file(s) failed validation`);
  }
}
