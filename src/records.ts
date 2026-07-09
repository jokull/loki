// Scoped record writes for the dynamic site worker.
//
// RecordsEntrypoint is a ctx.exports WorkerEntrypoint handed to the site worker
// as `env.RECORDS`. It exposes ONLY `create(modelApiKey, fields)` (narrow
// capability — no update/delete/query). The allowlist of writable models comes
// from the serving tree's loki.config.json, threaded in via entrypoint props,
// so a route action can only create records the site explicitly opted in to.
//
// create() creates the record via the in-process CMS MCP (`create_record`) and,
// if the model has drafts enabled, immediately publishes it (`set_publish_status`
// action "publish") so it is visible to published GraphQL queries. Validation
// failures (deferred to publish time for draft models) pass through legibly.
//
// TODO(v1): no rate limiting. Public write routes MUST validate inputs (length
// caps etc.) via model validators — see site_help.

import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import { callCmsTool, type McpToolResult } from "./cms-bridge";
import { DEFAULT_SITE_ID } from "./site/store";

export type RecordCreateResult = { id: string } | { error: string };

interface RecordsProps {
  /** Model api_keys the serving tree allows writes to (loki.config.json). */
  allowlist?: string[];
  /** Site whose CMS the writes route to (default site => shared CMS). */
  siteId?: string;
}

/** Join an MCP result's text content into a single legible error string. */
function cmsErrorText(result: McpToolResult): string {
  const texts = (result.content ?? [])
    .map((c) => (typeof c.text === "string" ? c.text : ""))
    .filter(Boolean);
  return texts.join("\n") || "unknown CMS error";
}

/** Pull the created record id from an MCP result (structuredContent or JSON text). */
function extractRecordId(result: McpToolResult): string | null {
  const fromObj = (v: unknown): string | null => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const id = (v as Record<string, unknown>).id;
      if (typeof id === "string" && id) return id;
    }
    return null;
  };
  const sc = fromObj(result.structuredContent);
  if (sc) return sc;
  for (const c of result.content ?? []) {
    if (typeof c.text !== "string") continue;
    try {
      const id = fromObj(JSON.parse(c.text));
      if (id) return id;
    } catch {
      // not JSON; skip
    }
  }
  return null;
}

async function modelHasDraft(
  env: Env,
  siteId: string,
  modelApiKey: string,
): Promise<boolean> {
  // Per-site: the default site's models live in the shared D1; a tenant's live
  // in its own TenantDB SQLite.
  if (siteId !== DEFAULT_SITE_ID) {
    const stub = env.TENANT_DB.get(env.TENANT_DB.idFromName(siteId));
    return await stub.modelHasDraft(modelApiKey);
  }
  const row = await env.DB.prepare(
    "SELECT has_draft FROM models WHERE api_key = ?",
  )
    .bind(modelApiKey)
    .first<{ has_draft: number }>();
  return !!row && row.has_draft === 1;
}

export class RecordsEntrypoint extends WorkerEntrypoint<Env, RecordsProps> {
  /**
   * Create a record on an allowlisted model. Returns `{ id }` on success or
   * `{ error }` (allowlist rejection or a CMS validation failure) — never throws
   * across the RPC boundary for expected failures.
   */
  async create(
    modelApiKey: string,
    fields: Record<string, unknown>,
  ): Promise<RecordCreateResult> {
    const allowlist = this.ctx.props?.allowlist ?? [];
    const siteId = this.ctx.props?.siteId ?? DEFAULT_SITE_ID;
    if (!allowlist.includes(modelApiKey)) {
      return {
        error:
          `Model "${modelApiKey}" is not writable from the site. Add it to ` +
          `loki.config.json "writableModels" and publish. ` +
          `Currently writable: ${allowlist.join(", ") || "(none)"}.`,
      };
    }

    let created: McpToolResult;
    try {
      created = await callCmsTool(this.env, siteId, "create_record", {
        modelApiKey,
        data: fields ?? {},
      });
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
    if (created.isError) return { error: cmsErrorText(created) };

    const id = extractRecordId(created);
    if (!id) {
      return {
        error: "create_record succeeded but returned no record id.",
      };
    }

    // Draft-enabled models create as draft; publish so published GraphQL sees it.
    // (Required-field validation for draft models is enforced here, at publish.)
    if (await modelHasDraft(this.env, siteId, modelApiKey)) {
      let published: McpToolResult;
      try {
        published = await callCmsTool(this.env, siteId, "set_publish_status", {
          action: "publish",
          modelApiKey,
          recordIds: [id],
        });
      } catch (err) {
        return {
          error: `Record ${id} was created but could not be published: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
      if (published.isError) {
        return {
          error: `Record ${id} was created but failed to publish: ${cmsErrorText(published)}`,
        };
      }
    }

    return { id };
  }
}
