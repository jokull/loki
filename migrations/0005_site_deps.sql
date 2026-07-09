-- Loki npm-dependency resolver lockfile (esm.sh snapshot pins).
--
-- When authored site code imports an allowlisted bare specifier (e.g.
-- `drizzle-orm/sqlite-proxy`), the SUPERVISOR resolves it via esm.sh at write
-- time: pins a concrete version, fetches `?bundle&target=es2022`, recursively
-- crawls any remaining esm.sh imports, strips dead `/node/*` imports, and
-- produces a self-contained module set with ZERO esm.sh references. Each module's
-- bytes are content-addressed in R2 at `site/dep/<sha256>` (like static assets),
-- and this table records the pin so publishes are reproducible.

CREATE TABLE IF NOT EXISTS "site_deps" (
  -- Bare specifier as authored, e.g. "drizzle-orm", "drizzle-orm/sqlite-core".
  "specifier" TEXT PRIMARY KEY,
  -- Concrete version esm.sh resolved to, e.g. "0.45.2".
  "version" TEXT NOT NULL,
  -- Local module-map filename of the crawl entry (the module that re-exports the
  -- package's public API); the author's import rewrites to point at this.
  "entry_key" TEXT NOT NULL,
  -- JSON map { localKey: blobHash } — every module in the self-contained set,
  -- each stored in R2 at `site/dep/<blobHash>`.
  "module_manifest" TEXT NOT NULL,
  -- Content hash over the whole set (specifier + version + sorted manifest);
  -- also the isolate module-map namespace `deps/<dep_hash>/…`.
  "dep_hash" TEXT NOT NULL,
  "created_at" TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Published snapshots carry the resolved dep manifest so published + preview +
-- rollback all serve the SAME pinned deps. JSON map:
--   { [specifier]: { version, entryKey, depHash, manifest: { localKey: blobHash } } }
-- NULL on versions published before deps existed (treated as empty).
ALTER TABLE "site_versions" ADD COLUMN "deps" TEXT;
