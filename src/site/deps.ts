// npm-dependency resolver: esm.sh snapshot of a bare import specifier.
//
// THESIS: an agent just `import`s ANY package; Loki resolves + snapshots it via
// esm.sh in the SUPERVISOR (which has network) at write/publish time and serves
// a self-contained, version-pinned module set into the site isolate — no
// userland npm install, no bundler. There is NO name-based allowlist: any bare
// specifier that isn't a Loki built-in is a candidate, and Loki EMPIRICALLY
// determines whether it is supported by TEST-LOADING the snapshot in a throwaway
// isolate (see loadable() below) — the isolate is workerd with NO nodejs_compat,
// so a package needing Node builtins fails legibly rather than being pre-judged.
//
// General mechanism:
//  1. Pin a concrete version and fetch `<spec>?bundle&target=es2022`. On a
//     package SUBPATH that yields (essentially) one self-contained file; on a
//     package ROOT `?bundle` does NOT inline, so we recursively CRAWL every
//     imported esm.sh URL, save each locally, and rewrite specifiers to relative
//     local module keys (ported from the de-risking probe's crawl.mjs).
//  2. esm.sh's `/node/*` polyfill imports are crawled + inlined like any other
//     esm.sh module. A polyfill that itself pulls a real `node:` builtin surfaces
//     at test-load as the correct "not workerd-compatible" signal.
//  3. The result has ZERO esm.sh import references (banners stripped too). Each
//     module's bytes are content-addressed in R2 at `site/dep/<sha256>` (mirrors
//     static-assets.ts), and a pin is recorded in the `site_deps` lockfile so
//     publishes are reproducible.
//
// The set is injected into the isolate module map namespaced by content hash
// (`deps/<depHash>/<localKey>`) and the author's bare import is rewritten to the
// entry module key (see bundle.ts).

import type { Env } from "../env";
import type { DepManifestEntry, DepSnapshot } from "./store";
import { getDepEntry, getState, setState, upsertDep } from "./store";
import { COMPAT_DATE } from "./bundle";

const ESM_ORIGIN = "https://esm.sh";
const DEP_BLOB_PREFIX = "site/dep/";

// ---- Guardrails (fail legibly, never hang or store a monster) ----------------

/** Per-esm.sh-fetch timeout. A slow/hung esm.sh call aborts with a clear error. */
const ESM_FETCH_TIMEOUT_MS = 15_000;
/** Max modules in a single package's crawled set before we refuse to snapshot. */
const MAX_DEP_FILES = 400;
/** Max total bytes of a package's crawled module set before we refuse. */
const MAX_DEP_BYTES = 8 * 1024 * 1024; // 8 MB
/** Hard cap on crawl iterations (belt-and-braces vs. a pathological graph). */
const MAX_CRAWL_MODULES = 500;

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
 * Every bare specifier a bundle imports that is NOT a Loki built-in — i.e. every
 * candidate npm dep that must be resolved + assembled into the isolate. There is
 * no name allowlist: support is determined empirically by test-load at resolve
 * time, so any bare, non-built-in specifier is a dep candidate here.
 */
