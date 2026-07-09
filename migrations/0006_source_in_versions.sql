-- Source-in-versions. Until now a published version stored only COMPILED output
-- (`bundle` = path -> compiled?? source, plus `client_bundle`), so a version's
-- authored SOURCE was unrecoverable. That breaks faithful reset / checkout of an
-- old version / clean pull-push. Snapshot the exact draft source (path -> source)
-- alongside the compiled bundle from publish_site onward.
--
-- JSON map { [path]: source } — the verbatim `site_files.source` at publish time.
-- NULL on versions published before this column existed (restore falls back to
-- reconstructing source from the compiled bundle for those).
ALTER TABLE "site_versions" ADD COLUMN "source_bundle" TEXT;

-- Backfill the currently-published version from the live draft. This is correct
-- ONLY because the draft equals the published version at migration time (Loki is
-- single-surface; the handoff confirms draft == v13). json_group_object emits
-- byte-faithful JSON, identical to what publish_site would now store. Guarded so
-- it is a no-op on a fresh DB (no draft files / no published pointer).
UPDATE "site_versions"
  SET "source_bundle" = (SELECT json_group_object(path, source) FROM site_files)
  WHERE id = (SELECT CAST(value AS INTEGER) FROM site_state WHERE key = 'published_version')
    AND "source_bundle" IS NULL
    AND EXISTS (SELECT 1 FROM site_files);
