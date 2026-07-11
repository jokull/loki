// Control-plane DATA layer shared by both workers:
//   - loki (supervisor / MCP / tenant runtime), and
//   - loftur-web (TanStack Start account dashboard).
//
// Everything here is pure D1 + crypto over a MINIMAL bindings surface
// ({ DB, SECRETS_KEY }) — NO agent-cms, NO cloudflare:workers entrypoints, NO
// loki site tree — so the web app can import it without pulling the whole
// supervisor. loki's src/tenants.ts and src/secrets.ts RE-EXPORT from here, so
// there is one source of truth for sites, editor tokens, and secrets.

import { sealSecret, openSecret } from "./crypto";

// Minimal structural D1 surface, so this module depends on neither
// @cloudflare/workers-types (loki) nor DOM lib (web) — a real D1Database
// satisfies it. Only the slice of the D1 API we actually use.
export interface D1StmtLike {
  bind(...values: unknown[]): D1StmtLike;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta?: { changes?: number } }>;
}
export interface D1Like {
  prepare(query: string): D1StmtLike;
}

/** The minimal binding surface these helpers need. loki's full Env satisfies it. */
export interface DataEnv {
  DB: D1Like;
  SECRETS_KEY?: string;
}

// ---- sites ------------------------------------------------------------------

export type SiteStatus = "active" | "unpublished" | "deleted" | "suspended" | "purging";

export interface Site {
  id: string;
  subdomain: string;
  email: string | null;
  api_key_hash: string;
  created_at: string;
  status: SiteStatus;
  deleted_at: string | null;
  unpublished_at: string | null;
  suspended_at: string | null;
}

const SITE_COLS =
  "id, subdomain, email, api_key_hash, created_at, status, deleted_at, unpublished_at, suspended_at";

/** Subdomains reserved for the platform itself. */
const RESERVED = new Set([
  "www",
  "app",
  "api",
  "mcp",
  "auth",
  "admin",
  "dashboard",
  "dash",
  "help",
  "docs",
  "doc",
  "status",
  "mail",
  "email",
  "ftp",
  "cdn",
  "assets",
  "static",
  "default",
  "loftur",
  "test",
  "staging",
  "stage",
  "dev",
  "beta",
  "internal",
  "console",
  "account",
  "accounts",
  "billing",
  "support",
  "blog",
  "about",
  "__default__",
  "ns",
  "ns1",
  "ns2",
  "smtp",
  "webmail",
  "portal",
  "id",
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
      error: "Use lowercase letters, numbers, and hyphens only (no leading/trailing hyphen).",
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
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** A fresh, high-entropy owner API key. Prefix `lft_` for greppability. */
export function generateApiKey(): string {
  return `lft_${randomHex(24)}`;
}

function generateSiteId(): string {
  return randomHex(12);
}

export async function getSiteBySubdomain(env: DataEnv, subdomain: string): Promise<Site | null> {
  return env.DB.prepare(`SELECT ${SITE_COLS} FROM sites WHERE subdomain = ?`)
    .bind(subdomain.toLowerCase())
    .first<Site>();
}

export async function getSiteById(env: DataEnv, id: string): Promise<Site | null> {
  return env.DB.prepare(`SELECT ${SITE_COLS} FROM sites WHERE id = ?`).bind(id).first<Site>();
}

export async function getSiteByApiKey(env: DataEnv, key: string): Promise<Site | null> {
  const hash = await hashApiKey(key);
  return env.DB.prepare(`SELECT ${SITE_COLS} FROM sites WHERE api_key_hash = ?`)
    .bind(hash)
    .first<Site>();
}

/** All sites owned by an email (the dashboard's "my sites"). */
export async function getSitesByEmail(env: DataEnv, email: string): Promise<Site[]> {
  const { results } = await env.DB.prepare(
    `SELECT ${SITE_COLS} FROM sites WHERE lower(email) = ? ORDER BY created_at DESC`,
  )
    .bind(email.trim().toLowerCase())
    .all<Site>();
  return results ?? [];
}

export type CreateSiteResult =
  | { ok: true; site: Site; apiKey: string }
  | { ok: false; error: string };

/** Claim a subdomain: create a site row + return its API key (shown once). */
export async function createSite(
  env: DataEnv,
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
    status: "active",
    deleted_at: null,
    unpublished_at: null,
    suspended_at: null,
  };
  return { ok: true, site, apiKey };
}

/**
 * Rotate a site's OWNER key: generate a new key, replace the stored hash, return
 * the new key ONCE. Backs dashboard key recovery — an owner who lost their key
 * signs in by email and rotates. Returns null if the site doesn't exist.
 */
export async function rotateOwnerKey(env: DataEnv, siteId: string): Promise<string | null> {
  const site = await getSiteById(env, siteId);
  if (!site) return null;
  const apiKey = generateApiKey();
  const hash = await hashApiKey(apiKey);
  await env.DB.prepare("UPDATE sites SET api_key_hash = ? WHERE id = ?").bind(hash, siteId).run();
  return apiKey;
}

// ---- scoped (editor) tokens -------------------------------------------------

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
  return `lft_ed_${randomHex(24)}`;
}

