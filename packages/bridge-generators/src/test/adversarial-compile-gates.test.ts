/**
 * Issue #118: adversarial compile gates.
 *
 * CONTRIBUTING.md:55 says generated code must compile — but the adversarial
 * fixture (makeAdversarialIR, the edge.v1 package in src/test/fixtures.ts)
 * was only ever regex-asserted, never executed or compiled, and the real
 * compilers only ran over examples/ via scripts that exit 77/SKIP without
 * toolchains. This file gates the ADVERSARIAL output per toolchain:
 *
 * | tool       | gate when present                                                   | when absent |
 * |------------|---------------------------------------------------------------------|-------------|
 * | python3    | ast.parse every emitted module + import + functional round-trip of edge.v1 (extends the #115 round-trip, which covered the clobber fixture, and the payments round-trip in generators.test.ts — to the adversarial fixture) | loud skip |
 * | typescript | full ts.createProgram type-check via ts-program-check.ts (node + the bundled typescript run this gate everywhere) | never skipped |
 * | go         | `go build ./...` over the generated edge_v1 module (stdlib only)    | loud skip |
 * | rust       | `cargo build` over the generated edge_v1 crate (crates.io needed for serde/serde_json) | loud skip |
 * | javac      | `javac --release 17` over every generated .java (pure JDK, no maven needed) | loud skip |
 * | dotnet     | `dotnet build` over the generated edge.v1 project (net8.0, in-box packages only) | loud skip |
 *
 * SKIP BEHAVIOR: a missing toolchain prints
 *   [#118] skip: <tool> not available — install for full gate (<hint>)
 * to stderr and the test SKIPS (passes), so the suite never pretends the
 * compile gate ran. Set STRICT_SKIP=1 to make every skip FAIL instead —
 * use this in CI images that promise the toolchain.
 */

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { generate } from '../index';
import { makeAdversarialIR } from './fixtures';
import { typeCheckGenerated, formatDiagnostics } from './ts-program-check';

const adversarial = makeAdversarialIR();

const STRICT_SKIP = process.env['STRICT_SKIP'] === '1';

function toolWorks(command: string, args: readonly string[]): boolean {
  const probe = spawnSync(command, [...args], { encoding: 'utf8' });
  return probe.error === undefined && probe.status === 0;
}

/** Loud skip-or-fail, per the STRICT_SKIP contract in this file's header. */
function skipGate(t: TestContext, tool: string, hint: string): void {
  console.error(`[#118] skip: ${tool} not available — install for full gate (${hint})`);
  if (STRICT_SKIP) {
    // Throwing (rather than t.fail, absent from these node types) fails the test.
    throw new Error(`STRICT_SKIP=1: ${tool} not available — install for full gate (${hint})`);
  }
  t.skip(`${tool} not available`);
}

