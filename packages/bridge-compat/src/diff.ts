/**
 * The Bridge compatibility engine: compares two versions of a package's
 * canonical IR and classifies every change as SAFE / WARNING / BREAKING /
 * UNKNOWN.
 *
 * Design principles:
 * - Conservative by default: suspicious or undecidable changes are never
 *   silently classified SAFE (`json`-involved type changes become UNKNOWN).
 * - Deterministic: matching is name-keyed (input array order is irrelevant)
 *   and the resulting changes are emitted in a canonical order.
 * - Zero runtime dependencies: only the frozen IR types from `@bridge/core`.
 *
 * Detection rules (see README/docs for the full matrix):
 * - Types: added SAFE, removed BREAKING, kind-changed BREAKING, alias
 *   target changes BREAKING (aliases are transparent).
 * - Struct fields (matched by name): added optional SAFE / required
 *   WARNING, removed BREAKING, single removal+addition with deeply equal
 *   types synthesized into one BREAKING rename, widening primitive changes
 *   WARNING, all other type changes BREAKING, required→optional SAFE,
 *   optional→required BREAKING, default changes WARNING, constraint
 *   add/remove/arg changes WARNING, constraint message-only change SAFE,
 *   deprecation added SAFE / removed WARNING.
 * - Enums: value added WARNING, removed BREAKING.
 * - Unions: variant added WARNING, removed BREAKING, type changed BREAKING.
 * - Services: added SAFE, removed BREAKING (service-level entries are
 *   emitted regardless of method count, mirroring the type/event rules;
 *   per-method entries are additionally emitted for the methods an
 *   added/removed service carries), method added SAFE, removed BREAKING,
 *   signature change BREAKING.
 * - Events: added SAFE, removed BREAKING, field-level changes reuse the
 *   field rules nested under `EventName.field` with kind
 *   `event-field-changed`.
 * - Envelope: package rename BREAKING (opt-out → WARNING), import changes
 *   SAFE.
 */
import type {
  ConstraintKind,
  IRConstraint,
  IRField,
  IRMethod,
  IRPackage,
  IRService,
  IRTypeDefinition,
  IREnumVariant,
  IREvent,
  IRAlias,
  IREnum,
  IRStruct,
  IRUnion,
  TypeRef,
} from '@bridge/core';
import {
  cmp,
  groupByKind,
  constraintsEqual,
  involvesJson,
  renderConstraint,
  renderTypeRef,
  sortByArgs,
  typeRefsEqual,
} from './equal';
import { compareChanges, summarize, verdictOf } from './report';
import type { Change, ChangeKind, Classification, CompatReport, DiffOptions } from './types';

/** Primitive widenings that are wire-compatible in practice → WARNING. */
const WIDENING: ReadonlySet<string> = new Set(['int32>int64', 'float32>float64', 'uint32>uint64']);

/**
 * The field-level rule kinds a field diff can produce. Callers map these to
 * the concrete `ChangeKind` for their container (structs use them as-is,
 * events collapse everything to `event-field-changed`).
 */
type FieldRuleKind =
  | 'field-added'
  | 'field-removed'
  | 'field-renamed'
  | 'field-type-changed'
  | 'field-optional-changed'
  | 'field-default-changed'
  | 'field-constraint-changed'
  | 'field-deprecated'
  | 'field-deprecation-removed';

/** Structs use the field rule kinds verbatim. */
const structKinds: (rule: FieldRuleKind) => ChangeKind = (rule) => rule;

/** Events collapse every field-level rule into `event-field-changed`. */
const eventKinds: (rule: FieldRuleKind) => ChangeKind = () => 'event-field-changed';

/**
 * Construct a change with a deterministic key order (path, kind,
 * classification, message, old, new). `oldValue`/`newValue` keys are only
 * present when defined, so serialized output is stable.
 */
function change(
  path: string,
  kind: ChangeKind,
  classification: Classification,
  message: string,
  oldValue?: string,
  newValue?: string,
): Change {
  const out: Change = { path, kind, classification, message };
  if (oldValue !== undefined) out.old = oldValue;
  if (newValue !== undefined) out.new = newValue;
  return out;
}

/** Index items by a string key (last duplicate wins; IR names are unique). */
function indexBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) map.set(key(item), item);
  return map;
}

/** Deterministic sorted union of two key sets (string-keyed domains). */
function sortedUnion<T>(a: Iterable<T>, b: Iterable<T>): T[] {
  const names = new Set<T>([...a, ...b]);
  return [...names].sort((x, y) => cmp(String(x), String(y)));
}

