// Builds a `WorkerLoaderWorkerCode` module map from a compiled site bundle.
//
// A "bundle" is a flat map of site path -> content, where JS/TS modules hold
// their sucrase-compiled ESM and other files (styles.css) hold raw text. Loki
// injects the vendored preact modules + the `loki/runtime` shim + a generated
// entry module that wires file-based routes (or defers to a `main.*` escape
// hatch). These injected pieces are deterministic, so they are NOT stored per
// version — they are recomputed here at load time.

import { preact } from "../vendor/preact";
import { preactHooks } from "../vendor/preact-hooks";
import { preactJsxRuntime } from "../vendor/preact-jsx-runtime";
import { preactRenderToString } from "../vendor/preact-render-to-string";
import { RUNTIME_MODULE } from "./runtime-shim";
import { isTranspilable } from "./transpile";
import type { AssembledDeps } from "./deps";

export type Bundle = Record<string, string>;

// Bump when the runtime shim, vendor modules, or bundle builder change — it is
// mixed into every LOADER id so cached isolates are invalidated.
export const RUNTIME_VERSION = "r11";

const ENTRY_NAME = "__loki_entry.js";
const COMPAT_DATE = "2026-07-01";

// workerd resolves import specifiers URL-relative to the importing module AND
// rejects module-map keys with a leading "/". So we key the shared runtime
// modules as flat, root-level filenames (no slashes, no collision with the
// authored `routes/` tree) and rewrite each bare specifier to a depth-correct
// RELATIVE path from whichever module imports it.
const VENDOR_FILES: Record<string, string> = {
  "preact/jsx-runtime": "loki_preact_jsx_runtime.js",
  "preact/jsx-dev-runtime": "loki_preact_jsx_runtime.js",
  "preact/hooks": "loki_preact_hooks.js",
  "preact-render-to-string": "loki_preact_rts.js",
  preact: "loki_preact.js",
  "loki/runtime": "loki_runtime.js",
};