/** Writes a GeneratedFile[] to a temp project dir preserving the layout. */
function writeProject(files: readonly { path: string; content: string }[], dir: string): void {
  for (const file of files) {
    const target = join(dir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
}

function runCompiler(command: string, args: readonly string[], cwd: string): void {
  try {
    execFileSync(command, [...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const failure = err as { stderr?: string | Buffer; stdout?: string | Buffer; message?: string };
    const stderr = failure.stderr ? failure.stderr.toString() : '';
    const stdout = failure.stdout ? failure.stdout.toString() : '';
    assert.fail(
      `${command} failed on the adversarial output:\n${stderr}${stdout}\n${failure.message ?? ''}`,
    );
  }
}

// ---------------------------------------------------------------------------
// python3 (present in this environment): execute the generated edge.v1.
// ---------------------------------------------------------------------------

test('adversarial compile gate: python3 executes the generated edge.v1 package', (t) => {
  if (!toolWorks('python3', ['-c', 'print("ok")'])) {
    skipGate(t, 'python3', 'execute generated python (ast.parse + import + round-trip)');
    return;
  }
  const files = generate(adversarial, { language: 'python' });
  const dir = mkdtempSync(join(tmpdir(), 'bridge-py-edge-'));
  try {
    writeProject(files, dir);
    const script = `
import ast, pathlib, sys
sys.path.insert(0, ${JSON.stringify(dir)})

# 1) Every emitted module must parse.
root = pathlib.Path(${JSON.stringify(dir)}, "edge_v1")
for module in sorted(root.glob("*.py")):
    ast.parse(module.read_text(encoding="utf-8"), filename=str(module))

# 2) The package must import (models, validation, services, __init__).
import edge_v1 as m

# 3) Functional round-trips over the adversarial shapes.

# Primitive collections + keyword-named constrained field (type).
t = m.Tags(nums=[3, 1, 2], flags={True, False}, bigs=[5], quantities={9, 7}, type="abc")
assert m.Tags.from_dict(t.to_dict()) == t
assert t.to_dict()["type"] == "abc"  # wire key keeps the declared name
assert t.validate() == []
assert m.validate_Tags(t) == []

# Holder: fields colliding with generated methods are escaped; wire kept.
h = m.Holder(
    value="v", obj=t, errors=[],
    pick=m.Pick.order("123e4567-e89b-12d3-a456-426614174000"),
    channel=m.Channel.self_("s"),
    class_="c", to_dict_="td", validate_="va",
)
wire = h.to_dict()
assert wire["class"] == "c" and wire["to_dict"] == "td" and wire["validate"] == "va"
h2 = m.Holder.from_dict(wire)
assert h2 == h
assert h2.pick.value == "123e4567-e89b-12d3-a456-426614174000"  # alias payload
assert h2.channel.kind == "SELF"
assert m.validate_Holder(h) == []

# Unions: escaped classmethods (self_/kind_/value_), alias payload, round-trip.
c = m.Channel.value_(7)
assert m.Channel.from_dict(c.to_dict()) == c
p = m.Pick.none("fallback")
assert m.Pick.from_dict(p.to_dict()) == p

# Enum with a keyword-named variant (pass -> pass_).
assert m.Filter.ALL.value == "ALL"
assert m.Filter.pass_.value == "pass"
assert m.parse_Filter("pass") is m.Filter.pass_

print("PY-EDGE-OK")
`;
    const out = execFileSync('python3', ['-c', script], { encoding: 'utf8' }).trim();
    assert.equal(out, 'PY-EDGE-OK');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// TypeScript (node + bundled typescript: always runnable).
// ---------------------------------------------------------------------------

test('adversarial compile gate: TypeScript output type-checks as a full Program', () => {
  const diagnostics = typeCheckGenerated(generate(adversarial, { language: 'typescript' }));
  assert.equal(
    diagnostics.length,
    0,
    `adversarial TypeScript must type-check with zero diagnostics;\n${formatDiagnostics(diagnostics)}`,
  );
});

// ---------------------------------------------------------------------------
// go (NOT installed in this environment): skip-gates loudly.
// ---------------------------------------------------------------------------

test('adversarial compile gate: go build (toolchain-gated)', (t) => {
  if (!toolWorks('go', ['version'])) {
    skipGate(t, 'go', 'go build ./... over the generated edge_v1 module');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'bridge-go-edge-'));
  try {
    writeProject(generate(adversarial, { language: 'go' }), dir);
    runCompiler('go', ['build', './...'], dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// rust/cargo (NOT installed here). cargo needs crates.io for serde.
// ---------------------------------------------------------------------------

test('adversarial compile gate: cargo build (toolchain-gated)', (t) => {
  if (!toolWorks('cargo', ['--version'])) {
    skipGate(t, 'cargo/rustc', 'cargo build over the generated edge_v1 crate (crates.io for serde)');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'bridge-rs-edge-'));
  try {
    writeProject(generate(adversarial, { language: 'rust' }), dir);
    runCompiler('cargo', ['build'], dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// javac (NOT installed here). Pure JDK compile, no maven required.
// ---------------------------------------------------------------------------

test('adversarial compile gate: javac compiles every generated .java (toolchain-gated)', (t) => {
  if (!toolWorks('javac', ['-version'])) {
    skipGate(t, 'javac', 'javac --release 17 over the generated edge_v1 sources');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'bridge-java-edge-'));
  try {
    const files = generate(adversarial, { language: 'java' });
    writeProject(files, dir);
    const javaFiles: string[] = [];
    const walk = (d: string): void => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.isFile() && entry.name.endsWith('.java')) javaFiles.push(p);
      }
    };
    walk(dir);
    assert.ok(javaFiles.length > 0, 'no generated .java files found');
    runCompiler('javac', ['--release', '17', '-d', join(dir, 'javac-out'), ...javaFiles], dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// dotnet (NOT installed here). net8.0, in-box packages only.
// ---------------------------------------------------------------------------

test('adversarial compile gate: dotnet build (toolchain-gated)', (t) => {
  if (!toolWorks('dotnet', ['--version'])) {
    skipGate(t, 'dotnet', 'dotnet build over the generated edge.v1 project');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'bridge-cs-edge-'));
  try {
    const files = generate(adversarial, { language: 'csharp' });
    writeProject(files, dir);
    const csproj = files.find((f) => f.path.endsWith('.csproj'));
    assert.ok(csproj !== undefined, 'generated csharp project file missing');
    runCompiler('dotnet', ['build', csproj.path, '--nologo', '-v', 'q'], dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
