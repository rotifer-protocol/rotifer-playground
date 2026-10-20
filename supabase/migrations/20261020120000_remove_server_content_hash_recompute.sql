-- Remove the server-side content_hash recompute from the publish trigger.
--
-- ADR-341 (canonical-hash path c′), D1.
--
-- validate_content_hash_on_publish() recomputed the hash as
-- sha256(phenotype::jsonb::text). The client computes it over JSON.stringify of
-- the key-sorted phenotype (src/utils/content-hash.ts), so the two never match.
-- Since 20260528021934 a mismatch only raised a WARNING (ADR-292 D1), and no
-- consumer reads that log line. The recompute blocked nothing and cost a digest
-- per publish.
--
-- Base: the function body from 20260601083520 (the current one), not 05-28.
-- Kept unchanged:
--   - the early return for UPDATEs that touch neither content_hash, phenotype
--     nor published (the reputation cron depends on it);
--   - the duplicate check on the client's hash, RAISE ... ERRCODE 23505.
-- Removed: the recompute and the WARNING, with their two variables.
-- Not touched: chk_published_content_hash, trg_require_content_hash, and the
-- trg_validate_content_hash trigger itself.
--
-- Rollback target: the 20260601083520 body.
--
-- content_hash remains the client-defined v1 hash (ADR-341 D2). Until v1.0,
-- the duplicate check trusts the client's value; that is the same as before
-- this migration, not a new weakness.
--
-- Tests: supabase/tests/content_hash_trigger.sql (H2-a .. H2-f).

BEGIN;

CREATE OR REPLACE FUNCTION public.validate_content_hash_on_publish()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_existing_id UUID;
BEGIN
  -- Skip validation on UPDATEs that touch neither content nor publish state
  -- (e.g. the reputation_score / downloads bumps written by the reputation cron).
  -- Without this guard such UPDATEs re-run the duplicate-hash check and RAISE
  -- 23505, which silently aborts compute_all_reputations().
  IF TG_OP = 'UPDATE'
     AND NEW.content_hash IS NOT DISTINCT FROM OLD.content_hash
     AND NEW.phenotype    IS NOT DISTINCT FROM OLD.phenotype
     AND NEW.published    IS NOT DISTINCT FROM OLD.published
  THEN
    RETURN NEW;
  END IF;

  IF NEW.published = true AND NEW.content_hash IS NOT NULL AND NEW.phenotype IS NOT NULL THEN
    SELECT id INTO v_existing_id
      FROM genes
      WHERE content_hash = NEW.content_hash
        AND id != NEW.id
        AND published = true
      LIMIT 1;
    IF v_existing_id IS NOT NULL THEN
      RAISE EXCEPTION 'Duplicate content_hash: gene % already has this hash. This gene is a duplicate.',
        v_existing_id
        USING ERRCODE = '23505';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

COMMIT;
