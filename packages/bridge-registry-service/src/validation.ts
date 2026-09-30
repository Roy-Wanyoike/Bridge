/**
 * Strict, fail-closed validation of untrusted input.
 *
 * Contract contents arriving over HTTP are UNTRUSTED: everything is validated
 * structurally before it can reach a storage driver or the hashing path.
 *
 * `validateIRPackage` mirrors the canonical IR contract frozen in
 * `@bridge/core` (`src/ir/types.ts`), including its canonicality guarantees
 * (sorted, deduplicated `imports`; `types` sorted by name). Unknown fields
 * are rejected at every level — extra keys would silently change the content
 * hash, so the surface is closed. @bridge/core has no runtime validator to
 * import (its entry point is `compileSource`), so this module is the
 * service's own enforcement of the same rules; it is kept in lockstep with
 * the frozen IR contract and unit-tested against compiler output.
 */

import type {
  IRConstraint,
  IREnum,
  IREnumVariant,
  IREvent,
  IRField,
  IRMethod,
  IRPackage,
  IRService,
  IRTypeDefinition,
  IRUnion,
  PrimitiveKind,
  TypeRef,
} from '@bridge/core';
import { ServiceError } from './errors';

// ------------------------------------------------------------------ limits

/** Recursion cap for nested TypeRefs. */
const MAX_TYPE_REF_DEPTH = 32;
/** Hard caps on collection sizes (DoS resistance; body is capped too). */
const MAX_IMPORTS = 1000;
const MAX_TYPES = 10_000;
const MAX_FIELDS = 1000;
const MAX_METHODS = 1000;
const MAX_EVENTS = 1000;
const MAX_VARIANTS = 1000;
const MAX_CONSTRAINTS = 64;
const MAX_CONSTRAINT_ARGS = 32;
const MAX_STRING_LENGTH = 10_000;
const MAX_IDENTIFIER_LENGTH = 128;

// ----------------------------------------------------------------- helpers

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class Validator {
  public readonly errors: string[] = [];

  public fail(message: string): false {
    this.errors.push(message);
    return false;
  }

  /** Reject keys not in `allowed`; returns false (after recording) on extras. */
  public exactKeys(value: Record<string, unknown>, allowed: readonly string[], at: string): boolean {
    let ok = true;
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) {
        this.fail(`${at}: unknown field '${key}'`);
        ok = false;
      }
    }
    return ok;
  }

  public str(value: unknown, at: string, re?: RegExp): value is string {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_STRING_LENGTH) {
      this.fail(`${at}: expected a non-empty string (max ${MAX_STRING_LENGTH} chars)`);
      return false;
    }
    if (re !== undefined && !re.test(value)) {
      this.fail(`${at}: ${JSON.stringify(value)} does not match ${re}`);
      return false;
    }
    return true;
  }

  public optStr(value: unknown, at: string, re?: RegExp): boolean {
    if (value === undefined) return true;
    return this.str(value, at, re);
  }
}

/** Bridge identifiers: letters/digits/underscore, not starting with a digit. */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_DEPRECATION_LENGTH = MAX_STRING_LENGTH;

const PRIMITIVES: readonly string[] = [
  'string',
  'bool',
  'int32',
  'int64',
  'uint32',
  'uint64',
  'float32',
  'float64',
  'bytes',
  'uuid',
  'timestamp',
  'decimal',
  'json',
];

const CONSTRAINT_KINDS: readonly string[] = [
  'min',
  'max',
  'length',
  'email',
  'url',
  'pattern',
  'uuid',
];

const TYPE_KINDS: readonly string[] = ['struct', 'enum', 'union', 'alias'];

// ---------------------------------------------------------------- TypeRefs

