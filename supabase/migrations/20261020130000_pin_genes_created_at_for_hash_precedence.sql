-- Pin genes.created_at to server time, and let the duplicate-hash check
-- decide by who came first.
--
-- ADR-341 D5 (M1): cross-author content_hash squatting.
--
-- The publish trigger rejects a Gene whose content_hash another published
-- Gene already holds (23505). The INSERT policy only checks owner_id, so
-- author B could publish arbitrary content under the hash of author A's
-- unpublished Gene, and A could then never republish it.
--
-- Fix, in two parts:
--   1. trg_genes_00_pin_created_at (new): created_at is set by the server.
--      INSERT takes clock_timestamp(); UPDATE keeps the old value. Until now
--      created_at was only `DEFAULT now()`: a client could supply any value
--      and an author could change it later, so it could not decide anything.
--      The name sorts before trg_validate_content_hash, and BEFORE triggers
--      for the same event fire in name order, so the check sees the pinned
--      value.
--   2. validate_content_hash_on_publish(): the duplicate check only counts
--      rows created before the one being written (`created_at <
--      NEW.created_at`). INSERT behaves as before (every existing row is
--      older). On republish, an earlier Gene is no longer blocked by a later
--      one holding its hash; the later one still cannot publish over the
--      earlier one.
--
-- Base for (2): the 20261020120000 body; the only change is that one line.
-- Rollback target: that body, then DROP the trigger and function added here.
--
-- Limits:
--   - Existing rows are not backfilled. Their created_at cannot be proven
--     never to have been edited; only times written after this migration are
--     trustworthy.
--   - Anything that needs to insert genes with an original timestamp (an
--     import) is overridden, and needs a separate controlled path.
--
-- Tests: supabase/tests/content_hash_squatting.sql (M1-a .. M1-c).

BEGIN;

CREATE OR REPLACE FUNCTION public.pin_genes_created_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := clock_timestamp();
  ELSE
    NEW.created_at := OLD.created_at;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_genes_00_pin_created_at
  BEFORE INSERT OR UPDATE ON public.genes
  FOR EACH ROW
  EXECUTE FUNCTION public.pin_genes_created_at();

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
        AND created_at < NEW.created_at
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
