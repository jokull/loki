-- Account-level personal access tokens (PATs). Unlike a site owner key (scoped to
-- ONE site) or an editor token (content-only on one site), a PAT authenticates as
-- a whole ACCOUNT (an email) and drives the unified account MCP: claim new
-- subdomains + build any of that account's sites. This is "the developer's key
-- for their agent" — Openclaw/Claude Code holds it and spins up sites on demand.
-- Minted + revoked from the dashboard; the plaintext is shown once.
CREATE TABLE IF NOT EXISTS "account_tokens" (
  "id" TEXT PRIMARY KEY,
  "email" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL UNIQUE,
  "label" TEXT,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_used_at" TEXT
);
CREATE INDEX IF NOT EXISTS "idx_account_tokens_email" ON "account_tokens" (lower("email"));