/** "../" * depth of the importer key (root = "./"). */
function relPrefix(importerKey: string): string {
  const depth = (importerKey.match(/\//g) || []).length;
  return depth === 0 ? "./" : "../".repeat(depth);
}

/**
 * Build a regex matching any of `specifiers` in a `from "..."` / `import("...")`
 * position. Rebuilt per bundle because the resolvable dep specifiers vary.
 */
function buildSpecifierRe(specifiers: string[]): RegExp {
  return new RegExp(
    `(\\bfrom\\s*|\\bimport\\s*\\(\\s*)(["'])(${specifiers
      .map((s) => s.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&"))
      .join("|")})(["'])`,
    "g",
  );
}

/**
 * Rewrite each bare specifier in `fileMap` (vendor built-ins + resolved deps) to
 * a depth-correct relative path to its module-map key. Both flat vendor
 * filenames and namespaced `deps/<hash>/<key>` targets resolve URL-relative to
 * the importer, so the same relPrefix applies to both.
 */
function rewriteSpecifiers(
  code: string,
  importerKey: string,
  fileMap: Record<string, string>,
  re: RegExp,
): string {
  const prefix = relPrefix(importerKey);
  return code.replace(
    re,
    (_m, pre, q, spec) => `${pre}${q}${prefix}${fileMap[spec]}${q}`,
  );
}

const MODULE_EXT = /\.(tsx|ts|jsx|mjs|js)$/;

function stripExt(path: string): string {
  return path.replace(MODULE_EXT, "");
}

/** routes/index.tsx -> "/", routes/posts/[slug].tsx -> "/posts/:slug". */
export function routePathToPattern(path: string): string {
  let rel = stripExt(path).replace(/^routes\//, "");
  const segments = rel.split("/").filter(Boolean);
  if (segments.length && segments[segments.length - 1] === "index") {
    segments.pop();
  }
  const pattern = segments
    .map((seg) => seg.replace(/^\[(.+)\]$/, ":$1"))
    .join("/");
  return "/" + pattern;
}

function isRoute(path: string): boolean {
  return path.startsWith("routes/") && MODULE_EXT.test(path);
}

function isMainOverride(path: string): boolean {
  return /^main\.(tsx|ts|jsx|mjs|js)$/.test(path);
}

// A top-level `app.*` module is the site root: its `head` export is the GLOBAL
// head merged under every route (favicon / OG / site-wide meta live here once).
function isAppModule(path: string): boolean {
  return /^app\.(tsx|ts|jsx|mjs|js)$/.test(path);
}

/** Sort so static routes match before parameterised ones. */
function routeSpecificity(pattern: string): [number, number] {
  const segs = pattern.split("/").filter(Boolean);
  const params = segs.filter((s) => s.startsWith(":")).length;
  return [params, -segs.length];
}

export interface BuiltWorker {
  compatibilityDate: string;
  mainModule: string;
  modules: Record<string, { js: string }>;
}

const EMPTY_DEPS: AssembledDeps = { depModules: {}, specifierMap: {} };

export function buildWorkerCode(
  bundle: Bundle,
  deps: AssembledDeps = EMPTY_DEPS,
): BuiltWorker {
  // The rewrite map: bare runtime built-ins (flat vendor files) + resolved dep
  // entry specifiers (namespaced `deps/<hash>/<entry>`). Rebuilt per bundle.
  const fileMap: Record<string, string> = { ...VENDOR_FILES, ...deps.specifierMap };
  const re = buildSpecifierRe(Object.keys(fileMap));
  const rw = (code: string, importerKey: string) =>
    rewriteSpecifiers(code, importerKey, fileMap, re);

  const modules: Record<string, { js: string }> = {
    "loki_preact.js": { js: rw(preact, "loki_preact.js") },
    "loki_preact_hooks.js": { js: rw(preactHooks, "loki_preact_hooks.js") },
    "loki_preact_jsx_runtime.js": {
      js: rw(preactJsxRuntime, "loki_preact_jsx_runtime.js"),
    },
    "loki_preact_rts.js": { js: rw(preactRenderToString, "loki_preact_rts.js") },
    "loki_runtime.js": { js: rw(RUNTIME_MODULE, "loki_runtime.js") },
  };

  // Inject resolved dependency modules verbatim (their internal imports are
  // already relative `./local` within their `deps/<hash>/` namespace, and the
  // snapshot has zero esm.sh references — nothing to rewrite).
  for (const [key, code] of Object.entries(deps.depModules)) {
    modules[key] = { js: code };
  }

  const styles = bundle["styles.css"] ?? null;

  // Register authored JS/TS modules keyed by their (no-leading-slash) tree
  // path, plus an extensionless alias so relative imports can omit the ext.
  for (const [path, content] of Object.entries(bundle)) {
    if (!isTranspilable(path)) continue;
    const js = rw(content, path);
    modules[path] = { js };
    const alias = stripExt(path);
    if (alias !== path && !(alias in modules)) modules[alias] = { js };
  }

  // Escape hatch: a top-level main.* default-exports a fetch handler.
  const mainOverride = Object.keys(bundle).find(isMainOverride);
  if (mainOverride) {
    modules[ENTRY_NAME] = {
      js: `export { default } from ${JSON.stringify("./" + mainOverride)};\n`,
    };
    return { compatibilityDate: COMPAT_DATE, mainModule: ENTRY_NAME, modules };
  }

  // File-based routing: generate a root entry that imports EVERY authored
  // module (routes + components + utils) once. Route modules populate the router
  // table; all modules populate the island registry so <Island src="..."> can
  // resolve a component synchronously during SSR (renderToString is sync, so a
  // dynamic import is not an option).
  const authored = Object.keys(bundle).filter(isTranspilable);
  const indexOf = new Map(authored.map((p, i) => [p, i]));

  const imports = authored
    .map((path, i) => `import * as __m${i} from ${JSON.stringify("./" + path)};`)
    .join("\n");

  const registry = authored
    .map((path, i) => {
      const alias = stripExt(path);
      const lines = [`  ${JSON.stringify(path)}: __m${i},`];
      if (alias !== path) lines.push(`  ${JSON.stringify(alias)}: __m${i},`);
      return lines.join("\n");
    })
    .join("\n");

  const routes = authored
    .filter(isRoute)
    .map((path) => ({ path, pattern: routePathToPattern(path) }))
    .sort((a, b) => {
      const [pa, na] = routeSpecificity(a.pattern);
      const [pb, nb] = routeSpecificity(b.pattern);
      return pa - pb || na - nb;
    });
  const table = routes
    .map(
      (r) => `  { pattern: ${JSON.stringify(r.pattern)}, mod: __m${indexOf.get(r.path)} },`,
    )
    .join("\n");

  // Global head: the `head` export of a top-level `app.*` module, if present.
  const appModule = Object.keys(bundle).find(isAppModule);
  const globalHeadExpr =
    appModule != null ? `__m${indexOf.get(appModule)}.head` : "undefined";

  const vendorBase = "/__vendor/" + RUNTIME_VERSION;
  const entry = `
import * as __runtime from "./loki_runtime.js";
${imports}
const __styles = ${JSON.stringify(styles)};
const __routes = [
${table}
];
const __islands = {
${registry}
};
export default {
  fetch(request, env, ctx) {
    // serverFn RPC invocation: /__fn/<scope>/<id>. Importing every authored
    // module above ran each one's transpile epilogue, registering its serverFns
    // in the runtime; dispatch looks them up by id and runs them with THIS env.
    if (new URL(request.url).pathname.indexOf("/__fn/") === 0) {
      return __runtime.handleServerFn(request, env);
    }
    return __runtime.handleRequest(request, env, ctx, {
      routes: __routes,
      styles: __styles,
      islands: __islands,
      vendorBase: ${JSON.stringify(vendorBase)},
      globalHead: ${globalHeadExpr},
    });
  },
};
`;

  modules[ENTRY_NAME] = { js: entry };
  return { compatibilityDate: COMPAT_DATE, mainModule: ENTRY_NAME, modules };
}
