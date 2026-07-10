import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: Home,
});

const FEATURES = [
  ["Real content schema", "Models, fields, a typed GraphQL + schema API — DatoCMS-compatible, minus the CRUD UI."],
  ["Per-site database", "Design relational tables at runtime; query them with Drizzle from server code."],
  ["Islands + server functions", "SSR Preact, hydrated islands, typed serverFns — no bundler, no deploy step."],
  ["Passwordless auth", "Built-in magic-link login for your visitors; user in every loader and serverFn."],
  ["Secrets + outbound", "Encrypted per-site secrets and mediated fetch() — call Stripe, Resend, anything."],
  ["Editor tokens", "Hand a content editor a scoped MCP token — content and images only, no code."],
];

const STEPS = [
  ["Sign in and claim a name", "One email, no password. Claim {you}.loftur.app from your dashboard — you get a one-time owner key."],
  ["Point an agent at /mcp", "Connect Claude Code (or any MCP client) to your site's endpoint. It orients itself with site_help."],
  ["Ship a real site", "The agent designs a schema, a database, routes, islands, auth — checks it with preview, ships with publish."],
];

function Home() {
  return (
    <div className="wrap stack" style={{ gap: "3rem" }}>
      <header className="between">
        <span className="brand"><span className="dot" />loftur</span>
        <nav className="row small">
          <Link to="/docs">Docs</Link>
          <Link to="/changelog">Changelog</Link>
          <a href="https://github.com/jokull/loftur" target="_blank" rel="noreferrer">GitHub</a>
          <Link to="/login" className="btn ghost">Sign in</Link>
          <Link to="/login" className="btn primary">Get started</Link>
        </nav>
      </header>

      <section className="stack" style={{ gap: "1.1rem", paddingTop: "1rem" }}>
        <p className="eyebrow">Open-source agent-native runtime · Cloudflare Workers</p>
        <h1 style={{ fontSize: "clamp(2.1rem, 6vw, 3.6rem)", margin: 0, maxWidth: "18ch" }}>
          Point any agent at a subdomain. It ships a real site.
        </h1>
        <p className="muted" style={{ fontSize: "1.12rem", maxWidth: "56ch" }}>
          Loftur is the runtime, not another chat box. Bring Claude Code, Openclaw,
          your own — any MCP agent — and it builds a live site at {"{you}"}.loftur.app
          with auth, a per-site database, email, secrets, and mediated outbound already
          wired in. Not generated boilerplate — powers the runtime hands every site for free.
        </p>
        <div className="row">
          <Link to="/login" className="btn primary">Start building</Link>
          <Link to="/docs" className="btn">Read the docs</Link>
        </div>
        <pre className="key" style={{ marginTop: ".6rem", maxWidth: "44rem" }}>
{`claude mcp add loftur --transport http https://acme.loftur.app/mcp \\
  --header "Authorization: Bearer lft_your_owner_key"`}
        </pre>
      </section>

      <section className="stack" style={{ gap: "1rem" }}>
        <h2 style={{ fontSize: "1.35rem", margin: 0 }}>How it works</h2>
        <div className="grid">
          {STEPS.map(([title, body], i) => (
            <div key={title} className="card stack" style={{ gap: ".4rem" }}>
              <span className="pill">0{i + 1}</span>
              <h3 style={{ fontSize: "1rem", margin: 0 }}>{title}</h3>
              <p className="muted small" style={{ margin: 0 }}>{body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="stack" style={{ gap: "1rem" }}>
        <h2 style={{ fontSize: "1.35rem", margin: 0 }}>What the agent can build</h2>
        <div className="grid">
          {FEATURES.map(([title, body]) => (
            <div key={title} className="card">
              <h3 style={{ fontSize: "1rem", margin: "0 0 .3rem" }}>{title}</h3>
              <p className="muted small" style={{ margin: 0 }}>{body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="card between" style={{ alignItems: "center" }}>
        <div>
          <h2 style={{ fontSize: "1.2rem", margin: "0 0 .2rem" }}>Or run it yourself</h2>
          <p className="muted small" style={{ margin: 0, maxWidth: "48ch" }}>
            Loftur is open source. Deploy the whole runtime to your own Cloudflare
            account and serve tenants under your own domain — no lock-in.
          </p>
        </div>
        <a href="https://github.com/jokull/loftur" target="_blank" rel="noreferrer" className="btn">
          Self-host on GitHub
        </a>
      </section>

      <section className="card between" style={{ alignItems: "center" }}>
        <div>
          <h2 style={{ fontSize: "1.2rem", margin: "0 0 .2rem" }}>Ready to build?</h2>
          <p className="muted small" style={{ margin: 0 }}>Sign in with your email and claim a subdomain.</p>
        </div>
        <Link to="/login" className="btn primary">Get started</Link>
      </section>

      <footer className="between small muted">
        <span className="brand" style={{ fontSize: ".95rem" }}><span className="dot" />loftur</span>
        <span className="row">
          <Link to="/docs">Docs</Link>
          <Link to="/changelog">Changelog</Link>
          <a href="https://github.com/jokull/loftur" target="_blank" rel="noreferrer">GitHub</a>
        </span>
      </footer>
    </div>
  );
}
