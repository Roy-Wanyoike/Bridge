# Bridge Website

The public marketing site for Bridge: one contract, every language, zero
interoperability drift. Static export — no server code, no API routes.

Next.js (App Router, `output: 'export'`) + TypeScript + Tailwind CSS. Dark-only
theme sharing the console's design tokens (`dashboard/src/app/globals.css`), so
the two surfaces read as one product.

## Quickstart

```bash
cd website
npm install
npm run dev          # http://localhost:3000
```

Brand assets (logo, images, videos) are **not** committed here — `prebuild`
copies them from `../marketing/` into `public/`. The monorepo checkout is
required (Vercel clones the whole repo, so this works there too).

## Verification

```bash
npm run build        # static export into out/ (prebuild copies assets)
npm test             # check-site.mjs: anchors, assets, SEO, sections, CTAs
npm run lint && npm run typecheck
```

`npm test` validates the **emitted HTML**: every internal anchor resolves, all
local assets exist in `out/`, title/description/OG/canonical are present, all
nav sections render, and the console CTA appears on the page.

## Deploying to Vercel

The site deploys as its **own Vercel project** (separate from the dashboard):

1. Import the repo, set **Root Directory = `website`** (Project → Settings →
   General). Framework auto-detects as Next.js.
2. No environment variables are required. Optional overrides:
   - `NEXT_PUBLIC_DASHBOARD_URL` — where every "Open Console" CTA points
     (default: `https://bridge-dashboard.vercel.app`)
   - `NEXT_PUBLIC_SITE_URL` — canonical/sitemap/OG base URL for the deployed
     origin

Known failure signatures, for diagnosis:

| Signature | Meaning | Fix |
|-----------|---------|-----|
| `No Output Directory named "public"` | Root Directory is the repo root | Set Root Directory = `website` |
| `[copy-assets] ../marketing not found` | Build ran outside the monorepo | Build from a full repo clone (Vercel does this) |

## Environment

| Variable | Default | Meaning |
|----------|---------|---------|
| `NEXT_PUBLIC_DASHBOARD_URL` | `https://bridge-dashboard.vercel.app` | Target of every "Open Console" CTA (nav, hero, resources, footer, mobile menu) |
| `NEXT_PUBLIC_SITE_URL` | `https://bridge-website.vercel.app` | Canonical base URL for metadata, sitemap and robots |

## Structure

```
website/
├── app/               # layout (metadata/OG), page, robots, sitemap, icon, 404
├── components/        # nav, hero, demo (terminal), problem, moat, languages,
│                      # videos, resources, footer
├── lib/               # dashboard-url (build-time console CTA target)
├── scripts/
│   ├── copy-assets.mjs  # prebuild: ../marketing -> public/ (+ favicon)
│   └── check-site.mjs   # verification gate over out/*.html
└── public/            # generated at build time (gitignored)
```

Content source of truth: the README and `docs/strategy/` in the repo — facts
(six languages, 831 + 94 tests, v0.2.1, MIT) are kept in sync by review, and
the terminal transcript mirrors the verified examples.
