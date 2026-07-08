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
- \`loader({ env, params, request })\` -> returns props (may be async; runs on the server).
- \`head\` -> an object \`{ title, meta: [{name, content}], links: [{rel, href}] }\`,
  or a function \`(props) => head\`.

The component receives \`{ ...loaderProps, params }\`.

## Imports available

- \`preact\`, \`preact/hooks\`, \`preact/jsx-runtime\` (JSX is auto-configured for preact).
- \`preact-render-to-string\` (rendering is handled for you; rarely needed directly).
- \`loki/runtime\` -> \`gql\` (tag GraphQL documents), \`query(env, document, variables)\`
  (runs a GraphQL query against the CMS; drafts are visible in preview mode),
  \`renderStructuredText(value)\` (renders a Structured Text DAST value to Preact vnodes),
  and \`Island\` (the client-hydration helper — see "Islands" below).
- Relative imports between your own files must include the extension, e.g.
  \`import { Layout } from "./components/layout.tsx"\`.

Do NOT rely on network access, \`process\`, or Node built-ins — the site runs in an
isolated worker with no outbound fetch except the GraphQL binding.

## Example: routes/posts/[slug].tsx

The CMS schema is DatoCMS-style: singular record fields take a \`filter\`, and
Structured Text fields expose \`{ value, blocks, inlineBlocks, links }\` — there is
NO pre-rendered \`bodyHtml\`. Query \`body { value }\` (the DAST JSON) and render it
with \`renderStructuredText\`. (Explore the exact fields first with the
\`graphql_query\` MCP tool — introspection is allowed.)

    import { gql, query, renderStructuredText } from "loki/runtime";

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

    export async function loader({ env, params }) {
      const data = await query(env, POST, { slug: params.slug });
      return { post: data.blogPost };
    }

    export const head = (props) => ({ title: props.post?.title ?? "Post" });

    export default function Post({ post }) {
      if (!post) return <main><h1>Not found</h1></main>;
      return (
        <main class="post">
          <h1>{post.title}</h1>
          <div class="body">{renderStructuredText(post.body?.value)}</div>
        </main>
      );
    }

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
  (requestIdleCallback), or \`"visible"\` (on first scroll into view). Prefer
  \`idle\`/\`visible\` for below-the-fold widgets.
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

## styles.css example

    body { font-family: system-ui, sans-serif; max-width: 42rem; margin: 2rem auto; }

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

## Workflow

1. site_write("routes/index.tsx", "...")   (transpiled immediately; errors returned)
2. preview_site()                          -> open the returned URL to see the DRAFT
3. publish_site("message")                 -> validates + smoke-renders + snapshots
4. rollback_site(versionId) / site_versions() as needed

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
(shows added/removed/changed paths vs the published version).`;