function validateTypeRef(v: Validator, ref: unknown, at: string, depth: number): boolean {
  if (depth > MAX_TYPE_REF_DEPTH) {
    return v.fail(`${at}: type reference nesting exceeds ${MAX_TYPE_REF_DEPTH} levels`);
  }
  if (!isPlainObject(ref)) {
    return v.fail(`${at}: expected a type reference object`);
  }
  const kind = ref['kind'];
  switch (kind) {
    case 'primitive': {
      if (!PRIMITIVES.includes(ref['primitive'] as string)) {
        return v.fail(`${at}: unknown primitive ${JSON.stringify(ref['primitive'])}`);
      }
      return v.exactKeys(ref, ['kind', 'primitive'], at);
    }
    case 'named': {
      let ok = v.str(ref['name'], `${at}.name`, IDENT_RE);
      ok = v.optStr(ref['package'], `${at}.package`) && ok;
      if (typeof ref['package'] === 'string' && !/^[a-z][a-z0-9_.-]*$/.test(ref['package'])) {
        v.fail(`${at}.package: not a valid dotted package name`);
        ok = false;
      }
      return v.exactKeys(ref, ['kind', 'name', 'package'], at) && ok;
    }
    case 'list':
    case 'set': {
      if (ref['element'] === undefined) return v.fail(`${at}: missing 'element'`);
      const inner = validateTypeRef(v, ref['element'], `${at}.element`, depth + 1);
      return v.exactKeys(ref, ['kind', 'element'], at) && inner;
    }
    case 'map': {
      if (ref['key'] === undefined || ref['value'] === undefined) {
        return v.fail(`${at}: map references need 'key' and 'value'`);
      }
      const k = validateTypeRef(v, ref['key'], `${at}.key`, depth + 1);
      const val = validateTypeRef(v, ref['value'], `${at}.value`, depth + 1);
      return v.exactKeys(ref, ['kind', 'key', 'value'], at) && k && val;
    }
    case 'optional': {
      if (ref['inner'] === undefined) return v.fail(`${at}: missing 'inner'`);
      const inner = validateTypeRef(v, ref['inner'], `${at}.inner`, depth + 1);
      return v.exactKeys(ref, ['kind', 'inner'], at) && inner;
    }
    default:
      return v.fail(`${at}: unknown type reference kind ${JSON.stringify(kind)}`);
  }
}

function validateDeprecation(v: Validator, value: unknown, at: string): boolean {
  if (value === undefined) return true;
  if (value === true) return true;
  return v.str(value, at) && value.length <= MAX_DEPRECATION_LENGTH;
}

function validateConstraints(v: Validator, value: unknown, at: string): boolean {
  if (!Array.isArray(value)) {
    v.fail(`${at}: expected an array`);
    return false;
  }
  if (value.length > MAX_CONSTRAINTS) {
    v.fail(`${at}: more than ${MAX_CONSTRAINTS} constraints`);
    return false;
  }
  let ok = true;
  for (let i = 0; i < value.length; i++) {
    const c = value[i] as unknown;
    const cat = `${at}[${i}]`;
    if (!isPlainObject(c)) {
      v.fail(`${cat}: expected an object`);
      ok = false;
      continue;
    }
    let cok = v.exactKeys(c, ['kind', 'args', 'message'], cat);
    if (!CONSTRAINT_KINDS.includes(c['kind'] as string)) {
      v.fail(`${cat}.kind: unknown constraint kind ${JSON.stringify(c['kind'])}`);
      cok = false;
    }
    if (!Array.isArray(c['args'])) {
      v.fail(`${cat}.args: expected an array of strings`);
      cok = false;
    } else {
      if (c['args'].length > MAX_CONSTRAINT_ARGS) {
        v.fail(`${cat}.args: more than ${MAX_CONSTRAINT_ARGS} arguments`);
        cok = false;
      }
      for (let j = 0; j < (c['args'] as unknown[]).length; j++) {
        if (typeof (c['args'] as unknown[])[j] !== 'string') {
          v.fail(`${cat}.args[${j}]: expected a string`);
          cok = false;
        }
      }
    }
    cok = v.optStr(c['message'], `${cat}.message`) && cok;
    ok = ok && cok;
  }
  return ok;
}

