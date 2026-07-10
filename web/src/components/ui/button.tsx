import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-[color,background-color,border-color,box-shadow] outline-none cursor-pointer disabled:pointer-events-none disabled:opacity-50 focus-visible:ring-[3px] focus-visible:ring-ring/45 focus-visible:border-ring [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // Ink — the minimal-black default.
        default: "bg-primary text-primary-foreground border border-transparent hover:bg-primary/90",
        // Sky — the one baby-blue accent; ink text for contrast on the soft fill.
        sky: "bg-sky text-sky-foreground border border-transparent shadow-[0_1px_0_0_color-mix(in_oklch,var(--sky)_70%,#000_18%)] hover:brightness-[1.04]",
        secondary:
          "bg-secondary text-secondary-foreground border border-transparent hover:bg-secondary/70",
        outline:
          "border border-border bg-card text-foreground hover:bg-accent hover:text-accent-foreground",
        ghost:
          "border border-transparent text-foreground hover:bg-accent hover:text-accent-foreground",
        destructive:
          "border border-transparent bg-transparent text-destructive hover:bg-destructive/10",
        link: "border border-transparent text-link underline-offset-4 hover:underline",
      },
      size: {
        sm: "h-8 rounded-md px-3 text-[0.8rem]",
        default: "h-9 px-4 py-2",
        lg: "h-10 rounded-lg px-5 text-[0.95rem]",
        icon: "size-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /** Compose with another element (e.g. a router <Link />) instead of <button>. */
  render?: useRender.RenderProp;
}

export function Button({ className, variant, size, render, type, ...props }: ButtonProps) {
  // `type` is a native-button concern; don't leak it onto a composed <a>/<Link>.
  return useRender({
    render: render ?? <button type={type ?? "button"} />,
    props: { className: cn(buttonVariants({ variant, size, className })), ...props },
  });
}

export { buttonVariants };
