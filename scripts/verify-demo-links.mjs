// Demo deep-link integrity check (issue #51 acceptance: "All demo deep links resolve").
// Compiles the demo dataset with the dashboard's tsconfig, then runs every
// audit row through the same link builder the audit page uses
// (`/contracts/${org}/${project}/${contract}`) and asserts the target exists.
// Run: node scripts/verify-demo-links.mjs
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The dashboard lives next to scripts/ in the repo checkout — resolve it
// relative to this script so the check works on any machine (a hardcoded
// absolute path only ever worked on one workstation).
const DASH = join(import.meta.dirname, '..', 'dashboard');
if (!existsSync(DASH)) {
  console.error(`verify-demo-links: dashboard directory not found at ${DASH}`);
  console.error('Expected ../dashboard relative to scripts/ — run this from a full repo checkout.');
  process.exit(1);
}
const out = mkdtempSync(join(tmpdir(), 'demolinks-'));
try {
  execSync(
    `npx tsc src/lib/demo-data.ts --outDir ${out} --module nodenext --target es2022 --moduleResolution nodenext --skipLibCheck --strict`,
    { cwd: DASH, stdio: 'pipe' },
  );
  const demo = await import(join(out, 'demo-data.mjs')).catch(() => import(join(out, 'demo-data.js')));

  const contracts = new Set(
    demo.demoListContracts().map((c) => `${c.org}/${c.project}/${c.base}`),
  );
  const rows = demo.demoListAudit();
  const fmt = (e) =>
    `${e.id}  ${e.action.padEnd(12)} /contracts/${e.org}/${e.project}/${e.contract}${e.version ? `@${e.version}` : ''}`;

  let broken = 0;
  console.log(`audit rows: ${rows.length}, demo contracts: ${contracts.size}\n`);
  for (const e of rows) {
    const key = `${e.org}/${e.project}/${e.contract}`;
    const ok = contracts.has(key);
    if (!ok) broken += 1;
    console.log(`${ok ? 'RESOLVES' : '404     '}  ${fmt(e)}`);
  }
  console.log(broken === 0 ? '\nALL AUDIT DEEP LINKS RESOLVE' : `\n${broken} BROKEN DEEP LINK(S)`);
  if (broken !== 0) process.exit(1);
} finally {
  rmSync(out, { recursive: true, force: true });
}
