// Write-time transpile of authored site files (TSX/TS/JSX/JS) into ESM that the
// dynamic worker can execute. Uses sucrase (fast, no type-checking) with the
// automatic JSX runtime pointed at preact, then rewrites bare import specifiers
// to the module-map names used inside the loaded worker.

import { transform } from "sucrase";

// Specifiers the site code is allowed to import. The keys are what an author
// writes; the values are the exact module-map keys injected at load time.
// (They are identical here — the map is keyed by these same strings — but the
// indirection documents the contract and lets us catch/rewrite if it changes.)
export const RUNTIME_SPECIFIERS = [
  "preact",
  "preact/hooks",
  "preact/jsx-runtime",
  "preact/jsx-dev-runtime",
  "preact-render-to-string",
  "loki/runtime",
] as const;

const TRANSPILE_EXTENSIONS = /\.(tsx|ts|jsx|mjs|js)$/;

export function isTranspilable(path: string): boolean {
  return TRANSPILE_EXTENSIONS.test(path);
}

export interface TranspileResult {
  ok: boolean;
  code?: string;
  error?: string;
}

/** One serverFn export discovered statically in a module's source. */
export interface ServerFnExport {
  name: string;
  /** RPC transport verb the browser stub uses. Defaults to POST. */
  method: string;
}

export interface ClientBuildResult {
  ok: boolean;
  /**
   * The text to serve to the BROWSER for this module. `null` when the module
   * defines no serverFns (browser gets the normal compiled text unchanged).
   */
  clientCompiled?: string | null;
  error?: string;
}

/**
 * Transpile a single authored module. Non-transpilable files (e.g. `.graphql`,
 * `.css`) are passed through unchanged and never compiled.
 */
