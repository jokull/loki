// Loftur tenant registry. The pure data layer (sites, editor tokens, secrets)
// now lives in the shared workspace package so loftur-web can reuse it; this file
// RE-EXPORTS it and keeps the loki-only bits (DEFAULT_SITE_ID, siteOrigin).

import type { Env } from "./env";
import { getSiteById } from "shared/data";
import { DEFAULT_SITE_ID } from "./site/store";

export * from "shared/data";
export { DEFAULT_SITE_ID };

/** The public origin a site is served from (for preview/absolute URLs). */
export async function siteOrigin(
  env: Env,
  siteId: string,
  fallback: string,
): Promise<string> {
  if (siteId === DEFAULT_SITE_ID) return fallback;
  const site = await getSiteById(env, siteId);
  return site ? `https://${site.subdomain}.loftur.app` : fallback;
}
