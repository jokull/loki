import { createCMSHandler } from "agent-cms";

export interface Env {
  DB: D1Database;
  /**
   * Feature database for agent-authored serverFns (the npm-dependency spike).
   * Held ONLY by the supervisor + FeaturesDbEntrypoint — never passed into a
   * site isolate directly (a raw D1Database is not structured-cloneable and
   * throws `DataCloneError` when placed on a Worker Loader `env`). The site
   * isolate reaches it exclusively through the `FEATURES_SQL` service binding
   * (see src/features-db.ts) via drizzle's sqlite-proxy async driver.
   */
  FEATURES_DB: D1Database;
  LOADER: WorkerLoader;
  /** Durable Object namespace backing realtime channels (see src/realtime.ts). */
  CHANNELS: DurableObjectNamespace<import("./realtime").ChannelDO>;
  /**
   * Per-tenant backend DO (SQLite-backed). One instance per site
   * (idFromName(siteId)) holds that tenant's content (agent-cms) + feature data,
   * isolated. See src/tenant-db.ts and memory `loftur-per-tenant-data`.
   */
  TENANT_DB: DurableObjectNamespace<import("./tenant-db").TenantDB>;
  /**
   * R2 bucket (`loki-assets`) shared by two independent concerns:
   * - agent-cms content assets (keyed under `uploads/…` by agent-cms itself);
   * - Loki site static/design assets (keyed under `site/blob/<sha256>`, see
   *   src/site/static-assets.ts). The two prefixes never collide.
   */
  ASSETS: R2Bucket;
  WRITE_KEY?: string;
  ENVIRONMENT?: "production" | "development";
}

export type CmsHandler = ReturnType<typeof createCMSHandler>;

/**
 * agent-cms's handler is WeakMap-cached per bindings identity, so we cache the
 * bindings object per isolate and hand the same reference to every request.
 *
 * We deliberately do NOT pass `loader` — Code Mode's loopback tools/call would
 * bypass Loki's migration guard (see PLAN.md). LOADER is used only for serving
 * the dynamic site worker.
 */
let cachedBindings: Parameters<typeof createCMSHandler>[0]["bindings"] | null =
  null;

export function getCms(env: Env, origin = "https://loki.solberg.workers.dev"): CmsHandler {
  if (!cachedBindings) {
    cachedBindings = {
      db: env.DB,
      environment: env.ENVIRONMENT === "development" ? "development" : "production",
      writeKey: env.WRITE_KEY,
      siteUrl: origin,
      // agent-cms content-asset store. It keys objects under `uploads/…` and
      // serves them at `/assets/:id/:filename` (forwarded to cms.fetch). The
      // public base it stamps onto media URLs is `<assetBaseUrl>/uploads/…`.
      assets: env.ASSETS,
      assetBaseUrl: origin,
    };
  }
  return createCMSHandler({ bindings: cachedBindings });
}