/** Mint a scoped token for a site (default role: editor). Returns it ONCE. */
export async function createSiteToken(
  env: DataEnv,
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
export async function getSiteToken(env: DataEnv, token: string): Promise<SiteToken | null> {
  const hash = await hashApiKey(token);
  return env.DB.prepare(
    "SELECT id, site_id, token_hash, role, label, created_at FROM site_tokens WHERE token_hash = ?",
  )
    .bind(hash)
    .first<SiteToken>();
}

export async function listSiteTokens(
  env: DataEnv,
  siteId: string,
): Promise<Array<Omit<SiteToken, "token_hash">>> {
  const { results } = await env.DB.prepare(
    "SELECT id, site_id, role, label, created_at FROM site_tokens WHERE site_id = ? ORDER BY created_at DESC",
  )
    .bind(siteId)
    .all<Omit<SiteToken, "token_hash">>();
  return results ?? [];
}

/** Revoke a token by id, scoped to the site. */
export async function revokeSiteToken(env: DataEnv, siteId: string, id: string): Promise<boolean> {
  const res = await env.DB.prepare("DELETE FROM site_tokens WHERE site_id = ? AND id = ?")
    .bind(siteId, id)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

// ---- per-site secrets -------------------------------------------------------

const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export function validateSecretName(name: string): string | null {
  if (!SECRET_NAME_RE.test(name)) {
    return (
      "Secret name must look like an env var: start with a letter or underscore, " +
      "then letters/numbers/underscores, max 64 chars (e.g. STRIPE_SECRET_KEY)."
    );
  }
  return null;
}

export async function setSecret(
  env: DataEnv,
  siteId: string,
  name: string,
  value: string,
): Promise<void> {
  const sealed = await sealSecret(env.SECRETS_KEY, siteId, value);
  await env.DB.prepare(
    "INSERT INTO site_secrets (site_id, name, iv, ciphertext) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(site_id, name) DO UPDATE SET iv = excluded.iv, " +
      "ciphertext = excluded.ciphertext, updated_at = CURRENT_TIMESTAMP",
  )
    .bind(siteId, name, sealed.iv, sealed.ciphertext)
    .run();
}

export async function getSecret(
  env: DataEnv,
  siteId: string,
  name: string,
): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT iv, ciphertext FROM site_secrets WHERE site_id = ? AND name = ?",
  )
    .bind(siteId, name)
    .first<{ iv: string; ciphertext: string }>();
  if (!row) return null;
  return openSecret(env.SECRETS_KEY, siteId, row);
}

export async function listSecretNames(
  env: DataEnv,
  siteId: string,
): Promise<Array<{ name: string; created_at: string; updated_at: string }>> {
  const { results } = await env.DB.prepare(
    "SELECT name, created_at, updated_at FROM site_secrets WHERE site_id = ? ORDER BY name",
  )
    .bind(siteId)
    .all<{ name: string; created_at: string; updated_at: string }>();
  return results ?? [];
}

