-- Loki site static/design assets ring. Mirrors site_files, but for binary
-- assets served under public/… at the site root (public/favicon.ico ->
-- /favicon.ico). Bytes live content-addressed in R2 at `site/blob/<sha256>`;
-- these tables hold only the manifest (path -> hash/contentType/size).

-- Draft asset working tree: one row per public/… path. `hash` is the sha256
-- hex of the bytes (also the R2 blob key suffix and the strong ETag).
CREATE TABLE IF NOT EXISTS "site_assets" (
  "path" TEXT PRIMARY KEY,
  "hash" TEXT NOT NULL,
  "content_type" TEXT NOT NULL,
  "size" INTEGER NOT NULL,
  "updated_at" TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Published asset manifest, snapshotted per site version alongside the code
-- bundle. JSON map: { [path]: { hash, contentType, size } }. NULL on versions
-- published before assets existed (treated as an empty manifest). Blobs are
-- written at authoring time, so publish/rollback only swap this manifest —
-- they never copy bytes.
ALTER TABLE "site_versions" ADD COLUMN "assets" TEXT;
