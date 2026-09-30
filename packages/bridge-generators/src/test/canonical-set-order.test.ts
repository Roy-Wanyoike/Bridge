/**
 * Cross-language golden-vector test for the canonical set wire order
 * (issue #117).
 *
 * The rule (mirroring docs/SERIALIZATION.md rule 5 and the
 * `compareValues` canonical layer in @bridge/serialization, and pinned by
 * the `set_ints` / `set_strings` golden vectors):
 *
 *   - numeric primitives  → ascending numeric order
 *   - string primitives   → ascending Unicode code-point order
 *     (= UTF-8 byte order; deliberately NOT UTF-16 code-unit order)
 *   - booleans            → false < true
 *   - duplicates          → dropped (set semantics)
 *
 * TypeScript and Python are EXECUTED here (transpiled types.ts run in
 * `node:vm`; generated dataclasses run under python3), exactly like the
 * serialization golden vectors execute every runtime. Go, Java, C# and
 * Rust have no toolchain in this environment, so their generated
 * ordering code is pinned structurally to the same rule — each language's
 * generated comparator is asserted to implement exactly the ordering
 * above for every element family.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ts = require('typescript') as typeof import('typescript');
import { generate } from '../index';
import type { GeneratedFile } from '../gen/input';
import type { IRPackage } from '@bridge/core';

/** Golden fixture: one struct carrying a set of each primitive family. */
function makeSetOrderIR(): IRPackage {
  return {
    name: 'sets.v1',
    imports: [],
    types: [
      {
        name: 'SetOrders',
        kind: 'struct',
        fields: [
          {
            name: 'nums',
            type: { kind: 'set', element: { kind: 'primitive', primitive: 'int32' } },
            optional: false,
            constraints: [],
          },
          {
            name: 'flags',
            type: { kind: 'set', element: { kind: 'primitive', primitive: 'bool' } },
            optional: false,
            constraints: [],
          },
          {
            name: 'tags',
            type: { kind: 'set', element: { kind: 'primitive', primitive: 'string' } },
            optional: false,
            constraints: [],
          },
        ],
      },
    ],
    services: [],
    events: [],
  };
}

// The golden values. Deliberately chosen so that insertion order, UTF-16
// code-unit order and code-point order all disagree:
// - nums {10, 9, 100, 2}: lexicographic string order would give [10,100,2,9].
// - tags: 'B' (U+0042) < 'a' (U+0061) < 'é' (U+00E9) < '\uFFFD' (U+FFFD) <
//   '𝄞' (U+1D11E, non-BMP). UTF-16 order would place '𝄞' (surrogate
//   U+D834) BEFORE '\uFFFD' — that divergence is the regression this test
//   pins.
const GOLDEN = {
  nums: [2, 9, 10, 100],
  flags: [false, true],
  tags: ['B', 'a', 'é', '\uFFFD', '𝄞'],
} as const;

function byPath(files: GeneratedFile[], path: string): GeneratedFile {
  const file = files.find((f) => f.path === path);
  assert.ok(file !== undefined, `expected generated file ${path}`);
  return file;
}

/** Runs the generated types.ts setToArray in a bare CommonJS sandbox. */
function executeTypescript(ir: IRPackage): Record<string, unknown[]> {
  const source = byPath(generate(ir, { language: 'typescript' }), 'src/types.ts').content;
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const mod = { exports: {} as Record<string, unknown> };
  new Function('exports', 'module', js)(mod.exports, mod);
  const setToArray = mod.exports.setToArray as (value: Set<unknown>) => unknown[];
  assert.equal(typeof setToArray, 'function', 'types.ts must export setToArray');
  return {
    nums: setToArray(new Set([10, 9, 100, 2])) as number[],
    flags: setToArray(new Set([true, false])) as boolean[],
    tags: setToArray(new Set([...GOLDEN.tags].reverse())) as string[],
  };
}

