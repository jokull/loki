// npm-dependency resolver: esm.sh snapshot of a bare import specifier.
//
// THESIS: an agent just `import`s a package; Loki resolves + snapshots it via
// esm.sh in the SUPERVISOR (which has network) at write/publish time and serves
// a self-contained, version-pinned module set into the site isolate — no
// userland npm install, no bundler.
//
// General mechanism (Drizzle is the spike's test package):
//  1. Pin a concrete version and fetch `<spec>?bundle&target=es2022`. On a
//     package SUBPATH that yields (essentially) one self-contained file; on a
//     package ROOT `?bundle` does NOT inline, so we recursively CRAWL every
//     imported esm.sh URL, save each locally, and rewrite specifiers to relative
//     local module keys (ported from the de-risking probe's crawl.mjs).
//  2. Dead `/node/*` esm.sh polyfill imports (e.g. an unused `/node/buffer.mjs`
//     in sqlite-core) are rewritten to a shared empty stub — the isolate has NO
//     nodejs_compat, and these imports are unused.
//  3. The result has ZERO esm.sh import references (banners stripped too). Each
//     module's bytes are content-addressed in R2 at `site/dep/<sha256>` (mirrors
//     static-assets.ts), and a pin is recorded in the `site_deps` lockfile so
//     publishes are reproducible.
//
// The set is injected into the isolate module map namespaced by content hash
// (`deps/<depHash>/<localKey>`) and the author's bare import is rewritten to the
// entry module key (see bundle.ts). For the spike the resolver is GATED to the
// `drizzle-orm` scope, but nothing here is drizzle-specific.

import type { Env } from "../env";
import type { DepManifestEntry, DepSnapshot } from "./store";
import { getDepEntry, upsertDep } from "./store";

const ESM_ORIGIN = "https://esm.sh";
const DEP_BLOB_PREFIX = "site/dep/";

/**
 * Resolver allowlist for the spike. A bare specifier is resolvable iff it is the
 * `drizzle-orm` package or one of its subpaths. Broadening the spike to more
 * packages is a one-line change here — the machinery is package-agnostic.
 */
const ALLOWED_SCOPES = ["drizzle-orm"];

/** Built-in specifiers Loki injects itself — never resolved via esm.sh. */
export const BUILTIN_SPECIFIERS = new Set<string>([
  "preact",
  "preact/hooks",
  "preact/jsx-runtime",
  "preact/jsx-dev-runtime",
  "preact-render-to-string",
  "loki/runtime",
  "loki/schema",
]);

/** True for a bare specifier (not relative, not absolute, not a URL/node:). */
export function isBareSpecifier(spec: string): boolean {
  if (!spec) return false;
  if (spec.startsWith(".") || spec.startsWith("/")) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(spec)) return false; // node:, http:, data:
  return true;
}

/** True if `spec` is within an allowlisted resolver scope (pkg or pkg/sub). */
export function isAllowedDep(spec: string): boolean {
  return ALLOWED_SCOPES.some((s) => spec === s || spec.startsWith(s + "/"));
}

export function allowedScopesDoc(): string {
  return ALLOWED_SCOPES.join(", ");
}

// Matches an ES import/export-from/dynamic-import specifier (single or double
// quoted). Mirrors the probe crawler's regex; used on SOURCE and on esm.sh code.
const SPEC_RE =
  /(?:(?:import|export)\b[^'"()]*?\bfrom\s*|(?:import|export)\s*|\bimport\s*\(\s*)(['"])([^'"]+)\1/g;

/** Every distinct bare specifier imported by a source module. */
export function parseBareImports(source: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  SPEC_RE.lastIndex = 0;
  while ((m = SPEC_RE.exec(source))) {
    const spec = m[2];
    if (isBareSpecifier(spec)) out.add(spec);
  }
  return [...out];
}

/**
 * Bare specifiers a bundle imports that fall in the resolver allowlist AND are
 * not Loki built-ins. These are the deps that must be assembled into the isolate.
 */
