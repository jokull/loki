// Mediated outbound for site isolates.
//
// A Worker-Loader isolate is created with `globalOutbound` set to a Fetcher: any
// bare `fetch()` the site's server code makes (to an external host) is routed to
// THAT fetcher's `fetch()` instead of hitting the network directly. We point it
// at this entrypoint so the platform sits in the path of every outbound request —
// the seam where per-site allowlists, rate limits, and audit logging live.
//
// v1 policy: proxy everything and log (host + method + status). The site's own
// capability stubs (GRAPHQL / FEATURES_SQL / RECORDS / REALTIME / SECRETS / AUTH)
// are service bindings, NOT global fetch, so they never pass through here — only
// genuine network egress does. `globalOutbound: null` (the old default) blocked
// all egress; this opens it under supervision so serverFns can call Stripe,
// Resend, webhooks, etc.

import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import { DEFAULT_SITE_ID } from "./site/store";
import { logLine } from "./logs";

export class OutboundEntrypoint extends WorkerEntrypoint<
  Env,
  { siteId?: string; allowedHosts?: string[] }
> {
  async fetch(request: Request): Promise<Response> {
    const siteId = this.ctx.props?.siteId ?? DEFAULT_SITE_ID;
    const allowed = this.ctx.props?.allowedHosts ?? [];
    let host = "?";
    let hostname = "";
    try {
      const u = new URL(request.url);
      host = u.host;
      hostname = u.hostname.toLowerCase();
    } catch {
      /* non-absolute URL — let fetch surface the error */
    }
    // Optional per-site allowlist: empty = allow all (backward compatible). A listed
    // host matches exactly or as a parent domain (api.stripe.com allowed by stripe.com).
    if (allowed.length > 0 && hostname) {
      const okHost = allowed.some((h) => hostname === h || hostname.endsWith("." + h));
      if (!okHost) {
        console.log(`[outbound ${siteId}] BLOCKED ${host} (not in allowedHosts)`);
        this.ctx.waitUntil(
          logLine(
            this.env,
            siteId,
            "warn",
            "outbound",
            `BLOCKED ${request.method} ${host} — not in loki.config.json allowedHosts`,
          ),
        );
        return new Response(
          `Outbound request to "${host}" blocked: not in loki.config.json allowedHosts.`,
          { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } },
        );
      }
    }
    const started = Date.now();
    try {
      // Real global fetch runs in the SUPERVISOR (this entrypoint), which has
      // network access — the isolate itself never touches the network directly.
      const res = await fetch(request);
      const ms = Date.now() - started;
      console.log(`[outbound ${siteId}] ${request.method} ${host} -> ${res.status} (${ms}ms)`);
      this.ctx.waitUntil(
        logLine(
          this.env,
          siteId,
          res.ok ? "info" : "warn",
          "outbound",
          `${request.method} ${host} -> ${res.status} (${ms}ms)`,
        ),
      );
      return res;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[outbound ${siteId}] ${request.method} ${host} -> ERROR ${msg}`);
      this.ctx.waitUntil(
        logLine(this.env, siteId, "error", "outbound", `${request.method} ${host} -> ERROR ${msg}`),
      );
      throw err;
    }
  }
}
