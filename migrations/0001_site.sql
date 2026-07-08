-- Loki site ring: the agent-authored site code store (draft tree + published versions).
-- See PLAN.md "Site ring". Site code lives in D1 and executes via Worker Loader.

-- Draft working tree: one row per file. `source` is the authored TSX/TS,
-- `compiled` is the transpiled ESM (sucrase, at write time).
CREATE TABLE IF NOT EXISTS "site_files" (
  "path" TEXT PRIMARY KEY,
  "source" TEXT NOT NULL,
  "compiled" TEXT,
  "updated_at" TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Published snapshots. `bundle` is a JSON map of path -> compiled module.
-- `footprint` is a JSON set of (parentType, fieldName) + model api_keys
-- extracted from the draft's GraphQL documents (migration guard).
CREATE TABLE IF NOT EXISTS "site_versions" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "created_at" TEXT NOT NULL DEFAULT (datetime('now')),
  "message" TEXT,
  "bundle" TEXT NOT NULL,
  "footprint" TEXT
);

-- Key/value site state: `published_version`, preview tokens, etc.
CREATE TABLE IF NOT EXISTS "site_state" (
  "key" TEXT PRIMARY KEY,
  "value" TEXT
);