/** Runs the generated Python dataclasses' to_dict under python3. */
function executePython(ir: IRPackage): Record<string, unknown[]> {
  const files = generate(ir, { language: 'python' });
  const dir = mkdtempSync(join(tmpdir(), 'bridge-setorder-'));
  try {
    for (const file of files) {
      const target = join(dir, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content);
    }
    const script = `
import sys, json
sys.path.insert(0, ${JSON.stringify(dir)})
import sets_v1 as m
s = m.SetOrders(nums={10, 9, 100, 2}, flags={True, False}, tags=set(${JSON.stringify([...GOLDEN.tags].reverse())}))
d = s.to_dict()
print(json.dumps([d["nums"], d["flags"], d["tags"]]))
print("PY-OK")
`;
    const out = execFileSync('python3', ['-c', script]).toString().trim();
    assert.ok(out.endsWith('PY-OK'), `python execution failed: ${out}`);
    const parsed = JSON.parse(out.split('\n')[0] as string) as unknown[][];
    const [nums, flags, tags] = parsed;
    return {
      nums: nums as unknown[],
      flags: flags as unknown[],
      tags: tags as unknown[],
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('canonical set order (#117): executed serializers agree on element order', () => {
  const ir = makeSetOrderIR();
  const tsOrder = executeTypescript(ir);
  assert.deepEqual(tsOrder.nums, [...GOLDEN.nums], 'typescript set<int32> order');
  assert.deepEqual(tsOrder.flags, [...GOLDEN.flags], 'typescript set<bool> order');
  assert.deepEqual(tsOrder.tags, [...GOLDEN.tags], 'typescript set<string> order');

  const pyOrder = executePython(ir);
  assert.deepEqual(pyOrder.nums, [...GOLDEN.nums], 'python set<int32> order');
  assert.deepEqual(pyOrder.flags, [...GOLDEN.flags], 'python set<bool> order');
  assert.deepEqual(pyOrder.tags, [...GOLDEN.tags], 'python set<string> order');
});

test('canonical set order (#117): go/java/csharp/rust implement the same rule', () => {
  const ir = makeSetOrderIR();

  // Go: one reflect-based comparator implementing every family; the old
  // fmt.Sprint (stringified) ordering must be gone.
  const go = byPath(generate(ir, { language: 'go' }), 'types.go').content;
  assert.match(go, /func bridgeSetLess\(a, b any\) bool \{/);
  assert.match(go, /case reflect\.String:\n\t\treturn av\.String\(\) < bv\.String\(\)/, 'go: strings bytewise');
  assert.match(go, /case reflect\.Bool:\n\t\treturn !av\.Bool\(\) && bv\.Bool\(\)/, 'go: false < true');
  assert.match(go, /case reflect\.Int, reflect\.Int8, reflect\.Int16, reflect\.Int32, reflect\.Int64:\n\t\treturn av\.Int\(\) < bv\.Int\(\)/, 'go: signed numeric');
  assert.match(go, /case reflect\.Uint, reflect\.Uint8, reflect\.Uint16, reflect\.Uint32, reflect\.Uint64:\n\t\treturn av\.Uint\(\) < bv\.Uint\(\)/, 'go: unsigned numeric');
  assert.match(go, /case reflect\.Float32, reflect\.Float64:\n\t\treturn av\.Float\(\) < bv\.Float\(\)/, 'go: float numeric');
  assert.doesNotMatch(go, /fmt\.Sprint\(items\[i\]\)/, 'go: stringified ordering removed');
  assert.match(go, /"reflect"/, 'go: reflect import');

  // Java: string(-like) sets via the UTF-8 comparator in BridgeJson,
  // numeric/bool sets via natural Collections.sort.
  const javaFiles = generate(ir, { language: 'java' });
  const setOrders = byPath(javaFiles, 'src/main/java/bridge/sets/v1/SetOrders.java').content;
  assert.match(setOrders, /s\d+\.sort\(BridgeJson::compareUtf8\);/, 'java: string sets by code point');
  assert.match(setOrders, /Collections\.sort\(s\d+\);/, 'java: numeric/bool sets natural');
  const bridgeJson = byPath(javaFiles, 'src/main/java/bridge/sets/v1/BridgeJson.java').content;
  assert.match(bridgeJson, /byte\[\] ba = a\.getBytes\(StandardCharsets\.UTF_8\);/, 'java: UTF-8 byte comparison');

  // C#: numeric/bool sets naturally, string sets via the BridgeJson
  // code-point comparer.
  const models = byPath(generate(ir, { language: 'csharp' }), 'Models.cs').content;
  assert.match(models, /OrderBy\(x => x\)/, 'csharp: numeric/bool sets natural');
  assert.match(models, /OrderBy\(x => x, BridgeJson\.Utf8Comparer\)/, 'csharp: string sets by code point');
  assert.match(models, /Comparer<string>\.Create\(CompareUtf8\)/, 'csharp: comparer defined');
  assert.match(models, /System\.Text\.Encoding\.UTF8\.GetBytes\(a\)/, 'csharp: UTF-8 byte comparison');

  // Rust: BTreeSet IS the canonical order for primitives (numeric for
  // numbers, byte order = code-point order for strings, false < true).
  const rust = byPath(generate(ir, { language: 'rust' }), 'src/types.rs').content;
  assert.match(rust, /BTreeSet<i32>/, 'rust: set<int32>');
  assert.match(rust, /BTreeSet<bool>/, 'rust: set<bool>');
  assert.match(rust, /BTreeSet<String>/, 'rust: set<string>');
});
