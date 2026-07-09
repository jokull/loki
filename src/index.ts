import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import { getCms } from "./env";
import { classifyRestSchemaOp, guardRestSchemaOp } from "./guard";
import { handleMcp } from "./mcp";
import { serveSite } from "./site/serve";
import { handleControlPlane } from "./control";
import { getSiteBySubdomain } from "./tenants";
import { DEFAULT_SITE_ID } from "./site/store";
import { cmsExecuteFor } from "./cms-dispatch";

/** The Loftur apex zone. Subdomains of it are tenant sites. */
const APEX = "loftur.app";

/** Resolve the effective host (with a dev override header for pre-DNS testing). */
function effectiveHost(request: Request, url: URL): string {
  return (
    request.headers.get("x-loftur-host") ||
    url.hostname ||
    ""
  ).toLowerCase();
}

/** Friendly 404 for an unclaimed {sub}.loftur.app. */
function unknownSubdomain(sub: string): Response {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>loftur.app</title><body style="margin:0;background:#0d1016;color:#e9edf3;font:16px/1.6 ui-sans-serif,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh"><div style="max-width:32rem;padding:2rem;text-align:center"><p style="font-family:ui-monospace,Menlo,monospace;letter-spacing:.14em;text-transform:uppercase;color:#7e8896;font-size:.8rem">◆ Loftur</p><h1 style="font-family:Charter,Georgia,serif;font-size:2rem;margin:1rem 0">${sub}.loftur.app is unclaimed</h1><p style="color:#b4bdca">No site here yet. <a href="https://loftur.app" style="color:#f0752e">Claim this name →</a></p></div></body>`;
  return new Response(html, {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export type { Env };

// Durable Object + ctx.exports entrypoints for the dynamic site worker. They are
// re-exported from the main module so `ctx.exports.<Name>` resolves them and so
// wrangler can bind the Durable Object class by name.
export { ChannelDO, RealtimeEntrypoint } from "./realtime";
export { RecordsEntrypoint } from "./records";
export { FeaturesDbEntrypoint } from "./features-db";
export { TenantDB } from "./tenant-db";

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
  { includeDrafts?: boolean; siteId?: string }
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
    // Per-site content: the default site uses the shared CMS; a tenant uses its
    // own agent-cms in its TenantDB. So a tenant route's query() reads ONLY that
    // tenant's content.
    const siteId = this.ctx.props?.siteId ?? DEFAULT_SITE_ID;
    const result = await cmsExecuteFor(
      this.env,
      siteId,
      payload.query,
      payload.variables ?? {},
      includeDrafts,
    );
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
    // CMS REST is exposed only for the legacy default site (v1), so the guard
    // checks that site's published footprint.
    const verdict = await guardRestSchemaOp(env, DEFAULT_SITE_ID, descriptor);
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
    const host = effectiveHost(request, url);

    // (0) Admin-only DO validation probe (WRITE_KEY): exercises a tenant's
    // SQLite-backed agent-cms end-to-end. Temporary v2 bring-up scaffolding.
    if (pathname.startsWith("/__tenantdb/")) {
      const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
      if (!env.WRITE_KEY || token !== env.WRITE_KEY) {
        return new Response("Unauthorized", { status: 401 });
      }
      const name = pathname.slice("/__tenantdb/".length) || "probe";
      try {
        const stub = env.TENANT_DB.get(env.TENANT_DB.idFromName(name));
        const tables = await stub.tables(); // triggers lazy schema bootstrap
        if (url.searchParams.get("only") === "tables") {
          return Response.json({ tenant: name, tableCount: tables.length, tables });
        }
        const introspection = JSON.parse(
          await stub.cmsExecute("{ __schema { queryType { name } } }", {}, false),
        ) as { data?: any; errors?: unknown };
        return Response.json({
          tenant: name,
          tableCount: tables.length,
          tables,
          graphqlOk: !!(introspection as any)?.data && !(introspection as any)?.errors,
          queryType: (introspection as any)?.data?.__schema?.queryType?.name ?? null,
          errors: (introspection as any)?.errors ?? null,
        });
      } catch (err) {
        return Response.json(
          {
            tenant: name,
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack?.split("\n").slice(0, 8) : undefined,
          },
          { status: 500 },
        );
      }
    }

    // (1) Apex (loftur.app / www) -> the Loftur control plane (signup, keys).
    // The MCP endpoint is also served here: it resolves the site from the bearer
    // key alone, so an agent can connect at loftur.app/mcp without waiting on the
    // per-subdomain wildcard DNS. (The branded {sub}.loftur.app/mcp also works.)
    if (host === APEX || host === `www.${APEX}`) {
      if (pathname === "/mcp") return handleMcp(request, env, ctx);
      return handleControlPlane(request, env);
    }

    // (2) Resolve the tenant. A {sub}.loftur.app host maps to a site; anything
    // else (workers.dev, custom) is the legacy single-tenant default site.
    let siteId = DEFAULT_SITE_ID;
    let isTenant = false;
    if (host.endsWith(`.${APEX}`)) {
      const sub = host.slice(0, host.length - (`.${APEX}`).length);
      const site = await getSiteBySubdomain(env, sub);
      if (!site) return unknownSubdomain(sub);
      siteId = site.id;
      isTenant = true;
    }

    // (3) MCP endpoint. handleMcp derives the site from the bearer key
    // (tenant API key -> that site; the legacy WRITE_KEY -> the default site).
    if (pathname === "/mcp") {
      return handleMcp(request, env, ctx);
    }

    // (4) agent-cms content REST/GraphQL is exposed ONLY for the legacy default
    // site (v1 defers per-tenant CMS). On a tenant host these paths fall through
    // to the site worker (and 404 there if the site defines no such route).
    if (!isTenant) {
      // agent-cms content-asset bytes, addressed by their R2 key (`uploads/…`).
      if (pathname.startsWith("/uploads/")) {
        return serveCmsUpload(request, env);
      }
      if (isCmsPath(pathname)) {
        // Guard the destructive schema REST seam (DELETE/PATCH on models/fields).
        if (pathname.startsWith("/api/models/")) {
          return guardedCmsForward(request, env, url);
        }
        return getCms(env, url.origin).fetch(request);
      }
    }

    // (5) Everything else is the tenant's public site (published version, or the
    // draft in preview mode) plus the /__preview token exchange — scoped to siteId.
    try {
      return await serveSite(env, ctx, request, siteId);
    } catch (err) {
      const message =
        err instanceof Error ? (err.stack ?? err.message) : String(err);
      return new Response(`Loftur serve error:\n${message}`, {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await getCms(env).runScheduledTransitions();
  },
};
