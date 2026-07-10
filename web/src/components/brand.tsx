import { cn } from "../lib/utils";

/** GitHub mark (lucide dropped brand glyphs in v1). Inherits currentColor + size-4. */
export function GithubMark(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.29-.01-1.04-.02-2.05-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.49.99.11-.78.42-1.31.76-1.61-2.67-.3-5.47-1.34-5.47-5.95 0-1.31.47-2.39 1.24-3.23-.12-.3-.54-1.53.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6.01 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.77.84 1.24 1.92 1.24 3.23 0 4.62-2.81 5.64-5.49 5.94.43.37.81 1.1.81 2.22 0 1.6-.01 2.9-.01 3.29 0 .32.22.7.83.58C20.56 22.29 24 17.8 24 12.5 24 5.87 18.63.5 12 .5Z" />
    </svg>
  );
}

/**
 * Loftur wordmark. The mark is a small "lofted" tile — a rounded square tilted a
 * few degrees with a baby-blue Sky glow, the runtime's one accent moment.
 */
export function Brand({ className, markOnly = false }: { className?: string; markOnly?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-semibold tracking-tight", className)}>
      <span
        aria-hidden
        className="grid size-[1.15em] -rotate-6 place-items-center rounded-[0.28em] bg-sky shadow-[0_0_0_1px_color-mix(in_oklch,var(--sky)_60%,#000_10%),0_4px_16px_-2px_color-mix(in_oklch,var(--sky)_65%,transparent)]"
      >
        <span className="size-[0.32em] rounded-full bg-sky-foreground/85" />
      </span>
      {!markOnly && <span>loftur</span>}
    </span>
  );
}
