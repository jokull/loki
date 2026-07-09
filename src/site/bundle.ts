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

export type Bundle = Record<string, string>;

// Bump when the runtime shim, vendor modules, or bundle builder change — it is
// mixed into every LOADER id so cached isolates are invalidated.
export const RUNTIME_VERSION = "r9";

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

const SPECIFIER_RE = new RegExp(
  `(\\bfrom\\s*|\\bimport\\s*\\(\\s*)(["'])(${Object.keys(VENDOR_FILES)
    .map((s) => s.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&"))
    .join("|")})(["'])`,
  "g",
);

/** "../" * depth of the importer key (root = "./"). */
function relPrefix(importerKey: string): string {
  const depth = (importerKey.match(/\//g) || []).length;
  return depth === 0 ? "./" : "../".repeat(depth);
}

/** Rewrite bare runtime specifiers to relative paths to the flat vendor files. */
function rewriteSpecifiers(code: string, importerKey: string): string {
  const prefix = relPrefix(importerKey);
  return code.replace(
    SPECIFIER_RE,
    (_m, pre, q, spec) => `${pre}${q}${prefix}${VENDOR_FILES[spec]}${q}`,
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

export function buildWorkerCode(bundle: Bundle): BuiltWorker {
  const modules: Record<string, { js: string }> = {
    "loki_preact.js": { js: rewriteSpecifiers(preact, "loki_preact.js") },
    "loki_preact_hooks.js": {
      js: rewriteSpecifiers(preactHooks, "loki_preact_hooks.js"),
    },
    "loki_preact_jsx_runtime.js": {
      js: rewriteSpecifiers(preactJsxRuntime, "loki_preact_jsx_runtime.js"),
    },
    "loki_preact_rts.js": {
      js: rewriteSpecifiers(preactRenderToString, "loki_preact_rts.js"),
    },
    "loki_runtime.js": { js: rewriteSpecifiers(RUNTIME_MODULE, "loki_runtime.js") },
  };

  const styles = bundle["styles.css"] ?? null;

  // Register authored JS/TS modules keyed by their (no-leading-slash) tree
  // path, plus an extensionless alias so relative imports can omit the ext.
  for (const [path, content] of Object.entries(bundle)) {
    if (!isTranspilable(path)) continue;
    const js = rewriteSpecifiers(content, path);
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
