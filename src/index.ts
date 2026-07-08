import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import { getCms } from "./env";
import { handleMcp } from "./mcp";
import { serveSite } from "./site/serve";

export type { Env };

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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // Loki's merged MCP endpoint (agent-cms's own /mcp stays internal).
    if (pathname === "/mcp") {
      return handleMcp(request, env, ctx);
    }

    if (isCmsPath(pathname)) {
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
