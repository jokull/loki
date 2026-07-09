// Browser-facing module + vendor serving for island hydration.
//
// Islands ship the SAME compiled module to the browser that the isolate runs
// server-side. That stored compiled form already carries browser-resolvable
// specifiers: bare `preact` / `preact/hooks` / `preact/jsx-runtime` / `loki/runtime`
// (resolved by the page's import map -> /__vendor/...) and relative `./x.tsx`
// imports (resolved by URL, since modules are served at their tree path under
// /__modules/...). So NO extra rewrite is needed — we serve the stored compiled
// text verbatim. (This is the "rewrite-on-read is a no-op" choice: the isolate's
// bare->flat rewrite in bundle.ts is applied only at load time and never stored,
// leaving the persisted compiled module already browser-shaped.)
//
// - GET /__vendor/<ver>/<name>.js -> vendored preact ESM + the client runtime,
//   immutable.
// - GET /__modules/v<N>/<path>    -> compiled module from published version N,
//   immutable.
// - GET /__modules/draft/<path>   -> compiled module from the draft tree (only
//   with a valid preview cookie), no-store.

import type { Env } from "../env";
import { preact } from "../vendor/preact";
import { preactHooks } from "../vendor/preact-hooks";
import { preactJsxRuntime } from "../vendor/preact-jsx-runtime";
import { CLIENT_RUNTIME_MODULE } from "./runtime-shim";
import { type Bundle } from "./bundle";
import { isTranspilable } from "./transpile";
import { buildDraftClientBundle } from "./serve";
import { getVersion, versionClientBundle } from "./store";

const JS_TYPE = "text/javascript; charset=utf-8";
const IMMUTABLE = "public, max-age=31536000, immutable";
const MODULE_EXTS = [".tsx", ".ts", ".jsx", ".mjs", ".js"];

// The four vendored/browser modules, keyed by their served filename. Every bare
// `preact` import inside these resolves through the page import map.
const VENDOR_MODULES: Record<string, string> = {
  "preact.js": preact,
  "preact-hooks.js": preactHooks,
  "preact-jsx-runtime.js": preactJsxRuntime,
  "loki-runtime.js": CLIENT_RUNTIME_MODULE,
};

function jsResponse(code: string, cacheControl: string): Response {
  return new Response(code, {
    headers: { "content-type": JS_TYPE, "cache-control": cacheControl },
  });
}

/** GET /__vendor/<ver>/<name>.js — version segment is only cache-busting. */
export function serveVendor(pathname: string): Response {
  const m = pathname.match(/^\/__vendor\/[^/]+\/([^/]+)$/);
  if (!m) return new Response("Not found", { status: 404 });
  const code = VENDOR_MODULES[m[1]];
  if (code == null) return new Response("Not found", { status: 404 });
  return jsResponse(code, IMMUTABLE);
}

/** Resolve a requested module path against a bundle (exact, then ext-alias). */
function resolveModule(bundle: Bundle, path: string): string | null {
  if (path in bundle && isTranspilable(path)) return bundle[path];
  for (const ext of MODULE_EXTS) {
    const candidate = path + ext;
    if (candidate in bundle && isTranspilable(candidate)) return bundle[candidate];
  }
  return null;
}

/**
 * GET /__modules/(v<N>|draft)/<path>. Published versions are immutable;
 * the draft tree requires a valid preview cookie and is never cached.
 */
export async function serveModule(
  env: Env,
  pathname: string,
  previewOk: boolean,
): Promise<Response> {
  const m = pathname.match(/^\/__modules\/(v\d+|draft)\/(.+)$/);
  if (!m) return new Response("Not found", { status: 404 });
  const [, scope, modPath] = m;

  if (scope === "draft") {
    if (!previewOk) return new Response("Not found", { status: 404 });
    // The CLIENT bundle: serverFn modules resolve to their synthesized stub, so
    // handler/validator source (secrets, gql, logic) never reaches the browser.
    const bundle = await buildDraftClientBundle(env);
    const code = resolveModule(bundle, modPath);
    if (code == null) return new Response("Not found", { status: 404 });
    return jsResponse(code, "no-store");
  }

  const versionId = Number(scope.slice(1));
  if (!Number.isInteger(versionId)) return new Response("Not found", { status: 404 });
  const version = await getVersion(env, versionId);
  if (!version) return new Response("Not found", { status: 404 });
  // Overlay the version's browser stubs over its full bundle: serverFn modules
  // serve the stub, everything else the normal compiled text. (Legacy versions
  // published before client stubs existed carry no overlay and fall back to the
  // full text — republish to stub them.)
  const bundle = {
    ...(JSON.parse(version.bundle) as Bundle),
    ...versionClientBundle(version),
  };
  const code = resolveModule(bundle, modPath);
  if (code == null) return new Response("Not found", { status: 404 });
  return jsResponse(code, IMMUTABLE);
}
