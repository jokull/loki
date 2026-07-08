// Site static/design assets ("it's just a file").
//
// This is a DIFFERENT concern from src/site/assets.ts, which serves island
// vendor/module JS at /__vendor and /__modules for browser hydration. THIS file
// handles authored static files (favicon, images, CSS backgrounds, PDFs) that
// the site references by URL.
//
// Model:
// - Authors store files under `public/…`; they serve at the site ROOT
//   (public/favicon.ico -> /favicon.ico, public/img/hero.jpg -> /img/hero.jpg).
//   That mapping is the single serving rule and the returned `url`.
// - Bytes are content-addressed in R2 at `site/blob/<sha256>` (deduped, written
//   at authoring time). agent-cms keys its own content assets under `uploads/…`
//   in the same bucket, so the two never collide.
// - The draft manifest lives in the D1 `site_assets` table; publish snapshots it
//   into site_versions.assets, so assets version/rollback exactly like code.

import type { Env } from "../env";
import {
  getPublishedVersionId,
  getVersion,
  readAsset,
  upsertAsset,
  versionAssetManifest,
  type AssetManifestEntry,
} from "./store";

const BLOB_PREFIX = "site/blob/";
const PUBLIC_PREFIX = "public/";

/** ~2 MB cap for inline base64 writes (site_asset_write). */
export const MAX_INLINE_BYTES = 2 * 1024 * 1024;

// Serving-path prefixes owned by Loki/CMS, not the site. A public/ asset that
// maps to one of these can never be reached (the supervisor intercepts these
// paths before static-asset serving), so authoring one is rejected up front.
const RESERVED_PREFIXES = [
  "/mcp",
  "/graphql",
  "/api",
  "/assets",
  "/uploads", // agent-cms content-asset bytes (R2 passthrough)
  "/health",
  "/paths",
  "/openapi.json",
  "/__", // /__vendor, /__modules, /__preview, /__realtime, …
];

export const RESERVED_PATHS_DOC =
  "/mcp, /graphql, /api/*, /assets/*, /uploads/*, /health, /paths/*, " +
  "/openapi.json, and /__* (/__vendor, /__modules, /__preview, /__realtime)";

const CONTENT_TYPES: Record<string, string> = {
  ico: "image/x-icon",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  pdf: "application/pdf",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  wasm: "application/wasm",
  map: "application/json; charset=utf-8",
  webmanifest: "application/manifest+json",
};

/** Infer a Content-Type from a path's extension (octet-stream fallback). */
export function inferContentType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/** The exact URL a `public/…` asset serves at (root-mapped). */
export function assetServingUrl(path: string): string {
  return "/" + path.slice(PUBLIC_PREFIX.length);
}

