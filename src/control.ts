// Loftur control plane (served on the apex, loftur.app): the signup landing and
// the /api/signup handler that claims a {subdomain}.loftur.app and returns the
// environment-keyed MCP instructions (endpoint URL + one-time API key + a
// ready-to-paste MCP server config). No JS required — plain form POST.

import type { Env } from "./env";
import { createSite, validateSubdomain } from "./tenants";

const BRAND = {
  ember: "#cf551d",
  emberDark: "#f0752e",
};

/** Shared <head> + shell styles (ember-on-slate Loftur identity, theme-aware). */
function page(title: string, body: string): Response {
  const html = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root{--bg:#f4f6f9;--surface:#fff;--surface2:#edf0f5;--ink:#12161d;--soft:#454e5d;--muted:#737d8d;--border:#dde2ea;--accent:${BRAND.ember};--accentink:${BRAND.ember};--wash:#fbeee7}
  @media (prefers-color-scheme:dark){:root{--bg:#0d1016;--surface:#151a22;--surface2:#1c232e;--ink:#e9edf3;--soft:#b4bdca;--muted:#7e8896;--border:#253040;--accent:${BRAND.emberDark};--accentink:#f5945c;--wash:#2a1a10}}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
  .wrap{max-width:640px;margin:0 auto;padding:0 20px 80px}
  header{padding:72px 0 8px}
  .logo{display:inline-flex;align-items:center;gap:.5em;font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:.8rem;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);border:1px solid var(--border);border-radius:999px;padding:.35em .8em}
  .logo b{color:var(--accent)}
  h1{font-family:"Charter","Iowan Old Style",Georgia,serif;font-weight:800;font-size:clamp(2rem,1.4rem+2.6vw,2.9rem);letter-spacing:-.02em;line-height:1.05;margin:1.4rem 0 .4em;text-wrap:balance}
  h1 .fire{color:var(--accent)}
  .lede{font-size:1.12rem;color:var(--soft);margin:0 0 2rem}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:26px}
  label{display:block;font-family:ui-monospace,Menlo,monospace;font-size:.68rem;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin:0 0 .5em}
  .field{display:flex;align-items:stretch;border:1px solid var(--border);border-radius:10px;overflow:hidden;background:var(--bg)}
  .field input{flex:1;border:0;background:transparent;color:var(--ink);font:inherit;padding:.7em .8em;outline:none;min-width:0}
  .field .suffix{display:flex;align-items:center;padding:0 .8em;color:var(--muted);background:var(--surface2);border-left:1px solid var(--border);font-family:ui-monospace,Menlo,monospace;font-size:.9rem}
  input[type=email]{width:100%;border:1px solid var(--border);border-radius:10px;background:var(--bg);color:var(--ink);font:inherit;padding:.7em .8em;outline:none}
  input:focus,input:focus-within{border-color:var(--accent)}
  .field:focus-within{border-color:var(--accent)}
  .row{margin:0 0 18px}
  button{appearance:none;border:0;border-radius:10px;background:var(--accent);color:#fff;font:600 1rem/1 inherit;padding:.85em 1.2em;cursor:pointer;width:100%}
  button:hover{filter:brightness(1.05)}
  .hint{color:var(--muted);font-size:.86rem;margin:.6em 0 0}
  .err{background:var(--wash);border:1px solid var(--accent);color:var(--ink);border-radius:10px;padding:.7em .9em;margin:0 0 18px;font-size:.94rem}
  pre{background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:14px 16px;overflow-x:auto;font-family:ui-monospace,Menlo,monospace;font-size:.82rem;line-height:1.5;color:var(--ink)}
  code{font-family:ui-monospace,Menlo,monospace}
  .key{font-family:ui-monospace,Menlo,monospace;font-size:.95rem;color:var(--accentink);word-break:break-all}
  .steps{counter-reset:s;list-style:none;padding:0;margin:1.5rem 0 0}
  .steps li{position:relative;padding:0 0 1.4rem 2.4rem;border-left:2px solid var(--border);margin-left:.6rem}
  .steps li:last-child{border-left-color:transparent}
  .steps li::before{counter-increment:s;content:counter(s);position:absolute;left:-.85rem;top:-.1rem;width:1.7rem;height:1.7rem;border-radius:50%;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font:600 .85rem ui-monospace,Menlo,monospace}
  .steps h3{margin:.1rem 0 .5rem;font-size:1.02rem}
  a{color:var(--accentink)}
  footer{margin-top:56px;padding-top:20px;border-top:1px solid var(--border);color:var(--muted);font-size:.8rem}
  .warn{color:var(--accentink);font-weight:600}
</style></head><body><div class="wrap">${body}</div></body></html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function landing(error?: string, subValue = "", emailValue = ""): Response {
  const err = error ? `<div class="err">${escapeHtml(error)}</div>` : "";
  return page(
    "Loftur — build a site by talking to an agent",
    `<header><span class="logo"><b>◆</b> Loftur</span></header>
    <h1>Claim a subdomain. <span class="fire">Hand it to your agent.</span></h1>
    <p class="lede">Loftur runs your site on the edge and lets an AI agent build it over MCP — routes, islands, server functions, live preview, versioned publishes. Pick a name, get a key, start building.</p>
    <div class="card">
      <form method="POST" action="/api/signup">
        ${err}
        <div class="row">
          <label for="subdomain">Your subdomain</label>
          <div class="field">
            <input id="subdomain" name="subdomain" value="${escapeHtml(subValue)}" placeholder="acme" autocomplete="off" autocapitalize="off" spellcheck="false" required>
            <span class="suffix">.loftur.app</span>
          </div>
          <p class="hint">3–30 chars · lowercase letters, numbers, hyphens.</p>
        </div>
        <div class="row">
          <label for="email">Email (optional)</label>
          <input id="email" name="email" type="email" value="${escapeHtml(emailValue)}" placeholder="you@example.com" autocomplete="email">
          <p class="hint">Only used to recover your key later. No password yet.</p>
        </div>
        <button type="submit">Claim it &amp; get my MCP key →</button>
      </form>
    </div>
    <footer>Loftur · an agent-native site platform on Cloudflare. One key, one site, live at your subdomain.</footer>`,
  );
}

function successPage(subdomain: string, apiKey: string): Response {
  const mcpUrl = `https://${subdomain}.loftur.app/mcp`;
  const serverName = `loftur-${subdomain}`;
  const mcpJson = JSON.stringify(
    {
      mcpServers: {
        [serverName]: {
          type: "http",
          url: mcpUrl,
          headers: { Authorization: `Bearer ${apiKey}` },
        },
      },
    },
    null,
    2,
  );
  const cliCmd = `claude mcp add ${serverName} --transport http ${mcpUrl} \\\n  --header "Authorization: Bearer ${apiKey}"`;
  return page(
    `Loftur — ${subdomain}.loftur.app is yours`,
    `<header><span class="logo"><b>◆</b> Loftur</span></header>
    <h1><span class="fire">${escapeHtml(subdomain)}.loftur.app</span> is yours.</h1>
    <p class="lede">Save your key — <span class="warn">it's shown only once.</span> Then point your agent at the endpoint and start building.</p>
    <div class="card">
      <div class="row">
        <label>Your API key (shown once)</label>
        <pre class="key">${escapeHtml(apiKey)}</pre>
      </div>
      <div class="row">
        <label>MCP endpoint</label>
        <pre>${escapeHtml(mcpUrl)}</pre>
      </div>
    </div>
    <ol class="steps">
      <li><h3>Add the MCP server to Claude Code</h3><pre>${escapeHtml(cliCmd)}</pre>
        <p class="hint">Or drop this into your MCP client config:</p><pre>${escapeHtml(mcpJson)}</pre></li>
      <li><h3>Ask your agent to orient itself</h3>
        <p class="hint">Have it call the <code>site_help</code> tool first — it returns the routing conventions, the module shape, available imports, and the preview → publish workflow.</p></li>
      <li><h3>Build, preview, publish</h3>
        <p class="hint">The agent writes routes and islands with <code>site_write</code>/<code>shell</code>, checks work with <code>preview_site</code>, and ships with <code>publish_site</code>. Your site goes live at <a href="https://${escapeHtml(subdomain)}.loftur.app">${escapeHtml(subdomain)}.loftur.app</a>.</p></li>
    </ol>
    <footer>Lost your key? Key recovery isn't built yet — for now, keep it somewhere safe.</footer>`,
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

/** Route an apex (loftur.app) request: landing, signup, health. */
export async function handleControlPlane(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;

  if (pathname === "/health") {
    return new Response("ok", { headers: { "content-type": "text/plain" } });
  }

  if (pathname === "/api/signup" && request.method === "POST") {
    const ct = request.headers.get("content-type") ?? "";
    let subdomain = "";
    let email = "";
    let wantsJson = ct.includes("application/json");
    if (wantsJson) {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      subdomain = String(body.subdomain ?? "");
      email = String(body.email ?? "");
    } else {
      const form = await request.formData();
      subdomain = String(form.get("subdomain") ?? "");
      email = String(form.get("email") ?? "");
    }

    const result = await createSite(env, subdomain, email || null);
    if (!result.ok) {
      if (wantsJson) {
        return Response.json({ ok: false, error: result.error }, { status: 400 });
      }
      return landing(result.error, subdomain, email);
    }
    if (wantsJson) {
      return Response.json({
        ok: true,
        subdomain: result.site.subdomain,
        siteUrl: `https://${result.site.subdomain}.loftur.app`,
        mcpUrl: `https://${result.site.subdomain}.loftur.app/mcp`,
        apiKey: result.apiKey,
      });
    }
    return successPage(result.site.subdomain, result.apiKey);
  }

  if (pathname === "/" || pathname === "") {
    return landing();
  }

  // Anything else on the apex → 404 to the landing.
  return new Response("Not found", { status: 404 });
}

/** Exported for a possible future availability endpoint. */
export { validateSubdomain };
