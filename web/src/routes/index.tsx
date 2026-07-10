import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { CodeBlock } from "../components/ui/code-block";
import { Eyebrow, Shell, SiteFooter, SiteHeader } from "../components/layout";
import { GithubMark } from "../components/brand";

export const Route = createFileRoute("/")({
  component: Home,
});

const FEATURES: [string, string][] = [
  ["Real content schema", "Models, fields, a typed GraphQL + schema API — DatoCMS-compatible, minus the CRUD UI."],
  ["Per-site database", "Design relational tables at runtime; query them with Drizzle from server code."],
  ["Islands + server functions", "SSR Preact, hydrated islands, typed serverFns — no bundler, no deploy step."],
  ["Passwordless auth", "Built-in magic-link login for your visitors; user in every loader and serverFn."],
  ["Secrets + outbound", "Encrypted per-site secrets and mediated fetch() — call Stripe, Resend, anything."],
  ["Editor tokens", "Hand a content editor a scoped MCP token — content and images only, no code."],
];

const STEPS: [string, string][] = [
  ["Sign in and claim a name", "One email, no password. Claim {you}.loftur.app from your dashboard — you get a one-time owner key."],
  ["Point an agent at /mcp", "Connect Claude Code (or any MCP client) to your site's endpoint. It orients itself with site_help."],
  ["Ship a real site", "The agent designs a schema, a database, routes, islands, auth — checks it with preview, ships with publish."],
];

const MCP_CMD = `claude mcp add loftur --transport http https://acme.loftur.app/mcp \\
  --header "Authorization: Bearer lft_your_owner_key"`;

function Home() {
  return (
    <Shell className="flex flex-col gap-20 sm:gap-28">
      <SiteHeader>
        <Link to="/docs" className="hidden px-2 text-sm text-muted-foreground no-underline hover:text-foreground sm:inline">Docs</Link>
        <Link to="/changelog" className="hidden px-2 text-sm text-muted-foreground no-underline hover:text-foreground sm:inline">Changelog</Link>
        <a href="https://github.com/jokull/loftur" target="_blank" rel="noreferrer" className="hidden px-2 text-sm text-muted-foreground no-underline hover:text-foreground sm:inline">GitHub</a>
        <Button variant="ghost" size="sm" render={<Link to="/login" />}>Sign in</Button>
        <Button variant="sky" size="sm" render={<Link to="/login" />}>Get started</Button>
      </SiteHeader>

      {/* Hero — the one bold moment: a soft Sky glow behind the thesis. */}
      <section className="relative">
        <div
          aria-hidden
          className="pointer-events-none absolute -top-24 left-1/2 -z-10 h-[26rem] w-[46rem] max-w-full -translate-x-1/2 rounded-full opacity-60 blur-3xl"
          style={{ background: "radial-gradient(closest-side, color-mix(in oklch, var(--sky) 55%, transparent), transparent)" }}
        />
        <div className="flex flex-col items-start gap-6">
          <Eyebrow>Open-source agent-native runtime · Cloudflare Workers</Eyebrow>
          <h1 className="max-w-[16ch] text-4xl font-semibold leading-[1.04] sm:text-6xl">
            Point any agent at a subdomain. It ships a real site.
          </h1>
          <p className="max-w-[54ch] text-lg text-muted-foreground">
            Loftur is the runtime, not another chat box. Bring Claude Code, Openclaw, your own —
            any MCP agent — and it builds a live site at{" "}
            <span className="font-mono text-sm text-foreground">{"{you}"}.loftur.app</span> with auth,
            a per-site database, email, secrets, and mediated outbound already wired in. Not generated
            boilerplate — the runtime hands every site those powers for free.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="sky" size="lg" render={<Link to="/login" />}>
              Start building <ArrowRight />
            </Button>
            <Button variant="outline" size="lg" render={<Link to="/docs" />}>Read the docs</Button>
          </div>

          <div className="mt-4 w-full max-w-2xl overflow-hidden rounded-xl border border-border bg-card shadow-sm">
            <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
              <span className="size-2.5 rounded-full bg-border" />
              <span className="size-2.5 rounded-full bg-border" />
              <span className="size-2.5 rounded-full bg-border" />
              <span className="ml-2 font-mono text-xs text-muted-foreground">connect your agent</span>
            </div>
            <CodeBlock className="rounded-none border-0 bg-transparent">{MCP_CMD}</CodeBlock>
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-6">
        <h2 className="text-2xl font-semibold">How it works</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          {STEPS.map(([title, body], i) => (
            <Card key={title} className="flex flex-col gap-2 p-5">
              <span className="font-mono text-sm text-link">0{i + 1}</span>
              <h3 className="text-base font-medium">{title}</h3>
              <p className="text-sm text-muted-foreground">{body}</p>
            </Card>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-6">
        <h2 className="text-2xl font-semibold">What the agent can build</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(([title, body]) => (
            <Card key={title} className="flex flex-col gap-1.5 p-5">
              <h3 className="text-base font-medium">{title}</h3>
              <p className="text-sm text-muted-foreground">{body}</p>
            </Card>
          ))}
        </div>
      </section>

      <section className="grid gap-8 sm:grid-cols-2">
        <Card className="flex flex-col items-start justify-between gap-4 border-sky/35 bg-sky/[0.06] p-6">
          <div className="flex flex-col gap-1.5">
            <h2 className="text-xl font-semibold">Or run it yourself</h2>
            <p className="max-w-[44ch] text-sm text-muted-foreground">
              Loftur is open source. Deploy the whole runtime to your own Cloudflare account and
              serve tenants under your own domain — no lock-in.
            </p>
          </div>
          <Button variant="outline" render={<a href="https://github.com/jokull/loftur" target="_blank" rel="noreferrer" />}>
            <GithubMark /> Self-host on GitHub
          </Button>
        </Card>

        <Card className="flex flex-col items-start justify-between gap-4 p-6">
          <div className="flex flex-col gap-1.5">
            <h2 className="text-xl font-semibold">Ready to build?</h2>
            <p className="max-w-[44ch] text-sm text-muted-foreground">
              Sign in with your email and claim a subdomain. First site is a few prompts away.
            </p>
          </div>
          <Button variant="sky" render={<Link to="/login" />}>
            Get started <ArrowRight />
          </Button>
        </Card>
      </section>

      <SiteFooter />
    </Shell>
  );
}
