/**
 * Consumer-aware impact analysis: combines the compat diff with a transitive
 * walk over the registry's dependent graph to answer "who feels this change?"
 *
 * Reachability model (best-effort, documented honestly):
 *
 * 1. Every detected change is reduced to the set of *names* it marks:
 *    - type-level changes mark their struct/enum/union/alias name;
 *    - method signature changes mark the named input/output types on both
 *      sides of the signature;
 *    - event changes mark the event name (events cannot be referenced as
 *      types, so they follow their own rule, see below);
 *    - import changes mark nothing (always SAFE); a package rename marks
 *      everything (every dependent is conservatively affected).
 * 2. A dependent contract *directly uses* the changed package when its IR
 *    contains a qualified reference `pkg.Type` (matching the package name or
 *    its base) whose type name is marked. Unqualified references are local by
 *    definition (the compiler enforces qualification for imports).
 * 3. Taint flows through intermediate contracts: an intermediate's own type
 *    is tainted when it transitively references — through the intermediate's
 *    local type graph — a foreign type that carries taint. Tainted local
 *    types are then matched against the intermediate's dependents.
 * 4. Event changes cannot be traced through type references (subscription
 *    edges are not part of the IR). Every DIRECT dependent is conservatively
 *    flagged with the event change's classification; indirect dependents are
 *    not (only type taint flows through intermediates).
 * 5. Consumers whose IR cannot be pulled from the registry are conservatively
 *    counted as affected with severity UNKNOWN.
 *
 * Known limits (all deterministic under- or over-approximations, see
 * docs/IMPACT.md):
 * - Field-level precision is out of scope: touching a type touches all its
 *   referencers (name-level, not field-level, intersection).
 * - Callers of services and subscribers of events are invisible in IR; method
 *   changes only reach consumers through the named types in signatures.
 * - The dependency graph uses recorded `imports` — consumers outside the
 *   registry are invisible by definition.
 *
 * The walk is cycle-safe (visited set keyed by package name) and
 * deterministic: registry iteration order is normalized, results are sorted,
 * and identical inputs produce byte-identical reports.
 */
import type { IRPackage, TypeRef } from '@bridge/core';
import { cmp } from './equal';
import { diffPackages } from './diff';
import type {
  AffectedConsumer,
  ContactReason,
  ContractMetaLike,
  ImpactOptions,
  ImpactRegistry,
  ImpactReport,
  ImpactStats,
  SuggestedAction,
} from './impact-types';
import type { Change, Classification } from './types';

/** Failure of {@link computeImpact}: bad input combination or unusable registry. */
export class ImpactError extends Error {
  /** `invalid-input` — the option combination is unusable; `registry` — the store failed. */
  readonly code: 'invalid-input' | 'registry';

