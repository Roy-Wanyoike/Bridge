/**
 * Issue #116 regression coverage: post-normalization identifier collision
 * detection + reserved-name handling.
 *
 * Five verified collision classes used to produce non-compiling output from
 * legal contracts:
 *
 * 1. case-variant collapse (user_id/userID -> UserID in Go, RATE_LIMIT/
 *    rate_limit -> one const/key/factory)      -> FAIL with a diagnostic
 * 2. user types named like generated runtime symbols (Set, BridgeJson,
 *    BridgeRpcError, BridgeEventMeta, ...)     -> FAIL with a diagnostic
 * 3. Java getter for field `class` (getClass() override) -> member/getter
 *    auto-escape to class_/getClass_; a field rendering `getClass` FAILs
 * 4. C# property/method collision (to_dict/validate)     -> auto-escape to
 *    ToDict_/Validate_ with the wire name preserved
 * 5. method/variant name escaping (Go `func`, Python `pass`, Java keyword
 *    enum constants)                            -> auto-escape, wire kept
 *
 * The failing classes throw GenerationCollisionError naming the contract,
 * the scope, both source names (or the reserved symbol) and the rendered
 * identifier. Every failing class also has a control test proving legal
 * names (or the same names in languages where they do not collide) still
 * generate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generate } from '../index';
import { GenerationCollisionError } from '../collisions';
import { makeAdversarialIR } from './fixtures';
import type { IRField, IRPackage, IRTypeDefinition } from '@bridge/core';
import type { TargetLanguage } from '../mappings';
import type { GeneratedFile } from '../gen/input';

const str = { kind: 'primitive', primitive: 'string' } as const;

function field(name: string, extra: Partial<IRField> = {}): IRField {
  return { name, type: str, optional: false, constraints: [], ...extra };
}

function structType(name: string, fields: IRField[]): IRTypeDefinition {
  return { name, kind: 'struct', fields };
}

function packageOf(types: IRTypeDefinition[], extra: Partial<IRPackage> = {}): IRPackage {
  return {
    name: 'collide.v1',
    imports: [],
    types,
    services: [],
    events: [],
    ...extra,
  };
}

function expectCollision(
  ir: IRPackage,
  language: TargetLanguage,
  ...needles: string[]
): GenerationCollisionError {
  let caught: unknown;
  let threw = false;
  try {
    generate(ir, { language });
  } catch (error) {
    threw = true;
    caught = error;
  }
  assert.ok(threw, `${language}: expected generation to fail, but it produced output`);
  assert.ok(
    caught instanceof GenerationCollisionError,
    `${language}: expected GenerationCollisionError, got ${String(caught)}`,
  );
  const collision = caught as GenerationCollisionError;
  for (const needle of needles) {
    assert.ok(
      collision.message.includes(needle),
      `${language}: diagnostic missing ${JSON.stringify(needle)}:\n${collision.message}`,
    );
  }
  return collision;
}

function expectClean(ir: IRPackage, languages: readonly TargetLanguage[]): void {
  for (const language of languages) {
    const files = generate(ir, { language });
    assert.ok(files.length > 0, `${language}: expected output`);
  }
}

const ALL_LANGUAGES: readonly TargetLanguage[] = [
  'go',
  'rust',
  'typescript',
  'python',
  'java',
  'csharp',
];

/* ------------------------------------------------------------------ */
/* Class 1: case-variant collapse                                      */
/* ------------------------------------------------------------------ */

function makeCaseVariantFieldsIR(): IRPackage {
  return packageOf([structType('Profile', [field('user_id'), field('userID')])]);
}

function makeCaseVariantEnumIR(): IRPackage {
  return packageOf([
    {
      name: 'Rate',
      kind: 'enum',
      variants: [{ name: 'RATE_LIMIT' }, { name: 'rate_limit' }],
    },
  ]);
}

function makeCaseVariantUnionIR(): IRPackage {
  return packageOf([
    {
      name: 'Choice',
      kind: 'union',
      variants: [
        { name: 'RATE_LIMIT', type: str, optional: false, constraints: [] },
        { name: 'rate_limit', type: str, optional: false, constraints: [] },
      ],
    },
  ]);
}

test('collisions: go case-variant fields (user_id + userID) fail with an actionable diagnostic', () => {
  const error = expectCollision(
    makeCaseVariantFieldsIR(),
    'go',
    'collide.v1',
    "struct 'Profile'",
    "'user_id'",
    "'userID'",
    "'UserID'",
  );
  assert.match(error.message, /Rename one of them in the contract/);
});

