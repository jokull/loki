import { cn } from "../../lib/utils";

/** Monospace block for keys, MCP config, and shell snippets. Selectable in full. */
export function CodeBlock({
  className,
  selectAll,
  ...props
}: React.HTMLAttributes<HTMLPreElement> & { selectAll?: boolean }) {
  return (
    <pre
      className={cn(
        "overflow-x-auto rounded-lg border border-border bg-muted px-3.5 py-3 font-mono text-[0.8rem] leading-relaxed text-foreground",
        selectAll && "select-all",
        className,
      )}
      {...props}
    />
  );
}
