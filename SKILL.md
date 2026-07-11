---
name: loftur
description: >-
  Spin up and ship real, multi-tenant websites and web apps on Loftur — a runtime
  you drive over MCP. Use when the user wants to create, edit, or deploy a site,
  page, or small app that needs hosting, a database, auth, secrets, email, file
  uploads, or a CMS, without setting up any infrastructure. With one account token
  you can claim {subdomain}.loftur.app names on demand and build each one live.
---

# Loftur — one token: claim subdomains and ship real sites

Loftur is a **runtime, not a chat box**. You (the agent) are the developer's
hands: with ONE account token you connect to a single MCP endpoint and can
**claim new `{subdomain}.loftur.app` sites on demand** and **build any of them** —
file-based routes, SSR Preact + hydrated islands, a per-site SQL database,
passwordless end-user auth, encrypted secrets, transactional email, uploads,
realtime, and any npm package. No local dev setup, no bundler, no deploy pipeline.
You write files, preview, and publish immutable versions.

## 1. Connect once (account token → one MCP endpoint)

The user creates an **account token** (`lftr_pat_…`) in their Loftur dashboard
(https://loftur.app → sign in → **Agent access** → create token; shown once,
revocable). Ask them for it if you don't have it. This token authenticates as
their whole **account** — not a single site — so it can claim subdomains and
build across all of their sites.

**Claude Code / Openclaw (CLI):**

```bash
claude mcp add loftur --transport http https://loftur.app/mcp \
  --header "Authorization: Bearer lftr_pat_your_account_token"
```

**Any MCP client (JSON config):**

```json
{
  "mcpServers": {
    "loftur": {
      "type": "http",
      "url": "https://loftur.app/mcp",
      "headers": { "Authorization": "Bearer lftr_pat_your_account_token" }
    }
  }
}
```

**Connecting notes.** Some agent hosts only project a newly-added MCP server's
tools into the *next* turn/session — if the `loftur.app` tools don't appear
immediately after adding the server, start a fresh turn (or drive the endpoint
directly with a small HTTP JSON-RPC client meanwhile). Calls to `/mcp` go over
the network, so treat a transient network error (e.g. `ENETDOWN`) as retryable —
retry the same tool call rather than assuming it failed.

## 2. Orient, then claim a site

Everything below happens over that ONE connection.

1. **`site_help`** — the full authoring guide (route module shape, serverFns, the
   `env` capabilities, the feature database, auth, assets, GraphQL, islands,
   worked examples). It's global (no `site` needed) — read it any time; it's the
   source of truth.
2. **`whoami`** — the account email + every site you already own, and how to
   address them (each build tool takes a `site` argument).
3. **`claim_site({ subdomain })`** — provision a brand-new
   `{subdomain}.loftur.app` (e.g. `claim_site({ subdomain: "hermes" })`). It comes
   back live with its backend wired up. Build it immediately — no reconnect.
4. **`schema_types({ site })`** — TypeScript types generated from THAT site's LIVE
   CMS schema (per-site, so it needs a claimed `site`). You have no IDE hover, so
   this is how you learn exact field names.

Other account tools: `list_sites`, `rotate_site_key({ site })` (regenerate an
owner key), `mint_editor_token({ site, label })` (hand a content editor a
content-only token).

## 3. The build loop (every build tool takes `site`)

```
site_write({ site: "hermes", path: "routes/index.tsx", source: "…" })   # transpiled + gql-validated on write
preview_site({ site: "hermes" })                                        # a live draft URL (30-min token)
publish_site({ site: "hermes", message: "v1" })                         # validates, smoke-renders, snapshots a version
rollback_site({ site: "hermes", versionId })                            # immutable history, byte-for-byte
```

- The `site` selector is the subdomain (or id) from `whoami`/`list_sites`/`claim_site`.
- Files live in a **draft working tree**. `site_write` returns transpile/GraphQL
  errors immediately (non-fatal); `publish_site` hard-gates on the same validation.
- **`shell({ site, command })`** is a real in-process bash over the draft
  (`grep`/`sed`/`awk`/`find`/pipes) for multi-file edits — hermetic: **no** real
  `git`/`tsc`/`node`/`npm`/network. Let the write pipeline + `publish_site` validate.
