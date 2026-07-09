// The `loki/runtime` module injected into every dynamic-site module map (server
// form) and served to the browser (client form) for island hydration.
//
// Both forms are authored as plain-JS strings (already "transpiled") and share
// the `gql` tag + `renderStructuredText` DAST renderer so the SAME component
// file works whether it is imported server-side (SSR) or as a hydrated island.
//
// - RUNTIME_MODULE (server): injected into the isolate module map. Imports
//   `preact` and `preact-render-to-string` (both vendored into the same map).
//   Exposes `gql`, `query`, `renderStructuredText`, the file router
//   (`handleRequest`) and the `Island` SSR helper.
// - CLIENT_RUNTIME_MODULE (browser): served at `/__vendor/<ver>/loki-runtime.js`
//   and resolved via the page import map. Imports only `preact`. `query()`
//   throws (server-only); `renderToString`/`Island`/`handleRequest` throw too,
//   so a component module that imports them still LOADS in the browser and only
//   fails if a server-only API is actually called at runtime.

// --- island hydration bootstrap (inlined into the page <head> when needed) ----
// Dependency-free beyond `preact` (imported dynamically, resolved by the page's
// import map). Finds every <loki-island> marker and hydrates per its directive.
const ISLAND_BOOTSTRAP = `(function(){
  var hydrateOne = function(el){
    var src = el.getAttribute("data-loki-src");
    var props;
    try { props = JSON.parse(el.getAttribute("data-loki-props") || "{}"); }
    catch (e) { props = {}; }
    Promise.all([import("preact"), import(src)]).then(function(mods){
      var preact = mods[0];
      var mod = mods[1];
      var Component = mod && (mod.default || mod);
      if (typeof Component === "function") {
        preact.hydrate(preact.h(Component, props), el);
      } else {
        console.error("[loki island] " + src + " has no default export");
      }
    }).catch(function(err){
      console.error("[loki island] hydration failed for " + src, err);
    });
  };
  // The <loki-island> wrapper is rendered with display:contents, so it generates
  // NO layout box of its own. An IntersectionObserver targeting it would never
  // report an intersection (a box-less element is treated as never visible), so
  // "visible" islands would silently never hydrate. Find the first descendant
  // element that actually has a box and observe THAT instead. Returns null if
  // the whole subtree is box-less (empty / all display:contents), in which case
  // the caller hydrates immediately rather than never.
  var firstObservable = function(el){
    var r = el.getBoundingClientRect();
    if (r.width > 0 || r.height > 0) return el;
    var kids = el.querySelectorAll("*");
    for (var k = 0; k < kids.length; k++) {
      var kr = kids[k].getBoundingClientRect();
      if (kr.width > 0 || kr.height > 0) return kids[k];
    }
    return null;
  };
  var els = document.querySelectorAll("loki-island[data-loki-src]");
  for (var i = 0; i < els.length; i++) {
    (function(el){
      var client = el.getAttribute("data-loki-client") || "load";
      if (client === "idle") {
        (window.requestIdleCallback || function(f){ return setTimeout(f, 1); })(function(){ hydrateOne(el); });
      } else if (client === "visible" && "IntersectionObserver" in window) {
        var target = firstObservable(el);
        if (!target) { hydrateOne(el); return; }
        var io = new IntersectionObserver(function(entries, obs){
          for (var j = 0; j < entries.length; j++) {
            if (entries[j].isIntersecting) { obs.disconnect(); hydrateOne(el); return; }
          }
        });
        io.observe(target);
      } else {
        hydrateOne(el);
      }
    })(els[i]);
  }
})();`;

