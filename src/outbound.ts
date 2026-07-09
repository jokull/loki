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

export class OutboundEntrypoint extends WorkerEntrypoint<Env, { siteId?: string }> {
  async fetch(request: Request): Promise<Response> {
    const siteId = this.ctx.props?.siteId ?? DEFAULT_SITE_ID;
    let host = "?";
    try {
      host = new URL(request.url).host;
    } catch {
      /* non-absolute URL — let fetch surface the error */
    }
    const started = Date.now();
    try {
      // Real global fetch runs in the SUPERVISOR (this entrypoint), which has
      // network access — the isolate itself never touches the network directly.
      const res = await fetch(request);
      console.log(
        `[outbound ${siteId}] ${request.method} ${host} -> ${res.status} ` +
          `(${Date.now() - started}ms)`,
      );
      return res;
    } catch (err) {
      console.log(
        `[outbound ${siteId}] ${request.method} ${host} -> ERROR ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }
}
