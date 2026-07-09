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
          'loki/schema is types-only — it has no runtime module. Use a type-only ' +
          'import: `import type { BlogPostRecord } from "loki/schema"`. It exposes ' +
          "content types (record interfaces, the Query root, filter/orderBy) for " +
          "annotating loaders and props; read the exact shapes with the " +
          "schema_types tool. Do not use its names as runtime values.",
      };
    }
    return { ok: true, code: rewritten };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

// Matches a surviving `loki/schema` module specifier in `from "…"` /
// `import(…)` position (a genuine value import — type-only imports are erased).
const SCHEMA_SPECIFIER_RE =
  /(\bfrom\s*|\bimport\s*\(\s*)(["'])loki\/schema\2/;

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