/**
 * Classify and render a type change on a field/variant path.
 *
 * Order of decisions:
 * 1. `json` involved on either side → UNKNOWN (undecidable).
 * 2. primitive → primitive: widening pairs WARNING (unless
 *    `breakingOverWarning`, e.g. union variants where any type change is
 *    BREAKING), everything else BREAKING.
 * 3. anything involving named/composite types → BREAKING.
 */
function typeChange(
  path: string,
  oldType: TypeRef,
  newType: TypeRef,
  kind: ChangeKind,
  breakingOverWarning: boolean,
): Change {
  const oldRender = renderTypeRef(oldType);
  const newRender = renderTypeRef(newType);
  if (involvesJson(oldType) || involvesJson(newType)) {
    return change(
      path,
      kind,
      'UNKNOWN',
      `Type changed: ${path} (${oldRender} → ${newRender}) — undecidable: 'json' involved`,
      oldRender,
      newRender,
    );
  }
  if (oldType.kind === 'primitive' && newType.kind === 'primitive') {
    const widening = WIDENING.has(`${oldType.primitive}>${newType.primitive}`);
    const classification: Classification = widening && !breakingOverWarning ? 'WARNING' : 'BREAKING';
    return change(path, kind, classification, `Type changed: ${path} (${oldRender} → ${newRender})`, oldRender, newRender);
  }
  return change(path, kind, 'BREAKING', `Type changed: ${path} (${oldRender} → ${newRender})`, oldRender, newRender);
}

/** Field present only in the new version (addition rule). */
function addedField(path: string, f: IRField, kind: ChangeKind): Change {
  return f.optional
    ? change(path, kind, 'SAFE', `Added optional field: ${path}`, undefined, renderTypeRef(f.type))
    : change(path, kind, 'WARNING', `Added required field: ${path}`, undefined, renderTypeRef(f.type));
}

/** Field present only in the old version (removal rule). */
function removedField(path: string, f: IRField, kind: ChangeKind): Change {
  return change(path, kind, 'BREAKING', `${path} removed`, renderTypeRef(f.type));
}

/** Render an `IRField.deprecated` value for change metadata. */
function renderDeprecation(d: string | true): string {
  return d === true ? 'true' : d;
}

/**
 * Diff constraint lists attached to one field. Per constraint kind:
 * added → WARNING, removed → WARNING, args changed → WARNING, message-only
 * change → SAFE.
 */
function constraintChanges(
  path: string,
  oldConstraints: readonly IRConstraint[],
  newConstraints: readonly IRConstraint[],
  kind: ChangeKind,
  out: Change[],
): void {
  const oldByKind = groupByKind(oldConstraints);
  const newByKind = groupByKind(newConstraints);
  for (const constraintKind of sortedUnion(oldByKind.keys(), newByKind.keys())) {
    const oldOnes = oldByKind.get(constraintKind);
    const newOnes = newByKind.get(constraintKind);
    if (oldOnes !== undefined && newOnes === undefined) {
      const rendered = renderConstraint(oldOnes[0] as IRConstraint);
      out.push(change(path, kind, 'WARNING', `Constraint removed: ${path} (${rendered})`, rendered));
      continue;
    }
    if (oldOnes === undefined && newOnes !== undefined) {
      const rendered = renderConstraint(newOnes[0] as IRConstraint);
      out.push(change(path, kind, 'WARNING', `Constraint added: ${path} (${rendered})`, undefined, rendered));
      continue;
    }
    // Present on both sides: compare pairwise after a deterministic sort.
    const olds = sortByArgs(oldOnes as IRConstraint[]);
    const news = sortByArgs(newOnes as IRConstraint[]);
    if (olds.length !== news.length) {
      out.push(
        change(
          path,
          kind,
          'WARNING',
          `Constraint changed: ${path} (${olds.map(renderConstraint).join('; ')} → ${news
            .map(renderConstraint)
            .join('; ')})`,
        ),
      );
      continue;
    }
    let argsDiffer = false;
    let messageDiffer = false;
    let firstDiff = -1;
    for (let i = 0; i < olds.length; i++) {
      const o = olds[i] as IRConstraint;
      const n = news[i] as IRConstraint;
      if (!constraintsEqual(o, n)) {
        argsDiffer = true;
        if (firstDiff < 0) firstDiff = i;
      }
      if (o.message !== n.message) messageDiffer = true;
    }
    if (argsDiffer) {
      const o = olds[firstDiff] as IRConstraint;
      const n = news[firstDiff] as IRConstraint;
      out.push(
        change(
          path,
          kind,
          'WARNING',
          `Constraint changed: ${path} (${renderConstraint(o)} → ${renderConstraint(n)})`,
          renderConstraint(o),
          renderConstraint(n),
        ),
      );
    } else if (messageDiffer) {
      const o = olds[0] as IRConstraint;
      const n = news[0] as IRConstraint;
      out.push(
        change(
          path,
          kind,
          'SAFE',
          `Constraint message changed: ${path} (${o.kind})`,
          o.message,
          n.message,
        ),
      );
    }
  }
}

