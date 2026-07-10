import { Collapsible as BaseCollapsible } from "@base-ui/react/collapsible";
import { cn } from "../../lib/utils";

export function Collapsible(props: React.ComponentProps<typeof BaseCollapsible.Root>) {
  return <BaseCollapsible.Root {...props} />;
}

export function CollapsibleTrigger({
  className,
  ...props
}: React.ComponentProps<typeof BaseCollapsible.Trigger>) {
  return (
    <BaseCollapsible.Trigger
      className={cn(
        "inline-flex cursor-pointer items-center gap-1.5 text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:text-foreground",
        "[&_svg]:size-3.5 [&_svg]:transition-transform data-[panel-open]:[&_svg]:rotate-90",
        className,
      )}
      {...props}
    />
  );
}

export function CollapsiblePanel({
  className,
  ...props
}: React.ComponentProps<typeof BaseCollapsible.Panel>) {
  return (
    <BaseCollapsible.Panel
      className={cn(
        "overflow-hidden transition-[height] duration-200 ease-out",
        "h-[var(--collapsible-panel-height)] data-[starting-style]:h-0 data-[ending-style]:h-0",
        className,
      )}
      {...props}
    />
  );
}
