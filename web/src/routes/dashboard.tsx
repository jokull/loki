import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { ChevronRight, ExternalLink } from "lucide-react";
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
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input, Label } from "../components/ui/input";
import { Badge } from "../components/ui/badge";
import { Callout } from "../components/ui/callout";
import { CodeBlock } from "../components/ui/code-block";
import { Separator } from "../components/ui/separator";
import { Collapsible, CollapsibleTrigger, CollapsiblePanel } from "../components/ui/collapsible";
import { Eyebrow, Shell } from "../components/layout";
import { Brand } from "../components/brand";

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
    <div className="flex flex-col gap-2">
      <Callout variant="ok" className="text-sm">
        New owner key — shown once. Store it now; you can always rotate again.
      </Callout>
      <CodeBlock selectAll>{apiKey}</CodeBlock>
      <Collapsible>
        <CollapsibleTrigger>
          <ChevronRight /> MCP config
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <CodeBlock selectAll className="mt-2">
            {mcpConfig(subdomain, apiKey)}
          </CodeBlock>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}

function Dashboard() {
  const { email, sites } = Route.useLoaderData();
  return (
    <Shell className="flex flex-col gap-8">
      <header className="flex items-center justify-between gap-4">
        <Link to="/" className="text-lg text-foreground no-underline">
          <Brand />
        </Link>
        <div className="flex items-center gap-3">
          <span className="hidden text-sm text-muted-foreground sm:inline">{email}</span>
          <Button variant="ghost" size="sm" render={<Link to="/auth/logout" />}>
            Log out
          </Button>
        </div>
      </header>

      <div className="flex flex-col gap-1">
        <Eyebrow>Dashboard</Eyebrow>
        <h1 className="text-2xl font-semibold">Your sites</h1>
        <p className="text-sm text-muted-foreground sm:hidden">{email}</p>
      </div>

      <ClaimSite />

      {sites.length === 0 ? (
        <Card className="p-5 text-sm text-muted-foreground">
          No sites yet. Claim your first subdomain above.
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {sites.map((s: SiteRow) => (
            <SiteCard key={s.id} site={s} />
          ))}
        </div>
      )}
    </Shell>
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
        void router.invalidate();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="flex flex-col gap-3 p-5">
      <form onSubmit={claim} className="flex flex-col gap-2">
        <Label htmlFor="sub">Claim a new site</Label>
        <div className="flex flex-wrap gap-2">
          <div className="flex min-w-0 flex-1 items-stretch">
            <Input
              id="sub"
              value={subdomain}
              onChange={(e) => setSubdomain(e.currentTarget.value.toLowerCase())}
              placeholder="acme"
              className="rounded-r-none border-r-0"
            />
            <span className="inline-flex items-center rounded-r-md border border-l-0 border-input bg-muted px-3 font-mono text-sm text-muted-foreground">
              .loftur.app
            </span>
          </div>
          <Button variant="sky" type="submit" disabled={busy || !subdomain}>
            {busy ? "Claiming…" : "Claim"}
          </Button>
        </div>
        {err && <Callout variant="error">{err}</Callout>}
      </form>
      {claimed && <KeyReveal subdomain={claimed.subdomain} apiKey={claimed.apiKey} />}
    </Card>
  );
}

type Panel = null | "key" | "tokens" | "secrets";

