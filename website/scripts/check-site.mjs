#!/usr/bin/env node
/**
 * Verification gate for the static export in out/.
 *
 * Checks, over the EMITTED html:
 *   1. index.html exists (build actually produced output)
 *   2. every internal anchor referenced by href="#..." has a matching id
 *   3. every local asset referenced (href/src starting with /) exists in out/
 *   4. SEO essentials present: title, description, og:title, og:image, canonical
 *   5. every section promised by the nav is present
 *   6. no "undefined" leaked into hrefs/srcs (broken env wiring signature)
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'out');

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`  FAIL ${msg}`);
};
const ok = (msg) => console.log(`  ok   ${msg}`);

const indexPath = join(out, 'index.html');
if (!existsSync(indexPath)) {
  console.error('FAIL out/index.html not found — run `npm run build` first.');
  process.exit(1);
}
ok('out/index.html exists');

const html = readFileSync(indexPath, 'utf8');

// -- 2. internal anchors -----------------------------------------------------
const hrefAnchors = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const missingAnchors = [...new Set(hrefAnchors)].filter((a) => !ids.has(a));
if (missingAnchors.length === 0) ok(`all ${new Set(hrefAnchors).size} internal anchors resolve`);
else missingAnchors.forEach((a) => fail(`anchor #${a} has no matching id`));

// -- 3. local assets exist ---------------------------------------------------
const localRefs = [
  ...html.matchAll(/(?:href|src|poster)="(\/[^"#][^"]*)"/g),
].map((m) => m[1].split('?')[0].split('#')[0]);
const uniqueRefs = [...new Set(localRefs)];
const missingAssets = uniqueRefs.filter((ref) => !existsSync(join(out, ref)));
if (uniqueRefs.length < 10) {
  fail(`expected >=10 local asset references in html, matched ${uniqueRefs.length} — regex or markup regression?`);
} else if (missingAssets.length === 0) ok(`all ${uniqueRefs.length} local assets exist in out/`);
else missingAssets.forEach((a) => fail(`asset ${a} missing from out/`));

// -- 4. SEO essentials -------------------------------------------------------
const needs = [
  ['<title>', 'title tag'],
  ['name="description"', 'meta description'],
  ['property="og:title"', 'og:title'],
  ['property="og:image"', 'og:image'],
  ['rel="canonical"', 'canonical link'],
];
for (const [needle, label] of needs) {
  if (html.includes(needle)) ok(`${label} present`);
  else fail(`${label} missing`);
}

// -- 5. sections promised by the nav ----------------------------------------
for (const section of ['demo', 'problem', 'moat', 'languages', 'videos', 'docs']) {
  if (ids.has(section)) ok(`section #${section} present`);
  else fail(`section #${section} missing`);
}

// -- 6. env-wiring sanity ----------------------------------------------------
if (/href="\/undefined|src="\/undefined/.test(html)) {
  fail('undefined leaked into an href/src — check env var wiring');
} else {
  ok('no undefined hrefs/srcs');
}

const consoleCta = (html.match(/Open Console/g) ?? []).length;
if (consoleCta >= 2) ok(`console CTA present (${consoleCta}x)`);
else fail(`console CTA expected >=2 times, found ${consoleCta}`);

const files = (dir) =>
  existsSync(dir) ? readdirSync(dir).length : 0;
const videos = files(join(out, 'videos'));
if (videos >= 3) ok(`${videos} videos emitted`);
else fail(`expected >=3 videos in out/videos, found ${videos}`);

if (failures > 0) {
  console.error(`\ncheck-site: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-site: OK — export verified');
