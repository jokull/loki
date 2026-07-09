// Per-site runtime logs. Owners (and the building agent, via the site_logs MCP
// tool) can see recent errors + custom log lines — the "why did my site 500?"
// answer. Backed by a capped `_logs` ring in the tenant's TenantFeatureDB.
//
// Two write paths:
//   - env.LOG.write(level, message) — the site's own code logs intentionally.
//   - logError(env, siteId, ...) — the supervisor records isolate render errors
//     (see serve.ts) and serverFn failures.

import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import { DEFAULT_SITE_ID } from "./site/store";

/** Record a log line for a tenant site (no-op for the default/legacy site). */
export async function logLine(
  env: Env,
  siteId: string,
  level: string,
  source: string | null,
  message: string,
): Promise<void> {
  if (siteId === DEFAULT_SITE_ID) return;
  try {
    const stub = env.TENANT_FEATURE_DB.get(env.TENANT_FEATURE_DB.idFromName(siteId));
    await stub.appendLog(level, source, message);
  } catch {
    /* logging must never break serving */
  }
}

export class LogEntrypoint extends WorkerEntrypoint<Env, { siteId?: string }> {
  /** Append a log line from site code: env.LOG.write("info", "checkout ok"). */
  async write(level: string, message: string, source?: string): Promise<void> {
    const siteId = this.ctx.props?.siteId ?? DEFAULT_SITE_ID;
    await logLine(this.env, siteId, level || "info", source ?? "site", message);
  }
}
