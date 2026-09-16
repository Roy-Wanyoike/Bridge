import { Badge } from '@/components/ui/badge';
import { LANGUAGE_LABELS } from '@/lib/format';
import { cn } from '@/lib/utils';

const SHORT: Record<string, string> = {
  typescript: 'TS',
  go: 'GO',
  rust: 'RS',
  python: 'PY',
};

/** Compact monospace language coverage badges, e.g. [TS] [GO] [RS] [PY]. */
export function LanguageBadges({
  languages,
  className,
}: {
  languages: string[];
  className?: string;
}) {
  if (languages.length === 0) {
    return <span className={cn('text-xs text-muted-foreground', className)}>none</span>;
  }
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1', className)}>
      {languages.map((lang) => (
        <Badge
          key={lang}
          variant="secondary"
          title={LANGUAGE_LABELS[lang] ?? lang}
          aria-label={LANGUAGE_LABELS[lang] ?? lang}
          className="px-1.5 font-mono text-[10px] tracking-wider text-muted-foreground"
        >
          {SHORT[lang] ?? lang.toUpperCase()}
        </Badge>
      ))}
    </span>
  );
}