export function collectAllowedDepSpecifiers(
  bundle: Record<string, string>,
): string[] {
  const out = new Set<string>();
  for (const code of Object.values(bundle)) {
    for (const spec of parseBareImports(code)) {
      if (BUILTIN_SPECIFIERS.has(spec)) continue;
      if (isAllowedDep(spec)) out.add(spec);
    }
  }
  return [...out];
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeUrl(u: string): string {
  const url = new URL(u);
  url.hash = "";
  return url.toString();
}

/** Package name for a specifier: `@scope/name` or `name` (drop any subpath). */
function packageNameOf(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Strip esm.sh banner comments so no `esm.sh` reference survives, even in text. */
function stripBanners(code: string): string {
  return code.replace(/\/\*\s*esm\.sh[^*]*\*\/\s*/g, "");
}

export interface ResolvedDep {
  specifier: string;
  version: string;
  entryKey: string;
  depHash: string;
  /** localKey -> code, the full self-contained set. */
  modules: Record<string, string>;
  /** localKey -> blobHash. */
  manifest: Record<string, string>;
  files: number;
  bytes: number;
}

class DepResolveError extends Error {}

/**
 * Crawl the esm.sh module graph for `specifier`, producing a self-contained
 * module set with zero esm.sh references. Pins the concrete version off the
 * fetched code. Throws DepResolveError with an agent-legible message on failure
 * (not found / not ESM / needs a node builtin / unresolved reference).
 */
async function crawlEsm(specifier: string): Promise<{
  version: string;
  entryKey: string;
  modules: Record<string, string>;
}> {
  const startUrl = `${ESM_ORIGIN}/${specifier}?bundle&target=es2022`;

  const urlToLocal = new Map<string, string>();
  const taken = new Set<string>();
  const modules: Record<string, string> = {};
  const processed = new Set<string>();
  const queue: string[] = [];

  // Pin the concrete version off the RAW esm.sh text (the banner + versioned
  // import paths carry `<pkg>@<ver>`), captured BEFORE we strip banners and
  // rewrite specifiers to local paths (which would erase the version).
  const pkg = packageNameOf(specifier);
  const verRe = new RegExp(
    pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "@(\\d[^/\\s\"']*)",
  );
  let version = "unknown";

  function localNameFor(u: string): string {
    const existing = urlToLocal.get(u);
    if (existing) return existing;
    const url = new URL(u);
    let base = (url.pathname.split("/").pop() || "mod").replace(/\.m?js$/, "");
    let name = base.replace(/[^a-zA-Z0-9._-]/g, "_");
    if (url.search) {
      // Deterministic short suffix from the query (hex of the search string).
      let hex = "";
      for (const ch of url.search) hex += ch.charCodeAt(0).toString(16);
      name += "__" + hex.slice(0, 8);
    }
    name = name + ".mjs";
    let final = name;
    let i = 1;
    while (taken.has(final)) final = name.replace(/\.mjs$/, "_" + i++ + ".mjs");
    taken.add(final);
    urlToLocal.set(u, final);
    return final;
  }

  async function processUrl(u: string): Promise<void> {
    const norm = normalizeUrl(u);
    const localName = localNameFor(norm);
    let res: Response;
    try {
      res = await fetch(norm);
    } catch (err) {
      throw new DepResolveError(
        `Failed to fetch ${norm}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (res.status === 404) {
      throw new DepResolveError(
        `esm.sh has no module at ${norm} (HTTP 404) — check the specifier "${specifier}".`,
      );
    }
    if (!res.ok) {
      throw new DepResolveError(`esm.sh returned HTTP ${res.status} for ${norm}.`);
    }
    const ctype = res.headers.get("content-type") || "";
    const src = await res.text();
    if (version === "unknown") {
      const vm = verRe.exec(src);
      if (vm) version = vm[1];
    }
    if (!/javascript|ecmascript|typescript/i.test(ctype) && !/^\s*(?:\/\*|import|export|\/\/)/.test(src)) {
      throw new DepResolveError(
        `${norm} did not return an ES module (content-type "${ctype}"). The ` +
          `package may not be ESM-compatible.`,
      );
    }

    const deps: string[] = [];
    const out = src.replace(SPEC_RE, (whole, _q, spec) => {
      if (!/^(https?:|\/|\.)/.test(spec)) return whole; // bare
      if (spec.startsWith("node:")) return whole; // real node: builtin (kept)
      let abs: string;
      try {
        abs = normalizeUrl(new URL(spec, norm).toString());
      } catch {
        return whole;
      }
      if (!abs.startsWith(ESM_ORIGIN)) return whole;
      // Everything under the esm.sh origin — including `/node/*` polyfills — is
      // crawled and inlined. esm.sh's node polyfills (e.g. `/node/buffer.mjs`)
      // are self-contained pure-JS modules that export real bindings (Buffer,
      // …), so a package that imports `{ Buffer }` links correctly with NO
      // nodejs_compat on the isolate. (A polyfill that itself pulls a `node:`
      // builtin would surface as a load-time failure — the correct signal that
      // the package isn't workerd-compatible.)
      deps.push(abs);
      return whole.replace(spec, "./" + localNameFor(abs));
    });

    modules[localName] = stripBanners(out);
    for (const d of deps) {
      if (!processed.has(d)) {
        processed.add(d);
        queue.push(d);
      }
    }
  }

  // Fetch the entry first (via its final URL after any redirect) so the version
  // pin is read from real code.
  const startNorm = normalizeUrl(startUrl);
  processed.add(startNorm);
  queue.push(startNorm);
  const entryKey = localNameFor(startNorm);
  let guard = 0;
  while (queue.length) {
    if (++guard > 500) {
      throw new DepResolveError(
        `Dependency graph for "${specifier}" exceeded 500 modules — refusing to snapshot.`,
      );
    }
    await processUrl(queue.shift()!);
  }

  // Final safety net: no esm.sh import reference may survive anywhere.
  for (const [key, code] of Object.entries(modules)) {
    SPEC_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SPEC_RE.exec(code))) {
      const spec = m[2];
      if (spec.startsWith("node:") || spec.startsWith("./") || spec.startsWith("../")) continue;
      if (/^(https?:|\/)/.test(spec) || spec.includes("esm.sh")) {
        throw new DepResolveError(
          `Unresolved esm.sh reference "${spec}" remained in ${key} after crawl.`,
        );
      }
    }
  }

  return { version, entryKey, modules };
}

/**
 * Resolve + snapshot a dep: crawl esm.sh, content-address every module in R2,
 * and upsert the lockfile pin. Idempotent — re-storing identical bytes is a HEAD
 * + skip. Returns the ResolvedDep for write-time feedback. Runs in the SUPERVISOR.
 */
export async function resolveDep(
  env: Env,
  specifier: string,
): Promise<ResolvedDep> {
  if (!isBareSpecifier(specifier)) {
    throw new DepResolveError(`"${specifier}" is not a bare package specifier.`);
  }
  if (BUILTIN_SPECIFIERS.has(specifier)) {
    throw new DepResolveError(
      `"${specifier}" is a Loki built-in, not an npm dependency.`,
    );
  }
  if (!isAllowedDep(specifier)) {
    throw new DepResolveError(
      `Dependency "${specifier}" is not in the resolver allowlist. ` +
        `Allowed for now: ${allowedScopesDoc()} (and their subpaths).`,
    );
  }

  const { version, entryKey, modules } = await crawlEsm(specifier);

  // Content-address each module in R2.
  const manifest: Record<string, string> = {};
  let bytes = 0;
  for (const [localKey, code] of Object.entries(modules)) {
    const blobHash = await sha256Hex(code);
    manifest[localKey] = blobHash;
    bytes += new TextEncoder().encode(code).length;
    const objKey = DEP_BLOB_PREFIX + blobHash;
    const existing = await env.ASSETS.head(objKey);
    if (!existing) {
      await env.ASSETS.put(objKey, code, {
        httpMetadata: { contentType: "text/javascript; charset=utf-8" },
      });
    }
    // Warm the in-memory cache so a subsequent serve is immediate.
    DEP_CODE_CACHE.set(blobHash, code);
  }

  const depHash = await sha256Hex(
    JSON.stringify({
      specifier,
      version,
      entryKey,
      manifest: Object.keys(manifest)
        .sort()
        .map((k) => [k, manifest[k]]),
    }),
  );

  await upsertDep(env, specifier, version, entryKey, manifest, depHash);

  return {
    specifier,
    version,
    entryKey,
    depHash,
    modules,
    manifest,
    files: Object.keys(modules).length,
    bytes,
  };
}

// Content-addressed dep module bytes are immutable, so this per-isolate cache
// (keyed by blobHash) is safe to keep for the isolate's lifetime.
const DEP_CODE_CACHE = new Map<string, string>();

async function loadDepCode(env: Env, blobHash: string): Promise<string> {
  const cached = DEP_CODE_CACHE.get(blobHash);
  if (cached != null) return cached;
  const obj = await env.ASSETS.get(DEP_BLOB_PREFIX + blobHash);
  if (!obj) {
    throw new Error(`Dep blob ${blobHash} missing from R2 (site/dep/).`);
  }
  const code = await obj.text();
  DEP_CODE_CACHE.set(blobHash, code);
  return code;
}

export interface AssembledDeps {
  /** isolate module-map key -> code, namespaced `deps/<depHash>/<localKey>`. */
  depModules: Record<string, string>;
  /** author specifier -> entry module-map key (for import rewriting). */
  specifierMap: Record<string, string>;
}

/**
 * Assemble a DepSnapshot into isolate modules + a specifier->entryKey rewrite
 * map. Loads module bytes from R2 (cached). depHash namespacing pins exact
 * content, so different pins never collide and published isolates are byte-exact.
 */
export async function assembleDeps(
  env: Env,
  snapshot: DepSnapshot,
): Promise<AssembledDeps> {
  const depModules: Record<string, string> = {};
  const specifierMap: Record<string, string> = {};
  for (const [specifier, entry] of Object.entries(snapshot)) {
    const ns = `deps/${entry.depHash}/`;
    for (const [localKey, blobHash] of Object.entries(entry.manifest)) {
      depModules[ns + localKey] = await loadDepCode(env, blobHash);
    }
    specifierMap[specifier] = ns + entry.entryKey;
  }
  return { depModules, specifierMap };
}

/**
 * Build the DepSnapshot for a DRAFT bundle: for each allowlisted bare specifier
 * the bundle imports, read its lockfile pin. A specifier with no pin means it was
 * never resolved (shouldn't happen post-write) and is skipped — the isolate will
 * then fail loudly on the unresolved import, which is the correct signal.
 */
export async function draftDepSnapshot(
  env: Env,
  bundle: Record<string, string>,
): Promise<DepSnapshot> {
  const snapshot: DepSnapshot = {};
  for (const specifier of collectAllowedDepSpecifiers(bundle)) {
    const entry = await getDepEntry(env, specifier);
    if (entry) snapshot[specifier] = entry;
  }
  return snapshot;
}

export type { DepManifestEntry };