function validateField(v: Validator, field: unknown, at: string): boolean {
  if (!isPlainObject(field)) {
    v.fail(`${at}: expected a field object`);
    return false;
  }
  let ok = v.exactKeys(field, ['name', 'type', 'optional', 'constraints', 'docs', 'deprecated', 'default'], at);
  ok = v.str(field['name'], `${at}.name`, IDENT_RE) && ok;
  if (field['type'] === undefined) {
    v.fail(`${at}.type: missing`);
    ok = false;
  } else {
    ok = validateTypeRef(v, field['type'], `${at}.type`, 0) && ok;
  }
  if (typeof field['optional'] !== 'boolean') {
    v.fail(`${at}.optional: expected a boolean`);
    ok = false;
  }
  ok = validateConstraints(v, field['constraints'], `${at}.constraints`) && ok;
  ok = v.optStr(field['docs'], `${at}.docs`) && ok;
  ok = validateDeprecation(v, field['deprecated'], `${at}.deprecated`) && ok;
  ok = v.optStr(field['default'], `${at}.default`) && ok;
  return ok;
}

function validateNameDocsList(
  v: Validator,
  items: unknown,
  at: string,
  max: number,
  extraKeys: readonly string[],
  validateItem: (item: unknown, at: string) => boolean,
): boolean {
  if (!Array.isArray(items)) {
    v.fail(`${at}: expected an array`);
    return false;
  }
  if (items.length > max) {
    v.fail(`${at}: more than ${max} entries`);
    return false;
  }
  let ok = true;
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as unknown;
    const iat = `${at}[${i}]`;
    if (isPlainObject(item)) {
      ok = v.exactKeys(item, ['name', ...extraKeys, 'docs', 'deprecated'], iat) && ok;
      ok = v.str(item['name'], `${iat}.name`, IDENT_RE) && ok;
    }
    ok = validateItem(item, iat) && ok;
  }
  return ok;
}

// -------------------------------------------------------------- IRPackage

/**
 * Validate an untrusted parsed IR object against the canonical IR contract.
 * Returns `{ ok: true, ir }` (the same reference, typed) or
 * `{ ok: false, errors }` with every violation found (not just the first).
 */
export function validateIRPackage(value: unknown): { ok: true; ir: IRPackage } | { ok: false; errors: string[] } {
  const v = new Validator();
  const ok = validatePackage(v, value);
  if (ok && v.errors.length === 0) {
    return { ok: true, ir: value as IRPackage };
  }
  return { ok: false, errors: v.errors.length > 0 ? v.errors : ['expected an IR object'] };
}