// --- shared: gql tag + Structured Text renderer (used by both forms) ---------
// Depends only on `h` / `Fragment`, imported by whichever form includes it.
const SHARED_RUNTIME = String.raw`
// Identity tag for GraphQL documents. Enables extraction/validation at publish
// and gives editors syntax highlighting. Interpolations are stringified.
export function gql(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    out += String(values[i]) + strings[i + 1];
  }
  return out;
}

// ---- structured text --------------------------------------------------------

// Render a DatoCMS-style Structured Text "value" (DAST JSON) to Preact vnodes.
// Pass the field's \`value\` directly (e.g. \`renderStructuredText(post.body.value)\`).
// Standard DAST nodes are mapped to HTML tags; unknown node types degrade
// gracefully by rendering their children (or their text) and are never fatal.
const __DAST_MARK_TAGS = {
  strong: "strong",
  emphasis: "em",
  code: "code",
  underline: "u",
  strikethrough: "s",
};

function __dastDocument(value) {
  if (!value || typeof value !== "object") return null;
  if (value.document) return value.document; // { schema, document }
  if (value.type === "root") return value; // a bare root node
  if (value.value) return __dastDocument(value.value); // whole field object
  return null;
}

function __dastChildren(node) {
  const kids = node && Array.isArray(node.children) ? node.children : [];
  return kids.map((child, i) => __renderDastNode(child, i));
}

function __renderDastNode(node, key) {
  if (node == null) return null;
  if (typeof node === "string") return node;

  switch (node.type) {
    case "root":
      return h(Fragment, { key }, __dastChildren(node));
    case "paragraph":
      return h("p", { key }, __dastChildren(node));
    case "heading": {
      const level = Math.min(Math.max(Number(node.level) || 1, 1), 6);
      return h("h" + level, { key }, __dastChildren(node));
    }
    case "list":
      return h(node.style === "numbered" ? "ol" : "ul", { key }, __dastChildren(node));
    case "listItem":
      return h("li", { key }, __dastChildren(node));
    case "blockquote":
      return h("blockquote", { key }, __dastChildren(node));
    case "link":
      return h("a", { key, href: node.url }, __dastChildren(node));
    case "code":
      return h("pre", { key }, h("code", null, node.code));
    case "thematicBreak":
      return h("hr", { key });
    case "span": {
      let out = node.value;
      const marks = Array.isArray(node.marks) ? node.marks : [];
      for (const mark of marks) {
        const tag = __DAST_MARK_TAGS[mark];
        if (tag) out = h(tag, null, out);
      }
      // Wrap so array items carry a key without disturbing plain-text spans.
      return marks.length ? h(Fragment, { key }, out) : out;
    }
    default:
      // Unknown node: render children if any, else its text, else nothing.
      if (Array.isArray(node.children)) return h(Fragment, { key }, __dastChildren(node));
      if (typeof node.value === "string") return node.value;
      return null;
  }
}

export function renderStructuredText(value) {
  const doc = __dastDocument(value);
  if (!doc) return null;
  return h(Fragment, null, __dastChildren(doc));
}
`;

