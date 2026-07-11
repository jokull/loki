export const SITE_HELP = `# Loki site authoring guide

You are authoring a server-rendered (SSR) Preact site. The code lives in D1 as a
draft working tree; you edit it with the site_* MCP tools, preview it, then
publish an immutable version. Content comes from the CMS via GraphQL.

## Files & conventions

- File-based routing under \`routes/\`:
  - \`routes/index.tsx\`        -> \`/\`
  - \`routes/about.tsx\`        -> \`/about\`
  - \`routes/posts/index.tsx\`  -> \`/posts\`
  - \`routes/posts/[slug].tsx\` -> \`/posts/:slug\` (the \`slug\` becomes a route param)
- \`styles.css\` (top-level) is served at \`/styles.css\` and auto-linked into every page.
- \`main.ts\` (or main.tsx/js) is an ESCAPE HATCH: if present it must default-export
  a fetch handler \`{ fetch(request, env, ctx) }\` and it fully replaces file routing.
- \`*.graphql\` files are treated as standalone GraphQL documents (validated at publish).

## Route module shape

Each route module default-exports a Preact component. Optionally export:
- \`loader({ env, params, request, user })\` -> returns props (may be async; runs on the server).
  \`user\` is the signed-in end user (\`{ id, email }\`) or \`null\` — see "User auth" below.
- \`head\` -> an object \`{ title, meta: [...], links: [{rel, href}] }\`, or a
  function \`(props) => head\`. Each \`meta\` item is EITHER \`{ name, content }\`
  (standard meta) OR \`{ property, content }\` (Open-Graph / Facebook — e.g.
  \`{ property: "og:image", content: "/og.png" }\`). A meta given as
  \`{ name: "og:..." }\` (or \`fb:\`/\`article:\`) is auto-mapped to \`property\` for you.

### Global head (site-wide favicon / OG / meta)

Set a favicon, default OG tags, or any site-wide \`<head>\` bits ONCE by exporting
\`head\` from a top-level \`app.tsx\` (or app.ts/js). It has the SAME shape as a route
head (object or \`(props) => head\`) and is merged UNDER every page:

- \`title\`: the route's wins if it sets one, else the global title.
- \`meta\` / \`links\`: unioned. A route entry OVERRIDES a global one with the same
  identity — meta by its \`name\`/\`property\`, links by \`rel\`+\`href\` — and duplicates
  are collapsed, so you never emit two favicons or two \`og:image\` tags.

    // app.tsx — applies to every route
    export const head = {
      links: [{ rel: "icon", href: "/favicon.ico" }],
      meta: [
        { property: "og:image", content: "/og.png" },
        { property: "og:site_name", content: "My Site" },
      ],
    };

A route that sets its own \`head\` still works: it keeps the global favicon while
overriding \`title\` and any tag it re-declares (e.g. a page-specific \`og:image\`).
- \`action({ request, env, params, user })\` -> handles NON-GET requests to this route
  (POST/PUT/PATCH/DELETE) — see "Route actions" below. \`user\` is the signed-in
  end user or \`null\`.

The component receives \`{ ...loaderProps, params }\`. To show who is signed in,
read \`user\` in the loader and pass it into props.

## Route actions (form handling & writes)

A non-GET request to a route is dispatched to that route's \`action\` export
(instead of rendering the component). If the matched route has no \`action\`, the
response is \`405 Method Not Allowed\`. Action return values are normalized:

- a \`Response\` (including \`Response.redirect(url, 303)\`) -> passed through as-is;
- a \`{ redirect: "/path" }\` sentinel -> \`303 See Other\` to that path (use this
  for the post/redirect/get pattern after a successful form POST);
- \`null\`/\`undefined\` -> \`204 No Content\`;
- any other plain value -> \`200\` JSON response.

    // routes/contact.tsx
    export async function action({ request, env }) {
      const form = await request.formData();
      const email = String(form.get("email") || "");
      if (!email.includes("@")) return new Response("Bad email", { status: 400 });
      // ...do the write...
      return { redirect: "/contact?sent=1" }; // 303 back to the page
    }
    export default function Contact({ params }) {
      return (
        <form method="post">
          <input name="email" type="email" required />
          <button>Sign up</button>
        </form>
      );
    }

## Server functions: serverFn (the PREFERRED path for forms / mutations / data)

A \`serverFn\` is a typed, validated server function. It is the recommended way to
do mutations and typed reads — reach for a raw route \`action\` only when you need a
full \`Response\` (redirects, non-JSON, webhooks).

CONVENTION (enforced at write): a serverFn module exports ONLY serverFns (and
\`import type\` types). The browser build of a serverFn module is SYNTHESIZED
entirely from its serverFn exports — the handler/validator source is never sent
to the client — so any OTHER value export (a component, a plain function,
\`export default\`, an \`export { … }\` list) would be dropped from the client build
and is REJECTED by \`site_write\` with a message telling you to move the serverFn(s)
into their own module. Keep serverFns in a dedicated module (e.g. under
\`functions/\`) and put components/helpers elsewhere. Define it there and import it
from BOTH a loader (server) and an island (browser):

    // functions/guestbook.ts
    import { serverFn } from "loki/runtime";
    import type { GuestbookEntryRecord } from "loki/schema";

    export const createEntry = serverFn({ method: "POST" })
      .validator((input) => ({
        name: String(input.name).slice(0, 80),
        message: String(input.message).slice(0, 500),
      }))
      .handler(async ({ data, env }): Promise<{ id: string }> => {
        const created = await env.RECORDS.create("guestbook_entry", data);
        if (created.error) throw new Error(created.error);
        await env.REALTIME.publish("guestbook", { id: created.id, ...data });
        return { id: created.id };
      });

    export const recentEntries = serverFn() // called from a loader (in-isolate); method n/a
      .handler(async ({ env }): Promise<GuestbookEntryRecord[]> => {
        const data = await query(env, ENTRIES);
        return data.allGuestbookEntries;
      });

- \`.validator(fn)\`: transforms/validates the RAW input into the typed \`data\` your
  handler receives. If it throws, the RPC call returns \`400\` with the thrown
  message. Optional (defaults to identity). Its return TYPE is your \`data\` type.
- \`.handler({ data, env, request, user })\`: runs IN THE ISOLATE. \`env\` is the
  site's narrow capability env — the SAME one a loader/render gets: \`env.GRAPHQL\`,
  \`env.RECORDS\`, \`env.REALTIME\`, \`env.FEATURES_SQL\`, \`env.SECRETS\` (read stored API
  keys), \`env.AUTH\` (send magic-link sign-ins), \`env.MAIL\` (send transactional
  email), \`env.LOG.write(level, message)\` (runtime logs — read them with the
  \`site_logs\` tool), \`env.UPLOADS\` (store user-uploaded files), plus MEDIATED
  outbound \`fetch()\` to external hosts. There is NO raw DB and NO Worker Loader.
  \`user\` is the signed-in
  end user (\`{ id, email }\`) or \`null\`. The return value is JSON-serialized to
  callers; annotate it (e.g. via
  \`import type { X } from "loki/schema"\`) so its type flows to the caller.
- \`method\`: \`"GET"\` or \`"POST"\` (POST is the default for the browser stub). It ONLY
  affects the browser-RPC TRANSPORT: a GET stub encodes the input as
  \`?data=<urlencoded JSON>\` (watch URL length — use POST for large/complex input);
  a POST stub sends \`{ data }\` in the request body. When a serverFn is called
  DIRECTLY from a loader it is an in-isolate call and \`method\` is irrelevant (no
  HTTP happens). Use GET for cache-friendly reads, POST for mutations.

### serverFn id + RPC endpoint (curl-testing)

Every serverFn has a stable id of the form \`<modulePath>#<exportName>\` (e.g.
\`functions/guestbook.ts#createEntry\`) — derived from where it's defined, identical
in the isolate and the browser stub, so warm isolates cache across publishes of
unchanged code. The browser stub calls:

    <method> /__fn/<scope>/<encodeURIComponent(id)>

where \`scope\` is \`draft\` in preview (requires the \`loki_preview\` cookie) or
\`v<N>\` on the published site (this is exactly \`window.__lokiFnBase\`, injected into
the page alongside the island bootstrap). So to curl-test a POST serverFn in
preview (reusing the cookie jar from \`preview_site\`):

    curl -sb jar -X POST "<origin>/__fn/draft/functions%2Fguestbook.ts%23createEntry" \\
      -H 'content-type: application/json' \\
      -d '{"data":{"name":"Ada","message":"hi"}}'

A GET serverFn instead: \`curl -sb jar "<origin>/__fn/draft/<id>?data=%7B%7D"\`.
Responses: \`200\` with the JSON result, \`400\` on a validator throw / bad input,
\`404\` unknown id, \`500\` on a plain handler throw (logged server-side, GENERIC
message so internals never leak). To send a SPECIFIC status + message to the
caller (the browser stub throws \`Error(message)\`, so an island can show it), throw
an \`HttpError\` from \`loki/runtime\`:

    import { serverFn, HttpError } from "loki/runtime";
    export const buy = serverFn({ method: "POST" })
      .handler(async ({ user }) => {
        if (!user) throw new HttpError("Sign in first", 401); // -> {status:401,error:"Sign in first"}
        // ...
      });

A plain \`throw new Error("db creds xyz")\` stays a generic 500 (never surfaced);
only \`HttpError\` opts a message into the response. Use it for auth gates
(401/403) and user-facing validation you want the UI to display.

### Two ways to call the SAME imported function

- FROM A LOADER (server-side): just call it — a direct in-isolate call, no HTTP.
  \`env\` is supplied for you (do NOT pass it):

      // routes/guestbook.tsx
      import { recentEntries } from "../functions/guestbook.ts";
      export async function loader() {
        return { entries: await recentEntries() };
      }

- FROM AN ISLAND (browser): the SAME import becomes an RPC stub. Calling it does
  \`POST /__fn/<version>/<id>\` (or \`/__fn/draft/...\` in preview) with \`{ data }\` and
  returns the parsed result — no full-page reload:

      // components/guestbook.tsx (island)
      import { createEntry } from "../functions/guestbook.ts";
      // ...inside a submit handler:
      const { id } = await createEntry({ name, message });

  This dual behaviour is automatic: the module resolves to the real handler in the
  isolate and to a fetch stub in the browser (like how \`query()\` is server-only).
  Each serverFn has a stable id derived from its module path + export name, so warm
  isolates cache across publishes of unchanged code. serverFns must be NAMED
  exports and require file-based routing (not the \`main.*\` escape hatch).

### Security (READ THIS)

A serverFn runs SANDBOXED in the site isolate with EXACTLY the capabilities a
route loader has — \`env.GRAPHQL\` (read), \`env.RECORDS.create\` (gated by
loki.config.json \`writableModels\`), \`env.REALTIME.publish\`, \`env.FEATURES_SQL\`,
\`env.SECRETS.get\`, \`env.AUTH\`, and MEDIATED outbound \`fetch()\` (proxied + logged by
the platform). It cannot reach D1 or the Worker Loader directly, and \`env.RECORDS\`
rejects any model not in your allowlist exactly as it does from a loader. Writing
a serverFn does NOT escalate privileges beyond what your page code already has.
Outbound fetch goes through the platform (a per-site seam for future allowlists /
rate limits) — treat third-party calls as you would anywhere: put keys in
\`env.SECRETS\`, never in client-imported modules.

Your handler and validator SOURCE does NOT ship to the browser. The browser build
of a serverFn module is a synthesized stub — for each serverFn just
\`export const NAME = __lokiClientServerFn("<id>","<method>")\`, no handler body, no
validator, no \`gql\` strings, no logic. So the RPC boundary is real: the client can
only INVOKE the serverFn over \`/__fn/...\` and receive its JSON result; it cannot
read what the handler does. The capability boundary is \`env\` — what you can reach
through \`env.GRAPHQL\`/\`env.RECORDS\`/\`env.REALTIME\` is all a handler can do.
Nevertheless, secrets belong in bindings/\`env\`, NEVER hardcoded in a module that
client code imports: only serverFn modules are stubbed, so a secret placed in a
component or shared util (which IS served verbatim to the browser for hydration)
would leak. Keep secrets in \`env\`.

## Scoped record writes: env.RECORDS.create

Route actions (and loaders) can create CMS records via \`env.RECORDS\`, but ONLY
for models the site explicitly opts into. List those model api_keys in a
top-level \`loki.config.json\`:

    { "writableModels": ["guestbook_entry"] }

At publish, this file must be valid JSON and every listed model must exist, or
the publish fails. The published tree's allowlist is snapshotted with the version
(the draft's config applies in preview).

\`await env.RECORDS.create(modelApiKey, fields)\`:
- rejects models not in the allowlist -> resolves to \`{ error: "..." }\`;
- creates the record via the CMS; if the model has drafts enabled it is
  immediately PUBLISHED so published GraphQL queries see it;
- returns \`{ id }\` on success, or \`{ error }\` (CMS validation failures — e.g. a
  required field missing or a validator tripped — pass through in \`error\`).

RECORDS exposes ONLY \`create\` (no update/delete/query). There is NO rate limiting
in v1: a public write route MUST validate inputs itself and rely on model field
validators (length caps, required, format) to reject junk.

CASING TRAP (important): \`env.RECORDS.create(model, fields)\` takes **snake_case**
field api_keys — the CMS write API — while GraphQL READS expose the SAME fields in
**camelCase**. So within ONE file you routinely write \`postSlug\` in a \`gql\` query
and \`post_slug\` in the \`create\` call for the same field:

    await env.RECORDS.create("comment", { post_slug: slug, author_name: name });
    // …but the query that reads them back uses camelCase:
    gql\`query { allComments { postSlug authorName } }\`

If a create silently ignores a field or errors on an unknown one, check the case:
create = snake_case, GraphQL = camelCase.

## Realtime: env.REALTIME.publish (server) + connectChannel (client)

Push live updates to connected browsers over WebSockets.

- Server (action/loader): \`await env.REALTIME.publish(channel, message)\` —
  \`channel\` is any string, \`message\` must be JSON-serializable. It fans out to
  every browser subscribed to that channel. No history: a client that connects
  after a publish does not receive it.
- Client (inside an island only): \`connectChannel(name, onMessage)\` from
  \`loki/runtime\` opens a WebSocket to that channel (wss on https), JSON-parses
  each message into \`onMessage\`, auto-reconnects with capped backoff, and returns
  \`{ close }\` for cleanup. It THROWS if called during SSR — call it in a
  \`useEffect\`.

## Secrets (env.SECRETS) — API keys for your server code

Store third-party API keys (Stripe, OpenAI, a webhook signing secret) as
encrypted per-site secrets — NEVER hardcode them in a module. The site OWNER sets
them with the \`set_secret\` MCP tool (\`list_secrets\` / \`delete_secret\` to manage);
your server code reads them:

    // inside a serverFn handler or a route loader (server-side only):
    const key = await env.SECRETS.get("STRIPE_SECRET_KEY"); // string | null
    const names = await env.SECRETS.names();                // which are set

- Values are AES-GCM encrypted at rest and decrypt supervisor-side; the plaintext
  is handed only to YOUR site's own server code (never the browser, never another
  tenant). \`env.SECRETS\` exists only server-side (serverFn/loader/action).
- Secrets are NOT part of a version — they persist across publish/rollback and are
  shared by the draft and published isolates. Name them env-var style
  (\`STRIPE_SECRET_KEY\`).
- To wire a key: tell the owner to run \`set_secret({ name, value })\`, then read it
  with \`env.SECRETS.get(name)\`. If \`get\` returns \`null\`, the secret isn't set yet.

## Outbound HTTP (fetch external APIs)

Your server code CAN call external HTTP(S) APIs with the normal \`fetch()\` — from a
serverFn handler or a route loader/action. Every outbound request is proxied and
logged to \`site_logs\` (host, method, status, ms — blocked hosts too), so you can
audit egress with the \`site_logs\` tool; \`env.MAIL\` sends are logged there as well.
No config needed to start. Combine with \`env.SECRETS\`:

    export const charge = serverFn({ method: "POST" })
      .validator((i: any) => ({ amount: Number(i?.amount) | 0 }))
      .handler(async ({ data, env }) => {
        const key = await env.SECRETS.get("STRIPE_SECRET_KEY");
        if (!key) throw new Error("STRIPE_SECRET_KEY not set");
        const res = await fetch("https://api.stripe.com/v1/payment_intents", {
          method: "POST",
          headers: { authorization: "Bearer " + key,
                     "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ amount: String(data.amount), currency: "usd" }),
        });
        return res.json();
      });

Only HTTP(S) via \`fetch\` is mediated — raw TCP sockets are not available. Outbound
fetch is server-only; the browser build never makes these calls.

To RESTRICT egress, add an \`allowedHosts\` array to \`loki.config.json\` — requests to
any other host are blocked (403). A listed host also allows its subdomains
(\`stripe.com\` allows \`api.stripe.com\`). Omit it (or leave empty) to allow all hosts.

    { "writableModels": [...], "allowedHosts": ["api.stripe.com", "api.resend.com"] }

## Transactional email (env.MAIL)

Send email from a serverFn/loader with \`env.MAIL.send({ to, subject, html?, text? })\`
— order confirmations, notifications, etc. (Sign-in links go through the built-in
auth below, not this.) Returns \`{ ok, id? }\` or \`{ ok:false, error }\`.

    export const notify = serverFn({ method: "POST" })
      .validator((i: any) => ({ to: String(i?.to || ""), name: String(i?.name || "") }))
      .handler(async ({ data, env }) => {
        const r = await env.MAIL.send({
          to: data.to,
          subject: "Thanks for your order",
          html: \`<p>Hi \${data.name}, your order is confirmed.</p>\`,
          text: \`Hi \${data.name}, your order is confirmed.\`,
        });
        if (!r.ok) throw new Error(r.error);
        return { sent: true };
      });

Email sends from a shared \`loftur.app\` address (the platform's verified sender).
Provide \`fromName\` to set the display name and \`replyTo\` for replies. Server-only.

## End-user uploads (env.UPLOADS)

Store files a visitor uploads (avatars, images) with
\`env.UPLOADS.put(key, base64, contentType?)\` from a serverFn. It returns
\`{ ok, url }\` where \`url\` is \`/__uploads/<key>\` on your site — reference it in
markup. Reads are public; \`env.UPLOADS.delete(key)\` removes a file. Gate the write
on \`user\` (only signed-in visitors upload). Bytes cross as base64, so this is for
avatars/images, not huge files (10 MB cap).

    export const setAvatar = serverFn({ method: "POST" })
      .validator((i: any) => ({ base64: String(i?.base64 || "") }))
      .handler(async ({ data, env, user }) => {
        if (!user) throw new Error("Sign in first");
        const r = await env.UPLOADS.put(\`avatars/\${user.id}.png\`, data.base64, "image/png");
        if (!r.ok) throw new Error(r.error);
        return { url: r.url };   // e.g. "/__uploads/avatars/<id>.png"
      });

## User auth (passwordless email sign-in)

Loki has built-in passwordless auth for your site's END USERS (your visitors — NOT
the owner/editor MCP tokens). It's magic-link email: the user enters their email,
gets a one-time link, clicks it, and is signed in via a secure HttpOnly cookie. No
passwords, no schema work, no config — it's always on.

**Roles.** Each user has a \`role\` (default \`"member"\`). The owner sets roles with
the \`set_user_role\` MCP tool (and lists users with \`list_users\`); the role arrives
as \`user.role\` in every loader/serverFn, so you can gate admin pages or tiers:
\`if (user?.role !== "admin") return { redirect: "/" }\`. Roles are free-form strings.
For richer PROFILES (name, avatar, plan), store a feature-DB row keyed by \`user.id\`.

**Reading the signed-in user.** Every loader / action / serverFn receives \`user\`:
\`{ id, email, role }\` when signed in, or \`null\`. Gate content on it:

    // routes/members.tsx — a members-only page
    import { requireUser } from "loki/runtime";
    export async function loader({ user }) {
      return requireUser(user) || { user };   // 303 -> /login when signed out
    }
    export default function Members({ user }) {
      return <main><h1>Welcome, {user.email}</h1></main>;
    }
    // admin page: requireRole(user, "admin") gates to "/" for non-admins.

A loader that returns \`{ redirect: "/path" }\` (or a \`Response\`, e.g.
\`Response.redirect(url, 303)\`) performs a real 303 redirect BEFORE the component
renders — so the gate above never leaks the members-only markup. Any other object
is passed to the component as props. (You can also gate a write in a serverFn and
\`throw new HttpError("Sign in first", 401)\`.)

**Sending the sign-in link.** Call \`env.AUTH.requestMagicLink(email, redirectTo?)\`
from a serverFn or action. It emails the user a link that returns them to
\`redirectTo\` (a same-origin path, default \`/\`) signed in:

    // functions/auth.ts
    import { serverFn } from "loki/runtime";
    export const login = serverFn({ method: "POST" })
      .validator((i: any) => ({ email: String(i?.email || "").trim() }))
      .handler(async ({ data, env }) => {
        const r = await env.AUTH.requestMagicLink(data.email, "/members");
        if (!r.ok) throw new Error(r.error || "Could not send link");
        return { sent: true };        // tell the UI to say "check your email"
      });

**Signing out.** Link to \`/__auth/logout\` (optionally \`?redirect=/\`) — it clears
the session cookie and redirects. No code needed.

**How it works (so you don't reinvent it).**
- \`env.AUTH.requestMagicLink\` signs a short-lived (15 min) token and emails a
  \`/__auth/verify?token=...\` link (via Cloudflare Email, from a loftur.app address).
- Clicking it verifies the token, records the user, and sets an HttpOnly, Secure,
  \`SameSite=Lax\` session cookie (\`loki_session\`, 30 days). The session is a signed
  stateless token — the signing key stays on the platform; your code can't forge
  it and never sees it. You only ever read the already-verified \`user\`.
- Users are recorded per-site; you don't manage a users table. To attach a PROFILE
  (name, avatar, plan), key a feature-DB row by \`user.id\` (see "Feature database").
- \`user\` is delivered to your code as a trusted request header the platform sets
  after verifying the cookie — do NOT trust any client-sent user data; use \`user\`.

Build a login page with a form that calls \`login\` (island → serverFn RPC, or a
route \`action\`), then a members area whose loader checks \`user\`. That's the whole
pattern.

## Package dependencies (npm imports — no install, no bundler, no allowlist)

You can \`import\` from ANY real npm package — there is no curated list. There is
NO \`npm install\` and NO bundler step: when you \`site_write\` a file, Loki (which
has network) RESOLVES each bare import via esm.sh in the supervisor, crawls the
module graph, SNAPSHOTS a self-contained, version-pinned copy into R2, and then
TEST-LOADS that snapshot in a throwaway workerd isolate to see whether it actually
links + runs here. \`site_write\` returns a \`resolvedDeps\` block —
\`[{ specifier, version, files, bytes, loadable }]\` — so you see exactly what got
pinned. The pin is recorded per draft and snapshotted into the published version,
so preview / publish / rollback all serve byte-identical dependency code
(reproducible; no drift). Resolving a NEW or large package the FIRST time takes a
few seconds (crawl + store + test-load); re-importing an already-resolved package
is instant.

Loki decides support EMPIRICALLY, not from a name list. Supported means: pure
ESM + workerd-compatible + no Node builtins. Concretely, a package is accepted iff
its snapshot links and executes in the test-load; otherwise \`site_write\` REJECTS
the import (the draft tree never holds an unusable dependency — same ethos as
write-time gql validation) with a specific reason:
- NOT FOUND — \`package "<spec>" not found on esm.sh\` (check the name/subpath).
- NOT WORKERD-COMPATIBLE — e.g. \`imports "node:fs", a Node builtin that isn't
  available in workerd\`. The site isolate has NO \`nodejs_compat\`; a package that
  needs \`node:fs\` / \`node:net\` / the real \`node:crypto\` module (etc.) can't load
  here. (esm.sh's pure-JS polyfills like Buffer DO link; a polyfill that itself
  pulls a \`node:\` builtin does not — and that surfaces as this same rejection.)
- TOO LARGE — a package whose crawled module set is too big to snapshot is
  rejected with its file/byte count.

Other constraints on what a dep can DO once loaded:
- Outbound network IS available (server-side), but MEDIATED: a package's \`fetch()\`
  to an external host is proxied + logged by the platform. So an SDK that calls an
  HTTP API (Stripe, etc.) works from a serverFn/loader; give it its key via
  \`env.SECRETS\`. (Raw TCP / non-HTTP sockets are still not available.)
- Deps imported inside a serverFn module are SERVER-ONLY: serverFn modules are
  stubbed in the browser build, so the dependency code is NEVER shipped to the
  client. (This is exactly why the feature-DB \`drizzle\` import below is
  zero-cost on the client.)

## Feature database (Drizzle over sqlite-proxy)

Loki gives serverFns a separate SQL FEATURE DATABASE (SQLite/D1), distinct from
the CMS content. Query it with drizzle-orm via the \`featuresDriver(env)\` helper —
no raw SQL, no driver boilerplate:

    // functions/signups.ts  (a serverFn module — server-only)
    import { drizzle } from "drizzle-orm/sqlite-proxy";
    import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
    import { featuresDriver, serverFn } from "loki/runtime";

    // MUST match the existing table — Loki does NOT create it (see below).
    const signups = sqliteTable("signups", {
      id: integer("id").primaryKey(),
      email: text("email").notNull(),
      // created_at is DB-defaulted — OMITTED here so drizzle never inserts NULL.
    });

    export const addSignup = serverFn({ method: "POST" })
      .validator((i: any) => ({ email: String(i?.email || "").trim().slice(0, 200) }))
      .handler(async ({ data, env }): Promise<{ ok: true }> => {
        const db = drizzle(featuresDriver(env), { schema: { signups } });
        await db.insert(signups).values({ email: data.email });
        return { ok: true };
      });

    export const listSignups = serverFn()
      .handler(async ({ env }): Promise<{ id: number; email: string }[]> => {
        const db = drizzle(featuresDriver(env), { schema: { signups } });
        return db.select().from(signups).all();   // .get() for a single row
      });

### Designing the feature schema (feature_migrate)

You OWN this database — create and evolve its tables at runtime with three tools:
- \`feature_migrate({ name, up })\` — apply ONE named, versioned migration. \`name\`
  is a stable id (e.g. \`0001_create_signups\`); \`up\` is SQL (CREATE TABLE / ALTER
  TABLE / CREATE INDEX; \`;\`-separate multiple statements). IDEMPOTENT — a name
  already applied is skipped, so re-running is safe. Returns the resulting schema.
- \`feature_schema()\` — show the current tables + columns. Read it before writing
  queries so your drizzle table defs match.
- \`feature_query({ sql, params?, write? })\` — run one SQL statement for INSPECTION
  or SEEDING (reads → { columns, rows }; \`write:true\` for INSERT/UPDATE/DELETE).
  NOT the request hot path — your app code uses drizzle over \`env.FEATURES_SQL\`.

    feature_migrate({ name: "0001_signups",
      up: "CREATE TABLE signups (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)" })

Each site's feature DB is FULLY ISOLATED (its own SQLite). Types: INTEGER, TEXT,
REAL, BLOB. GOTCHA: for a timestamp default use \`DEFAULT CURRENT_TIMESTAMP\`, NOT
\`DEFAULT (datetime('now'))\` — the latter is a non-constant default and is rejected.

CRITICAL — read before using:
- (a) CREATE TABLES with \`feature_migrate\` FIRST, then query them with drizzle.
  Call \`feature_schema()\` to confirm the columns your drizzle table defs must match.
- (b) OMIT DB-DEFAULTED COLUMNS (like \`created_at TEXT DEFAULT ...\`) from your
  drizzle table, OR give them \`.default(...)\`. If you declare such a column with
  no default and don't set it on insert, drizzle inserts an explicit \`NULL\`,
  which violates a \`NOT NULL\` / breaks the DB default. Only model the columns you
  actually read/write.
- (c) SERVER-ONLY. \`featuresDriver(env)\` works only inside a serverFn handler or a
  route loader (it reads \`env\`); the browser build throws. Construct \`drizzle(...)\`
  inside the handler — never at module top level (no \`env\` there).
- (d) RAW SQL / RAW DB IS INTENTIONALLY NOT EXPOSED. There is no \`env.FEATURES_DB\`
  and no query-string API. Everything goes through drizzle over the mediated
  \`sqlite-proxy\` RPC — that RPC IS the isolation boundary (a raw D1 handle can't
  cross into the isolate). Use drizzle's query builder; that is the whole surface.

The \`featuresDriver(env)\` returns the async callback drizzle's sqlite-proxy driver
expects and handles the positional row-shape mapping for you — \`.get()\` yields one
row, \`.all()\`/\`.select()\` yield rows, inserts/updates \`.run()\` — so columns map
correctly with no manual plumbing.

## Imports available

- \`preact\`, \`preact/hooks\`, \`preact/jsx-runtime\` (JSX is auto-configured for preact).
- \`preact-render-to-string\` (rendering is handled for you; rarely needed directly).
- \`loki/runtime\` -> \`gql\` (tag GraphQL documents), \`query(env, document, variables)\`
  (runs a GraphQL query against the CMS; drafts are visible in preview mode),
  \`renderStructuredText(value)\` (renders a Structured Text DAST value to Preact vnodes),
  \`Island\` (the client-hydration helper — see "Islands" below),
  \`serverFn({...}).validator(...).handler(...)\` (a typed, validated server function
  callable from a loader OR a browser island — see "Server functions" below),
  \`featuresDriver(env)\` (drizzle sqlite-proxy driver for the feature DB, server-only —
  see "Feature database" above),
  \`HttpError\` (throw \`new HttpError(message, status)\` from a serverFn/action to send
  that status + message to the caller — see "Server functions"),
  \`requireUser(user, to?)\` / \`requireRole(user, role, to?)\` (loader/action auth
  gates — return the sentinel or null: \`return requireUser(user) || { user }\`), and
  \`connectChannel(name, onMessage)\` (client-only realtime subscription — see
  "Realtime" below).
- ANY npm package (no allowlist): resolved via esm.sh at write time and
  test-loaded for workerd-compatibility — see "Package dependencies" above.
  \`drizzle-orm\` (used by the feature DB below) is one example.
- \`loki/schema\` (TYPE IMPORTS ONLY) -> content types generated from the live
  schema: \`import type { BlogPostRecord, Query } from "loki/schema"\`. See "Typed
  content" below; read the exact shapes with the \`schema_types\` tool.
- Relative imports between your own files must include the extension, e.g.
  \`import { Layout } from "./components/layout.tsx"\`.

Do NOT rely on \`process\` or Node built-ins — the site runs in an isolated worker
(no \`nodejs_compat\`) whose capabilities are the \`env\` bindings (GRAPHQL / RECORDS /
REALTIME / FEATURES_SQL via \`featuresDriver\`, SECRETS, AUTH) plus MEDIATED outbound
\`fetch()\`. Imported npm packages must be pure-ESM + workerd-compatible (see
"Package dependencies").

## Typed content (schema_types + loki/schema)

Your content has a real, live-generated TypeScript type for every model. Use it —
you have no IDE hover, so reading the types is how you know the exact field names
and shapes you're coding against.

1. Run the \`schema_types\` MCP tool FIRST. It returns TypeScript generated from the
   LIVE schema: one interface per record type (e.g. \`BlogPostRecord\`,
   \`GuestbookEntryRecord\`), the \`Query\` root (\`allBlogPosts\` / \`blogPost\` /
   \`_allBlogPostsMeta\` return shapes, each field's args in a JSDoc comment), the
   \`*OrderBy\` and \`ItemStatus\` enums, and the filter input types. Nullability
   (\`| null\`), lists (\`T[]\`), nested linked records, and Structured Text
   (\`{ value, blocks, inlineBlocks, links }\`) are all rendered faithfully.
2. Annotate loaders and props with \`import type\` from \`loki/schema\` — the SAME
   types:

       import type { BlogPostRecord, Query } from "loki/schema";
       export async function loader({ env }): Promise<{ posts: BlogPostRecord[] }> { … }
       export default function Home({ posts }: { posts: BlogPostRecord[] }) { … }

   \`loki/schema\` is TYPES-ONLY: \`import type\` (and any import used only in type
   positions) is erased at transpile, so it adds NO runtime import. Using one of
   its names as a runtime VALUE fails the write with a clear message — keep it to
   \`import type\`.
3. Every \`gql\`\`...\`\`\` document is validated against the live schema at WRITE time:
   \`site_write\` returns a \`graphqlErrors\` block (precise messages, e.g.
   \`Cannot query field "x" on type "BlogPostRecord". Did you mean "y"?\`) the moment
   you save. Those errors are NON-FATAL (the file is still written, so you can
   scaffold a component before its query is done) — but \`publish_site\` HARD-GATES
   on the same validation, so fix them before publishing.

## Example: routes/posts/[slug].tsx

The CMS schema is DatoCMS-style: singular record fields take a \`filter\`, and
Structured Text fields expose \`{ value, blocks, inlineBlocks, links }\` — there is
NO pre-rendered \`bodyHtml\`. Query \`body { value }\` (the DAST JSON) and render it
with \`renderStructuredText\`. (Explore the exact fields first with the
\`graphql_query\` MCP tool — introspection is allowed.)

    import { gql, query, renderStructuredText } from "loki/runtime";
    import type { BlogPostRecord } from "loki/schema";

    const POST = gql\`
      query Post($slug: String!) {
        blogPost(filter: { slug: { eq: $slug } }) {
          title
          body {
            value
          }
        }
      }
    \`;

    // Type the loader's return so props are checked against the real schema.
    export async function loader({ env, params }): Promise<{ post: BlogPostRecord | null }> {
      const data = await query(env, POST, { slug: params.slug });
      return { post: data.blogPost };
    }

    export const head = (props: { post: BlogPostRecord | null }) =>
      ({ title: props.post?.title ?? "Post" });

    export default function Post({ post }: { post: BlogPostRecord | null }) {
      if (!post) return <main><h1>Not found</h1></main>;
      return (
        <main class="post">
          <h1>{post.title}</h1>
          <div class="body">{renderStructuredText(post.body?.value)}</div>
        </main>
      );
    }

    // \`BlogPostRecord\` (and Query, filter/orderBy types) come from the live schema —
    // run \`schema_types\` to read the exact fields. \`import type\` is erased at
    // transpile, so it adds no runtime import.

## Islands (client-side interactivity)

The site is SSR by default — server components + a route \`loader\` are the RIGHT
tool for almost everything (data fetching, layout, content). Reach for an island
ONLY when a piece of UI needs to run in the browser (local state, event handlers,
timers). Everything else should stay server-rendered.

An island is a normal component file (e.g. \`components/counter.tsx\`) that you drop
into a page with the \`Island\` helper. It is server-rendered for first paint AND
hydrated in the browser, so \`useState\`/\`useEffect\`/\`useRef\` (from \`preact/hooks\`)
and event handlers work. The SAME file is imported server-side (for SSR) and
served to the browser (for hydration) — no separate client bundle.

    // components/counter.tsx
    import { useState } from "preact/hooks";
    export default function Counter({ initial = 0 }) {
      const [n, setN] = useState(initial);
      return (
        <div class="counter">
          <button onClick={() => setN(n - 1)}>-</button>
          <output>{n}</output>
          <button onClick={() => setN(n + 1)}>+</button>
        </div>
      );
    }

    // routes/index.tsx
    import { Island } from "loki/runtime";
    export default function Home() {
      return (
        <main>
          <h1>Welcome</h1>
          <Island src="components/counter.tsx" client="load" initial={5} />
        </main>
      );
    }

\`Island\` props:
- \`src\` (required) — path of the component file in the site tree, e.g.
  \`"components/counter.tsx"\` (extension recommended).
- \`client\` — WHEN to hydrate: \`"load"\` (default, immediately), \`"idle"\`
  (requestIdleCallback), or \`"visible"\` (IntersectionObserver — hydrates as soon
  as the island enters the viewport, i.e. immediately if it is already on-screen
  at load, else on scroll into view). Prefer \`idle\`/\`visible\` for below-the-fold
  widgets.
- everything else is passed to the component as props. Props MUST be
  JSON-serializable (strings, numbers, booleans, null, arrays, plain objects) —
  they are serialized at SSR and re-parsed to hydrate. Passing a function or
  BigInt throws a clear error at render time. Islands do not receive children.

Rules & notes:
- Data is a SERVER concern: call \`query()\` in a route \`loader\` and pass the
  result into the island as props. \`query()\` is server-only and THROWS in the
  browser. Islands must not fetch from the CMS directly.
- Loki injects an import map + a tiny hydration script into the page \`<head>\`
  automatically, only when a page actually uses an island.
- Islands require file-based routing (they don't work under a \`main.*\` escape
  hatch).

## Worked example: live guestbook (serverFn + RECORDS + REALTIME + island)

The canonical pattern. A shared \`functions/\` module defines a typed POST serverFn
(validate -> create record -> publish to a channel); the route loader reads via a
GET serverFn; the form island calls the POST serverFn on submit (RPC — no reload)
and subscribes to the channel to append everyone's entries live.

    // loki.config.json
    { "writableModels": ["guestbook_entry"] }

    // functions/guestbook.ts — shared by the loader (server) and island (browser)
    import { gql, query, serverFn } from "loki/runtime";
    import type { GuestbookEntryRecord } from "loki/schema";

    const ENTRIES = gql\`
      query { allGuestbookEntries(orderBy: _createdAt_DESC, first: 50) { id name message } }
    \`;

    export const recentEntries = serverFn()
      .handler(async ({ env }): Promise<GuestbookEntryRecord[]> => {
        const data = await query(env, ENTRIES);
        return data.allGuestbookEntries;
      });

    export const createEntry = serverFn({ method: "POST" })
      .validator((input) => {
        const name = String(input.name || "").trim().slice(0, 80);
        const message = String(input.message || "").trim().slice(0, 500);
        if (!name || !message) throw new Error("name and message are required");
        return { name, message };
      })
      .handler(async ({ data, env }): Promise<{ id: string } & typeof data> => {
        const created = await env.RECORDS.create("guestbook_entry", data);
        if (created.error) throw new Error(created.error);
        await env.REALTIME.publish("guestbook", { id: created.id, ...data });
        return { id: created.id, ...data };
      });

    // routes/guestbook.tsx — loader calls the GET serverFn DIRECTLY (in-isolate)
    import { Island } from "loki/runtime";
    import { recentEntries } from "../functions/guestbook.ts";
    export async function loader() {
      return { entries: await recentEntries() };
    }
    export default function Guestbook({ entries }) {
      return <Island src="components/guestbook.tsx" client="load" entries={entries} />;
    }

    // components/guestbook.tsx — island: calls the POST serverFn over RPC on submit
    import { useState, useEffect } from "preact/hooks";
    import { connectChannel } from "loki/runtime";
    import { createEntry } from "../functions/guestbook.ts";
    export default function Guestbook({ entries }) {
      const [items, setItems] = useState(entries || []);
      useEffect(() => {
        const ch = connectChannel("guestbook", (e) => setItems((cur) => [e, ...cur]));
        return () => ch.close();
      }, []);
      async function onSubmit(ev) {
        ev.preventDefault();
        const f = ev.currentTarget;
        try {
          // RPC to the isolate; the channel echo appends it for us.
          await createEntry({ name: f.name.value, message: f.message.value });
          f.reset();
        } catch (err) { alert(String(err.message || err)); }
      }
      return (
        <section>
          <form onSubmit={onSubmit}>
            <input name="name" required maxLength={80} />
            <input name="message" required maxLength={500} />
            <button>Sign</button>
          </form>
          <ul>{items.map((e) => <li key={e.id}><b>{e.name}</b>: {e.message}</li>)}</ul>
        </section>
      );
    }

The poster's own submit updates the list via the channel echo (no reload); OTHER
open browsers get it live over the same channel. \`createEntry\` runs the SAME
validated handler whether reached from a loader or this island — the browser build
just turns the call into an RPC. (A raw route \`action\` still works as the escape
hatch when you need a redirect or a non-JSON \`Response\`.)

## styles.css example

    body { font-family: system-ui, sans-serif; max-width: 42rem; margin: 2rem auto; }

## Assets (favicons, images, fonts, downloads) — "it's just a file"

Static/design files live under \`public/\` and serve at the site ROOT. There is
exactly ONE rule:

    public/favicon.ico      ->  /favicon.ico
    public/img/hero.jpg     ->  /img/hero.jpg
    public/files/brochure.pdf -> /files/brochure.pdf

Two tools mirror site_write; BOTH require a \`public/…\` path and BOTH return JSON
\`{ path, url, hash, size, contentType }\` where **\`url\` is the exact string to
paste into markup/CSS** (already root-mapped — do NOT prefix it with \`public/\`):

- \`site_asset_import({ path, url })\` — Loki fetches the URL (it has network
  access; your site worker does not) and stores the bytes. Use for anything but
  tiny files (photos, og-images, downloads).
- \`site_asset_write({ path, base64, contentType? })\` — decode base64 bytes.
  For SMALL files only (favicon, inline SVG); ~2 MB cap, over which it errors and
  tells you to use site_asset_import. \`contentType\` is inferred from the
  extension if omitted (common web/text/font types are known, incl. \`.svg\`,
  \`.json\`, \`.md\`, \`.txt\`, \`.csv\`, \`.xml\`, \`.webmanifest\`, \`.woff2\`). If the
  extension is unknown the result carries \`contentTypeInferred: false\` + a \`note\`
  — pass an explicit \`contentType\` in that case.

Assets are DRAFT until you publish, and they version / preview / rollback exactly
like code: preview shows the draft manifest (no-store), the published site serves
the version's snapshot (ETag = content hash, \`Cache-Control: public, max-age=300,
must-revalidate\`), and rollback_site restores that version's asset set (a rollback
to before an asset was added makes it 404 — assets are version-pinned).

RESERVED — a \`public/\` path whose root URL is one of these is rejected (Loki/CMS
own them): /mcp, /graphql, /api/*, /assets/*, /uploads/*, /health, /paths/*,
/openapi.json, and /__* (/__vendor, /__modules, /__preview, /__realtime).
(\`/assets/*\` and \`/uploads/*\` are the CMS *content* asset routes — different from
these site files.)

### Worked example: favicon + og-image + CSS hero + a download

    // 1) favicon — tiny, so write it inline as base64 (or import a URL):
    site_asset_write({
      path: "public/favicon.ico",
      base64: "<base64 bytes>",           // data: URL prefix is tolerated
    })
    // -> { "url": "/favicon.ico", "hash": "…", "size": 1150, "contentType": "image/x-icon" }

    // 2) og-image — import a real image by URL:
    site_asset_import({ path: "public/og.png", url: "https://example.com/og.png" })
    // -> { "url": "/og.png", … }

    // 3) hero photo used from CSS:
    site_asset_import({ path: "public/img/hero.jpg", url: "https://example.com/hero.jpg" })
    // -> { "url": "/img/hero.jpg", … }

    // 4) a downloadable PDF:
    site_asset_import({ path: "public/files/brochure.pdf", url: "https://example.com/brochure.pdf" })
    // -> { "url": "/files/brochure.pdf", … }

Reference the returned \`url\` strings verbatim. Set the favicon + a default
og-image ONCE in \`app.tsx\` (global head) so every route inherits them:

    // app.tsx — site-wide head (favicon + default OG), merged under every page
    export const head = {
      links: [{ rel: "icon", href: "/favicon.ico" }],
      meta: [{ property: "og:image", content: "/og.png" }],
    };

A route only needs a \`head\` to override — e.g. its own title or og:image:

    // routes/index.tsx — favicon + default og:image come from app.tsx
    export const head = {
      title: "Home",
      // meta: [{ property: "og:image", content: "/og-home.png" }], // page override
    };
    export default function Home() {
      return (
        <main class="hero">
          <h1>Welcome</h1>
          <a href="/files/brochure.pdf" download>Download the brochure (PDF)</a>
        </main>
      );
    }

    /* styles.css — hero background from the imported image */
    .hero { background: url(/img/hero.jpg) center / cover no-repeat; min-height: 60vh; }

Then \`publish_site\` — it snapshots the asset manifest into the version and warns
(non-fatal) about any \`/foo.ext\` reference in your code that has no matching
\`public/foo.ext\` asset. \`site_list\` shows assets alongside code; \`site_read\` on a
\`public/…\` path returns metadata (not bytes); \`site_delete\` removes an asset;
\`site_diff\` shows added/changed/removed assets (compared by content hash).

## GraphQL notes

- Prototype queries with the \`graphql_query\` MCP tool before wiring them into a
  route: \`graphql_query({ query, variables?, includeDrafts? })\` runs against the
  live schema and returns \`{ data, errors }\`. Introspection is allowed, so you can
  discover the exact model and field names first.
- Naming is DatoCMS-style: collections are pluralised (\`allBlogPosts\`), single
  records are singular with a \`filter\` (\`blogPost(filter: { slug: { eq: $slug } })\`),
  and record types are \`...Record\` (\`BlogPostRecord\`). Structured Text fields expose
  \`{ value, blocks, inlineBlocks, links }\`; render \`value\` with \`renderStructuredText\`.
- Tag every query with \`gql\` (or put it in a \`.graphql\` file). At publish, ALL
  documents are validated against the live CMS schema — unknown fields/types fail
  the publish with per-document errors.
- Keep gql documents self-contained: \`\${...}\` interpolations are stripped before
  validation, so inline fragments/variables rather than interpolating query text.
- The published version records a "footprint" of the (Type.field) pairs it uses.
  This powers the migration guard: deleting a field/model the live site depends on
  is rejected. The safe schema-change order is:
  expand (add new field) -> backfill content -> publish the site using it ->
  contract (remove the old field).

## Localized content (i18n)

Content is localized out of the box (DatoCMS-style). Every collection/record field
and every localized content field takes a \`locale: SiteLocale\` argument (plus
\`fallbackLocales: [SiteLocale!]\`), and each record exposes \`_locales\`. So you don't
need any special setup — just pass the locale in your query:

    const POST = gql\`
      query Post($slug: String!, $locale: SiteLocale) {
        blogPost(filter: { slug: { eq: $slug } }, locale: $locale, fallbackLocales: [en]) {
          title
          body { value }
        }
      }
    \`;
    export async function loader({ env, params }) {
      const data = await query(env, POST, { slug: params.slug, locale: params.lang });
      return { post: data.blogPost };
    }

Drive it from the URL with a language route param — \`routes/[lang]/posts/[slug].tsx\`
maps to \`/:lang/posts/:slug\`, so \`params.lang\` is the locale. \`SiteLocale\` is an
enum; introspect it (\`graphql_query\` with \`{ __type(name:"SiteLocale"){ enumValues{ name } } }\`)
or read \`schema_types\` to see which locales exist. Per-field all-locale values are
available as \`_allXLocales\`. Manage locales/translations with the content (editor) tools.

## Shell (edit the working tree like a repo folder)

The \`shell\` tool gives you a real in-process bash over the site's WORKING TREE —
the draft. It's the fast way to navigate and text-edit code across many files
without round-tripping each one through site_read/site_write.

Working-copy model:
- \`shell\` edits MUTATE THE DRAFT LIVE. The draft is the persistent working copy
  between calls — each command sees the previous command's edits.
- \`preview_site\` renders the CURRENT draft (so a shell edit shows up on the next
  preview load, no re-mint needed).
- \`publish_site\` COMMITS the draft to a new immutable version.
- \`reset_site\` DISCARDS the whole draft back to the published version (\`git
  checkout .\`).

Reads/writes:
- READS come from the live draft: code files are their real source; binary assets
  under \`public/\` show up as opaque EMPTY placeholders (their bytes aren't in the
  shell — use the asset tools / site_read for those).
- WRITES route through the SAME pipeline as site_write: a \`sed -i\` / \`echo >\` /
  redirect on a .tsx is transpiled, gql-validated, and its imports dep-resolved.
  \`shell\` returns \`changedFiles\` and \`warnings\` (transpile / serverFn / dependency
  / graphql issues from those writes). A write whose TSX fails to transpile still
  LANDS (so \`cat\` reads it back) but is flagged and BLOCKS publish_site until fixed.

Supported utilities (text-processing + navigation): \`grep\`/\`rg\`/\`egrep\`,
\`sed\`, \`awk\`, \`cut\`, \`tr\`, \`sort\`, \`uniq\`, \`nl\`, \`rev\`, \`fold\`,
\`head\`, \`tail\`, \`wc\`, \`cat\`, \`tac\`, \`ls\`, \`find\`, \`tree\`, \`stat\`,
\`diff\`, \`comm\`, \`paste\`, \`join\`, \`jq\`, \`yq\`, \`xan\`, \`basename\`,
\`dirname\`, \`cp\`, \`mv\`, \`rm\`, \`mkdir\`, \`touch\`, \`ln\`, \`tee\`,
\`xargs\`, \`echo\`, \`printf\`, \`seq\`, \`base64\`, \`md5sum\`/\`sha256sum\`,
plus pipes, redirections (\`>\`, \`>>\`, \`2>&1\`), \`&&\`/\`||\`/\`;\`, globs,
\`$VAR\`, and \`for\`/\`while\`/\`if\`/functions.

HERMETIC — FAKE TOOLCHAIN (important): this is NOT a dev box. There is NO real
\`git\`, \`tsc\`, \`node\`, \`npm\`, \`drizzle-kit\`, or network — text utilities
only (\`grep\`/\`sed\`/\`awk\` yes; real binaries no). Don't try to "run" or
"typecheck" the site here. To check types/gql, let the write pipeline +
\`publish_site\` validate; for content use \`graphql_query\`; for record/feature-DB
work use serverFns.

Worked example — recolor an accent, preview, publish:

    shell({ command: "grep -rn 'accent' styles.css" })      # locate the style
    # -> 12:  --accent: #3b82f6;  /* brand accent */
    shell({ command: "sed -i 's/#3b82f6/#e11d48/' styles.css" })
    # -> changedFiles: styles.css
    shell({ command: "grep -n e11d48 styles.css" })         # confirm it landed
    preview_site()                                          # open the URL: new accent
    publish_site("recolor accent to rose")                  # commit
    # (or reset_site() to throw the change away)

## Workflow

0. schema_types()                          -> read the content types before querying
1. site_write("routes/index.tsx", "...")   (file contents go in \`source\`; \`content\`
   is accepted as an alias. transpiled + gql validated; errors returned)
2. preview_site()                          -> open the returned URL to see the DRAFT
3. site_check()                            -> non-destructive preflight ("green means
   green"): transpile + gql-vs-live-schema + config + smoke-render + node:/route
   checks. If it PASSES, publish won't fail for a knowable reason.
4. publish_site("message")                 -> validates + smoke-renders + snapshots
5. rollback_site(versionId) / site_versions() as needed

## Previewing without a browser

\`preview_site\` returns a \`/__preview?token=...\` URL. It sets an HttpOnly cookie
named \`loki_preview\` (Path=/, Max-Age=1800, SameSite=Lax) and 302-redirects to /.
For non-browser clients use a cookie jar:

    curl -sc jar "<preview_url>" -o /dev/null      # step 1: capture loki_preview cookie
    curl -sb jar "<origin>/posts/my-post"          # step 2: draft HTML, reusing the jar

The token is valid for 30 minutes and is tied to that window, NOT to the draft
contents. After further site_write edits, DO NOT mint a new token — just re-request
the path with the same jar; the draft tree is rebuilt on every request. Only call
preview_site again once the 30-minute token has expired.

Other tools: graphql_query({query, variables?, includeDrafts?}) (explore the content
API / introspection), site_read(path), site_list(), site_delete(path), site_diff()
(shows added/removed/changed paths vs the published version), and the asset tools
site_asset_import({path, url}) / site_asset_write({path, base64, contentType?}) —
see the "Assets" section above.`;
