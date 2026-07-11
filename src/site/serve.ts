// Serving the dynamic site worker via the LOADER binding.
//
// - Published traffic loads the snapshot bundle from site_versions with a
//   stable loader id `site:v<N>` (isolate cache friendly).
// - Preview traffic (valid preview cookie) loads the draft tree with a
//   content-addressed id `draft:<sha256>` and drafts-visible GraphQL.
//
// The GRAPHQL binding handed to the dynamic worker is a loopback to Loki's own
// `GraphqlEntrypoint` (via ctx.exports), with draft/published visibility fixed
// through entrypoint props.

import type { Env } from "../env";
import { buildWorkerCode, RUNTIME_VERSION, type Bundle } from "./bundle";
import { serveModule, serveVendor } from "./assets";
import { serveStaticAsset } from "./static-assets";
import { resolveUser, handleAuthRoute } from "../auth";
import { logLine } from "../logs";
import { serveUpload } from "../uploads";
import { assembleDeps, draftDepSnapshot } from "./deps";
import {
  DEFAULT_SITE_ID,
  getPublishedVersionId,
  getVersion,
  getState,
  listFiles,
  versionDepSnapshot,
  type DepSnapshot,
} from "./store";

const PREVIEW_COOKIE = "loki_preview";

/**
 * Build the draft bundle for the ISOLATE (server) from the live working tree.
 * Always the FULL compiled text — serverFn handlers must run server-side.
 */
export async function buildDraftBundle(env: Env, siteId: string): Promise<Bundle> {
  const files = await listFiles(env, siteId);
  const bundle: Bundle = {};
  for (const f of files) {
    bundle[f.path] = f.compiled ?? f.source;
  }
  return bundle;
}

/**
 * Build the draft bundle served to the BROWSER (/__modules). serverFn modules
 * resolve to their synthesized stub (client_compiled) so no handler/validator
 * source ever reaches the client; everything else is identical to the isolate
 * text. NEVER feed this to buildWorkerCode — the isolate needs the full build.
 */
