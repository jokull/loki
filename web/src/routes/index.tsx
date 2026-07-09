import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: Home,
});

const FEATURES = [
  ["Real content schema", "Models, fields, a typed GraphQL + schema API — DatoCMS-compatible, minus the CRUD UI."],
  ["Per-site database", "Design relational tables at runtime; query them with Drizzle from server code."],
  ["Islands + server functions", "SSR Preact, hydrated islands, typed serverFns — no bundler, no deploy step."],
  ["Passwordless auth", "Built-in magic-link login for your visitors; `user` in every loader and serverFn."],
  ["Secrets + outbound", "Encrypted per-site secrets and mediated fetch() — call Stripe, Resend, anything."],
  ["Editor tokens", "Hand a content editor a scoped MCP token — content and images only, no code."],
];

function Home() {
  return (
    <div className="wrap stack" style={{ gap: "2.5rem" }}>
      <header className="between">
        <span className="brand"><span className="dot" />loftur</span>
        <div className="row small">
          <Link to="/login" className="btn ghost">Sign in</Link>
          <Link to="/login" className="btn primary">Get started</Link>
        </div>
      </header>

      <section className="stack" style={{ gap: "1rem", paddingTop: "1.5rem" }}>
        <p className="eyebrow">Agent-native site platform on Cloudflare</p>
        <h1 style={{ fontSize: "clamp(2rem, 6vw, 3.4rem)", margin: 0, maxWidth: "18ch" }}>
          Vibe-code a real site. Schema, content, auth and all.
        </h1>
        <p className="muted" style={{ fontSize: "1.1rem", maxWidth: "52ch" }}>
          Most AI builders one-shot a good-looking page. Loftur one-shots the whole
          backend over MCP — a real content schema, a per-site database, routes,
          islands, auth, and secrets — then lets you hand editors a scoped token.
        </p>
        <div className="row">
          <Link to="/login" className="btn primary">Start building</Link>
          <a className="btn" href="https://github.com/jokull/loftur" target="_blank" rel="noreferrer">GitHub</a>
        </div>
      </section>

      <section className="grid">
        {FEATURES.map(([title, body]) => (
          <div key={title} className="card">
            <h3 style={{ fontSize: "1rem", margin: "0 0 .3rem" }}>{title}</h3>
            <p className="muted small" style={{ margin: 0 }}>{body}</p>
          </div>
        ))}
      </section>

      <footer className="between small muted">
        <span>© Loftur</span>
        <Link to="/login">Sign in →</Link>
      </footer>
    </div>
  );
}
