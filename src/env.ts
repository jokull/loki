import { createCMSHandler } from "agent-cms";

export interface Env {
  DB: D1Database;
  LOADER: WorkerLoader;
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
    };
  }
  return createCMSHandler({ bindings: cachedBindings });
}
