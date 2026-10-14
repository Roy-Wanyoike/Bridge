import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center">
      <p className="font-mono text-sm text-warning">404</p>
      <h1 className="text-2xl font-semibold text-foreground">This page does not exist</h1>
      <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
        The site is a single page — everything lives on the home route.
      </p>
      <Link
        href="/"
        className="mt-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
      >
        Back to the home page
      </Link>
    </main>
  );
}