/** Reverse of assetServingUrl: a root request path -> its public/ tree path. */
function servingUrlToAssetPath(pathname: string): string {
  return PUBLIC_PREFIX + pathname.replace(/^\//, "");
}

function isReserved(servingPath: string): boolean {
  return RESERVED_PREFIXES.some(
    (p) => servingPath === p || servingPath.startsWith(p + "/") || servingPath.startsWith(p),
  );
}

export interface PathCheck {
  ok: boolean;
  error?: string;
  url?: string;
}

/**
 * Validate an authored asset path. Enforces the single rule (`public/…`), keeps
 * it filesystem-clean, and rejects paths whose root URL collides with a claimed
 * Loki/CMS route (which would make the asset unreachable).
 */
export function checkAssetPath(path: string): PathCheck {
  if (typeof path !== "string" || path.length === 0) {
    return { ok: false, error: "path is required." };
  }
  if (path !== path.trim()) {
    return { ok: false, error: "path must not have leading/trailing whitespace." };
  }
  if (!path.startsWith(PUBLIC_PREFIX)) {
    return {
      ok: false,
      error:
        `Asset paths must start with "public/" — files under public/ serve at the ` +
        `site root (e.g. public/favicon.ico -> /favicon.ico, public/img/hero.jpg -> ` +
        `/img/hero.jpg). Got: ${path}`,
    };
  }
  if (path === PUBLIC_PREFIX) {
    return { ok: false, error: 'path must name a file under "public/".' };
  }
  const rest = path.slice(PUBLIC_PREFIX.length);
  if (
    rest.length === 0 ||
    rest.startsWith("/") ||
    rest.endsWith("/") ||
    rest.includes("//") ||
    rest.split("/").some((seg) => seg === "" || seg === "." || seg === "..")
  ) {
    return { ok: false, error: `Invalid asset path segment in: ${path}` };
  }
  const url = assetServingUrl(path);
  if (isReserved(url)) {
    return {
      ok: false,
      error:
        `public/${rest} would serve at ${url}, which collides with a reserved ` +
        `Loki/CMS path. Reserved: ${RESERVED_PATHS_DOC}. Choose another path.`,
    };
  }
  return { ok: true, url };
}

// ---- storage ----------------------------------------------------------------

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface StoredAsset {
  path: string;
  url: string;
  hash: string;
  size: number;
  contentType: string;
}

/**
 * Content-address `bytes`, put them to R2 at `site/blob/<hash>` only if absent
 * (HEAD first), then record/replace the draft manifest entry for `path`.
 */
export async function storeAsset(
  env: Env,
  path: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<StoredAsset> {
  const hash = await sha256Bytes(bytes);
  const key = BLOB_PREFIX + hash;
  const existing = await env.ASSETS.head(key);
  if (!existing) {
    await env.ASSETS.put(key, bytes, {
      httpMetadata: { contentType },
    });
  }
  await upsertAsset(env, path, hash, contentType, bytes.length);
  return {
    path,
    url: assetServingUrl(path),
    hash,
    size: bytes.length,
    contentType,
  };
}

// ---- serving ----------------------------------------------------------------

/**
 * Serve a site static asset for a root request, or return null if this path
 * maps to no asset (the caller then returns a clean 404). This is the SINGLE
 * serving seam — a future Cloudflare Images transform (?w=…) slots in here.
 *
 * - published mode reads the live version's snapshotted manifest (version-
 *   pinned: a rollback that predates an asset makes it 404);
 * - draft mode (valid preview cookie) reads the draft site_assets table.
 */
export async function serveStaticAsset(
  env: Env,
  request: Request,
  opts: { draft: boolean },
): Promise<Response | null> {
  const url = new URL(request.url);
  const pathname = url.pathname;
  if (pathname === "/" || isReserved(pathname)) return null;

  const assetPath = servingUrlToAssetPath(pathname);

  let entry: AssetManifestEntry | null = null;
  if (opts.draft) {
    const row = await readAsset(env, assetPath);
    if (row) {
      entry = { hash: row.hash, contentType: row.content_type, size: row.size };
    }
  } else {
    const versionId = await getPublishedVersionId(env);
    if (versionId != null) {
      const version = await getVersion(env, versionId);
      if (version) entry = versionAssetManifest(version)[assetPath] ?? null;
    }
  }
  if (!entry) return null;

  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "GET, HEAD" },
    });
  }

  const etag = `"${entry.hash}"`;
  const cacheControl = opts.draft
    ? "no-store"
    : "public, max-age=300, must-revalidate";

  // Cheap 304 without touching R2.
  const inm = request.headers.get("if-none-match");
  if (inm && ifNoneMatchHits(inm, etag)) {
    return new Response(null, {
      status: 304,
      headers: { etag, "cache-control": cacheControl },
    });
  }

  // TODO: image transforms — inspect url.searchParams (?w=&h=&fit=…) here and
  // route through Cloudflare Images before falling back to the raw blob.

  const object = await env.ASSETS.get(BLOB_PREFIX + entry.hash);
  if (!object) {
    // Manifest references a blob that is not in R2 — clean 404, never 500.
    return new Response("Not found", { status: 404 });
  }

  const headers = new Headers({
    "content-type": entry.contentType,
    "cache-control": cacheControl,
    etag,
    "content-length": String(entry.size),
  });
  if (method === "HEAD") {
    // Drain the body so the R2 stream isn't left dangling.
    await object.arrayBuffer().catch(() => undefined);
    return new Response(null, { status: 200, headers });
  }
  return new Response(object.body, { status: 200, headers });
}

/** RFC-compliant-enough If-None-Match check (supports `*` and comma lists). */
function ifNoneMatchHits(header: string, etag: string): boolean {
  const raw = header.trim();
  if (raw === "*") return true;
  return raw
    .split(",")
    .map((t) => t.trim().replace(/^W\//, ""))
    .some((t) => t === etag);
}
