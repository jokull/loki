// The `loki/runtime` module injected into every dynamic-site module map.
//
// It is authored as a plain-JS string (already "transpiled") and exposes the
// site authoring API: `gql`, `query(env, doc, vars)`, and the file-based router
// (`handleRequest`) that the generated site entry calls. Site route modules
// import from here via `import { gql, query } from "loki/runtime"`.
//
// Keep this dependency-light: it imports only `preact` and
// `preact-render-to-string`, both of which are vendored into the same map.

export const RUNTIME_MODULE = String.raw`
import { h, Fragment } from "preact";
import { renderToString } from "preact-render-to-string";

// Identity tag for GraphQL documents. Enables extraction/validation at publish
// and gives editors syntax highlighting. Interpolations are stringified.
export function gql(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    out += String(values[i]) + strings[i + 1];
  }
  return out;
}

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

function htmlResponse(body, status) {
  return new Response(body, {
    status: status || 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/**
 * Handle a request against the site's file-based routes.
 * config = { routes: [{ pattern, mod }], styles: string | null }.
 */
export async function handleRequest(request, env, ctx, config) {
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

  let head = mod.head;
  if (typeof head === "function") head = head(props);

  const bodyHtml = renderToString(
    h(Component, Object.assign({}, props, { params: matched.params })),
  );

  const doc =
    "<!doctype html><html><head>" +
    renderHead(head, config.styles != null) +
    '</head><body><div id="app">' +
    bodyHtml +
    "</div></body></html>";

  return htmlResponse(doc, 200);
}
`;
