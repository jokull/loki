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

// ---- scoped tokens (editor) -------------------------------------------------

export type SiteRole = "owner" | "editor";

export interface SiteToken {
  id: string;
  site_id: string;
  token_hash: string;
  role: string;
  label: string | null;
  created_at: string;
}

/** A fresh editor MCP token. Prefixed `lft_ed_` to distinguish from owner keys. */
export function generateEditorToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `lft_ed_${hex}`;
}

/** Mint a scoped token for a site (default role: editor). Returns it ONCE. */
export async function createSiteToken(
  env: Env,
  siteId: string,
  label: string | null,
  role: SiteRole = "editor",
): Promise<{ id: string; token: string }> {
  const id = generateSiteId();
  const token = generateEditorToken();
  const hash = await hashApiKey(token);
  await env.DB.prepare(
    "INSERT INTO site_tokens (id, site_id, token_hash, role, label) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(id, siteId, hash, role, label)
    .run();
  return { id, token };
}

/** Resolve a scoped token to its site + role (null if unknown). */
export async function getSiteToken(
  env: Env,
  token: string,
): Promise<SiteToken | null> {
  const hash = await hashApiKey(token);
  return await env.DB.prepare(
    "SELECT id, site_id, token_hash, role, label, created_at FROM site_tokens WHERE token_hash = ?",
  )
    .bind(hash)
    .first<SiteToken>();
}

export async function listSiteTokens(
  env: Env,
  siteId: string,
): Promise<Array<Omit<SiteToken, "token_hash">>> {
  const { results } = await env.DB.prepare(
    "SELECT id, site_id, role, label, created_at FROM site_tokens WHERE site_id = ? ORDER BY created_at DESC",
  )
    .bind(siteId)
    .all<Omit<SiteToken, "token_hash">>();
  return results ?? [];
}

/** Revoke a token by id, scoped to the site (so an editor can't revoke another site's). */
export async function revokeSiteToken(
  env: Env,
  siteId: string,
  id: string,
): Promise<boolean> {
  const res = await env.DB.prepare(
    "DELETE FROM site_tokens WHERE site_id = ? AND id = ?",
  )
    .bind(siteId, id)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/** Re-export for callers that need the legacy id. */
export { DEFAULT_SITE_ID };