export async function deleteSecret(env: DataEnv, siteId: string, name: string): Promise<boolean> {
  const res = await env.DB.prepare("DELETE FROM site_secrets WHERE site_id = ? AND name = ?")
    .bind(siteId, name)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

// ---- account tokens (PATs) --------------------------------------------------
// A PAT authenticates as a whole account (an email), not a single site. It backs
// the unified account MCP: an agent holding one PAT can claim subdomains and
// build any of the account's sites. See migrations/0010_account_tokens.sql.

export interface AccountTokenRow {
  id: string;
  email: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
}

/** A fresh account PAT. Prefix `lftr_pat_` to distinguish from site keys. */
export function generateAccountToken(): string {
  return `lftr_pat_${randomHex(24)}`;
}

/** Mint an account PAT for an email. Returns the plaintext token ONCE. */
export async function createAccountToken(
  env: DataEnv,
  email: string,
  label: string | null,
): Promise<{ id: string; token: string }> {
  const id = generateSiteId();
  const token = generateAccountToken();
  const hash = await hashApiKey(token);
  await env.DB.prepare(
    "INSERT INTO account_tokens (id, email, token_hash, label) VALUES (?, ?, ?, ?)",
  )
    .bind(id, email.trim().toLowerCase(), hash, label)
    .run();
  return { id, token };
}

/** Resolve a PAT to its account email (null if unknown). Stamps last_used_at. */
export async function getAccountByToken(
  env: DataEnv,
  token: string,
): Promise<{ email: string } | null> {
  const hash = await hashApiKey(token);
  const row = await env.DB.prepare("SELECT id, email FROM account_tokens WHERE token_hash = ?")
    .bind(hash)
    .first<{ id: string; email: string }>();
  if (!row) return null;
  // Best-effort recency stamp; never block auth on it.
  await env.DB.prepare("UPDATE account_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(row.id)
    .run()
    .catch(() => {});
  return { email: row.email };
}

/** List an account's PATs (never the token itself). */
export async function listAccountTokens(env: DataEnv, email: string): Promise<AccountTokenRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, email, label, created_at, last_used_at FROM account_tokens WHERE lower(email) = ? ORDER BY created_at DESC",
  )
    .bind(email.trim().toLowerCase())
    .all<AccountTokenRow>();
  return results ?? [];
}

/** Revoke a PAT by id, scoped to the owning account. */
export async function revokeAccountToken(
  env: DataEnv,
  email: string,
  id: string,
): Promise<boolean> {
  const res = await env.DB.prepare("DELETE FROM account_tokens WHERE id = ? AND lower(email) = ?")
    .bind(id, email.trim().toLowerCase())
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

// ---- site lifecycle ---------------------------------------------------------
// See PLAN.md. Owner ops flip status; a daily reaper hard-purges `deleted`
// sites > 7 days old. Deleting HOLDS the subdomain lease until purge.

export const RECOVERY_WINDOW_DAYS = 7;
export const PURGE_LOCK_HOURS = 24; // purge_site can't run until 24h after delete
export const DEFAULT_SITE_QUOTA = 5;

/**
 * Normalize an account email so aliases collapse to ONE account (can't farm the
 * free-site quota): lowercase + trim + strip a `+tag` from the local part. NOT
 * gemail dot-collapsing (provider-specific). The magic link is still delivered to
 * the raw address; identity/quota key on this.
 */
export function normalizeAccountEmail(raw: string | null | undefined): string {
  const e = (raw ?? "").trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at <= 0) return e;
  const local = e.slice(0, at).replace(/\+.*$/, "");
  return local + e.slice(at);
}

type LifecycleResult = { ok: true; site: Site } | { ok: false; error: string };

async function transition(
  env: DataEnv,
  siteId: string,
  set: string,
  binds: unknown[],
): Promise<Site | null> {
  await env.DB.prepare(`UPDATE sites SET ${set} WHERE id = ?`)
    .bind(...binds, siteId)
    .run();
  return getSiteById(env, siteId);
}