test('collisions: go enum variants (RATE_LIMIT + rate_limit) collapse to one const and fail', () => {
  expectCollision(
    makeCaseVariantEnumIR(),
    'go',
    'collide.v1',
    "enum 'Rate'",
    "'RATE_LIMIT'",
    "'rate_limit'",
    "'RateRateLimit'",
  );
});

test('collisions: typescript as-const enum keys collapse and fail', () => {
  expectCollision(
    makeCaseVariantEnumIR(),
    'typescript',
    "enum 'Rate'",
    "'RATE_LIMIT'",
    "'rate_limit'",
    "'RateLimit'",
  );
});

test('collisions: csharp enum constants collapse and fail', () => {
  expectCollision(makeCaseVariantEnumIR(), 'csharp', "enum 'Rate'", "'RateLimit'");
});

test('collisions: rust enum variants collapse and fail', () => {
  expectCollision(makeCaseVariantEnumIR(), 'rust', "enum 'Rate'", "'RateLimit'");
});

test('collisions: java union factories collapse and fail', () => {
  expectCollision(
    makeCaseVariantUnionIR(),
    'java',
    "union 'Choice'",
    "'RATE_LIMIT'",
    "'rate_limit'",
    "'rate_limit'",
  );
});

test('collisions: python union classmethods collapse and fail', () => {
  expectCollision(makeCaseVariantUnionIR(), 'python', "union 'Choice'", "'rate_limit'");
});

test('collisions: csharp and rust union factories collapse and fail', () => {
  expectCollision(makeCaseVariantUnionIR(), 'csharp', "union 'Choice'", "'RateLimit'");
  expectCollision(makeCaseVariantUnionIR(), 'rust', "union 'Choice'", "'RateLimit'");
});

test('collisions: case-variant diagnostics are order-independent (determinism)', () => {
  const a = expectCollision(makeCaseVariantFieldsIR(), 'go', "'UserID'");
  const b = expectCollision(
    packageOf([structType('Profile', [field('userID'), field('user_id')])]),
    'go',
    "'UserID'",
  );
  assert.equal(a.message, b.message, 'diagnostic must not depend on IR array order');
});

test('controls: case-different names that do NOT collapse still generate', () => {
  // user_id/userID collapse in Go (both render UserID) and in Java (the
  // getters both derive getUserid — see the getter test below); they stay
  // distinct identifiers in every other backend. Java unions of distinct
  // snake names and single-variant enums are legal everywhere.
  expectClean(makeCaseVariantFieldsIR(), ['rust', 'typescript', 'python', 'csharp']);
  expectClean(makeCaseVariantEnumIR(), ['java', 'python']);
  expectClean(makeCaseVariantUnionIR(), ['go', 'typescript']);
});

test('collisions: java case-variant fields (user_id + userID) collapse at the getter and fail', () => {
  // Distinct members (userId vs userID) but javaGetterName folds both
  // getters to getUserid() — two identical methods in one class. The
  // detector mirrors java.ts's javaGetterName derivation exactly.
  expectCollision(
    makeCaseVariantFieldsIR(),
    'java',
    'collide.v1',
    "struct 'Profile'",
    "'user_id'",
    "'userID'",
    "'getUserid'",
    '(getter name)',
  );
});

/* ------------------------------------------------------------------ */
/* Class 2: reserved runtime symbols                                   */
/* ------------------------------------------------------------------ */

function makeSetTypeIR(withSetUsage: boolean): IRPackage {
  const types: IRTypeDefinition[] = [structType('Set', [field('ids')])];
  if (withSetUsage) {
    types.push({
      name: 'Bag',
      kind: 'struct',
      fields: [
        {
          name: 'tags',
          type: { kind: 'set', element: str },
          optional: false,
          constraints: [],
        },
      ],
    });
  }
  return packageOf(types);
}

function makeServiceIR(typeName: string): IRPackage {
  return packageOf([structType(typeName, [field('value')])], {
    services: [
      {
        name: 'Things',
        methods: [
          {
            name: 'GetThing',
            input: { kind: 'named', name: typeName },
            output: { kind: 'named', name: typeName },
          },
        ],
      },
    ],
  });
}