function SiteCard({ site }: { site: SiteRow }) {
  const [panel, setPanel] = useState<Panel>(null);
  const toggle = (p: Panel) => setPanel((cur) => (cur === p ? null : p));
  const tab = (p: Exclude<Panel, null>, label: string) => (
    <Button variant={panel === p ? "secondary" : "outline"} size="sm" onClick={() => toggle(p)}>
      {label}
    </Button>
  );
  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <a
            href={`https://${site.subdomain}.loftur.app`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 font-medium text-foreground no-underline hover:text-link"
          >
            {site.subdomain}.loftur.app
            <ExternalLink className="size-3.5 text-muted-foreground" />
          </a>
          <span className="text-xs text-muted-foreground">created {site.created_at}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {tab("key", "Owner key")}
          {tab("tokens", "Editor tokens")}
          {tab("secrets", "Secrets")}
        </div>
      </div>
      {panel === "key" && <RotateKey site={site} />}
      {panel === "tokens" && <Tokens site={site} />}
      {panel === "secrets" && <Secrets site={site} />}
    </Card>
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
    <div className="flex flex-col gap-3">
      <Separator />
      <p className="text-sm text-muted-foreground">
        Lost your owner key, or want to revoke it? Rotate to mint a new one. The old key is
        invalidated instantly. This is your account-recovery path.
      </p>
      <div>
        <Button variant="destructive" onClick={rotate} disabled={busy}>
          {busy ? "Rotating…" : "Rotate owner key"}
        </Button>
      </div>
      {key && <KeyReveal subdomain={site.subdomain} apiKey={key} />}
    </div>
  );
}

function Tokens({ site }: { site: SiteRow }) {
  const [tokens, setTokens] = useState<Array<{
    id: string;
    role: string;
    label: string | null;
    created_at: string;
  }> | null>(null);
  const [label, setLabel] = useState("");
  const [minted, setMinted] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const r = await listTokensFn({ data: { siteId: site.id } });
    setTokens(r.tokens as any);
  }
  if (tokens === null) void load();

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
    <div className="flex flex-col gap-3">
      <Separator />
      <p className="text-sm text-muted-foreground">
        Editor tokens let a content editor connect their own MCP client to maintain content and
        upload images — no schema or code access.
      </p>
      <form onSubmit={mint} className="flex flex-wrap gap-2">
        <Input
          value={label}
          onChange={(e) => setLabel(e.currentTarget.value)}
          placeholder="Label (e.g. Jane, content)"
          className="min-w-0 flex-1"
        />
        <Button variant="sky" type="submit" disabled={busy}>
          Mint editor token
        </Button>
      </form>
      {minted && (
        <div className="flex flex-col gap-1.5">
          <Callout variant="ok">Editor token — shown once.</Callout>
          <CodeBlock selectAll>{minted}</CodeBlock>
        </div>
      )}
      {tokens && tokens.length > 0 && (
        <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {tokens.map((t) => (
            <div key={t.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
              <span className="flex items-center gap-2">
                <Badge variant="mono">{t.role}</Badge>
                {t.label || <span className="text-muted-foreground">(no label)</span>}
                <span className="text-muted-foreground">· {t.created_at}</span>
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:bg-destructive/10"
                onClick={() => revoke(t.id)}
              >
                Revoke
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Secrets({ site }: { site: SiteRow }) {
  const [secrets, setSecrets] = useState<Array<{
    name: string;
    created_at: string;
    updated_at: string;
  }> | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const r = await listSecretsFn({ data: { siteId: site.id } });
    setSecrets(r.secrets as any);
  }
  if (secrets === null) void load();

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await setSecretFn({ data: { siteId: site.id, name, value } });
      if (!r.ok) setErr(r.error);
      else {
        setName("");
        setValue("");
        await load();
      }
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
    <div className="flex flex-col gap-3">
      <Separator />
      <p className="text-sm text-muted-foreground">
        Encrypted secrets your site's server code reads with <code>env.SECRETS.get("NAME")</code>.
        Values are write-only here — only names are shown.
      </p>
      <form onSubmit={save} className="flex flex-wrap gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          placeholder="STRIPE_SECRET_KEY"
          className="w-full font-mono sm:w-56"
        />
        <Input
          value={value}
          onChange={(e) => setValue(e.currentTarget.value)}
          placeholder="value"
          className="min-w-0 flex-1"
        />
        <Button variant="sky" type="submit" disabled={busy || !name || !value}>
          Set
        </Button>
      </form>
      {err && <Callout variant="error">{err}</Callout>}
      {secrets && secrets.length > 0 && (
        <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {secrets.map((s) => (
            <div key={s.name} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
              <span className="font-mono">
                {s.name} <span className="text-muted-foreground">· updated {s.updated_at}</span>
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:bg-destructive/10"
                onClick={() => del(s.name)}
              >
                Delete
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