export async function buildDraftClientBundle(env: Env, siteId: string): Promise<Bundle> {
  const files = await listFiles(env, siteId);
  const bundle: Bundle = {};
  for (const f of files) {
    bundle[f.path] = f.client_compiled ?? f.compiled ?? f.source;
  }
  return bundle;
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Deterministic serialization of a bundle for content addressing. */
function stableStringify(bundle: Bundle): string {
  const keys = Object.keys(bundle).sort();
  return JSON.stringify(keys.map((k) => [k, bundle[k]]));
}

function ctxExports(ctx: ExecutionContext): Record<string, any> {
  // ctx.exports is typed from the (undeclared) main-module GlobalProps, so cast.
  return (ctx as unknown as { exports: Record<string, any> }).exports;
}

/**
 * Create the loopback GRAPHQL binding for the dynamic worker. Uses ctx.exports
 * (loopback WorkerEntrypoint) with `includeDrafts` fixed via entrypoint props.
 */
function makeGraphqlBinding(
  ctx: ExecutionContext,
  includeDrafts: boolean,
  siteId: string,
): Fetcher {
  return ctxExports(ctx).GraphqlEntrypoint({
    props: { includeDrafts, siteId },
  }) as Fetcher;
}

/** Parse a string-array field from the serving tree's loki.config.json. */
function parseConfigList(bundle: Bundle, field: string): string[] {
  const raw = bundle["loki.config.json"];
  if (!raw) return [];
  try {
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    const list = cfg?.[field];
    return Array.isArray(list) ? list.filter((m): m is string => typeof m === "string") : [];
  } catch {
    return [];
  }
}

/** Parse the writable-model allowlist from the serving tree's loki.config.json. */
export function parseWritableModels(bundle: Bundle): string[] {
  return parseConfigList(bundle, "writableModels");
}

/** Parse the outbound host allowlist (empty = allow all). */
export function parseAllowedHosts(bundle: Bundle): string[] {
  return parseConfigList(bundle, "allowedHosts").map((h) => h.toLowerCase());
}

async function runSite(
  env: Env,
  ctx: ExecutionContext,
  siteId: string,
  loaderId: string,
  bundle: Bundle,
  includeDrafts: boolean,
  request: Request,
  islandBase: string,
  deps: DepSnapshot,
): Promise<Response> {
  // Assemble resolved npm deps (esm.sh snapshots) into the isolate module map.
  // Loads content-addressed bytes from R2 (cached per isolate). Deps are pinned
  // per bundle so published/preview/rollback serve identical bytes.
  const assembled = await assembleDeps(env, deps);
  const built = buildWorkerCode(bundle, assembled);
  const exports = ctxExports(ctx);
  const workerEnv: Record<string, unknown> = {
    GRAPHQL_DRAFTS: includeDrafts ? "true" : "false",
    // Version-aware base for island module URLs, read by the runtime shim.
    LOKI_ISLAND_BASE: islandBase,
  };
  // Content READ capability, per-site: the default site reads the shared CMS; a
  // tenant reads its OWN agent-cms in its TenantDB (query() in a tenant route
  // returns only that tenant's content). Wired for every site.
  const graphql = makeGraphqlBinding(ctx, includeDrafts, siteId);
  if (graphql) workerEnv.GRAPHQL = graphql;
  // Feature-data SQL, per-site: the default site uses the shared FEATURES_DB; a
  // tenant uses its OWN tables in its TenantDB SQLite. Either way the site isolate
  // sees `env.FEATURES_SQL` with the same narrow exec() contract (drizzle
  // sqlite-proxy), and never a raw D1 (which can't cross the loader boundary).
  const isDefault = siteId === DEFAULT_SITE_ID;
  if (isDefault) {
    if (exports?.FeaturesDbEntrypoint) {
      workerEnv.FEATURES_SQL = exports.FeaturesDbEntrypoint({});
    }
  } else if (exports?.TenantFeaturesEntrypoint) {
    workerEnv.FEATURES_SQL = exports.TenantFeaturesEntrypoint({ props: { siteId } });
  }
  // Scoped record WRITES, per-site: RECORDS.create routes to the resolved site's
  // CMS (default → shared, tenant → its DO), gated by the serving tree's
  // loki.config.json writableModels allowlist.
  if (exports?.RecordsEntrypoint) {
    workerEnv.RECORDS = exports.RecordsEntrypoint({
      props: { allowlist: parseWritableModels(bundle), siteId },
    });
  }
  // Realtime fan-out: REALTIME.publish(channel, message). Channels are
  // namespaced per site, so this is safe for every tenant.
  if (exports?.RealtimeEntrypoint) {
    workerEnv.REALTIME = exports.RealtimeEntrypoint({ props: { siteId } });
  }
  // Per-site encrypted secrets: env.SECRETS.get("STRIPE_KEY"). Values decrypt
  // supervisor-side; only this site's rows are reachable (siteId in props).
  if (exports?.SecretsEntrypoint) {
    workerEnv.SECRETS = exports.SecretsEntrypoint({ props: { siteId } });
  }
  // Passwordless auth: env.AUTH.requestMagicLink(email, redirectTo). Session
  // verification stays supervisor-side (below); the isolate only triggers sends.
  if (exports?.AuthEntrypoint) {
    workerEnv.AUTH = exports.AuthEntrypoint({ props: { siteId } });
  }
  // Transactional email: env.MAIL.send({to,subject,html/text}) via Cloudflare Email.
  if (exports?.MailEntrypoint) {
    workerEnv.MAIL = exports.MailEntrypoint({ props: { siteId } });
  }
  // Runtime logs: env.LOG.write(level, message) — surfaced via the site_logs tool.
  if (exports?.LogEntrypoint) {
    workerEnv.LOG = exports.LogEntrypoint({ props: { siteId } });
  }
  // End-user uploads: env.UPLOADS.put(key, base64) -> R2, served at /__uploads/<key>.
  if (exports?.UploadsEntrypoint) {
    workerEnv.UPLOADS = exports.UploadsEntrypoint({ props: { siteId } });
  }
  // Mediated outbound: any external fetch() the site makes is proxied + logged
  // through OutboundEntrypoint (per-site policy seam). Falls back to no network
  // if the entrypoint is somehow unavailable.
  const outbound = exports?.OutboundEntrypoint
    ? (exports.OutboundEntrypoint({
        props: { siteId, allowedHosts: parseAllowedHosts(bundle) },
      }) as Fetcher)
    : null;
  // Namespace the isolate by site so two sites with byte-identical bundles never
  // share an isolate (their capability env differs).
  const stub = env.LOADER.get(`${siteId}:${loaderId}`, () => ({
    compatibilityDate: built.compatibilityDate,
    mainModule: built.mainModule,
    modules: built.modules,
    env: workerEnv,
    globalOutbound: outbound,
  }));
  // Resolve the signed-in user (session cookie) HERE, supervisor-side, and inject
  // it as a TRUSTED header. All isolate traffic (pages + serverFn RPC) flows
  // through this path, and we strip any client-supplied x-loki-user first, so the
  // isolate can trust it. The HMAC key never enters the isolate.
  const user = await resolveUser(env, siteId, request);
  const fwdHeaders = new Headers(request.headers);
  fwdHeaders.delete("x-loki-user");
  if (user) fwdHeaders.set("x-loki-user", JSON.stringify(user));
  const forwarded = new Request(request, { headers: fwdHeaders });
  try {
    return await stub.getEntrypoint().fetch(forwarded);
  } catch (err) {
    // The actionable message goes to the client; the full stack + internal
    // isolate cache-key go ONLY to site_logs (never leaked in the response body,
    // and not mislabeled "loader" — this catches any render/island/loader error).
    const clientMessage = err instanceof Error ? err.message : String(err);
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    const path = (() => {
      try {
        return new URL(request.url).pathname;
      } catch {
        return "?";
      }
    })();
    ctx.waitUntil(logLine(env, siteId, "error", `render ${path} [${loaderId}]`, detail));
    return new Response(
      `Site render error at ${path}:\n${clientMessage}\n\n(full stack trace in site_logs)`,
      { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
}

/**
 * Load the given draft bundle into a throwaway isolate and fetch "/" — used as
 * the publish-time smoke test. A unique id forces a cold load reflecting exactly
 * this bundle (no cache reuse).
 */
export async function smokeRender(
  env: Env,
  ctx: ExecutionContext,
  siteId: string,
  bundle: Bundle,
): Promise<Response> {
  const id = `smoke:${RUNTIME_VERSION}:${await sha256Hex(stableStringify(bundle))}:${Date.now()}`;
  return runSite(
    env,
    ctx,
    siteId,
    id,
    bundle,
    true,
    new Request("https://loki.internal/"),
    "/__modules/draft",
    await draftDepSnapshot(env, siteId, bundle),
  );
}

const NO_SITE = `<!doctype html><html><head><meta charset="utf-8"><title>Loftur</title></head><body style="font-family:system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem"><h1>Loftur</h1><p>No site has been published here yet. Point an agent at this site's MCP endpoint and use the <code>site_write</code> and <code>publish_site</code> tools to build one.</p></body></html>`;

function placeholder(): Response {
  return new Response(NO_SITE, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

interface PreviewState {
  token: string;
  expires: number;
}

export async function readPreviewState(env: Env, siteId: string): Promise<PreviewState | null> {
  const raw = await getState(env, siteId, "preview_token");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PreviewState;
    if (parsed.expires < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function isValidPreviewToken(
  env: Env,
  siteId: string,
  token: string,
): Promise<boolean> {
  const state = await readPreviewState(env, siteId);
  return !!state && state.token === token;
}

/** Serve the draft site tree (preview mode). */
export async function serveDraft(
  env: Env,
  ctx: ExecutionContext,
  request: Request,
  siteId: string,
): Promise<Response> {
  const bundle = await buildDraftBundle(env, siteId);
  if (Object.keys(bundle).length === 0) return placeholder();
  const deps = await draftDepSnapshot(env, siteId, bundle);
  const id = `draft:${RUNTIME_VERSION}:${await sha256Hex(stableStringify(bundle))}:${depFingerprint(deps)}`;
  return runSite(env, ctx, siteId, id, bundle, true, request, "/__modules/draft", deps);
}

/** Stable fingerprint of a dep snapshot (specifier@depHash pairs). */
function depFingerprint(deps: DepSnapshot): string {
  return Object.keys(deps)
    .sort()
    .map((s) => `${s}@${deps[s].depHash.slice(0, 12)}`)
    .join(",");
}

/** Serve the currently published site version. */
export async function servePublished(
  env: Env,
  ctx: ExecutionContext,
  request: Request,
  siteId: string,
): Promise<Response> {
  const versionId = await getPublishedVersionId(env, siteId);
  if (versionId == null) return placeholder();
  const version = await getVersion(env, siteId, versionId);
  if (!version) return placeholder();
  const bundle = JSON.parse(version.bundle) as Bundle;
  return runSite(
    env,
    ctx,
    siteId,
    `site:v${versionId}:${RUNTIME_VERSION}`,
    bundle,
    false,
    request,
    `/__modules/v${versionId}`,
    versionDepSnapshot(version),
  );
}

/**
 * Public site dispatch: preview cookie -> draft tree, otherwise the published
 * version. Also handles `/__preview` token exchange (sets cookie, redirects).
 */
export async function serveSite(
  env: Env,
  ctx: ExecutionContext,
  request: Request,
  siteId: string,
): Promise<Response> {
  const url = new URL(request.url);

  // Passwordless auth: /__auth/verify (magic-link exchange -> session cookie) and
  // /__auth/logout. Handled supervisor-side (holds the HMAC key) before any
  // isolate dispatch; returns null for other paths.
  if (url.pathname.startsWith("/__auth/")) {
    const authResponse = await handleAuthRoute(env, request, siteId, url);
    if (authResponse) return authResponse;
  }

  // Realtime channel WebSocket supervisor: /__realtime/<channel> -> ChannelDO.
  if (url.pathname.startsWith("/__realtime/")) {
    const channel = decodeURIComponent(url.pathname.slice("/__realtime/".length));
    if (!channel || channel.includes("/")) {
      return new Response("Invalid channel name", { status: 400 });
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    // Namespace per site so tenants' channels never collide (matches the prefix
    // RealtimeEntrypoint.publish applies server-side).
    const id = env.CHANNELS.idFromName(`${siteId}:${channel}`);
    return env.CHANNELS.get(id).fetch(request);
  }

  // Public end-user uploads (env.UPLOADS.put -> /__uploads/<key>), served from R2.
  if (url.pathname.startsWith("/__uploads/")) {
    return serveUpload(env, siteId, decodeURIComponent(url.pathname.slice("/__uploads/".length)));
  }

  // Browser-facing island assets (served regardless of published state).
  if (url.pathname.startsWith("/__vendor/")) {
    return serveVendor(url.pathname);
  }
  if (url.pathname.startsWith("/__modules/")) {
    const cookie = getCookie(request, PREVIEW_COOKIE);
    const previewOk = !!cookie && (await isValidPreviewToken(env, siteId, cookie));
    return serveModule(env, siteId, url.pathname, previewOk);
  }

  // serverFn RPC: /__fn/<scope>/<id>. The scope selects the site tree exactly
  // like page serving — `draft` (preview cookie required) loads the draft
  // isolate, `v<N>` the published one. We forward the whole request (incl. the
  // /__fn/... path) into the SAME isolate a page render uses, so the serverFn
  // handler receives the identical narrow-capability env. No duplicated wiring.
  if (url.pathname.startsWith("/__fn/")) {
    const scope = url.pathname.slice("/__fn/".length).split("/")[0];
    if (scope === "draft") {
      const cookie = getCookie(request, PREVIEW_COOKIE);
      const previewOk = !!cookie && (await isValidPreviewToken(env, siteId, cookie));
      if (!previewOk) {
        return new Response("Preview cookie required for draft server functions.", {
          status: 403,
        });
      }
      return serveDraft(env, ctx, request, siteId);
    }
    if (/^v\d+$/.test(scope)) {
      return servePublished(env, ctx, request, siteId);
    }
    return new Response("Bad server-function scope.", { status: 400 });
  }

  if (url.pathname === "/__preview") {
    const token = url.searchParams.get("token") ?? "";
    if (!(await isValidPreviewToken(env, siteId, token))) {
      return new Response("Invalid or expired preview token", { status: 403 });
    }
    const headers = new Headers({ Location: "/" });
    headers.append(
      "Set-Cookie",
      `${PREVIEW_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=1800; SameSite=Lax`,
    );
    return new Response(null, { status: 302, headers });
  }

  const cookie = getCookie(request, PREVIEW_COOKIE);
  const previewOk = !!cookie && (await isValidPreviewToken(env, siteId, cookie));

  // Precedence: a FILE-LIKE path (its last segment has an extension, e.g.
  // /favicon.svg, /og.png, /files/brochure.pdf) is served from public/ FIRST, so
  // a greedy dynamic route like `[lang]` (= /:lang) can't shadow static assets
  // (reported: favicon/og served the page as HTML). Extensionless paths route as
  // normal, with the usual static fallback on a 404. Draft cookie -> draft
  // manifest; otherwise published manifest.
  const lastSegment = url.pathname.split("/").pop() ?? "";
  if (lastSegment.includes(".")) {
    const asset = await serveStaticAsset(env, siteId, request, { draft: previewOk });
    if (asset) return asset;
  }
  const response = previewOk
    ? await serveDraft(env, ctx, request, siteId)
    : await servePublished(env, ctx, request, siteId);
  if (response.status === 404) {
    const asset = await serveStaticAsset(env, siteId, request, { draft: previewOk });
    if (asset) return asset;
  }
  return response;
}