function makeEventIR(typeName: string, withEvent: boolean): IRPackage {
  const ir = packageOf([structType(typeName, [field('value')])]);
  if (withEvent) {
    ir.events.push({ name: 'ThingHappened', fields: [field('value')] });
  }
  return ir;
}

test('collisions: go type named Set in a set-using package fails', () => {
  expectCollision(
    makeSetTypeIR(true),
    'go',
    'collide.v1',
    "user type 'Set'",
    "reserved generated runtime symbol 'Set'",
    'types.go',
  );
});

test('control: go type named Set WITHOUT set usage still generates', () => {
  expectClean(makeSetTypeIR(false), ['go']);
});

test('collisions: BridgeRPCError user type fails in ts/python/rust when services are generated', () => {
  expectCollision(
    makeServiceIR('BridgeRpcError'),
    'typescript',
    "user type 'BridgeRpcError'",
    'src/services.ts',
  );
  expectCollision(makeServiceIR('BridgeRpcError'), 'python', "user type 'BridgeRpcError'");
  expectCollision(makeServiceIR('BridgeRpcError'), 'rust', "user type 'BridgeRpcError'");
});

test('control: BridgeRpcError without services still generates in ts/python/rust', () => {
  expectClean(
    packageOf([structType('BridgeRpcError', [field('value')])]),
    ['typescript', 'python', 'rust'],
  );
});

test('collisions: BridgeJson user type fails in java and csharp', () => {
  expectCollision(
    packageOf([structType('BridgeJson', [field('value')])]),
    'java',
    "user type 'BridgeJson'",
    'BridgeJson.java',
  );
  expectCollision(packageOf([structType('BridgeJson', [field('value')])]), 'csharp', "user type 'BridgeJson'");
});

test('control: BridgeJson is legal in the languages without that runtime symbol', () => {
  expectClean(packageOf([structType('BridgeJson', [field('value')])]), ['go', 'rust', 'typescript', 'python']);
});

test('collisions: BridgeEventMeta user type fails wherever the envelope declares it at module scope', () => {
  const ir = makeEventIR('BridgeEventMeta', true);
  expectCollision(ir, 'go', "user type 'BridgeEventMeta'", 'events.go');
  expectCollision(ir, 'typescript', "user type 'BridgeEventMeta'", 'src/events.ts');
  expectCollision(ir, 'python', "user type 'BridgeEventMeta'");
  expectCollision(ir, 'rust', "user type 'BridgeEventMeta'");
});

test('control: BridgeEventMeta without events still generates', () => {
  expectClean(
    makeEventIR('BridgeEventMeta', false),
    ['go', 'rust', 'typescript', 'python', 'java', 'csharp'],
  );
});

test('control: legal payments-shaped package still generates in all languages', () => {
  const ir = packageOf([
    structType('Money', [field('amount'), field('currency')]),
    {
      name: 'Status',
      kind: 'enum',
      variants: [{ name: 'PENDING' }, { name: 'CAPTURED' }],
    },
  ]);
  expectClean(ir, ALL_LANGUAGES);
});

/* ------------------------------------------------------------------ */
/* Class 3: Java getClass                                              */
/* ------------------------------------------------------------------ */

function makeClassFieldIR(className: string, fieldName: string): IRPackage {
  return packageOf([
    structType(className, [field(fieldName, { constraints: [{ kind: 'length', args: ['3'] }] })]),
  ]);
}

