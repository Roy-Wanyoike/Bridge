import type { Metadata, Viewport } from 'next';
import './globals.css';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://bridge-website.vercel.app';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: 'Bridge — One contract. Every language. Zero interoperability drift.',
  description:
    'Define a data or service contract once; Bridge generates idiomatic, validated code for Go, Rust, TypeScript, Python, Java and C#, catches breaking changes before they merge, and governs contracts in a registry that knows who consumes what.',
  openGraph: {
    type: 'website',
    siteName: 'Bridge',
    title: 'Bridge — One contract. Every language. Zero interoperability drift.',
    description:
      'A polyglot contract compiler and compatibility platform: generate code for six languages from one contract, catch breaking changes in CI, and track consumers in a content-addressed registry.',
    url: SITE_URL,
    images: [
      {
        url: '/images/bridge-og-image.png',
        width: 1200,
        height: 630,
        alt: 'Bridge — one contract, every language',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Bridge — One contract. Every language.',
    description:
      'Polyglot contract infrastructure: compiler, registry, CI gate. 831+ tests green, MIT licensed.',
    images: ['/images/bridge-og-image.png'],
  },
  robots: { index: true, follow: true },
  alternates: { canonical: '/' },
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
