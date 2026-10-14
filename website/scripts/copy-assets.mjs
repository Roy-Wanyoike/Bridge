#!/usr/bin/env node
/**
 * Copies brand + video assets from ../marketing into public/ at build time.
 *
 * The assets live in ONE place (marketing/) — binaries are never duplicated
 * in git. This script runs as `prebuild`, so both local builds and Vercel
 * builds (which clone the whole monorepo and build inside website/) see it.
 */
import { cpSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const marketing = join(root, '..', 'marketing');
const publicDir = join(root, 'public');

if (!existsSync(marketing)) {
  console.error(
    `[copy-assets] ../marketing not found at ${marketing} — run from the monorepo checkout.`,
  );
  process.exit(1);
}

const COPIES = [
  { from: 'logo', to: 'logo' },
  { from: 'images', to: 'images' },
];

// Videos: only the three web-ready mp4s — narration sources stay out of the site.
const VIDEO_FILES = [
  'bridge-intro.mp4',
  'bridge-gate-demo.mp4',
  'bridge-social-square.mp4',
];

for (const { from, to } of COPIES) {
  const src = join(marketing, from);
  if (!existsSync(src)) {
    console.error(`[copy-assets] missing ${src}`);
    process.exit(1);
  }
  mkdirSync(join(publicDir, to), { recursive: true });
  cpSync(src, join(publicDir, to), { recursive: true });
  console.log(`[copy-assets] marketing/${from} -> public/${to}`);
}

mkdirSync(join(publicDir, 'videos'), { recursive: true });
for (const file of VIDEO_FILES) {
  const src = join(marketing, 'videos', file);
  if (!existsSync(src)) {
    console.error(`[copy-assets] missing ${src}`);
    process.exit(1);
  }
  cpSync(src, join(publicDir, 'videos', file));
  const kb = Math.round(statSync(src).size / 1024);
  console.log(`[copy-assets] videos/${file} (${kb} KB)`);
}

// Favicon: the brand icon served from the app/ route convention.
cpSync(join(marketing, 'logo', 'bridge-icon-dark.svg'), join(root, 'app', 'icon.svg'));
console.log('[copy-assets] app/icon.svg (favicon)');

const count = (dir) => readdirSync(join(publicDir, dir)).length;
console.log(
  `[copy-assets] done: ${count('logo')} logo, ${count('images')} images, ${VIDEO_FILES.length} videos`,
);