test('java: field class escapes member + getter (getClass_), wire name preserved', () => {
  const files = generate(makeClassFieldIR('Frame', 'class'), { language: 'java' });
  const frame = files.find((f) => f.path.endsWith('/Frame.java'));
  assert.ok(frame !== undefined, 'Frame.java missing');
  assert.match(frame.content, /private final String class_;/);
  assert.match(frame.content, /public String getClass_\(\) \{/);
  assert.doesNotMatch(frame.content, /public String getClass\(\) \{/);
  assert.match(frame.content, /out\.put\("class", this\.class_\);/);
  // BridgeValidation derives the same escaped getter.
  const validation = files.find((f) => f.path.endsWith('/BridgeValidation.java'));
  assert.ok(validation !== undefined, 'BridgeValidation.java missing');
  assert.match(validation.content, /value\.getClass_\(\)\.length\(\)/);
});

test('java: field named Class (getter getClass) fails with an actionable diagnostic', () => {
  expectCollision(
    makeClassFieldIR('Frame', 'Class'),
    'java',
    'collide.v1',
    "struct 'Frame'",
    "field 'Class'",
    "'getClass'",
    'Object.getClass',
  );
});

test('control: java keyword getters from escaped members never collide for legal names', () => {
  // getAmount/getCurrency-style getters must keep generating untouched.
  const files = generate(makeClassFieldIR('Frame', 'amount'), { language: 'java' });
  const frame = files.find((f) => f.path.endsWith('/Frame.java'))!;
  assert.match(frame.content, /public String getAmount\(\) \{/);
});

/* ------------------------------------------------------------------ */
/* Class 4: C# property/method collisions (auto-escape)                */
/* ------------------------------------------------------------------ */

test('csharp: to_dict/validate/from_dict fields become ToDict_/Validate_/FromDict_ with wire kept', () => {
  const files = generate(
    packageOf([structType('Store', [field('to_dict'), field('validate'), field('from_dict')])]),
    { language: 'csharp' },
  );
  const models = files.find((f) => f.path === 'Models.cs');
  assert.ok(models !== undefined, 'Models.cs missing');
  assert.match(models.content, /public string ToDict_ \{ get; set; \}/);
  assert.match(models.content, /public string Validate_ \{ get; set; \}/);
  assert.match(models.content, /public string FromDict_ \{ get; set; \}/);
  // Exactly ONE generated ToDict()/Validate() method remains.
  assert.equal(models.content.match(/public Dictionary<string, object> ToDict\(\)/g)?.length, 1);
  assert.equal(models.content.match(/public List<string> Validate\(\)/g)?.length, 1);
  // Wire keys keep the declared names.
  assert.match(models.content, /outDict\["to_dict"\] = this\.ToDict_;/);
  assert.match(models.content, /outDict\["validate"\] = this\.Validate_;/);
  assert.match(models.content, /outDict\["from_dict"\] = this\.FromDict_;/);
  assert.match(models.content, /root\.TryGetProperty\("to_dict"/);
});

test('go: validate field escapes to Validate_ and the Validate method stays intact', () => {
  const files = generate(packageOf([structType('Job', [field('validate')])]), { language: 'go' });
  const types = files.find((f) => f.path === 'types.go')!;
  // The go generator emits struct tags with one leading blank between the
  // backtick and "json:" — historical emission, also pinned by the
  // CustomerEmail tag assertion in generators.test.ts. The ` ?` below is
  // the same optional-space pattern that test uses.
  assert.match(types.content, /Validate_ string ` ?json:"validate"`/);
  const validate = files.find((f) => f.path === 'validate.go')!;
  assert.match(validate.content, /func \(j Job\) Validate\(\) error \{/);
  assert.doesNotMatch(validate.content, /j\.Validate\(\)\.Validate/);
});

test('java: to_dict/validate fields escape to toDict_/validate_ with wire kept', () => {
  const files = generate(packageOf([structType('Store', [field('to_dict'), field('validate')])]), {
    language: 'java',
  });
  const store = files.find((f) => f.path.endsWith('/Store.java'))!;
  assert.match(store.content, /private final String toDict_;/);
  assert.match(store.content, /private final String validate_;/);
  assert.match(store.content, /public Map<String, Object> toDict\(\) \{/);
  assert.match(store.content, /out\.put\("to_dict", this\.toDict_\);/);
  assert.match(store.content, /out\.put\("validate", this\.validate_\);/);
});

test('python: to_dict/validate fields keep the #115 trailing-underscore escape (control)', () => {
  const files = generate(packageOf([structType('Store', [field('to_dict'), field('validate')])]), {
    language: 'python',
  });
  const models = files.find((f) => f.path.endsWith('/models.py'))!;
  assert.match(models.content, /^ {4}to_dict_: str$/m);
  assert.match(models.content, /^ {4}validate_: str$/m);
  assert.match(models.content, /out\["to_dict"\] = self\.to_dict_/);
});

/* ------------------------------------------------------------------ */
/* Class 5: method/variant name escaping                               */
/* ------------------------------------------------------------------ */

test('go: service method named func escapes the selector (func_), route stays raw', () => {
  const ir = packageOf([structType('Ping', [field('value')])], {
    services: [
      {
        name: 'Pings',
        methods: [
          {
            name: 'func',
            input: { kind: 'named', name: 'Ping' },
            output: { kind: 'named', name: 'Ping' },
          },
        ],
      },
    ],
  });
  const files = generate(ir, { language: 'go' });
  const services = files.find((f) => f.path === 'services.go')!;
  assert.match(services.content, /func_\(ctx context\.Context, req \*Ping\)/);
  assert.match(services.content, /case "func":/);
  assert.match(services.content, /server\.func_\(r\.Context\(\), &req\)/);
  assert.match(services.content, /\/collide\.v1\/Pings\//);
});

test('python: enum variant named pass escapes the member, wire value stays "pass"', () => {
  const files = generate(
    packageOf([{ name: 'Mode', kind: 'enum', variants: [{ name: 'ALL' }, { name: 'pass' }] }]),
    { language: 'python' },
  );
  const enums = files.find((f) => f.path.endsWith('/enums.py'))!;
  assert.match(enums.content, /^ {4}pass_ = "pass"$/m);
  assert.doesNotMatch(enums.content, /^ {4}pass = /m);
  assert.match(enums.content, /^ {4}ALL = "ALL"$/m);
});

test('java: enum constant named class escapes to class_, wire value preserved', () => {
  const files = generate(
    packageOf([{ name: 'Mode', kind: 'enum', variants: [{ name: 'ALL' }, { name: 'class' }] }]),
    { language: 'java' },
  );
  const mode = files.find((f) => f.path.endsWith('/Mode.java'))!;
  assert.match(mode.content, / {4}ALL,/);
  assert.match(mode.content, / {4}class_;/);
  assert.match(mode.content, /case class_: return "class";/);
  assert.match(mode.content, /if \(variant\.wire\(\)\.equals\(value\)\)/);
  // Unescaped enums keep the plain name()-based wire().
  const plain = generate(
    packageOf([{ name: 'Plain', kind: 'enum', variants: [{ name: 'A' }, { name: 'B' }] }]),
    { language: 'java' },
  );
  const plainFile = plain.find((f) => f.path.endsWith('/Plain.java'))!;
  assert.match(plainFile.content, /public String wire\(\) \{\n {8}return name\(\);\n {4}\}/);
});

test('service method case-collisions fail per language with actionable diagnostics', () => {
  const makeService = (methods: string[]): IRPackage =>
    packageOf([structType('Ping', [field('value')])], {
      services: [
        {
          name: 'Pings',
          methods: methods.map((name) => ({
            name,
            input: { kind: 'named', name: 'Ping' } as const,
            output: { kind: 'named', name: 'Ping' } as const,
          })),
        },
      ],
    });

  // TypeScript renders method identifiers with pascalToCamel (first
  // character lowercased, remainder verbatim), so the case-variant pair
  // that collapses is first-char case ('createPayment'); snake input stays
  // a distinct identifier. Every other backend folds both spellings.
  expectCollision(makeService(['CreatePayment', 'createPayment']), 'typescript', "service 'Pings'", "'CreatePayment'", "'createPayment'");
  expectCollision(makeService(['CreatePayment', 'create_payment']), 'python', "service 'Pings'", "'create_payment'");
  expectCollision(makeService(['CreatePayment', 'create_payment']), 'csharp', "service 'Pings'", "'CreatePayment'");
  expectCollision(makeService(['CreatePayment', 'createPayment']), 'java', "service 'Pings'", "'createPayment'");
  expectCollision(makeService(['CreatePayment', 'create_payment']), 'rust', "service 'Pings'", "'create_payment'");
  expectCollision(makeService(['func', 'func_']), 'go', "service 'Pings'", "'func_'");
});

test('control: distinct legal service methods generate in every language', () => {
  const ir = packageOf([structType('Ping', [field('value')])], {
    services: [
      {
        name: 'Pings',
        methods: [
          { name: 'Create', input: { kind: 'named', name: 'Ping' }, output: { kind: 'named', name: 'Ping' } },
          { name: 'Delete', input: { kind: 'named', name: 'Ping' }, output: { kind: 'named', name: 'Ping' } },
        ],
      },
    ],
  });
  expectClean(ir, ALL_LANGUAGES);
});

/* ------------------------------------------------------------------ */
/* Adversarial extension (fixtures.ts) still generates everywhere      */
/* ------------------------------------------------------------------ */

function byPath(files: GeneratedFile[], path: string): GeneratedFile {
  const file = files.find((f) => f.path === path);
  assert.ok(file !== undefined, `expected generated file ${path}`);
  return file;
}

test('adversarial #116 fixture: every language still generates without throwing', () => {
  expectClean(makeAdversarialIR(), ALL_LANGUAGES);
});