export function collectDepSpecifiers(
  bundle: Record<string, string>,
): string[] {
  const out = new Set<string>();
  for (const code of Object.values(bundle)) {
    for (const spec of parseBareImports(code)) {
      if (BUILTIN_SPECIFIERS.has(spec)) continue;
      out.add(spec);
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
  /** Always true for a returned dep — resolveDep throws when the test-load fails. */
  loadable: true;
}

class DepResolveError extends Error {}

interface LoadableResult {
  loadable: boolean;
  /** Concise, agent-legible reason when `loadable` is false. */
  reason?: string;
}

// Per-isolate cache of test-load verdicts, keyed by content-addressed depHash.
// A dep's module set is immutable under its hash, so a verdict never goes stale.
const LOADABLE_CACHE = new Map<string, LoadableResult>();
const LOADABLE_STATE_PREFIX = "deploadable:";

/**
 * Empirically decide whether a snapshotted dep is usable in the site isolate by
 * TEST-LOADING it in a throwaway, non-cached dynamic isolate (`env.LOADER.load`)
 * — runs in the SUPERVISOR only (the site sandbox has no LOADER). A tiny probe
 * module imports the dep's entry module and touches its namespace + default
 * export, forcing the module graph to link AND top-level-execute. If it links and
 * runs → loadable. If linking/executing throws (a `node:` builtin the isolate
 * lacks, a missing binding, non-ESM) → not loadable, with a trimmed reason.
 *
 * Cached by depHash (in-memory + site_state) so it is not re-run on every write.
 */
async function loadable(
  env: Env,
  siteId: string,
  depHash: string,
  entryKey: string,
  modules: Record<string, string>,
): Promise<LoadableResult> {
  const cached = LOADABLE_CACHE.get(depHash);
  if (cached) return cached;
  const persisted = await getState(env, siteId, LOADABLE_STATE_PREFIX + depHash);
  if (persisted) {
    try {
      const parsed = JSON.parse(persisted) as LoadableResult;
      LOADABLE_CACHE.set(depHash, parsed);
      return parsed;
    } catch {
      // fall through and re-run
    }
  }

  // Build a throwaway worker whose modules are the dep's own set keyed by their
  // flat localKeys (their internal imports are already relative `./localKey`),
  // plus a probe main module that imports the entry and exercises its exports.
  const probeModules: Record<string, { js: string }> = {};
  for (const [localKey, code] of Object.entries(modules)) {
    probeModules[localKey] = { js: code };
  }
  const PROBE = "__loki_probe.js";
  probeModules[PROBE] = {
    js:
      `import * as __ns from ${JSON.stringify("./" + entryKey)};\n` +
      `export default {\n` +
      `  fetch() {\n` +
      // Touch the namespace + default so the linker cannot dead-strip the import
      // and the module's top-level code is forced to have executed.
      `    const __k = Object.keys(__ns).length;\n` +
      `    void __ns.default; void __k;\n` +
      `    return new Response("ok");\n` +
      `  },\n` +
      `};\n`,
  };

  const result = await runProbe(env, PROBE, probeModules);
  LOADABLE_CACHE.set(depHash, result);
  await setState(env, siteId, LOADABLE_STATE_PREFIX + depHash, JSON.stringify(result));
  return result;
}

/** Load + fetch the probe isolate, mapping any link/exec failure to a reason. */
async function runProbe(
  env: Env,
  mainModule: string,
  modules: Record<string, { js: string }>,
): Promise<LoadableResult> {
  try {
    const stub = env.LOADER.load({
      compatibilityDate: COMPAT_DATE,
      mainModule,
      modules,
      env: {},
      globalOutbound: null,
    });
    const res = await stub.getEntrypoint().fetch(new Request("https://probe.internal/"));
    // Any HTTP response (even non-2xx) means the graph linked + executed.
    await res.body?.cancel().catch(() => {});
    return { loadable: true };
  } catch (err) {
    return { loadable: false, reason: describeLoadFailure(err) };
  }
}

/** Turn a raw test-load error into a concise, actionable one-liner. */
function describeLoadFailure(err: unknown): string {
  const raw = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim();
  // A missing Node builtin is the canonical "not workerd-compatible" case.
  const nodeMatch = raw.match(/(?:no such module|cannot find module|module not found)[^"']*["']?(node:[a-z/]+)/i)
    || raw.match(/["'](node:[a-z/]+)["']/i)
    || raw.match(/\b(node:[a-z/]+)\b/i);
  if (nodeMatch) {
    return `imports "${nodeMatch[1]}", a Node builtin that isn't available in workerd (no nodejs_compat).`;
  }
  if (/no such module|cannot find module|module not found|unresolved/i.test(raw)) {
    return `a module in its graph failed to resolve in workerd: ${raw.slice(0, 240)}`;
  }
  if (/is not( a)? (valid )?(es ?module|module)|unexpected|not esm/i.test(raw)) {
    return `it is not workerd-loadable ES module code: ${raw.slice(0, 240)}`;
  }
  return raw.slice(0, 280) || "unknown test-load failure";
}

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
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ESM_FETCH_TIMEOUT_MS);
    try {
      res = await fetch(norm, { signal: ac.signal });
    } catch (err) {
      if (ac.signal.aborted) {
        throw new DepResolveError(
          `Timed out after ${ESM_FETCH_TIMEOUT_MS}ms fetching ${norm} from esm.sh.`,
        );
      }
      throw new DepResolveError(
        `Failed to fetch ${norm}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 404) {
      throw new DepResolveError(
        `package "${specifier}" not found on esm.sh (HTTP 404 for ${norm}).`,
      );
    }
    if (!res.ok) {
      throw new DepResolveError(
        `package "${specifier}" not resolvable on esm.sh — HTTP ${res.status} for ${norm}.`,
      );
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
    if (++guard > MAX_CRAWL_MODULES) {
      throw new DepResolveError(
        `package "${specifier}" too large to snapshot: dependency graph exceeded ` +
          `${MAX_CRAWL_MODULES} modules.`,
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
 * Resolve + snapshot a dep: crawl esm.sh, TEST-LOAD the snapshot in a throwaway
 * isolate to confirm it is workerd-compatible, then content-address every module
 * in R2 and upsert the lockfile pin. Idempotent — re-storing identical bytes is a
 * HEAD + skip. Runs in the SUPERVISOR (which alone has network + LOADER).
 *
 * Throws DepResolveError — with a concise, actionable reason — on any failure:
 * not found, too large, or NOT LOADABLE (e.g. needs a Node builtin). On a
 * not-loadable dep NOTHING is persisted (no R2 blobs, no lockfile pin), so the
 * draft tree never holds a broken pin.
 */
export async function resolveDep(
  env: Env,
  siteId: string,
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

  const { version, entryKey, modules } = await crawlEsm(specifier);

  // Guardrail: refuse to snapshot a monster. Computed on the crawled set BEFORE
  // any R2 write so a huge package never lands in the store.
  const files = Object.keys(modules).length;
  let bytes = 0;
  for (const code of Object.values(modules)) {
    bytes += new TextEncoder().encode(code).length;
  }
  if (files > MAX_DEP_FILES || bytes > MAX_DEP_BYTES) {
    throw new DepResolveError(
      `package "${specifier}" too large to snapshot: ${files} files / ${bytes} bytes ` +
        `(limit ${MAX_DEP_FILES} files / ${MAX_DEP_BYTES} bytes).`,
    );
  }

  // Content-address hashes in memory (no R2 write yet) so we can compute depHash
  // and gate persistence on the test-load verdict.
  const manifest: Record<string, string> = {};
  for (const [localKey, code] of Object.entries(modules)) {
    manifest[localKey] = await sha256Hex(code);
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

  // Empirically confirm the snapshot loads in a workerd isolate (cached by
  // depHash). REJECT — persisting nothing — when it doesn't.
  const verdict = await loadable(env, siteId, depHash, entryKey, modules);
  if (!verdict.loadable) {
    throw new DepResolveError(
      `package "${specifier}@${version}" is not workerd-compatible: ${verdict.reason}`,
    );
  }

  // Loadable — now persist the content-addressed bytes + the lockfile pin.
  for (const [localKey, code] of Object.entries(modules)) {
    const blobHash = manifest[localKey];
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

  await upsertDep(env, siteId, specifier, version, entryKey, manifest, depHash);

  return {
    specifier,
    version,
    entryKey,
    depHash,
    modules,
    manifest,
    files,
    bytes,
    loadable: true,
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
 * Build the DepSnapshot for a DRAFT bundle: for each candidate bare specifier
 * the bundle imports, read its lockfile pin. A specifier with no pin means it was
 * never resolved (shouldn't happen post-write) and is skipped — the isolate will
 * then fail loudly on the unresolved import, which is the correct signal.
 */
export async function draftDepSnapshot(
  env: Env,
  siteId: string,
  bundle: Record<string, string>,
): Promise<DepSnapshot> {
  const snapshot: DepSnapshot = {};
  for (const specifier of collectDepSpecifiers(bundle)) {
    const entry = await getDepEntry(env, siteId, specifier);
    if (entry) snapshot[specifier] = entry;
  }
  return snapshot;
}

export type { DepManifestEntry };
