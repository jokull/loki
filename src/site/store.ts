// D1 access for the site ring: draft working tree (site_files), published
// snapshots (site_versions), and key/value state (site_state).

import type { Env } from "../env";

export interface SiteFile {
  path: string;
  source: string;
  compiled: string | null;
  /** Synthesized browser stub for serverFn modules; NULL otherwise. */
  client_compiled: string | null;
  updated_at: string;
}

export interface SiteVersion {
  id: number;
  created_at: string;
  message: string | null;
  bundle: string; // JSON: { [path]: compiledModule } (full, isolate-side)
  footprint: string | null; // JSON footprint
  assets: string | null; // JSON asset manifest: { [path]: AssetManifestEntry }
  /** JSON: { [path]: clientCompiled } — browser stubs for serverFn modules. */
  client_bundle: string | null;
  /** JSON DepSnapshot: resolved npm dep pins (esm.sh). NULL on legacy rows. */
  deps: string | null;
  /** JSON: { [path]: source } — verbatim authored source. NULL on legacy rows. */
  source_bundle: string | null;
}

// ---- resolved npm deps (site_deps lockfile + version snapshot) --------------

/** One resolver lockfile row (site_deps). */
export interface SiteDep {
  specifier: string;
  version: string;
  entry_key: string;
  /** JSON: { localKey: blobHash }. */
  module_manifest: string;
  dep_hash: string;
  created_at: string;
}

/** A resolved dep as snapshotted per version / assembled at serve time. */
export interface DepManifestEntry {
  version: string;
  entryKey: string;
  depHash: string;
  /** { localKey: blobHash } — every module in the self-contained set. */
  manifest: Record<string, string>;
}

/** Per-bundle resolved deps: specifier -> pin. */
export type DepSnapshot = Record<string, DepManifestEntry>;

/** Draft asset row (site_assets). `path` always starts with `public/`. */
export interface SiteAsset {
  path: string;
  hash: string;
  content_type: string;
  size: number;
  updated_at: string;
}

/** One entry in a published asset manifest (site_versions.assets JSON). */
export interface AssetManifestEntry {
  hash: string;
  contentType: string;
  size: number;
}

export type AssetManifest = Record<string, AssetManifestEntry>;

// ---- site_files (draft tree) -------------------------------------------------

export async function listFiles(env: Env): Promise<SiteFile[]> {
  const { results } = await env.DB.prepare(
    "SELECT path, source, compiled, client_compiled, updated_at FROM site_files ORDER BY path",
  ).all<SiteFile>();
  return results ?? [];
}

export async function readFile(env: Env, path: string): Promise<SiteFile | null> {
  return await env.DB.prepare(
    "SELECT path, source, compiled, client_compiled, updated_at FROM site_files WHERE path = ?",
  )
    .bind(path)
    .first<SiteFile>();
}

