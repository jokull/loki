-- Site lifecycle: a site is a lease on the *.loftur.app namespace + several
-- stores. `status` drives serving + the reaper. Owner ops (delete/restore/
-- unpublish/republish/purge) flip status; a daily cron reaper hard-purges
-- `deleted` sites older than 7 days.
--   active      - normal, serves.
--   unpublished - owner paused (503). Data intact, no countdown.
--   deleted     - owner archived (served as a generic 404, indistinguishable
--                 from a never-claimed name). Name held; on the 7-day clock.
--   suspended   - PLATFORM abuse hold (404). Owner can't lift. Never auto-reaps.
--   purging     - reaper tombstone (mid-teardown; resumable). Name freed LAST.
ALTER TABLE "sites" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active';
ALTER TABLE "sites" ADD COLUMN "deleted_at" TEXT;
ALTER TABLE "sites" ADD COLUMN "unpublished_at" TEXT;
ALTER TABLE "sites" ADD COLUMN "suspended_at" TEXT;
CREATE INDEX IF NOT EXISTS "idx_sites_status" ON "sites" ("status", "deleted_at");

-- Per-account free-site quota override (absent = default 5; -1 = unlimited),
-- keyed by NORMALIZED email (lowercased, +tag stripped).
CREATE TABLE IF NOT EXISTS "account_quotas" (
  "email" TEXT PRIMARY KEY,
  "max_sites" INTEGER NOT NULL
);

-- Intent-to-pay: every over-cap claim attempt (the commercial-interest harvest).
CREATE TABLE IF NOT EXISTS "quota_requests" (
  "id" TEXT PRIMARY KEY,
  "email" TEXT NOT NULL,
  "subdomain" TEXT NOT NULL,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
