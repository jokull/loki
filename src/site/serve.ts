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
import {
  getPublishedVersionId,
  getVersion,
  getState,
  listFiles,
} from "./store";

const PREVIEW_COOKIE = "loki_preview";

/** Build the draft bundle from the live working tree (site_files). */
export async function buildDraftBundle(env: Env): Promise<Bundle> {
  const files = await listFiles(env);
  const bundle: Bundle = {};
  for (const f of files) {
    bundle[f.path] = f.compiled ?? f.source;
  }
  return bundle;
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
): Fetcher {
  return ctxExports(ctx).GraphqlEntrypoint({ props: { includeDrafts } }) as Fetcher;
}

/** Parse the writable-model allowlist from the serving tree's loki.config.json. */
export function parseWritableModels(bundle: Bundle): string[] {
  const raw = bundle["loki.config.json"];
  if (!raw) return [];
  try {
    const cfg = JSON.parse(raw) as { writableModels?: unknown };
    const list = cfg?.writableModels;
    return Array.isArray(list)
      ? list.filter((m): m is string => typeof m === "string")
      : [];
  } catch {
    return [];
  }
}

async function runSite(
  env: Env,
  ctx: ExecutionContext,
  loaderId: string,
  bundle: Bundle,
  includeDrafts: boolean,
  request: Request,
  islandBase: string,
): Promise<Response> {
  const built = buildWorkerCode(bundle);
  const graphql = makeGraphqlBinding(ctx, includeDrafts);
  const exports = ctxExports(ctx);
  const workerEnv: Record<string, unknown> = {
    GRAPHQL_DRAFTS: includeDrafts ? "true" : "false",
    // Version-aware base for island module URLs, read by the runtime shim.
    LOKI_ISLAND_BASE: islandBase,
  };
  if (graphql) workerEnv.GRAPHQL = graphql;
  // Scoped record writes: RECORDS.create is gated by this tree's allowlist.
  if (exports?.RecordsEntrypoint) {
    workerEnv.RECORDS = exports.RecordsEntrypoint({
      props: { allowlist: parseWritableModels(bundle) },
    });
  }
  // Realtime fan-out: REALTIME.publish(channel, message).
  if (exports?.RealtimeEntrypoint) {
    workerEnv.REALTIME = exports.RealtimeEntrypoint({});
  }
  const stub = env.LOADER.get(loaderId, () => ({
    compatibilityDate: built.compatibilityDate,
    mainModule: built.mainModule,
    modules: built.modules,
    env: workerEnv,
    globalOutbound: null,
  }));
  try {
    return await stub.getEntrypoint().fetch(request);
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    return new Response(
      `Site worker error (loader ${loaderId}):\n${message}`,
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
  bundle: Bundle,
): Promise<Response> {
  const id = `smoke:${RUNTIME_VERSION}:${await sha256Hex(stableStringify(bundle))}:${Date.now()}`;
  return runSite(
    env,
    ctx,
    id,
    bundle,
    true,
    new Request("https://loki.internal/"),
    "/__modules/draft",
  );
}

const NO_SITE = `<!doctype html><html><head><meta charset="utf-8"><title>Loki</title></head><body style="font-family:system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem"><h1>Loki</h1><p>No site has been published yet. Use the <code>site_write</code> and <code>publish_site</code> MCP tools to build one.</p></body></html>`;

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

export async function readPreviewState(env: Env): Promise<PreviewState | null> {
  const raw = await getState(env, "preview_token");
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
  token: string,
): Promise<boolean> {
  const state = await readPreviewState(env);
  return !!state && state.token === token;
}

/** Serve the draft site tree (preview mode). */
export async function serveDraft(
  env: Env,
  ctx: ExecutionContext,
  request: Request,
): Promise<Response> {
  const bundle = await buildDraftBundle(env);
  if (Object.keys(bundle).length === 0) return placeholder();
  const id = `draft:${RUNTIME_VERSION}:${await sha256Hex(stableStringify(bundle))}`;
  return runSite(env, ctx, id, bundle, true, request, "/__modules/draft");
}

/** Serve the currently published site version. */
export async function servePublished(
  env: Env,
  ctx: ExecutionContext,
  request: Request,
): Promise<Response> {
  const versionId = await getPublishedVersionId(env);
  if (versionId == null) return placeholder();
  const version = await getVersion(env, versionId);
  if (!version) return placeholder();
  const bundle = JSON.parse(version.bundle) as Bundle;
  return runSite(
    env,
    ctx,
    `site:v${versionId}:${RUNTIME_VERSION}`,
    bundle,
    false,
    request,
    `/__modules/v${versionId}`,
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
): Promise<Response> {
  const url = new URL(request.url);

  // Realtime channel WebSocket supervisor: /__realtime/<channel> -> ChannelDO.
  if (url.pathname.startsWith("/__realtime/")) {
    const channel = decodeURIComponent(url.pathname.slice("/__realtime/".length));
    if (!channel || channel.includes("/")) {
      return new Response("Invalid channel name", { status: 400 });
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const id = env.CHANNELS.idFromName(channel);
    return env.CHANNELS.get(id).fetch(request);
  }

  // Browser-facing island assets (served regardless of published state).
  if (url.pathname.startsWith("/__vendor/")) {
    return serveVendor(url.pathname);
  }
  if (url.pathname.startsWith("/__modules/")) {
    const cookie = getCookie(request, PREVIEW_COOKIE);
    const previewOk = !!cookie && (await isValidPreviewToken(env, cookie));
    return serveModule(env, url.pathname, previewOk);
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
      const previewOk = !!cookie && (await isValidPreviewToken(env, cookie));
      if (!previewOk) {
        return new Response("Preview cookie required for draft server functions.", {
          status: 403,
        });
      }
      return serveDraft(env, ctx, request);
    }
    if (/^v\d+$/.test(scope)) {
      return servePublished(env, ctx, request);
    }
    return new Response("Bad server-function scope.", { status: 400 });
  }

  if (url.pathname === "/__preview") {
    const token = url.searchParams.get("token") ?? "";
    if (!(await isValidPreviewToken(env, token))) {
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
  const previewOk = !!cookie && (await isValidPreviewToken(env, cookie));

  // Routes take precedence over static files: dispatch to the site worker
  // first, and only fall back to a public/ static asset when it 404s. The
  // isolate is cache-warm, so the fallback costs one extra R2 lookup on a
  // genuine miss. Draft cookie -> draft manifest; otherwise published manifest.
  const response = previewOk
    ? await serveDraft(env, ctx, request)
    : await servePublished(env, ctx, request);
  if (response.status === 404) {
    const asset = await serveStaticAsset(env, request, { draft: previewOk });
    if (asset) return asset;
  }
  return response;
}