/**
 * Diff a field present in both versions: optionality, default, constraints
 * and deprecation. The type change is handled by the caller (containers
 * pick their own kind/classification for it).
 */
function commonFieldChanges(
  path: string,
  oldField: IRField,
  newField: IRField,
  kindOf: (rule: FieldRuleKind) => ChangeKind,
  out: Change[],
): void {
  if (oldField.optional !== newField.optional) {
    const toOptional = !oldField.optional && newField.optional;
    out.push(
      change(
        path,
        kindOf('field-optional-changed'),
        toOptional ? 'SAFE' : 'BREAKING',
        `Optional changed: ${path} (${toOptional ? 'required → optional' : 'optional → required'})`,
        toOptional ? 'required' : 'optional',
        toOptional ? 'optional' : 'required',
      ),
    );
  }

  if (oldField.default !== newField.default) {
    const c = change(
      path,
      kindOf('field-default-changed'),
      'WARNING',
      `Default changed: ${path} (${oldField.default ?? '(none)'} → ${newField.default ?? '(none)'})`,
    );
    if (oldField.default !== undefined) c.old = oldField.default;
    if (newField.default !== undefined) c.new = newField.default;
    out.push(c);
  }

  constraintChanges(path, oldField.constraints, newField.constraints, kindOf('field-constraint-changed'), out);

  const wasDeprecated = oldField.deprecated !== undefined;
  const isDeprecated = newField.deprecated !== undefined;
  if (isDeprecated && !wasDeprecated) {
    const reason = typeof newField.deprecated === 'string' ? ` — ${newField.deprecated}` : '';
    out.push(
      change(
        path,
        kindOf('field-deprecated'),
        'SAFE',
        `Field deprecated: ${path}${reason}`,
        undefined,
        renderDeprecation(newField.deprecated as string | true),
      ),
    );
  } else if (wasDeprecated && !isDeprecated) {
    out.push(
      change(
        path,
        kindOf('field-deprecation-removed'),
        'WARNING',
        `Deprecation removed: ${path}`,
        renderDeprecation(oldField.deprecated as string | true),
      ),
    );
  }
}

/**
 * Diff two field lists matched by name (shared by struct fields and event
 * fields). Handles additions, removals, rename synthesis (exactly one
 * removal + one addition with deeply equal types → single BREAKING rename)
 * and all common-field rules.
 */
function diffFieldMap(
  container: string,
  oldFields: readonly IRField[],
  newFields: readonly IRField[],
  kindOf: (rule: FieldRuleKind) => ChangeKind,
  out: Change[],
): void {
  const oldByName = indexBy(oldFields, (f) => f.name);
  const newByName = indexBy(newFields, (f) => f.name);
  const removed: string[] = [];
  const added: string[] = [];
  for (const name of oldByName.keys()) if (!newByName.has(name)) removed.push(name);
  for (const name of newByName.keys()) if (!oldByName.has(name)) added.push(name);
  removed.sort(cmp);
  added.sort(cmp);

  if (removed.length === 1 && added.length === 1) {
    // Rename synthesis candidate: single removal + single addition.
    const oldField = oldByName.get(removed[0] as string) as IRField;
    const newField = newByName.get(added[0] as string) as IRField;
    if (typeRefsEqual(oldField.type, newField.type)) {
      out.push(
        change(
          `${container}.${newField.name}`,
          kindOf('field-renamed'),
          'BREAKING',
          `Field renamed: ${container}.${oldField.name} → ${container}.${newField.name}`,
          oldField.name,
          newField.name,
        ),
      );
    } else {
      out.push(removedField(`${container}.${oldField.name}`, oldField, kindOf('field-removed')));
      out.push(addedField(`${container}.${newField.name}`, newField, kindOf('field-added')));
    }
  } else {
    for (const name of removed) {
      out.push(removedField(`${container}.${name}`, oldByName.get(name) as IRField, kindOf('field-removed')));
    }
    for (const name of added) {
      out.push(addedField(`${container}.${name}`, newByName.get(name) as IRField, kindOf('field-added')));
    }
  }

  for (const [name, oldField] of oldByName) {
    const newField = newByName.get(name);
    if (newField === undefined) continue;
    const path = `${container}.${name}`;
    if (!typeRefsEqual(oldField.type, newField.type)) {
      out.push(typeChange(path, oldField.type, newField.type, kindOf('field-type-changed'), false));
    }
    commonFieldChanges(path, oldField, newField, kindOf, out);
  }
}