export function transpileModule(path: string, source: string): TranspileResult {
  if (!isTranspilable(path)) {
    // Not a JS/TS module — store as-is, no compiled output.
    return { ok: true, code: undefined };
  }
  try {
    const result = transform(source, {
      transforms: ["typescript", "jsx"],
      jsxRuntime: "automatic",
      jsxImportSource: "preact",
      filePath: path,
      production: true,
    });
    const rewritten = rewriteSpecifiers(result.code);
    // `loki/schema` is a TYPES-ONLY module — `import type { … }` (and imports
    // used only in type positions) are erased by sucrase and leave no runtime
    // specifier. If one survives transpile the author used a binding as a VALUE,
    // which cannot resolve at load time (there is no runtime loki/schema module).
    if (SCHEMA_SPECIFIER_RE.test(rewritten)) {
      return {
        ok: false,
        error:
          "loki/schema is types-only — it has no runtime module. Use a type-only " +
          'import: `import type { BlogPostRecord } from "loki/schema"`. It exposes ' +
          "content types (record interfaces, the Query root, filter/orderBy) for " +
          "annotating loaders and props; read the exact shapes with the " +
          "schema_types tool. Do not use its names as runtime values.",
      };
    }
    return { ok: true, code: withServerFnIds(path, rewritten) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

// Matches a surviving `loki/schema` module specifier in `from "…"` /
// `import(…)` position (a genuine value import — type-only imports are erased).
const SCHEMA_SPECIFIER_RE = /(\bfrom\s*|\bimport\s*\(\s*)(["'])loki\/schema\2/;

// Named top-level exports (const/let/var/function). Re-export lists and default
// exports are intentionally out of scope — serverFns must be NAMED exports.
const EXPORT_NAME_RE = /\bexport\s+(?:async\s+)?(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g;

// A serverFn export in its documented authored form:
//   export const NAME = serverFn({ method?: "..." }).validator(...).handler(...)
// Captures the export name and the (optional) config object literal so we can
// read `method`. Parsed from SOURCE (not the compiled text) — the shape is the
// contract we document, so this is deliberately simple and robust.
const SERVERFN_EXPORT_RE =
  /\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+?)?=\s*serverFn\b\s*(?:<[^>]*>)?\s*\(([^)]*)\)/g;

const SERVERFN_METHOD_RE = /\bmethod\s*:\s*["'`]([A-Za-z]+)["'`]/;

/**
 * Statically enumerate the serverFn exports of a module from its SOURCE, with
 * each one's declared RPC method (default POST). Only the documented authored
 * form is recognised — `export const NAME = serverFn({ method? }).…`.
 */
export function parseServerFnExports(source: string): ServerFnExport[] {
  const out: ServerFnExport[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  SERVERFN_EXPORT_RE.lastIndex = 0;
  while ((m = SERVERFN_EXPORT_RE.exec(source))) {
    const name = m[1];
    if (seen.has(name)) continue;
    seen.add(name);
    const config = m[2] || "";
    const method = (SERVERFN_METHOD_RE.exec(config)?.[1] || "POST").toUpperCase();
    out.push({ name, method });
  }
  return out;
}

/** Synthesize the browser-served stub module for a serverFn module. */
function synthesizeClientStub(path: string, fns: ServerFnExport[]): string {
  const lines = fns.map(
    (f) =>
      `export const ${f.name} = __lokiClientServerFn(` +
      `${JSON.stringify(path + "#" + f.name)},${JSON.stringify(f.method)});`,
  );
  return 'import { __lokiClientServerFn } from "loki/runtime";\n' + lines.join("\n") + "\n";
}

/**
 * Build the BROWSER-served text for a module. If the module defines any
 * serverFns, the browser must NOT receive the real handler/validator source
 * (it can contain secrets, gql strings, and server-only logic). Instead we
 * synthesize a stub module that exports only client RPC bindings keyed by each
 * serverFn's stable id + method — the isolate build stays full and unchanged.
 *
 * Convention (enforced): a serverFn module exports ONLY serverFns (and types).
 * Because the client build is fully synthesized from the serverFn export list,
 * any OTHER value export would silently vanish from the browser build — so we
 * REJECT it at write time and tell the author to move the serverFn(s) into their
 * own module (e.g. under `functions/`). Type-only exports are erased at
 * transpile and are fine.
 *
 * Returns `{ clientCompiled: null }` for modules with no serverFns.
 */
export function buildClientBuild(path: string, source: string): ClientBuildResult {
  if (!isTranspilable(path)) return { ok: true, clientCompiled: null };
  const fns = parseServerFnExports(source);
  if (fns.length === 0) return { ok: true, clientCompiled: null };

  // Collision guard: every VALUE export must be a serverFn. Value exports are
  // const/let/var/function named exports; `export default` and `export { … }`
  // lists are also value exports (and unsupported for serverFns). `export type`
  // / `export interface` are erased at transpile, so they never reach here.
  const serverFnNames = new Set(fns.map((f) => f.name));
  const offenders: string[] = [];
  let e: RegExpExecArray | null;
  EXPORT_NAME_RE.lastIndex = 0;
  while ((e = EXPORT_NAME_RE.exec(source))) {
    if (!serverFnNames.has(e[1])) offenders.push(e[1]);
  }
  const hasDefault = /\bexport\s+default\b/.test(source);
  const hasExportList = /\bexport\s*\{/.test(source);
  const hasStarReexport = /\bexport\s*\*/.test(source);
  if (offenders.length || hasDefault || hasExportList || hasStarReexport) {
    const extras = [
      ...new Set(offenders),
      ...(hasDefault ? ["default"] : []),
      ...(hasExportList ? ["{ … } re-export list"] : []),
      ...(hasStarReexport ? ["* re-export"] : []),
    ];
    return {
      ok: false,
      error:
        `${path} defines serverFn(s) [${[...serverFnNames].join(", ")}] but ALSO ` +
        `exports non-serverFn value(s): ${extras.join(", ")}. A serverFn module's ` +
        `browser build is SYNTHESIZED entirely from its serverFn exports, so any ` +
        `other value export would be DROPPED from the client build (and its source ` +
        `is deliberately never shipped to the browser). Move the serverFn(s) into ` +
        `a NEW module (e.g. functions/${(path.split("/").pop() ?? "module").replace(/\.[^.]+$/, "")}-fns.ts) that exports ` +
        `ONLY serverFns (and \`import type\` types), and import your component/` +
        `helper from elsewhere. This keeps handler source (secrets, gql, logic) off ` +
        `the client.`,
    };
  }

  return { ok: true, clientCompiled: synthesizeClientStub(path, fns) };
}

/**
 * Give every exported serverFn a stable id ("<path>#<exportName>") that is
 * identical in the isolate (server) and the browser build of the module, since
 * BOTH execute this same stored compiled text. A tiny epilogue tags each exported
 * binding that is a serverFn — the server registers itself for RPC dispatch, the
 * browser stub keeps the id to build its fetch URL. No-op for modules that don't
 * mention `serverFn` (keeps unrelated modules byte-for-byte unchanged).
 *
 * `typeof NAME !== "undefined"` guards make it robust: a name matched inside a
 * string/comment that isn't a real binding never throws (typeof on an undeclared
 * identifier is safe), and non-serverFn exports simply lack the brand.
 */
function withServerFnIds(path: string, code: string): string {
  if (!/\bserverFn\b/.test(code)) return code;
  const names: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  EXPORT_NAME_RE.lastIndex = 0;
  while ((m = EXPORT_NAME_RE.exec(code))) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      names.push(m[1]);
    }
  }
  if (names.length === 0) return code;
  const entries = names
    .map((n) => `[${JSON.stringify(path + "#" + n)},(typeof ${n}!=="undefined"?${n}:null)]`)
    .join(",");
  const epilogue =
    `\n;(function(){var __f=[${entries}];` +
    `for(var i=0;i<__f.length;i++){var e=__f[i];` +
    `if(e[1]&&e[1].__isLokiServerFn&&typeof e[1].__lokiSetId==="function")e[1].__lokiSetId(e[0]);}})();\n`;
  return code + epilogue;
}

/**
 * Sucrase's automatic runtime emits `import { jsx } from "preact/jsx-runtime"`.
 * That already matches our module-map key, so the rewrite is largely a no-op —
 * but we normalise `preact/jsx-dev-runtime` (dev builds) to the prod runtime
 * we actually vendor, and leave everything else intact. Kept as an explicit
 * seam so the module-map naming can diverge from author-facing names later.
 */
function rewriteSpecifiers(code: string): string {
  return code.replace(
    /(\bfrom\s*|\bimport\s*\(\s*)(["'])([^"']+)\2/g,
    (match, prefix, quote, spec) => {
      if (spec === "preact/jsx-dev-runtime") {
        return `${prefix}${quote}preact/jsx-runtime${quote}`;
      }
      return match;
    },
  );
}
