import { Link } from "@tanstack/react-router";
import { cn } from "../lib/utils";
import { Brand } from "./brand";

/** Centered page column with consistent gutters + vertical rhythm. */
export function Shell({
  className,
  width = "default",
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { width?: "default" | "prose" | "narrow" }) {
  const max = width === "narrow" ? "max-w-md" : width === "prose" ? "max-w-3xl" : "max-w-5xl";
  return <div className={cn("mx-auto w-full px-5 py-10 sm:py-14", max, className)} {...props} />;
}

export function Eyebrow({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn(
        "font-mono text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function SiteHeader({ children }: { children?: React.ReactNode }) {
  return (
    <header className="flex items-center justify-between gap-4">
      <Link to="/" className="text-lg text-foreground no-underline">
        <Brand />
      </Link>
      {children && <nav className="flex items-center gap-1.5 sm:gap-2.5">{children}</nav>}
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="flex flex-wrap items-center justify-between gap-4 border-t border-border pt-6 text-sm text-muted-foreground">
      <Link to="/" className="text-muted-foreground no-underline hover:text-foreground">
        <Brand className="text-[0.95rem] font-medium" />
      </Link>
      <div className="flex items-center gap-4">
        <Link to="/docs" className="no-underline hover:text-foreground">
          Docs
        </Link>
        <Link to="/changelog" className="no-underline hover:text-foreground">
          Changelog
        </Link>
        <a
          href="https://github.com/jokull/loftur"
          target="_blank"
          rel="noreferrer"
          className="no-underline hover:text-foreground"
        >
          GitHub
        </a>
      </div>
    </footer>
  );
}
