/**
 * The BRIDGE glyph (bridge span over water) — shared by the console shell
 * and the standalone auth pages (issue #163), which deliberately render
 * without the full shell.
 */
import { cn } from '@/lib/utils';

export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={cn('h-7 w-7', className)}>
      <path
        d="M3 17 12 4l9 13"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M3 17h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.55" />
      <circle cx="12" cy="13" r="2.2" fill="currentColor" />
    </svg>
  );
}