  constructor(code: 'invalid-input' | 'registry', message: string) {
    super(message);
    this.name = 'ImpactError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Small local helpers (dependency-free mirrors of registry semantics)
// ---------------------------------------------------------------------------

/** Mirrors the registry's base-name rule: strip one trailing `vN`/`N` segment. */
const VERSION_SEGMENT_RE = /^(?:v\d+|\d+)$/;

function baseOf(packageName: string): string {
  const dot = packageName.lastIndexOf('.');
  if (dot > 0) {
    const last = packageName.slice(dot + 1);
    if (VERSION_SEGMENT_RE.test(last)) return packageName.slice(0, dot);
  }
  return packageName;
}

/** Numeric-aware version comparison for deterministic ordering (`v2 < v10`). */
function compareVersionStrings(a: string, b: string): number {
  const an = Number.parseInt(a.replace(/^v/i, ''), 10);
  const bn = Number.parseInt(b.replace(/^v/i, ''), 10);
  if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an < bn ? -1 : 1;
  return cmp(a, b);
}

function compareMeta(a: ContractMetaLike, b: ContractMetaLike): number {
  return cmp(a.packageName, b.packageName) || compareVersionStrings(a.version, b.version);
}

/** Best-effort message for arbitrary thrown values. */
function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Type-ref walking
// ---------------------------------------------------------------------------

type NamedRef = Extract<TypeRef, { kind: 'named' }>;

/** Visit every named reference inside a type tree (depth-first). */
function visitTypeRef(t: TypeRef, visit: (ref: NamedRef) => void): void {
  switch (t.kind) {
    case 'named':
      visit(t);
      return;
    case 'list':
    case 'set':
      visitTypeRef(t.element, visit);
      return;
    case 'map':
      visitTypeRef(t.key, visit);
      visitTypeRef(t.value, visit);
      return;
    case 'optional':
      visitTypeRef(t.inner, visit);
      return;
    case 'primitive':
      return;
    default: {
      const unreachable: never = t;
      throw new Error(`unreachable TypeRef kind: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * Qualified foreign references of an IR, indexed by the *referenced* package
 * name. Built in a single O(IR size) walk; {@link computeContacts} then
 * answers each source lookup in O(refs to that source) instead of re-walking
 * the whole IR once per source package (the previous O(consumers² × IR)
 * behavior, multiplied again by the taint fixed-point rounds).
 */
function indexRefsByPackage(ir: IRPackage): Map<string, Set<string>> {
  const byPackage = new Map<string, Set<string>>();
  const add = (r: NamedRef): void => {
    if (r.package === undefined) return;
    let names = byPackage.get(r.package);
    if (names === undefined) {
      names = new Set<string>();
      byPackage.set(r.package, names);
    }
    names.add(r.name);
  };
  for (const t of ir.types) {
    if (t.kind === 'struct') for (const f of t.fields) visitTypeRef(f.type, add);
    else if (t.kind === 'union') for (const v of t.variants) visitTypeRef(v.type, add);
    else if (t.kind === 'alias') visitTypeRef(t.target, add);
  }
  for (const s of ir.services) {
    for (const m of s.methods) {
      visitTypeRef(m.input, add);
      visitTypeRef(m.output, add);
    }
  }
  for (const e of ir.events) for (const f of e.fields) visitTypeRef(f.type, add);
  return byPackage;
}

/**
 * Local type graph of an IR: for each local type, the names it references.
 * Local references (unqualified) are followed further; qualified references
 * are foreign leaves — they carry the package for qualified taint matching.
 */
interface LocalEdge {
  local: Set<string>;
  /** Qualified foreign references, as `pkg#name` keys. */
  foreign: Set<string>;
}

function localGraph(ir: IRPackage): Map<string, LocalEdge> {
  const localNames = new Set(ir.types.map((t) => t.name));
  const graph = new Map<string, LocalEdge>();
  const record = (typeName: string, ref: NamedRef): void => {
    let edge = graph.get(typeName);
    if (edge === undefined) {
      edge = { local: new Set(), foreign: new Set() };
      graph.set(typeName, edge);
    }
    if (ref.package === undefined) {
      if (ref.name !== typeName && localNames.has(ref.name)) edge.local.add(ref.name);
      // Unqualified names that are not local types are dangling (invalid or
      // error IR) — treated as inert leaves.
    } else {
      edge.foreign.add(`${ref.package}#${ref.name}`);
    }
  };
  for (const t of ir.types) {
    if (t.kind === 'struct') for (const f of t.fields) visitTypeRef(f.type, (r) => record(t.name, r));
    else if (t.kind === 'union') for (const v of t.variants) visitTypeRef(v.type, (r) => record(t.name, r));
    else if (t.kind === 'alias') visitTypeRef(t.target, (r) => record(t.name, r));
    else graph.set(t.name, graph.get(t.name) ?? { local: new Set(), foreign: new Set() });
  }
  return graph;
}

// ---------------------------------------------------------------------------
// Change → marks
// ---------------------------------------------------------------------------

interface Marks {
  /** Index of the `package-renamed` change, when present. */
  renameIndex: number | undefined;
  /** Anchor-local type name → indices of changes marking it. */
  types: Map<string, Set<number>>;
  /** Anchor event name → indices of changes marking it. */
  events: Map<string, Set<number>>;
}

function buildMarks(oldIr: IRPackage, newIr: IRPackage, changes: readonly Change[]): Marks {
  const typeNames = new Set<string>([...oldIr.types, ...newIr.types].map((t) => t.name));
  const eventNames = new Set<string>([...oldIr.events, ...newIr.events].map((e) => e.name));
  const serviceNames = new Set<string>([...oldIr.services, ...newIr.services].map((s) => s.name));
  const hasMethod = (service: string, method: string | undefined): boolean => {
    if (method === undefined) return false;
    for (const ir of [oldIr, newIr]) {
      const svc = ir.services.find((s) => s.name === service);
      if (svc !== undefined && svc.methods.some((m) => m.name === method)) return true;
    }
    return false;
  };

  const marks: Marks = { renameIndex: undefined, types: new Map(), events: new Map() };
  const markType = (name: string, index: number): void => {
    const set = marks.types.get(name) ?? new Set<number>();
    set.add(index);
    marks.types.set(name, set);
  };
  const markEvent = (name: string, index: number): void => {
    const set = marks.events.get(name) ?? new Set<number>();
    set.add(index);
    marks.events.set(name, set);
  };

  for (let i = 0; i < changes.length; i++) {
    const c = changes[i] as Change;
    if (c.kind === 'package-renamed') {
      marks.renameIndex = i;
      continue;
    }
    if (c.kind === 'import-added' || c.kind === 'import-removed') continue; // always SAFE
    const segments = c.path.split('.');
    const head = segments[0] as string;
    if (eventNames.has(head)) {
      markEvent(head, i);
      continue;
    }
    if (serviceNames.has(head) && hasMethod(head, segments[1])) {
      // Method-level change: mark the named types on both sides of the
      // signature (old and new), so consumers using either are flagged.
      for (const ir of [oldIr, newIr]) {
        const svc = ir.services.find((s) => s.name === head);
        const method = svc?.methods.find((m) => m.name === segments[1]);
        if (method === undefined) continue;
        for (const ref of [method.input, method.output]) {
          visitTypeRef(ref, (r) => markType(r.name, i));
        }
      }
      continue;
    }
    if (typeNames.has(head)) {
      markType(head, i);
      continue;
    }
    // Unattributable path (e.g. `imports.x`) — marks nothing.
  }
  return marks;
}

// ---------------------------------------------------------------------------
// Consumer graph walk
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Readonly<Record<Classification, number>> = {
  SAFE: 0,
  WARNING: 1,
  UNKNOWN: 2,
  BREAKING: 3,
};

function worstSeverity(a: Classification, b: Classification): Classification {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

const REASON_RANK: Readonly<Record<ContactReason, number>> = {
  'package-renamed': 5,
  'direct-type': 4,
  through: 3,
  event: 2,
  unscannable: 1,
  unaffected: 0,
};

function strongerReason(a: ContactReason, b: ContactReason): ContactReason {
  return REASON_RANK[a] >= REASON_RANK[b] ? a : b;
}

/** Contact between one consumer and one source package. */
interface Contact {
  /** Tainted names referenced by the consumer (source-local names). */
  types: Set<string>;
  /** Indices of changes flowing through this contact. */
  changes: Set<number>;
  /** Event-level (subscription-invisible) contact, anchor only, direct only. */
  event: boolean;
  /** Package-rename contact (anchor only). */
  rename: boolean;
}

interface Node {
  readonly meta: ContractMetaLike;
  readonly name: string;
  readonly base: string;
  /** Pulled IR; `undefined` when the contract could not be loaded. */
  ir: IRPackage | undefined;
  readonly pullError: string | undefined;
  /** BFS depth from the anchor (anchor = 0). */
  readonly depth: number;
  /** Node through which this node was discovered (anchor has none). */
  readonly parent: Node | undefined;
  /** Local type name → indices of changes tainting it. */
  taint: Map<string, Set<number>>;
  /** Contacts computed against all other nodes (source name → contact). */
  contacts: Map<string, Contact>;
  /** Qualified refs of `ir` indexed by referenced package (lazy cache). */
  refIndex: Map<string, Set<string>> | undefined;
}

/**
 * Compute a consumer's contacts against every known node: qualified
 * references intersected with the source's taint, plus the anchor-only
 * event/rename rules for direct dependents.
 *
 * The consumer's qualified refs are indexed once per node (memoized on the
 * node across fixed-point rounds); each per-source check is then a pair of
 * map lookups, keeping the whole contact pass O(consumers × IR + contacts)
 * instead of the previous O(consumers² × IR) per round.
 */
function computeContacts(node: Node, nodes: ReadonlyMap<string, Node>, marks: Marks, anchorName: string): Map<string, Contact> {
  const contacts = new Map<string, Contact>();
  if (node.ir === undefined) return contacts;
  if (node.refIndex === undefined) node.refIndex = indexRefsByPackage(node.ir);
  const refIndex = node.refIndex;

  for (const source of nodes.values()) {
    if (source === node) continue;
    const isAnchor = source.name === anchorName;
    const hasEventMarks = isAnchor && marks.events.size > 0;
    const hasRename = isAnchor && marks.renameIndex !== undefined;
    if (source.taint.size === 0 && !hasEventMarks && !hasRename) continue;

    // Names `node` references from this source package (full name or base).
    const refNames = new Set<string>();
    for (const pkg of [source.name, source.base]) {
      const names = refIndex.get(pkg);
      if (names !== undefined) for (const name of names) refNames.add(name);
    }
    const changes = new Set<number>();
    const types = new Set<string>();
    for (const name of refNames) {
      const tainted = source.taint.get(name);
      if (tainted === undefined) continue;
      types.add(name);
      for (const i of tainted) changes.add(i);
    }

    const imports = node.meta.imports;
    const isDirect = imports.includes(source.name) || imports.includes(source.base);
    let event = false;
    if (isAnchor && isDirect && hasEventMarks) {
      for (const indices of marks.events.values()) {
        if (indices.size > 0) {
          event = true;
          for (const i of indices) changes.add(i);
        }
      }
    }
    const rename = isAnchor && hasRename;
    if (rename) {
      changes.add(marks.renameIndex as number);
    }

    if (types.size === 0 && !event && !rename) continue;
    contacts.set(source.name, { types, changes, event, rename });
  }
  return contacts;
}

/**
 * Propagate taint into a consumer's local types: a local type is tainted when
 * its local reference closure reaches a foreign reference that carries taint.
 */
function computeTaint(node: Node, nodes: ReadonlyMap<string, Node>): Map<string, Set<number>> {
  if (node.ir === undefined) return new Map();
  // Qualified foreign references touched by any contact: refKey → change indices.
  const touchedByRef = new Map<string, Set<number>>();
  for (const [sourceName, contact] of node.contacts) {
    const source = nodes.get(sourceName);
    if (source === undefined) continue;
    for (const name of contact.types) {
      const indices = source.taint.get(name);
      if (indices === undefined) continue;
      for (const pkg of [source.name, source.base]) {
        const key = `${pkg}#${name}`;
        const set = touchedByRef.get(key) ?? new Set<number>();
        for (const i of indices) set.add(i);
        touchedByRef.set(key, set);
      }
    }
  }

  const graph = localGraph(node.ir);
  const taint = new Map<string, Set<number>>();
  for (const [typeName, edge] of graph) {
    // DFS over local edges; foreign refs are leaves checked against taint.
    const visited = new Set<string>([typeName]);
    const stack = [...edge.local];
    const combined = new Set<number>();
    for (const key of edge.foreign) {
      const touched = touchedByRef.get(key);
      if (touched !== undefined) for (const i of touched) combined.add(i);
    }
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (visited.has(current)) continue;
      visited.add(current);
      const currentEdge = graph.get(current);
      if (currentEdge === undefined) continue; // dangling local name
      for (const key of currentEdge.foreign) {
        const touched = touchedByRef.get(key);
        if (touched !== undefined) for (const i of touched) combined.add(i);
      }
      for (const next of currentEdge.local) if (!visited.has(next)) stack.push(next);
    }
    if (combined.size > 0) taint.set(typeName, combined);
  }
  return taint;
}

// ---------------------------------------------------------------------------
// Suggested actions
// ---------------------------------------------------------------------------

/** Kind-specific guidance for evolving a contract safely. */
function actionFor(change: Change): string {
  switch (change.kind) {
    case 'field-added':
      return change.classification === 'WARNING'
        ? 'Adding a required field forces producers to emit it — make the field optional or publish a new package version.'
        : 'No action required — additive change.';
    case 'field-removed':
      return 'Deprecate the field first, migrate the listed consumers, then remove it in a future version.';
    case 'field-renamed':
      return 'Keep the old field as a deprecated alias during the migration window, then remove it.';
    case 'field-type-changed':
      return change.classification === 'WARNING'
        ? 'Widening is wire-compatible for most clients — confirm generated code accepts the wider type.'
        : 'Introduce a new field with the new type, deprecate the old one, and migrate consumers before switching.';
    case 'field-optional-changed':
      return change.classification === 'SAFE'
        ? 'No action required — the field may now be absent; ensure consumers handle absence.'
        : 'Restore optionality or provide a default — requiring previously optional values breaks existing producers.';
    case 'field-default-changed':
      return 'Audit consumers relying on the previous default before shipping the new one.';
    case 'field-constraint-changed':
      return 'Tightened constraints can reject previously valid data — coordinate with producers or relax the constraint.';
    case 'field-deprecated':
      return 'No action required — announce the deprecation and its removal timeline.';
    case 'field-deprecation-removed':
      return 'Re-add the deprecation marker until the migration window closes.';
    case 'enum-value-added':
    case 'union-variant-added':
      return 'Exhaustive switches in consumers must handle the new value — add a default case before upgrading.';
    case 'enum-value-removed':
    case 'union-variant-removed':
      return 'Deprecate the value first and give consumers a migration window before removing it.';
    case 'union-variant-changed':
      return 'Keep the old variant shape available during migration, or publish a new package version.';
    case 'alias-target-changed':
      return 'Aliases are transparent to consumers — restore the old target or introduce a new alias name.';
    case 'alias-added':
    case 'type-added':
    case 'method-added':
    case 'event-added':
      return 'No action required — additive change.';
    case 'alias-removed':
    case 'type-removed':
      return 'Keep the type as a deprecated alias during the migration window; the listed consumers still reference it.';
    case 'type-kind-changed':
      return 'Changing a type kind breaks every reference — publish a new package version instead.';
    case 'method-removed':
      return 'Keep the method (or a delegating replacement) for one release cycle before removing it.';
    case 'method-signature-changed':
      return 'Add a new method with the new signature and deprecate the old one instead of editing it in place.';
    case 'event-removed':
      return 'Keep publishing the event for a migration window and announce the removal to subscribers.';
    case 'event-field-changed':
      return 'Coordinate with subscribers — prefer adding new fields and deprecating old ones.';
    case 'package-renamed':
      return 'Republish under the old name during a deprecation window so name-based references keep resolving.';
    case 'import-added':
    case 'import-removed':
      return 'No action required — import changes do not affect the wire format.';
    default:
      return 'Review the change with the affected consumers before publishing.';
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Compute the consumer-aware impact of a contract change.
 *
 * Input combinations (exactly one baseline and one candidate source):
 * - `{ oldIR, newIR }` — both IRs provided directly; `registry` optional
 *   (without it no consumer graph is traversed);
 * - `{ oldName, newIR, registry }` — baseline pulled from the registry
 *   (`oldName` may carry `@version`; without it the latest version is used);
 * - `{ oldName, newVersion, registry }` — both sides pulled from the registry.
 *
 * @returns a deterministic {@link ImpactReport}; identical inputs produce
 * byte-identical output.
 */
export function computeImpact(options: ImpactOptions): ImpactReport {
  const { oldIR, newIR, oldName, newVersion, registry, labels } = options;

  // ---- input validation -------------------------------------------------
  if (oldIR === undefined && oldName === undefined) {
    throw new ImpactError('invalid-input', "computeImpact needs a baseline: pass 'oldIR' or 'oldName'.");
  }
  if (oldName !== undefined && registry === undefined) {
    throw new ImpactError('invalid-input', "computeImpact with 'oldName' requires a 'registry'.");
  }
  if (newVersion !== undefined) {
    if (registry === undefined || oldName === undefined) {
      throw new ImpactError('invalid-input', "computeImpact with 'newVersion' requires 'oldName' and a 'registry'.");
    }
    if (newIR !== undefined) {
      throw new ImpactError('invalid-input', "Pass either 'newIR' or 'newVersion', not both.");
    }
  }
  if (newIR === undefined && newVersion === undefined) {
    throw new ImpactError('invalid-input', "computeImpact needs a candidate: pass 'newIR' or 'newVersion'.");
  }

  // ---- resolve the baseline (anchor) ------------------------------------
  let anchorMeta: ContractMetaLike | undefined;
  let oldPackage: IRPackage;
  if (oldIR !== undefined) {
    oldPackage = oldIR;
  } else {
    const raw = oldName as string;
    const at = raw.lastIndexOf('@');
    const namePart = at > 0 ? raw.slice(0, at) : raw;
    const versionPart = at > 0 ? raw.slice(at + 1) : undefined;
    try {
      anchorMeta =
        versionPart !== undefined
          ? registry?.pull(namePart, versionPart).meta
          : registry?.latest(namePart);
      if (anchorMeta === undefined) throw new Error('registry returned no metadata');
      const pulled = registry?.pull(anchorMeta.packageName, anchorMeta.version);
      if (pulled === undefined) throw new Error('registry returned no contract');
      anchorMeta = pulled.meta;
      oldPackage = pulled.ir;
    } catch (e) {
      throw new ImpactError('registry', `cannot load baseline '${raw}' from the registry: ${describe(e)}`);
    }
  }

  // ---- resolve the candidate --------------------------------------------
  let newMeta: ContractMetaLike | undefined;
  let newPackage: IRPackage;
  if (newVersion !== undefined) {
    try {
      const pulled = registry?.pull(oldPackage.name, newVersion);
      if (pulled === undefined) throw new Error('registry returned no contract');
      newMeta = pulled.meta;
      newPackage = pulled.ir;
    } catch (e) {
      throw new ImpactError(
        'registry',
        `cannot load candidate '${oldPackage.name}@${newVersion}' from the registry: ${describe(e)}`,
      );
    }
  } else {
    newPackage = newIR as IRPackage;
  }

  // ---- diff (reuses the classification engine verbatim) ------------------
  const report = diffPackages(oldPackage, newPackage);
  const changes = report.changes;
  const marks = buildMarks(oldPackage, newPackage, changes);

  // ---- discover the transitive consumer graph ----------------------------
  const anchor: Node = {
    meta: anchorMeta ?? {
      packageName: oldPackage.name,
      base: baseOf(oldPackage.name),
      version: '',
      imports: oldPackage.imports,
    },
    name: oldPackage.name,
    base: baseOf(oldPackage.name),
    ir: oldPackage,
    pullError: undefined,
    depth: 0,
    parent: undefined,
    taint: new Map(),
    contacts: new Map(),
    refIndex: undefined,
  };
  for (const [name, indices] of marks.types) anchor.taint.set(name, new Set(indices));

  const nodes = new Map<string, Node>([[anchor.name, anchor]]);
  const graphTraversed = registry !== undefined;
  const notes: string[] = [];

  if (registry !== undefined) {
    const queue: Node[] = [anchor];
    while (queue.length > 0) {
      const current = queue.shift() as Node;
      let deps: readonly ContractMetaLike[];
      try {
        deps = registry.dependents(current.name);
      } catch (e) {
        throw new ImpactError('registry', `cannot walk dependents of '${current.name}': ${describe(e)}`);
      }
      const sorted = [...deps].sort(compareMeta);
      for (const meta of sorted) {
        if (nodes.has(meta.packageName)) continue; // cycle-safe, dedupe
        let ir: IRPackage | undefined;
        let pullError: string | undefined;
        try {
          ir = registry.pull(meta.packageName, meta.version).ir;
        } catch (e) {
          pullError = describe(e);
        }
        const node: Node = {
          meta,
          name: meta.packageName,
          base: meta.base,
          ir,
          pullError,
          depth: current.depth + 1,
          parent: current,
          taint: new Map(),
          contacts: new Map(),
          refIndex: undefined,
        };
        nodes.set(meta.packageName, node);
        queue.push(node);
      }
    }

    // ---- taint fixed-point (bounded by node count) -----------------------
    const order = [...nodes.values()]
      .filter((n) => n !== anchor)
      .sort((a, b) => a.depth - b.depth || compareMeta(a.meta, b.meta));
    const maxRounds = order.length + 1;
    // Stability must be content-level, not key-level: taint VALUES (the set
    // of change indices flowing through an already-tainted name) can grow in
    // a round that adds no new keys. Stopping on key growth alone strands
    // late-arriving indices — a consumer processed before its source (it
    // sorts first at equal depth, or sits at a shallower depth) then misses
    // absorbing a BREAKING change. Per-name index sets only ever grow
    // (monotone), so equal total element counts imply identical content.
    const taintElements = (taint: ReadonlyMap<string, ReadonlySet<number>>): number => {
      let total = 0;
      for (const indices of taint.values()) total += indices.size;
      return total;
    };
    for (let round = 0; round < maxRounds; round++) {
      let grew = false;
      for (const node of order) {
        node.contacts = computeContacts(node, nodes, marks, anchor.name);
        const nextTaint = computeTaint(node, nodes);
        if (taintElements(nextTaint) > taintElements(node.taint)) grew = true;
        node.taint = nextTaint;
      }
      if (!grew) break;
    }

    if (marks.renameIndex !== undefined) {
      notes.push('The package itself was renamed: every discovered dependent is conservatively affected.');
    }
    if (marks.events.size > 0) {
      notes.push(
        'Event changes are attributed to direct dependents only: event subscriptions are not visible in contract IR.',
      );
    }
  } else {
    notes.push('No registry provided: the consumer graph was not traversed and no consumers are listed.');
  }

  // ---- aggregate consumers ------------------------------------------------
  const route = (node: Node): string[] => {
    const path: string[] = [];
    for (let n: Node | undefined = node; n !== undefined; n = n.parent) path.push(n.name);
    return path.reverse();
  };
  const consumers: AffectedConsumer[] = [];
  let unscannable = 0;
  for (const node of [...nodes.values()].filter((n) => n !== anchor).sort(compareNode)) {
    let severity: Classification = 'SAFE';
    let reason: ContactReason = 'unaffected';
    const viaTypes = new Set<string>();
    let affected = false;

    if (node.ir === undefined) {
      unscannable += 1;
      affected = true;
      severity = worstSeverity(severity, 'UNKNOWN');
      reason = strongerReason(reason, 'unscannable');
      notes.push(
        `Consumer '${node.name}@${node.meta.version}' could not be pulled from the registry and is conservatively counted as affected (${node.pullError}).`,
      );
    }
    for (const [sourceName, contact] of [...node.contacts].sort((a, b) => cmp(a[0], b[0]))) {
      if (contact.rename) {
        affected = true;
        severity = worstSeverity(severity, (changes[marks.renameIndex as number] as Change).classification);
        reason = strongerReason(reason, 'package-renamed');
      }
      if (contact.types.size > 0) {
        affected = true;
        for (const t of contact.types) viaTypes.add(t);
        for (const i of contact.changes) {
          severity = worstSeverity(severity, (changes[i] as Change).classification);
        }
        reason = strongerReason(reason, sourceName === anchor.name ? 'direct-type' : 'through');
      } else if (contact.event) {
        affected = true;
        for (const i of contact.changes) {
          severity = worstSeverity(severity, (changes[i] as Change).classification);
        }
        reason = strongerReason(reason, 'event');
      }
    }

    const consumer: AffectedConsumer = {
      packageName: node.name,
      version: node.meta.version,
      depth: node.depth,
      severity: affected ? severity : 'SAFE',
      reason: affected ? reason : 'unaffected',
      scanned: node.ir !== undefined,
      viaTypes: [...viaTypes].sort(cmp),
      viaPackages: route(node),
    };
    if (node.meta.owner !== undefined) consumer.owner = node.meta.owner;
    if (node.meta.repository !== undefined) consumer.repository = node.meta.repository;
    consumers.push(consumer);
  }

  const bySeverity = { breaking: 0, unknown: 0, warning: 0, safe: 0 };
  for (const c of consumers) {
    switch (c.severity) {
      case 'BREAKING':
        bySeverity.breaking += 1;
        break;
      case 'UNKNOWN':
        bySeverity.unknown += 1;
        break;
      case 'WARNING':
        bySeverity.warning += 1;
        break;
      case 'SAFE':
        bySeverity.safe += 1;
        break;
    }
  }
  const stats: ImpactStats = {
    total: changes.length,
    breaking: report.summary.breaking,
    warning: report.summary.warning,
    safe: report.summary.safe,
    unknown: report.summary.unknown,
    consumersAffected: bySeverity.breaking + bySeverity.unknown + bySeverity.warning,
    consumersBreakingAffected: bySeverity.breaking,
  };

  // ---- suggested actions (one per change) ---------------------------------
  const reachesByChange = new Map<number, Set<string>>();
  for (const consumer of consumers) {
    const node = nodes.get(consumer.packageName);
    if (node === undefined) continue;
    if (consumer.reason === 'unscannable') continue; // handled below
    for (const contact of node.contacts.values()) {
      for (const i of contact.changes) {
        const set = reachesByChange.get(i) ?? new Set<string>();
        set.add(consumer.packageName);
        reachesByChange.set(i, set);
      }
    }
  }
  const suggestedActions: SuggestedAction[] = changes.map((change, index) => {
    const reaches = new Set(reachesByChange.get(index) ?? new Set<string>());
    if (unscannable > 0 && change.classification !== 'SAFE') {
      for (const consumer of consumers) {
        if (consumer.reason === 'unscannable') reaches.add(consumer.packageName);
      }
    }
    const action: SuggestedAction = {
      path: change.path,
      kind: change.kind,
      classification: change.classification,
      action: actionFor(change),
      reaches: [...reaches].sort(cmp),
    };
    return action;
  });

  return {
    contract: oldPackage.name,
    fromRef: labels?.from ?? (anchorMeta !== undefined ? `${anchorMeta.packageName}@${anchorMeta.version}` : `${oldPackage.name} (provided IR)`),
    toRef: labels?.to ?? (newMeta !== undefined ? `${newMeta.packageName}@${newMeta.version}` : `${newPackage.name} (provided IR)`),
    changes,
    affectedConsumers: consumers,
    stats,
    suggestedActions,
    verdict: report.verdict,
    analysis: {
      graphTraversed,
      method: 'type-reference-reachability',
      notes,
    },
  };
}

/** Canonical consumer order: name, then version (numeric-aware). */
function compareNode(a: Node, b: Node): number {
  return compareMeta(a.meta, b.meta);
}
