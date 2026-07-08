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
}

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
): Promise<number> {
  const res = await env.DB.prepare(
    "INSERT INTO site_versions (message, bundle, footprint) VALUES (?, ?, ?)",
  )
    .bind(message, JSON.stringify(bundle), JSON.stringify(footprint))
    .run();
  return Number(res.meta.last_row_id);
}

export async function getVersion(
  env: Env,
  id: number,
): Promise<SiteVersion | null> {
  return await env.DB.prepare(
    "SELECT id, created_at, message, bundle, footprint FROM site_versions WHERE id = ?",
  )
    .bind(id)
    .first<SiteVersion>();
}

export async function listVersions(
  env: Env,
): Promise<Array<Omit<SiteVersion, "bundle">>> {
  const { results } = await env.DB.prepare(
    "SELECT id, created_at, message, footprint FROM site_versions ORDER BY id DESC",
  ).all<Omit<SiteVersion, "bundle">>();
  return results ?? [];
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
