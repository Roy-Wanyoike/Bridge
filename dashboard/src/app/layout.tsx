/**
 * Root layout: document shell only (issue #163).
 *
 * The console chrome (sidebar with org scope, demo/live chip) moved into
 * the `(console)` route group so the `/login` page renders without it.
 * That is a security requirement, not styling: the shell's sidebar is
 * populated by an admin-credential registry read (`listOrgs`), and the
 * login page is the one route unauthenticated visitors see — rendering the
 * shell there would leak the deployment's org/project surface to them.
 */
import type { Metadata, Viewport } from 'next';
import './globals.css';

const CONSOLE_URL = process.env.NEXT_PUBLIC_CONSOLE_URL ?? 'http://localhost:3000';
if (
  process.env.NODE_ENV === 'production' &&
  !process.env.NEXT_PUBLIC_CONSOLE_URL &&
  CONSOLE_URL === 'http://localhost:3000'
) {
  console.warn(
    '[dashboard] NEXT_PUBLIC_CONSOLE_URL is not set — canonical/OG URLs will point at http://localhost:3000 in this production deployment.',
  );
}

export const metadata: Metadata = {
  metadataBase: new URL(CONSOLE_URL),
  title: {
    default: 'BRIDGE Registry Console',
    template: '%s | BRIDGE Registry Console',
  },
  description:
    'Multilingual contract compilation and compatibility: browse contracts, versions, dependency graph and compatibility reports.',
  openGraph: {
    type: 'website',
    siteName: 'BRIDGE Registry Console',
    title: { default: 'BRIDGE Registry Console', template: '%s | BRIDGE Registry Console' },
    description:
      'Browse contracts, versions, dependency graph and compatibility reports for the BRIDGE registry.',
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: '#0a0a0c',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
