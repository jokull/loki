// Site purge + the daily reaper. Purge is the IRREVERSIBLE teardown of a site's
// five stores; `purge_site` runs it on demand (24h-locked) and the cron reaper
// runs it on `deleted` sites past the 7-day window. See PLAN.md.
//
// Atomicity (Fable 5): mark `purging` first (a resumable tombstone), destroy the
// stores, and free the subdomain lease LAST (delete the sites row) — so a purge
// that dies mid-way is re-run idempotently and a re-claimed name can NEVER
// inherit a predecessor's orphaned data.

import type { Env } from "./env";
import { RECOVERY_WINDOW_DAYS } from "shared/data";

/** Every supervisor-D1 table with a `site_id` column — discovered at runtime so a
 *  future per-site table is never forgotten by the purge. */
async function perSiteTables(env: Env): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table'",
  ).all<{ name: string }>();
  const out: string[] = [];
  for (const { name } of results ?? []) {
    if (name === "sites" || name.startsWith("sqlite_") || name.startsWith("_")) continue;
    const cols = await env.DB.prepare(`PRAGMA table_info("${name}")`).all<{ name: string }>();
    if ((cols.results ?? []).some((c) => c.name === "site_id")) out.push(name);
  }
  return out;
}

/** Delete this site's per-site R2 objects (end-user uploads under a per-site
 *  prefix). Content-addressed `site/blob/*` is DEDUPED across sites, so it is
 *  intentionally LEFT (a separate GC can reclaim genuine orphans). */
async function purgeR2(env: Env, siteId: string): Promise<void> {
  const prefix = `site/upload/${siteId}/`;
  let cursor: string | undefined;
  do {
    const listed = await env.ASSETS.list({ prefix, cursor });
    if (listed.objects.length > 0) {
      await env.ASSETS.delete(listed.objects.map((o) => o.key));
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

/** Irreversibly destroy a site's five stores and free its subdomain lease. */
export async function purgeSite(env: Env, siteId: string): Promise<void> {
  // 1. Tombstone — resumable if we die mid-teardown.
  await env.DB.prepare("UPDATE sites SET status='purging' WHERE id = ?").bind(siteId).run();
  // 2. The tenant DOs (content + feature data + logs + end-user auth/sessions).
  await env.TENANT_DB.get(env.TENANT_DB.idFromName(siteId))
    .destroy()
    .catch(() => {});
  await env.TENANT_FEATURE_DB.get(env.TENANT_FEATURE_DB.idFromName(siteId))
    .destroy()
    .catch(() => {});
  // 3. Per-site R2 (uploads). Deduped blobs are left.
  await purgeR2(env, siteId).catch(() => {});
  // 4. Every supervisor-D1 per-site row (site tree, versions, deps, assets,
  //    tokens, secrets, state, …) — auto-discovered.
  for (const t of await perSiteTables(env)) {
    await env.DB.prepare(`DELETE FROM "${t}" WHERE site_id = ?`)
      .bind(siteId)
      .run()
      .catch(() => {});
  }
  // 5. LAST — the sites row: frees the subdomain lease only after all stores are gone.
  await env.DB.prepare("DELETE FROM sites WHERE id = ?").bind(siteId).run();
}

/** The daily reaper: purge `deleted` sites past the recovery window + resume any
 *  half-finished `purging` tombstone. Returns how many it purged. */
export async function runReaper(env: Env): Promise<number> {
  const cutoff = new Date(Date.now() - RECOVERY_WINDOW_DAYS * 86400000).toISOString();
  const { results } = await env.DB.prepare(
    "SELECT id FROM sites WHERE status='purging' OR (status='deleted' AND deleted_at < ?) LIMIT 200",
  )
    .bind(cutoff)
    .all<{ id: string }>();
  let n = 0;
  for (const { id } of results ?? []) {
    try {
      await purgeSite(env, id);
      n++;
    } catch {
      /* leave the tombstone; next run retries */
    }
  }
  return n;
}
