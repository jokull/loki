<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
  <img src="assets/logo.svg" alt="Loftur" width="220">
</picture>

**Vibe-code a real site. Schema and all.**

Most AI builders one-shot a good-looking page. Loftur one-shots the whole thing over MCP: a **real content schema** (models, fields, a typed GraphQL + schema API — feature-compatible with DatoCMS, minus the CRUD-UI), a **per-site database**, routes, islands, and server functions. Then the owner hands **editors** a scoped MCP token to maintain content and upload images — no schema changes, no code, no dashboard to babysit.

Loftur is a multi-tenant, agent-native site platform on Cloudflare, built on [agent-cms](https://github.com/jokull/agent-cms) (agent-first headless CMS) and [Dynamic Workers](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/) (the Worker Loader API). Each site is its own isolated backend. Site code lives in the database, transpiles at write time, and runs in sandboxed V8 isolates loaded on demand — no repo, no bundler, no deploy step.

## How it works

1. **Sign up** at [loftur.app](https://loftur.app) and claim `{sub}.loftur.app`. You get a one-time **owner API key** and a ready-to-paste MCP server config.
2. **Point an AI agent** (Claude Code or any MCP client) at `{sub}.loftur.app/mcp` with `Authorization: Bearer <key>`. The MCP endpoint also answers at `loftur.app/mcp` — it resolves your site from the key alone, so you can connect before the wildcard DNS resolves your subdomain.
3. **The agent orients itself** by calling `site_help`, then designs a content schema, a per-site feature database, routes, islands, and server functions — checking work with `preview_site` and shipping with `publish_site`.
4. **The site serves** at `{sub}.loftur.app`. Rollback is instant; a failed publish never touches the live site.

In blind tests, agents given nothing but the endpoint URL and a key discovered the tooling through `site_help` and shipped persistent apps — a guestbook and a poll — first try.

## What the agent can build

Every site gets the full toolset over one merged `/mcp` endpoint (Loftur's own site tools plus every agent-cms tool, proxied in-process). Grouped:

**Content schema & data (agent-cms).** Content models, fields, records, publishing, assets, and search over a typed GraphQL + schema API — DatoCMS-style (`allBlogPosts`, `blogPost(filter: …)`, `BlogPostRecord`, Structured Text as `{ value, blocks, inlineBlocks, links }`). `graphql_query` explores the API (introspection included); `schema_types` returns live-generated TypeScript for every model.

**A per-site feature database.** For app state that isn't content (guestbooks, polls, orders), the agent designs relational tables at runtime with `feature_migrate` (named, idempotent, versioned migrations), inspects them with `feature_schema` / `feature_query`, and queries them from server code with Drizzle over `env.FEATURES_SQL` (`drizzle-orm/sqlite-proxy` + a `featuresDriver(env)` helper).

**Routes, islands & server functions (no bundler).** File-based routing under `routes/`; SSR Preact by default. Any component becomes a hydrated **Preact island** (`<Island client="load|idle|visible">`) served with native ES modules and import maps — no client bundle. Typed, validated **`serverFn`** server functions run in the sandboxed isolate, callable in-process from a loader and over RPC from an island. `env.RECORDS.create` does scoped record writes (gated by `loki.config.json` `writableModels`); `env.REALTIME.publish` fans out to WebSocket channels backed by a Durable Object.

**Static & design assets.** `site_asset_import` (by URL) and `site_asset_write` (base64) store files under `public/`, content-addressed in R2, served with ETag/304 and version-pinned.

**npm dependencies — no install, no build.** The agent can `import` any npm package. On `site_write`, Loftur resolves it via esm.sh, crawls and rewrites the module graph, snapshots a self-contained, version-pinned copy into R2, then **test-loads that snapshot in a throwaway workerd isolate** to confirm it actually links and runs here. Support is empirical, not an allowlist: the write reports `resolvedDeps` with a `loadable` flag and rejects anything that needs a Node builtin or won't load. Server-only deps (inside a `serverFn` module) never reach the browser.

**Byte-faithful versioning + an in-Worker shell.** `preview_site` mints a 30-minute token that serves the draft at the real domain behind an HttpOnly cookie. `publish_site` validates every GraphQL document against the live schema, extracts the migration footprint, smoke-renders, and snapshots the authored **source** (plus compiled bundle and asset manifest) into an immutable version. `rollback_site` / `site_versions` / `reset_site` restore a version's exact source byte-for-byte. `shell` is a real in-process bash over the draft tree (`grep`/`sed`/`awk`/`find`/pipes) whose writes route through the same transpile + validate + dep-resolve pipeline as `site_write`.

**Migration guard.** Each published version records the set of GraphQL `Type.field` pairs it queries (its _footprint_). A destructive schema op that would break a live site is rejected with an error that teaches the expand → backfill → publish → contract order — over MCP and over the REST API (409). The safety CI would have given you, re-created where an agent can use it.

## Owner vs editor

Two roles, resolved from the bearer token:

- **Owner key** — full access: schema, content, and code. This is the one-time key issued at signup.
- **Editor token** — content only. The owner mints one with `create_editor_token`; an editor points their own MCP client at it to create/update/delete records, publish, and upload images. It **cannot** touch the schema (models/fields) or the site's code. Manage with `list_editor_tokens` / `revoke_editor_token`.

The toolset is gated by an allowlist, so new tools default to owner-only.

## Architecture

A single supervisor Worker (deployed as `loki`) serves the apex control plane, the merged `/mcp` endpoint, and every tenant site.

- **Per-tenant isolation.** Each site is its own backend in Durable Object SQLite, addressed by `idFromName(siteId)`:
  - `TenantDB` holds the site's **content** and runs the agent-cms engine _inside_ the DO, against the DO's embedded SQLite (via `SqlStorageD1`, a ~50-line `D1Database` adapter over `ctx.storage.sql` — agent-cms runs unmodified).
  - `TenantFeatureDB` holds the site's **feature data**, separate so app table names can't collide with agent-cms's reserved tables.

  Name-addressing means no per-tenant binding ceiling (D1 static bindings cap out; DO namespaces scale to millions), idle cost ≈ $0 (hibernated DO = no compute billing), and **30-day point-in-time recovery per tenant** for free.

- **Worker Loader isolates.** A tenant's published version loads into a V8 isolate via the Worker Loader (`LOADER`) — milliseconds cold, cached warm, `globalOutbound: null`. The isolate is handed its capabilities as `WorkerEntrypoint` service-binding stubs: `GRAPHQL` (loopback into that tenant's CMS), `RECORDS`, `REALTIME`, and `FEATURES_SQL`. This is not a convenience — a raw D1/DO handle **cannot** cross the loader's structured-clone boundary (`DataCloneError`); only entrypoint stubs pass. So the per-tenant DO SQLite is always reached through a capability stub, and the sandbox has exactly the surface a loader has and nothing more.

- **Request routing.** `loftur.app` / `www` → the control plane (signup, keys) and `/mcp`. `{sub}.loftur.app` → the tenant site (published version, or the draft under a preview cookie) and `/mcp`. A `x-loftur-host` header overrides the host for pre-DNS testing.

## Local development

Requires a Cloudflare account on Workers Paid (Worker Loader), `pnpm`, and `wrangler` logged in.

```sh
pnpm install
pnpm vendor                              # builds the site runtime shim (scripts/build-vendor.mjs)

wrangler d1 create loftur-db             # put the database_id into wrangler.jsonc (binding DB)
wrangler d1 migrations apply loftur-db   # applies migrations/ (add --remote for prod)
wrangler secret put WRITE_KEY            # any long random string (admin/default-site key)

pnpm dev                                 # wrangler dev
pnpm deploy                              # wrangler deploy
```

`pnpm typecheck` runs `tsc --noEmit`; `pnpm types` regenerates `worker-configuration.d.ts` via `wrangler types` (never edit it by hand). The Worker binds `DB` (D1 `loftur-db`), `FEATURES_DB`, `LOADER` (Worker Loader), `ASSETS` (R2), and the `ChannelDO` / `TenantDB` / `TenantFeatureDB` Durable Objects — see `wrangler.jsonc`.

See [`DECISIONS.md`](./DECISIONS.md) for the no-bundler architecture rationale (ADR-001) and the autonomous-run risk notes (ADR-002).

## Status

Live at [loftur.app](https://loftur.app): signup → keyed MCP → build, with a fully isolated content + feature backend per site. The apex, control plane, and `loftur.app/mcp` are in production; public serving at each `{sub}.loftur.app` needs the proxied wildcard `*.loftur.app` DNS record (serving is otherwise proven via the `x-loftur-host` override).

**A note on the name.** The project is being renamed **loki → loftur** ("Loftur" is the modern Icelandic form of _Loptr_, one of Loki's bynames — from _loft_ = air/sky, an edge/cloud pun). The deployed Cloudflare Worker keeps the internal name `loki` and the runtime import namespaces stay `loki/runtime` and `loki/schema` — those are deploy/module names, never user-facing; renaming the Worker would strand its Durable Object data.

## License

MIT © Jökull Sólberg
</content>
</invoke>