function validatePackage(v: Validator, value: unknown): boolean {
  if (!isPlainObject(value)) {
    v.fail('expected an IRPackage object');
    return false;
  }
  let ok = v.exactKeys(value, ['name', 'imports', 'types', 'services', 'events', 'docs'], '$');
  ok = v.str(value['name'], '$.name') && ok;
  if (typeof value['name'] === 'string') {
    if (value['name'].length > 200) {
      v.fail('$.name: longer than 200 chars');
      ok = false;
    }
    if (!/^[a-z][a-z0-9_.-]*$/.test(value['name'])) {
      v.fail('$.name: not a valid dotted lowercase package name');
      ok = false;
    } else if (value['name'].includes('..') || value['name'].endsWith('.') || value['name'].endsWith('-')) {
      v.fail('$.name: empty name segment or trailing punctuation');
      ok = false;
    }
  }
  // imports: sorted, deduplicated, each a valid package name (canonicality).
  if (!Array.isArray(value['imports'])) {
    v.fail('$.imports: expected an array of package names');
    ok = false;
  } else {
    const imports = value['imports'] as unknown[];
    if (imports.length > MAX_IMPORTS) {
      v.fail(`$.imports: more than ${MAX_IMPORTS} entries`);
      ok = false;
    }
    for (let i = 0; i < imports.length; i++) {
      const imp = imports[i] as unknown;
      if (
        typeof imp !== 'string' ||
        imp.length === 0 ||
        imp.length > 200 ||
        !/^[a-z][a-z0-9_.-]*$/.test(imp) ||
        imp.includes('..') ||
        imp.endsWith('.') ||
        imp.endsWith('-')
      ) {
        v.fail(`$.imports[${i}]: not a valid package name`);
        ok = false;
      }
    }
    for (let i = 1; i < imports.length; i++) {
      const prev = imports[i - 1] as string;
      const cur = imports[i] as string;
      if (prev === cur) {
        v.fail(`$.imports[${i}]: duplicate import '${cur}'`);
        ok = false;
      } else if (prev > cur) {
        v.fail('$.imports: not sorted (canonical IR requires sorted imports)');
        ok = false;
        break;
      }
    }
  }

  // types: objects with a name + a kind'd body, sorted by name, unique.
  if (!Array.isArray(value['types'])) {
    v.fail('$.types: expected an array');
    ok = false;
  } else {
    const types = value['types'] as unknown[];
    if (types.length > MAX_TYPES) {
      v.fail(`$.types: more than ${MAX_TYPES} entries`);
      ok = false;
    }
    for (let i = 0; i < types.length; i++) {
      ok = validateTypeDefinition(v, types[i], `$.types[${i}]`) && ok;
    }
    for (let i = 1; i < types.length; i++) {
      const prev = (types[i - 1] as Record<string, unknown>)['name'];
      const cur = (types[i] as Record<string, unknown>)['name'];
      if (typeof prev === 'string' && typeof cur === 'string') {
        if (prev === cur) {
          v.fail(`$.types[${i}]: duplicate type name '${cur}'`);
          ok = false;
        } else if (prev > cur) {
          v.fail('$.types: not sorted by name (canonical IR requires sorted types)');
          ok = false;
          break;
        }
      }
    }
  }

  ok = validateNameDocsList(v, value['services'], '$.services', MAX_METHODS, ['methods'], (item, at) => validateService(v, item, at)) && ok;
  ok = validateNameDocsList(v, value['events'], '$.events', MAX_EVENTS, ['fields'], (item, at) => validateEvent(v, item, at)) && ok;
  ok = validateCrossCategoryNames(v, value) && ok;
  ok = v.optStr(value['docs'], '$.docs') && ok;
  return ok;
}

/**
 * Cross-category duplicate-name backstop (issue #120 item 9).
 *
 * The per-category checks above only see their own arrays (`types` is
 * sorted+unique; methods/variants are per-definition). But the compiler
 * treats type, event and service names as ONE namespace (BR2002: generators
 * emit every declaration into the same scope), so a name reused across
 * categories produces non-compiling generated code. The publish side must
 * reject at the HTTP boundary what the compiler would reject at build time.
 *
 * Each collision is reported once, naming the offending name AND both
 * declaration locations. Non-string/empty names are already reported by the
 * per-item checks and are skipped here. Same-category duplicates of
 * services/events are a separate (pre-existing) gap and intentionally not
 * handled by this backstop.
 */
function validateCrossCategoryNames(v: Validator, value: Record<string, unknown>): boolean {
  interface FirstUse {
    /** Path of the first declaration, e.g. `$.types[0]`. */
    at: string;
    /** Category of the first declaration. */
    category: 'types' | 'services' | 'events';
  }
  const firstUse = new Map<string, FirstUse>();
  let ok = true;
  const scan = (category: 'types' | 'services' | 'events'): void => {
    const items = value[category];
    if (!Array.isArray(items)) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i] as unknown;
      if (!isPlainObject(item)) continue;
      const name = item['name'];
      if (typeof name !== 'string' || name.length === 0) continue;
      const at = `$.${category}[${i}]`;
      const seen = firstUse.get(name);
      if (seen === undefined) {
        firstUse.set(name, { at, category });
      } else if (seen.category !== category) {
        v.fail(
          `${at}: name '${name}' is already used by a ${seen.category.replace(/s$/, '')} declaration (${seen.at}) — ` +
            'type, event and service names share one namespace within a package (rename one of them)',
        );
        ok = false;
      }
    }
  };
  scan('types');
  scan('services');
  scan('events');
  return ok;
}

