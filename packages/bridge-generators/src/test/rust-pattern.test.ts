/**
 * G1 (audit item, HIGH): generated Rust validators must ENFORCE `@pattern`
 * like Go/TS/Python/Java/C# instead of silently skipping it.
 *
 * Three behaviours are pinned here:
 * 1. A valid @pattern field compiles into an init-once
 *    `static RE_<FIELD>: LazyLock<Regex>` plus an `is_match` check, and the
 *    generated Cargo.toml gains `regex = "1"` (only when needed).
 * 2. A pattern the Rust `regex` crate cannot compile (lookahead, lookbehind,
 *    backreference, atomic/possessive quantifier, `\Q`, `\Z`) fails Rust
 *    GENERATION in full with a bridge-core Diagnostic: code BR2020, error
 *    severity, anchored on the package identity (the IR carries no source
 *    file/line) and naming the offending Type.field — never a silent skip.
 * 3. The compiler already rejects RE2-incompatible patterns at compile time
 *    (BR2018, with true file/line), so for IDL input BR2020 is
 *    defense-in-depth for IR that bypassed the parser/semantic checks.
 *
 * Raw-string embedding is covered too: Rust string escapes diverge from
 * JSON's, so patterns are embedded as raw string literals with a computed
 * `#` count.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compileSource, type IRPackage, type IRConstraint, type PrimitiveKind } from '@bridge/core';

import { generate } from '../index';
import { RUST_PATTERN_REGEX_CODE, RustPatternRegexError } from '../gen/rust';
import { makeMinimalIR } from './fixtures';
import type { GeneratedFile } from '../gen/input';

interface PatternFieldSpec {
  name: string;
  primitive: Extract<PrimitiveKind, 'string' | 'uuid' | 'decimal'>;
  optional?: boolean;
  constraints: Array<Omit<IRConstraint, 'kind'> & { kind: 'pattern' }>;
}

/** Package of struct declarations whose string-like fields carry @pattern. */
function makePatternIR(name: string, types: Array<{ name: string; fields: PatternFieldSpec[] }>): IRPackage {
  return {
    name,
    imports: [],
    types: types.map((t) => ({
      name: t.name,
      kind: 'struct' as const,
      fields: t.fields.map((f) => ({
        name: f.name,
        type: { kind: 'primitive' as const, primitive: f.primitive },
        optional: f.optional ?? false,
        constraints: f.constraints,
      })),
    })),
    services: [],
    events: [],
  };
}

function byPath(files: GeneratedFile[], path: string): GeneratedFile {
  const file = files.find((f) => f.path === path);
  assert.ok(file !== undefined, `expected generated file ${path}`);
  return file;
}

// ---------------------------------------------------------------------------
// (a) valid @pattern: regex-backed validation is emitted
// ---------------------------------------------------------------------------

