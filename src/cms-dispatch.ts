// Per-site CMS dispatch. The legacy default site uses the shared agent-cms
// (getCms over the supervisor's D1); a tenant site uses ITS OWN agent-cms running
// inside its TenantDB Durable Object (per-tenant SQLite). Everything that touched
// getCms directly now goes through here so content is isolated per tenant.

import { getCms } from "./env";
import type { Env } from "./env";
import { DEFAULT_SITE_ID } from "./site/store";

function tenantStub(env: Env, siteId: string) {
  return env.TENANT_DB.get(env.TENANT_DB.idFromName(siteId));
}

/** Run a GraphQL document against a site's content. */
export async function cmsExecuteFor(
  env: Env,
  siteId: string,
  query: string,
  variables: Record<string, unknown>,
  includeDrafts: boolean,
): Promise<any> {
  if (siteId === DEFAULT_SITE_ID) {
    return await getCms(env).execute(query, variables ?? {}, { includeDrafts });
  }
  const raw = await tenantStub(env, siteId).cmsExecute(
    query,
    variables ?? {},
    includeDrafts,
  );
  return JSON.parse(raw);
}

/** Forward an HTTP request (agent-cms MCP/REST/GraphQL) to a site's CMS. */
export async function cmsFetchFor(
  env: Env,
  siteId: string,
  request: Request,
): Promise<Response> {
  if (siteId === DEFAULT_SITE_ID) {
    return await getCms(env, new URL(request.url).origin).fetch(request);
  }
  const headers: Record<string, string> = {};
  request.headers.forEach((v: string, k: string) => (headers[k] = v));
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? null
      : await request.text();
  const r = await tenantStub(env, siteId).cmsRequest(
    request.method,
    request.url,
    headers,
    body,
  );
  return new Response(r.body, { status: r.status, headers: r.headers });
}
