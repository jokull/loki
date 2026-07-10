import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Card } from "../components/ui/card";
import { Eyebrow, Shell, SiteHeader } from "../components/layout";

export const Route = createFileRoute("/changelog")({
  component: Changelog,
});

const ENTRIES: Array<{ date: string; title: string; items: string[] }> = [
  {
    date: "2026-07",
    title: "Accounts & dashboard",
    items: [
      "Passwordless account sign-in — manage all your sites from one place.",
      "Owner-key rotation & recovery: lost your key? Sign in by email and rotate.",
      "Editor tokens and encrypted secrets, now manageable from the dashboard.",
    ],
  },
  {
    date: "2026-07",
    title: "Auth, secrets & outbound",
    items: [
      "Built-in passwordless login for your site's visitors — user in every loader/serverFn.",
      "Encrypted per-site secrets (env.SECRETS.get) for third-party API keys.",
      "Mediated outbound fetch() — call Stripe, Resend, and any HTTP API from server code.",
    ],
  },
  {
    date: "2026-07",
    title: "Per-tenant backends",
    items: [
      "Every site gets its own isolated content + feature database (Durable Object SQLite).",
      "Per-site feature migrations; blind agents shipped persistent apps first try.",
    ],
  },
  {
    date: "2026-07",
    title: "Foundations",
    items: [
      "npm imports with no install or bundler; support determined by test-loading.",
      "Typed serverFns and loki/schema types generated from the live schema.",
      "Byte-faithful versioning, an in-Worker shell, and a migration guard.",
    ],
  },
];

function Changelog() {
  return (
    <Shell width="prose" className="flex flex-col gap-10">
      <SiteHeader>
        <Link to="/docs" className="px-2 text-sm text-muted-foreground no-underline hover:text-foreground">Docs</Link>
        <Button variant="sky" size="sm" render={<Link to="/login" />}>Sign in</Button>
      </SiteHeader>

      <div className="flex flex-col gap-2">
        <Eyebrow>Changelog</Eyebrow>
        <h1 className="text-3xl font-semibold sm:text-4xl">What's new</h1>
      </div>

      <div className="flex flex-col gap-5">
        {ENTRIES.map((e, i) => (
          <Card key={i} className="flex flex-col gap-3 p-5">
            <div className="flex items-center gap-2.5">
              <Badge variant="mono">{e.date}</Badge>
              <h3 className="text-base font-medium">{e.title}</h3>
            </div>
            <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-muted-foreground marker:text-link">
              {e.items.map((it, j) => <li key={j}>{it}</li>)}
            </ul>
          </Card>
        ))}
      </div>

      <footer className="flex items-center justify-between border-t border-border pt-6 text-sm text-muted-foreground">
        <Link to="/" className="no-underline hover:text-foreground">← Home</Link>
        <a href="https://github.com/jokull/loftur" target="_blank" rel="noreferrer" className="no-underline hover:text-foreground">GitHub</a>
      </footer>
    </Shell>
  );
}
