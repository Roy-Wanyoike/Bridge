/**
 * Issue #115 regression coverage: Python generated code used to clobber
 * itself for legal field names.
 *
 * - a struct field named `data` emitted `data = data.get("data")` inside
 *   from_dict, rebinding the decoder parameter, so the NEXT `data.get(...)`
 *   raised AttributeError;
 * - fields named `to_dict` / `validate` / `from_dict` shadowed the generated
 *   METHODS (`m.validate()` raised TypeError: 'str' object is not callable).
 *
 * The fix (1) renames the decoder parameter/temp to `raw_data`/`raw_value`
 * in every from_dict emission site (structs, unions, event payloads) and
 * (2) escapes the reserved member names via naming.ts
 * PYTHON_RESERVED_MEMBERS, using the same trailing-underscore mechanism as
 * keywords. The wire name always keeps the declared form.
 *
 * The functional test EXECUTES the generated package with python3
 * (full round-trip, validate(), wire keys). If python3 is unavailable at
 * runtime the test skips with a loud printed reason.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generate } from '../index';
import { PYTHON_RESERVED_MEMBERS, pythonFieldName } from '../naming';
import type { GeneratedFile } from '../gen/input';
import type { IRPackage } from '@bridge/core';

/**
 * Dedicated fixture (kept OUT of the shared fixtures.ts to avoid collisions
 * with other agents' fixture work): one struct declaring every name that
 * used to clobber the Python decoder or shadow generated methods, including
 * the decoder locals themselves (`raw_data`/`raw_value`) and composite
 * fields that exercise the nested list/map decoding paths.
 */
function makeClobberIR(): IRPackage {
  const str = { kind: 'primitive', primitive: 'string' } as const;
  return {
    name: 'clobber.v1',
    imports: [],
    types: [
      {
        name: 'Payload',
        kind: 'struct',
        docs: 'Declares every name that used to clobber the Python decoder.',
        fields: [
          {
            name: 'data',
            type: str,
            optional: false,
            constraints: [],
            docs: 'Used to rebind the from_dict parameter.',
          },
          { name: 'other', type: { kind: 'primitive', primitive: 'int32' }, optional: false, constraints: [] },
          { name: 'to_dict', type: str, optional: false, constraints: [] },
          { name: 'validate', type: str, optional: false, constraints: [] },
          { name: 'from_dict', type: str, optional: false, constraints: [] },
          { name: 'self', type: str, optional: true, constraints: [] },
          { name: 'raw', type: str, optional: true, constraints: [] },
          {
            name: 'out',
            type: { kind: 'list', element: str },
            optional: true,
            constraints: [],
            docs: 'list decoding path.',
          },
          {
            name: 'raw_data',
            type: {
              kind: 'map',
              key: str,
              value: { kind: 'primitive', primitive: 'int32' },
            },
            optional: true,
            constraints: [],
            docs: 'map decoding path; also the from_dict parameter name.',
          },
          { name: 'raw_value', type: str, optional: true, constraints: [] },
        ],
      },
    ],
    services: [],
    events: [],
  };
}

const ir = makeClobberIR();

function byPath(files: GeneratedFile[], path: string): GeneratedFile {
  const file = files.find((f) => f.path === path);
  assert.ok(file !== undefined, `expected generated file ${path}`);
  return file;
}

test('naming: python escape table covers method, decoder-local and runtime names', () => {
  for (const reserved of PYTHON_RESERVED_MEMBERS) {
    const escaped = pythonFieldName(reserved);
    assert.equal(escaped.name, `${reserved}_`, `${reserved} must escape with a trailing underscore`);
    assert.equal(escaped.wire, reserved, `${reserved} wire name must stay the declared form`);
  }
  // True keywords still escape; ordinary names are untouched.
  assert.equal(pythonFieldName('class').name, 'class_');
  assert.equal(pythonFieldName('class').wire, 'class');
  assert.equal(pythonFieldName('other').name, 'other');
  assert.equal(pythonFieldName('other').wire, 'other');
});

