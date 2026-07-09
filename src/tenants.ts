// Loftur tenant registry: the `sites` table maps a subdomain to a site_id and an
// API-key hash. Signup creates a row and returns the key ONCE (only its sha-256
// is stored). The MCP endpoint resolves a bearer key -> site_id; site serving
// resolves {subdomain}.loftur.app -> site_id.

import type { Env } from "./env";
import { DEFAULT_SITE_ID } from "./site/store";

export interface Site {
  id: string;
  subdomain: string;
  email: string | null;
  api_key_hash: string;
  created_at: string;
}

/** Subdomains we keep for the platform itself / to avoid confusion. */
const RESERVED = new Set([
  "www", "app", "api", "mcp", "auth", "admin", "dashboard", "dash", "help",
  "docs", "doc", "status", "mail", "email", "ftp", "cdn", "assets", "static",
  "default", "loftur", "test", "staging", "stage", "dev", "beta", "internal",
  "console", "account", "accounts", "billing", "support", "blog", "about",
  "__default__", "ns", "ns1", "ns2", "smtp", "webmail", "portal", "id",
]);

export interface SubdomainCheck {
  ok: boolean;
  error?: string;
}

/** Validate a requested subdomain label (the part before .loftur.app). */
export function validateSubdomain(raw: string): SubdomainCheck {
  const sub = (raw ?? "").trim().toLowerCase();
  if (!sub) return { ok: false, error: "Pick a subdomain." };
  if (sub.length < 3 || sub.length > 30) {
    return { ok: false, error: "Subdomain must be 3–30 characters." };
  }
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(sub)) {
    return {
      ok: false,
      error:
        "Use lowercase letters, numbers, and hyphens only (no leading/trailing hyphen).",
    };
  }
  if (sub.includes("--")) {
    return { ok: false, error: "Subdomain can't contain a double hyphen." };
  }
  if (RESERVED.has(sub)) {
    return { ok: false, error: `“${sub}” is reserved — pick another name.` };
  }
  return { ok: true };
}

/** sha-256 hex of an API key (what we store; the key itself is shown once). */
export async function hashApiKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** A fresh, high-entropy API key. Prefix `lft_` for greppability. */
export function generateApiKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `lft_${hex}`;
}

/** A fresh site id. */
function generateSiteId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function getSiteBySubdomain(
  env: Env,
  subdomain: string,
): Promise<Site | null> {
  return await env.DB.prepare(
    "SELECT id, subdomain, email, api_key_hash, created_at FROM sites WHERE subdomain = ?",
  )
    .bind(subdomain.toLowerCase())
    .first<Site>();
}

export async function getSiteById(
  env: Env,
  id: string,
): Promise<Site | null> {
  return await env.DB.prepare(
    "SELECT id, subdomain, email, api_key_hash, created_at FROM sites WHERE id = ?",
  )
    .bind(id)
    .first<Site>();
}

/** The public origin a site is served from (for preview/absolute URLs). */
export async function siteOrigin(
  env: Env,
  siteId: string,
  fallback: string,
): Promise<string> {
  if (siteId === DEFAULT_SITE_ID) return fallback;
  const site = await getSiteById(env, siteId);
  return site ? `https://${site.subdomain}.loftur.app` : fallback;
}

export async function getSiteByApiKey(
  env: Env,
  key: string,
): Promise<Site | null> {
  const hash = await hashApiKey(key);
  return await env.DB.prepare(
    "SELECT id, subdomain, email, api_key_hash, created_at FROM sites WHERE api_key_hash = ?",
  )
    .bind(hash)
    .first<Site>();
}

export type CreateSiteResult =
  | { ok: true; site: Site; apiKey: string }
  | { ok: false; error: string };

/** Claim a subdomain: create a site row + return its API key (shown once). */
export async function createSite(
  env: Env,
  subdomainRaw: string,
  emailRaw: string | null,
): Promise<CreateSiteResult> {
  const check = validateSubdomain(subdomainRaw);
  if (!check.ok) return { ok: false, error: check.error! };
  const subdomain = subdomainRaw.trim().toLowerCase();

  const existing = await getSiteBySubdomain(env, subdomain);
  if (existing) {
    return { ok: false, error: `“${subdomain}.loftur.app” is already taken.` };
  }

  const email = emailRaw?.trim() || null;
  const id = generateSiteId();
  const apiKey = generateApiKey();
  const apiKeyHash = await hashApiKey(apiKey);

  try {
    await env.DB.prepare(
      "INSERT INTO sites (id, subdomain, email, api_key_hash) VALUES (?, ?, ?, ?)",
    )
      .bind(id, subdomain, email, apiKeyHash)
      .run();
  } catch (err) {
    // UNIQUE(subdomain) race — treat as taken.
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE|constraint/i.test(msg)) {
      return { ok: false, error: `“${subdomain}.loftur.app” is already taken.` };
    }
    return { ok: false, error: `Could not create site: ${msg}` };
  }

  const site: Site = {
    id,
    subdomain,
    email,
    api_key_hash: apiKeyHash,
    created_at: new Date().toISOString(),
  };
  return { ok: true, site, apiKey };
}

/** Re-export for callers that need the legacy id. */
export { DEFAULT_SITE_ID };