/** Diff enum variants matched by name. */
function enumVariantChanges(
  container: string,
  oldVariants: readonly IREnumVariant[],
  newVariants: readonly IREnumVariant[],
  out: Change[],
): void {
  const oldByName = indexBy(oldVariants, (v) => v.name);
  const newByName = indexBy(newVariants, (v) => v.name);
  for (const name of sortedUnion(oldByName.keys(), newByName.keys())) {
    const path = `${container}.${name}`;
    const oldVariant = oldByName.get(name);
    const newVariant = newByName.get(name);
    if (oldVariant !== undefined && newVariant === undefined) {
      out.push(change(path, 'enum-value-removed', 'BREAKING', `${path} removed`, name));
    } else if (oldVariant === undefined && newVariant !== undefined) {
      out.push(change(path, 'enum-value-added', 'WARNING', `Added enum value: ${path}`, undefined, name));
    }
    // Variant deprecation/doc edits are not wire-visible; intentionally not
    // reported (documented deviation from strict conservatism).
  }
}

/**
 * Diff union variants matched by name. Variant addition is always WARNING
 * (even when optional — a new tag can hit exhaustive consumer switches),
 * removal and type change are always BREAKING. Non-type changes reuse the
 * field rules with their own kinds.
 */
function unionVariantChanges(
  container: string,
  oldVariants: readonly IRField[],
  newVariants: readonly IRField[],
  out: Change[],
): void {
  const oldByName = indexBy(oldVariants, (v) => v.name);
  const newByName = indexBy(newVariants, (v) => v.name);
  for (const name of sortedUnion(oldByName.keys(), newByName.keys())) {
    const path = `${container}.${name}`;
    const oldVariant = oldByName.get(name);
    const newVariant = newByName.get(name);
    if (oldVariant !== undefined && newVariant === undefined) {
      out.push(change(path, 'union-variant-removed', 'BREAKING', `${path} removed`, renderTypeRef(oldVariant.type)));
      continue;
    }
    if (oldVariant === undefined && newVariant !== undefined) {
      out.push(
        change(path, 'union-variant-added', 'WARNING', `Added union variant: ${path}`, undefined, renderTypeRef(newVariant.type)),
      );
      continue;
    }
    const o = oldVariant as IRField;
    const n = newVariant as IRField;
    if (!typeRefsEqual(o.type, n.type)) {
      out.push(typeChange(path, o.type, n.type, 'union-variant-changed', true));
    }
    commonFieldChanges(path, o, n, structKinds, out);
  }
}

