import type { NextConfig } from 'next';

/**
 * Static export — the site is pure HTML/CSS/JS, no server code. Vercel serves
 * the `out/` directory; HTTP headers live in vercel.json (next.config headers()
 * is not supported with `output: 'export'`).
 */
const nextConfig: NextConfig = {
  output: 'export',
  images: { unoptimized: true },
  poweredByHeader: false,
};

export default nextConfig;