export async function writeFile(
  env: Env,
  path: string,
  source: string,
  compiled: string | null,
  clientCompiled: string | null,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO site_files (path, source, compiled, client_compiled, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(path) DO UPDATE SET
       source = excluded.source,
       compiled = excluded.compiled,
       client_compiled = excluded.client_compiled,
       updated_at = excluded.updated_at`,
  )
    .bind(path, source, compiled, clientCompiled)
    .run();
}

export async function deleteFile(env: Env, path: string): Promise<boolean> {
  const res = await env.DB.prepare("DELETE FROM site_files WHERE path = ?")
    .bind(path)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

// ---- site_versions (published snapshots) ------------------------------------

export async function insertVersion(
  env: Env,
  message: string | null,
  bundle: Record<string, string>,
  footprint: unknown,
  assets: AssetManifest,
  clientBundle: Record<string, string>,
  deps: DepSnapshot,
  sourceBundle: Record<string, string>,
): Promise<number> {
  const res = await env.DB.prepare(
    "INSERT INTO site_versions (message, bundle, footprint, assets, client_bundle, deps, source_bundle) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      message,
      JSON.stringify(bundle),
      JSON.stringify(footprint),
      JSON.stringify(assets),
      JSON.stringify(clientBundle),
      JSON.stringify(deps),
      JSON.stringify(sourceBundle),
    )
    .run();
  return Number(res.meta.last_row_id);
}

export async function getVersion(
  env: Env,
  id: number,
): Promise<SiteVersion | null> {
  return await env.DB.prepare(
    "SELECT id, created_at, message, bundle, footprint, assets, client_bundle, deps, source_bundle FROM site_versions WHERE id = ?",
  )
    .bind(id)
    .first<SiteVersion>();
}

/** Parse a version row's snapshotted source (empty on legacy pre-0006 rows). */
export function versionSourceBundle(
  version: SiteVersion,
): Record<string, string> {
  if (!version.source_bundle) return {};
  try {
    const parsed = JSON.parse(version.source_bundle) as Record<string, string>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Parse a version row's snapshotted dep pins (empty on legacy rows). */
export function versionDepSnapshot(version: SiteVersion): DepSnapshot {
  if (!version.deps) return {};
  try {
    const parsed = JSON.parse(version.deps) as DepSnapshot;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// ---- site_deps (resolver lockfile) ------------------------------------------

export async function getDep(
  env: Env,
  specifier: string,
): Promise<SiteDep | null> {
  return await env.DB.prepare(
    "SELECT specifier, version, entry_key, module_manifest, dep_hash, created_at FROM site_deps WHERE specifier = ?",
  )
    .bind(specifier)
    .first<SiteDep>();
}

export async function upsertDep(
  env: Env,
  specifier: string,
  version: string,
  entryKey: string,
  moduleManifest: Record<string, string>,
  depHash: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO site_deps (specifier, version, entry_key, module_manifest, dep_hash, created_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(specifier) DO UPDATE SET
       version = excluded.version,
       entry_key = excluded.entry_key,
       module_manifest = excluded.module_manifest,
       dep_hash = excluded.dep_hash,
       created_at = excluded.created_at`,
  )
    .bind(specifier, version, entryKey, JSON.stringify(moduleManifest), depHash)
    .run();
}

/** The lockfile row parsed into a DepManifestEntry (or null if unresolved). */
export async function getDepEntry(
  env: Env,
  specifier: string,
): Promise<DepManifestEntry | null> {
  const row = await getDep(env, specifier);
  if (!row) return null;
  let manifest: Record<string, string>;
  try {
    manifest = JSON.parse(row.module_manifest) as Record<string, string>;
  } catch {
    return null;
  }
  return {
    version: row.version,
    entryKey: row.entry_key,
    depHash: row.dep_hash,
    manifest,
  };
}

