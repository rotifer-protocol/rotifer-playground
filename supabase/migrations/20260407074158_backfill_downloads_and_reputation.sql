-- ============================================================
-- RESTORED FROM PRODUCTION schema_migrations — 2026-05-18
-- ============================================================
-- This migration was applied directly via Supabase Dashboard SQL Editor
-- on 2026-04-07 07:41:58 UTC. The local migration file was never created
-- at that time (one-shot hotfix). Restored here from
-- supabase_migrations.schema_migrations.statements during the v0.9 F2
-- push prep audit (see meta-lesson S2-L11; private; 2026-05-18 dev/prod parity sprint).
--
-- Production timestamp:  20260407074158
-- Production name:       backfill_downloads_and_reputation
-- ============================================================

-- Backfill: sync genes.downloads with actual downloads table counts.
-- Root cause: some download records were inserted before trg_increment_gene_downloads
-- existed, or bypassed the trigger via direct INSERT paths.

UPDATE genes g
SET downloads = COALESCE(sub.actual_count, 0)
FROM (
  SELECT d.gene_id, COUNT(*)::BIGINT AS actual_count
  FROM downloads d
  GROUP BY d.gene_id
) sub
WHERE g.id = sub.gene_id
  AND g.downloads IS DISTINCT FROM sub.actual_count;

-- Recompute reputation for all published genes with corrected download counts.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT id FROM genes WHERE published = true LOOP
    PERFORM compute_gene_reputation(r.id);
  END LOOP;
  FOR r IN SELECT DISTINCT owner_id FROM genes WHERE published = true AND owner_id IS NOT NULL LOOP
    PERFORM compute_developer_reputation(r.owner_id);
  END LOOP;
END;
$$;
