// Per-tenant backend: a SQLite-backed Durable Object that holds ONE tenant's
// data and runs agent-cms INSIDE it, against the DO's embedded SQLite.
//
// Why a DO: Cloudflare Worker bindings are static, so you can't bind one D1 per
// tenant at PaaS scale. A DO namespace addresses unlimited instances by name
// (idFromName(siteId)), each with its own isolated 10 GB SQLite — the blessed
// multi-tenant primitive. See memory `loftur-per-tenant-data`.
//
// agent-cms speaks the `@effect/sql-d1` D1 client, which uses only a tiny slice
// of the D1Database surface (prepare/bind/all/raw + batch; NO SQL transactions —
// the driver explicitly rejects them). SqlStorageD1 below adapts DO SqlStorage to
// that surface, so agent-cms runs UNMODIFIED. SqlStorage is DO-local, so the CMS
// must run in the DO; the supervisor reaches it via the RPC methods here.

import { DurableObject } from "cloudflare:workers";
import { createCMSHandler } from "agent-cms";
import type { Env, CmsHandler } from "./env";

// ---- SqlStorage -> D1Database adapter ---------------------------------------

/** A prepared (and optionally bound) statement over DO SqlStorage. */
class SqlStorageStatement {
  constructor(
    private readonly sqlStore: SqlStorage,
    readonly sql: string,
    readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]): SqlStorageStatement {
    return new SqlStorageStatement(this.sqlStore, this.sql, params);
  }

  /** D1: returns { results }. SqlStorage cursor is consumed synchronously. */
  async all<T = Record<string, unknown>>(): Promise<{
    results: T[];
    success: true;
    meta: Record<string, unknown>;
  }> {
    const cursor = this.sqlStore.exec(this.sql, ...(this.params as any[]));
    const results = cursor.toArray() as T[];
    return { results, success: true, meta: { rows_read: cursor.rowsRead, rows_written: cursor.rowsWritten } };
  }

  /** D1: value-array rows (no column keys). */
  async raw<T = unknown[]>(): Promise<T[]> {
    const cursor = this.sqlStore.exec(this.sql, ...(this.params as any[]));
    return [...cursor.raw()] as T[];
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const rows = this.sqlStore.exec(this.sql, ...(this.params as any[])).toArray();
    const row = (rows[0] ?? null) as any;
    if (row && column != null) return row[column] ?? null;
    return row as T | null;
  }

  async run(): Promise<{ success: true; meta: Record<string, unknown> }> {
    const cursor = this.sqlStore.exec(this.sql, ...(this.params as any[]));
    cursor.toArray(); // drain
    return { success: true, meta: { rows_read: cursor.rowsRead, rows_written: cursor.rowsWritten } };
  }
}

/**
 * Minimal D1Database over DO SqlStorage — exactly the surface @effect/sql-d1 +
 * agent-cms's runBatchedQueries use: prepare / bind / all / raw / batch. Batch is
 * atomic via transactionSync (D1 has no interactive transactions either).
 */
export class SqlStorageD1 {
  constructor(
    private readonly sqlStore: SqlStorage,
    private readonly storage: DurableObjectStorage,
  ) {}

  prepare(sql: string): SqlStorageStatement {
    return new SqlStorageStatement(this.sqlStore, sql);
  }

  async batch<T = Record<string, unknown>>(
    statements: SqlStorageStatement[],
  ): Promise<Array<{ results: T[]; success: true; meta: Record<string, unknown> }>> {
    // transactionSync gives batch atomicity + rollback-on-error (D1 has no
    // interactive transactions either — this matches its batch semantics).
    return this.storage.transactionSync(() =>
      statements.map((s) => {
        const cursor = this.sqlStore.exec(s.sql, ...(s.params as any[]));
        return {
          results: cursor.toArray() as T[],
          success: true as const,
          meta: { rows_read: cursor.rowsRead, rows_written: cursor.rowsWritten },
        };
      }),
    );
  }

  /** D1.exec runs a single raw statement (used rarely). */
  async exec(sql: string): Promise<{ count: number; duration: number }> {
    const cursor = this.sqlStore.exec(sql);
    cursor.toArray();
    return { count: cursor.rowsWritten, duration: 0 };
  }
}

// ---- TenantDB Durable Object ------------------------------------------------

export interface CmsRpcResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export class TenantDB extends DurableObject<Env> {
  private readonly sqlStore: SqlStorage;
  private cms: CmsHandler | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sqlStore = ctx.storage.sql;
  }

  /** Lazily build the agent-cms handler over this DO's SQLite, ensuring schema. */
  private async getCms(): Promise<CmsHandler> {
    if (this.cms) return this.cms;
    const db = new SqlStorageD1(
      this.sqlStore,
      this.ctx.storage,
    ) as unknown as D1Database;
    const cms = createCMSHandler({
      bindings: {
        db,
        environment:
          this.env.ENVIRONMENT === "development" ? "development" : "production",
        writeKey: this.env.WRITE_KEY,
        // Shared R2 for content assets (keyed by unique record/asset ids). A
        // per-tenant prefix is a v2.1 refinement.
        assets: this.env.ASSETS,
      },
    });
    // Bootstrap the agent-cms schema in this DO's SQLite on first use.
    await this.ctx.blockConcurrencyWhile(async () => {
      if (!this.schemaReady()) {
        const res = await cms.fetch(
          new Request("https://tenant.internal/api/setup", {
            method: "POST",
            headers: { authorization: `Bearer ${this.env.WRITE_KEY ?? ""}` },
          }),
        );
        if (res.status >= 400) {
          throw new Error(`agent-cms /setup failed: ${res.status} ${await res.text()}`);
        }
      }
    });
    this.cms = cms;
    return cms;
  }

  private schemaReady(): boolean {
    const rows = this.sqlStore
      .exec("SELECT name FROM sqlite_master WHERE type='table' AND name='models'")
      .toArray();
    return rows.length > 0;
  }

  /** Run a GraphQL document against this tenant's content (RPC target for the
   * site isolate's GRAPHQL capability and the graphql_query tool). */
  async cmsExecute(
    query: string,
    variables: Record<string, unknown>,
    includeDrafts: boolean,
  ): Promise<string> {
    // Catch INSIDE the DO: an Effect/agent-cms error object may not survive the
    // DO RPC boundary (structured clone) and would surface as an opaque
    // DataCloneError. Return everything as a JSON string so nothing non-cloneable
    // ever crosses the boundary.
    try {
      const cms = await this.getCms();
      const result = await cms.execute(query, variables ?? {}, { includeDrafts });
      return JSON.stringify(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      return JSON.stringify({ __tenantError: message, stack: stack?.split("\n").slice(0, 10) });
    }
  }

  /** Forward an HTTP request to agent-cms (its MCP/REST/GraphQL surfaces),
   * returned as a plain serializable object for RPC. */
  async cmsRequest(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: string | null,
  ): Promise<CmsRpcResponse> {
    const cms = await this.getCms();
    const res = await cms.fetch(
      new Request(url, {
        method,
        headers,
        body: body ?? undefined,
      }),
    );
    const outHeaders: Record<string, string> = {};
    res.headers.forEach((v: string, k: string) => (outHeaders[k] = v));
    return { status: res.status, headers: outHeaders, body: await res.text() };
  }

  /** Cheap health/inspection: table names in this tenant's SQLite. */
  async tables(): Promise<string[]> {
    return this.sqlStore
      .exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .toArray()
      .map((r: any) => r.name as string);
  }
}