// --- server form: query + routing + Island SSR helper ------------------------
const SERVER_RUNTIME = String.raw`
// Run a GraphQL query against the CMS via the loopback GRAPHQL binding.
// The supervisor fixes draft/published visibility on the binding itself.
export async function query(env, document, variables) {
  if (!env || !env.GRAPHQL) {
    throw new Error("query(): env.GRAPHQL binding is not available");
  }
  const res = await env.GRAPHQL.fetch("https://graphql.internal/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: document, variables: variables || {} }),
  });
  const json = await res.json();
  if (json.errors && json.errors.length) {
    throw new Error(
      "GraphQL error: " + json.errors.map((e) => e.message).join("; "),
    );
  }
  return json.data;
}

export { h, Fragment, renderToString };

// ---- feature database (drizzle) --------------------------------------------
// Return the async remote callback drizzle's \`drizzle-orm/sqlite-proxy\` driver
// wants — \`(sql, params, method) => Promise<{ rows }>\` — backed by the mediated
// \`env.FEATURES_SQL.exec()\` RPC. A raw D1Database cannot cross the Worker-Loader
// boundary (DataCloneError), so the feature DB is reached ONLY through this narrow
// exec() capability, which already returns the POSITIONAL row shape drizzle maps
// by column index: \`all\`/\`values\` -> array-of-arrays, \`get\` -> a single row array
// (or undefined when no row), \`run\` -> empty. So the agent never writes the
// sqlite-proxy wrapper or worries about \`.raw()\` row shapes — just:
//
//   import { drizzle } from "drizzle-orm/sqlite-proxy";
//   const db = drizzle(featuresDriver(env), { schema });
//
// Construct drizzle in YOUR module (it is a resolved dep, not re-exported here).
// SERVER-ONLY, exactly like query(): the browser build throws.
export function featuresDriver(env) {
  if (!env || !env.FEATURES_SQL) {
    throw new Error(
      "featuresDriver(): env.FEATURES_SQL is not available. The feature database " +
        "is reachable only from a serverFn/loader (server) — never the browser.",
    );
  }
  return async function (sql, params, method) {
    const res = await env.FEATURES_SQL.exec(sql, params || [], method);
    // exec() has already mapped D1's .raw() output into the positional shape
    // sqlite-proxy expects (get -> single row array or undefined; all/values ->
    // array-of-arrays; run -> []). Forward it unchanged.
    return { rows: res ? res.rows : [] };
  };
}

// Realtime is a browser capability: subscribing happens in a hydrated island.
export function connectChannel() {
  throw new Error(
    "connectChannel() is client-only — call it inside an island (browser), " +
      "e.g. in a useEffect. To PUSH messages from the server use env.REALTIME.publish().",
  );
}

// ---- server functions -------------------------------------------------------
// A serverFn is a typed, validated function that runs IN THIS ISOLATE with the
// site's narrow capability env (env.GRAPHQL / env.RECORDS / env.REALTIME — the
// SAME env a route render/loader gets; never raw DB/LOADER). It is callable two
// ways from the SAME authored import:
//   - server-side (from a loader): direct in-isolate call, no HTTP;
//   - browser (from a hydrated island): the client build of this module (see
//     CLIENT_RUNTIME) turns the import into an RPC stub that POSTs /__fn/...
// Each serverFn is tagged with a stable id ("<modulePath>#<exportName>") by a
// transpile-time epilogue that calls __lokiSetId on every exported serverFn; the
// server registers itself in __serverFns for dispatch, the client stub keeps the
// id to build its fetch URL.

// Ambient per-request env for DIRECT (in-isolate) serverFn calls from a loader.
// Every env handed to a given isolate is functionally identical (a published
// isolate only ever receives published envs, a draft isolate draft envs — same
// GRAPHQL visibility, same RECORDS allowlist, same REALTIME), so this module
// global is safe under concurrent requests. The RPC dispatch path threads env
// EXPLICITLY and never reads this.
let __requestEnv = null;

// id -> serverFn, populated at module-eval time by the transpile epilogue.
const __serverFns = Object.create(null);

export function serverFn(config) {
  const method = String((config && config.method) || "GET").toUpperCase();
  let validate = function (x) { return x; };
  let handle = null;
  let id = null;
  // Direct in-isolate call (e.g. from a loader): validate + run against the
  // ambient request env. Errors propagate to the caller unchanged.
  const fn = async function (input) {
    const data = await validate(input);
    if (typeof handle !== "function") {
      throw new Error("serverFn: .handler() was never set" + (id ? " for " + id : ""));
    }
    return handle({ data, env: __requestEnv, request: null });
  };
  fn.__isLokiServerFn = true;
  fn.__lokiMethod = method;
  fn.validator = function (v) { if (typeof v === "function") validate = v; return fn; };
  fn.handler = function (h) { handle = h; return fn; };
  fn.__lokiSetId = function (v) { id = v; fn.__lokiId = v; __serverFns[v] = fn; };
  // Dispatch used by the RPC endpoint: distinguishes validator (400) from handler
  // (500) failures and threads env EXPLICITLY (never the ambient global).
  fn.__lokiDispatch = async function (input, request, env) {
    let data;
    try {
      data = await validate(input);
    } catch (e) {
      return { status: 400, error: (e && e.message) ? e.message : String(e) };
    }
    if (typeof handle !== "function") {
      return { status: 500, error: "Server function is not fully defined." };
    }
    try {
      const result = await handle({ data, env, request });
      return { status: 200, result: result };
    } catch (e) {
      console.error("[loki serverFn] handler threw for " + (id || "?"), e);
      return { status: 500, error: "Server function failed." };
    }
  };
  return fn;
}

function __fnJson(status, obj) {
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// Invoke a registered serverFn over the internal /__fn/<scope>/<id> route. The
// supervisor loads THIS isolate (the same env a page render gets) and forwards
// the request here. 404 unknown id, 400 validator throw / bad input, 500 handler
// throw (logged; generic message to the client).
export async function handleServerFn(request, env) {
  __requestEnv = env;
  const url = new URL(request.url);
  const m = url.pathname.match(/^\/__fn\/(?:v\d+|draft)\/(.+)$/);
  if (!m) return __fnJson(404, { error: "Not a server-function route." });
  const id = decodeURIComponent(m[1]);
  const fn = __serverFns[id];
  if (!fn) return __fnJson(404, { error: 'Unknown server function "' + id + '".' });
  const method = request.method.toUpperCase();
  let input;
  if (method === "GET" || method === "HEAD") {
    const raw = url.searchParams.get("data");
    if (raw != null) {
      try { input = JSON.parse(raw); }
      catch (e) { return __fnJson(400, { error: "Invalid ?data= JSON: " + e.message }); }
    }
  } else {
    let body;
    try { body = await request.json(); }
    catch (e) { return __fnJson(400, { error: "Invalid JSON body." }); }
    input = body ? body.data : undefined;
  }
  const out = await fn.__lokiDispatch(input, request, env);
  if (out.status === 200) {
    return __fnJson(200, out.result === undefined ? null : out.result);
  }
  return __fnJson(out.status, { error: out.error });
}

// ---- islands (partial hydration) --------------------------------------------

// Populated per-request by handleRequest (see below). Because renderToString is
// synchronous and these are set immediately before it with no intervening await,
// a single request's render never interleaves with another's.
let __islandRegistry = {};
let __islandBase = "/__modules/draft";
let __islandUsed = false;

function __stripModuleExt(p) {
  return p.replace(/\.(tsx|ts|jsx|mjs|js)$/, "");
}

function __serializeIslandProps(src, props) {
  try {
    return JSON.stringify(props, function (key, value) {
      if (typeof value === "function") {
        throw new Error("prop '" + key + "' is a function");
      }
      if (typeof value === "bigint") {
        throw new Error("prop '" + key + "' is a BigInt");
      }
      return value;
    });
  } catch (e) {
    throw new Error(
      'Island "' + src + '": props must be JSON-serializable (' + e.message + ").",
    );
  }
}

/**
 * SSR an interactive island. Usage:
 *   <Island src="components/counter.tsx" client="load" initial={5} />
 * Renders the module's default component to HTML now, wraps it in a
 * <loki-island> marker carrying the browser module URL, the serialized props,
 * and the client directive ("load" | "idle" | "visible"), and flags the page so
 * the head gets an import map + the hydration bootstrap. Props must round-trip
 * as JSON. The SAME module is SSR'd here and hydrated in the browser.
 */
export function Island(props) {
  props = props || {};
  const src = props.src;
  if (!src) {
    throw new Error("Island requires a 'src' prop (e.g. 'components/counter.tsx').");
  }
  const client = props.client || "load";
  const rest = {};
  for (const k in props) {
    if (k === "src" || k === "client" || k === "children") continue;
    rest[k] = props[k];
  }
  const mod = __islandRegistry[src] || __islandRegistry[__stripModuleExt(src)];
  if (!mod) {
    const known = Object.keys(__islandRegistry).sort().join(", ") || "(none)";
    throw new Error(
      'Island "' + src + '": no such module in the site tree. Known modules: ' + known,
    );
  }
  const Component = mod.default;
  if (typeof Component !== "function") {
    throw new Error('Island "' + src + '": module has no default component export.');
  }
  const propsJson = __serializeIslandProps(src, rest);
  __islandUsed = true;
  return h(
    "loki-island",
    {
      "data-loki-src": __islandBase + "/" + src,
      "data-loki-props": propsJson,
      "data-loki-client": client,
      style: "display:contents",
    },
    h(Component, rest),
  );
}

// ---- routing ----------------------------------------------------------------

function compilePattern(pattern) {
  const keys = [];
  const regexSource =
    "^" +
    pattern
      .replace(/[.*+?^{}()|[\]\\]/g, (c) => (c === "." ? "\\." : c))
      .replace(/:([A-Za-z0-9_]+)/g, (_m, key) => {
        keys.push(key);
        return "([^/]+)";
      }) +
    "/?$";
  return { regex: new RegExp(regexSource), keys };
}

function matchRoutes(routes, pathname) {
  for (const route of routes) {
    const { regex, keys } = compilePattern(route.pattern);
    const m = regex.exec(pathname);
    if (!m) continue;
    const params = {};
    keys.forEach((key, i) => {
      params[key] = decodeURIComponent(m[i + 1]);
    });
    return { route, params };
  }
  return null;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// A head can be authored two ways per route AND once globally (the head export
// of a top-level app.* module). These helpers merge a global head (defaults)
// with a route head (overrides), so a favicon/OG set once on the app applies to
// every page while a route can still override title or a specific tag.

// Open-Graph / Facebook / article meta MUST use property=, not name=. As a
// convenience, a meta authored as { name: "og:image", ... } is auto-mapped to
// { property: "og:image", ... } so it emits the correct attribute either way.
const __PROPERTY_META_RE = /^(og|fb|article|book|profile|music|video):/;

function __normalizeMeta(m) {
  if (!m || typeof m !== "object") return m;
  if (
    m.property == null &&
    typeof m.name === "string" &&
    __PROPERTY_META_RE.test(m.name)
  ) {
    const out = { property: m.name };
    for (const k in m) if (k !== "name") out[k] = m[k];
    return out;
  }
  return m;
}

// Identity used to override/de-dupe. Meta: its property (preferred) or name.
// Link: rel + href together (so multiple preloads with distinct href survive,
// while a repeated favicon collapses to one).
function __metaIdentity(m) {
  if (!m || typeof m !== "object") return null;
  if (m.property != null) return "property:" + m.property;
  if (m.name != null) return "name:" + m.name;
  return null;
}
function __linkIdentity(l) {
  if (!l || typeof l !== "object") return null;
  const rel = l.rel != null ? String(l.rel) : "";
  const href = l.href != null ? String(l.href) : "";
  if (!rel && !href) return null;
  return "link:" + rel + "\n" + href;
}

// Union global + route: route entries override global ones sharing an identity,
// identity-less entries are kept as-is. Global insertion order is preserved.
function __mergeList(globalArr, routeArr, idOf) {
  const g = Array.isArray(globalArr) ? globalArr : [];
  const r = Array.isArray(routeArr) ? routeArr : [];
  const byId = new Map();
  const anon = [];
  for (const item of g.concat(r)) {
    const id = idOf(item);
    if (id == null) anon.push(item);
    else byId.set(id, item); // route (appended later) overrides global
  }
  const out = [];
  for (const v of byId.values()) out.push(v);
  for (const v of anon) out.push(v);
  return out;
}

// Merge a resolved global head (defaults) under a resolved route head.
function __mergeHead(globalHead, routeHead) {
  const g = globalHead && typeof globalHead === "object" ? globalHead : {};
  const r = routeHead && typeof routeHead === "object" ? routeHead : {};
  const gMeta = (Array.isArray(g.meta) ? g.meta : []).map(__normalizeMeta);
  const rMeta = (Array.isArray(r.meta) ? r.meta : []).map(__normalizeMeta);
  return {
    // Route title wins if set; else the global (site-wide) title.
    title: r.title != null ? r.title : g.title,
    meta: __mergeList(gMeta, rMeta, __metaIdentity),
    links: __mergeList(g.links, r.links, __linkIdentity),
  };
}

function renderHead(head, hasStyles) {
  const parts = [];
  parts.push('<meta charset="utf-8">');
  parts.push(
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
  );
  if (head && head.title) parts.push("<title>" + escapeHtml(head.title) + "</title>");
  if (head && Array.isArray(head.meta)) {
    for (const m of head.meta) {
      const attrs = Object.keys(m)
        .map((k) => k + '="' + escapeHtml(m[k]) + '"')
        .join(" ");
      parts.push("<meta " + attrs + ">");
    }
  }
  if (head && Array.isArray(head.links)) {
    for (const l of head.links) {
      const attrs = Object.keys(l)
        .map((k) => k + '="' + escapeHtml(l[k]) + '"')
        .join(" ");
      parts.push("<link " + attrs + ">");
    }
  }
  if (hasStyles) parts.push('<link rel="stylesheet" href="/styles.css">');
  return parts.join("");
}

const __ISLAND_BOOTSTRAP = ${JSON.stringify(ISLAND_BOOTSTRAP)};

// /__modules/<scope> -> /__fn/<scope>: the base a client serverFn stub POSTs to.
function __islandToFnBase(islandBase) {
  return (islandBase || "/__modules/draft").replace("/__modules/", "/__fn/");
}

function renderIslandHead(vendorBase, fnBase) {
  const vb = vendorBase || "/__vendor";
  const importMap = {
    imports: {
      preact: vb + "/preact.js",
      "preact/hooks": vb + "/preact-hooks.js",
      "preact/jsx-runtime": vb + "/preact-jsx-runtime.js",
      "loki/runtime": vb + "/loki-runtime.js",
    },
  };
  return (
    '<script type="importmap">' + JSON.stringify(importMap) + "</script>" +
    "<script>window.__lokiFnBase=" + JSON.stringify(fnBase || "/__fn/draft") + ";</script>" +
    '<script type="module">' + __ISLAND_BOOTSTRAP + "</script>"
  );
}

function htmlResponse(body, status) {
  return new Response(body, {
    status: status || 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// Normalize a route action(...) return value into a Response:
//   - a Response (incl. Response.redirect(...)) -> passed through unchanged
//   - { redirect: "/path" } sentinel            -> 303 See Other to that path
//   - null / undefined                          -> 204 No Content
//   - any other plain value                     -> 200 JSON
function normalizeActionResult(result) {
  if (result instanceof Response) return result;
  if (
    result &&
    typeof result === "object" &&
    typeof result.redirect === "string"
  ) {
    return new Response(null, {
      status: 303,
      headers: { location: result.redirect },
    });
  }
  if (result == null) return new Response(null, { status: 204 });
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * Handle a request against the site's file-based routes.
 * config = { routes, styles, islands, vendorBase, islandBase }.
 */
export async function handleRequest(request, env, ctx, config) {
  // Ambient env for direct (in-isolate) serverFn calls made from a loader.
  __requestEnv = env;
  const url = new URL(request.url);

  if (url.pathname === "/styles.css") {
    if (config.styles == null) return new Response("Not found", { status: 404 });
    return new Response(config.styles, {
      headers: {
        "content-type": "text/css; charset=utf-8",
        "cache-control": "public, max-age=300",
      },
    });
  }

  const matched = matchRoutes(config.routes || [], url.pathname);
  if (!matched) {
    return htmlResponse(
      "<!doctype html><meta charset=utf-8><title>404</title><h1>404 — Not found</h1>",
      404,
    );
  }

  const mod = matched.route.mod;

  // Non-GET/HEAD requests dispatch to the route's action(...) export instead of
  // rendering. No action -> 405 Method Not Allowed.
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    if (typeof mod.action !== "function") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" },
      });
    }
    const result = await mod.action({ request, env, params: matched.params });
    return normalizeActionResult(result);
  }

  const Component = mod.default;
  if (typeof Component !== "function") {
    return htmlResponse(
      "<!doctype html><meta charset=utf-8><title>500</title><h1>500</h1><p>Route " +
        escapeHtml(matched.route.pattern) +
        " has no default component export.</p>",
      500,
    );
  }

  let props = {};
  if (typeof mod.loader === "function") {
    const loaded = await mod.loader({ env, params: matched.params, request });
    if (loaded && typeof loaded === "object") props = loaded;
  }

  let routeHead = mod.head;
  if (typeof routeHead === "function") routeHead = routeHead(props);
  let globalHead = config.globalHead;
  if (typeof globalHead === "function") globalHead = globalHead(props);
  // Global head provides site-wide defaults (favicon/OG); the route head
  // overrides title and any tag sharing an identity. De-dupes so a favicon or
  // og:image set globally + per-route emits once (the route's).
  const head = __mergeHead(globalHead, routeHead);

  // Prime island context, then render synchronously (no await until we've read
  // back whether any island was used) so requests can't clobber each other.
  __islandRegistry = config.islands || {};
  __islandBase = (env && env.LOKI_ISLAND_BASE) || config.islandBase || "/__modules/draft";
  __islandUsed = false;
  const bodyHtml = renderToString(
    h(Component, Object.assign({}, props, { params: matched.params })),
  );
  const islandHead = __islandUsed
    ? renderIslandHead(config.vendorBase, __islandToFnBase(__islandBase))
    : "";

  const doc =
    "<!doctype html><html><head>" +
    renderHead(head, config.styles != null) +
    islandHead +
    '</head><body><div id="app">' +
    bodyHtml +
    "</div></body></html>";

  return htmlResponse(doc, 200);
}
`;

