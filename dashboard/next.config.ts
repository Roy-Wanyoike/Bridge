import type { NextConfig } from 'next';

/**
 * Security headers applied to every console route (issue #122).
 *
 * Deliberately conservative: the console renders server components with
 * Next's inline bootstrap/hydration scripts, so a strict CSP (script-src
 * 'self') would break the app. The hardening here is the non-breaking set:
 * no framing, no MIME sniffing, no referrer leakage, no powerful browser
 * features. Network isolation / an auth gate in front of a live deployment
 * is a deployment concern — see README.md ("Deployment boundary").
 */
const SECURITY_HEADERS = [
  // Framing: the console is a top-level admin surface, never embeddable.
  { key: 'X-Frame-Options', value: 'DENY' },
  // Browsers must not MIME-sniff responses (registry JSON served as HTML etc.).
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // Cross-origin navigations carry no URL beyond the origin.
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // The console needs no camera, microphone or geolocation.
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Do not advertise the framework version via `X-Powered-By`.
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
