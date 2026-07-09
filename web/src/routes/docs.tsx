import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/docs")({
  component: Docs,
});

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="stack" style={{ gap: ".5rem" }}>
      <h2 style={{ fontSize: "1.25rem", margin: 0 }}>{title}</h2>
      {children}
    </section>
  );
}

function Docs() {
  return (
    <div className="wrap stack" style={{ gap: "2rem", maxWidth: "48rem" }}>
      <header className="between">
        <Link to="/" className="brand"><span className="dot" />loftur</Link>
        <nav className="row small">
          <Link to="/changelog">Changelog</Link>
          <Link to="/login" className="btn primary">Sign in</Link>
        </nav>
      </header>

      <div className="stack" style={{ gap: ".4rem" }}>
        <p className="eyebrow">Docs</p>
        <h1 style={{ fontSize: "2rem", margin: 0 }}>Build a site over MCP</h1>
        <p className="muted">
          Loftur is an agent-native site platform. You don't click around a builder —
          you point an AI agent at your site's MCP endpoint and it builds a real
          backend: content schema, database, routes, islands, auth, and secrets.
        </p>
      </div>

      <Section title="1. Sign in & claim a subdomain">
        <p className="muted small" style={{ margin: 0 }}>
          <Link to="/login">Sign in</Link> with your email — no password. From your
          dashboard, claim <code>{"{name}"}.loftur.app</code>. You'll get a one-time
          <b> owner key</b> (starts with <code>lft_</code>) and a ready-to-paste MCP config.
          Lost the key later? Rotate it from the dashboard.
        </p>
      </Section>

      <Section title="2. Connect your agent">
        <p className="muted small" style={{ margin: 0 }}>
          Point Claude Code (or any MCP client) at your endpoint:
        </p>
        <pre className="key">
{`claude mcp add loftur --transport http https://acme.loftur.app/mcp \\
  --header "Authorization: Bearer lft_your_owner_key"`}
        </pre>
        <p className="muted small" style={{ margin: 0 }}>
          The endpoint also answers at <code>loftur.app/mcp</code> — it resolves your
          site from the key alone, so you can connect before DNS propagates. The agent's
          first move should be the <code>site_help</code> tool, which returns the full
          authoring guide.
        </p>
      </Section>

      <Section title="3. What the agent works with">
        <ul className="muted small" style={{ margin: 0, paddingLeft: "1.1rem", lineHeight: 1.9 }}>
          <li><b>Content</b> — models, fields, records, publishing, assets over a typed GraphQL + schema API (DatoCMS-style). Localized content via built-in locales.</li>
          <li><b>Feature database</b> — design relational tables at runtime with <code>feature_migrate</code>; query with Drizzle over <code>env.FEATURES_SQL</code>.</li>
          <li><b>Routes, islands & serverFns</b> — file-based routing, SSR Preact, hydrated islands, typed server functions. No bundler, no deploy step.</li>
          <li><b>Auth</b> — passwordless magic-link login for your visitors; <code>user</code> is injected into every loader and serverFn.</li>
          <li><b>Secrets & outbound</b> — <code>env.SECRETS.get()</code> for API keys, mediated <code>fetch()</code> to any host — call Stripe, Resend, anything.</li>
          <li><b>npm imports</b> — import any workerd-compatible package; resolved and snapshotted at write time.</li>
        </ul>
      </Section>

      <Section title="4. Preview, publish, roll back">
        <p className="muted small" style={{ margin: 0 }}>
          <code>preview_site</code> serves the draft behind a token; <code>publish_site</code>{" "}
          validates every GraphQL document against the live schema, smoke-renders, and
          snapshots an immutable version; <code>rollback_site</code> restores any version
          byte-for-byte. A migration guard rejects destructive schema changes that would
          break a published site.
        </p>
      </Section>

      <Section title="Owner vs editor">
        <p className="muted small" style={{ margin: 0 }}>
          The <b>owner key</b> has full access (schema, content, code). Mint scoped
          <b> editor tokens</b> from your dashboard so a content editor can maintain
          content and upload images over their own MCP client — no schema or code access.
        </p>
      </Section>

      <footer className="between small muted">
        <Link to="/">← Home</Link>
        <a href="https://github.com/jokull/loftur" target="_blank" rel="noreferrer">GitHub</a>
      </footer>
    </div>
  );
}