/** Diff type definitions matched by name (kinds, aliases, composites). */
function typeChanges(oldTypes: readonly IRTypeDefinition[], newTypes: readonly IRTypeDefinition[], out: Change[]): void {
  const oldByName = indexBy(oldTypes, (t) => t.name);
  const newByName = indexBy(newTypes, (t) => t.name);
  for (const name of sortedUnion(oldByName.keys(), newByName.keys())) {
    const oldType = oldByName.get(name);
    const newType = newByName.get(name);
    if (oldType === undefined && newType !== undefined) {
      if (newType.kind === 'alias') out.push(change(name, 'alias-added', 'SAFE', `Alias added: ${name}`));
      else out.push(change(name, 'type-added', 'SAFE', `Type added: ${name}`));
      continue;
    }
    if (oldType !== undefined && newType === undefined) {
      if (oldType.kind === 'alias') out.push(change(name, 'alias-removed', 'BREAKING', `Alias removed: ${name}`));
      else out.push(change(name, 'type-removed', 'BREAKING', `Type removed: ${name}`));
      continue;
    }
    const o = oldType as IRTypeDefinition;
    const n = newType as IRTypeDefinition;
    if (o.kind !== n.kind) {
      out.push(change(name, 'type-kind-changed', 'BREAKING', `Type kind changed: ${name} (${o.kind} → ${n.kind})`));
      continue;
    }
    switch (o.kind) {
      case 'struct':
        diffFieldMap(name, o.fields, (n as IRStruct).fields, structKinds, out);
        break;
      case 'enum':
        enumVariantChanges(name, o.variants, (n as IREnum).variants, out);
        break;
      case 'union':
        unionVariantChanges(name, o.variants, (n as IRUnion).variants, out);
        break;
      case 'alias': {
        const target = (n as IRAlias).target;
        if (!typeRefsEqual(o.target, target)) {
          out.push(
            change(
              name,
              'alias-target-changed',
              'BREAKING',
              `Alias target changed: ${name} (${renderTypeRef(o.target)} → ${renderTypeRef(target)})`,
              renderTypeRef(o.target),
              renderTypeRef(target),
            ),
          );
        }
        break;
      }
      default: {
        const unreachable: never = o;
        throw new Error(`unreachable type kind: ${JSON.stringify(unreachable)}`);
      }
    }
  }
}

/** Diff methods within one service (or across an added/removed service). */
function methodChanges(serviceName: string, oldMethods: readonly IRMethod[], newMethods: readonly IRMethod[], out: Change[]): void {
  const oldByName = indexBy(oldMethods, (m) => m.name);
  const newByName = indexBy(newMethods, (m) => m.name);
  for (const name of sortedUnion(oldByName.keys(), newByName.keys())) {
    const fqName = `${serviceName}.${name}`;
    const oldMethod = oldByName.get(name);
    const newMethod = newByName.get(name);
    if (oldMethod !== undefined && newMethod === undefined) {
      out.push(change(fqName, 'method-removed', 'BREAKING', `Method removed: ${fqName}`));
      continue;
    }
    if (oldMethod === undefined && newMethod !== undefined) {
      out.push(change(fqName, 'method-added', 'SAFE', `Method added: ${fqName}`));
      continue;
    }
    const o = oldMethod as IRMethod;
    const n = newMethod as IRMethod;
    if (!typeRefsEqual(o.input, n.input)) {
      out.push(
        change(
          `${fqName}.input`,
          'method-signature-changed',
          'BREAKING',
          `Method signature changed: ${fqName} input (${renderTypeRef(o.input)} → ${renderTypeRef(n.input)})`,
          renderTypeRef(o.input),
          renderTypeRef(n.input),
        ),
      );
    }
    if (!typeRefsEqual(o.output, n.output)) {
      out.push(
        change(
          `${fqName}.output`,
          'method-signature-changed',
          'BREAKING',
          `Method signature changed: ${fqName} output (${renderTypeRef(o.output)} → ${renderTypeRef(n.output)})`,
          renderTypeRef(o.output),
          renderTypeRef(n.output),
        ),
      );
    }
  }
}

/**
 * Diff services matched by name. Service addition/removal is reported as an
 * explicit envelope-level change — independent of method count, so an empty
 * service still produces exactly one entry (removal BREAKING, addition SAFE,
 * mirroring the type/event rules). The per-method entries for the methods an
 * added/removed service carries are kept for visibility; paths never collide
 * (envelope path is the bare service name, method paths are `Name.method`).
 */
function serviceChanges(oldServices: readonly IRService[], newServices: readonly IRService[], out: Change[]): void {
  const oldByName = indexBy(oldServices, (s) => s.name);
  const newByName = indexBy(newServices, (s) => s.name);
  for (const name of sortedUnion(oldByName.keys(), newByName.keys())) {
    const oldService = oldByName.get(name);
    const newService = newByName.get(name);
    if (oldService === undefined && newService !== undefined) {
      out.push(change(name, 'service-added', 'SAFE', `Service added: ${name}`));
      for (const m of newService.methods) {
        out.push(change(`${name}.${m.name}`, 'method-added', 'SAFE', `Method added: ${name}.${m.name}`));
      }
      continue;
    }
    if (oldService !== undefined && newService === undefined) {
      out.push(change(name, 'service-removed', 'BREAKING', `Service removed: ${name}`));
      for (const m of oldService.methods) {
        out.push(change(`${name}.${m.name}`, 'method-removed', 'BREAKING', `Method removed: ${name}.${m.name}`));
      }
      continue;
    }
    methodChanges(name, (oldService as IRService).methods, (newService as IRService).methods, out);
  }
}