// --- client form: browser stubs for server-only APIs -------------------------
const CLIENT_RUNTIME = String.raw`
export function query() {
  throw new Error(
    "query() is server-only — it cannot run in the browser. Fetch data in a route " +
      "loader (server) and pass it into the island via props.",
  );
}

export function featuresDriver() {
  throw new Error(
    "featuresDriver() is server-only — the feature database is reachable only from a " +
      "serverFn/loader (server), never the browser. Read it there and pass data into " +
      "the island via props, or mutate it through a serverFn RPC.",
  );
}

export function renderToString() {
  throw new Error("renderToString() is server-only and unavailable in the browser.");
}

export function Island() {
  throw new Error("Island() is a server-side SSR helper and cannot run in the browser.");
}

// Browser build of serverFn: the SAME authored \`serverFn(...).validator(...)
// .handler(...)\` chain loads here, but instead of running the handler it returns
// an RPC stub. Calling it POSTs (or GETs) /__fn/<scope>/<id> and returns the
// parsed JSON. The id is assigned by the transpile epilogue (__lokiSetId); the
// scope base (\`/__fn/v<N>\` or \`/__fn/draft\`) is injected into the page as
// window.__lokiFnBase alongside the island bootstrap.
export function serverFn(config) {
  const method = String((config && config.method) || "GET").toUpperCase();
  let id = null;
  const fn = async function (input) {
    if (!id) {
      throw new Error(
        "serverFn: this stub has no id — it must be a NAMED export of its module.",
      );
    }
    const base =
      (typeof window !== "undefined" && window.__lokiFnBase) || "/__fn/draft";
    let url = base + "/" + encodeURIComponent(id);
    const init = { method: method, headers: {} };
    if (method === "GET" || method === "HEAD") {
      if (input !== undefined) {
        url += "?data=" + encodeURIComponent(JSON.stringify(input));
      }
    } else {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify({ data: input });
    }
    const res = await fetch(url, init);
    const bodyText = await res.text();
    let payload;
    try { payload = bodyText ? JSON.parse(bodyText) : null; }
    catch (e) { payload = bodyText; }
    if (!res.ok) {
      const msg = payload && payload.error ? payload.error : "HTTP " + res.status;
      throw new Error("serverFn " + id + ": " + msg);
    }
    return payload;
  };
  fn.__isLokiServerFn = true;
  fn.__lokiMethod = method;
  // Chainable no-ops so the authored \`.validator().handler()\` chain LOADS in the
  // browser; validation + handling only ever run server-side.
  fn.validator = function () { return fn; };
  fn.handler = function () { return fn; };
  fn.__lokiSetId = function (v) { id = v; fn.__lokiId = v; };
  return fn;
}

// Client RPC stub FACTORY. A serverFn module's browser build is fully
// SYNTHESIZED at write time (see transpile.buildClientBuild): the real handler/
// validator source is NEVER served to the browser — only, per exported serverFn,
// a call to this factory with the stable id (\`<modulePath>#<exportName>\`) and its
// transport method. So the browser can invoke the serverFn over RPC but has no
// access to its body (no secrets, no gql, no server logic). The isolate build is
// separate and keeps the full handler for in-isolate execution + /__fn dispatch.
export function __lokiClientServerFn(id, method) {
  var m = String(method || "POST").toUpperCase();
  var fn = async function (input) {
    var base =
      (typeof window !== "undefined" && window.__lokiFnBase) || "/__fn/draft";
    var url = base + "/" + encodeURIComponent(id);
    var init = { method: m, headers: {} };
    if (m === "GET" || m === "HEAD") {
      if (input !== undefined) {
        url += "?data=" + encodeURIComponent(JSON.stringify(input));
      }
    } else {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify({ data: input });
    }
    var res = await fetch(url, init);
    var bodyText = await res.text();
    var payload;
    try { payload = bodyText ? JSON.parse(bodyText) : null; }
    catch (e) { payload = bodyText; }
    if (!res.ok) {
      var msg = payload && payload.error ? payload.error : "HTTP " + res.status;
      throw new Error("serverFn " + id + ": " + msg);
    }
    return payload;
  };
  fn.__isLokiServerFn = true;
  fn.__lokiId = id;
  fn.__lokiMethod = m;
  return fn;
}

// Subscribe to a realtime channel from the browser. Opens a WebSocket to
// /__realtime/<name> (wss when the page is https), JSON-parses each message and
// hands it to onMessage, and auto-reconnects with capped exponential backoff.
// Returns { close } to tear the subscription down (e.g. from a useEffect cleanup).
export function connectChannel(name, onMessage) {
  if (typeof WebSocket === "undefined" || typeof location === "undefined") {
    throw new Error("connectChannel() requires a browser environment.");
  }
  var proto = location.protocol === "https:" ? "wss:" : "ws:";
  var url = proto + "//" + location.host + "/__realtime/" + encodeURIComponent(name);
  var ws = null;
  var closed = false;
  var attempt = 0;
  var timer = null;
  function connect() {
    if (closed) return;
    ws = new WebSocket(url);
    ws.addEventListener("open", function () { attempt = 0; });
    ws.addEventListener("message", function (ev) {
      var data = ev.data;
      try { data = JSON.parse(ev.data); } catch (e) { /* leave as raw string */ }
      try { onMessage(data); }
      catch (e) { console.error("[loki channel] onMessage threw", e); }
    });
    ws.addEventListener("close", function () { scheduleReconnect(); });
    ws.addEventListener("error", function () { try { ws.close(); } catch (e) {} });
  }
  function scheduleReconnect() {
    if (closed) return;
    var delay = Math.min(30000, 500 * Math.pow(2, attempt++));
    timer = setTimeout(connect, delay);
  }
  connect();
  return {
    close: function () {
      closed = true;
      if (timer) clearTimeout(timer);
      if (ws) { try { ws.close(); } catch (e) {} }
    },
  };
}

export { h, Fragment };
`;

// Assemble the two module strings. The `${JSON.stringify(ISLAND_BOOTSTRAP)}`
// inside SERVER_RUNTIME above is a real String.raw interpolation: it emits the
// bootstrap source as a JS string literal assigned to __ISLAND_BOOTSTRAP.
export const RUNTIME_MODULE =
  'import { h, Fragment } from "preact";\n' +
  'import { renderToString } from "preact-render-to-string";\n' +
  SHARED_RUNTIME +
  SERVER_RUNTIME;

export const CLIENT_RUNTIME_MODULE =
  'import { h, Fragment } from "preact";\n' + SHARED_RUNTIME + CLIENT_RUNTIME;