test('rust @pattern: valid patterns generate regex-backed validation', () => {
  const ir = makePatternIR('pattern.v1', [
    {
      name: 'Address',
      fields: [
        { name: 'postal_code', primitive: 'string', constraints: [{ kind: 'pattern', args: ['^[0-9]{5}$'] }] },
        {
          name: 'po_box',
          primitive: 'string',
          optional: true,
          constraints: [{ kind: 'pattern', args: ['^#[A-Z]+$'], message: 'PO boxes start with #' }],
        },
      ],
    },
    {
      name: 'Shipment',
      fields: [
        { name: 'tracking_code', primitive: 'decimal', constraints: [{ kind: 'pattern', args: ['^[A-Z0-9-]{6,}$'] }] },
        { name: 'label', primitive: 'string', constraints: [{ kind: 'pattern', args: ['^v(?<minor>[0-9]+)$'] }] },
      ],
    },
  ]);
  const files = generate(ir, { language: 'rust' });
  const validate = byPath(files, 'src/validate.rs');
  const cargo = byPath(files, 'Cargo.toml');

  // One init-once static per constrained field, mirroring Go's
  // regexp.MustCompile package vars; compiled once via stdlib LazyLock.
  assert.match(validate.content, /static RE_POSTAL_CODE: LazyLock<Regex> = LazyLock::new/);
  assert.match(validate.content, /static RE_PO_BOX: LazyLock<Regex> = LazyLock::new/);
  assert.match(validate.content, /static RE_TRACKING_CODE: LazyLock<Regex> = LazyLock::new/);
  assert.match(validate.content, /static RE_LABEL: LazyLock<Regex> = LazyLock::new/);
  // is_match checks, on the borrowed value
  assert.match(validate.content, /if !RE_POSTAL_CODE\.is_match\(&self\.postal_code\) \{/);
  assert.match(validate.content, /if !RE_TRACKING_CODE\.is_match\(&self\.tracking_code\) \{/);
  // optional fields keep the Some-binding guard and check the borrowed value
  assert.match(
    validate.content,
    /if let Some\(value\) = &self\.po_box \{\n {12}if !RE_PO_BOX\.is_match\(value\) \{/,
  );
  // the pattern is embedded VERBATIM as a raw string literal (no JSON escaping)
  assert.match(validate.content, /Regex::new\(r"\^\[0-9\]\{5\}\$"\)/);
  // named capture groups survive untouched
  assert.match(validate.content, /Regex::new\(r"\^v\(\?<minor>\[0-9\]\+\)\$"\)/);
  // custom violation messages travel into the error
  assert.match(validate.content, /ValidationError::new\("po_box", "PO boxes start with #"\)/);
  // default message matches Go's convention
  assert.match(validate.content, /ValidationError::new\("postal_code", "must match pattern \^\[0-9\]\{5\}\$"\)/);
  // the regex dependency appears exactly when patterns are declared
  assert.match(cargo.content, /^regex = "1"$/m);
  // module docs document the mechanism
  assert.match(validate.content, /@pattern checks are precompiled once into std::sync::LazyLock<Regex> statics/);
});

test('rust @pattern: patterns are embedded as raw string literals', () => {
  // `^"#x$` contains `"#`, which would close r"...": the emitted literal must
  // be hashed to r##"...". `\\Q` is a literal backslash before Q (an escape
  // pair), NOT \Q quoting — it must neither be flagged nor unescaped.
  const ir = makePatternIR('edge.v1', [
    {
      name: 'Edge',
      fields: [
        { name: 'weird', primitive: 'string', constraints: [{ kind: 'pattern', args: ['^"#x$'] }] },
        { name: 'escaped', primitive: 'string', constraints: [{ kind: 'pattern', args: ['\\\\Q'] }] },
      ],
    },
  ]);
  const files = generate(ir, { language: 'rust' });
  const validate = byPath(files, 'src/validate.rs');
  assert.match(validate.content, /Regex::new\(r##"\^"#x\$"##\)/);
  assert.match(validate.content, /Regex::new\(r"\\\\Q"\)/);
});

test('rust @pattern: no regex dependency when no pattern is declared', () => {
  const files = generate(makeMinimalIR(), { language: 'rust' });
  const cargo = byPath(files, 'Cargo.toml');
  assert.ok(!cargo.content.includes('regex'), 'regex must not be a dependency unless @pattern is used');
  const validate = byPath(files, 'src/validate.rs');
  assert.ok(!validate.content.includes('LazyLock'), 'no pattern statics without @pattern');
});

// ---------------------------------------------------------------------------
// (b) uncompilable patterns: generation fails with a BR2020 diagnostic
// ---------------------------------------------------------------------------

test('rust @pattern: uncompilable patterns fail generation with BR2020', () => {
  const cases: Array<[pattern: string, constructFragment: string]> = [
    ['^a(?=b)', 'lookahead `(?=`'],
    ['^a(?!b)', 'negative lookahead `(?!`'],
    ['^a(?<=b)', 'lookbehind `(?<=`'],
    ['^a(?<!b)', 'negative lookbehind `(?<!`'],
    ['^a\\1', 'backreference `\\1`'],
    ['^a(?>b)', 'atomic group `(?>`'],
    ['^ab*+c', 'nested repetition operator `*+`'],
    ['^ab**c', 'nested repetition operator `**`'],
    ['^a\\Qb\\Ec', 'escape `\\Q`'],
    ['^a\\Z', 'escape `\\Z`'],
  ];
  for (const [pattern, fragment] of cases) {
    const ir = makePatternIR('pattern.v1', [
      { name: 'Shipment', fields: [{ name: 'code', primitive: 'string', constraints: [{ kind: 'pattern', args: [pattern] }] }] },
    ]);
    assert.throws(
      () => generate(ir, { language: 'rust' }),
      (error: unknown) => {
        assert.ok(error instanceof RustPatternRegexError, `expected RustPatternRegexError for ${pattern}`);
        const err = error as RustPatternRegexError;
        assert.equal(err.name, 'RustPatternRegexError');
        assert.equal(err.diagnostic.code, RUST_PATTERN_REGEX_CODE);
        assert.equal(err.diagnostic.code, 'BR2020');
        assert.equal(err.diagnostic.severity, 'error');
        assert.equal(err.diagnostic.file, 'pattern.v1');
        assert.equal(err.diagnostic.line, 1);
        assert.equal(err.diagnostic.column, 1);
        // Rendered through the bridge-core diagnostics system: file:line:column prefix.
        assert.match(err.message, /^pattern\.v1:1:1: error BR2020: /);
        assert.ok(err.message.includes(fragment), `BR2020 message must name the construct for ${pattern}`);
        assert.ok(err.message.includes('Shipment.code'), 'BR2020 message must name the offending field');
        assert.ok(err.message.includes(JSON.stringify(pattern)), 'BR2020 message must quote the pattern');
        return true;
      },
      `expected BR2020 generation failure for pattern ${pattern}`,
    );
  }
});

test('rust @pattern: the Rust-only gate leaves sibling generation untouched', () => {
  // \Q..\E is legal RE2 (Go) and a parse-time string for TS/Python codegen;
  // the BR2020 gate is scoped to the rust generator and must not change
  // what the other backends do with the same hand-built IR.
  const ir = makePatternIR('edge.v1', [
    { name: 'Edge', fields: [{ name: 'code', primitive: 'string', constraints: [{ kind: 'pattern', args: ['^\\Qx\\E$'] }] }] },
  ]);
  for (const language of ['go', 'typescript', 'python'] as const) {
    assert.ok(generate(ir, { language }).length > 0, `${language} generation is unaffected`);
  }
});

// ---------------------------------------------------------------------------
// (c) compile-path interplay: IDL input is gated by BR2018 first
// ---------------------------------------------------------------------------

test('rust @pattern: the compiler rejects lookahead IDL with BR2018 before generation', () => {
  const result = compileSource(
    ['package demo.v1', '', 'type Code {', '    value: string @pattern("(?=[a-z])[a-z]+")', '}', ''].join('\n'),
    'demo.bridge',
  );
  assert.equal(result.ok, false);
  const br2018 = result.diagnostics.find((d) => d.code === 'BR2018');
  assert.ok(br2018, 'expected a BR2018 diagnostic');
  assert.equal(br2018!.file, 'demo.bridge');
  assert.equal(br2018!.line, 4);
  assert.match(br2018!.message, /lookahead/);
});
