import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import { getCms } from "./env";
import { classifyRestSchemaOp, guardRestSchemaOp } from "./guard";
import { handleMcp } from "./mcp";
import { serveSite } from "./site/serve";

export type { Env };

// Durable Object + ctx.exports entrypoints for the dynamic site worker. They are
// re-exported from the main module so `ctx.exports.<Name>` resolves them and so
// wrangler can bind the Durable Object class by name.
export { ChannelDO, RealtimeEntrypoint } from "./realtime";
export { RecordsEntrypoint } from "./records";

/**
 * Loopback GraphQL entrypoint for the dynamic site worker.
 *
 * The site worker's `env.GRAPHQL` is a loopback binding to this entrypoint
 * (via ctx.exports), created per request with `includeDrafts` fixed through
 * entrypoint props (published => false, preview/smoke => true). The site's
 * `query()` helper POSTs `{ query, variables }`; we run it in-process through
 * agent-cms's `execute()` (skips HTTP/auth/CORS) and return the GraphQL result.
 */
export class GraphqlEntrypoint extends WorkerEntrypoint<
  Env,
  { includeDrafts?: boolean }
> {
  async fetch(request: Request): Promise<Response> {
    let payload: { query?: string; variables?: Record<string, unknown> };
    try {
      payload = (await request.json()) as typeof payload;
    } catch {
      return Response.json(
        { errors: [{ message: "Invalid JSON body" }] },
        { status: 400 },
      );
    }
    if (!payload.query) {
      return Response.json({ errors: [{ message: "Missing 'query'" }] });
    }
    const includeDrafts = this.ctx.props?.includeDrafts === true;
    const cms = getCms(this.env);
    const result = await cms.execute(payload.query, payload.variables ?? {}, {
      includeDrafts,
    });
    return Response.json(result);
  }
}

/**
 * Paths agent-cms owns and Loki forwards verbatim to `cms.fetch`. Loki's own
 * merged `/mcp` is handled separately and is NOT forwarded, so agent-cms's
 * `/mcp` is never reachable externally.
 */
const CMS_EXACT = new Set(["/graphql", "/health", "/openapi.json", "/mcp/editor"]);
const CMS_PREFIXES = ["/assets/", "/paths/", "/api/"];

function isCmsPath(pathname: string): boolean {
  if (CMS_EXACT.has(pathname)) return true;
  return CMS_PREFIXES.some((p) => pathname.startsWith(p));
}

/**
 * Serve an agent-cms content asset straight from R2 by object key.
 *
 * agent-cms keys content assets under `uploads/<id>/<filename>` and stamps that
 * exact key onto the public URLs it returns (`<assetBaseUrl>/uploads/…`, driven
 * by our `assetBaseUrl = origin`). agent-cms's own worker only serves the SQL-
 * backed `/assets/:id` route, so this passthrough makes those stamped
 * `/uploads/…` URLs resolve. Keys are content-stable per id, hence immutable.
 * (Distinct from Loki's SITE static assets under `site/blob/…`; see
 * src/site/static-assets.ts.)
 */
async function serveCmsUpload(request: Request, env: Env): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "GET, HEAD" },
    });
  }
  const key = new URL(request.url).pathname.slice(1); // drop leading "/"
  const object = await env.ASSETS.get(key);
  if (!object) return new Response("Not found", { status: 404 });
  const headers = new Headers({
    "content-type": object.httpMetadata?.contentType || "application/octet-stream",
    "cache-control": "public, max-age=31536000, immutable",
    etag: object.httpEtag,
  });
  if (method === "HEAD") {
    await object.arrayBuffer().catch(() => undefined);
    return new Response(null, { status: 200, headers });
  }
  return new Response(object.body, { status: 200, headers });
}

/**
 * Forward an `/api/models/...` request to agent-cms, running the migration
 * guard first for destructive schema ops (DELETE model/field, breaking PATCH).
 * On veto, returns 409 JSON carrying the same instructive reason the MCP seam
 * uses. The PATCH body is read once here and replayed into the forwarded
 * request so agent-cms still receives it.
 */
async function guardedCmsForward(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== "DELETE" && method !== "PATCH") {
    return getCms(env, url.origin).fetch(request);
  }

  let forward = request;
  let body: unknown = undefined;
  if (method === "PATCH") {
    const raw = await request.text();
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = undefined;
      }
    }
    // Rebuild an equivalent request since the body stream was consumed.
    forward = new Request(request.url, {
      method,
      headers: request.headers,
      body: raw,
    });
  }

  const descriptor = classifyRestSchemaOp(method, url.pathname, body);
  if (descriptor) {
    const verdict = await guardRestSchemaOp(env, descriptor);
    if (!verdict.allowed) {
      return new Response(
        JSON.stringify({
          error: "migration_guard_blocked",
          message: `Blocked by Loki migration guard: ${verdict.reason}`,
        }),
        {
          status: 409,
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      );
    }
  }

  return getCms(env, url.origin).fetch(forward);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // Loki's merged MCP endpoint (agent-cms's own /mcp stays internal).
    if (pathname === "/mcp") {
      return handleMcp(request, env, ctx);
    }

    // agent-cms content-asset bytes, addressed by their R2 key (`uploads/…`).
    if (pathname.startsWith("/uploads/")) {
      return serveCmsUpload(request, env);
    }

    if (isCmsPath(pathname)) {
      // Guard the destructive schema REST seam (DELETE/PATCH on models/fields)
      // with the same expand/contract check as the MCP endpoint before
      // forwarding to agent-cms. Non-guarded requests pass straight through.
      if (pathname.startsWith("/api/models/")) {
        return guardedCmsForward(request, env, url);
      }
      return getCms(env, url.origin).fetch(request);
    }

    // Everything else is the public site (published version, or draft in
    // preview mode) plus the /__preview token exchange.
    try {
      return await serveSite(env, ctx, request);
    } catch (err) {
      const message =
        err instanceof Error ? (err.stack ?? err.message) : String(err);
      return new Response(`Loki serve error:\n${message}`, {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await getCms(env).runScheduledTransitions();
  },
};