/** Parse a version row's snapshotted browser stubs (empty on legacy rows). */
export function versionClientBundle(
  version: SiteVersion,
): Record<string, string> {
  if (!version.client_bundle) return {};
  try {
    const parsed = JSON.parse(version.client_bundle) as Record<string, string>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Parse a version row's snapshotted asset manifest (empty on legacy rows). */
export function versionAssetManifest(version: SiteVersion): AssetManifest {
  if (!version.assets) return {};
  try {
    const parsed = JSON.parse(version.assets) as AssetManifest;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function listVersions(
  env: Env,
): Promise<Array<Omit<SiteVersion, "bundle">>> {
  const { results } = await env.DB.prepare(
    "SELECT id, created_at, message, footprint FROM site_versions ORDER BY id DESC",
  ).all<Omit<SiteVersion, "bundle">>();
  return results ?? [];
}

export interface DraftRestoreResult {
  files: number;
  assets: number;
  /** Paths whose source had to fall back to the compiled bundle (legacy version
   * with no source snapshot) — surfaced so the caller can warn. */
  compiledFallbackPaths: string[];
}

/**
 * Replace the entire draft working tree (site_files + site_assets) with the
 * given version's snapshot, reconstructing authored SOURCE byte-faithfully.
 *
 * A version row fully describes its tree: `source_bundle` (authored source),
 * `bundle` (path -> `compiled ?? source`), `client_bundle` (serverFn browser
 * stubs), and `assets` (path -> {hash,contentType,size}; blobs are immutable and
 * content-addressed in R2, so they need no restore). We rebuild each site_files
 * row so `source` matches what the agent authored and buildDraftBundle() then
 * reproduces the version's bundle exactly.
 *
 * Legacy versions published before source snapshots (source_bundle NULL, or a
 * path missing from it) can't restore true source; those paths fall back to the
 * compiled bundle text as source (listed in `compiledFallbackPaths`) so the
 * draft is still coherent and buildable.
 */
export async function restoreDraftFromVersion(
  env: Env,
  version: SiteVersion,
): Promise<DraftRestoreResult> {
  const bundle = JSON.parse(version.bundle) as Record<string, string>;
  const sourceBundle = versionSourceBundle(version);
  const clientBundle = versionClientBundle(version);
  const assets = versionAssetManifest(version);

  const compiledFallbackPaths: string[] = [];
  const fileRows = Object.keys(bundle).map((path) => {
    const bundled = bundle[path]; // compiled ?? source at publish time
    const fromSource = path in sourceBundle;
    if (!fromSource) compiledFallbackPaths.push(path);
    const source = fromSource ? sourceBundle[path] : bundled;
    // `compiled` is NULL when the bundle entry is just the raw-source fallback
    // (non-transpilable files); otherwise it is the transpiled ESM. Either way
    // buildDraftBundle()'s `compiled ?? source` reproduces `bundled` exactly.
    const compiled = bundled === source ? null : bundled;
    const clientCompiled = clientBundle[path] ?? null;
    return { path, source, compiled, clientCompiled };
  });

  // Full replace in one implicit transaction: the version is the whole tree.
  const stmts = [env.DB.prepare("DELETE FROM site_files")];
  for (const r of fileRows) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO site_files (path, source, compiled, client_compiled, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))`,
      ).bind(r.path, r.source, r.compiled, r.clientCompiled),
    );
  }
  stmts.push(env.DB.prepare("DELETE FROM site_assets"));
  for (const [path, a] of Object.entries(assets)) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO site_assets (path, hash, content_type, size, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))`,
      ).bind(path, a.hash, a.contentType, a.size),
    );
  }
  await env.DB.batch(stmts);

  return {
    files: fileRows.length,
    assets: Object.keys(assets).length,
    compiledFallbackPaths,
  };
}

// ---- site_assets (draft asset tree) -----------------------------------------

export async function listAssets(env: Env): Promise<SiteAsset[]> {
  const { results } = await env.DB.prepare(
    "SELECT path, hash, content_type, size, updated_at FROM site_assets ORDER BY path",
  ).all<SiteAsset>();
  return results ?? [];
}

export async function readAsset(
  env: Env,
  path: string,
): Promise<SiteAsset | null> {
  return await env.DB.prepare(
    "SELECT path, hash, content_type, size, updated_at FROM site_assets WHERE path = ?",
  )
    .bind(path)
    .first<SiteAsset>();
}

export async function upsertAsset(
  env: Env,
  path: string,
  hash: string,
  contentType: string,
  size: number,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO site_assets (path, hash, content_type, size, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(path) DO UPDATE SET
       hash = excluded.hash,
       content_type = excluded.content_type,
       size = excluded.size,
       updated_at = excluded.updated_at`,
  )
    .bind(path, hash, contentType, size)
    .run();
}

export async function deleteAsset(env: Env, path: string): Promise<boolean> {
  const res = await env.DB.prepare("DELETE FROM site_assets WHERE path = ?")
    .bind(path)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/** Build the draft asset manifest (path -> {hash,contentType,size}). */
export async function buildDraftAssetManifest(env: Env): Promise<AssetManifest> {
  const rows = await listAssets(env);
  const manifest: AssetManifest = {};
  for (const r of rows) {
    manifest[r.path] = {
      hash: r.hash,
      contentType: r.content_type,
      size: r.size,
    };
  }
  return manifest;
}

// ---- site_state (key/value) --------------------------------------------------

export async function getState(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM site_state WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function setState(
  env: Env,
  key: string,
  value: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO site_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  )
    .bind(key, value)
    .run();
}

export async function getPublishedVersionId(env: Env): Promise<number | null> {
  const v = await getState(env, "published_version");
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
