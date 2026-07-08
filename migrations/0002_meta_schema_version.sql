-- agent-cms 0.4.2 shared schema-version counter. Bumped on every schema
-- mutation so Worker isolates detect a stale per-isolate GraphQL schema /
-- fast-path metadata cache and rebuild it within the TTL. Mirrors agent-cms's
-- own migrations/0001_meta_schema_version.sql (Loki manages its D1 schema via
-- wrangler migrations rather than agent-cms's /setup route, so we apply it here).
CREATE TABLE IF NOT EXISTS "_cms_meta" (
  "key" text PRIMARY KEY,
  "value" integer NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO "_cms_meta" ("key", "value") VALUES ('schema_version', 0);
