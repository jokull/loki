import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import {
  mySitesFn,
  rotateKeyFn,
  listTokensFn,
  mintTokenFn,
  revokeTokenFn,
  listSecretsFn,
  setSecretFn,
  deleteSecretFn,
  claimSiteFn,
} from "../server/rpc";

export const Route = createFileRoute("/dashboard")({
  // mySitesFn throws a redirect to /login when not signed in.
  loader: async () => mySitesFn(),
  component: Dashboard,
});

type SiteRow = { id: string; subdomain: string; created_at: string };

function mcpConfig(subdomain: string, key: string) {
  return JSON.stringify(
    {
      mcpServers: {
        [`loftur-${subdomain}`]: {
          type: "http",
          url: `https://${subdomain}.loftur.app/mcp`,
          headers: { Authorization: `Bearer ${key}` },
        },
      },
    },
    null,
    2,
  );
}

function KeyReveal({ subdomain, apiKey }: { subdomain: string; apiKey: string }) {
  return (
    <div className="stack" style={{ gap: ".4rem" }}>
      <div className="notice ok small">
        New owner key — shown once. Store it now; you can always rotate again.
      </div>
      <pre className="key">{apiKey}</pre>
      <details>
        <summary className="small muted" style={{ cursor: "pointer" }}>MCP config</summary>
        <pre className="key">{mcpConfig(subdomain, apiKey)}</pre>
      </details>
    </div>
  );
}

function Dashboard() {
  const { email, sites } = Route.useLoaderData();
  return (
    <div className="wrap stack">
      <header className="between">
        <Link to="/" className="brand"><span className="dot" />loftur</Link>
        <div className="row small">
          <span className="muted">{email}</span>
          <Link to="/auth/logout" className="btn ghost small">Log out</Link>
        </div>
      </header>

      <div className="between">
        <div>
          <p className="eyebrow">Dashboard</p>
          <h1 style={{ fontSize: "1.6rem", margin: ".2rem 0 0" }}>Your sites</h1>
        </div>
      </div>

      <ClaimSite />

      {sites.length === 0 ? (
        <div className="card muted">No sites yet. Claim your first subdomain above.</div>
      ) : (
        <div className="stack">
          {sites.map((s: SiteRow) => (
            <SiteCard key={s.id} site={s} />
          ))}
        </div>
      )}
    </div>
  );
}

