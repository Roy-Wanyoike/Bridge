/**
 * Public types of the Bridge compatibility engine.
 *
 * The engine compares two versions of a package's canonical IR
 * (`IRPackage` from `@bridge/core`) and classifies every detected change so
 * CI pipelines can block breaking contract evolution. See `diff.ts` for the
 * detection rules and `report.ts` for rendering.
 */

/**
 * Severity classification assigned to every detected change.
 *
 * - `SAFE`    — provably harmless to all consumers.
 * - `WARNING` — visible change that well-behaved consumers tolerate, but
 *   strict readers or exhaustive switches may not.
 * - `BREAKING`— guaranteed to break at least one class of consumers.
 * - `UNKNOWN` — the engine cannot decide confidently (e.g. a `json`
 *   primitive is involved in a type change). Never silently downgraded:
 *   UNKNOWN fails the default strict gate.
 */
export type Classification = 'SAFE' | 'WARNING' | 'BREAKING' | 'UNKNOWN';

/** A single detected difference between two package versions. */
export interface Change {
  /**
   * Dotted location of the change, e.g. `Payment.currency` (struct field),
   * `Payments` (service), `Payments.CreatePayment` (method),
   * `Payments.CreatePayment.input` (method signature half),
   * `PaymentStatus.REFUNDED` (enum variant), `PaymentCaptured.amount`
   * (event field), `imports.legacy.v1` (import), or the old package name
   * for a package rename.
   */
  path: string;
  /** Machine-readable kind of the change. */
  kind: ChangeKind;
  /** Severity classification of the change. */
  classification: Classification;
  /** Human-readable description rendered by {@link formatReport}. */
  message: string;
  /** Human-readable rendering of the old value, when applicable. */
  old?: string;
  /** Human-readable rendering of the new value, when applicable. */
  new?: string;
}

/**
 * Machine-readable kinds of changes the engine detects. Kinds are grouped
 * by where they occur: fields (structs and, nested, events), enum variants,
 * union variants, aliases, whole types, whole services, service methods,
 * events, and the package envelope (name and imports).
 */
export type ChangeKind =
  | 'field-added'
  | 'field-removed'
  | 'field-renamed'
  | 'field-type-changed'
  | 'field-optional-changed'
  | 'field-default-changed'
  | 'field-constraint-changed'
  | 'field-deprecated'
  | 'field-deprecation-removed'
  | 'enum-value-added'
  | 'enum-value-removed'
  | 'union-variant-added'
  | 'union-variant-removed'
  | 'union-variant-changed'
  | 'alias-target-changed'
  | 'alias-added'
  | 'alias-removed'
  | 'type-added'
  | 'type-removed'
  | 'type-kind-changed'
  | 'service-added'
  | 'service-removed'
  | 'method-added'
  | 'method-removed'
  | 'method-signature-changed'
  | 'event-added'
  | 'event-removed'
  | 'event-field-changed'
  | 'package-renamed'
  | 'import-added'
  | 'import-removed';

/** Result of comparing two versions of a package. */
export interface CompatReport {
  /** Name of the NEW package version (the target state of the upgrade). */
  packageName: string;
  /**
   * All detected changes in canonical (deterministic) order: BREAKING
   * first, then UNKNOWN, WARNING, SAFE; ties broken by path, then kind,
   * then message.
   */
  changes: Change[];
  /** Worst classification across all changes (BREAKING > UNKNOWN > WARNING > SAFE). */
  verdict: Classification;
  /** Count of changes per classification. */
  summary: { safe: number; warning: number; breaking: number; unknown: number };
}

/** Options controlling {@link diffPackages} and {@link check}. */
export interface DiffOptions {
  /**
   * Failure policy applied by `check()` and reflected in the
   * `Compatibility: PASSED/FAILED` line of `formatReport()`:
   *
   * | Verdict  | `'strict'` (default) | `'compatible'` |
   * |----------|----------------------|----------------|
   * | SAFE     | passes               | passes         |
   * | WARNING  | passes               | passes         |
   * | UNKNOWN  | FAILS                | passes         |
   * | BREAKING | FAILS                | FAILS          |
   *
   * `'strict'` implements the strict compatibility policy: breaking and
   * unknown changes fail. `'compatible'` fails only on definite BREAKING
   * changes, for teams that explicitly accept warnings and undecidable
   * diffs while migrating.
   *
   * @default 'strict'
   */
  mode?: 'strict' | 'compatible';
  /**
   * Treat a package rename as BREAKING. Renaming is breaking for consumers
   * that reference the package by name; set to `false` to downgrade the
   * rename to a WARNING (the internal diff is still produced).
   *
   * @default true
   */
  packageRenameBreaking?: boolean;
}
