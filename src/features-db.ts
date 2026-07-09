// Feature-DB SQL capability for the dynamic site worker (npm-dependency spike).
//
// A raw D1Database binding cannot be handed to a Worker-Loader isolate: the
// loader `env` is structured-clone-serialized and D1Database throws
// `DataCloneError: Could not serialize object of type "D1Database"`. Service
// bindings (WorkerEntrypoint stubs) DO serialize — which is exactly why
// GRAPHQL/RECORDS/REALTIME already pass through — so we hold FEATURES_DB in a
// WorkerEntrypoint and expose ONLY a narrow async `exec()` RPC. The site isolate
// receives this as `env.FEATURES_SQL` and drives it through drizzle-orm's
// `sqlite-proxy` async remote driver. This keeps raw D1 entirely out of the
// sandbox (the correct multi-tenant posture) while the AGENT-facing story stays
// "import drizzle, write queries".
//
// The `exec` contract is drizzle sqlite-proxy's AsyncRemoteCallback:
//   (sql, params, method: "run" | "all" | "get" | "values") => { rows }
// where for `all`/`values` rows is any[][] (positional rows) and for `get` rows
// is a SINGLE positional row (or undefined). D1's `.raw()` yields exactly the
// positional value arrays drizzle maps by column index, so we use it for the
// read methods and `.run()` for writes.

import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import { DEFAULT_SITE_ID } from "./site/store";

export type SqlMethod = "run" | "all" | "get" | "values";

export interface SqlExecResult {
  /**
   * For `all`/`values`: array of positional row arrays. For `get`: a single
   * positional row array (or undefined when no row). For `run`: empty.
   */
  rows: unknown;
}

export class FeaturesDbEntrypoint extends WorkerEntrypoint<Env> {
  /**
   * Run one SQL statement against FEATURES_DB and return rows in the positional
   * shape drizzle's sqlite-proxy driver expects. Parameters are bound via D1's
   * prepared-statement binding (no string interpolation).
   */
  async exec(
    sql: string,
    params: unknown[] = [],
    method: SqlMethod = "all",
  ): Promise<SqlExecResult> {
    const bound = this.env.FEATURES_DB.prepare(sql).bind(...(params ?? []));
    if (method === "run") {
      await bound.run();
      return { rows: [] };
    }
    // `.raw()` returns positional value arrays (array-of-arrays), which is what
    // sqlite-proxy maps to columns by index.
    const rows = (await bound.raw()) as unknown[][];
    if (method === "get") {
      return { rows: rows[0] };
    }
    // all | values
    return { rows };
  }
}

/**
 * Per-tenant feature-DB capability: the same narrow `exec` contract, but backed
 * by the tenant's TenantDB SQLite (not the shared FEATURES_DB). Wired into a
 * tenant site isolate as `env.FEATURES_SQL` with `siteId` in props, so a tenant
 * serverFn's Drizzle queries hit ITS OWN isolated tables.
 */
export class TenantFeaturesEntrypoint extends WorkerEntrypoint<
  Env,
  { siteId?: string }
> {
  async exec(
    sql: string,
    params: unknown[] = [],
    method: SqlMethod = "all",
  ): Promise<SqlExecResult> {
    const siteId = this.ctx.props?.siteId ?? DEFAULT_SITE_ID;
    const stub = this.env.TENANT_DB.get(this.env.TENANT_DB.idFromName(siteId));
    return await stub.featureExec(sql, params, method);
  }
}
