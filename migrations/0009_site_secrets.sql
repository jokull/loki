-- Per-site secret store. Owners set named secrets (API keys for Stripe, Resend,
-- etc.) that their site's OWN server code reads via `env.SECRETS.get(name)` — the
-- keys never touch the browser build and never cross tenant boundaries. Values
-- are encrypted at rest with AES-GCM under a per-site key derived (HKDF) from the
-- worker secret SECRETS_KEY, so a raw DB dump reveals only ciphertext. Only the
-- `name` is ever returned to a listing (never the plaintext).
CREATE TABLE IF NOT EXISTS "site_secrets" (
  "site_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "iv" TEXT NOT NULL,
  "ciphertext" TEXT NOT NULL,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("site_id", "name")
);
