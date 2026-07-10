// End-user file uploads for site isolates: env.UPLOADS.put(...).
//
// Stores user-uploaded files (avatars, images, attachments) in the shared R2
// bucket under a per-site prefix (`site/upload/<siteId>/...`), and serves them
// publicly at `/__uploads/<key>` on the site's own origin. Distinct from static
// site assets (public/, version-pinned) and CMS content assets (/uploads/).
//
// The isolate can't hold a raw R2 binding (Worker-Loader boundary), so it reaches
// this via the entrypoint stub. Bytes cross as base64 in the serverFn input —
// fine for avatars/images; large multipart streaming is later work. Reads are
// public (v1); gate write in your serverFn on `user`.

import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import { DEFAULT_SITE_ID } from "./site/store";

/** Storage prefix for a site's user uploads in the shared R2 bucket. */
export function uploadKey(siteId: string, key: string): string {
  return `site/upload/${siteId}/${key}`;
}

/** Reject traversal / absolute / weird keys. */
function cleanKey(raw: string): string | null {
  const key = String(raw || "")
    .replace(/^\/+/, "")
    .trim();
  if (!key || key.length > 256) return null;
  if (key.includes("..") || key.includes("//")) return null;
  if (!/^[A-Za-z0-9._\-/]+$/.test(key)) return null;
  return key;
}

function decodeBase64(input: string): Uint8Array {
  const comma = input.indexOf(",");
  const body = input.startsWith("data:") && comma !== -1 ? input.slice(comma + 1) : input;
  const bin = atob(body.replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

export interface PutResult {
  ok: boolean;
  key?: string;
  url?: string;
  size?: number;
  error?: string;
}

export class UploadsEntrypoint extends WorkerEntrypoint<Env, { siteId?: string }> {
  /**
   * Store a file from base64. Returns { url } — the path to reference/serve it at
   * (`/__uploads/<key>` on the site origin). Overwrites an existing key.
   */
  async put(key: string, base64: string, contentType?: string): Promise<PutResult> {
    const siteId = this.ctx.props?.siteId ?? DEFAULT_SITE_ID;
    const clean = cleanKey(key);
    if (!clean) return { ok: false, error: "Invalid key. Use letters/numbers/._-/ (no ..)." };
    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(base64);
    } catch {
      return { ok: false, error: "Invalid base64 data." };
    }
    if (bytes.length === 0) return { ok: false, error: "Empty file." };
    if (bytes.length > MAX_UPLOAD_BYTES) {
      return { ok: false, error: `File too large (max ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB).` };
    }
    await this.env.ASSETS.put(uploadKey(siteId, clean), bytes, {
      httpMetadata: contentType ? { contentType } : undefined,
    });
    return { ok: true, key: clean, url: `/__uploads/${clean}`, size: bytes.length };
  }

  /** Delete an uploaded file. */
  async delete(key: string): Promise<{ ok: boolean }> {
    const siteId = this.ctx.props?.siteId ?? DEFAULT_SITE_ID;
    const clean = cleanKey(key);
    if (!clean) return { ok: false };
    await this.env.ASSETS.delete(uploadKey(siteId, clean));
    return { ok: true };
  }
}

/** Serve a public user upload (`/__uploads/<key>`) from R2 for a site. */
export async function serveUpload(env: Env, siteId: string, key: string): Promise<Response> {
  const clean = cleanKey(key);
  if (!clean) return new Response("Bad key", { status: 400 });
  const obj = await env.ASSETS.get(uploadKey(siteId, clean));
  if (!obj) return new Response("Not found", { status: 404 });
  return new Response(obj.body, {
    status: 200,
    headers: {
      "content-type": obj.httpMetadata?.contentType || "application/octet-stream",
      "cache-control": "public, max-age=3600",
      etag: obj.httpEtag,
    },
  });
}