function validateTypeDefinition(v: Validator, def: unknown, at: string): boolean {
  if (!isPlainObject(def)) {
    v.fail(`${at}: expected a type definition object`);
    return false;
  }
  let ok = v.exactKeys(def, ['name', 'kind', 'docs', 'deprecated', 'fields', 'variants', 'target'], at);
  ok = v.str(def['name'], `${at}.name`, IDENT_RE) && ok;
  ok = validateDeprecation(v, def['deprecated'], `${at}.deprecated`) && ok;
  ok = v.optStr(def['docs'], `${at}.docs`) && ok;
  const kind = def['kind'];
  switch (kind) {
    case 'struct': {
      if (!Array.isArray(def['fields'])) {
        v.fail(`${at}.fields: expected an array`);
        ok = false;
        break;
      }
      if ((def['fields'] as unknown[]).length > MAX_FIELDS) {
        v.fail(`${at}.fields: more than ${MAX_FIELDS} fields`);
        ok = false;
        break;
      }
      for (let i = 0; i < (def['fields'] as unknown[]).length; i++) {
        ok = validateField(v, (def['fields'] as unknown[])[i], `${at}.fields[${i}]`) && ok;
      }
      break;
    }
    case 'enum': {
      if (!Array.isArray(def['variants'])) {
        v.fail(`${at}.variants: expected an array`);
        ok = false;
        break;
      }
      const variants = def['variants'] as unknown[];
      if (variants.length > MAX_VARIANTS) {
        v.fail(`${at}.variants: more than ${MAX_VARIANTS} variants`);
        ok = false;
        break;
      }
      const seen = new Set<string>();
      for (let i = 0; i < variants.length; i++) {
        const variant = variants[i] as unknown;
        const vat = `${at}.variants[${i}]`;
        if (isPlainObject(variant)) {
          ok = v.exactKeys(variant, ['name', 'docs', 'deprecated'], vat) && ok;
          ok = v.str(variant['name'], `${vat}.name`, IDENT_RE) && ok;
          ok = validateDeprecation(v, variant['deprecated'], `${vat}.deprecated`) && ok;
          ok = v.optStr(variant['docs'], `${vat}.docs`) && ok;
          if (typeof variant['name'] === 'string') {
            if (seen.has(variant['name'])) {
              v.fail(`${vat}: duplicate variant name '${variant['name']}'`);
              ok = false;
            }
            seen.add(variant['name'] as string);
          }
        } else {
          v.fail(`${vat}: expected an object`);
          ok = false;
        }
      }
      break;
    }
    case 'union': {
      if (!Array.isArray(def['variants'])) {
        v.fail(`${at}.variants: expected an array`);
        ok = false;
        break;
      }
      const variants = def['variants'] as unknown[];
      if (variants.length > MAX_VARIANTS) {
        v.fail(`${at}.variants: more than ${MAX_VARIANTS} variants`);
        ok = false;
        break;
      }
      const seen = new Set<string>();
      for (let i = 0; i < variants.length; i++) {
        const variant = variants[i] as unknown;
        const vat = `${at}.variants[${i}]`;
        ok = validateField(v, variant, vat) && ok;
        if (isPlainObject(variant) && typeof variant['name'] === 'string') {
          if (seen.has(variant['name'])) {
            v.fail(`${vat}: duplicate variant name '${variant['name']}'`);
            ok = false;
          }
          seen.add(variant['name'] as string);
        }
      }
      break;
    }
    case 'alias': {
      if (def['target'] === undefined) {
        v.fail(`${at}.target: missing`);
        ok = false;
      } else {
        ok = validateTypeRef(v, def['target'], `${at}.target`, 0) && ok;
      }
      break;
    }
    default:
      v.fail(`${at}.kind: unknown kind ${JSON.stringify(kind)}`);
      ok = false;
  }
  return ok;
}

