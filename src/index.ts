import { createCMSHandler } from "agent-cms";

export interface Env {
  DB: D1Database;
  LOADER: unknown;
  WRITE_KEY?: string;
  ENVIRONMENT?: "production" | "development";
}

/**
 * agent-cms handler is WeakMap-cached per bindings identity, so we cache the
 * bindings object per isolate and hand the same reference to every request.
 */
let cachedBindings: Parameters<typeof createCMSHandler>[0]["bindings"] | null =
  null;

function getCms(request: Request, env: Env) {
  if (!cachedBindings) {
    cachedBindings = {
      db: env.DB,
      environment: env.ENVIRONMENT === "development" ? "development" : "production",
      writeKey: env.WRITE_KEY,
      siteUrl: new URL(request.url).origin,
      // Deliberately NOT passing `loader` — Code Mode's loopback tools/call
      // would bypass Loki's migration guard (see PLAN.md).
    };
  }
  return createCMSHandler({ bindings: cachedBindings });
}

/**
 * Paths that agent-cms owns and Loki forwards verbatim to `cms.fetch`.
 * Loki's own merged `/mcp` endpoint is handled separately and is NOT forwarded,
 * so agent-cms's `/mcp` is never reachable externally.
 */
const CMS_EXACT = new Set([
  "/graphql",
  "/health",
  "/openapi.json",
  "/mcp/editor",
]);
const CMS_PREFIXES = ["/assets/", "/paths/", "/api/"];

function isCmsPath(pathname: string): boolean {
  if (CMS_EXACT.has(pathname)) return true;
  return CMS_PREFIXES.some((p) => pathname.startsWith(p));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // Loki's merged MCP endpoint. agent-cms's own /mcp is intentionally shadowed
    // here and never forwarded. (Built by a later phase.)
    if (pathname === "/mcp") {
      return new Response("merged MCP not built yet", {
        status: 501,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (isCmsPath(pathname)) {
      return getCms(request, env).fetch(request);
    }

    // Everything else is the public site. The site ring (LOADER-served dynamic
    // worker) is built by a later phase.
    return new Response(
      "<!doctype html><meta charset=utf-8><title>Loki</title><p>No site published yet.</p>",
      { status: 404, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await getCms(
      new Request("https://loki.internal/"),
      env,
    ).runScheduledTransitions();
  },
};
