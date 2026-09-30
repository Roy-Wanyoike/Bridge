/**
 * Demo/live parity check for the dashboard data layer (issue #121).
 *
 * ZERO new dependencies: transpiles `src/lib/{types,format,demo-data}.ts`
 * with the already-installed `typescript` package into a temp directory and
 * runs the demo provider through the same shape assertions the live REST
 * client enforces on its responses. The original live-mode crash shipped
 * because the demo provider returned full `VersionMeta` while the live list
 * route served bare version strings — this check makes that drift visible.
 *
 * Run from dashboard/:  node scripts/demo-live-parity.mjs
 * (or: npm run parity)
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcLib = resolve(here, '..', 'src', 'lib');
const require = createRequire(import.meta.url);
const ts = require('typescript');

const CLASSIFICATIONS = ['SAFE', 'WARNING', 'BREAKING', 'UNKNOWN'];

const tmp = mkdtempSync(join(tmpdir(), 'bridge-parity-'));
try {
  for (const name of ['types', 'format', 'demo-data']) {
    const source = readFileSync(join(srcLib, `${name}.ts`), 'utf8');
    const out = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    });
    writeFileSync(join(tmp, `${name}.js`), out.outputText);
  }
  // CJS resolution makes demo-data.js's `require('./format')` resolve here.
  const demo = require(join(tmp, 'demo-data.js'));

  let checked = 0;
  const contracts = demo.demoListContracts();
  assert.ok(contracts.length > 0, 'demo dataset must contain contracts');

  for (const contract of contracts) {
    const { org, project, base } = contract;
    const refs = demo.demoListVersions(org, project, base);

    // 1. listVersions parity: every entry is EXACTLY {version: string} — the
    //    live list-route wire shape. Stub metadata or fabricated fields must
    //    never reappear here.
    assert.ok(refs.length >= 1, `${base}: at least one version listed`);
    for (const ref of refs) {
      assert.deepEqual(
        Object.keys(ref).sort(),
        ['version'],
        `${base}: listVersions entries must carry only 'version' (live wire shape)`,
      );
      assert.equal(typeof ref.version, 'string');
      assert.ok(ref.version.length > 0, `${base}: version id must be non-empty`);
      checked += 1;
    }

    // 2. Enrichment parity: every listed version resolves to a complete,
    //    validated detail through the same pull the contract page uses —
    //    in BOTH modes (the page code path is shared).
    for (const ref of refs) {
      const detail = demo.demoGetVersion(org, project, base, ref.version);
      assert.ok(detail, `${base}@${ref.version}: getVersion must resolve`);
      for (const key of [
        'packageName',
        'base',
        'version',
        'hash',
        'shortHash',
        'publishedAt',
        'publisher',
        'owner',
      ]) {
        assert.equal(
          typeof detail[key],
          'string',
          `${base}@${ref.version}.${key} must be a string`,
        );
      }
      assert.ok(detail.publishedAt.length > 0, `${base}@${ref.version}: publishedAt non-empty`);
      assert.ok(Array.isArray(detail.imports), `${base}@${ref.version}: imports array`);
      for (const imp of detail.imports) {
        assert.equal(typeof imp, 'string', `${base}@${ref.version}: import entries are strings`);
      }
      assert.ok(Array.isArray(detail.languages), `${base}@${ref.version}: languages array`);
      checked += 1;
    }

    // 3. getDiff parity: adjacent pairs satisfy the live client's response
    //    validation (verdict ∈ Classification, numeric summary, change rows,
    //    optional-but-valid impact).
    for (let i = 1; i < refs.length; i += 1) {
      const from = refs[i - 1].version;
      const to = refs[i].version;
      const report = demo.demoGetDiff(org, project, base, from, to);
      assert.ok(report, `${base} ${from}→${to}: demoGetDiff must resolve`);
      assert.ok(
        CLASSIFICATIONS.includes(report.verdict),
        `${base} ${from}→${to}: verdict must be a Classification`,
      );
      for (const k of ['safe', 'warning', 'breaking', 'unknown']) {
        assert.equal(typeof report.summary[k], 'number', `${base}: summary.${k} numeric`);
        assert.ok(Number.isFinite(report.summary[k]), `${base}: summary.${k} finite`);
      }
      assert.ok(Array.isArray(report.changes), `${base}: changes array`);
      for (const ch of report.changes) {
        assert.equal(typeof ch.path, 'string', `${base}: change.path string`);
        assert.equal(typeof ch.kind, 'string', `${base}: change.kind string`);
        assert.ok(CLASSIFICATIONS.includes(ch.classification), `${base}: change.classification`);
        assert.equal(typeof ch.message, 'string', `${base}: change.message string`);
        checked += 1;
      }
      if (report.impact !== undefined && report.impact !== null) {
        for (const k of ['dependents', 'affected', 'breakingAffected']) {
          assert.equal(
            typeof report.impact[k],
            'number',
            `${base}: impact.${k} numeric`,
          );
        }
        assert.ok(Array.isArray(report.impact.consumers), `${base}: impact.consumers array`);
        for (const c of report.impact.consumers) {
          assert.equal(typeof c.packageName, 'string', `${base}: impact consumer.packageName`);
          assert.equal(typeof c.depth, 'number', `${base}: impact consumer.depth`);
          assert.ok(CLASSIFICATIONS.includes(c.severity), `${base}: impact consumer.severity`);
          assert.equal(typeof c.reason, 'string', `${base}: impact consumer.reason`);
          assert.ok(Array.isArray(c.viaTypes), `${base}: impact consumer.viaTypes`);
          checked += 1;
        }
      }
      checked += 1;
    }
  }

  console.log(
    `demo/live parity: OK — ${checked} checks across ${contracts.length} demo contracts ` +
      `(listVersions wire shape, getVersion enrichment, getDiff validation)`,
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