test('python clobber: members escape, decoder locals renamed, wire keys original', () => {
  const files = generate(ir, { language: 'python' });
  const models = byPath(files, 'clobber_v1/models.py');

  // Dataclass members are escaped with the trailing underscore.
  assert.match(models.content, /^ {4}data_: str$/m);
  assert.match(models.content, /^ {4}to_dict_: str$/m);
  assert.match(models.content, /^ {4}validate_: str$/m);
  assert.match(models.content, /^ {4}from_dict_: str$/m);
  assert.match(models.content, /^ {4}self_: str \| None = None$/m);
  assert.match(models.content, /^ {4}raw_data_: dict\[str, int\] \| None = None$/m);

  // No UNescaped declaration of any reserved member name remains.
  assert.doesNotMatch(
    models.content,
    /^ {4}(data|raw|out|self|to_dict|validate|from_dict|raw_data|raw_value):/m,
  );

  // The decoder parameter/temp are renamed at every emission site.
  assert.match(models.content, /def from_dict\(cls, raw_data: "dict\[str, Any\]"\) -> "Payload":/);
  assert.match(models.content, /data_ = raw_data\.get\("data"\)/);
  assert.match(models.content, /raw_value = raw_data\.get\("self"\)/);
  assert.match(models.content, /out_ = None if raw_value is None else \[item for item in raw_value\]/);
  assert.match(models.content, /raw_data_ = None if raw_value is None else \{str\(k\): v for k, v in raw_value\.items\(\)\}/);
  // The old clobbering emission is gone.
  assert.doesNotMatch(models.content, /\bdata = data\.get\(/);
  assert.doesNotMatch(models.content, /\bdef from_dict\(cls, data:/);

  // Wire keys keep the ORIGINAL declared field names.
  assert.match(models.content, /out\["data"\] = self\.data_/);
  assert.match(models.content, /out\["to_dict"\] = self\.to_dict_/);
  assert.match(models.content, /out\["validate"\] = self\.validate_/);
  assert.match(models.content, /out\["from_dict"\] = self\.from_dict_/);
  assert.match(models.content, /out\["self"\] = self\.self_/);
  assert.match(models.content, /out\["raw_data"\] = \{str\(k\): v for k, v in self\.raw_data_\.items\(\)\}/);

  // validation.py reads the escaped attribute, never shadowed members.
  const validation = byPath(files, 'clobber_v1/validation.py');
  assert.match(validation.content, /value\.data_/);
  assert.match(validation.content, /value\.validate_/);
  assert.doesNotMatch(validation.content, /value\.validate\b(?!_)/);

  // Union decoders use the same renamed locals (consistent emission).
  const union = generate(
    {
      ...ir,
      types: [
        {
          name: 'U',
          kind: 'union',
          variants: [
            {
              name: 'A',
              type: { kind: 'primitive', primitive: 'string' },
              optional: false,
              constraints: [],
            },
          ],
        },
      ],
    },
    { language: 'python' },
  );
  const unionModels = byPath(union, 'clobber_v1/models.py');
  assert.match(unionModels.content, /def from_dict\(cls, raw_data: "dict\[str, Any\]"\) -> "U":/);
  assert.match(unionModels.content, /kind = raw_data\.get\("kind"\)/);
  assert.match(unionModels.content, /raw_value = raw_data\.get\("value"\)/);
});

function python3Available(): boolean {
  const probe = spawnSync('python3', ['-c', 'print("ok")']);
  return probe.error === undefined && probe.status === 0;
}

test('python clobber: functional round-trip executes (python3)', (t) => {
  if (!python3Available()) {
    console.error(
      'SKIPPED (python-field-clobber): python3 is NOT available on PATH — cannot execute generated code; skipping the functional round-trip.',
    );
    t.skip('python3 not available');
    return;
  }

  const files = generate(ir, { language: 'python' });
  const dir = mkdtempSync(join(tmpdir(), 'bridge-pyclobber-'));
  try {
    mkdirSync(join(dir, 'clobber_v1'), { recursive: true });
    for (const file of files) {
      writeFileSync(join(dir, file.path), file.content);
    }

    const script = `
import sys
sys.path.insert(0, ${JSON.stringify(dir)})
import clobber_v1 as m

p = m.Payload(
    data_="payload-data", other=7,
    to_dict_="td", validate_="val", from_dict_="fd",
    self_="s", raw_="r", out_=["a", "b"], raw_data_={"k": 1}, raw_value_="rv",
)

wire = p.to_dict()
# Wire keys keep the ORIGINAL declared field names.
assert wire == {
    "data": "payload-data", "other": 7,
    "to_dict": "td", "validate": "val", "from_dict": "fd",
    "self": "s", "raw": "r", "out": ["a", "b"],
    "raw_data": {"k": 1}, "raw_value": "rv",
}, wire

# from_dict round-trips every field (dataclass equality).
q = m.Payload.from_dict(wire)
assert q == p, (q, p)
assert m.Payload.from_dict(q.to_dict()) == q

# validate() must be the generated METHOD, not the string field.
assert q.validate() == []
assert m.validate_Payload(q) == []
assert callable(type(q).validate)

# Optional fields: explicit JSON null and missing keys both decode to None
# (exercises the raw_value fallback path), and None optionals are skipped
# by to_dict.
r2 = m.Payload.from_dict({
    "data": "d2", "other": -3, "to_dict": "", "validate": "", "from_dict": "",
    "out": None,
})
assert r2.self_ is None and r2.raw_ is None and r2.raw_data_ is None
assert r2.raw_value_ is None and r2.out_ is None
assert "out" not in r2.to_dict() and "raw" not in r2.to_dict()

# A field named data must not clobber the decoder: decode twice in a row.
d1 = m.Payload.from_dict({"data": "one", "other": 1, "to_dict": "t", "validate": "v", "from_dict": "f"})
d2 = m.Payload.from_dict({"data": "two", "other": 2, "to_dict": "t", "validate": "v", "from_dict": "f"})
assert d1.data_ == "one" and d2.data_ == "two"
assert d1.to_dict()["data"] == "one" and d2.to_dict()["data"] == "two"

print("PY-CLOBBER-OK")
`;
    const out = execFileSync('python3', ['-c', script]).toString().trim();
    assert.equal(out, 'PY-CLOBBER-OK');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
