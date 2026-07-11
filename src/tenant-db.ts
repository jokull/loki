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
    return {
      results,
      success: true,
      meta: { rows_read: cursor.rowsRead, rows_written: cursor.rowsWritten },
    };
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
    return {
      success: true,
      meta: { rows_read: cursor.rowsRead, rows_written: cursor.rowsWritten },
    };
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
    const db = new SqlStorageD1(this.sqlStore, this.ctx.storage) as unknown as D1Database;
    const cms = createCMSHandler({
      bindings: {
        db,
        environment: this.env.ENVIRONMENT === "development" ? "development" : "production",
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

  /** All content-model api_keys in this tenant's CMS (for config validation). */
  async modelApiKeys(): Promise<string[]> {
    return this.sqlStore
      .exec("SELECT api_key FROM models")
      .toArray()
      .map((r: any) => r.api_key as string);
  }

  /** Whether a content model has drafts enabled (for RECORDS publish-on-create). */
  async modelHasDraft(modelApiKey: string): Promise<boolean> {
    const rows = this.sqlStore
      .exec("SELECT has_draft FROM models WHERE api_key = ?", modelApiKey)
      .toArray();
    return rows.length > 0 && (rows[0] as any).has_draft === 1;
  }

  /** Cheap health/inspection: table names in this tenant's SQLite. */
  async tables(): Promise<string[]> {
    return this.sqlStore
      .exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .toArray()
      .map((r: any) => r.name as string);
  }

  /**
   * This tenant's agent-cms schema-version counter (`_cms_meta.schema_version`),
   * read from THIS DO's SQLite. The supervisor's schema cache polls this to know
   * when a create_field/create_model here invalidated the introspected schema —
   * reading the supervisor's own D1 counter would never reflect a tenant edit.
   * Returns 0 on any error (never blocks a write or tool call).
   */
  async schemaVersion(): Promise<number> {
    try {
      const rows = this.sqlStore
        .exec(`SELECT "value" AS value FROM "_cms_meta" WHERE "key" = 'schema_version'`)
        .toArray();
      const n = Number((rows[0] as any)?.value ?? 0);
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  }

  /** Resolve a model ref (id OR api_key) in THIS tenant's schema — for the
   * migration guard (which must read the tenant's own models, not the supervisor
   * D1). Returns null if not found. */
  async resolveModelRef(ref: string): Promise<{ id: string; api_key: string } | null> {
    const rows = this.sqlStore
      .exec("SELECT id, api_key FROM models WHERE id = ?1 OR api_key = ?1 LIMIT 1", ref)
      .toArray();
    return (rows[0] as { id: string; api_key: string } | undefined) ?? null;
  }

  /** Resolve a field ref (id OR api_key) + its parent model api_key in THIS
   * tenant's schema — for the migration guard. Returns null if not found. */
  async resolveFieldRef(
    ref: string,
  ): Promise<{ id: string; api_key: string; field_type: string; model_api_key: string } | null> {
    const rows = this.sqlStore
      .exec(
        `SELECT f.id AS id, f.api_key AS api_key, f.field_type AS field_type,
                m.api_key AS model_api_key
           FROM fields f JOIN models m ON m.id = f.model_id
          WHERE f.id = ?1 OR f.api_key = ?1 LIMIT 1`,
        ref,
      )
      .toArray();
    return (
      (rows[0] as
        | { id: string; api_key: string; field_type: string; model_api_key: string }
        | undefined) ?? null
    );
  }
}

// ---- TenantFeatureDB: the tenant's own app-data database ---------------------

export interface FeatureColumn {
  name: string;
  type: string;
  notnull: boolean;
  pk: boolean;
}
export type FeatureSchema = Record<string, FeatureColumn[]>;

/** One versioned feature migration: `name` is a stable id, `up` is DDL/SQL. */
export interface FeatureMigration {
  name: string;
  up: string;
}

/** Split a migration body into individual statements (SqlStorage runs one at a
 * time). Naive `;` split — fine for DDL; string literals with `;` are rare in
 * schema migrations. */
function splitStatements(sql: string): string[] {
  return sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * The tenant's FEATURE database — a SQLite-backed DO holding the app tables the
 * agent designs at runtime (guestbooks, todos, orders, …), SEPARATE from the
 * content DB (TenantDB) so feature table names never collide with agent-cms's
 * reserved tables. One instance per site (idFromName(siteId)).
 *
 * The site isolate reaches it as `env.FEATURES_SQL` (drizzle sqlite-proxy) via
 * TenantFeaturesEntrypoint; the agent evolves its schema via the feature_migrate
 * / feature_schema / feature_query MCP tools, which call the methods here.
 */
export class TenantFeatureDB extends DurableObject<Env> {
  private readonly sqlStore: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sqlStore = ctx.storage.sql;
  }

  /** drizzle sqlite-proxy contract: positional rows for reads, empty for run. */
  async exec(
    sql: string,
    params: unknown[] = [],
    method: "run" | "all" | "get" | "values" = "all",
  ): Promise<{ rows: unknown }> {
    const cursor = this.sqlStore.exec(sql, ...(params as any[]));
    if (method === "run") {
      cursor.toArray();
      return { rows: [] };
    }
    const rows = [...cursor.raw()] as unknown[][];
    if (method === "get") return { rows: rows[0] };
    return { rows };
  }

  /**
   * Apply versioned migrations idempotently. Already-applied names (tracked in
   * `_migrations`) are skipped; each new one runs its statements + is recorded
   * atomically (transactionSync — a failed migration rolls back and is NOT
   * recorded). Returns JSON { applied, skipped, failed?, schema }.
   */
  async migrate(migrations: FeatureMigration[]): Promise<string> {
    this.sqlStore.exec(
      "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
    );
    const applied: string[] = [];
    const skipped: string[] = [];
    let failed: { name: string; error: string } | undefined;
    for (const m of migrations) {
      const already =
        this.sqlStore.exec("SELECT 1 FROM _migrations WHERE name = ?", m.name).toArray().length > 0;
      if (already) {
        skipped.push(m.name);
        continue;
      }
      try {
        this.ctx.storage.transactionSync(() => {
          for (const stmt of splitStatements(m.up)) this.sqlStore.exec(stmt);
          this.sqlStore.exec("INSERT INTO _migrations (name) VALUES (?)", m.name);
        });
        applied.push(m.name);
      } catch (err) {
        failed = { name: m.name, error: err instanceof Error ? err.message : String(err) };
        break; // stop at the first failure (later migrations may depend on it)
      }
    }
    return JSON.stringify({ applied, skipped, failed, schema: this.schemaObject() });
  }

  /** Current feature schema (tables → columns), excluding internal tables. */
  async schema(): Promise<string> {
    return JSON.stringify({ schema: this.schemaObject() });
  }

  /** Ensure the `_auth_users` table exists with the role column (idempotent). */
  private ensureAuthUsers(): void {
    this.sqlStore.exec(
      "CREATE TABLE IF NOT EXISTS _auth_users (" +
        "id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, " +
        "role TEXT NOT NULL DEFAULT 'member', " +
        "created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
    );
    // Backfill the role column on tables created before roles existed.
    try {
      this.sqlStore.exec("ALTER TABLE _auth_users ADD COLUMN role TEXT NOT NULL DEFAULT 'member'");
    } catch {
      /* column already exists */
    }
  }

  /**
   * Upsert an end-user by email into `_auth_users` (created on demand) and return
   * its id + role — the existing row if the email is known, else a new row with
   * `newId` and role 'member'. Backs passwordless auth (see src/auth.ts); the
   * `_auth_` prefix keeps it out of the agent-visible feature schema.
   */
  async authUpsertUser(email: string, newId: string): Promise<{ id: string; role: string }> {
    this.ensureAuthUsers();
    this.sqlStore.exec("INSERT OR IGNORE INTO _auth_users (id, email) VALUES (?, ?)", newId, email);
    const rows = this.sqlStore
      .exec("SELECT id, role FROM _auth_users WHERE email = ?", email)
      .toArray();
    const row = rows[0] as any;
    return { id: row?.id ?? newId, role: row?.role ?? "member" };
  }

  /** Set an end-user's role by email (owner tool). Returns true if a row matched. */
  async setUserRole(email: string, role: string): Promise<boolean> {
    this.ensureAuthUsers();
    this.sqlStore.exec("UPDATE _auth_users SET role = ? WHERE email = ?", role, email);
    return (
      this.sqlStore.exec("SELECT 1 FROM _auth_users WHERE email = ?", email).toArray().length > 0
    );
  }

  /** List end-users (owner tool). */
  async listUsers(): Promise<
    Array<{ id: string; email: string; role: string; created_at: string }>
  > {
    this.ensureAuthUsers();
    return this.sqlStore
      .exec("SELECT id, email, role, created_at FROM _auth_users ORDER BY created_at DESC")
      .toArray() as any;
  }

  /** Ensure the `_logs` ring table exists. */
  private ensureLogs(): void {
    this.sqlStore.exec(
      "CREATE TABLE IF NOT EXISTS _logs (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
        "ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
        "level TEXT NOT NULL, source TEXT, message TEXT NOT NULL)",
    );
  }

  /** Append a log line (capped ring — last 500 kept). */
  async appendLog(level: string, source: string | null, message: string): Promise<void> {
    this.ensureLogs();
    this.sqlStore.exec(
      "INSERT INTO _logs (level, source, message) VALUES (?, ?, ?)",
      String(level).slice(0, 16),
      source ? String(source).slice(0, 64) : null,
      String(message).slice(0, 2000),
    );
    this.sqlStore.exec("DELETE FROM _logs WHERE id <= (SELECT MAX(id) FROM _logs) - 500");
  }

  /** Read recent log lines (newest first) for the site_logs tool / dashboard. */
  async readLogs(
    limit = 100,
  ): Promise<Array<{ ts: string; level: string; source: string | null; message: string }>> {
    this.ensureLogs();
    return this.sqlStore
      .exec(
        "SELECT ts, level, source, message FROM _logs ORDER BY id DESC LIMIT ?",
        Math.min(Math.max(1, limit), 500),
      )
      .toArray() as any;
  }

  private schemaObject(): FeatureSchema {
    // Hide ALL underscore-prefixed internal tables (_migrations, _auth_*, _logs)
    // from the agent-visible feature schema.
    const tables = this.sqlStore
      .exec(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND substr(name,1,1) != '_' ORDER BY name",
      )
      .toArray()
      .map((r: any) => r.name as string);
    const out: FeatureSchema = {};
    for (const t of tables) {
      out[t] = this.sqlStore
        .exec(`PRAGMA table_info("${t.replace(/"/g, '""')}")`)
        .toArray()
        .map((c: any) => ({
          name: c.name as string,
          type: c.type as string,
          notnull: !!c.notnull,
          pk: !!c.pk,
        }));
    }
    return out;
  }

  /**
   * Run an agent-supplied SQL query for inspection/seeding (feature_query tool).
   * Returns JSON { columns, rows } for reads, or { changes } for writes.
   */
  async query(sql: string, params: unknown[] = [], write: boolean): Promise<string> {
    const cursor = this.sqlStore.exec(sql, ...(params as any[]));
    if (write) {
      cursor.toArray();
      return JSON.stringify({ ok: true, rowsWritten: cursor.rowsWritten });
    }
    const rows = cursor.toArray();
    return JSON.stringify({ columns: cursor.columnNames, rows });
  }
}
