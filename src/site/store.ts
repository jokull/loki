// D1 access for the site ring: draft working tree (site_files), published
// snapshots (site_versions), and key/value state (site_state).

import type { Env } from "../env";

export interface SiteFile {
  path: string;
  source: string;
  compiled: string | null;
  updated_at: string;
}

export interface SiteVersion {
  id: number;
  created_at: string;
  message: string | null;
  bundle: string; // JSON: { [path]: compiledModule }
  footprint: string | null; // JSON footprint
  assets: string | null; // JSON asset manifest: { [path]: AssetManifestEntry }
}

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
    "SELECT path, source, compiled, updated_at FROM site_files ORDER BY path",
  ).all<SiteFile>();
  return results ?? [];
}

export async function readFile(env: Env, path: string): Promise<SiteFile | null> {
  return await env.DB.prepare(
    "SELECT path, source, compiled, updated_at FROM site_files WHERE path = ?",
  )
    .bind(path)
    .first<SiteFile>();
}

export async function writeFile(
  env: Env,
  path: string,
  source: string,
  compiled: string | null,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO site_files (path, source, compiled, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(path) DO UPDATE SET
       source = excluded.source,
       compiled = excluded.compiled,
       updated_at = excluded.updated_at`,
  )
    .bind(path, source, compiled)
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
): Promise<number> {
  const res = await env.DB.prepare(
    "INSERT INTO site_versions (message, bundle, footprint, assets) VALUES (?, ?, ?, ?)",
  )
    .bind(
      message,
      JSON.stringify(bundle),
      JSON.stringify(footprint),
      JSON.stringify(assets),
    )
    .run();
  return Number(res.meta.last_row_id);
}

export async function getVersion(
  env: Env,
  id: number,
): Promise<SiteVersion | null> {
  return await env.DB.prepare(
    "SELECT id, created_at, message, bundle, footprint, assets FROM site_versions WHERE id = ?",
  )
    .bind(id)
    .first<SiteVersion>();
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
