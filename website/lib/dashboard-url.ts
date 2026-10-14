/**
 * Where "Open Console" points. Injected at build time so the deployed site
 * can be repointed at any dashboard origin without a code change:
 *   NEXT_PUBLIC_DASHBOARD_URL=https://your-dashboard.example npm run build
 */
export const DASHBOARD_URL =
  process.env.NEXT_PUBLIC_DASHBOARD_URL ?? 'https://bridge-dashboard.vercel.app';