/** Diff events matched by name; field-level changes reuse the field rules. */
function eventChanges(oldEvents: readonly IREvent[], newEvents: readonly IREvent[], out: Change[]): void {
  const oldByName = indexBy(oldEvents, (e) => e.name);
  const newByName = indexBy(newEvents, (e) => e.name);
  for (const name of sortedUnion(oldByName.keys(), newByName.keys())) {
    const oldEvent = oldByName.get(name);
    const newEvent = newByName.get(name);
    if (oldEvent !== undefined && newEvent === undefined) {
      out.push(change(name, 'event-removed', 'BREAKING', `Event removed: ${name}`));
      continue;
    }
    if (oldEvent === undefined && newEvent !== undefined) {
      out.push(change(name, 'event-added', 'SAFE', `Event added: ${name}`));
      continue;
    }
    diffFieldMap(name, (oldEvent as IREvent).fields, (newEvent as IREvent).fields, eventKinds, out);
  }
}

/** Diff the import lists (both directions are SAFE). */
function importChanges(oldImports: readonly string[], newImports: readonly string[], out: Change[]): void {
  const oldSet = new Set(oldImports);
  const newSet = new Set(newImports);
  for (const name of sortedUnion(oldSet, newSet)) {
    if (!newSet.has(name)) out.push(change(`imports.${name}`, 'import-removed', 'SAFE', `Import removed: ${name}`, name));
    else if (!oldSet.has(name)) out.push(change(`imports.${name}`, 'import-added', 'SAFE', `Import added: ${name}`, undefined, name));
  }
}

/**
 * Compare two versions of a package's canonical IR and classify every
 * detected change. Both inputs must be valid `IRPackage`s produced by the
 * Bridge compiler; array order inside the inputs is irrelevant (matching is
 * name-keyed and the report is canonically sorted).
 *
 * @param oldIr - the baseline (published) package version
 * @param newIr - the candidate (to-be-published) package version
 * @param options - see {@link DiffOptions}
 * @returns a deterministic {@link CompatReport}
 */
export function diffPackages(oldIr: IRPackage, newIr: IRPackage, options: DiffOptions = {}): CompatReport {
  const packageRenameBreaking = options.packageRenameBreaking ?? true;
  const changes: Change[] = [];

  if (oldIr.name !== newIr.name) {
    changes.push(
      change(
        oldIr.name,
        'package-renamed',
        packageRenameBreaking ? 'BREAKING' : 'WARNING',
        `package renamed ${oldIr.name} → ${newIr.name}`,
        oldIr.name,
        newIr.name,
      ),
    );
  }

  importChanges(oldIr.imports, newIr.imports, changes);
  typeChanges(oldIr.types, newIr.types, changes);
  serviceChanges(oldIr.services, newIr.services, changes);
  eventChanges(oldIr.events, newIr.events, changes);

  changes.sort(compareChanges);
  return {
    packageName: newIr.name,
    changes,
    verdict: verdictOf(changes),
    summary: summarize(changes),
  };
}

/**
 * Compare two package versions and produce a CI gate decision from the
 * report verdict.
 *
 * Truth table by verdict and mode:
 *
 * | Verdict  | `'strict'` (default) | `'compatible'` |
 * |----------|----------------------|----------------|
 * | SAFE     | passed               | passed         |
 * | WARNING  | passed               | passed         |
 * | UNKNOWN  | FAILED               | passed         |
 * | BREAKING | FAILED               | FAILED         |
 *
 * `'strict'` implements the strict compatibility policy: breaking and
 * unknown changes fail. `'compatible'` fails only on definite BREAKING
 * changes, for teams that explicitly accept warnings and undecidable diffs
 * during a migration window. Note that the engine itself never classifies
 * an undecidable change as SAFE — the mode only decides whether such a
 * verdict gates the pipeline.
 *
 * @returns `passed` plus the full {@link CompatReport} for rendering.
 */
export function check(oldIr: IRPackage, newIr: IRPackage, options: DiffOptions = {}): { passed: boolean; report: CompatReport } {
  const report = diffPackages(oldIr, newIr, options);
  const mode = options.mode ?? 'strict';
  const passed = mode === 'compatible' ? report.verdict !== 'BREAKING' : report.verdict === 'SAFE' || report.verdict === 'WARNING';
  return { passed, report };
}