- `reset_site({ site })` throws the draft away back to the published version.

## 4. What you can build (pointers — full detail in `site_help`)

| Need              | How                                                                                                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pages & routing   | `routes/index.tsx` → `/`, `routes/posts/[slug].tsx` → `/posts/:slug`. Default-export a Preact component; optional `loader`, `head`, `action`.              |
| Content (CMS)     | GraphQL via `query(env, gql\`…\`)`; DatoCMS-style (`allBlogPosts`, `blogPost(filter:…)`). Prototype with the `graphql_query` tool.                         |
| Mutations / forms | A **serverFn** (`serverFn().validator().handler()`) in its own module under `functions/` — callable from a loader (server) AND an island (browser RPC).    |
| A real database   | The **feature DB**: `feature_migrate({site, name, up})` to create tables, then Drizzle over `featuresDriver(env)` inside a serverFn.                       |
| End-user auth     | Built-in passwordless magic-link. `env.AUTH.requestMagicLink(email)`; read `user` (`{id, email, role}`) in any loader/serverFn. Roles via `set_user_role`. |
| Secrets           | `set_secret` tool → `env.SECRETS.get("NAME")` in server code. Never hardcode keys.                                                                         |
| Outbound HTTP     | `fetch()` from server code (mediated + logged). Restrict with `allowedHosts` in `loki.config.json`.                                                        |
| Email             | `env.MAIL.send({to, subject, html})` from a serverFn.                                                                                                      |
| Uploads           | `env.UPLOADS.put(key, base64)` → served at `/__uploads/<key>`.                                                                                             |
| Realtime          | `env.REALTIME.publish(channel, msg)` (server) + `connectChannel(name, cb)` (island).                                                                       |
| Interactivity     | An **island**: `<Island src="components/x.tsx" client="visible" …/>` — SSR'd + hydrated.                                                                   |
| Static assets     | `site_asset_import({site, path:"public/og.png", url})` → served at the site root.                                                                          |
| npm packages      | Just `import` any pure-ESM, workerd-compatible package — resolved & snapshotted at write time, no install.                                                 |
| Starters          | `scaffold_template` lists & writes starters (e.g. members area, link-in-bio).                                                                              |

## 5. Guardrails (avoid the common traps)

- **serverFn modules export ONLY serverFns** (+ `import type`). A component or
  other value export in the same file is rejected — put helpers/components elsewhere.
- **Casing:** `env.RECORDS.create(model, fields)` takes **snake_case** field keys;
  GraphQL reads the same fields in **camelCase**.
- **Secrets** go in `env.SECRETS`, never in a module the browser imports (only
  serverFn modules are stubbed out of the client build).
- **Migration guard:** deleting a CMS field/model a published site depends on is
  rejected. Safe order: expand → backfill → publish → contract.
- **No Node builtins** in site code (no `nodejs_compat`); capabilities are the
  `env` bindings + mediated `fetch()`.
- Relative imports include the extension: `import { X } from "./lib/x.tsx"`.

## 6. A good first run

> "Spin me up a personal site with a home page, an about page, and a working
> contact form that emails me."

1. `claim_site({ subdomain: "yourname" })`.
2. `site_help`, then `schema_types({ site: "yourname" })`.
3. `site_write` `routes/index.tsx` + `routes/about.tsx` + `styles.css` (each with `site`).
4. A `functions/contact.ts` serverFn that validates input and calls `env.MAIL.send`
   (tell the owner to `set_secret` if a third-party key is needed).
5. `site_write` `routes/contact.tsx` with a form island calling the serverFn.
6. `preview_site({ site: "yourname" })` → open the URL, check it, iterate.
7. `publish_site({ site: "yourname", message: "initial site" })`. It's live at
   `https://yourname.loftur.app`. Claim the next idea whenever you want.

---

Loftur is open source (https://github.com/jokull/loftur) — self-host the whole
runtime on your own Cloudflare account and serve tenants under your own domain.
This skill's latest version is always at **https://loftur.app/skill.md**.
