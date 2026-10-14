/**
 * @bridge/core — the Bridge compiler: IDL front-end and canonical IR.
 *
 * Public API:
 * - `compileSource` / `compilePackage`   — compiler pipeline → canonical IR
 * - `createCompileCache`                 — deterministic compile cache (CLI --cache)
 * - `formatSource`                       — canonical source formatter
 * - `formatDiagnostic` / `formatDiagnostics` — diagnostic rendering
 * - `analyzeFile` / SEMANTIC_CODES       — semantic analysis (tooling)
 * - `parse` / `tokenize` + AST nodes     — front-end internals (tooling)
 * - canonical IR types + `hashPackage`   — stable boundary (frozen)
 */

// Frozen canonical IR contract.
export * from './ir/types';
export * from './ir/hash';

// Front-end internals, exported for tooling (linter, playground, docs).
export * from './lexer';
export * from './parser';
export * from './ast';

// Semantic analysis.
export {
  analyzeFile,
  didYouMean,
  levenshtein,
  suggestionHint,
  SEMANTIC_CODES,
  INTERNAL_ERROR,
  type AnalyzeOptions,
} from './semantic';

// Compiler pipeline.
export {
  bridgeCompiler,
  compilePackage,
  compileSource,
} from './compiler/compile';

// Deterministic, content-addressed compile cache (src/cache.ts, issue #23).
// Shipped as a library first; the CLI `--cache` flag is its production consumer.
export { createCompileCache } from './cache';

// Formatter and diagnostic rendering.
export { formatSource, type FormatResult } from './format';
export {
  formatDiagnostic,
  formatDiagnostics,
} from './diagnostics';

import type { CompileResult, IRPackage } from './ir/types';

/**
 * Compiler API implemented by the compiler pipeline (compiler/compile.ts).
 * Kept here as the typed surface that CLI, registry and tooling program
 * against. The concrete implementation is exported as `bridgeCompiler`.
 */
export interface BridgeCompiler {
  /**
   * Compile Bridge IDL source text into the canonical IR.
   * Must never throw on malformed input — always return diagnostics.
   */
  compileSource(text: string, filePath: string): CompileResult;
  /**
   * Compile a package plus its (already compiled) dependencies, validating
   * cross-package references. `dependencies` maps dotted package name → IR.
   */
  compilePackage(
    text: string,
    filePath: string,
    dependencies: Map<string, IRPackage>,
  ): CompileResult;
}
