import { createFileRoute, Link } from "@tanstack/react-router";

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
    <div className="wrap stack" style={{ gap: "2rem", maxWidth: "44rem" }}>
      <header className="between">
        <Link to="/" className="brand"><span className="dot" />loftur</Link>
        <nav className="row small">
          <Link to="/docs">Docs</Link>
          <Link to="/login" className="btn primary">Sign in</Link>
        </nav>
      </header>

      <div className="stack" style={{ gap: ".3rem" }}>
        <p className="eyebrow">Changelog</p>
        <h1 style={{ fontSize: "2rem", margin: 0 }}>What's new</h1>
      </div>

      <div className="stack" style={{ gap: "1.25rem" }}>
        {ENTRIES.map((e, i) => (
          <div key={i} className="card stack" style={{ gap: ".5rem" }}>
            <div className="row" style={{ gap: ".6rem" }}>
              <span className="pill">{e.date}</span>
              <h3 style={{ fontSize: "1.05rem", margin: 0 }}>{e.title}</h3>
            </div>
            <ul className="muted small" style={{ margin: 0, paddingLeft: "1.1rem", lineHeight: 1.8 }}>
              {e.items.map((it, j) => <li key={j}>{it}</li>)}
            </ul>
          </div>
        ))}
      </div>

      <footer className="between small muted">
        <Link to="/">← Home</Link>
        <a href="https://github.com/jokull/loftur" target="_blank" rel="noreferrer">GitHub</a>
      </footer>
    </div>
  );
}
