import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const calloutVariants = cva(
  "rounded-lg border px-3.5 py-2.5 text-sm",
  {
    variants: {
      variant: {
        info: "border-border bg-muted text-foreground",
        ok: "border-sky/40 bg-sky/12 text-foreground",
        error: "border-destructive/40 bg-destructive/8 text-destructive",
      },
    },
    defaultVariants: { variant: "info" },
  },
);

export interface CalloutProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof calloutVariants> {}

export function Callout({ className, variant, ...props }: CalloutProps) {
  return <div className={cn(calloutVariants({ variant }), className)} {...props} />;
}
