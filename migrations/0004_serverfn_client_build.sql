-- serverFn client-stub build. A serverFn module's handler/validator source must
-- NEVER be served to the browser (it can hold secrets, gql, and server logic).
-- The isolate keeps the full `compiled` text; the browser is served a synthesized
-- stub instead. That stub is stored here so /__modules serving picks it up.

-- Draft tree: per-file synthesized browser stub. NULL for modules that define no
-- serverFns (the browser gets the normal `compiled` text unchanged).
ALTER TABLE "site_files" ADD COLUMN "client_compiled" TEXT;

-- Published snapshots: JSON map { [path]: clientCompiled } for the version's
-- serverFn modules, snapshotted alongside `bundle` so published + preview both
-- serve the stub and rollback carries it. NULL on versions published before this
-- existed (treated as empty -> browser falls back to the full compiled text).
ALTER TABLE "site_versions" ADD COLUMN "client_bundle" TEXT;