function validateService(v: Validator, service: unknown, at: string): boolean {
  if (!isPlainObject(service)) return false;
  if (!Array.isArray(service['methods'])) return false;
  const methods = service['methods'] as unknown[];
  if (methods.length > MAX_METHODS) return false;
  let ok = true;
  const seen = new Set<string>();
  for (let i = 0; i < methods.length; i++) {
    const method = methods[i] as unknown;
    const mat = `${at}.methods[${i}]`;
    if (!isPlainObject(method)) {
      ok = false;
      continue;
    }
    ok = v.exactKeys(method, ['name', 'input', 'output', 'docs', 'deprecated'], mat) && ok;
    ok = v.str(method['name'], `${mat}.name`, IDENT_RE) && ok;
    if (typeof method['name'] === 'string') {
      if (seen.has(method['name'])) {
        v.fail(`${mat}: duplicate method name '${method['name']}'`);
        ok = false;
      }
      seen.add(method['name'] as string);
    }
    ok = validateTypeRef(v, method['input'], `${mat}.input`, 0) && ok;
    ok = validateTypeRef(v, method['output'], `${mat}.output`, 0) && ok;
    ok = v.optStr(method['docs'], `${mat}.docs`) && ok;
    ok = validateDeprecation(v, method['deprecated'], `${mat}.deprecated`) && ok;
  }
  return ok;
}

function validateEvent(v: Validator, event: unknown, at: string): boolean {
  if (!isPlainObject(event)) return false;
  if (!Array.isArray(event['fields'])) return false;
  const fields = event['fields'] as unknown[];
  if (fields.length > MAX_FIELDS) return false;
  let ok = true;
  for (let i = 0; i < fields.length; i++) {
    ok = validateField(v, fields[i], `${at}.fields[${i}]`) && ok;
  }
  return ok;
}

// ------------------------------------------------------------- coordinates

/** Org/project slug rule: lowercase alphanumerics and `-`, 1–63 chars. */
const ORG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Package-name rule mirrored from `@bridge/registry` (`name.ts`). */
const PACKAGE_NAME_RE = /^[a-z][a-z0-9_.-]*$/;
const MAX_PACKAGE_NAME_LENGTH = 200;

export function isValidOrgOrProject(value: unknown): value is string {
  return typeof value === 'string' && ORG_RE.test(value);
}

export function assertOrgOrProject(value: unknown, what: 'org' | 'project'): string {
  if (!isValidOrgOrProject(value)) {
    throw new ServiceError(
      400,
      'invalid_argument',
      `${what} must be a lowercase alphanumeric slug matching /^[a-z0-9][a-z0-9-]{0,62}$/`,
    );
  }
  return value;
}

export function isValidContractName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_PACKAGE_NAME_LENGTH &&
    PACKAGE_NAME_RE.test(value) &&
    !value.includes('..') &&
    !value.endsWith('.') &&
    !value.endsWith('-')
  );
}

export function assertContractName(value: unknown): string {
  if (!isValidContractName(value)) {
    throw new ServiceError(
      400,
      'invalid_argument',
      "contract must be a dotted lowercase package name (e.g. 'payments.v1'); " +
        "path separators, '..', uppercase letters, leading dots and trailing '.'/'-' are rejected",
    );
  }
  return value;
}

/** Validate an ISO-8601 timestamp used for publishTime / audit bounds. */
export function assertIsoTimestamp(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
    throw new ServiceError(400, 'invalid_argument', `${what} must be an ISO-8601 timestamp string`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ServiceError(400, 'invalid_argument', `${what} is not a valid ISO-8601 timestamp`);
  }
  return value;
}