function ClaimSite() {
  const router = useRouter();
  const [subdomain, setSubdomain] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [claimed, setClaimed] = useState<{ subdomain: string; apiKey: string } | null>(null);

  async function claim(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await claimSiteFn({ data: { subdomain } });
      if (!r.ok) setErr(r.error);
      else {
        setClaimed({ subdomain: r.subdomain, apiKey: r.apiKey });
        setSubdomain("");
        router.invalidate();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack">
      <form onSubmit={claim} className="stack">
        <label htmlFor="sub">Claim a new site</label>
        <div className="row">
          <div className="row" style={{ flex: 1, gap: 0 }}>
            <input
              id="sub"
              className="inp"
              value={subdomain}
              onChange={(e) => setSubdomain(e.currentTarget.value.toLowerCase())}
              placeholder="acme"
              style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
            />
            <span className="pill" style={{ borderRadius: 0, borderLeft: 0, padding: ".55rem .6rem" }}>
              .loftur.app
            </span>
          </div>
          <button className="btn primary" disabled={busy || !subdomain}>
            {busy ? "Claiming…" : "Claim"}
          </button>
        </div>
        {err && <div className="notice err small">{err}</div>}
      </form>
      {claimed && <KeyReveal subdomain={claimed.subdomain} apiKey={claimed.apiKey} />}
    </div>
  );
}

type Panel = null | "key" | "tokens" | "secrets";

function SiteCard({ site }: { site: SiteRow }) {
  const [panel, setPanel] = useState<Panel>(null);
  const toggle = (p: Panel) => setPanel((cur) => (cur === p ? null : p));
  return (
    <div className="card stack">
      <div className="between">
        <div>
          <a href={`https://${site.subdomain}.loftur.app`} target="_blank" rel="noreferrer" style={{ fontWeight: 600 }}>
            {site.subdomain}.loftur.app
          </a>
          <div className="small muted">created {site.created_at}</div>
        </div>
        <div className="row small">
          <button className="btn" onClick={() => toggle("key")}>Owner key</button>
          <button className="btn" onClick={() => toggle("tokens")}>Editor tokens</button>
          <button className="btn" onClick={() => toggle("secrets")}>Secrets</button>
        </div>
      </div>
      {panel === "key" && <RotateKey site={site} />}
      {panel === "tokens" && <Tokens site={site} />}
      {panel === "secrets" && <Secrets site={site} />}
    </div>
  );
}

function RotateKey({ site }: { site: SiteRow }) {
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState<string | null>(null);
  async function rotate() {
    if (!confirm("Rotate the owner key? The old key stops working immediately.")) return;
    setBusy(true);
    try {
      const r = await rotateKeyFn({ data: { siteId: site.id } });
      if (r.ok) setKey(r.apiKey);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="stack">
      <hr className="divider" />
      <p className="small muted" style={{ margin: 0 }}>
        Lost your owner key, or want to revoke it? Rotate to mint a new one. The old
        key is invalidated instantly. This is your account-recovery path.
      </p>
      <div><button className="btn danger" onClick={rotate} disabled={busy}>{busy ? "Rotating…" : "Rotate owner key"}</button></div>
      {key && <KeyReveal subdomain={site.subdomain} apiKey={key} />}
    </div>
  );
}

function Tokens({ site }: { site: SiteRow }) {
  const [tokens, setTokens] = useState<Array<{ id: string; role: string; label: string | null; created_at: string }> | null>(null);
  const [label, setLabel] = useState("");
  const [minted, setMinted] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const r = await listTokensFn({ data: { siteId: site.id } });
    setTokens(r.tokens as any);
  }
  if (tokens === null) load();

  async function mint(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await mintTokenFn({ data: { siteId: site.id, label } });
      setMinted(r.token);
      setLabel("");
      await load();
    } finally {
      setBusy(false);
    }
  }
  async function revoke(id: string) {
    if (!confirm("Revoke this editor token?")) return;
    await revokeTokenFn({ data: { siteId: site.id, id } });
    await load();
  }

  return (
    <div className="stack">
      <hr className="divider" />
      <p className="small muted" style={{ margin: 0 }}>
        Editor tokens let a content editor connect their own MCP client to maintain
        content and upload images — no schema or code access.
      </p>
      <form onSubmit={mint} className="row">
        <input className="inp" value={label} onChange={(e) => setLabel(e.currentTarget.value)} placeholder="Label (e.g. Jane, content)" style={{ flex: 1 }} />
        <button className="btn primary" disabled={busy}>Mint editor token</button>
      </form>
      {minted && (
        <div className="stack" style={{ gap: ".3rem" }}>
          <div className="notice ok small">Editor token — shown once.</div>
          <pre className="key">{minted}</pre>
        </div>
      )}
      {tokens && tokens.length > 0 && (
        <div className="stack" style={{ gap: ".3rem" }}>
          {tokens.map((t) => (
            <div key={t.id} className="between small">
              <span><span className="pill">{t.role}</span> {t.label || <span className="muted">(no label)</span>} <span className="muted">· {t.created_at}</span></span>
              <button className="btn ghost danger small" onClick={() => revoke(t.id)}>Revoke</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Secrets({ site }: { site: SiteRow }) {
  const [secrets, setSecrets] = useState<Array<{ name: string; created_at: string; updated_at: string }> | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const r = await listSecretsFn({ data: { siteId: site.id } });
    setSecrets(r.secrets as any);
  }
  if (secrets === null) load();

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await setSecretFn({ data: { siteId: site.id, name, value } });
      if (!r.ok) setErr(r.error);
      else { setName(""); setValue(""); await load(); }
    } finally {
      setBusy(false);
    }
  }
  async function del(n: string) {
    if (!confirm(`Delete secret ${n}?`)) return;
    await deleteSecretFn({ data: { siteId: site.id, name: n } });
    await load();
  }

  return (
    <div className="stack">
      <hr className="divider" />
      <p className="small muted" style={{ margin: 0 }}>
        Encrypted secrets your site's server code reads with <code>env.SECRETS.get("NAME")</code>.
        Values are write-only here — only names are shown.
      </p>
      <form onSubmit={save} className="row">
        <input className="inp" value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="STRIPE_SECRET_KEY" style={{ flex: "0 1 14rem" }} />
        <input className="inp" value={value} onChange={(e) => setValue(e.currentTarget.value)} placeholder="value" style={{ flex: 1 }} />
        <button className="btn primary" disabled={busy || !name || !value}>Set</button>
      </form>
      {err && <div className="notice err small">{err}</div>}
      {secrets && secrets.length > 0 && (
        <div className="stack" style={{ gap: ".3rem" }}>
          {secrets.map((s) => (
            <div key={s.name} className="between small">
              <span className="mono">{s.name} <span className="muted">· updated {s.updated_at}</span></span>
              <button className="btn ghost danger small" onClick={() => del(s.name)}>Delete</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