/** Soft-delete: active|unpublished -> deleted (offline, 7-day recovery, name held). */
export async function deleteSite(env: DataEnv, site: Site): Promise<LifecycleResult> {
  if (site.status === "suspended")
    return { ok: false, error: "This site is suspended by the platform; contact support." };
  if (site.status === "deleted")
    return {
      ok: false,
      error: `"${site.subdomain}" is already deleted (recoverable until it reaps).`,
    };
  if (site.status === "purging") return { ok: false, error: "This site is being purged." };
  const updated = await transition(env, site.id, "status = 'deleted', deleted_at = ?", [
    new Date().toISOString(),
  ]);
  return updated ? { ok: true, site: updated } : { ok: false, error: "Site not found." };
}

/** Undo a soft-delete within the window: deleted -> active (full restore). */
export async function restoreSite(env: DataEnv, site: Site): Promise<LifecycleResult> {
  if (site.status === "suspended")
    return { ok: false, error: "This site is suspended by the platform; contact support." };
  if (site.status !== "deleted")
    return { ok: false, error: `"${site.subdomain}" is not deleted (status: ${site.status}).` };
  const updated = await transition(env, site.id, "status = 'active', deleted_at = NULL", []);
  return updated ? { ok: true, site: updated } : { ok: false, error: "Site not found." };
}

/** Pause a live site: active -> unpublished (offline, data intact, no countdown). */
export async function unpublishSite(env: DataEnv, site: Site): Promise<LifecycleResult> {
  if (site.status === "suspended")
    return { ok: false, error: "This site is suspended by the platform; contact support." };
  if (site.status === "unpublished")
    return { ok: false, error: `"${site.subdomain}" is already unpublished.` };
  if (site.status !== "active")
    return { ok: false, error: `Can't unpublish a site with status "${site.status}".` };
  const updated = await transition(env, site.id, "status = 'unpublished', unpublished_at = ?", [
    new Date().toISOString(),
  ]);
  return updated ? { ok: true, site: updated } : { ok: false, error: "Site not found." };
}

/** Resume a paused site: unpublished -> active. */
export async function republishSite(env: DataEnv, site: Site): Promise<LifecycleResult> {
  if (site.status === "suspended")
    return { ok: false, error: "This site is suspended by the platform; contact support." };
  if (site.status !== "unpublished")
    return { ok: false, error: `"${site.subdomain}" is not unpublished (status: ${site.status}).` };
  const updated = await transition(env, site.id, "status = 'active', unpublished_at = NULL", []);
  return updated ? { ok: true, site: updated } : { ok: false, error: "Site not found." };
}

/** ms since a site was deleted, or null if not deleted. */
export function deletedAgeMs(site: Site): number | null {
  if (site.status !== "deleted" || !site.deleted_at) return null;
  return Date.now() - new Date(site.deleted_at).getTime();
}

// ---- quota ------------------------------------------------------------------

/** The site quota for a (normalized) email: an override, else the default. -1 = unlimited. */
export async function getAccountQuota(env: DataEnv, email: string): Promise<number> {
  const row = await env.DB.prepare("SELECT max_sites FROM account_quotas WHERE email = ?")
    .bind(normalizeAccountEmail(email))
    .first<{ max_sites: number }>();
  return row ? row.max_sites : DEFAULT_SITE_QUOTA;
}

/** Sites that occupy a quota slot for an email: active + unpublished + deleted
 *  (suspended is the platform's; purging is being reaped). */
export async function accountSlotSites(env: DataEnv, email: string): Promise<Site[]> {
  const norm = normalizeAccountEmail(email);
  const { results } = await env.DB.prepare(
    `SELECT ${SITE_COLS} FROM sites WHERE lower(email) = ? AND status IN ('active','unpublished','deleted') ORDER BY created_at DESC`,
  )
    .bind(norm)
    .all<Site>();
  return results ?? [];
}

/** Record an over-cap claim attempt (the commercial-interest harvest). */
export async function recordQuotaRequest(
  env: DataEnv,
  email: string,
  subdomain: string,
): Promise<void> {
  await env.DB.prepare("INSERT INTO quota_requests (id, email, subdomain) VALUES (?, ?, ?)")
    .bind(generateSiteId(), normalizeAccountEmail(email), subdomain.trim().toLowerCase())
    .run()
    .catch(() => {});
}
