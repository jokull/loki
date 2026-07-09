-- Loftur multi-tenancy. One worker + one D1 host many sites, isolated by
-- `site_id` (row-level tenancy). Legacy single-tenant rows fold into the site
-- '__default__' so an in-place upgrade of an existing DB is non-destructive.
-- Draft-tree tables get a composite (site_id, <natural key>) primary key.

-- Tenant registry. api_key_hash = sha-256 hex of the site's API key (key shown once).
CREATE TABLE IF NOT EXISTS "sites" (
  "id" TEXT PRIMARY KEY,                 -- site_id
  "subdomain" TEXT NOT NULL UNIQUE,      -- {subdomain}.loftur.app
  "email" TEXT,
  "api_key_hash" TEXT NOT NULL,
  "created_at" TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO "sites" ("id","subdomain","email","api_key_hash")
  VALUES ('__default__','__default__', NULL, '__legacy__');

-- site_files: PK (path) -> (site_id, path)
CREATE TABLE "site_files_new" (
  "site_id" TEXT NOT NULL DEFAULT '__default__',
  "path" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "compiled" TEXT,
  "client_compiled" TEXT,
  "updated_at" TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY ("site_id","path")
);
INSERT INTO "site_files_new" ("site_id","path","source","compiled","client_compiled","updated_at")
  SELECT '__default__',"path","source","compiled","client_compiled","updated_at" FROM "site_files";
DROP TABLE "site_files";
ALTER TABLE "site_files_new" RENAME TO "site_files";

-- site_state: PK (key) -> (site_id, key)
CREATE TABLE "site_state_new" (
  "site_id" TEXT NOT NULL DEFAULT '__default__',
  "key" TEXT NOT NULL,
  "value" TEXT,
  PRIMARY KEY ("site_id","key")
);
INSERT INTO "site_state_new" ("site_id","key","value")
  SELECT '__default__',"key","value" FROM "site_state";
DROP TABLE "site_state";
ALTER TABLE "site_state_new" RENAME TO "site_state";

-- site_assets: PK (path) -> (site_id, path)
CREATE TABLE "site_assets_new" (
  "site_id" TEXT NOT NULL DEFAULT '__default__',
  "path" TEXT NOT NULL,
  "hash" TEXT NOT NULL,
  "content_type" TEXT NOT NULL,
  "size" INTEGER NOT NULL,
  "updated_at" TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY ("site_id","path")
);
INSERT INTO "site_assets_new" ("site_id","path","hash","content_type","size","updated_at")
  SELECT '__default__',"path","hash","content_type","size","updated_at" FROM "site_assets";
DROP TABLE "site_assets";
ALTER TABLE "site_assets_new" RENAME TO "site_assets";

-- site_deps: PK (specifier) -> (site_id, specifier)
CREATE TABLE "site_deps_new" (
  "site_id" TEXT NOT NULL DEFAULT '__default__',
  "specifier" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "entry_key" TEXT NOT NULL,
  "module_manifest" TEXT NOT NULL,
  "dep_hash" TEXT NOT NULL,
  "created_at" TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY ("site_id","specifier")
);
INSERT INTO "site_deps_new" ("site_id","specifier","version","entry_key","module_manifest","dep_hash","created_at")
  SELECT '__default__',"specifier","version","entry_key","module_manifest","dep_hash","created_at" FROM "site_deps";
DROP TABLE "site_deps";
ALTER TABLE "site_deps_new" RENAME TO "site_deps";

-- site_versions: keep the global autoincrement `id` PK (uniqueness), add `site_id`
-- and a per-site version number `n` (what the tenant sees as v1, v2, …). Legacy
-- rows get n = id (preserves the existing demo's v-numbers).
ALTER TABLE "site_versions" ADD COLUMN "site_id" TEXT NOT NULL DEFAULT '__default__';
ALTER TABLE "site_versions" ADD COLUMN "n" INTEGER;
UPDATE "site_versions" SET "n" = "id" WHERE "n" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_site_versions_site_n" ON "site_versions" ("site_id","n");
