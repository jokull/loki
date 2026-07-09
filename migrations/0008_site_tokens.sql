-- Scoped per-site MCP tokens. The site's OWNER key lives in sites.api_key_hash
-- (full access: schema + content + code). Additional tokens with narrower roles
-- live here — notably `editor`: an MCP token that can maintain CONTENT and upload
-- images, but NOT change the schema or the code. Owners mint these so a content
-- editor can connect their own MCP client to {sub}.loftur.app/mcp.
CREATE TABLE IF NOT EXISTS "site_tokens" (
  "id" TEXT PRIMARY KEY,
  "site_id" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL UNIQUE,
  "role" TEXT NOT NULL DEFAULT 'editor',
  "label" TEXT,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "idx_site_tokens_site" ON "site_tokens" ("site_id");
