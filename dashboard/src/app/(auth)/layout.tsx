
import { BrandMark } from '@/components/brand-mark';

/**
 * Auth pages render standalone: no sidebar, no registry reads, no org
 * surface — this layout is the one thing an unauthenticated visitor is
 * allowed to see (issue #163).
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-10">
      <div className="mb-8 flex flex-col items-center gap-3 text-center">
        <BrandMark className="h-10 w-10 text-primary" />
        <div>
          <div className="text-sm font-semibold tracking-[0.22em] text-foreground">BRIDGE</div>
          <div className="mt-1 text-xs text-muted-foreground">Registry Console</div>
        </div>
      </div>
      <main className="w-full max-w-sm">{children}</main>
      <footer className="mt-8 text-center text-[11px] text-muted-foreground">
        <span className="font-mono">one IDL, one canonical IR, many languages</span>
      </footer>
    </div>
  );
}
