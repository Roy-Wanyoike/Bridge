/**
 * Full TypeScript Program type-check for generated packages (issue #118).
 *
 * `ts.transpileModule` is SYNTAX-ONLY: it never runs semantic analysis and
 * never sees more than one file, so it cannot catch duplicate identifiers,
 * unresolved names, or type errors across the emitted module graph. This
 * helper builds a real `ts.createProgram` over the emitted `.ts` files with
 * an in-memory compiler host (no disk writes), per the issue #118 spec:
 * lib es2020 + dom, skipLibCheck.
 *
 * Coverage statement: the whole emitted module graph (types/enums/
 * validate/services/events/index) is checked TOGETHER as one Program, so
 * cross-file semantic errors surface — TS2300 duplicate identifier,
 * TS2304 cannot-find-name, TS2322 type mismatches. RootDir-style emit
 * errors (TS6059) are structurally impossible here because rootDir is
 * intentionally NOT set: the virtual layout is already root-like.
 *
 * Compiler options mirror the emitted tsconfig.json (target ES2020,
 * module CommonJS, moduleResolution Node, strict, esModuleInterop) plus
 * `lib: ['es2020', 'dom']` from the issue. The generated code is
 * deliberately DOM-independent (structural `FetchLike` + `globalThis`
 * cast), so including the DOM lib only WIDENS the net: a generated name
 * colliding with a DOM global would surface rather than hide.
 */

import type * as tsTypes from 'typescript';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ts = require('typescript') as typeof tsTypes;

/** Minimal structural view of a generated file (keeps this helper decoupled). */
export interface GeneratedFileLike {
  readonly path: string;
  readonly content: string;
}

const VIRTUAL_ROOT = '/bridge-virtual';

function virtualPath(filePath: string): string {
  return `${VIRTUAL_ROOT}/${filePath.split('\\').join('/')}`;
}

/** Compiler options mirroring the emitted tsconfig.json (+ issue #118 libs). */
function compilerOptions(): tsTypes.CompilerOptions {
  return {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    // Programmatic CompilerOptions take FULL lib file names — the short
    // names ("es2020", "dom") are only mapped from tsconfig JSON by
    // convertCompilerOptionsFromJson, and a bare "dom" here fails with
    // TS6231 (typescript 5.9 uses options.lib entries verbatim).
    lib: ['lib.es2020.d.ts', 'lib.dom.d.ts'],
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    esModuleInterop: true,
    forceConsistentCasingInFileNames: true,
  };
}

/**
 * Builds a full ts.Program over the `.ts` files of a generated package.
 * Non-TypeScript artifacts (package.json, tsconfig.json, ...) are ignored.
 * All relative imports resolve inside the virtual file map; lib files
 * resolve from the `typescript` package itself.
 */
export function createGeneratedProgram(
  files: readonly GeneratedFileLike[],
): tsTypes.Program {
  const virtualFiles = new Map<string, string>();
  const rootNames: string[] = [];
  for (const file of files) {
    if (!file.path.endsWith('.ts')) continue;
    const vPath = virtualPath(file.path);
    virtualFiles.set(vPath, file.content);
    rootNames.push(vPath);
  }
  if (rootNames.length === 0) {
    throw new Error('no .ts files to type-check');
  }

  const options = compilerOptions();
  const host = ts.createCompilerHost(options, /* setParentNodes */ true);
  const baseReadFile = host.readFile.bind(host);
  const baseFileExists = host.fileExists.bind(host);
  host.readFile = (fileName: string) => {
    const hit = virtualFiles.get(fileName);
    if (hit !== undefined) return hit;
    return baseReadFile(fileName);
  };
  host.fileExists = (fileName: string) =>
    virtualFiles.has(fileName) || baseFileExists(fileName);
  // Module resolution short-circuits fileExists entirely for directories
  // that "do not exist" (onlyRecordFailures optimization), so the host must
  // report the virtual directories as existing or every relative import
  // fails with TS2307 even though the files are in the map.
  const baseDirectoryExists = host.directoryExists?.bind(host);
  if (host.directoryExists) {
    host.directoryExists = (directory: string) =>
      directory === VIRTUAL_ROOT ||
      directory.startsWith(`${VIRTUAL_ROOT}/`) ||
      (baseDirectoryExists ? baseDirectoryExists(directory) : false);
  }

  return ts.createProgram({ rootNames, options, host });
}

/** Error/Warning diagnostics of a program (empty list = clean). */
export function programErrors(program: tsTypes.Program): tsTypes.Diagnostic[] {
  return ts
    .getPreEmitDiagnostics(program)
    .filter(
      (d) =>
        d.category === ts.DiagnosticCategory.Error ||
        d.category === ts.DiagnosticCategory.Warning,
    );
}

/** Type-checks a generated package; returns its Error/Warning diagnostics. */
export function typeCheckGenerated(
  files: readonly GeneratedFileLike[],
): tsTypes.Diagnostic[] {
  return programErrors(createGeneratedProgram(files));
}

/** One-line-per-diagnostic rendering with file:line:column and TS code. */
export function formatDiagnostics(
  diagnostics: readonly tsTypes.Diagnostic[],
): string {
  return diagnostics
    .map((d) => {
      let where = '';
      if (d.file !== undefined && d.start !== undefined) {
        const pos = d.file.getLineAndCharacterOfPosition(d.start);
        where = `${d.file.fileName}:${pos.line + 1}:${pos.character + 1}: `;
      }
      return `${where}TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
    })
    .join('\n');
}
