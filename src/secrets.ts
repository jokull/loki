// Per-site secret store: encrypted key/value pairs an owner sets so their site's
// server code can call third-party APIs (Stripe, Resend, OpenAI, …) without ever
// hardcoding a key into the source (which would version/rollback and, for a
// serverFn module, must never leak to the browser build).
//
// Storage is the supervisor D1 (`site_secrets`), values AES-GCM-encrypted under a
// per-site key (see crypto.ts). The site isolate reaches values ONLY through the
// `SecretsEntrypoint` capability stub as `env.SECRETS.get(name)` — a raw D1 can't
// cross the Worker-Loader boundary, and this keeps decryption supervisor-side.
// A secret is plaintext to the SITE'S OWN code by design (it needs the key to
// call the API); cross-tenant isolation holds because the entrypoint is bound
// with that site's siteId in props and only reads that site's rows.

import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import { sealSecret, openSecret } from "./crypto";
import { DEFAULT_SITE_ID } from "./site/store";

/** A secret name: env-var-ish, so it maps cleanly to `env.SECRETS.get("NAME")`. */
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export function validateSecretName(name: string): string | null {
  if (!NAME_RE.test(name)) {
    return (
      "Secret name must look like an env var: start with a letter or underscore, " +
      "then letters/numbers/underscores, max 64 chars (e.g. STRIPE_SECRET_KEY)."
    );
  }
  return null;
}

/** Upsert a secret (encrypted). Returns nothing; the plaintext is never stored. */
export async function setSecret(
  env: Env,
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

/** Decrypt and return a secret value, or null if the site has no such secret. */
export async function getSecret(
  env: Env,
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

/** List a site's secret NAMES (never values) with timestamps. */
export async function listSecretNames(
  env: Env,
  siteId: string,
): Promise<Array<{ name: string; created_at: string; updated_at: string }>> {
  const { results } = await env.DB.prepare(
    "SELECT name, created_at, updated_at FROM site_secrets WHERE site_id = ? ORDER BY name",
  )
    .bind(siteId)
    .all<{ name: string; created_at: string; updated_at: string }>();
  return results ?? [];
}

/** Delete a secret. Returns true if a row was removed. */
export async function deleteSecret(
  env: Env,
  siteId: string,
  name: string,
): Promise<boolean> {
  const res = await env.DB.prepare(
    "DELETE FROM site_secrets WHERE site_id = ? AND name = ?",
  )
    .bind(siteId, name)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/**
 * Per-site secret capability handed to the site isolate as `env.SECRETS`. Only
 * `get(name)` is exposed to site code — setting/deleting is an owner MCP action,
 * not something the running site can do to itself.
 */
export class SecretsEntrypoint extends WorkerEntrypoint<Env, { siteId?: string }> {
  async get(name: string): Promise<string | null> {
    const siteId = this.ctx.props?.siteId ?? DEFAULT_SITE_ID;
    return getSecret(this.env, siteId, name);
  }

  /** Names only — so a site can check which secrets are configured. */
  async names(): Promise<string[]> {
    const siteId = this.ctx.props?.siteId ?? DEFAULT_SITE_ID;
    return (await listSecretNames(this.env, siteId)).map((s) => s.name);
  }
}
